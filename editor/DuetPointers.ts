// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// DuetBox: draws other people's mouse pointers.

import { SVG } from "imperative-html/dist/esm/elements-strict";

export interface DrawnPointer {
	x: number;
	y: number;
	color: string;
	name: string;
}

/** Redraws the pointers inside an SVG group, positioned in that group's pixel coordinates. */
export function drawPointers(group: SVGGElement, pointers: DrawnPointer[], width: number, height: number): void {
	while (group.firstChild != null) group.removeChild(group.firstChild);
	for (const pointer of pointers) {
		if (pointer.x < -2 || pointer.y < -2 || pointer.x > width + 2 || pointer.y > height + 2) continue;
		const labelWidth: number = Math.min(120, 8 + pointer.name.length * 6);
		// Keep the name tag inside the editor near the right and bottom edges.
		const labelX: number = pointer.x + 10 + labelWidth > width ? -labelWidth - 2 : 10;
		const labelY: number = pointer.y + 30 > height ? -18 : 14;
		group.appendChild(SVG.g({ transform: `translate(${pointer.x.toFixed(1)},${pointer.y.toFixed(1)})` },
			SVG.path({ d: "M 0 0 L 0 14 L 4 10.5 L 7 16.5 L 9.5 15.5 L 6.5 9.5 L 11 9.5 Z", fill: pointer.color, stroke: "black", "stroke-width": 1, "stroke-linejoin": "round" }),
			SVG.rect({ x: labelX, y: labelY, width: labelWidth, height: 14, rx: 3, fill: pointer.color }),
			SVG.text({ x: labelX + 4, y: labelY + 10.5, "font-size": "10px", "font-family": "sans-serif", fill: "black" }, pointer.name.length > 18 ? pointer.name.substring(0, 17) + "…" : pointer.name),
		));
	}
}
