import { useEffect } from 'react';

type Disposable = { dispose: () => void } | null | undefined;

/**
 * Releases a Three.js resource when it is replaced or when the component
 * unmounts (cadautoscript.com#101).
 *
 * react-three-fiber only owns — and therefore only disposes — objects it
 * constructs itself from declarative JSX (`<bufferGeometry />`). Anything
 * built imperatively and handed over through a prop (`geometry={geo}`,
 * `<primitive object={line} />`) stays owned by the component that made it.
 *
 * That matters here because the preview geometry is rebuilt on every
 * parameter change: without this, dragging a diameter or angle slider
 * orphaned a BufferGeometry (and, for the seam, a material) on each frame of
 * the interaction, retaining their GPU buffers for the life of the page.
 *
 * The effect's cleanup runs both when `resource` changes — disposing the
 * previous value, which the closure still holds — and on unmount.
 */
export function useDisposeOnChange(resource: Disposable): void {
    useEffect(() => {
        if (!resource) return;
        return () => {
            resource.dispose();
        };
    }, [resource]);
}

/**
 * Disposes a THREE.Line/Mesh-like object together with the geometry and
 * material it owns — `Object3D.dispose()` does not cascade to them.
 */
export function useDisposeObject3DOnChange(
    object: {geometry?: Disposable; material?: Disposable} | null | undefined,
): void {
    useEffect(() => {
        if (!object) return;
        return () => {
            object.geometry?.dispose();
            object.material?.dispose();
        };
    }, [object]);
}
