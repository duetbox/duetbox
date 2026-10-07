// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// DuetBox: a fallback for people who can't connect to each other directly.
//
// WebRTC connections between different networks fail when a router or mobile carrier
// doesn't allow them (symmetric NAT, carrier-grade NAT, blocked UDP). When that happens,
// room messages are carried by the same public Nostr relays that are used to find each
// other. They're encrypted with the room code, sent as ephemeral events (which relays
// pass on but don't store), batched to stay polite to the relays, and split into chunks
// when they're big. Each sender numbers its packets, so they're delivered in order and
// exactly once even though every relay delivers its own copy.

import { createEvent } from "../vendor/trystero/nostr";
import { strToNum } from "../vendor/trystero/core/utils";

/** How long to wait for a direct connection to someone before relaying their messages. */
const directGracePeriod: number = 4000;
const presenceInterval: number = 5000;
/** Someone who hasn't been heard from for this long has left. */
const peerTimeout: number = 16000;
/** Minimum time between events, so relays don't rate-limit us. */
const flushDelay: number = 200;
/** A packet missing for this long was lost by every relay, so skip it. */
const gapTimeout: number = 2500;
/** Big messages (whole songs) are split into chunks of this many characters. */
const chunkSize: number = 24000;
const maxHeldPackets: number = 500;
const rateLimitBackoff: number = 10000;
const maxReconnectDelay: number = 60000;
/** Messages that only describe the latest state, so a newer one replaces an unsent older one. */
const replaceableTypes: ReadonlyArray<string> = ["pointer", "where"];

type Targets = string[] | null;

interface RelayPeer {
	firstSeen: number;
	lastSeen: number;
	/** The next packet number to deliver, or -1 before the first packet. */
	next: number;
	/** They've sent us messages through the relays, so they gave up on a direct connection. */
	relaying: boolean;
	held: Map<number, [Targets, any][]>;
	chunks: Map<number, string[]>;
	gapSince: number;
}

interface RelayConnection {
	readonly url: string;
	socket: WebSocket | null;
	retryDelay: number;
	retryTimer: number | null;
	quietUntil: number;
}

