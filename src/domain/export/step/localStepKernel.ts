import { createFrame, type Frame3D } from '../../geometry/frame';
import { addVec3, scaleVec3, subVec3, vec3, type Vec3 } from '../../geometry/vector';
import { deriveProject } from '../../model/deriveProject';
import type { DerivedProject, ProjectInput } from '../../model/types';
import { buildStepExportFilename, buildStepExportPayload } from './buildStepExportPayload';
import type { LocalStepExportResult, StepExportRequest } from './types';
import replicadWasmUrl from 'replicad-opencascadejs/src/replicad_single.wasm?url';

type ReplicadModule = typeof import('replicad');

interface LocalStepExportRuntime {
    assembleWire: ReplicadModule['assembleWire'];
    exportSTEP: ReplicadModule['exportSTEP'];
    loft: ReplicadModule['loft'];
    makeBSplineApproximation: ReplicadModule['makeBSplineApproximation'];
    makeCircle: ReplicadModule['makeCircle'];
    makeCylinder: ReplicadModule['makeCylinder'];
    makeFace: ReplicadModule['makeFace'];
    makeSolid: ReplicadModule['makeSolid'];
    weldShellsAndFaces: ReplicadModule['weldShellsAndFaces'];
}

let runtimePromise: Promise<LocalStepExportRuntime> | null = null;

function resolveWasmAssetPath() {
    if (
        typeof process !== 'undefined'
        && typeof process.cwd === 'function'
        && typeof process.versions?.node === 'string'
        && replicadWasmUrl.startsWith('/')
    ) {
        return `${process.cwd()}${replicadWasmUrl}`;
    }

    return replicadWasmUrl;
}

function requestToProjectInput(request: StepExportRequest): ProjectInput {
    return {
        main: {
            od: request.project.main.od,
            wall: request.project.main.wall,
        },
        branch: {
            od: request.project.branch.od,
            wall: request.project.branch.wall,
        },
        connection: {
            ...request.project.connection,
        },
        export: {
            branchPadding: 0,
            mainPadding: 0,
        },
    };
}

function safeSmall(value: number, fallbackMagnitude: number = 1e-6) {
    if (Math.abs(value) >= fallbackMagnitude) {
        return value;
    }

    return value >= 0 ? fallbackMagnitude : -fallbackMagnitude;
}

function pointAlongAxis(frame: Frame3D, distance: number): Vec3 {
    return addVec3(frame.origin, scaleVec3(frame.axis, distance));
}

function frameTangent(frame: Frame3D): Vec3 {
    return scaleVec3(frame.binormal, -1);
}

function samplePointOnFrame(
    frame: Frame3D,
    axialOffset: number,
    normalOffset: number = 0,
    tangentOffset: number = 0,
): Vec3 {
    return addVec3(
        addVec3(
            addVec3(frame.origin, scaleVec3(frame.axis, axialOffset)),
            scaleVec3(frame.normal, normalOffset),
        ),
        scaleVec3(frameTangent(frame), tangentOffset),
    );
}

function toPoint(value: Vec3): [number, number, number] {
    return [value.x, value.y, value.z];
}

function mainStockLength(derivedProject: DerivedProject) {
    return Math.max(derivedProject.main.od * 3, derivedProject.branch.od * 2 + 200);
}

function branchAxialRange(derivedProject: DerivedProject) {
    const end = Math.max(
        derivedProject.main.od + (derivedProject.main.od * 1.5) + 100 - derivedProject.connection.resolvedPenetrationDepth,
        derivedProject.branch.od * 2.5,
    );

    return {
        start: -(derivedProject.branch.od * 0.75),
        end,
    };
}

function openingToolRadius(derivedProject: DerivedProject) {
    const contourRadius = derivedProject.connection.useOuterBranchContour
        ? derivedProject.branch.outerRadius
        : derivedProject.branch.innerRadius;

    return Math.max(contourRadius, 0.1);
}

function createMainFrame() {
    return createFrame(vec3(0, 0, 0), vec3(0, 1, 0));
}

function createBranchFrame(derivedProject: DerivedProject) {
    return createFrame(
        vec3(0, 0, derivedProject.connection.offset),
        vec3(Math.sin(derivedProject.connection.axisAngleRad), Math.cos(derivedProject.connection.axisAngleRad), 0),
    );
}

function receiverRadius(derivedProject: DerivedProject) {
    return derivedProject.connection.type === 'set_in'
        ? derivedProject.main.innerRadius
        : derivedProject.main.outerRadius;
}

