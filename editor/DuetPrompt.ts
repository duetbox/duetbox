// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// DuetBox: the window for creating, joining, and leaving a room.

import { HTML } from "imperative-html/dist/esm/elements-strict";
import { ColorConfig } from "./ColorConfig";
import { SongDocument } from "./SongDocument";
import { Prompt } from "./Prompt";
import { DuetController, DuetSession, DuetStatus, loadDuetName } from "./DuetSession";
import { DuetNetworkSettings, formatInviteCode, loadNetworkSettings, parseInviteCode, saveNetworkSettings } from "./DuetNetwork";

const { a, button, details, div, h2, input, label, span, summary, textarea } = HTML;

// How long to look for a room before offering to create it.
const searchHintDelay: number = 12000;

const rowStyle: string = "display: flex; align-items: center; gap: 0.5em;";
const inputStyle: string = "flex-grow: 1; min-width: 0; text-align: left; padding: 2px 6px;";
const dimStyle: string = `color: ${ColorConfig.secondaryText}; font-size: 0.9em;`;

export function duetStatusText(session: DuetSession): string {
	switch (session.status) {
		case DuetStatus.hosting: return "Room open";
		case DuetStatus.connected: return "Connected";
		case DuetStatus.hostLeft: return "Reconnecting…";
		default: return "Connecting…";
	}
}

export function duetStatusColor(session: DuetSession): string {
	switch (session.status) {
		case DuetStatus.hosting:
		case DuetStatus.connected: return "#69db7c";
		case DuetStatus.hostLeft: return "#ffa94d";
		default: return "#ffd43b";
	}
}

function dot(color: string): HTMLSpanElement {
	return span({ style: `flex-shrink: 0; width: 0.7em; height: 0.7em; border-radius: 50%; background: ${color};` });
}

