import type { ConnectionType, DerivedConnection, DerivedPipeSpec } from '../model/types';
import { createFrame, planeAtAxisOffset, type Frame3D, type Plane3D } from './frame';
import { vec3, type Vec3 } from './vector';

export interface AxialRange {
    start: number;
    end: number;
}

export interface HollowCylinderPrimitive {
    kind: 'hollow-cylinder';
    id: string;
    label: string;
    frame: Frame3D;
    axialRange: AxialRange;
    outerRadius: number;
    innerRadius: number;
}

export interface SolidCylinderPrimitive {
    kind: 'solid-cylinder';
    id: string;
    label: string;
    frame: Frame3D;
    axialRange: AxialRange;
    radius: number;
    role: 'main-opening-tool';
}

export type SolidPrimitive = HollowCylinderPrimitive | SolidCylinderPrimitive;

export interface PlaneTrimOperation {
    kind: 'plane';
    id: string;
    solidId: string;
    label: string;
    plane: Plane3D;
    keepSide: 'greater' | 'less';
}

export interface ReceiverTrimOperation {
    kind: 'receiver-profile';
    id: string;
    solidId: string;
    label: string;
    receiverSurface: 'main-outer' | 'main-inner';
    branchContourSurface: 'branch-outer' | 'branch-inner';
    connectionType: ConnectionType;
    weldingGap: number;
    offset: number;
    penetrationDepth: number;
    note: string;
}

export type SolidTrimOperation = PlaneTrimOperation | ReceiverTrimOperation;

export interface BooleanIntent {
    id: string;
    operation: 'subtract' | 'union' | 'intersect';
    targetId: string;
    toolIds: string[];
    resultId: string;
    label: string;
    note: string;
}

export interface SolidModelOutputs {
    mainPrimitiveId: string;
    branchPrimitiveId: string;
    openingToolId: string;
    mainOpenedId: string;
    branchTrimmedId: string;
    assemblyId: string;
}

export interface SolidModel {
    primitives: SolidPrimitive[];
    trims: SolidTrimOperation[];
    booleans: BooleanIntent[];
    outputs: SolidModelOutputs;
}

function createMainFrame(): Frame3D {
    return createFrame(vec3(0, 0, 0), vec3(0, 1, 0));
}

function createBranchFrame(connection: DerivedConnection): Frame3D {
    const axis = vec3(Math.sin(connection.axisAngleRad), Math.cos(connection.axisAngleRad), 0);
    const origin = vec3(0, 0, connection.offset);
    return createFrame(origin, axis);
}

function createPlaneTrim(
    id: string,
    solidId: string,
    label: string,
    frame: Frame3D,
    offset: number,
    keepSide: 'greater' | 'less',
    normalSign: 1 | -1,
): PlaneTrimOperation {
    return {
        kind: 'plane',
        id,
        solidId,
        label,
        plane: planeAtAxisOffset(frame, offset, normalSign),
        keepSide,
    };
}

function mainAxialRange(main: DerivedPipeSpec): AxialRange {
    const length = main.od * 3;
    return {
        start: -length / 2,
        end: length / 2,
    };
}

function branchAxialRange(main: DerivedPipeSpec, branch: DerivedPipeSpec, connection: DerivedConnection): AxialRange {
    const visualLength = main.od + (main.od * 1.5) + 100 - connection.resolvedPenetrationDepth;
    return {
        start: -branch.od * 0.75,
        end: visualLength,
    };
}

function openingToolRange(main: DerivedPipeSpec): AxialRange {
    return {
        start: -main.od,
        end: main.od * 2,
    };
}

function openingToolRadius(branch: DerivedPipeSpec, connection: DerivedConnection): number {
    const referenceRadius = connection.useOuterBranchContour ? branch.outerRadius : branch.innerRadius;
    return Math.max(referenceRadius, 0.1);
}

function receiverSurfaceForConnection(connection: DerivedConnection): 'main-outer' | 'main-inner' {
    return connection.type === 'set_in' ? 'main-inner' : 'main-outer';
}

function branchContourSurfaceForConnection(connection: DerivedConnection): 'branch-outer' | 'branch-inner' {
    return connection.useOuterBranchContour ? 'branch-outer' : 'branch-inner';
}