function trimContourRadius(derivedProject: DerivedProject) {
    return derivedProject.connection.useOuterBranchContour
        ? derivedProject.branch.outerRadius
        : derivedProject.branch.innerRadius;
}

function branchNotchShift(derivedProject: DerivedProject) {
    return derivedProject.connection.resolvedPenetrationDepth - derivedProject.connection.weldingGap;
}

function mainOpeningShift(derivedProject: DerivedProject) {
    return derivedProject.connection.resolvedPenetrationDepth;
}

function validateIntersection(derivedProject: DerivedProject, segments: number = 128) {
    const receiverContactRadius = receiverRadius(derivedProject);
    const contourRadius = trimContourRadius(derivedProject);

    for (let index = 0; index <= segments; index += 1) {
        const alpha = (index / segments) * Math.PI * 2;
        const term = (receiverContactRadius ** 2)
            - ((contourRadius * Math.sin(alpha)) + derivedProject.connection.offset) ** 2;

        if (term < -0.1) {
            throw new Error('Geometry Error: Pipes do not intersect.');
        }
    }
}

function calculateReceiverNotchDepth(
    derivedProject: DerivedProject,
    alpha: number,
    branchMeshRadius: number,
) {
    const sinAlpha = Math.sin(alpha);
    const cosAlpha = Math.cos(alpha);
    let term = (receiverRadius(derivedProject) ** 2)
        - (((trimContourRadius(derivedProject) * sinAlpha) + derivedProject.connection.offset) ** 2);

    term = Math.max(term, 0);

    const sTheta = safeSmall(Math.sin(derivedProject.connection.axisAngleRad));
    const tTheta = safeSmall(Math.tan(derivedProject.connection.axisAngleRad));

    return (Math.sqrt(term) / sTheta)
        + ((branchMeshRadius * cosAlpha) / tTheta)
        + derivedProject.connection.weldingGap
        - derivedProject.connection.resolvedPenetrationDepth;
}

function resolveSingleEndedStockStart(
    receiverContactRadius: number,
    branchRadius: number,
    offset: number,
    axisAngleRad: number,
    axialShift: number,
    segments: number = 256,
) {
    const sTheta = safeSmall(Math.sin(axisAngleRad));
    const tTheta = safeSmall(Math.tan(axisAngleRad));
    let maxLowerRoot = -Infinity;
    let minUpperRoot = Infinity;

    for (let index = 0; index <= segments; index += 1) {
        const alpha = (index / segments) * Math.PI * 2;
        let term = (receiverContactRadius ** 2)
            - ((branchRadius * Math.sin(alpha)) + offset) ** 2;

        if (term < -0.1) {
            throw new Error('Geometry Error: Pipes do not intersect.');
        }

        term = Math.max(term, 0);

        const rootSpan = Math.sqrt(term) / sTheta;
        const rootMidpoint = ((branchRadius * Math.cos(alpha)) / tTheta) - axialShift;

        maxLowerRoot = Math.max(maxLowerRoot, rootMidpoint - rootSpan);
        minUpperRoot = Math.min(minUpperRoot, rootMidpoint + rootSpan);
    }

    if (
        !Number.isFinite(maxLowerRoot)
        || !Number.isFinite(minUpperRoot)
        || minUpperRoot < maxLowerRoot - 1e-6
    ) {
        throw new Error('Geometry Error: Could not isolate a single receiver-trim interval.');
    }

    return maxLowerRoot + (Math.max(0, minUpperRoot - maxLowerRoot) * 0.5);
}

function receiverCutterLength(derivedProject: DerivedProject) {
    const branchRange = branchAxialRange(derivedProject);
    const branchLength = branchRange.end - branchRange.start;

    return Math.max(mainStockLength(derivedProject) + (derivedProject.branch.od * 2), branchLength + (derivedProject.main.od * 2));
}

function createShiftedReceiverFrame(
    mainFrame: Frame3D,
    branchFrame: Frame3D,
    shift: number,
) {
    return createFrame(
        subVec3(mainFrame.origin, scaleVec3(branchFrame.axis, shift)),
        mainFrame.axis,
        mainFrame.normal,
    );
}

function makeFiniteCylinder(
    runtime: LocalStepExportRuntime,
    radius: number,
    frame: Frame3D,
    start: number,
    end: number,
) {
    if (!(end > start)) {
        throw new Error('Invalid cylinder range.');
    }

    return runtime.makeCylinder(
        radius,
        end - start,
        toPoint(pointAlongAxis(frame, start)),
        toPoint(frame.axis),
    );
}

