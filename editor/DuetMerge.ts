// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// DuetBox: three-way merging of song URLs.
//
// Collaborators exchange whole song strings (the same format as the URL), and
// this module combines two edited versions of a song that started from a
// common base. Songs are compared piece by piece (song settings, channel
// names, instruments, patterns, and sequence cells), so two people editing
// different pieces at the same time both keep their work. When the same piece
// was changed on both sides, the caller decides which side wins.
//
// Channels are matched up by content when one side inserted or deleted
// channels, so edits still land on the right channel. Changes to beats per bar
// or the instrument layering modes reshape every pattern, so those are merged
// by taking one side's whole song.

import { Config, InstrumentType } from "../synth/SynthConfig";
import { Channel, Instrument, Note, Pattern, Song } from "../synth/synth";

export type MergeWinner = "ours" | "theirs";

const channelTypePitch: number = 0;
const channelTypeNoise: number = 1;
const channelTypeMod: number = 2;

// Channels need to share at least this fraction of their parts to be
// considered the same channel when the number of channels changed.
const minimumChannelSimilarity: number = 0.3;

interface ChannelInfo {
	readonly type: number;
	readonly name: string;
	readonly octave: number;
	readonly instruments: string[]; // Encoded settings, excluding mod channel targets.
	readonly modTargets: number[][]; // Raw modChannels for each instrument of a mod channel.
	readonly patterns: string[];
	readonly bars: number[];
}

// Song-level settings that are merged independently of each other.
const songSettings: ReadonlyArray<{ get: (song: Song) => string, copy: (from: Song, to: Song) => void }> = [
	{ get: s => s.title, copy: (f, t) => { t.title = f.title; } },
	{ get: s => s.scale + ":" + s.scaleCustom.join(","), copy: (f, t) => { t.scale = f.scale; t.scaleCustom = f.scaleCustom.concat(); } },
	{ get: s => s.key + ":" + s.octave, copy: (f, t) => { t.key = f.key; t.octave = f.octave; } },
	{ get: s => "" + s.tempo, copy: (f, t) => { t.tempo = f.tempo; } },
	{ get: s => "" + s.rhythm, copy: (f, t) => { t.rhythm = f.rhythm; } },
	{ get: s => s.loopStart + ":" + s.loopLength, copy: (f, t) => { t.loopStart = f.loopStart; t.loopLength = f.loopLength; } },
	{
		get: s => [s.compressionRatio, s.limitRatio, s.limitDecay, s.limitRise, s.compressionThreshold, s.limitThreshold, s.masterGain].join(","),
		copy: (f, t) => {
			t.compressionRatio = f.compressionRatio;
			t.limitRatio = f.limitRatio;
			t.limitDecay = f.limitDecay;
			t.limitRise = f.limitRise;
			t.compressionThreshold = f.compressionThreshold;
			t.limitThreshold = f.limitThreshold;
			t.masterGain = f.masterGain;
		},
	},
];

function noteFingerprint(note: Note): string {
	let result: string = note.start + "," + note.end + "," + note.pitches.join(".") + "," + (note.start == 0 && note.continuesLastPattern ? 1 : 0);
	for (const pin of note.pins) {
		result += "," + pin.interval + "/" + pin.time + "/" + pin.size;
	}
	return result;
}

function patternFingerprint(pattern: Pattern): string {
	let result: string = pattern.instruments.join(",");
	for (const note of pattern.notes) {
		result += ";" + noteFingerprint(note);
	}
	return result;
}

function notesOverlap(a: Note, b: Note, isModChannel: boolean): boolean {
	// Mod channel notes only collide with notes for the same modulator.
	if (isModChannel && a.pitches[0] != b.pitches[0]) return false;
	return a.start < b.end && b.start < a.end;
}

