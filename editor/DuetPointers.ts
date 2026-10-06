// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// DuetBox: draws other people's mouse pointers.

import { SVG } from "imperative-html/dist/esm/elements-strict";
import { DuetPointer, DuetRemotePointer } from "./SongDocument";

export interface DrawnPointer {
	x: number;
	y: number;
	color: string;
	name: string;
	/** Drawn see-through, for someone who is somewhere else (e.g. on another pattern). */
	faded?: boolean;
	/** Shown after the name, e.g. where they are. */
	detail?: string;
}

/** Redraws the pointers inside an SVG group, positioned in that group's pixel coordinates. */
export function drawPointers(group: SVGGElement, pointers: DrawnPointer[], width: number, height: number): void {
	while (group.firstChild != null) group.removeChild(group.firstChild);
	for (const pointer of pointers) {
		if (pointer.x < -2 || pointer.y < -2 || pointer.x > width + 2 || pointer.y > height + 2) continue;
		const name: string = (pointer.name.length > 18 ? pointer.name.substring(0, 17) + "…" : pointer.name) + (pointer.detail == undefined ? "" : " " + pointer.detail);
		const labelWidth: number = 8 + name.length * 6;
		// Keep the name tag inside the editor near the right and bottom edges.
		const labelX: number = pointer.x + 10 + labelWidth > width ? -labelWidth - 2 : 10;
		const labelY: number = pointer.y + 30 > height ? -18 : 14;
		group.appendChild(SVG.g({ transform: `translate(${pointer.x.toFixed(1)},${pointer.y.toFixed(1)})`, opacity: pointer.faded ? 0.45 : 1 },
			SVG.path({ d: "M 0 0 L 0 14 L 4 10.5 L 7 16.5 L 9.5 15.5 L 6.5 9.5 L 11 9.5 Z", fill: pointer.color, stroke: "black", "stroke-width": 1, "stroke-linejoin": "round" }),
			SVG.rect({ x: labelX, y: labelY, width: labelWidth, height: 14, rx: 3, fill: pointer.color }),
			SVG.text({ x: labelX + 4, y: labelY + 10.5, "font-size": "10px", "font-family": "sans-serif", fill: "black" }, name),
		));
	}
}

/** Marks an element that changes position in the page depending on each person's settings. */
const anchorAttribute: string = "data-duet-anchor";

/**
 * Lets pointers over an element (or inside it) find it by name, for elements whose place in
 * the page differs between people, e.g. because of a setting. Their siblings are counted as
 * if they weren't there, so those keep the same position for everyone too.
 */
export function markDuetAnchor(element: Element, name: string): void {
	element.setAttribute(anchorAttribute, name);
}

/** The position of a child among its siblings, not counting anchors, which move around. */
function stableIndex(element: Element): number {
	let index: number = 0;
	for (let sibling: Element | null = element.previousElementSibling; sibling != null; sibling = sibling.previousElementSibling) {
		if (!sibling.hasAttribute(anchorAttribute)) index++;
	}
	return index;
}

function stableChild(parent: Element, index: number): Element | null {
	for (let child: Element | null = parent.firstElementChild; child != null; child = child.nextElementSibling) {
		if (child.hasAttribute(anchorAttribute)) continue;
		if (index == 0) return child;
		index--;
	}
	return null;
}

/**
 * Shows other people's pointers anywhere on the page outside the pattern and track
 * editors (menus, song and instrument settings, buttons...). Each pointer is anchored
 * to the element it's over, so it lands on the same control even if the layout differs.
 */
export class DuetPointerOverlay {
	private readonly _group: SVGGElement = SVG.g();
	// Above the editor but below prompts, like the pointers inside the editors.
	private readonly _svg: SVGSVGElement = SVG.svg({ style: "position: fixed; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; z-index: 50; overflow: hidden;" }, this._group);
	private _pointers: DuetRemotePointer[] = [];
	private _drawn: string = "[]";
	private _frame: number | null = null;