function toBase64(bytes: Uint8Array): string {
	let binary: string = "";
	for (let i: number = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
	}
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary: string = atob(text);
	const bytes: Uint8Array = new Uint8Array(binary.length);
	for (let i: number = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function sha256Hex(text: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export class DuetRelay {
	/** Called with each message from someone, in the order they sent them. */
	public onMessage: ((message: any, peerId: string) => void) | null = null;
	/** Called about once a second, and when someone appears or leaves, so the caller can update who's reachable. */
	public onPeersChanged: (() => void) | null = null;

	private readonly _connections: RelayConnection[];
	private readonly _peers: Map<string, RelayPeer> = new Map();
	private readonly _seenEvents: Set<string> = new Set();
	/** People who said they're leaving, so a late copy of an older packet doesn't bring them back. */
	private readonly _gone: Set<string> = new Set();
	private readonly _subscriptionId: string = "duet" + Math.random().toString(36).substring(2, 10);
	private readonly _ready: Promise<void>;
	private _topic: string = "";
	private _kind: number = 0;
	private _key: CryptoKey | null = null;
	private _nextSequence: number = 0;
	private _queue: [Targets, any][] = [];
	private _flushTimer: number | null = null;
	private _lastFlush: number = 0;
	private _lastPresence: number = 0;
	private _presenceTimer: number | null = null;
	private _tickTimer: number;
	private _left: boolean = false;

	constructor(code: string, relayUrls: string[], private readonly _selfId: string, private readonly _canDeliver: (peerId: string) => boolean) {
		this._connections = relayUrls.map(url => ({ url: url, socket: null, retryDelay: 2000, retryTimer: null, quietUntil: 0 }));
		this._ready = this._setUp(code);
		this._tickTimer = window.setInterval(this._tick, 1000);
	}

	private async _setUp(code: string): Promise<void> {
		// The topic and key are derived separately, so relays only ever see a hash that doesn't reveal either.
		this._topic = await sha256Hex("duetbox-relay-topic:" + code);
		this._kind = 20000 + strToNum(this._topic, 10000);
		const keyBytes: ArrayBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("duetbox-relay-key:" + code));
		this._key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
		if (this._left) return;
		for (const connection of this._connections) this._connect(connection);
	}

	/** Whether someone's messages can be relayed: they're here, and a direct connection had its chance. */
	public isAvailable(peerId: string): boolean {
		const peer: RelayPeer | undefined = this._peers.get(peerId);
		return peer != undefined && (peer.relaying || performance.now() - peer.firstSeen >= directGracePeriod);
	}

	public getPeerIds(): string[] {
		return Array.from(this._peers.keys());
	}

	/** Queues a message for some people (who must be reachable through the relays). */
	public send(message: any, targets: string[]): void {
		if (this._left || targets.length == 0) return;
		const entry: [Targets, any] = [targets.concat().sort(), message];
		if (message != null && replaceableTypes.indexOf(message.t) != -1) {
			const key: string = entry[0]!.join(",");
			const index: number = this._queue.findIndex(([queuedTargets, queued]) => queued.t == message.t && queuedTargets != null && queuedTargets.join(",") == key);
			if (index != -1) {
				this._queue[index] = entry;
				return;
			}
		}
		this._queue.push(entry);
		this._scheduleFlush();
	}

	/** Delivers anything held back from someone, e.g. once they've joined. */
	public deliverHeld(peerId: string): void {
		const peer: RelayPeer | undefined = this._peers.get(peerId);
		if (peer != undefined) this._deliver(peerId, peer);
	}

	public async leave(): Promise<void> {
		if (this._left) return;
		window.clearInterval(this._tickTimer);
		if (this._flushTimer != null) window.clearTimeout(this._flushTimer);
		if (this._presenceTimer != null) window.clearTimeout(this._presenceTimer);
		try {
			await this._ready;
			// Send anything still queued (like a goodbye) before saying we're leaving.
			if (this._queue.length > 0) await this._flush();
			await this._publish(JSON.stringify({ f: this._selfId, k: "l" }));
		} catch (error) {}
		this._left = true;
		for (const connection of this._connections) {
			if (connection.retryTimer != null) window.clearTimeout(connection.retryTimer);
			if (connection.socket != null) {
				connection.socket.onclose = null;
				connection.socket.close();
			}
		}
		this._peers.clear();
	}

	// ---- Relay connections ----

	private _connect(connection: RelayConnection): void {
		if (this._left) return;
		let socket: WebSocket;
		try {
			socket = new WebSocket(connection.url);
		} catch (error) {
			return;
		}
		connection.socket = socket;
		socket.onopen = () => {
			connection.retryDelay = 2000;
			// "since" is a little in the past to allow for clocks that are a bit off; ephemeral events aren't stored, so nothing old comes back.
			const filter: any = { kinds: [this._kind], since: Math.floor(Date.now() / 1000) - 600, "#x": [this._topic] };
			socket.send(JSON.stringify(["REQ", this._subscriptionId, filter]));
			this._sendPresence();
		};
		socket.onmessage = (event: MessageEvent) => this._receiveRelayMessage(connection, event.data);
		socket.onclose = () => {
			if (connection.socket != socket) return;
			connection.socket = null;
			if (this._left) return;
			connection.retryTimer = window.setTimeout(() => {
				connection.retryTimer = null;
				this._connect(connection);
			}, connection.retryDelay);
			connection.retryDelay = Math.min(maxReconnectDelay, connection.retryDelay * 2);
		};
	}

	private _receiveRelayMessage(connection: RelayConnection, data: any): void {
		if (this._left || typeof data != "string") return;
		let message: any;
		try {
			message = JSON.parse(data);
		} catch (error) {
			return;
		}
		if (!Array.isArray(message)) return;
		if (message[0] == "EVENT" && message[1] == this._subscriptionId && message[2] != null && typeof message[2].content == "string") {
			const event: any = message[2];
			// Every relay passes on its own copy.
			if (typeof event.id != "string" || this._seenEvents.has(event.id)) return;
			this._seenEvents.add(event.id);
			if (this._seenEvents.size > 4000) this._seenEvents.delete(this._seenEvents.values().next().value!);
			this._decrypt(event.content).then(text => {
				if (text != null) this._receivePacket(text);
			});
		} else if (message[0] == "OK" && message[2] === false && typeof message[3] == "string" && /^rate-limited/.test(message[3])) {
			connection.quietUntil = performance.now() + rateLimitBackoff;
		}
	}

	private async _publish(plaintext: string): Promise<void> {
		const content: string = await this._encrypt(plaintext);
		const event: string = await createEvent(this._topic, content);
		const now: number = performance.now();
		for (const connection of this._connections) {
			if (connection.socket != null && connection.socket.readyState == WebSocket.OPEN && now >= connection.quietUntil) {
				connection.socket.send(event);
			}
		}
	}

	private async _encrypt(plaintext: string): Promise<string> {
		const iv: Uint8Array = crypto.getRandomValues(new Uint8Array(12));
		const encrypted: ArrayBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, this._key!, new TextEncoder().encode(plaintext));
		return toBase64(iv) + "." + toBase64(new Uint8Array(encrypted));
	}

	private async _decrypt(content: string): Promise<string | null> {
		const parts: string[] = content.split(".");
		if (parts.length != 2 || this._key == null) return null;
		try {
			const decrypted: ArrayBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(parts[0]) }, this._key, fromBase64(parts[1]));
			return new TextDecoder().decode(decrypted);
		} catch (error) {
			// Someone with a different room code that happened to hash to the same kind, or garbage.
			return null;
		}
	}

	// ---- Sending ----

	private _scheduleFlush(): void {
		if (this._flushTimer != null) return;
		const wait: number = Math.max(0, this._lastFlush + flushDelay - performance.now());
		this._flushTimer = window.setTimeout(() => {
			this._flushTimer = null;
			this._flush().catch(error => console.warn("DuetBox: couldn't send through the relays", error));
		}, wait);
	}

	private async _flush(): Promise<void> {
		await this._ready;
		if (this._queue.length == 0) return;
		const messages: [Targets, any][] = this._queue;
		this._queue = [];
		this._lastFlush = performance.now();
		const sequence: number = this._nextSequence++;
		const packet: string = JSON.stringify({ f: this._selfId, s: sequence, m: messages });
		if (packet.length <= chunkSize) {
			await this._publish(packet);
			return;
		}
		const data: string = JSON.stringify(messages);
		const count: number = Math.ceil(data.length / chunkSize);
		const sends: Promise<void>[] = [];
		for (let i: number = 0; i < count; i++) {
			sends.push(this._publish(JSON.stringify({ f: this._selfId, s: sequence, c: i, n: count, d: data.substring(i * chunkSize, (i + 1) * chunkSize) })));
		}
		await Promise.all(sends);
	}

	private _sendPresence(): void {
		if (this._left) return;
		this._lastPresence = performance.now();
		this._ready.then(() => this._publish(JSON.stringify({ f: this._selfId, k: "p", s: this._nextSequence }))).catch(() => {});
	}

	// ---- Receiving ----

	private _receivePacket(text: string): void {
		let packet: any;
		try {
			packet = JSON.parse(text);
		} catch (error) {
			return;
		}
		if (packet == null || typeof packet != "object" || typeof packet.f != "string" || packet.f == this._selfId || packet.f.length > 64) return;
		const peerId: string = packet.f;
		if (this._gone.has(peerId)) return;
		if (packet.k == "l") {
			this._gone.add(peerId);
			if (this._peers.delete(peerId) && this.onPeersChanged != null) this.onPeersChanged();
			return;
		}
		const now: number = performance.now();
		let peer: RelayPeer | undefined = this._peers.get(peerId);
		if (peer == undefined) {
			peer = { firstSeen: now, lastSeen: now, next: -1, relaying: false, held: new Map(), chunks: new Map(), gapSince: 0 };
			this._peers.set(peerId, peer);
			// Let them know we're here right away instead of at the next heartbeat (once for several newcomers).
			if (this._presenceTimer == null) {
				this._presenceTimer = window.setTimeout(() => {
					this._presenceTimer = null;
					this._sendPresence();
				}, 100);
			}
			if (this.onPeersChanged != null) this.onPeersChanged();
		}
		peer.lastSeen = now;
		const sequence: number = Number(packet.s);
		if (!Number.isInteger(sequence) || sequence < 0) return;
		if (packet.k == "p") {
			// Packets numbered before their first presence we saw were sent before we were here.
			if (peer.next == -1) peer.next = sequence;
			return;
		}
		if (peer.next == -1) peer.next = sequence;
		if (sequence < peer.next || peer.held.has(sequence)) return;

		let messages: any = packet.m;
		if (packet.c != undefined) {
			const index: number = Number(packet.c);
			const count: number = Number(packet.n);
			if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 1000 || index < 0 || index >= count || typeof packet.d != "string") return;
			let chunks: string[] | undefined = peer.chunks.get(sequence);
			if (chunks == undefined) {
				chunks = new Array(count);
				peer.chunks.set(sequence, chunks);
			}
			if (chunks.length != count) return;
			chunks[index] = packet.d;
			for (let i: number = 0; i < count; i++) if (chunks[i] == undefined) return;
			peer.chunks.delete(sequence);
			try {
				messages = JSON.parse(chunks.join(""));
			} catch (error) {
				return;
			}
		}
		if (!Array.isArray(messages)) return;
		if (peer.held.size >= maxHeldPackets) return;
		peer.held.set(sequence, messages);
		if (!peer.relaying && messages.some(entry => Array.isArray(entry) && Array.isArray(entry[0]) && entry[0].indexOf(this._selfId) != -1)) {
			// No need to wait for a direct connection that they've already given up on.
			peer.relaying = true;
			if (this.onPeersChanged != null) this.onPeersChanged();
		}
		this._deliver(peerId, peer);
	}

	private _deliver(peerId: string, peer: RelayPeer): void {
		if (!this._canDeliver(peerId)) return;
		while (peer.held.has(peer.next)) {
			const messages: [Targets, any][] = peer.held.get(peer.next)!;
			peer.held.delete(peer.next);
			peer.next++;
			for (const entry of messages) {
				if (!Array.isArray(entry)) continue;
				const [targets, message] = entry;
				if (targets != null && (!Array.isArray(targets) || targets.indexOf(this._selfId) == -1)) continue;
				if (message == null || typeof message != "object" || Array.isArray(message)) continue;
				if (this.onMessage != null) this.onMessage(message, peerId);
				// The message may have made us leave.
				if (this._left || !this._peers.has(peerId)) return;
			}
		}
		peer.gapSince = peer.held.size > 0 ? (peer.gapSince || performance.now()) : 0;
		for (const sequence of peer.chunks.keys()) if (sequence < peer.next) peer.chunks.delete(sequence);
	}

	private _tick = (): void => {
		if (this._left) return;
		const now: number = performance.now();
		if (now - this._lastPresence >= presenceInterval) this._sendPresence();
		for (const [peerId, peer] of this._peers) {
			if (now - peer.lastSeen > peerTimeout) {
				this._peers.delete(peerId);
				continue;
			}
			if (peer.gapSince > 0 && peer.held.size > 0 && now - peer.gapSince > gapTimeout && this._canDeliver(peerId)) {
				// Every relay lost a packet: carry on from the next one we have.
				peer.next = Math.min(...Array.from(peer.held.keys()));
				peer.gapSince = 0;
				this._deliver(peerId, peer);
			}
		}
		if (this.onPeersChanged != null) this.onPeersChanged();
	}
}
