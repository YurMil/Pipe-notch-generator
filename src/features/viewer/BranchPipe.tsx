import React, { useMemo } from 'react';
import * as THREE from 'three';
import { findPrimitiveById } from '../../domain/geometry/solids';
import { evaluateReceiverTrimPreview } from '../../domain/geometry/receiverTrimPreview';
import { useDerivedProject } from '../../hooks/useDerivedProject';
import { createFrameTransform } from './solidPreview';
import { useDisposeOnChange } from '../../hooks/useDisposeOnChange';

export const BranchPipe: React.FC = () => {
    const derivedProject = useDerivedProject();
    const branchPrimitive = findPrimitiveById(derivedProject.solids, derivedProject.solids.outputs.branchPrimitiveId);
    const branchFrame = branchPrimitive?.kind === 'hollow-cylinder' ? branchPrimitive.frame : null;
    const transform = branchFrame ? createFrameTransform(branchFrame) : null;

    const { geometry, isValid } = useMemo(() => {
        if (!branchFrame) {
            return { geometry: null, isValid: false };
        }

        const result = evaluateReceiverTrimPreview(derivedProject.solids, 128);

        if (!result.isValid) {
            return { geometry: null, isValid: false };
        }

        const geo = new THREE.BufferGeometry();

        // Convert vertices to Float32Array
        const positions = new Float32Array(result.vertices.length * 3);
        result.vertices.forEach((v, i) => {
            positions[i * 3] = v.x;
            positions[i * 3 + 1] = v.y;
            positions[i * 3 + 2] = v.z;
        });

        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(result.uvs), 2));
        geo.setIndex(result.indices);
        geo.computeVertexNormals();

        return { geometry: geo, isValid: true };
    }, [branchFrame, derivedProject.solids]);

    // The geometry is rebuilt on every parameter change and passed to <mesh>
    // by prop, so R3F never disposes it — release it explicitly.
    useDisposeOnChange(geometry);

    // Conditional rendering of mesh
    const meshComponent = useMemo(() => {
        if (!isValid || !geometry || !transform) return null;
        return (
            <group position={transform.position} quaternion={transform.quaternion}>
                <mesh geometry={geometry}>
                    <meshStandardMaterial
                        color="#2f7eff"
                        roughness={0.24}
                        metalness={0.42}
                        emissive="#0b1d45"
                        emissiveIntensity={0.28}
                        side={THREE.DoubleSide}
                        transparent={derivedProject.connection.type === 'set_in'}
                        opacity={derivedProject.connection.type === 'set_in' ? 0.96 : 1}
                    />
                </mesh>
            </group>
        );
    }, [derivedProject.connection.type, geometry, isValid, transform]);

    return meshComponent;
};