	constructor(private readonly _editorRoot: HTMLElement) {
		document.body.appendChild(this._svg);
		window.addEventListener("resize", this.redraw);
		window.addEventListener("scroll", this.redraw, { capture: true, passive: true });
	}

	/** Describes where on the page an element under the pointer is. */
	public locate(target: Element, clientX: number, clientY: number): DuetPointer | null {
		let element: Element = target;
		// Anchor to the outermost SVG, since the shapes inside one are often redrawn.
		while (element instanceof SVGElement && element.ownerSVGElement != null) element = element.ownerSVGElement;
		let root: Element = this._editorRoot.contains(element) ? this._editorRoot : document.body;
		if (!root.contains(element)) return null;
		const indices: number[] = [];
		let node: Element = element;
		while (node != root && !node.hasAttribute(anchorAttribute)) {
			if (node.parentElement == null || indices.length >= 60) return null;
			indices.push(stableIndex(node));
			node = node.parentElement;
		}
		const rect: DOMRect = element.getBoundingClientRect();
		if (rect.width == 0 || rect.height == 0) return null;
		let path: string = node == this._editorRoot ? "e" : node == document.body ? "b" : "@" + node.getAttribute(anchorAttribute);
		for (let i: number = indices.length - 1; i >= 0; i--) path += "." + indices[i];
		return { area: "ui", channel: 0, bar: 0, x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height, path: path };
	}

	public render(pointers: DuetRemotePointer[]): void {
		this._pointers = pointers.filter(pointer => pointer.area == "ui" && pointer.path != undefined);
		this.redraw();
	}

	/** Moves the pointers to follow their elements (e.g. after the layout changed), once per frame at most. */
	public redraw = (): void => {
		if (this._frame == null && (this._pointers.length > 0 || this._drawn != "[]")) {
			this._frame = requestAnimationFrame(this._redrawNow);
		}
	}

	private _redrawNow = (): void => {
		this._frame = null;
		const drawn: DrawnPointer[] = [];
		for (const pointer of this._pointers) {
			const element: Element | null = this._resolve(pointer.path!);
			if (element == null) continue;
			const rect: DOMRect = element.getBoundingClientRect();
			// Hidden here, e.g. part of a menu that only they have open.
			if (rect.width == 0 || rect.height == 0) continue;
			const x: number = rect.left + pointer.x * rect.width;
			const y: number = rect.top + pointer.y * rect.height;
			if (!this._isScrolledIntoView(element, x, y)) continue;
			drawn.push({ x: x, y: y, color: pointer.color, name: pointer.name });
		}
		const key: string = JSON.stringify(drawn);
		if (key == this._drawn) return;
		this._drawn = key;
		drawPointers(this._group, drawn, document.documentElement.clientWidth, document.documentElement.clientHeight);
	}

	/** False if a scrolling panel around the element has scrolled that spot out of sight. */
	private _isScrolledIntoView(element: Element, x: number, y: number): boolean {
		for (let node: Element | null = element.parentElement; node != null && node != document.body; node = node.parentElement) {
			const style: CSSStyleDeclaration = getComputedStyle(node);
			if (style.overflowX == "visible" && style.overflowY == "visible") continue;
			const rect: DOMRect = node.getBoundingClientRect();
			if (x < rect.left - 1 || x > rect.right + 1 || y < rect.top - 1 || y > rect.bottom + 1) return false;
		}
		return true;
	}

	private _resolve(path: string): Element | null {
		const parts: string[] = path.split(".");
		let element: Element | null;
		if (parts[0] == "e") element = this._editorRoot;
		else if (parts[0] == "b") element = document.body;
		else element = this._editorRoot.querySelector("[" + anchorAttribute + "=\"" + parts[0].substring(1) + "\"]");
		for (let i: number = 1; i < parts.length && element != null; i++) {
			element = stableChild(element, Number(parts[i]));
		}
		return element == null || this._svg.contains(element) ? null : element;
	}
}
