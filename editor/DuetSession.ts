// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// DuetBox: keeps one song in sync between everyone in a session.
//
// One participant is the host and holds the official copy of the song, with a
// version number that goes up with every change. Everyone else (the guests)
// edits their own copy freely and sends the result to the host, one edit at a
// time. The host merges each edit into the official copy (see DuetMerge.ts)
// and sends the new version to everyone. Guests merge new versions into their
// copy so that any edits they haven't had confirmed yet are kept. Once nobody
// is editing, everyone ends up with the host's copy.
//
// If the host leaves, the remaining participant with the smallest id becomes
// the new host, so the session keeps going.

import { SongDocument, DuetHooks, DuetPointer, DuetRemotePointer } from "./SongDocument";
import { DuetNetwork, duetSelfId, formatInviteCode, generateInviteCode, makeInviteLink, setInviteCodeInUrl } from "./DuetNetwork";
import { mergeSongs } from "./DuetMerge";
import { Song } from "../synth/synth";

const protocolVersion: number = 1;
const maximumUndoSteps: number = 200;
const maximumSnapshots: number = 100;
const hostBroadcastDelay: number = 60;
const presenceDelay: number = 100;
const pointerDelay: number = 40;
// If the host's connection drops without saying goodbye, give it this long to come back.
const hostReconnectDelay: number = 5000;
// If whoever should take over as host hasn't said so by then, take over ourselves.
const hostTakeoverDelay: number = 8000;

const nameKey: string = "duetboxName";
const adjectives: ReadonlyArray<string> = ["Bouncy", "Cosmic", "Fuzzy", "Groovy", "Jazzy", "Lofi", "Mellow", "Funky", "Snappy", "Sunny", "Swingy", "Zippy"];
const animals: ReadonlyArray<string> = ["Axolotl", "Badger", "Capybara", "Dolphin", "Fox", "Gecko", "Koala", "Lynx", "Otter", "Panda", "Penguin", "Quokka"];
export const duetColors: ReadonlyArray<string> = ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#3bc9db", "#748ffc", "#da77f2", "#f783ac"];

export function loadDuetName(): string {
	const saved: string | null = window.localStorage.getItem(nameKey);
	if (saved != null && saved.trim() != "") return saved;
	return adjectives[Math.floor(Math.random() * adjectives.length)] + " " + animals[Math.floor(Math.random() * animals.length)];
}

export function saveDuetName(name: string): void {
	window.localStorage.setItem(nameKey, name);
}

export function cleanDuetName(name: string): string {
	const cleaned: string = String(name).replace(/\s+/g, " ").trim().substring(0, 24);
	return cleaned == "" ? "Anonymous" : cleaned;
}