function receiverTrimNote(connection: DerivedConnection): string {
    if (connection.type === 'set_in') {
        return `Trim by receiver inner cylinder with ${connection.resolvedPenetrationDepth.toFixed(2)} mm insertion.`;
    }

    return 'Trim by receiver outer cylinder for set-on seating.';
}

export function buildAssemblySolidModel(
    main: DerivedPipeSpec,
    branch: DerivedPipeSpec,
    connection: DerivedConnection,
): SolidModel {
    const mainPrimitiveId = 'main-shell';
    const branchPrimitiveId = 'branch-shell';
    const openingToolId = 'main-opening-tool';
    const mainOpenedId = 'main-opened';
    const branchTrimmedId = 'branch-trimmed';
    const assemblyId = 'assembly-solid';
    const mainFrame = createMainFrame();
    const branchFrame = createBranchFrame(connection);
    const mainRange = mainAxialRange(main);
    const branchRange = branchAxialRange(main, branch, connection);
    const toolRange = openingToolRange(main);

    const primitives: SolidPrimitive[] = [
        {
            kind: 'hollow-cylinder',
            id: mainPrimitiveId,
            label: 'Main Pipe Stock',
            frame: mainFrame,
            axialRange: mainRange,
            outerRadius: main.outerRadius,
            innerRadius: main.innerRadius,
        },
        {
            kind: 'hollow-cylinder',
            id: branchPrimitiveId,
            label: 'Branch Pipe Stock',
            frame: branchFrame,
            axialRange: branchRange,
            outerRadius: branch.outerRadius,
            innerRadius: branch.innerRadius,
        },
        {
            kind: 'solid-cylinder',
            id: openingToolId,
            label: 'Main Opening Tool',
            frame: branchFrame,
            axialRange: toolRange,
            radius: openingToolRadius(branch, connection),
            role: 'main-opening-tool',
        },
    ];

    const trims: SolidTrimOperation[] = [
        createPlaneTrim('trim-main-top', mainPrimitiveId, 'Main Top Cap', mainFrame, mainRange.end, 'less', 1),
        createPlaneTrim('trim-main-bottom', mainPrimitiveId, 'Main Bottom Cap', mainFrame, mainRange.start, 'greater', -1),
        createPlaneTrim('trim-branch-end', branchPrimitiveId, 'Branch Far End', branchFrame, branchRange.end, 'less', 1),
        {
            kind: 'receiver-profile',
            id: 'trim-branch-notch',
            solidId: branchPrimitiveId,
            label: 'Branch Notch Trim',
            receiverSurface: receiverSurfaceForConnection(connection),
            branchContourSurface: branchContourSurfaceForConnection(connection),
            connectionType: connection.type,
            weldingGap: connection.weldingGap,
            offset: connection.offset,
            penetrationDepth: connection.resolvedPenetrationDepth,
            note: receiverTrimNote(connection),
        },
    ];

    const booleans: BooleanIntent[] = [
        {
            id: 'boolean-main-opening',
            operation: 'subtract',
            targetId: mainPrimitiveId,
            toolIds: [openingToolId],
            resultId: mainOpenedId,
            label: 'Cut Main Opening',
            note: 'Subtract opening tool from the receiver body.',
        },
        {
            id: 'boolean-assembly-union',
            operation: 'union',
            targetId: mainOpenedId,
            toolIds: [branchTrimmedId],
            resultId: assemblyId,
            label: 'Assemble Main And Branch',
            note: connection.type === 'set_in'
                ? 'Union opened receiver and inserted branch.'
                : 'Union opened receiver and set-on branch.',
        },
    ];

    return {
        primitives,
        trims,
        booleans,
        outputs: {
            mainPrimitiveId,
            branchPrimitiveId,
            openingToolId,
            mainOpenedId,
            branchTrimmedId,
            assemblyId,
        },
    };
}

export function findPrimitiveById(model: SolidModel, id: string): SolidPrimitive | undefined {
    return model.primitives.find((primitive) => primitive.id === id);
}

export function findBranchFrame(model: SolidModel): Frame3D | undefined {
    const primitive = findPrimitiveById(model, model.outputs.branchPrimitiveId);
    return primitive?.frame;
}

export function frameOrigin(frame: Frame3D): Vec3 {
    return frame.origin;
}