function resolveBranchStockRange(derivedProject: DerivedProject) {
    const receiverContactRadius = receiverRadius(derivedProject);
    const branchRange = branchAxialRange(derivedProject);
    const start = resolveSingleEndedStockStart(
        receiverContactRadius,
        derivedProject.branch.outerRadius,
        derivedProject.connection.offset,
        derivedProject.connection.axisAngleRad,
        branchNotchShift(derivedProject),
    );

    if (!(branchRange.end > start + 1)) {
        throw new Error('Geometry Error: Branch stock range is too short after receiver trim.');
    }

    return {
        start,
        end: branchRange.end,
    };
}

function resolveMainOpeningToolRange(derivedProject: DerivedProject) {
    const branchRange = branchAxialRange(derivedProject);
    const start = resolveSingleEndedStockStart(
        derivedProject.main.outerRadius,
        openingToolRadius(derivedProject),
        derivedProject.connection.offset,
        derivedProject.connection.axisAngleRad,
        mainOpeningShift(derivedProject),
    );

    if (!(branchRange.end > start + 1)) {
        throw new Error('Geometry Error: Opening tool range is too short after receiver trim.');
    }

    return {
        start,
        end: branchRange.end,
    };
}

async function ensureRuntime(): Promise<LocalStepExportRuntime> {
    if (!runtimePromise) {
        runtimePromise = (async () => {
            const [replicad, initOcModule] = await Promise.all([
                import('replicad'),
                import('replicad-opencascadejs'),
            ]);

            const oc = await initOcModule.default({
                locateFile: (path: string) => {
                    if (path.endsWith('.wasm')) {
                        return resolveWasmAssetPath();
                    }

                    return path;
                },
            });

            replicad.setOC(oc);

            return {
                assembleWire: replicad.assembleWire,
                exportSTEP: replicad.exportSTEP,
                loft: replicad.loft,
                makeBSplineApproximation: replicad.makeBSplineApproximation,
                makeCircle: replicad.makeCircle,
                makeCylinder: replicad.makeCylinder,
                makeFace: replicad.makeFace,
                makeSolid: replicad.makeSolid,
                weldShellsAndFaces: replicad.weldShellsAndFaces,
            };
        })().catch((error) => {
            runtimePromise = null;
            throw error;
        });
    }

    return runtimePromise;
}

function createStepWarnings(derivedProject: DerivedProject) {
    return derivedProject.validation.warnings.map((warning) => warning.message);
}

function buildMainPipe(runtime: LocalStepExportRuntime, derivedProject: DerivedProject) {
    const mainFrame = createMainFrame();
    const stockLength = mainStockLength(derivedProject);
    const outer = makeFiniteCylinder(
        runtime,
        derivedProject.main.outerRadius,
        mainFrame,
        -(stockLength / 2),
        stockLength / 2,
    );

    const innerClearance = Math.max(1, derivedProject.main.od * 0.02);
    const inner = makeFiniteCylinder(
        runtime,
        derivedProject.main.innerRadius,
        mainFrame,
        -(stockLength / 2) - innerClearance,
        (stockLength / 2) + innerClearance,
    );

    const shell = outer.cut(inner);
    const branchFrame = createBranchFrame(derivedProject);
    const openingRange = resolveMainOpeningToolRange(derivedProject);
    const openingTool = makeFiniteCylinder(
        runtime,
        openingToolRadius(derivedProject),
        branchFrame,
        openingRange.start,
        openingRange.end,
    );

    return shell.cut(openingTool);
}

function buildNotchWire(
    runtime: LocalStepExportRuntime,
    derivedProject: DerivedProject,
    branchFrame: Frame3D,
    branchMeshRadius: number,
    segments: number = 192,
) {
    const points: Array<[number, number, number]> = [];

    for (let index = 0; index <= segments; index += 1) {
        const alpha = (index / segments) * Math.PI * 2;
        const axial = calculateReceiverNotchDepth(derivedProject, alpha, branchMeshRadius);
        points.push(toPoint(samplePointOnFrame(
            branchFrame,
            axial,
            branchMeshRadius * Math.sin(alpha),
            branchMeshRadius * Math.cos(alpha),
        )));
    }

    return runtime.assembleWire([
        runtime.makeBSplineApproximation(points, { tolerance: 1e-3, degMin: 1, degMax: 5 }),
    ]);
}

function buildCircleWire(
    runtime: LocalStepExportRuntime,
    frame: Frame3D,
    radius: number,
    axial: number,
) {
    return runtime.assembleWire([
        runtime.makeCircle(radius, toPoint(pointAlongAxis(frame, axial)), toPoint(frame.axis)),
    ]);
}

