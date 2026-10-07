// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// DuetBox: peer-to-peer networking for collaborative sessions.
//
// Everyone who enters the same invite code joins the same Trystero room. Trystero
// finds the other people in the room through public Nostr relays and then
// connects everyone directly to each other with WebRTC, so song data never
// passes through a server. The invite code doubles as the room password, which
// encrypts the connection handshakes that pass through the relays.

import { joinRoom, getRelaySockets, selfId, defaultRelayUrls } from "../vendor/trystero/nostr";
import { JsonValue, MessageAction, Room, TurnServerConfig } from "../vendor/trystero/core/index";
import { shuffle, strToNum } from "../vendor/trystero/core/utils";
import { DuetRelay } from "./DuetRelay";

const appId: string = "duetbox";
const relayRedundancy: number = 6;
// Songs are small, so anything much bigger than this is a mistake or abuse.
const maxReceiveBytes: number = 16 * 1024 * 1024;
const settingsKey: string = "duetboxNetworkSettings";

// Letters and digits that are hard to confuse with each other when read aloud or handwritten.
const codeAlphabet: string = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const codeLength: number = 8;

export const duetSelfId: string = selfId;

export function generateInviteCode(): string {
	const values: Uint32Array = new Uint32Array(codeLength);
	crypto.getRandomValues(values);
	let code: string = "";
	for (let i: number = 0; i < codeLength; i++) {
		code += codeAlphabet.charAt(values[i] % codeAlphabet.length);
	}
	return code;
}

