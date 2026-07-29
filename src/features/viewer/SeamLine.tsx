import React, { useMemo } from 'react';
import * as THREE from 'three';
import { findPrimitiveById } from '../../domain/geometry/solids';
import { evaluateReceiverTrimPreview } from '../../domain/geometry/receiverTrimPreview';
import { useDerivedProject } from '../../hooks/useDerivedProject';
import { createFrameTransform } from './solidPreview';
import { useDisposeObject3DOnChange } from '../../hooks/useDisposeOnChange';

export const SeamLine: React.FC = () => {
    const derivedProject = useDerivedProject();
    const branchPrimitive = findPrimitiveById(derivedProject.solids, derivedProject.solids.outputs.branchPrimitiveId);
    const branchFrame = branchPrimitive?.kind === 'hollow-cylinder' ? branchPrimitive.frame : null;
    const transform = branchFrame ? createFrameTransform(branchFrame) : null;

    const { points, isValid } = useMemo(() => {
        if (!branchFrame) {
            return { points: null, isValid: false };
        }

        const result = evaluateReceiverTrimPreview(derivedProject.solids, 128);
        if (!result.isValid) return { points: null, isValid: false };

        const seamPoints = result.cutCurve.map((point) => new THREE.Vector3(point.x, point.y, point.z));

        return { points: seamPoints, isValid: true };
    }, [branchFrame, derivedProject.solids]);

    const lineObj = useMemo(() => {
        if (!isValid || !points) return null;
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({ color: '#ff3333', linewidth: 3 });
        return new THREE.Line(geo, mat);
    }, [isValid, points]);

    // <primitive> hands ownership to us: R3F disposes neither the line's
    // geometry nor its material, and both are rebuilt on every edit.
    useDisposeObject3DOnChange(lineObj);

    if (!lineObj || !transform) return null;

    return (
        <group position={transform.position} quaternion={transform.quaternion}>
            <primitive object={lineObj} />
        </group>
    );
};