// When both sides edited the same pattern, combine their edits note by note: notes
// either side removed are removed, notes either side added are added, and if
// added notes collide, the winner's note is kept.
function mergePatternNotes(base: Pattern | undefined, ours: Pattern, theirs: Pattern, winner: MergeWinner, isModChannel: boolean): Pattern {
	const baseKeys: Set<string> = new Set(base == undefined ? [] : base.notes.map(noteFingerprint));
	const oursKeys: Set<string> = new Set(ours.notes.map(noteFingerprint));
	const theirsKeys: Set<string> = new Set(theirs.notes.map(noteFingerprint));

	const kept: Note[] = ours.notes.filter(note => { const key: string = noteFingerprint(note); return baseKeys.has(key) && theirsKeys.has(key); });
	const addedByOurs: Note[] = ours.notes.filter(note => !baseKeys.has(noteFingerprint(note)));
	const addedByTheirs: Note[] = theirs.notes.filter(note => { const key: string = noteFingerprint(note); return !baseKeys.has(key) && !oursKeys.has(key); });

	const notes: Note[] = kept.concat();
	for (const note of winner == "ours" ? addedByOurs.concat(addedByTheirs) : addedByTheirs.concat(addedByOurs)) {
		if (!notes.some(other => notesOverlap(note, other, isModChannel))) notes.push(note);
	}
	notes.sort((a, b) => a.start - b.start);

	const result: Pattern = ours;
	const instruments: number[] = pickValue(base == undefined ? undefined : base.instruments.join(","), ours.instruments.join(","), theirs.instruments.join(","), winner) == theirs.instruments.join(",") ? theirs.instruments.concat() : ours.instruments.concat();
	result.notes = notes;
	result.instruments.length = 0;
	Array.prototype.push.apply(result.instruments, instruments);
	return result;
}

function modSettingsFingerprint(instrument: Instrument): string {
	return instrument.modInstruments.join(",") + "|" + instrument.modulators.join(",") + "|" + instrument.modFilterTypes.join(",");
}

