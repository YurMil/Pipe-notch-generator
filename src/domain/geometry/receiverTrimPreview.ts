import type { Point2D } from '../../types';
import { dotVec3, subVec3, type Vec3 } from './vector';
import {
    findPrimitiveById,
    type HollowCylinderPrimitive,
    type PlaneTrimOperation,
    type ReceiverTrimOperation,
    type SolidModel,
    type SolidTrimOperation,
} from './solids';

export interface ReceiverTrimPreviewResult {
    vertices: Vec3[];
    indices: number[];
    uvs: number[];
    cutCurve: Vec3[];
    contour2D: Point2D[];
    isValid: boolean;
    error?: string;
}

interface ReceiverTrimConfig {
    receiverTrim: ReceiverTrimOperation;
    farEndAxial: number;
    receiverContactRadius: number;
    branchMeshRadius: number;
    trimContourRadius: number;
    sT: number;
    tT: number;
}

function safeSmall(value: number, fallbackMagnitude: number = 1e-6) {
    if (Math.abs(value) >= fallbackMagnitude) {
        return value;
    }

    return value >= 0 ? fallbackMagnitude : -fallbackMagnitude;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function findReceiverTrim(model: SolidModel, solidId: string): ReceiverTrimOperation | undefined {
    return model.trims.find((trim): trim is ReceiverTrimOperation => {
        return trim.kind === 'receiver-profile' && trim.solidId === solidId;
    });
}

function findPlaneTrim(model: SolidModel, solidId: string, trimId: string): PlaneTrimOperation | undefined {
    return model.trims.find((trim): trim is PlaneTrimOperation => {
        return trim.kind === 'plane' && trim.solidId === solidId && trim.id === trimId;
    });
}

function resolveAxialOffset(trim: PlaneTrimOperation, solid: HollowCylinderPrimitive) {
    return dotVec3(subVec3(trim.plane.origin, solid.frame.origin), solid.frame.axis);
}

function receiverRadius(main: HollowCylinderPrimitive, trim: ReceiverTrimOperation) {
    return trim.receiverSurface === 'main-inner' ? main.innerRadius : main.outerRadius;
}

function branchTrimRadius(branch: HollowCylinderPrimitive, trim: ReceiverTrimOperation) {
    return trim.branchContourSurface === 'branch-inner' ? branch.innerRadius : branch.outerRadius;
}

function branchAxisAngleRad(main: HollowCylinderPrimitive, branch: HollowCylinderPrimitive) {
    const cosine = clamp(dotVec3(main.frame.axis, branch.frame.axis), -1, 1);
    return Math.acos(cosine);
}

function resolveReceiverTrimConfig(model: SolidModel): ReceiverTrimConfig | { error: string } {
    const main = findPrimitiveById(model, model.outputs.mainPrimitiveId);
    const branch = findPrimitiveById(model, model.outputs.branchPrimitiveId);

    if (!main || main.kind !== 'hollow-cylinder') {
        return { error: 'SolidModel error: missing main hollow cylinder.' };
    }

    if (!branch || branch.kind !== 'hollow-cylinder') {
        return { error: 'SolidModel error: missing branch hollow cylinder.' };
    }

    const receiverTrim = findReceiverTrim(model, branch.id);
    const farEndTrim = findPlaneTrim(model, branch.id, 'trim-branch-end');

    if (!receiverTrim) {
        return { error: 'SolidModel error: missing receiver-profile trim for branch.' };
    }

    if (!farEndTrim) {
        return { error: 'SolidModel error: missing far-end trim for branch.' };
    }

    const receiverContactRadius = receiverRadius(main, receiverTrim);
    const branchMeshRadius = branch.outerRadius;
    const trimContourRadius = branchTrimRadius(branch, receiverTrim);
    const angleRad = branchAxisAngleRad(main, branch);
    const sinTheta = Math.sin(angleRad);
    const tanTheta = Math.tan(angleRad);
    const sT = safeSmall(sinTheta);
    const tT = safeSmall(tanTheta);
    const farEndAxial = resolveAxialOffset(farEndTrim, branch);

    if (receiverContactRadius <= 0 || branchMeshRadius <= 0 || trimContourRadius <= 0) {
        return { error: 'SolidModel error: invalid cylinder radii for receiver trim.' };
    }

    if (!Number.isFinite(farEndAxial) || farEndAxial <= 0) {
        return { error: 'SolidModel error: invalid branch far-end trim.' };
    }

    return {
        receiverTrim,
        farEndAxial,
        receiverContactRadius,
        branchMeshRadius,
        trimContourRadius,
        sT,
        tT,
    };
}

function validateIntersection(config: ReceiverTrimConfig, segments: number) {
    for (let step = 0; step <= segments; step += 1) {
        const alpha = (step / segments) * Math.PI * 2;
        const term = (config.receiverContactRadius ** 2)
            - ((config.trimContourRadius * Math.sin(alpha)) + config.receiverTrim.offset) ** 2;
        if (term < -0.1) {
            return 'Geometry Error: Pipes do not intersect.';
        }
    }

    return null;
}

export function validateReceiverTrim(model: SolidModel, segments: number = 128): string | null {
    const resolved = resolveReceiverTrimConfig(model);
    if ('error' in resolved) {
        return resolved.error;
    }

    return validateIntersection(resolved, segments);
}

function calculateCutDepth(config: ReceiverTrimConfig, alpha: number) {
    const sinAlpha = Math.sin(alpha);
    const cosAlpha = Math.cos(alpha);
    let term = (config.receiverContactRadius ** 2)
        - ((config.trimContourRadius * sinAlpha) + config.receiverTrim.offset) ** 2;
    if (term < 0) {
        term = 0;
    }

    return ((1 / config.sT) * Math.sqrt(term))
        + ((config.branchMeshRadius * cosAlpha) / config.tT)
        + config.receiverTrim.weldingGap
        - config.receiverTrim.penetrationDepth;
}

export function evaluateReceiverTrimPreview(
    model: SolidModel,
    segments: number = 128,
): ReceiverTrimPreviewResult {
    const resolved = resolveReceiverTrimConfig(model);
    if ('error' in resolved) {
        return {
            vertices: [],
            indices: [],
            uvs: [],
            cutCurve: [],
            contour2D: [],
            isValid: false,
            error: resolved.error,
        };
    }

    const intersectionError = validateIntersection(resolved, segments);
    if (intersectionError) {
        return {
            vertices: [],
            indices: [],
            uvs: [],
            cutCurve: [],
            contour2D: [],
            isValid: false,
            error: intersectionError,
        };
    }

    const vertices: Vec3[] = [];
    const cutCurve: Vec3[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];
    const contour2D: Point2D[] = [];

    for (let row = 0; row <= 1; row += 1) {
        for (let step = 0; step <= segments; step += 1) {
            const alpha = (step / segments) * Math.PI * 2;
            const cutDepth = calculateCutDepth(resolved, alpha);
            const axial = row === 0 ? cutDepth : resolved.farEndAxial;
            const point = {
                x: resolved.branchMeshRadius * Math.cos(alpha),
                y: resolved.branchMeshRadius * Math.sin(alpha),
                z: axial,
            };

            vertices.push(point);
            uvs.push(step / segments, row);

            if (row === 0) {
                cutCurve.push(point);
                contour2D.push({
                    x: (step / segments) * (Math.PI * 2 * resolved.branchMeshRadius),
                    y: cutDepth,
                });
            }
        }
    }

    for (let step = 0; step < segments; step += 1) {
        const a = step;
        const b = step + 1;
        const c = step + segments + 1;
        const d = step + segments + 2;

        indices.push(a, b, d);
        indices.push(a, d, c);
    }

    return {
        vertices,
        indices,
        uvs,
        cutCurve,
        contour2D,
        isValid: true,
    };
}

export function evaluateReceiverTrimUnrolledPoints(
    model: SolidModel,
    startAngleDeg: number = 0,
    padding: number = 0,
    steps: number = 360,
): Point2D[] {
    const resolved = resolveReceiverTrimConfig(model);
    if ('error' in resolved) {
        return [];
    }

    const intersectionError = validateIntersection(resolved, steps);
    if (intersectionError) {
        return [];
    }

    const startAngleRad = (startAngleDeg * Math.PI) / 180;
    const circumference = Math.PI * 2 * resolved.branchMeshRadius;
    const points: Point2D[] = [];

    for (let index = 0; index <= steps; index += 1) {
        const ratio = index / steps;
        const alpha = (ratio * Math.PI * 2) + startAngleRad;
        points.push({
            x: ratio * circumference,
            y: calculateCutDepth(resolved, alpha),
        });
    }

    let minY = Infinity;
    for (const point of points) {
        minY = Math.min(minY, point.y);
    }

    if (!Number.isFinite(minY)) {
        return [];
    }

    return points.map((point) => ({
        x: point.x,
        y: point.y - minY + padding,
    }));
}

export function findTrimForSolid(model: SolidModel, solidId: string, kind: SolidTrimOperation['kind']) {
    return model.trims.find((trim) => trim.solidId === solidId && trim.kind === kind);
}
