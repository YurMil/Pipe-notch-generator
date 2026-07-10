import { describe, expect, it } from 'vitest';
import { calculateNotchGeometry } from '../../core/__tests__/legacy-geometry-engine';
import { DEFAULT_PROJECT } from '../model/defaults';
import { deriveProject } from '../model/deriveProject';
import { dotVec3, subVec3, type Vec3 } from './vector';
import { evaluateReceiverTrimPreview } from './receiverTrimPreview';

function frameTangent(frame: {
    binormal: Vec3;
}) {
    return {
        x: -frame.binormal.x,
        y: -frame.binormal.y,
        z: -frame.binormal.z,
    };
}

function toFrameLocal(point: Vec3, frame: {
    origin: Vec3;
    axis: Vec3;
    normal: Vec3;
    binormal: Vec3;
}) {
    const tangent = frameTangent(frame);
    const delta = subVec3(point, frame.origin);

    return {
        x: dotVec3(delta, tangent),
        y: dotVec3(delta, frame.normal),
        z: dotVec3(delta, frame.axis),
    };
}

describe('receiver trim preview', () => {
    it('matches the legacy branch preview for the default set_on case', () => {
        const derived = deriveProject(DEFAULT_PROJECT);
        const preview = evaluateReceiverTrimPreview(derived.solids, 32);
        const legacy = calculateNotchGeometry(derived.geometry, 32);
        const branchPrimitive = derived.solids.primitives.find((primitive) => primitive.id === derived.solids.outputs.branchPrimitiveId);

        expect(preview.isValid).toBe(true);
        expect(legacy.isValid).toBe(true);
        expect(branchPrimitive?.kind).toBe('hollow-cylinder');

        const totalDelta = legacy.vertices.slice(0, 33).reduce((sum, point, index) => {
            if (!branchPrimitive || branchPrimitive.kind !== 'hollow-cylinder') {
                return sum;
            }

            const local = toFrameLocal(point, branchPrimitive.frame);
            const previewPoint = preview.cutCurve[index];

            return sum
                + Math.abs(local.x - previewPoint.x)
                + Math.abs(local.y - previewPoint.y)
                + Math.abs(local.z - previewPoint.z);
        }, 0);

        expect(totalDelta).toBeLessThan(0.01);
    });

    it('changes cut depths when set_in penetration is enabled', () => {
        const setOn = deriveProject(DEFAULT_PROJECT);
        const setIn = deriveProject({
            ...DEFAULT_PROJECT,
            connection: {
                ...DEFAULT_PROJECT.connection,
                type: 'set_in',
                useOuterBranchContour: false,
                penetrationMode: 'by_value',
                penetrationDepth: 6,
            },
        });

        const setOnPreview = evaluateReceiverTrimPreview(setOn.solids, 64);
        const setInPreview = evaluateReceiverTrimPreview(setIn.solids, 64);

        expect(setOnPreview.isValid).toBe(true);
        expect(setInPreview.isValid).toBe(true);

        const totalDelta = setOnPreview.cutCurve.reduce((sum, point, index) => {
            return sum + Math.abs((setInPreview.cutCurve[index]?.z ?? 0) - point.z);
        }, 0);

        expect(totalDelta).toBeGreaterThan(0.1);
    });

    it('moves the branch cut away from the receiver when welding gap increases', () => {
        const zeroGap = deriveProject({
            ...DEFAULT_PROJECT,
            branch: {
                od: 100,
                wall: 3,
            },
            connection: {
                ...DEFAULT_PROJECT.connection,
                axisAngleDeg: 90,
                weldingGap: 0,
                useOuterBranchContour: true,
            },
        });
        const gapped = deriveProject({
            ...zeroGap.input,
            connection: {
                ...zeroGap.input.connection,
                weldingGap: 10,
            },
        });

        const zeroGapPreview = evaluateReceiverTrimPreview(zeroGap.solids, 64);
        const gappedPreview = evaluateReceiverTrimPreview(gapped.solids, 64);

        expect(zeroGapPreview.isValid).toBe(true);
        expect(gappedPreview.isValid).toBe(true);

        const zeroGapMin = Math.min(...zeroGapPreview.cutCurve.map((point) => point.z));
        const gappedMin = Math.min(...gappedPreview.cutCurve.map((point) => point.z));

        expect(gappedMin).toBeGreaterThan(zeroGapMin);
        expect(gappedMin - zeroGapMin).toBeCloseTo(10, 6);
    });

    it('fails when the receiver trim no longer intersects the branch contour', () => {
        const derived = deriveProject({
            ...DEFAULT_PROJECT,
            connection: {
                ...DEFAULT_PROJECT.connection,
                offset: 60,
            },
        });

        const preview = evaluateReceiverTrimPreview(derived.solids, 32);

        expect(preview.isValid).toBe(false);
        expect(preview.error).toContain('do not intersect');
    });
});