// Splits off the custom sample list that follows the song data, the same way Song.fromBase64String does.
function splitSamples(hash: string): [string, string] {
	const normalized: string = hash.replace(/^\s*#/, "").replace(/%7C/g, "|");
	const index: number = normalized.indexOf("|");
	return index == -1 ? [normalized, ""] : [normalized.substring(0, index), normalized.substring(index)];
}

class ParsedSong {
	public readonly song: Song;
	public readonly structure: string;
	public readonly settings: string[];
	public readonly channels: ChannelInfo[] = [];
	public readonly groups: number[][] = [[], [], []];

	constructor(hash: string) {
		const song: Song = new Song(hash);
		this.song = song;
		this.structure = song.beatsPerBar + ":" + song.layeredInstruments + ":" + song.patternInstruments;
		this.settings = songSettings.map(setting => setting.get(song));

		const instrumentRanges: [number, number][][] = [];
		const encoded: string = song.toBase64String(instrumentRanges);
		for (let channelIndex: number = 0; channelIndex < song.channels.length; channelIndex++) {
			const channel: Channel = song.channels[channelIndex];
			const type: number = song.getChannelIsMod(channelIndex) ? channelTypeMod : (song.getChannelIsNoise(channelIndex) ? channelTypeNoise : channelTypePitch);
			const instruments: string[] = [];
			const modTargets: number[][] = [];
			for (let i: number = 0; i < channel.instruments.length; i++) {
				const range: [number, number] = instrumentRanges[channelIndex][i];
				let fingerprint: string = encoded.substring(range[0], range[1]);
				if (type == channelTypeMod) {
					fingerprint += "|" + modSettingsFingerprint(channel.instruments[i]);
					modTargets.push(channel.instruments[i].modChannels.concat());
				}
				instruments.push(fingerprint);
			}
			this.channels.push({
				type: type,
				name: channel.name,
				octave: channel.octave,
				instruments: instruments,
				modTargets: modTargets,
				patterns: channel.patterns.map(patternFingerprint),
				bars: channel.bars.concat(),
			});
			this.groups[type].push(channelIndex);
		}
	}
}

// Decides which side's version of one part to keep. Undefined means the part doesn't exist on that side.
function pick<T>(base: T | undefined, ours: T | undefined, theirs: T | undefined, winner: MergeWinner): MergeWinner {
	if (ours === theirs) return "ours";
	if (theirs === base) return "ours";
	if (ours === base) return "theirs";
	return winner;
}

function pickValue<T>(base: T, ours: T, theirs: T, winner: MergeWinner): T {
	return pick(base, ours, theirs, winner) == "ours" ? ours : theirs;
}

function channelSimilarity(a: ChannelInfo, b: ChannelInfo): number {
	let same: number = 0;
	let total: number = 2;
	if (a.name == b.name) same++;
	if (a.octave == b.octave) same++;
	const compare = <T>(x: T[], y: T[]): void => {
		const length: number = Math.max(x.length, y.length);
		total += length;
		for (let i: number = 0; i < length; i++) {
			if (x[i] === y[i]) same++;
		}
	};
	compare(a.instruments, b.instruments);
	compare(a.patterns, b.patterns);
	compare(a.bars, b.bars);
	return same / total;
}

// Matches channels of one song type group to the base song's channels, preserving order.
// Returns a map from the other song's channel index to the base song's channel index.
function alignGroup(base: ParsedSong, other: ParsedSong, type: number): Map<number, number> {
	const baseIndices: number[] = base.groups[type];
	const otherIndices: number[] = other.groups[type];
	const result: Map<number, number> = new Map();
	if (baseIndices.length == otherIndices.length) {
		for (let i: number = 0; i < otherIndices.length; i++) result.set(otherIndices[i], baseIndices[i]);
		return result;
	}

	const n: number = baseIndices.length;
	const m: number = otherIndices.length;
	const similarity: number[][] = [];
	const score: number[][] = [];
	for (let i: number = 0; i <= n; i++) {
		similarity[i] = [];
		score[i] = [];
		for (let j: number = 0; j <= m; j++) {
			similarity[i][j] = (i > 0 && j > 0) ? channelSimilarity(base.channels[baseIndices[i - 1]], other.channels[otherIndices[j - 1]]) : 0;
			let best: number = 0;
			if (i > 0) best = Math.max(best, score[i - 1][j]);
			if (j > 0) best = Math.max(best, score[i][j - 1]);
			if (i > 0 && j > 0 && similarity[i][j] >= minimumChannelSimilarity) best = Math.max(best, score[i - 1][j - 1] + similarity[i][j]);
			score[i][j] = best;
		}
	}

	let i: number = n;
	let j: number = m;
	while (i > 0 && j > 0) {
		if (similarity[i][j] >= minimumChannelSimilarity && score[i][j] == score[i - 1][j - 1] + similarity[i][j]) {
			result.set(otherIndices[j - 1], baseIndices[i - 1]);
			i--;
			j--;
		} else if (score[i][j] == score[i - 1][j]) {
			i--;
		} else {
			j--;
		}
	}
	return result;
}

function invert(map: Map<number, number>): Map<number, number> {
	const result: Map<number, number> = new Map();
	map.forEach((value, key) => result.set(value, key));
	return result;
}

interface MergedChannelSource {
	readonly base: number;
	readonly ours: number;
	readonly theirs: number;
}

// Merges one type group's list of channels: channels deleted on either side are
// dropped, and channels added on either side are kept near where they were added.
function mergeGroup(type: number, base: ParsedSong, ours: ParsedSong, theirs: ParsedSong, oursToBase: Map<number, number>, theirsToBase: Map<number, number>): MergedChannelSource[] {
	const baseToOurs: Map<number, number> = invert(oursToBase);
	const baseToTheirs: Map<number, number> = invert(theirsToBase);

	// Anchor each channel added by theirs after the nearest preceding channel that survives on both sides.
	const theirsAddedAfter: Map<number, number[]> = new Map();
	let anchor: number = -1;
	for (const theirsIndex of theirs.groups[type]) {
		const baseIndex: number | undefined = theirsToBase.get(theirsIndex);
		if (baseIndex == undefined) {
			if (!theirsAddedAfter.has(anchor)) theirsAddedAfter.set(anchor, []);
			theirsAddedAfter.get(anchor)!.push(theirsIndex);
		} else if (baseToOurs.has(baseIndex)) {
			anchor = baseIndex;
		}
	}

	const result: MergedChannelSource[] = [];
	const addTheirs = (anchor: number): void => {
		for (const theirsIndex of theirsAddedAfter.get(anchor) || []) {
			result.push({ base: -1, ours: -1, theirs: theirsIndex });
		}
	};
	addTheirs(-1);
	for (const oursIndex of ours.groups[type]) {
		const baseIndex: number | undefined = oursToBase.get(oursIndex);
		if (baseIndex == undefined) {
			result.push({ base: -1, ours: oursIndex, theirs: -1 });
			continue;
		}
		const theirsIndex: number | undefined = baseToTheirs.get(baseIndex);
		if (theirsIndex != undefined) {
			result.push({ base: baseIndex, ours: oursIndex, theirs: theirsIndex });
		}
		addTheirs(baseIndex);
	}

	// Respect the channel count limits by dropping the most recently added channels.
	const maximum: number = [Config.pitchChannelCountMax, Config.noiseChannelCountMax, Config.modChannelCountMax][type];
	for (let i: number = result.length - 1; i >= 0 && result.length > maximum; i--) {
		if (result[i].base == -1 && result[i].theirs != -1) result.splice(i, 1);
	}
	for (let i: number = result.length - 1; i >= 0 && result.length > maximum; i--) {
		if (result[i].base == -1) result.splice(i, 1);
	}
	return result;
}

// Translates a channel index of one song into a stable token, so mod targets can be compared across songs.
type ChannelTokenizer = (channelIndex: number) => string;

function makeTokenizer(prefix: string, toBase: Map<number, number> | null): ChannelTokenizer {
	return (channelIndex: number): string => {
		if (channelIndex < 0) return "" + channelIndex;
		if (toBase == null) return "b" + channelIndex;
		const baseIndex: number | undefined = toBase.get(channelIndex);
		return baseIndex == undefined ? prefix + channelIndex : "b" + baseIndex;
	};
}

function instrumentFingerprint(parsed: ParsedSong, channelIndex: number, instrumentIndex: number, tokenize: ChannelTokenizer): string | undefined {
	const channel: ChannelInfo = parsed.channels[channelIndex];
	const fingerprint: string | undefined = channel.instruments[instrumentIndex];
	if (fingerprint == undefined || channel.type != channelTypeMod) return fingerprint;
	return fingerprint + "|" + channel.modTargets[instrumentIndex].map(tokenize).join(",");
}

function filterPatternInstruments(song: Song, channelIndex: number): void {
	const channel: Channel = song.channels[channelIndex];
	const maximum: number = song.getChannelIsMod(channelIndex) ? 1 : song.getMaxInstrumentsPerPattern(channelIndex);
	for (const pattern of channel.patterns) {
		const valid: number[] = [];
		for (const instrument of pattern.instruments) {
			if (instrument < channel.instruments.length && valid.indexOf(instrument) == -1 && valid.length < maximum) valid.push(instrument);
		}
		if (valid.length == 0) valid.push(0);
		pattern.instruments.length = 0;
		Array.prototype.push.apply(pattern.instruments, valid);
	}
}

function resizePatterns(channel: Channel, patternCount: number): void {
	while (channel.patterns.length < patternCount) channel.patterns.push(new Pattern());
	channel.patterns.length = patternCount;
}

function resizeBars(channel: Channel, barCount: number): void {
	while (channel.bars.length < barCount) channel.bars.push(0);
	channel.bars.length = barCount;
}

/**
 * Combines the changes that `ours` and `theirs` each made relative to `base`.
 * All three arguments and the result are song strings as produced by Song.toBase64String().
 * When both sides changed the same part, `winner` decides whose version is kept.
 */
export function mergeSongs(base: string, ours: string, theirs: string, winner: MergeWinner): string {
	if (ours == theirs || base == theirs) return ours;
	if (base == ours) return theirs;

	// The custom sample list is global editor state, so pick it first and parse every song with it.
	const [baseMain, baseSamples] = splitSamples(base);
	const [oursMain, oursSamples] = splitSamples(ours);
	const [theirsMain, theirsSamples] = splitSamples(theirs);
	const samples: string = pickValue(baseSamples, oursSamples, theirsSamples, winner);

	const baseSong: ParsedSong = new ParsedSong(baseMain + samples);
	const oursSong: ParsedSong = new ParsedSong(oursMain + samples);
	const theirsSong: ParsedSong = new ParsedSong(theirsMain + samples);

	if (baseSong.structure != oursSong.structure || baseSong.structure != theirsSong.structure) {
		// One side reshaped every pattern, so keep that side's whole song.
		const side: MergeWinner = pick(baseSong.structure, oursSong.structure, theirsSong.structure, winner);
		return (side == "ours" ? oursSong : theirsSong).song.toBase64String();
	}

	const result: Song = oursSong.song;

	for (let i: number = 0; i < songSettings.length; i++) {
		if (pick(baseSong.settings[i], oursSong.settings[i], theirsSong.settings[i], winner) == "theirs") {
			songSettings[i].copy(theirsSong.song, result);
		}
	}
	const barCount: number = pickValue(baseSong.song.barCount, oursSong.song.barCount, theirsSong.song.barCount, winner);
	const patternsPerChannel: number = pickValue(baseSong.song.patternsPerChannel, oursSong.song.patternsPerChannel, theirsSong.song.patternsPerChannel, winner);

	// Line up the channels of each side with the base song's channels.
	const oursToBase: Map<number, number> = new Map();
	const theirsToBase: Map<number, number> = new Map();
	for (let type: number = 0; type < 3; type++) {
		alignGroup(baseSong, oursSong, type).forEach((value, key) => oursToBase.set(key, value));
		alignGroup(baseSong, theirsSong, type).forEach((value, key) => theirsToBase.set(key, value));
	}
	const sources: MergedChannelSource[][] = [0, 1, 2].map(type => mergeGroup(type, baseSong, oursSong, theirsSong, oursToBase, theirsToBase));
	if (sources[channelTypePitch].length < Config.pitchChannelCountMin || sources[channelTypeNoise].length < Config.noiseChannelCountMin || sources[channelTypeMod].length < Config.modChannelCountMin) {
		return (winner == "ours" ? oursSong : theirsSong).song.toBase64String();
	}
	const merged: MergedChannelSource[] = sources[channelTypePitch].concat(sources[channelTypeNoise], sources[channelTypeMod]);

	// Where each side's channels end up in the merged song, for remapping mod targets.
	const resultIndexOfBase: Map<number, number> = new Map();
	const resultIndexOfOursAdded: Map<number, number> = new Map();
	const resultIndexOfTheirsAdded: Map<number, number> = new Map();
	merged.forEach((source, resultIndex) => {
		if (source.base != -1) resultIndexOfBase.set(source.base, resultIndex);
		else if (source.ours != -1) resultIndexOfOursAdded.set(source.ours, resultIndex);
		else resultIndexOfTheirsAdded.set(source.theirs, resultIndex);
	});
	const toResult = (toBase: Map<number, number>, added: Map<number, number>) => (channelIndex: number): number | undefined => {
		const baseIndex: number | undefined = toBase.get(channelIndex);
		return baseIndex == undefined ? added.get(channelIndex) : resultIndexOfBase.get(baseIndex);
	};
	const oursToResult = toResult(oursToBase, resultIndexOfOursAdded);
	const theirsToResult = toResult(theirsToBase, resultIndexOfTheirsAdded);
	const tokenizeBase: ChannelTokenizer = makeTokenizer("b", null);
	const tokenizeOurs: ChannelTokenizer = makeTokenizer("o", oursToBase);
	const tokenizeTheirs: ChannelTokenizer = makeTokenizer("t", theirsToBase);

	const modInstruments: { instrument: Instrument, toResult: (channelIndex: number) => number | undefined }[] = [];
	const resultChannels: Channel[] = [];
	for (const source of merged) {
		if (source.base == -1) {
			// A channel added by one side is taken as a whole.
			const fromOurs: boolean = source.ours != -1;
			const channel: Channel = fromOurs ? oursSong.song.channels[source.ours] : theirsSong.song.channels[source.theirs];
			resizePatterns(channel, patternsPerChannel);
			resizeBars(channel, barCount);
			for (const instrument of channel.instruments) modInstruments.push({ instrument: instrument, toResult: fromOurs ? oursToResult : theirsToResult });
			resultChannels.push(channel);
			continue;
		}

		const baseInfo: ChannelInfo = baseSong.channels[source.base];
		const oursInfo: ChannelInfo = oursSong.channels[source.ours];
		const theirsInfo: ChannelInfo = theirsSong.channels[source.theirs];
		const oursChannel: Channel = oursSong.song.channels[source.ours];
		const theirsChannel: Channel = theirsSong.song.channels[source.theirs];

		if (pick(baseInfo.name, oursInfo.name, theirsInfo.name, winner) == "theirs") oursChannel.name = theirsChannel.name;
		if (pick(baseInfo.octave, oursInfo.octave, theirsInfo.octave, winner) == "theirs") oursChannel.octave = theirsChannel.octave;

		const instrumentCount: number = pickValue(baseInfo.instruments.length, oursInfo.instruments.length, theirsInfo.instruments.length, winner);
		const instruments: Instrument[] = [];
		for (let i: number = 0; i < instrumentCount; i++) {
			const side: MergeWinner = pick(
				instrumentFingerprint(baseSong, source.base, i, tokenizeBase),
				instrumentFingerprint(oursSong, source.ours, i, tokenizeOurs),
				instrumentFingerprint(theirsSong, source.theirs, i, tokenizeTheirs),
				winner);
			const useTheirs: boolean = (side == "theirs" && i < theirsChannel.instruments.length) || i >= oursChannel.instruments.length;
			const instrument: Instrument = useTheirs ? theirsChannel.instruments[i] : oursChannel.instruments[i];
			modInstruments.push({ instrument: instrument, toResult: useTheirs ? theirsToResult : oursToResult });
			instruments.push(instrument);
		}

		const patterns: Pattern[] = [];
		const isModChannel: boolean = baseInfo.type == channelTypeMod;
		for (let i: number = 0; i < patternsPerChannel; i++) {
			const basePattern: string | undefined = baseInfo.patterns[i];
			const oursPattern: string | undefined = oursInfo.patterns[i];
			const theirsPattern: string | undefined = theirsInfo.patterns[i];
			if (oursPattern != undefined && theirsPattern != undefined && oursPattern != basePattern && theirsPattern != basePattern && oursPattern != theirsPattern) {
				patterns.push(mergePatternNotes(baseSong.song.channels[source.base].patterns[i], oursChannel.patterns[i], theirsChannel.patterns[i], winner, isModChannel));
				continue;
			}
			const side: MergeWinner = pick(basePattern, oursPattern, theirsPattern, winner);
			const preferred: Pattern | undefined = side == "theirs" ? theirsChannel.patterns[i] : oursChannel.patterns[i];
			patterns.push(preferred || oursChannel.patterns[i] || theirsChannel.patterns[i] || new Pattern());
		}

		const bars: number[] = [];
		for (let i: number = 0; i < barCount; i++) {
			bars.push(pickValue(baseInfo.bars[i], oursInfo.bars[i], theirsInfo.bars[i], winner) || 0);
		}

		oursChannel.instruments.length = 0;
		Array.prototype.push.apply(oursChannel.instruments, instruments);
		oursChannel.patterns.length = 0;
		Array.prototype.push.apply(oursChannel.patterns, patterns);
		oursChannel.bars.length = 0;
		Array.prototype.push.apply(oursChannel.bars, bars);
		resultChannels.push(oursChannel);
	}

	result.channels.length = 0;
	Array.prototype.push.apply(result.channels, resultChannels);
	result.pitchChannelCount = sources[channelTypePitch].length;
	result.noiseChannelCount = sources[channelTypeNoise].length;
	result.modChannelCount = sources[channelTypeMod].length;
	result.barCount = barCount;
	result.patternsPerChannel = patternsPerChannel;

	// Point mod instruments at the merged channel positions.
	const noneModulator: number = Config.modulators.dictionary["none"].index;
	const targetableChannels: number = result.pitchChannelCount + result.noiseChannelCount;
	for (const { instrument, toResult } of modInstruments) {
		if (instrument.type != InstrumentType.mod) continue;
		for (let mod: number = 0; mod < Config.modCount; mod++) {
			if (instrument.modChannels[mod] < 0) continue;
			const target: number | undefined = toResult(instrument.modChannels[mod]);
			if (target == undefined || target >= targetableChannels) {
				instrument.modChannels[mod] = -2;
				instrument.modInstruments[mod] = 0;
				instrument.modulators[mod] = noneModulator;
			} else {
				instrument.modChannels[mod] = target;
			}
		}
	}

	for (let channelIndex: number = 0; channelIndex < result.channels.length; channelIndex++) {
		const channel: Channel = result.channels[channelIndex];
		filterPatternInstruments(result, channelIndex);
		for (let bar: number = 0; bar < channel.bars.length; bar++) {
			if (channel.bars[bar] > patternsPerChannel) channel.bars[bar] = 0;
		}
	}
	result.loopStart = Math.max(0, Math.min(barCount - 1, result.loopStart));
	result.loopLength = Math.max(1, Math.min(barCount - result.loopStart, result.loopLength));

	return result.toBase64String();
}