/** Turns whatever the user typed or pasted (a code with or without dashes, or a whole invite link) into a code, or null. */
export function parseInviteCode(text: string): string | null {
	const linkMatch: RegExpMatchArray | null = text.match(/[?&]duet=([^&#\s]+)/);
	if (linkMatch != null) text = decodeURIComponent(linkMatch[1]);
	let code: string = "";
	for (const char of text.toUpperCase()) {
		if (codeAlphabet.indexOf(char) != -1) code += char;
	}
	return code.length == codeLength ? code : null;
}

export function formatInviteCode(code: string): string {
	return code.substring(0, 4) + "-" + code.substring(4);
}

export function makeInviteLink(code: string): string {
	return location.origin + location.pathname + "?duet=" + formatInviteCode(code);
}

export function getInviteCodeFromUrl(): string | null {
	const value: string | null = new URLSearchParams(location.search).get("duet");
	return value == null ? null : parseInviteCode(value);
}

export function setInviteCodeInUrl(code: string | null): void {
	const params: URLSearchParams = new URLSearchParams(location.search);
	if (code == null) params.delete("duet");
	else params.set("duet", formatInviteCode(code));
	const search: string = params.toString();
	window.history.replaceState(window.history.state, "", location.pathname + (search ? "?" + search : "") + location.hash);
}

export interface DuetNetworkSettings {
	/** Nostr relays used to find other people. Empty means Trystero's built-in list. */
	relayUrls: string[];
	/** Optional TURN servers, for networks that block direct connections. */
	turnServers: TurnServerConfig[];
}

export function loadNetworkSettings(): DuetNetworkSettings {
	const settings: DuetNetworkSettings = { relayUrls: [], turnServers: [] };
	try {
		const saved: any = JSON.parse(window.localStorage.getItem(settingsKey) || "{}");
		if (Array.isArray(saved.relayUrls)) settings.relayUrls = saved.relayUrls.filter((url: any) => typeof url == "string" && url != "");
		if (Array.isArray(saved.turnServers)) settings.turnServers = saved.turnServers.filter((server: any) => server != null && server.urls);
	} catch (error) {
		console.warn("Ignoring invalid DuetBox network settings", error);
	}
	return settings;
}

export function saveNetworkSettings(settings: DuetNetworkSettings): void {
	window.localStorage.setItem(settingsKey, JSON.stringify(settings));
}

/**
 * One person's connection to a room. People are connected directly (WebRTC) when their
 * networks allow it, and otherwise through the relays (see DuetRelay); either way they
 * appear here as the same peers.
 */
export class DuetNetwork {
	public readonly selfId: string = selfId;
	public onPeerJoin: ((peerId: string) => void) | null = null;
	public onPeerLeave: ((peerId: string) => void) | null = null;
	public onMessage: ((message: any, peerId: string) => void) | null = null;
	public onError: ((message: string) => void) | null = null;

	private readonly _room: Room;
	private readonly _action: MessageAction<JsonValue>;
	private readonly _relay: DuetRelay;
	/** People connected directly. */
	private readonly _direct: Set<string> = new Set();
	/** Everyone reachable one way or the other, as last reported to onPeerJoin/onPeerLeave. */
	private readonly _peers: Set<string> = new Set();
	private _left: boolean = false;

	constructor(code: string, settings: DuetNetworkSettings = loadNetworkSettings()) {
		this._room = joinRoom({
			appId: appId,
			password: code,
			maxReceiveBytes: maxReceiveBytes,
			relayConfig: settings.relayUrls.length > 0 ? { urls: settings.relayUrls } : { redundancy: relayRedundancy },
			turnConfig: settings.turnServers.length > 0 ? settings.turnServers : undefined,
		}, "room-" + code, {
			onJoinError: (details) => {
				if (this.onError != null) this.onError(details.error);
			},
		});
		this._action = this._room.makeAction<JsonValue>("duet");
		this._action.onMessage = (data: JsonValue, context) => this._receive(data, context.peerId);
		this._room.onPeerJoin = (peerId: string) => {
			this._direct.add(peerId);
			this._updatePeer(peerId);
		};
		this._room.onPeerLeave = (peerId: string) => {
			this._direct.delete(peerId);
			this._updatePeer(peerId);
		};

		// The same relays that Trystero picks for this app, so everyone in the room shares them.
		const relayUrls: string[] = settings.relayUrls.length > 0 ? settings.relayUrls : shuffle(defaultRelayUrls, strToNum(appId)).slice(0, relayRedundancy);
		this._relay = new DuetRelay(code, relayUrls, selfId, (peerId: string) => this._peers.has(peerId));
		this._relay.onMessage = (message: any, peerId: string) => this._receive(message, peerId);
		this._relay.onPeersChanged = () => {
			for (const peerId of new Set(this._relay.getPeerIds().concat(Array.from(this._peers)))) this._updatePeer(peerId);
		};
	}

	private _receive(data: any, peerId: string): void {
		if (this._left || this.onMessage == null || data == null || typeof data != "object" || Array.isArray(data)) return;
		this.onMessage(data, peerId);
	}

	/** Reports someone joining or leaving when they become reachable or unreachable both ways. */
	private _updatePeer(peerId: string): void {
		if (this._left) return;
		const reachable: boolean = this._direct.has(peerId) || this._relay.isAvailable(peerId);
		if (reachable && !this._peers.has(peerId)) {
			this._peers.add(peerId);
			if (this.onPeerJoin != null) this.onPeerJoin(peerId);
			// Anything they sent through the relays while we were waiting for a direct connection.
			this._relay.deliverHeld(peerId);
		} else if (!reachable && this._peers.has(peerId)) {
			this._peers.delete(peerId);
			if (this.onPeerLeave != null) this.onPeerLeave(peerId);
		}
	}

	/** Sends a message to one peer, a list of peers, or everyone when target is omitted. */
	public send(message: JsonValue, target?: string | string[]): void {
		if (this._left) return;
		const targets: string[] = target == undefined ? Array.from(this._peers) : typeof target == "string" ? [target] : target;
		const direct: string[] = targets.filter(peerId => this._direct.has(peerId));
		const relayed: string[] = targets.filter(peerId => !this._direct.has(peerId) && this._peers.has(peerId));
		if (direct.length > 0) {
			this._action.send(message, { target: direct }).catch((error: any) => {
				console.warn("DuetBox: failed to send a message", error);
			});
		}
		if (relayed.length > 0) this._relay.send(message, relayed);
	}

	public getPeerIds(): string[] {
		return Array.from(this._peers);
	}

	/** Whether someone can only be reached through the relays, which is slower. */
	public isRelayed(peerId: string): boolean {
		return this._peers.has(peerId) && !this._direct.has(peerId);
	}

	public hasRelayedPeers(): boolean {
		return Array.from(this._peers).some(peerId => !this._direct.has(peerId));
	}

	/** How many of the matchmaking relays currently have an open connection. */
	public getRelayStatus(): { open: number, total: number } {
		const sockets: WebSocket[] = Object.values(getRelaySockets());
		return { open: sockets.filter(socket => socket.readyState == WebSocket.OPEN).length, total: sockets.length };
	}

	public leave(): void {
		if (this._left) return;
		this._left = true;
		this._room.leave().catch(() => {});
		void this._relay.leave();
	}
}
