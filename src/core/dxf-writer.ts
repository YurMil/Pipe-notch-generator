import type { Point2D } from '../types';

export class DxfWriter {
    private parts: string[] = [];

    constructor() {
        this.addHeader();
    }

    private addHeader() {
        // Proper DXF R12 preamble: strict viewers (eDrawings, AutoCAD) reject
        // entities-only files, and the CenterLines layer plus its CONTINUOUS
        // linetype must be declared before use. $MEASUREMENT = 1 marks the
        // drawing as metric.
        this.parts.push(
            "0\nSECTION\n2\nHEADER\n" +
            "9\n$ACADVER\n1\nAC1009\n" +
            "9\n$MEASUREMENT\n70\n1\n" +
            "0\nENDSEC\n" +
            "0\nSECTION\n2\nTABLES\n" +
            "0\nTABLE\n2\nLTYPE\n70\n1\n" +
            "0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n" +
            "0\nENDTAB\n" +
            "0\nTABLE\n2\nLAYER\n70\n2\n" +
            "0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n" +
            "0\nLAYER\n2\nCenterLines\n70\n0\n62\n1\n6\nCONTINUOUS\n" +
            "0\nENDTAB\n" +
            "0\nENDSEC\n" +
            "0\nSECTION\n2\nENTITIES\n"
        );
    }


    public addPolyline(points: Point2D[], closed: boolean = false) {
        if (points.length === 0) return;

        // Polyline Start
        this.parts.push(`0\nPOLYLINE\n8\n0\n66\n1\n70\n${closed ? 1 : 0}\n`);

        // Vertices
        points.forEach(p => {
            this.parts.push(`0\nVERTEX\n8\n0\n10\n${p.x.toFixed(4)}\n20\n${p.y.toFixed(4)}\n30\n0.0\n`);
        });

        // Loop Closing (Manual vertex repeat if needed, but flag 70 usually handles it in modern viewers)
        // Request says: "Loop Closing: Ensure the first and last points match"
        if (closed) {
            const first = points[0];
            const last = points[points.length - 1];
            // Simple epsilon check or just push first if not equal
            const dist = Math.sqrt(Math.pow(first.x - last.x, 2) + Math.pow(first.y - last.y, 2));
            if (dist > 0.001) {
                this.parts.push(`0\nVERTEX\n8\n0\n10\n${first.x.toFixed(4)}\n20\n${first.y.toFixed(4)}\n30\n0.0\n`);
            }
        }

        // Sequence End
        this.parts.push("0\nSEQEND\n");
    }

    public addLine(p1: Point2D, p2: Point2D, colorIndex: number = 0) {
        // LINE Entity
        // 0: LINE
        // 8: Layer (0)
        // 62: Color (if not 0/ByLayer). 1 = Red.
        // 10, 20: Start X, Y
        // 11, 21: End X, Y

        this.parts.push(`0\nLINE\n8\nCenterLines\n`);
        if (colorIndex > 0) {
            this.parts.push(`62\n${colorIndex}\n`);
        }
        this.parts.push(`10\n${p1.x.toFixed(4)}\n20\n${p1.y.toFixed(4)}\n30\n0.0\n`);
        this.parts.push(`11\n${p2.x.toFixed(4)}\n21\n${p2.y.toFixed(4)}\n31\n0.0\n`);
    }

    /**
     * Adds a simple rectangular frame (useful for templates)
     */
    public addRectangle(minX: number, minY: number, maxX: number, maxY: number) {
        this.addPolyline([
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
            { x: minX, y: minY } // Explicit close
        ], true);
    }

    public createString(): string {
        // Clone parts to avoid mutating state if called multiple times before finish? 
        // We just append footer on demand or keep state?
        // Let's just return what we have inclusive of footer.
        // Actually, stateless utility was requested: "Create a stateless utility..." 
        // My class is stateful. Let's make a static method.
        // "Class structure" was implied by "DxfWriter", but "stateless utility" suggests pure function.
        // I'll stick to the class for internal building but expose a static helper or just ensure it's used transiently.

        return [...this.parts, "0\nENDSEC\n0\nEOF\n"].join("");
    }
}

/**
 * Functional wrapper to match "stateless utility" requirement more directly.
 */
export function createDxfString(points: Point2D[], closed: boolean): string {
    const writer = new DxfWriter();
    writer.addPolyline(points, closed);
    return writer.createString();
}