function buildBranchPipeFromProfileLofts(runtime: LocalStepExportRuntime, derivedProject: DerivedProject) {
    validateIntersection(derivedProject, 192);

    const branchFrame = createBranchFrame(derivedProject);
    const branchRange = branchAxialRange(derivedProject);
    const outerNotch = buildNotchWire(runtime, derivedProject, branchFrame, derivedProject.branch.outerRadius);
    const innerNotch = buildNotchWire(runtime, derivedProject, branchFrame, derivedProject.branch.innerRadius);
    const farOuter = buildCircleWire(runtime, branchFrame, derivedProject.branch.outerRadius, branchRange.end);
    const farInner = buildCircleWire(runtime, branchFrame, derivedProject.branch.innerRadius, branchRange.end);
    const outerSide = runtime.loft([outerNotch, farOuter], { ruled: true }, true);
    const innerSide = runtime.loft([innerNotch, farInner], { ruled: true }, true);
    const notchRim = runtime.loft([outerNotch, innerNotch], { ruled: true }, true);
    const farRing = runtime.makeFace(farOuter, [farInner]);

    return runtime.makeSolid([
        runtime.weldShellsAndFaces(outerSide.faces, true),
        runtime.weldShellsAndFaces(innerSide.faces, true),
        runtime.weldShellsAndFaces(notchRim.faces, true),
        farRing,
    ]);
}

function buildBranchPipeWithReceiverBoolean(runtime: LocalStepExportRuntime, derivedProject: DerivedProject) {
    validateIntersection(derivedProject, 128);

    const mainFrame = createMainFrame();
    const branchFrame = createBranchFrame(derivedProject);
    const stockRange = resolveBranchStockRange(derivedProject);
    const branchLength = stockRange.end - stockRange.start;
    const innerClearance = Math.max(1, derivedProject.branch.od * 0.02);
    const outer = makeFiniteCylinder(
        runtime,
        derivedProject.branch.outerRadius,
        branchFrame,
        stockRange.start,
        stockRange.end,
    );
    const inner = makeFiniteCylinder(
        runtime,
        derivedProject.branch.innerRadius,
        branchFrame,
        stockRange.start - innerClearance,
        stockRange.end + innerClearance,
    );
    const shell = outer.cut(inner);
    const receiverCutterFrame = createShiftedReceiverFrame(
        mainFrame,
        branchFrame,
        branchNotchShift(derivedProject),
    );
    const receiverCutter = makeFiniteCylinder(
        runtime,
        receiverRadius(derivedProject),
        receiverCutterFrame,
        -(receiverCutterLength(derivedProject) / 2),
        receiverCutterLength(derivedProject) / 2,
    );

    if (!(branchLength > 0)) {
        throw new Error('Geometry Error: Branch stock collapsed after trim resolution.');
    }

    return shell.cut(receiverCutter);
}

function buildBranchPipe(runtime: LocalStepExportRuntime, derivedProject: DerivedProject) {
    if (!derivedProject.connection.useOuterBranchContour) {
        return buildBranchPipeFromProfileLofts(runtime, derivedProject);
    }

    return buildBranchPipeWithReceiverBoolean(runtime, derivedProject);
}

export function deriveStepProject(request: StepExportRequest) {
    return deriveProject(requestToProjectInput(request));
}

export async function exportStepAssemblyInProcess(
    derivedProject: DerivedProject,
): Promise<LocalStepExportResult> {
    if (typeof WebAssembly !== 'object') {
        throw new Error('This environment does not support WebAssembly STEP export.');
    }

    const runtime = await ensureRuntime();
    const filename = buildStepExportFilename(buildStepExportPayload(derivedProject));
    const warnings = createStepWarnings(derivedProject);

    const mainPipe = buildMainPipe(runtime, derivedProject);
    const branchPipe = buildBranchPipe(runtime, derivedProject);
    const blob = runtime.exportSTEP([
        { shape: mainPipe, name: 'MainPipe', color: '#6a7079', alpha: 1 },
        { shape: branchPipe, name: 'BranchPipe', color: '#2f7eff', alpha: 1 },
    ], {
        unit: 'MM',
        modelUnit: 'MM',
    });

    return {
        blob,
        filename,
        warnings,
    };
}

export async function exportStepAssemblyFromRequest(
    request: StepExportRequest,
): Promise<LocalStepExportResult> {
    const derivedProject = deriveStepProject(request);
    return exportStepAssemblyInProcess(derivedProject);
}
