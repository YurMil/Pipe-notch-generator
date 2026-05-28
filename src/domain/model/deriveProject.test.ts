import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT } from './defaults';
import { deriveProject } from './deriveProject';
import { findPrimitiveById } from '../geometry/solids';

describe('deriveProject', () => {
    it('derives inner diameters and default set_in penetration', () => {
        const derived = deriveProject({
            ...DEFAULT_PROJECT,
            connection: {
                ...DEFAULT_PROJECT.connection,
                type: 'set_in',
                penetrationMode: 'by_rule',
            },
        });

        expect(derived.main.id).toBe(94);
        expect(derived.branch.id).toBe(46);
        expect(derived.connection.resolvedPenetrationDepth).toBe(3);
        expect(derived.limits.maxOffset).toBe(22);
        expect(derived.solids.booleans).toHaveLength(2);
    });

    it('flags invalid wall thickness combinations', () => {
        const derived = deriveProject({
            ...DEFAULT_PROJECT,
            main: {
                od: 100,
                wall: 60,
            },
        });

        expect(derived.validation.isValid).toBe(false);
        expect(derived.validation.errors.some((message) => message.code === 'main-id')).toBe(true);
    });

    it('keeps main opening geometry stable when welding gap changes', () => {
        const derived = deriveProject({
            ...DEFAULT_PROJECT,
            connection: {
                ...DEFAULT_PROJECT.connection,
                weldingGap: 30,
            },
        });
        const openingTool = findPrimitiveById(derived.solids, derived.solids.outputs.openingToolId);

        expect(derived.validation.isValid).toBe(true);
        expect(openingTool?.kind === 'solid-cylinder' ? openingTool.radius : null).toBe(50 / 2);
    });

    it('accepts equal-diameter set-on geometry with welding gap', () => {
        const derived = deriveProject({
            ...DEFAULT_PROJECT,
            branch: {
                od: 100,
                wall: 3,
            },
            connection: {
                ...DEFAULT_PROJECT.connection,
                axisAngleDeg: 90,
                weldingGap: 50,
                useOuterBranchContour: true,
            },
        });

        expect(derived.validation.isValid).toBe(true);
    });

    it('builds a solid graph with hollow cylinders and boolean intents', () => {
        const derived = deriveProject(DEFAULT_PROJECT);
        const mainPrimitive = findPrimitiveById(derived.solids, derived.solids.outputs.mainPrimitiveId);
        const branchPrimitive = findPrimitiveById(derived.solids, derived.solids.outputs.branchPrimitiveId);
        const openingTool = findPrimitiveById(derived.solids, derived.solids.outputs.openingToolId);

        expect(mainPrimitive?.kind).toBe('hollow-cylinder');
        expect(branchPrimitive?.kind).toBe('hollow-cylinder');
        expect(openingTool?.kind).toBe('solid-cylinder');
        expect(derived.solids.trims.some((trim) => trim.kind === 'receiver-profile')).toBe(true);
        expect(derived.solids.booleans.map((operation) => operation.operation)).toEqual(['subtract', 'union']);
    });

    it('switches receiver trim intent to the inner wall for set_in', () => {
        const derived = deriveProject({
            ...DEFAULT_PROJECT,
            connection: {
                ...DEFAULT_PROJECT.connection,
                type: 'set_in',
                penetrationMode: 'by_value',
                penetrationDepth: 6,
            },
        });

        const receiverTrim = derived.solids.trims.find((trim) => trim.kind === 'receiver-profile');
        const branchPrimitive = findPrimitiveById(derived.solids, derived.solids.outputs.branchPrimitiveId);

        expect(receiverTrim && receiverTrim.kind === 'receiver-profile' ? receiverTrim.receiverSurface : null).toBe('main-inner');
        expect(receiverTrim && receiverTrim.kind === 'receiver-profile' ? receiverTrim.branchContourSurface : null).toBe('branch-outer');
        expect(receiverTrim && receiverTrim.kind === 'receiver-profile' ? receiverTrim.penetrationDepth : null).toBe(6);
        expect(receiverTrim && receiverTrim.kind === 'receiver-profile' ? receiverTrim.note.includes('6.00') : false).toBe(true);
        expect(branchPrimitive?.kind === 'hollow-cylinder' ? branchPrimitive.frame.origin.z : null).toBe(0);
    });
});