export class DuetPrompt implements Prompt {
	private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });
	private readonly _body: HTMLDivElement = div({ style: "display: flex; flex-direction: column; gap: 0.8em; text-align: left;" });
	public readonly container: HTMLDivElement = div({ class: "prompt noSelection duetPrompt", style: "width: 300px; max-width: calc(100vw - 60px);" },
		h2("Duet"),
		this._body,
		this._cancelButton,
	);

	private _renderedSession: DuetSession | null = null;
	private _renderedOnce: boolean = false;
	private _searchStarted: number = 0;
	private readonly _refreshTimer: number;
	private readonly _peerList: HTMLDivElement = div({ style: "display: flex; flex-direction: column; gap: 3px;" });
	private readonly _statusLine: HTMLDivElement = div({ style: rowStyle });
	private readonly _hint: HTMLDivElement = div();

	constructor(private readonly _doc: SongDocument, private readonly _duet: DuetController) {
		this._cancelButton.addEventListener("click", this._close);
		this._duet.listen(this._render);
		this._render();
		this._refreshTimer = window.setInterval(this._renderHint, 1000);
	}

	public cleanUp = (): void => {
		this._cancelButton.removeEventListener("click", this._close);
		this._duet.unlisten(this._render);
		window.clearInterval(this._refreshTimer);
	}

	private _close = (): void => {
		this._doc.undo();
	}

	private _render = (): void => {
		const session: DuetSession | null = this._duet.session;
		if (session != this._renderedSession || !this._renderedOnce) {
			this._renderedSession = session;
			this._renderedOnce = true;
			this._searchStarted = performance.now();
			this._body.replaceChildren(...(session == null ? this._buildJoinView() : this._buildRoomView(session)));
		}
		if (session != null) {
			this._statusLine.replaceChildren(dot(duetStatusColor(session)), span(duetStatusText(session)));
			this._renderPeers(session);
			this._renderHint();
		}
	}

	// ---- Not in a room ----

	private _buildJoinView(): HTMLElement[] {
		const nameInput: HTMLInputElement = input({ type: "text", maxlength: "24", value: loadDuetName(), style: inputStyle });
		const codeInput: HTMLInputElement = input({ type: "text", placeholder: "ABCD-EFGH", maxlength: "200", style: inputStyle + " text-transform: uppercase;" });
		const createButton: HTMLButtonElement = button({ style: "width: 100%;" }, "Create room");
		const joinButton: HTMLButtonElement = button({ style: "flex-shrink: 0; padding: 0 1em;" }, "Join room");
		const error: HTMLDivElement = div({ style: dimStyle });

		if (this._duet.pendingInviteCode != null) {
			codeInput.value = formatInviteCode(this._duet.pendingInviteCode);
			window.setTimeout(() => joinButton.focus());
		}

		const join = (): void => {
			const code: string | null = parseInviteCode(codeInput.value);
			if (code == null) {
				error.textContent = "Invalid code.";
				codeInput.focus();
				return;
			}
			this._duet.join(code, nameInput.value);
		};
		createButton.addEventListener("click", () => { this._duet.start(nameInput.value); });
		joinButton.addEventListener("click", join);
		codeInput.addEventListener("keydown", (event: KeyboardEvent) => { if (event.key == "Enter") join(); });
		codeInput.addEventListener("input", () => { error.textContent = ""; });

		return [
			div({ style: rowStyle }, label({ style: "flex-shrink: 0;" }, "Name:"), nameInput),
			createButton,
			div({ style: rowStyle + " height: 2em;" }, codeInput, joinButton),
			error,
			div({ style: dimStyle }, "Joining replaces your current song."),
			this._buildNetworkSettings(),
		];
	}

	private _buildNetworkSettings(): HTMLElement {
		const settings: DuetNetworkSettings = loadNetworkSettings();
		const turn = settings.turnServers[0];
		const relayInput: HTMLTextAreaElement = textarea({ rows: "3", placeholder: "wss://relay.example.com", style: "width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.85em; background: transparent; color: inherit;" }, settings.relayUrls.join("\n"));
		const turnUrlInput: HTMLInputElement = input({ type: "text", placeholder: "turn:turn.example.com:3478", value: turn == undefined ? "" : (Array.isArray(turn.urls) ? turn.urls.join(" ") : turn.urls), style: "width: 100%; box-sizing: border-box; text-align: left;" });
		const turnUserInput: HTMLInputElement = input({ type: "text", placeholder: "username", value: turn == undefined ? "" : (turn.username || ""), style: "width: 48%; text-align: left;" });
		const turnPasswordInput: HTMLInputElement = input({ type: "text", placeholder: "password", value: turn == undefined ? "" : (turn.credential || ""), style: "width: 48%; text-align: left;" });
		const saveButton: HTMLButtonElement = button({ style: "width: 100%;" }, "Save");
		saveButton.addEventListener("click", () => {
			const turnUrls: string[] = turnUrlInput.value.split(/\s+/).filter(url => /^turns?:/.test(url));
			saveNetworkSettings({
				relayUrls: relayInput.value.split(/\s+/).filter(url => /^wss?:\/\//.test(url)),
				turnServers: turnUrls.length == 0 ? [] : [{ urls: turnUrls, username: turnUserInput.value.trim() || undefined, credential: turnPasswordInput.value || undefined }],
			});
			saveButton.textContent = "Saved";
		});
		return details({ style: dimStyle },
			summary({ style: "cursor: pointer;" }, "Connection settings"),
			div({ style: "display: flex; flex-direction: column; gap: 0.4em; margin-top: 0.4em;" },
				label("Nostr relays (blank = default):"), relayInput,
				label("TURN server (optional):"), turnUrlInput,
				div({ style: "display: flex; justify-content: space-between;" }, turnUserInput, turnPasswordInput),
				saveButton,
			),
		);
	}

	// ---- In a room ----

	private _buildRoomView(session: DuetSession): HTMLElement[] {
		const linkInput: HTMLInputElement = input({ type: "text", readonly: "", value: session.inviteLink, style: inputStyle + " font-size: 0.85em;" });
		const copyButton: HTMLButtonElement = button({ style: "flex-shrink: 0; padding: 0 1em;" }, "Copy link");
		copyButton.addEventListener("click", () => {
			linkInput.select();
			const copied = (): void => {
				copyButton.textContent = "Copied";
				window.setTimeout(() => { copyButton.textContent = "Copy link"; }, 1500);
			};
			if (navigator.clipboard != undefined) {
				navigator.clipboard.writeText(session.inviteLink).then(copied, () => { document.execCommand("copy"); copied(); });
			} else {
				document.execCommand("copy");
				copied();
			}
		});
		linkInput.addEventListener("focus", () => linkInput.select());

		const nameInput: HTMLInputElement = input({ type: "text", maxlength: "24", value: session.name, style: inputStyle });
		nameInput.addEventListener("change", () => { session.setName(nameInput.value); });

		const leaveButton: HTMLButtonElement = button({ style: "width: 100%;" }, "Leave room");
		leaveButton.addEventListener("click", () => { this._duet.leave(); });

		return [
			this._statusLine,
			div({ style: rowStyle }, span("Code:"), span({ style: "font-family: monospace; font-size: 1.2em; font-weight: bold; letter-spacing: 1px;" }, session.formattedCode)),
			div({ style: rowStyle + " height: 2em;" }, linkInput, copyButton),
			this._hint,
			this._peerList,
			div({ style: rowStyle }, label({ style: "flex-shrink: 0;" }, "Name:"), nameInput),
			leaveButton,
		];
	}

	private _renderPeers(session: DuetSession): void {
		const rows: HTMLElement[] = [this._peerRow(session.color, session.name + " (you)", session.isHost)];
		for (const peer of session.getPeers()) {
			rows.push(this._peerRow(peer.color, peer.name || "…", peer.isHost));
		}
		if (session.getIncompatiblePeerCount() > 0) {
			rows.push(div({ style: dimStyle }, "Someone has a different DuetBox version."));
		}
		this._peerList.replaceChildren(...rows);
	}

	private _peerRow(color: string, name: string, isHost: boolean): HTMLElement {
		return div({ style: rowStyle },
			dot(color),
			span({ style: "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" }, name),
			isHost ? span({ style: dimStyle + " margin-left: auto;" }, "host") : span(),
		);
	}

	private _renderHint = (): void => {
		const session: DuetSession | null = this._duet.session;
		if (session == null) return;
		const notFound: boolean = session.status == DuetStatus.searching && performance.now() - this._searchStarted > searchHintDelay;
		if (notFound && this._hint.childElementCount == 0) {
			const createLink = a({ href: "#", style: `color: ${ColorConfig.linkAccent};` }, "Create it");
			createLink.addEventListener("click", (event: Event) => {
				event.preventDefault();
				this._duet.start(session.name, session.code);
			});
			this._hint.replaceChildren(div({ style: dimStyle }, "Room not found. ", createLink));
		} else if (!notFound && this._hint.childElementCount > 0) {
			this._hint.replaceChildren();
		}
	}
}