function colorIndexForId(id: string): number {
	let hash: number = 0;
	for (let i: number = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
	return Math.abs(hash) % duetColors.length;
}

/** Gives everyone a distinct color. Everyone in the session computes the same assignment. */
function assignColors(ids: string[]): Map<string, string> {
	const result: Map<string, string> = new Map();
	const taken: boolean[] = [];
	for (const id of ids.concat().sort()) {
		let index: number = colorIndexForId(id);
		for (let tries: number = 0; tries < duetColors.length && taken[index]; tries++) index = (index + 1) % duetColors.length;
		taken[index] = true;
		result.set(id, duetColors[index]);
	}
	return result;
}

export interface DuetPeer {
	readonly id: string;
	name: string;
	color: string;
	isHost: boolean;
	compatible: boolean;
	channel: number;
	bar: number;
	pointer: DuetPointer | null;
}

export const enum DuetStatus {
	/** Hosting; ready for others to join. */
	hosting,
	/** Looking for whoever is hosting this code. */
	searching,
	/** Found the host, waiting for the song. */
	syncing,
	/** In sync with the host. */
	connected,
	/** The host left; waiting for someone else to take over. */
	hostLeft,
}

interface UndoStep {
	sequenceNumber: number;
	before: string;
	after: string;
	applied: boolean;
}

interface QueuedMessage {
	message: any;
	from: string;
}

export class DuetSession implements DuetHooks {
	public readonly code: string;
	public readonly inviteLink: string;
	public readonly selfId: string = duetSelfId;
	public color: string = duetColors[colorIndexForId(duetSelfId)];
	public readonly peers: Map<string, DuetPeer> = new Map();
	// Peers that said goodbye; anything else they send while disconnecting is ignored.
	private readonly _departed: Set<string> = new Set();
	public name: string;
	public status: DuetStatus;
	public isHost: boolean;
	public hostId: string | null;
	public lastError: string | null = null;
	/** Called whenever something shown in the session UI changes. */
	public onChange: (() => void) | null = null;
	/** Called when someone's mouse pointer moves. */
	public onPointersChanged: (() => void) | null = null;
	/** Converts a local pointer event into song terms, or null when it isn't over an editor. */
	public pointerLocator: ((event: PointerEvent) => DuetPointer | null) | null = null;

	private readonly _doc: SongDocument;
	private readonly _network: DuetNetwork;
	private _epoch: number;
	private _ended: boolean = false;
	// The previous host's version that we continued from when we took over as host.
	private _forkedFrom: { epoch: number, version: number } | null = null;

	// The song as of the last local edit or remote update, for building undo steps.
	private _lastKnown: string;
	private _remoteSinceLastCommit: boolean = false;
	private readonly _undoSteps: UndoStep[] = [];

	// Host state.
	private _version: number = 0;
	private _canonical: string = "";
	private readonly _snapshots: Map<number, string> = new Map();
	private _broadcastTimer: number | null = null;

	// Guest state.
	private _confirmed: string | null = null;
	private _confirmedVersion: number = -1;
	private _inflight: string | null = null;
	private _inflightId: number = 0;

	// Remote updates wait while the user is in the middle of a mouse drag or a recording.
	private readonly _queue: QueuedMessage[] = [];
	private _pointerDown: boolean = false;
	private _retryTimer: number | null = null;
	private _takeoverTimer: number | null = null;
	private _electionTimer: number | null = null;

	private _sentPointer: string = "";
	private _pendingPointer: DuetPointer | null = null;
	private _pointerTimer: number | null = null;
	private _sentChannel: number = -1;
	private _sentBar: number = -1;
	private _presenceTimer: number | null = null;

	private constructor(doc: SongDocument, code: string, name: string, asHost: boolean) {
		this._doc = doc;
		this.code = code;
		this.inviteLink = makeInviteLink(code);
		this.name = cleanDuetName(name);
		this.isHost = asHost;
		this.hostId = asHost ? this.selfId : null;
		this.status = asHost ? DuetStatus.hosting : DuetStatus.searching;
		this._epoch = asHost ? 1 : 0;

		doc.flushPendingHistory();
		this._lastKnown = doc.song.toBase64String();
		if (asHost) this._publishVersion(this._lastKnown);

		doc.duet = this;
		doc.notifier.watch(this._whenDocumentChanged);
		window.addEventListener("pointerdown", this._whenPointerDown, true);
		window.addEventListener("pointerup", this._whenPointerUp, true);
		window.addEventListener("pointercancel", this._whenPointerUp, true);
		window.addEventListener("pointermove", this._whenPointerMoved, { capture: true, passive: true });
		document.documentElement.addEventListener("pointerleave", this._whenPointerLeft);
		window.addEventListener("beforeunload", this._whenUnloading);
		window.addEventListener("pagehide", this._whenPageHidden);

		this._network = new DuetNetwork(code);
		this._network.onPeerJoin = this._whenPeerJoined;
		this._network.onPeerLeave = this._whenPeerLeft;
		this._network.onMessage = this._receive;
		this._network.onError = (message: string) => {
			this.lastError = message;
			this._changed();
		};
	}

	public static host(doc: SongDocument, code: string, name: string): DuetSession {
		return new DuetSession(doc, code, name, true);
	}

	public static join(doc: SongDocument, code: string, name: string): DuetSession {
		return new DuetSession(doc, code, name, false);
	}

	public get formattedCode(): string {
		return formatInviteCode(this.code);
	}

	public get ended(): boolean {
		return this._ended;
	}

	/** Participants that are running a compatible version of DuetBox. */
	public getPeers(): DuetPeer[] {
		return Array.from(this.peers.values()).filter(peer => peer.compatible);
	}

	public getIncompatiblePeerCount(): number {
		return Array.from(this.peers.values()).filter(peer => !peer.compatible).length;
	}

	public getRelayStatus(): { open: number, total: number } {
		return this._network.getRelayStatus();
	}

	public setName(name: string): void {
		this.name = cleanDuetName(name);
		saveDuetName(this.name);
		this._network.send(this._hello());
		this._changed();
	}

	/** Stops hosting/joining. The current song stays in the editor. */
	public leave(): void {
		if (this._ended) return;
		this._ended = true;
		this._network.send({ t: "bye" });
		this._network.leave();
		// Stay attached until the next edit or history change: an open prompt's history entry
		// may predate other people's edits, and closing it shouldn't bring back the old song.
		this._doc.notifier.unwatch(this._whenDocumentChanged);
		window.removeEventListener("pointerdown", this._whenPointerDown, true);
		window.removeEventListener("pointerup", this._whenPointerUp, true);
		window.removeEventListener("pointercancel", this._whenPointerUp, true);
		window.removeEventListener("pointermove", this._whenPointerMoved, { capture: true } as EventListenerOptions);
		document.documentElement.removeEventListener("pointerleave", this._whenPointerLeft);
		window.removeEventListener("beforeunload", this._whenUnloading);
		window.removeEventListener("pagehide", this._whenPageHidden);
		for (const timer of [this._broadcastTimer, this._retryTimer, this._presenceTimer, this._takeoverTimer, this._electionTimer, this._pointerTimer]) {
			if (timer != null) window.clearTimeout(timer);
		}
		this._doc.notifier.changed();
		this._doc.notifier.notifyWatchers();
		this._changed();
	}

	// ---- SongDocument hooks ----

	public onLocalCommit(hash: string, sequenceNumber: number): void {
		if (this._ended) {
			this._detach();
			return;
		}
		if (hash == this._lastKnown) return;
		this.onHistoryPush();
		const last: UndoStep | undefined = this._undoSteps[this._undoSteps.length - 1];
		if (last != undefined && last.sequenceNumber == sequenceNumber && !this._remoteSinceLastCommit) {
			// Continuing edits (like dragging a slider) extend the same undo step.
			last.after = hash;
		} else {
			this._undoSteps.push({ sequenceNumber: sequenceNumber, before: this._lastKnown, after: hash, applied: true });
			if (this._undoSteps.length > maximumUndoSteps) this._undoSteps.shift();
		}
		this._lastKnown = hash;
		this._remoteSinceLastCommit = false;
		this._localSongChanged();
	}

	public onHistoryPush(): void {
		if (this._ended) return;
		// Anything that was undone can't be redone anymore.
		for (let i: number = this._undoSteps.length - 1; i >= 0; i--) {
			if (!this._undoSteps[i].applied) this._undoSteps.splice(i, 1);
		}
	}

	public onHistoryNavigation(fromSequenceNumber: number, toSequenceNumber: number): string {
		let song: string = this._doc.song.toBase64String();
		if (this._ended) {
			this._detach();
			return song;
		}
		// Undo and redo only revert or reapply the parts of the song that this
		// person changed, leaving everyone else's later edits alone.
		if (toSequenceNumber < fromSequenceNumber) {
			for (let i: number = this._undoSteps.length - 1; i >= 0; i--) {
				const step: UndoStep = this._undoSteps[i];
				if (step.applied && step.sequenceNumber > toSequenceNumber) {
					song = mergeSongs(step.after, song, step.before, "ours");
					step.applied = false;
				}
			}
		} else if (toSequenceNumber > fromSequenceNumber) {
			for (const step of this._undoSteps) {
				if (!step.applied && step.sequenceNumber <= toSequenceNumber) {
					song = mergeSongs(step.before, song, step.after, "ours");
					step.applied = true;
				}
			}
		}
		if (song != this._lastKnown) {
			this._lastKnown = song;
			this._remoteSinceLastCommit = true;
			// Let SongDocument load the song before telling everyone about it.
			window.setTimeout(() => this._localSongChanged());
		}
		return song;
	}

	// ---- Collaborator positions, for the track editor ----

	public getCollaboratorPositions(): { channel: number, bar: number, color: string, name: string }[] {
		if (this._ended) return [];
		const channelCount: number = this._doc.song.getChannelCount();
		return this.getPeers()
			.filter(peer => peer.channel >= 0 && peer.channel < channelCount && peer.bar >= 0 && peer.bar < this._doc.song.barCount)
			.map(peer => ({ channel: peer.channel, bar: peer.bar, color: peer.color, name: peer.name }));
	}

	public getRemotePointers(): DuetRemotePointer[] {
		if (this._ended) return [];
		const result: DuetRemotePointer[] = [];
		for (const peer of this.getPeers()) {
			if (peer.pointer != null) result.push(Object.assign({ color: peer.color, name: peer.name }, peer.pointer));
		}
		return result;
	}

	// ---- Networking ----

	private _hello(): any {
		return { t: "hello", proto: protocolVersion, name: this.name, host: this.isHost, epoch: this._epoch, fork: this.isHost ? this._forkedFrom : null, channel: this._doc.channel, bar: this._doc.bar };
	}

	private _whenPeerJoined = (peerId: string): void => {
		this._departed.delete(peerId);
		this._network.send(this._hello(), peerId);
	}

	private _whenPeerLeft = (peerId: string): void => {
		this._peerLeft(peerId, false);
	}

	private _peerLeft(peerId: string, saidGoodbye: boolean): void {
		const peer: DuetPeer | undefined = this.peers.get(peerId);
		this.peers.delete(peerId);
		this._updateColors();
		if (peerId == this.hostId && !this.isHost) {
			this.hostId = null;
			this._inflight = null;
			this.status = DuetStatus.hostLeft;
			if (this._electionTimer != null) window.clearTimeout(this._electionTimer);
			// A host that said goodbye won't be back; otherwise its connection may just have hiccupped.
			this._electionTimer = window.setTimeout(() => {
				this._electionTimer = null;
				if (!this._ended && this.hostId == null) this._electHost();
			}, saidGoodbye ? 0 : hostReconnectDelay);
		}
		if (peer != undefined) {
			this._repaint();
			if (peer.pointer != null && this.onPointersChanged != null) this.onPointersChanged();
		}
		this._changed();
	}

	private _receive = (message: any, from: string): void => {
		if (this._ended || this._departed.has(from)) return;
		const peer: DuetPeer | undefined = this.peers.get(from);
		if (message.t == "hello") {
			this._receiveHello(message, from);
			return;
		}
		if (peer != undefined && !peer.compatible) return;
		switch (message.t) {
			case "state":
			case "edit":
				this._queue.push({ message: message, from: from });
				this._processQueue();
				break;
			case "pointer":
				if (peer != undefined) {
					peer.pointer = this._readPointer(message.pointer);
					if (this.onPointersChanged != null) this.onPointersChanged();
				}
				break;
			case "where":
				if (peer != undefined) {
					peer.channel = Number(message.channel) | 0;
					peer.bar = Number(message.bar) | 0;
					this._repaint();
				}
				break;
			case "bye":
				// Trystero will also report the peer as gone, but this makes it immediate.
				this._departed.add(from);
				this._peerLeft(from, true);
				break;
		}
	}

	private _receiveHello(message: any, from: string): void {
		let peer: DuetPeer | undefined = this.peers.get(from);
		const isNew: boolean = peer == undefined;
		if (peer == undefined) {
			peer = { id: from, name: "", color: "", isHost: false, compatible: true, channel: -1, bar: -1, pointer: null };
			this.peers.set(from, peer);
			this._updateColors();
			// Make sure the newcomer knows about us too.
			this._network.send(this._hello(), from);
		}
		peer.name = cleanDuetName(message.name);
		peer.compatible = message.proto == protocolVersion;
		peer.channel = Number(message.channel) | 0;
		peer.bar = Number(message.bar) | 0;
		peer.isHost = !!message.host;
		const epoch: number = Number(message.epoch) | 0;

		if (peer.compatible && peer.isHost) {
			if (this.isHost) {
				if (epoch > this._epoch || (epoch == this._epoch && from < this.selfId)) {
					this._stepDown(from, epoch, message.fork);
				} else {
					// We outrank them; they'll step down once they see our hello.
					this._network.send(this._hello(), from);
					this._sendState(from, undefined);
				}
			} else if (this.hostId == null || epoch > this._epoch || (epoch == this._epoch && from < this.hostId)) {
				this._followHost(from, epoch);
			}
		} else if (peer.compatible && this.isHost && (isNew || message.needsSong)) {
			this._sendState(from, undefined);
		}
		for (const other of this.peers.values()) other.isHost = other.id == this.hostId;
		this._repaint();
		this._changed();
	}

	private _followHost(hostId: string, epoch: number): void {
		if (this.hostId != hostId) this._inflight = null;
		this.hostId = hostId;
		this._epoch = epoch;
		if (this.status != DuetStatus.connected) this.status = DuetStatus.syncing;
	}

	private _stepDown(newHostId: string, epoch: number, fork: any): void {
		// Someone else is the host after all. Their song gets merged into ours using the last
		// version we both had as the base: the version of ours they continued from, if they
		// took over from us, or else our latest version.
		const forkBase: string | undefined = fork != null && Number(fork.epoch) == this._epoch ? this._snapshots.get(Number(fork.version)) : undefined;
		this.isHost = false;
		this._confirmed = forkBase ?? this._canonical;
		this._confirmedVersion = -1;
		this._inflight = null;
		if (this._broadcastTimer != null) {
			window.clearTimeout(this._broadcastTimer);
			this._broadcastTimer = null;
		}
		this.status = DuetStatus.syncing;
		this._followHost(newHostId, epoch);
		this._network.send(Object.assign(this._hello(), { needsSong: true }), newHostId);
	}

	private _electHost(): void {
		const candidates: string[] = [this.selfId];
		for (const peer of this.peers.values()) {
			if (peer.compatible) candidates.push(peer.id);
		}
		candidates.sort();
		if (candidates[0] == this.selfId) {
			this._becomeHost();
		} else {
			// Wait for the new host to say hello.
			if (this._takeoverTimer != null) window.clearTimeout(this._takeoverTimer);
			this._takeoverTimer = window.setTimeout(() => {
				this._takeoverTimer = null;
				if (!this._ended && this.hostId == null && this._confirmed != null) this._becomeHost();
			}, hostTakeoverDelay);
		}
	}

	private _becomeHost(): void {
		this._forkedFrom = this._confirmedVersion >= 0 ? { epoch: this._epoch, version: this._confirmedVersion } : null;
		this.isHost = true;
		this.hostId = this.selfId;
		this._epoch++;
		this.status = DuetStatus.hosting;
		this._snapshots.clear();
		// Guests are most likely to share the last version the old host sent.
		this._version = Math.max(this._version, this._confirmedVersion);
		if (this._confirmed != null && this._confirmedVersion >= 0) this._snapshots.set(this._confirmedVersion, this._confirmed);
		this._doc.flushPendingHistory();
		this._publishVersion(this._doc.song.toBase64String());
		this._network.send(this._hello());
		this._sendState(this._memberIds(), undefined);
		this._changed();
	}

	private _memberIds(): string[] {
		return this.getPeers().map(peer => peer.id);
	}

	// ---- Host ----

	private _publishVersion(song: string): void {
		this._version++;
		this._canonical = song;
		this._snapshots.set(this._version, song);
		if (this._snapshots.size > maximumSnapshots) {
			this._snapshots.delete(this._snapshots.keys().next().value!);
		}
	}

	private _sendState(target: string | string[], ack: number | undefined, by: string = this.selfId): void {
		const message: any = { t: "state", v: this._version, song: this._canonical, epoch: this._epoch, fork: this._forkedFrom, by: by };
		if (ack != undefined) message.ack = ack;
		this._network.send(message, target);
	}

	private _scheduleBroadcast(): void {
		if (this._broadcastTimer != null) return;
		this._broadcastTimer = window.setTimeout(() => {
			this._broadcastTimer = null;
			if (this._ended || !this.isHost || this._lastKnown == this._canonical) return;
			this._publishVersion(this._lastKnown);
			this._sendState(this._memberIds(), undefined);
		}, hostBroadcastDelay);
	}

	private _receiveEdit(message: any, from: string): void {
		if (!this.isHost || typeof message.song != "string") return;
		this._doc.flushPendingHistory();
		const live: string = this._doc.song.toBase64String();
		const base: string = this._snapshots.get(Number(message.base)) ?? live;
		// The incoming edit is the newest change, so it wins conflicts.
		const merged: string = mergeSongs(base, live, message.song, "theirs");
		if (merged != live) this._applyRemoteSong(merged, false);
		if (this._lastKnown != this._canonical) this._publishVersion(this._lastKnown);
		this._sendState(from, Number(message.id), from);
		this._sendState(this._memberIds().filter(id => id != from), undefined, from);
	}

	// ---- Guest ----

	private _receiveState(message: any, from: string): void {
		if (typeof message.song != "string") return;
		const epoch: number = Number(message.epoch) | 0;
		if (this.isHost) {
			if (epoch > this._epoch || (epoch == this._epoch && from < this.selfId)) this._stepDown(from, epoch, message.fork);
			else return;
		}
		if (from != this.hostId) {
			if (this.hostId == null || epoch > this._epoch) this._followHost(from, epoch);
			else return;
		}

		if (this._confirmed == null) {
			// First contact: replace whatever was in the editor with the shared song.
			try {
				new Song(message.song);
			} catch (error) {
				console.error("DuetBox: received a song that couldn't be loaded", error);
				return;
			}
			this._applyRemoteSong(message.song, true);
			// Edits made before joining belong to the old song, so they can't be undone anymore.
			this._undoSteps.length = 0;
		} else {
			this._doc.flushPendingHistory();
			const live: string = this._doc.song.toBase64String();
			const acknowledged: boolean = message.ack != undefined && message.ack == this._inflightId && this._inflight != null;
			// Edits that the host hasn't seen yet are kept on top of the new version.
			const base: string = acknowledged ? this._inflight! : this._confirmed;
			if (acknowledged) this._inflight = null;
			const merged: string = mergeSongs(base, live, message.song, "ours");
			if (merged != live) this._applyRemoteSong(merged, false);
		}
		this._confirmed = message.song;
		this._confirmedVersion = Number(message.v);
		this.status = DuetStatus.connected;
		this._sendEditIfNeeded();
		this._changed();
	}

	private _sendEditIfNeeded(): void {
		if (this.isHost || this.hostId == null || this._confirmed == null || this._inflight != null) return;
		if (this._lastKnown == this._confirmed) return;
		this._inflight = this._lastKnown;
		this._inflightId++;
		this._network.send({ t: "edit", id: this._inflightId, base: this._confirmedVersion, song: this._inflight }, this.hostId);
	}

	// ---- Shared ----

	private _localSongChanged(): void {
		if (this._ended) return;
		if (this.isHost) this._scheduleBroadcast();
		else this._sendEditIfNeeded();
	}

	private _applyRemoteSong(song: string, isNewSong: boolean): void {
		this._lastKnown = this._doc.applyDuetSong(song, isNewSong);
		this._remoteSinceLastCommit = true;
	}

	private _isBusy(): boolean {
		return this._pointerDown || this._doc.synth.recording || this._doc.recordingModulators;
	}

	private _processQueue = (): void => {
		if (this._retryTimer != null) {
			window.clearTimeout(this._retryTimer);
			this._retryTimer = null;
		}
		if (this._ended) return;
		if (this._isBusy()) {
			this._retryTimer = window.setTimeout(this._processQueue, 250);
			return;
		}
		while (this._queue.length > 0) {
			const { message, from } = this._queue.shift()!;
			try {
				if (message.t == "state") this._receiveState(message, from);
				else if (message.t == "edit") this._receiveEdit(message, from);
			} catch (error) {
				console.error("DuetBox: couldn't apply an update from " + from, error);
			}
		}
	}

	private _whenPointerDown = (): void => {
		this._pointerDown = true;
	}

	private _whenPointerUp = (): void => {
		this._pointerDown = false;
		// Give mouseup handlers a chance to commit the edit that the drag made.
		window.setTimeout(this._processQueue, 30);
	}

	private _readPointer(value: any): DuetPointer | null {
		if (value == null || typeof value != "object" || (value.area != "pattern" && value.area != "track")) return null;
		const pointer: DuetPointer = { area: value.area, channel: Number(value.channel) | 0, bar: Number(value.bar) | 0, x: Number(value.x), y: Number(value.y) };
		return isFinite(pointer.x) && isFinite(pointer.y) ? pointer : null;
	}

	private _whenPointerMoved = (event: PointerEvent): void => {
		this._queuePointer(this.pointerLocator == null ? null : this.pointerLocator(event));
	}

	private _whenPointerLeft = (): void => {
		this._queuePointer(null);
	}

	private _queuePointer(pointer: DuetPointer | null): void {
		if (this._ended) return;
		this._pendingPointer = pointer;
		if (this._pointerTimer != null) return;
		this._pointerTimer = window.setTimeout(() => {
			this._pointerTimer = null;
			if (this._ended) return;
			const pointer: DuetPointer | null = this._pendingPointer;
			const rounded: any = pointer == null ? null : { area: pointer.area, channel: pointer.channel, bar: pointer.bar, x: Math.round(pointer.x * 100) / 100, y: Math.round(pointer.y * 100) / 100 };
			const key: string = JSON.stringify(rounded);
			if (key == this._sentPointer || this.getPeers().length == 0) return;
			this._sentPointer = key;
			this._network.send({ t: "pointer", pointer: rounded });
		}, pointerDelay);
	}

	private _whenPageHidden = (event: PageTransitionEvent): void => {
		// Closing the tab: let everyone know right away, so a new host can take over without waiting.
		if (!event.persisted) this.leave();
	}

	private _whenUnloading = (event: BeforeUnloadEvent): void => {
		if (this.getPeers().length > 0) {
			event.preventDefault();
			event.returnValue = "";
		}
	}

	private _whenDocumentChanged = (): void => {
		if (this._ended || (this._doc.channel == this._sentChannel && this._doc.bar == this._sentBar) || this._presenceTimer != null) return;
		this._presenceTimer = window.setTimeout(() => {
			this._presenceTimer = null;
			if (this._ended) return;
			this._sentChannel = this._doc.channel;
			this._sentBar = this._doc.bar;
			this._network.send({ t: "where", channel: this._sentChannel, bar: this._sentBar });
		}, presenceDelay);
	}

	private _updateColors(): void {
		const colors: Map<string, string> = assignColors([this.selfId].concat(Array.from(this.peers.keys())));
		this.color = colors.get(this.selfId)!;
		for (const peer of this.peers.values()) peer.color = colors.get(peer.id)!;
	}

	private _detach(): void {
		if (this._doc.duet == this) this._doc.duet = null;
	}

	private _repaint(): void {
		this._doc.notifier.changed();
		this._doc.notifier.notifyWatchers();
	}

	private _changed(): void {
		if (this.onChange != null) this.onChange();
	}
}

/** Starts, joins, and leaves sessions for the editor, and tells the UI when anything changes. */
export class DuetController {
	public session: DuetSession | null = null;
	/** An invite code from the page URL, waiting for the user to confirm joining. */
	public pendingInviteCode: string | null = null;
	public pointerLocator: ((event: PointerEvent) => DuetPointer | null) | null = null;
	public onPointersChanged: (() => void) | null = null;
	private readonly _listeners: (() => void)[] = [];

	constructor(private readonly _doc: SongDocument) {}

	public start(name: string, code: string = generateInviteCode()): DuetSession {
		this._end();
		saveDuetName(cleanDuetName(name));
		return this._attach(DuetSession.host(this._doc, code, name));
	}

	public join(code: string, name: string): DuetSession {
		this._end();
		saveDuetName(cleanDuetName(name));
		return this._attach(DuetSession.join(this._doc, code, name));
	}

	public leave(): void {
		this._end();
		setInviteCodeInUrl(null);
		this._notify();
	}

	public listen(listener: () => void): void {
		if (this._listeners.indexOf(listener) == -1) this._listeners.push(listener);
	}

	public unlisten(listener: () => void): void {
		const index: number = this._listeners.indexOf(listener);
		if (index != -1) this._listeners.splice(index, 1);
	}

	private _attach(session: DuetSession): DuetSession {
		this.session = session;
		this.pendingInviteCode = null;
		session.onChange = () => this._notify();
		session.pointerLocator = (event: PointerEvent) => this.pointerLocator == null ? null : this.pointerLocator(event);
		session.onPointersChanged = () => { if (this.onPointersChanged != null) this.onPointersChanged(); };
		setInviteCodeInUrl(session.code);
		this._notify();
		return session;
	}

	private _end(): void {
		if (this.session != null) {
			this.session.onChange = null;
			this.session.onPointersChanged = null;
			this.session.leave();
			this.session = null;
			if (this.onPointersChanged != null) this.onPointersChanged();
		}
	}

	private _notify(): void {
		for (const listener of this._listeners.concat()) listener();
	}
}
