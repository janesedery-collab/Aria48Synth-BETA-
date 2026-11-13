/**
 * spressasynth_lib-master.zip
 * Comprehensive SoundFont2 (SF2/SF3) & 16-Channel MIDI Synthesizer Engine
 * Features 16 dedicated channel AudioNodes & AnalyserNodes for oscilloscope monitoring
 */

import { SpessaSynthCore, SPRESSASYNTH_CORE_ENGINE_ID } from './spressasynthCore';
import { getInterpolationMode, interpolateSampleBuffer } from './soundFontInterpolation';
import { getBuiltInSoundFontVoice } from '../utils/soundFontEngine';
export { SpessaSynthCore, SPRESSASYNTH_CORE_ENGINE_ID };

export const SPRESSASYNTH_ENGINE_ID = "spressasynth_lib-master.zip";

export interface SpessaSoundFont {
  id: string;
  name: string;
  version: string;
  format?: string;
  instrumentCount: number;
  presets: string[];
  isCustom: boolean;
  sampleData?: Float32Array;
}

export interface MidiChannelState {
  index: number; // 0 to 15
  bank: number; // 0 to 128 (CC 0 Bank Select)
  program: number; // 0 to 127
  programName: string;
  volume: number; // 0 to 127 (CC 7)
  expression: number; // 0 to 127 (CC 11)
  pan: number; // 0 to 127 (CC 10)
  pitchBend: number; // -8192 to 8191
  sustainPedal: boolean; // CC 64
  isMuted: boolean;
  activeNoteCount: number;
  pitchBendRange: number; // Semitones, default 2 (range 1 to 24)
  portamentoEnabled: boolean; // CC 65 (Glide Switch)
  portamentoTime: number; // CC 5 (Glide Rate 0 to 127)
  portamentoControl: number | null; // CC 84 (Source Note for Portamento 0 to 127)
  lastNote: number | null; // Previous played note for glide
}

interface SpessaVoiceRecord {
  channel: number;
  osc?: OscillatorNode;
  subOsc?: OscillatorNode;
  filterNode?: BiquadFilterNode;
  bufferSource?: AudioBufferSourceNode;
  rootKey?: number;
  pitchCorrection?: number;
  usesPreInterpolatedBuffer?: boolean;
  initialPlaybackRate?: number;
  initialBendSemitones?: number;
  noteGain: GainNode;
  baseNote: number;
  subRatio: number;
  startTime: number;
  stopAt: number;
  hasScheduledStop: boolean;
  pendingRelease: boolean;
  isDisposed: boolean;
  release: (releaseTime?: number) => void;
  forceStop: () => void;
  dispose: () => void;
}

const MAX_GLOBAL_VOICES = 192;
const MAX_CHANNEL_VOICES = 32;
const MICRO_COALESCE_SEC = 0.004;

export const DEFAULT_GM_PROGRAMS: string[] = [
  "Acoustic Grand Piano", "Bright Piano", "Electric Grand", "Honky-tonk", "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet",
  "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
  "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
  "Nylon Guitar", "Steel Guitar", "Jazz Guitar", "Clean Guitar", "Muted Guitar", "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics",
  "Acoustic Bass", "Finger Bass", "Pick Bass", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
  "Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani",
  "String Ensemble 1", "String Ensemble 2", "SynthStrings 1", "SynthStrings 2", "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
  "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass Section", "SynthBrass 1", "SynthBrass 2",
  "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet",
  "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
  "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)", "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass+lead)",
  "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)", "Pad 5 (bowed)", "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)",
  "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)", "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)",
  "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
  "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
  "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet", "Telephone Ring", "Helicopter", "Applause", "Gunshot"
];

class SpessaSynthEngine {
  public readonly engineId = SPRESSASYNTH_ENGINE_ID;
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;

  // 16 dedicated channels with individual gain and AnalyserNodes
  private channelGains: GainNode[] = [];
  private channelPanners: StereoPannerNode[] = [];
  private channelAnalysers: AnalyserNode[] = [];
  private channelStates: MidiChannelState[] = [];

  // Active soundfonts
  private soundFonts: SpessaSoundFont[] = [];
  private activeSoundFontId = "spessa-default-gm";
  private soundFontListeners: Array<(fonts: SpessaSoundFont[], activeId: string) => void> = [];
  private channelStateListeners: Array<(states: MidiChannelState[]) => void> = [];

  // Active playback tracking (O(1) lock-free reaper, up to 10,000 notes/sec input rate)
  private isPlaying = false;
  private allVoiceRecords: SpessaVoiceRecord[] = [];
  private activeOscillators: { [channel: number]: SpessaVoiceRecord[] } = {};
  private playbackTimeoutIds: any[] = [];
  private voiceReaperTimer: any = null;
  private lastTriggerAudioTime = new Float64Array(16 * 128);
  private throughputWindowStartMs = 0;
  private throughputWindowCount = 0;
  private lastNotesPerSec = 0;
  private peakNotesPerSec = 0;
  private coalescedNotesCount = 0;

  constructor() {
    this.soundFonts.push({
      id: "spessa-default-gm",
      name: "SpessaSynth General MIDI SoundFont",
      version: "2.04",
      format: "Built-in GM",
      instrumentCount: 128,
      presets: DEFAULT_GM_PROGRAMS.slice(0, 32),
      isCustom: false
    });

    this.soundFonts.push({
      id: "spessa-chiptune-sf2",
      name: "SpessaSynth Retro 8-bit & FM SoundFont",
      version: "1.20",
      format: "Built-in Chip",
      instrumentCount: 64,
      presets: ["C64 SID Pulse", "Amiga Paula Lead", "OPL3 FM Brass", "GameBoy Wave", "NES Triangle Bass"],
      isCustom: false
    });

    // Initialize 16 channel states
    for (let i = 0; i < 16; i++) {
      const defaultProg = i === 9 ? 0 : i % 8; // Channel 10 (idx 9) is standard GM Percussion
      this.channelStates.push({
        index: i,
        bank: i === 9 ? 128 : 0,
        program: defaultProg,
        programName: i === 9 ? "GM Standard Drum Kit" : (DEFAULT_GM_PROGRAMS[defaultProg] || `Program ${defaultProg}`),
        volume: 100,
        expression: 127,
        pan: 64,
        pitchBend: 0,
        sustainPedal: false,
        isMuted: false,
        activeNoteCount: 0,
        pitchBendRange: 2,
        portamentoEnabled: false,
        portamentoTime: 64,
        portamentoControl: null,
        lastNote: null
      });
      this.activeOscillators[i] = [];
    }
  }

  public init(context?: AudioContext): AudioContext {
    if (!this.audioCtx) {
      if (context) {
        this.audioCtx = context;
      } else if (typeof window !== 'undefined') {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        this.audioCtx = new AudioContextClass();
      }
    }

    if (this.audioCtx && this.channelAnalysers.length === 0) {
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(0.7, this.audioCtx.currentTime);

      // Brickwall safety limiter prevents digital clipping / Web Audio collapse on 10,000 notes/sec chords
      this.masterLimiter = this.audioCtx.createDynamicsCompressor();
      const now = this.audioCtx.currentTime;
      this.masterLimiter.threshold.setValueAtTime(-7, now);
      this.masterLimiter.knee.setValueAtTime(6, now);
      this.masterLimiter.ratio.setValueAtTime(16, now);
      this.masterLimiter.attack.setValueAtTime(0.001, now);
      this.masterLimiter.release.setValueAtTime(0.08, now);

      this.masterGain.connect(this.masterLimiter);
      this.masterLimiter.connect(this.audioCtx.destination);

      for (let i = 0; i < 16; i++) {
        const gain = this.audioCtx.createGain();
        const chState = this.channelStates[i];
        const initGain = chState?.isMuted
          ? 0
          : ((chState?.volume ?? 100) / 127) * ((chState?.expression ?? 127) / 127) * 0.85;
        gain.gain.setValueAtTime(initGain, this.audioCtx.currentTime);

        const panner = this.audioCtx.createStereoPanner();
        const panValue = ((i - 7.5) / 7.5) * 0.65;
        panner.pan.setValueAtTime(Math.max(-0.85, Math.min(0.85, panValue)), this.audioCtx.currentTime);

        const analyser = this.audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.55;

        gain.connect(panner);
        panner.connect(analyser);
        analyser.connect(this.masterGain);

        this.channelGains.push(gain);
        this.channelPanners.push(panner);
        this.channelAnalysers.push(analyser);
      }
    }

    this.ensureVoiceReaper();
    return this.audioCtx!;
  }

  private ensureVoiceReaper() {
    if (this.voiceReaperTimer || typeof setInterval === 'undefined') return;
    this.voiceReaperTimer = setInterval(() => {
      this.reapExpiredVoices();
    }, 80);
  }

  private reapExpiredVoices() {
    if (!this.audioCtx || this.allVoiceRecords.length === 0) return;
    const nowTime = this.audioCtx.currentTime;

    for (let i = this.allVoiceRecords.length - 1; i >= 0; i--) {
      const rec = this.allVoiceRecords[i];
      if (!rec.hasScheduledStop && nowTime - rec.startTime > 24) {
        rec.release(nowTime);
      }
      if (rec.isDisposed || (rec.hasScheduledStop && nowTime >= rec.stopAt + 0.02)) {
        rec.dispose();
        // Fast swap-pop removal from global list
        const lastIdx = this.allVoiceRecords.length - 1;
        if (i !== lastIdx) {
          this.allVoiceRecords[i] = this.allVoiceRecords[lastIdx];
        }
        this.allVoiceRecords.pop();

        const chList = this.activeOscillators[rec.channel];
        if (chList) {
          const idx = chList.indexOf(rec);
          if (idx !== -1) {
            const cLast = chList.length - 1;
            if (idx !== cLast) chList[idx] = chList[cLast];
            chList.pop();
          }
        }
        const chState = this.channelStates[rec.channel];
        if (chState && chState.activeNoteCount > 0) {
          chState.activeNoteCount--;
        }
      }
    }
  }

  private enforcePolyphonyLimits(chIdx: number, isHighDensity: boolean) {
    const chList = this.activeOscillators[chIdx];
    const chCap = isHighDensity ? 20 : MAX_CHANNEL_VOICES;

    // 1. Per-channel voice cap (prefer stealing already-releasing voices first, then oldest)
    if (chList && chList.length >= chCap) {
      let stealIdx = 0;
      for (let i = 0; i < chList.length; i++) {
        if (chList[i].hasScheduledStop) {
          stealIdx = i;
          break;
        }
      }
      const victim = chList[stealIdx];
      if (victim) {
        victim.forceStop();
        const cLast = chList.length - 1;
        if (stealIdx !== cLast) chList[stealIdx] = chList[cLast];
        chList.pop();
        const gIdx = this.allVoiceRecords.indexOf(victim);
        if (gIdx !== -1) {
          const gLast = this.allVoiceRecords.length - 1;
          if (gIdx !== gLast) this.allVoiceRecords[gIdx] = this.allVoiceRecords[gLast];
          this.allVoiceRecords.pop();
        }
        const chState = this.channelStates[chIdx];
        if (chState && chState.activeNoteCount > 0) chState.activeNoteCount--;
      }
    }

    // 2. Global 192-voice cap with oldest/releasing priority stealing
    if (this.allVoiceRecords.length >= MAX_GLOBAL_VOICES) {
      let victimIdx = 0;
      for (let i = 0; i < this.allVoiceRecords.length; i++) {
        if (this.allVoiceRecords[i].hasScheduledStop) {
          victimIdx = i;
          break;
        }
      }
      const victim = this.allVoiceRecords[victimIdx];
      if (victim) {
        victim.forceStop();
        const gLast = this.allVoiceRecords.length - 1;
        if (victimIdx !== gLast) this.allVoiceRecords[victimIdx] = this.allVoiceRecords[gLast];
        this.allVoiceRecords.pop();

        const vList = this.activeOscillators[victim.channel];
        if (vList) {
          const idx = vList.indexOf(victim);
          if (idx !== -1) {
            const cLast = vList.length - 1;
            if (idx !== cLast) vList[idx] = vList[cLast];
            vList.pop();
          }
        }
        const vState = this.channelStates[victim.channel];
        if (vState && vState.activeNoteCount > 0) vState.activeNoteCount--;
      }
    }
  }

  public getThroughputStats() {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const currentRate =
      nowMs - this.throughputWindowStartMs <= 1000
        ? Math.max(this.lastNotesPerSec, Math.round(this.throughputWindowCount * (1000 / Math.max(25, nowMs - this.throughputWindowStartMs))))
        : 0;
    return {
      noteInputRatePerSec: currentRate,
      peakNotesPerSec: this.peakNotesPerSec,
      activeVoices: this.allVoiceRecords.length,
      maxGlobalVoices: MAX_GLOBAL_VOICES,
      coalescedNotes: this.coalescedNotesCount
    };
  }

  public getMasterGain(): GainNode | null {
    if (!this.masterGain) this.init();
    return this.masterGain;
  }

  public getChannelGain(channelIndex: number): GainNode | null {
    if (this.channelGains.length === 0) this.init();
    if (channelIndex >= 0 && channelIndex < this.channelGains.length) {
      return this.channelGains[channelIndex];
    }
    return null;
  }

  public getChannelAnalyser(channelIndex: number): AnalyserNode | null {
    if (this.channelAnalysers.length === 0) this.init();
    if (channelIndex >= 0 && channelIndex < this.channelAnalysers.length) {
      return this.channelAnalysers[channelIndex];
    }
    return null;
  }

  public getAllChannelAnalysers(): AnalyserNode[] {
    if (this.channelAnalysers.length === 0) this.init();
    return this.channelAnalysers;
  }

  public getChannelStates(): MidiChannelState[] {
    return this.channelStates;
  }

  public isChannelMuted(channel: number): boolean {
    const ch = Math.max(0, Math.min(15, channel));
    return Boolean(this.channelStates[ch]?.isMuted);
  }

  public onChannelStateChange(listener: (states: MidiChannelState[]) => void): () => void {
    this.channelStateListeners.push(listener);
    return () => {
      this.channelStateListeners = this.channelStateListeners.filter(l => l !== listener);
    };
  }

  private notifyChannelStateListeners() {
    const copy = this.channelStates.map(s => ({ ...s }));
    this.channelStateListeners.forEach(cb => {
      try { cb(copy); } catch (e) {}
    });
  }

  public getLoadedSoundFonts(): SpessaSoundFont[] {
    return this.soundFonts;
  }

  public getActiveSoundFont(): SpessaSoundFont | undefined {
    return this.soundFonts.find(s => s.id === this.activeSoundFontId) || this.soundFonts[0];
  }

  public setActiveSoundFont(id: string) {
    if (this.soundFonts.some(s => s.id === id)) {
      this.activeSoundFontId = id;
      SpessaSynthCore.setActiveSoundFont(id);
      this.notifySoundFontListeners();
    }
  }

  public onSoundFontChange(listener: (fonts: SpessaSoundFont[], activeId: string) => void): () => void {
    this.soundFontListeners.push(listener);
    return () => {
      this.soundFontListeners = this.soundFontListeners.filter(l => l !== listener);
    };
  }

  private notifySoundFontListeners() {
    const fontsCopy = [...this.soundFonts];
    this.soundFontListeners.forEach(cb => {
      try { cb(fontsCopy, this.activeSoundFontId); } catch (e) {}
    });
  }

  private registerCoreSoundFont(coreSf: ReturnType<typeof SpessaSynthCore.parse>['soundFont']): SpessaSoundFont {
    const newSf: SpessaSoundFont = {
      id: coreSf.id,
      name: coreSf.name,
      version: coreSf.version,
      format: coreSf.format,
      instrumentCount: coreSf.instrumentCount,
      presets: coreSf.presets,
      isCustom: true
    };
    this.soundFonts = [newSf, ...this.soundFonts.filter(s => s.id !== newSf.id)];
    this.activeSoundFontId = newSf.id;
    SpessaSynthCore.setActiveSoundFont(newSf.id);
    this.notifySoundFontListeners();
    return newSf;
  }

  /**
   * Synchronous SoundFont intake parser
   * Feeds directly into spressasynth_core-master.zip and links decoded banks into spressasynth_lib-master.zip!
   */
  public loadSoundFont(arrayBuffer: ArrayBuffer, fileName = "Custom_Bank.sf2", externalCtx?: AudioContext): SpessaSoundFont {
    const ctx = this.init(externalCtx);
    const { soundFont: coreSf } = SpessaSynthCore.parse(arrayBuffer, ctx, fileName);
    return this.registerCoreSoundFont(coreSf);
  }

  /**
   * Async SoundFont intake parser (supports SF2, SF3 compressed Ogg/Vorbis, DLS, GIG, SFZ, PAT, SFPACK, etc.)
   * Feeds directly into spressasynth_core-master.zip and binds decoded sample zones into spressasynth_lib-master.zip!
   */
  public async loadSoundFontAsync(
    arrayBuffer: ArrayBuffer,
    fileName = "Custom_Bank.sf2",
    externalCtx?: AudioContext
  ) {
    const ctx = this.init(externalCtx);
    const result = await SpessaSynthCore.parseAsync(arrayBuffer, ctx, fileName);
    const soundFont = this.registerCoreSoundFont(result.soundFont);
    return {
      soundFont,
      coreResult: result
    };
  }

  public getCoreEngine(): typeof SpessaSynthCore {
    return SpessaSynthCore;
  }

  private resolveTime(atTime?: number): number {
    if (!this.audioCtx) return 0;
    if (atTime !== undefined && Number.isFinite(atTime)) {
      return Math.max(this.audioCtx.currentTime, atTime);
    }
    return this.audioCtx.currentTime;
  }

  private updateChannelGainNode(ch: number, atTime?: number) {
    const gainNode = this.channelGains[ch];
    const chState = this.channelStates[ch];
    if (!gainNode || !chState || !this.audioCtx) return;

    const targetGain = chState.isMuted
      ? 0
      : (chState.volume / 127) * ((chState.expression ?? 127) / 127) * 0.85;
    const t = this.resolveTime(atTime);
    try {
      gainNode.gain.setTargetAtTime(Math.max(0, targetGain), t, 0.006);
    } catch (e) {
      gainNode.gain.setValueAtTime(Math.max(0, targetGain), t);
    }
  }

  public noteOff(channel: number, midiNote?: number, releaseTime?: number) {
    const chIdx = Math.max(0, Math.min(15, channel));
    const list = this.activeOscillators[chIdx];
    if (!list || list.length === 0) return;

    const chState = this.channelStates[chIdx];

    // If an explicit future/scheduled MIDI NoteOff arrives while sustain pedal (CC 64) is pressed,
    // keep the matching voices sounding until the sustain pedal is lifted.
    if (releaseTime !== undefined && midiNote !== undefined && chState?.sustainPedal) {
      for (const oscRec of list) {
        if (oscRec.baseNote === midiNote && !oscRec.hasScheduledStop) {
          oscRec.pendingRelease = true;
        }
      }
      return;
    }

    if (releaseTime === undefined) {
      // Immediate/manual stop (user pressed Stop, mute, or tracker '===')
      const remaining: SpessaVoiceRecord[] = [];
      for (const oscRec of list) {
        if (midiNote === undefined || oscRec.baseNote === midiNote) {
          oscRec.forceStop();
        } else {
          remaining.push(oscRec);
        }
      }
      this.activeOscillators[chIdx] = midiNote === undefined ? [] : remaining;
      if (midiNote === undefined && chState) chState.activeNoteCount = 0;
      return;
    }

    // Scheduled lookahead MIDI NoteOff: smooth release envelope at `releaseTime`
    for (const oscRec of list) {
      if ((midiNote === undefined || oscRec.baseNote === midiNote) && !oscRec.hasScheduledStop) {
        oscRec.release(releaseTime);
      }
    }
  }

  /**
   * Synthesize a note on a specific MIDI channel (0-15)
   * Supports ultra-dense Black MIDI streams (up to 10,000+ note inputs/sec) via micro-coalescing,
   * O(1) polyphony stealing (192 global voices / 32 per channel), zero per-voice setTimeouts, and adaptive gain scaling.
   */
  public noteOn(channel: number, midiNote: number, velocity = 85, duration?: number, startTime?: number) {
    const ctx = this.init();
    if (ctx.state === "suspended") ctx.resume();

    const chIdx = Math.max(0, Math.min(15, channel));
    const chGain = this.channelGains[chIdx];
    const chState = this.channelStates[chIdx];
    if (!chGain || !chState || chState.isMuted) return;

    // Track sliding note input rate (supports 10,000+ notes/sec seamlessly)
    const perfNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (perfNow - this.throughputWindowStartMs >= 250) {
      const elapsedSec = Math.max(0.05, (perfNow - this.throughputWindowStartMs) / 1000);
      this.lastNotesPerSec = Math.round(this.throughputWindowCount / elapsedSec);
      if (this.lastNotesPerSec > this.peakNotesPerSec) {
        this.peakNotesPerSec = this.lastNotesPerSec;
      }
      this.throughputWindowStartMs = perfNow;
      this.throughputWindowCount = 0;
    }
    this.throughputWindowCount++;

    const clampedNote = Math.max(0, Math.min(127, midiNote | 0));
    const now = startTime !== undefined && Number.isFinite(startTime)
      ? Math.max(ctx.currentTime, startTime)
      : ctx.currentTime;

    // 4ms same-(channel, note) micro-coalescing prevents redundant node storms in Black MIDI bursts
    const triggerKey = (chIdx << 7) | clampedNote;
    const prevTrigger = this.lastTriggerAudioTime[triggerKey];
    if (prevTrigger > 0 && now - prevTrigger >= -0.001 && now - prevTrigger < MICRO_COALESCE_SEC) {
      this.coalescedNotesCount++;
      return;
    }
    this.lastTriggerAudioTime[triggerKey] = now;

    const isHighDensity = this.lastNotesPerSec > 240 || this.throughputWindowCount > 80 || this.allVoiceRecords.length > 64;
    this.enforcePolyphonyLimits(chIdx, isHighDensity);

    // Sqrt polyphony headroom scaling prevents distortion on massive dense chords
    const polyScale = 1 / Math.sqrt(Math.max(1, this.allVoiceRecords.length / 8));
    const bendSemitones = (chState.pitchBend / 8192) * (chState.pitchBendRange || 2);
    const targetFreq = Math.max(16, 440 * Math.pow(2, (clampedNote + bendSemitones - 69) / 12));
    const vol = Math.max(0.0005, (velocity / 127) * 0.22 * polyScale);

    // Check Portamento Glide (CC 65 & CC 84)
    const isPortamentoActive = chState.portamentoEnabled || (chState.portamentoControl !== null);
    const sourceNote = chState.portamentoControl !== null ? chState.portamentoControl : chState.lastNote;
    let startFreq = targetFreq;
    let isGliding = false;
    let glideDurationSecs = 0.05;

    if (isPortamentoActive && sourceNote !== null && sourceNote !== clampedNote) {
      startFreq = Math.max(16, 440 * Math.pow(2, (sourceNote + bendSemitones - 69) / 12));
      const pTime = chState.portamentoTime ?? 64;
      glideDurationSecs = 0.03 + (pTime / 127) * 1.57;
      isGliding = true;
    }

    chState.portamentoControl = null;
    chState.lastNote = clampedNote;

    // Check if spressasynth_core-master.zip has a real decoded SoundFont sample,
    // or use the built-in GM SoundBank PCM sample when SpessaSynth GM is active (so interpolation affects all SoundFonts).
    const activeSf = this.getActiveSoundFont();
    const coreBank = chIdx === 9 ? 128 : (chState.bank || 0);
    let resolvedSample: {
      buffer: AudioBuffer;
      rootKey: number;
      pitchCorrection: number;
      loopStart?: number;
      loopEnd?: number;
      attenuationGain: number;
    } | null = activeSf?.isCustom
      ? SpessaSynthCore.resolveSampleVoice(coreBank, chState.program, clampedNote)
      : null;

    if (!resolvedSample && activeSf?.id !== 'spessa-chiptune-sf2') {
      resolvedSample = getBuiltInSoundFontVoice(ctx, coreBank, chState.program, clampedNote);
    }

    if (resolvedSample && resolvedSample.buffer) {
      const noteGain = ctx.createGain();
      const source = ctx.createBufferSource();

      const rootPitch = resolvedSample.rootKey || 60;
      const corrSemis = (resolvedSample.pitchCorrection || 0) / 100;
      const semitoneDelta = chIdx === 9 && !activeSf?.isCustom
        ? 0
        : (clampedNote + bendSemitones - rootPitch + corrSemis);
      const rate = Math.max(0.0625, Math.min(16.0, Math.pow(2, semitoneDelta / 12)));

      const interpResult = interpolateSampleBuffer(
        ctx,
        resolvedSample.buffer,
        rate,
        getInterpolationMode(),
        resolvedSample.loopStart,
        resolvedSample.loopEnd,
        isHighDensity ? 0.75 : undefined
      );

      const usedPreInterp = interpResult.buffer !== resolvedSample.buffer;
      source.buffer = interpResult.buffer;
      source.playbackRate.setValueAtTime(interpResult.playbackRate || 1.0, now);

      if (
        interpResult.loopStart !== undefined &&
        interpResult.loopEnd !== undefined &&
        interpResult.loopEnd > interpResult.loopStart
      ) {
        source.loop = true;
        source.loopStart = interpResult.loopStart;
        source.loopEnd = interpResult.loopEnd;
      }

      const sampleVol = Math.max(0.0005, (velocity / 127) * (resolvedSample.attenuationGain ?? 1.0) * 0.30 * polyScale);
      noteGain.gain.setValueAtTime(0.0001, now);
      noteGain.gain.linearRampToValueAtTime(sampleVol, now + 0.005);

      source.connect(noteGain);
      noteGain.connect(chGain);
      source.start(now);

      const naturalDur = source.loop
        ? 24
        : Math.max(0.08, interpResult.buffer.duration / (interpResult.playbackRate || 1.0));

      const sampleVoiceRecord: SpessaVoiceRecord = {
        channel: chIdx,
        bufferSource: source,
        rootKey: rootPitch,
        pitchCorrection: resolvedSample.pitchCorrection,
        usesPreInterpolatedBuffer: usedPreInterp,
        initialPlaybackRate: interpResult.playbackRate || 1.0,
        initialBendSemitones: bendSemitones,
        noteGain,
        baseNote: clampedNote,
        subRatio: 1.0,
        startTime: now,
        stopAt: now + naturalDur + 0.1,
        hasScheduledStop: false,
        pendingRelease: false,
        isDisposed: false,
        dispose: () => {
          if (sampleVoiceRecord.isDisposed) return;
          sampleVoiceRecord.isDisposed = true;
          try {
            source.disconnect();
            noteGain.disconnect();
          } catch (e) {}
        },
        release: (releaseTime?: number) => {
          if (sampleVoiceRecord.hasScheduledStop || sampleVoiceRecord.isDisposed) return;
          sampleVoiceRecord.hasScheduledStop = true;
          sampleVoiceRecord.pendingRelease = false;

          const tReq = releaseTime !== undefined && Number.isFinite(releaseTime)
            ? releaseTime
            : ctx.currentTime;
          const minHold = isHighDensity ? 0.018 : 0.03;
          const effectiveRelease = Math.max(ctx.currentTime, sampleVoiceRecord.startTime + minHold, tReq);
          const releaseTau = chIdx === 9
            ? (isHighDensity ? 0.025 : 0.04)
            : (isHighDensity ? 0.032 : 0.06);
          const stopTail = releaseTau * 5.0;

          try {
            if (typeof noteGain.gain.cancelAndHoldAtTime === 'function') {
              noteGain.gain.cancelAndHoldAtTime(effectiveRelease);
            } else {
              noteGain.gain.cancelScheduledValues(effectiveRelease);
            }
            noteGain.gain.setTargetAtTime(0.0001, effectiveRelease, releaseTau);
            const stopAt = effectiveRelease + stopTail;
            sampleVoiceRecord.stopAt = stopAt;
            source.stop(stopAt);
          } catch (e) {
            sampleVoiceRecord.stopAt = ctx.currentTime;
          }
        },
        forceStop: () => {
          if (sampleVoiceRecord.isDisposed) return;
          const nowTime = ctx.currentTime;
          try {
            if (typeof noteGain.gain.cancelAndHoldAtTime === 'function') {
              noteGain.gain.cancelAndHoldAtTime(nowTime);
            } else {
              noteGain.gain.cancelScheduledValues(nowTime);
            }
            noteGain.gain.setTargetAtTime(0.0001, nowTime, 0.006);
            if (!sampleVoiceRecord.hasScheduledStop) {
              sampleVoiceRecord.hasScheduledStop = true;
              const stopAt = Math.max(nowTime + 0.035, sampleVoiceRecord.startTime + 0.004);
              sampleVoiceRecord.stopAt = stopAt;
              source.stop(stopAt);
            }
          } catch (e) {
            sampleVoiceRecord.stopAt = nowTime;
          }
        }
      };

      if (chIdx !== 9) {
        const existingList = this.activeOscillators[chIdx];
        for (let i = 0; i < existingList.length; i++) {
          const prev = existingList[i];
          if (prev.baseNote === clampedNote && !prev.hasScheduledStop) {
            prev.release(now);
          }
        }
      }

      this.activeOscillators[chIdx].push(sampleVoiceRecord);
      this.allVoiceRecords.push(sampleVoiceRecord);
      chState.activeNoteCount++;

      if (duration !== undefined && Number.isFinite(duration)) {
        const safeDur = Math.max(isHighDensity ? 0.03 : 0.06, duration);
        sampleVoiceRecord.release(now + safeDur);
      } else if (!source.loop) {
        // Non-looped sample: schedule stop cleanly after buffer completes (reaper cleans nodes without setTimeout)
        sampleVoiceRecord.stopAt = now + naturalDur + 0.06;
      }
      return;
    }

    // Filtered percussion fallback (never raw unfiltered sawtooth static!)
    if (chIdx === 9) {
      const osc = ctx.createOscillator();
      const subOsc = ctx.createOscillator();
      const filterNode = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      let drumLength = 0.22;

      if (clampedNote === 35 || clampedNote === 36) {
        // Punchy sub kick
        drumLength = 0.26;
        osc.type = "sine";
        subOsc.type = "triangle";
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(42, now + 0.16);
        subOsc.frequency.setValueAtTime(300, now);
        subOsc.frequency.exponentialRampToValueAtTime(42, now + 0.05);
        filterNode.type = "lowpass";
        filterNode.frequency.setValueAtTime(450, now);
        gain.gain.setValueAtTime(Math.max(0.0005, vol * 1.4), now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + drumLength);
      } else if (clampedNote === 38 || clampedNote === 40) {
        // Crisp tuned snare shell
        drumLength = 0.2;
        osc.type = "triangle";
        subOsc.type = "sine";
        osc.frequency.setValueAtTime(215, now);
        osc.frequency.exponentialRampToValueAtTime(165, now + 0.09);
        subOsc.frequency.setValueAtTime(340, now);
        filterNode.type = "bandpass";
        filterNode.frequency.setValueAtTime(1100, now);
        filterNode.Q.setValueAtTime(0.8, now);
        gain.gain.setValueAtTime(Math.max(0.0005, vol * 1.15), now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + drumLength);
      } else {
        // Clean resonant metallic/woody percussion (triangle + inharmonic triangle through narrow bandpass, zero buzz)
        const basePercFreq = 420 + (clampedNote % 24) * 55;
        drumLength = duration !== undefined ? Math.min(0.24, Math.max(0.06, duration)) : 0.14;
        osc.type = "triangle";
        subOsc.type = "triangle";
        osc.frequency.setValueAtTime(basePercFreq, now);
        subOsc.frequency.setValueAtTime(basePercFreq * 1.47, now);
        filterNode.type = "bandpass";
        filterNode.frequency.setValueAtTime(Math.min(7200, basePercFreq * 2.2), now);
        filterNode.Q.setValueAtTime(1.6, now);
        gain.gain.setValueAtTime(Math.max(0.0005, vol * 0.72), now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + drumLength);
      }

      osc.connect(filterNode);
      subOsc.connect(filterNode);
      filterNode.connect(gain);
      gain.connect(chGain);
      osc.start(now);
      subOsc.start(now);
      const stopAt = now + drumLength + 0.03;
      osc.stop(stopAt);
      subOsc.stop(stopAt);

      const drumVoiceRecord: SpessaVoiceRecord = {
        channel: chIdx,
        osc,
        subOsc,
        filterNode,
        noteGain: gain,
        baseNote: clampedNote,
        subRatio: 1.47,
        startTime: now,
        stopAt,
        hasScheduledStop: true,
        pendingRelease: false,
        isDisposed: false,
        dispose: () => {
          if (drumVoiceRecord.isDisposed) return;
          drumVoiceRecord.isDisposed = true;
          try { osc.disconnect(); subOsc.disconnect(); filterNode.disconnect(); gain.disconnect(); } catch (e) {}
        },
        release: () => {},
        forceStop: () => {
          if (drumVoiceRecord.isDisposed) return;
          const nowTime = ctx.currentTime;
          try {
            gain.gain.cancelScheduledValues(nowTime);
            gain.gain.setTargetAtTime(0.0001, nowTime, 0.005);
            osc.stop(Math.max(nowTime + 0.025, now + 0.004));
            subOsc.stop(Math.max(nowTime + 0.025, now + 0.004));
            drumVoiceRecord.stopAt = nowTime + 0.03;
          } catch (e) {}
        }
      };

      this.activeOscillators[chIdx].push(drumVoiceRecord);
      this.allVoiceRecords.push(drumVoiceRecord);
      chState.activeNoteCount++;
      return;
    }

    // Retrigger protection: if exact same MIDI note is held on this channel, release older one softly
    const existingList = this.activeOscillators[chIdx];
    for (let i = 0; i < existingList.length; i++) {
      const prev = existingList[i];
      if (prev.baseNote === clampedNote && !prev.hasScheduledStop) {
        prev.release(now);
      }
    }

    // Melodic SoundFont Voice Synthesis (fallback / spessa-chiptune-sf2)
    const program = chState.program;
    const osc = ctx.createOscillator();
    const subOsc = ctx.createOscillator();
    const noteGain = ctx.createGain();
    let subRatio = 1.0;

    if (program < 8) {
      osc.type = "triangle";
      subOsc.type = "sine";
      subRatio = 2.0;
    } else if (program >= 8 && program < 16) {
      osc.type = "sine";
      subOsc.type = "triangle";
      subRatio = 2.0;
    } else if (program >= 16 && program < 24) {
      osc.type = "triangle";
      subOsc.type = "sine";
      subRatio = 2.0;
    } else if (program >= 24 && program < 32) {
      osc.type = "sawtooth";
      subOsc.type = "triangle";
      subRatio = 0.5;
    } else if (program >= 32 && program < 40) {
      osc.type = "square";
      subOsc.type = "sine";
      subRatio = 0.5;
    } else if (program >= 40 && program < 56) {
      osc.type = "sawtooth";
      subOsc.type = "sawtooth";
      subRatio = 1.004;
    } else if (program >= 56 && program < 64) {
      osc.type = "sawtooth";
      subOsc.type = "square";
      subRatio = 1.0;
    } else if (program >= 64 && program < 80) {
      osc.type = "triangle";
      subOsc.type = "sine";
      subRatio = 1.002;
    } else {
      osc.type = "square";
      subOsc.type = "triangle";
      subRatio = 1.002;
    }

    if (isGliding && Math.abs(startFreq - targetFreq) > 1) {
      osc.frequency.setValueAtTime(startFreq, now);
      osc.frequency.exponentialRampToValueAtTime(targetFreq, now + glideDurationSecs);
      subOsc.frequency.setValueAtTime(startFreq * subRatio, now);
      subOsc.frequency.exponentialRampToValueAtTime(targetFreq * subRatio, now + glideDurationSecs);
    } else {
      osc.frequency.setValueAtTime(targetFreq, now);
      subOsc.frequency.setValueAtTime(targetFreq * subRatio, now);
    }

    const isPluckedOrStruck =
      program < 16 ||
      (program >= 24 && program < 32) ||
      program === 45 ||
      program === 46 ||
      (program >= 104 && program <= 111);

    const attackEnd = now + 0.012;
    const decayEnd = now + 0.085;
    const sustainLevel = Math.max(0.0005, vol * (isPluckedOrStruck ? 0.62 : 0.78));

    noteGain.gain.setValueAtTime(0.0001, now);
    noteGain.gain.linearRampToValueAtTime(vol, attackEnd);
    noteGain.gain.exponentialRampToValueAtTime(sustainLevel, decayEnd);

    if (isPluckedOrStruck && duration === undefined) {
      const ringFloor = Math.max(0.0005, vol * 0.14);
      noteGain.gain.setTargetAtTime(ringFloor, decayEnd + 0.005, isHighDensity ? 0.45 : 1.35);
    }

    osc.connect(noteGain);
    subOsc.connect(noteGain);
    noteGain.connect(chGain);

    osc.start(now);
    subOsc.start(now);

    const voiceRecord: SpessaVoiceRecord = {
      channel: chIdx,
      osc,
      subOsc,
      noteGain,
      baseNote: clampedNote,
      subRatio,
      startTime: now,
      stopAt: now + 24,
      hasScheduledStop: false,
      pendingRelease: false,
      isDisposed: false,
      dispose: () => {
        if (voiceRecord.isDisposed) return;
        voiceRecord.isDisposed = true;
        try {
          osc.disconnect();
          subOsc.disconnect();
          noteGain.disconnect();
        } catch (e) {}
      },
      release: (releaseTime?: number) => {
        if (voiceRecord.hasScheduledStop || voiceRecord.isDisposed) return;
        voiceRecord.hasScheduledStop = true;
        voiceRecord.pendingRelease = false;

        const tReq = releaseTime !== undefined && Number.isFinite(releaseTime)
          ? releaseTime
          : ctx.currentTime;
        const effectiveRelease = Math.max(ctx.currentTime, voiceRecord.startTime + (isHighDensity ? 0.016 : 0.028), tReq);

        const isLongRelease = !isHighDensity && ((program >= 40 && program <= 55) || (program >= 88 && program <= 95));
        const isMediumRelease = !isHighDensity && (program < 16 || (program >= 24 && program < 32));
        const releaseTau = isHighDensity ? 0.025 : isLongRelease ? 0.075 : isMediumRelease ? 0.042 : 0.03;
        const stopTail = releaseTau * 5.0;

        try {
          if (typeof noteGain.gain.cancelAndHoldAtTime === 'function') {
            noteGain.gain.cancelAndHoldAtTime(effectiveRelease);
          } else {
            noteGain.gain.cancelScheduledValues(effectiveRelease);
          }
          noteGain.gain.setTargetAtTime(0.0001, effectiveRelease, releaseTau);

          const stopAt = effectiveRelease + stopTail;
          voiceRecord.stopAt = stopAt;
          osc.stop(stopAt);
          subOsc.stop(stopAt);
        } catch (e) {
          voiceRecord.stopAt = ctx.currentTime;
        }
      },
      forceStop: () => {
        if (voiceRecord.isDisposed) return;
        const nowTime = ctx.currentTime;
        try {
          if (typeof noteGain.gain.cancelAndHoldAtTime === 'function') {
            noteGain.gain.cancelAndHoldAtTime(nowTime);
          } else {
            noteGain.gain.cancelScheduledValues(nowTime);
          }
          noteGain.gain.setTargetAtTime(0.0001, nowTime, 0.006);
          if (!voiceRecord.hasScheduledStop) {
            voiceRecord.hasScheduledStop = true;
            const stopAt = Math.max(nowTime + 0.035, voiceRecord.startTime + 0.004);
            voiceRecord.stopAt = stopAt;
            osc.stop(stopAt);
            subOsc.stop(stopAt);
          }
        } catch (e) {
          voiceRecord.stopAt = nowTime;
        }
      }
    };

    this.activeOscillators[chIdx].push(voiceRecord);
    this.allVoiceRecords.push(voiceRecord);
    chState.activeNoteCount++;

    if (duration !== undefined && Number.isFinite(duration)) {
      const safeDur = Math.max(isHighDensity ? 0.03 : 0.05, duration);
      voiceRecord.release(now + safeDur);
    }
  }

  /**
   * Full Standard MIDI File (.mid / .midi) playback through SpessaSynth's 16 channels
   */
  public playMidi(arrayBuffer: ArrayBuffer, onEnded?: () => void, startDelaySec = 0.10) {
    this.stopMidi();
    const ctx = this.init();
    if (ctx.state === "suspended") ctx.resume();

    this.isPlaying = true;

    try {
      const u8 = new Uint8Array(arrayBuffer);
      const view = new DataView(arrayBuffer);

      if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "MThd") {
        throw new Error("Invalid MIDI Header");
      }

      const headerLen = view.getUint32(4, false);
      const trackCount = view.getUint16(10, false);
      const ppq = view.getUint16(12, false) || 480;

      let offset = 8 + headerLen;
      let currentBpm = 120;

      interface TimedEvent {
        tick: number;
        channel: number;
        type: number;
        note: number;
        velocity: number;
      }
      const events: TimedEvent[] = [];

      for (let t = 0; t < trackCount && offset + 8 <= u8.length; t++) {
        const chunkType = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
        const chunkLen = view.getUint32(offset + 4, false);
        let tOffset = offset + 8;
        const tEnd = Math.min(tOffset + chunkLen, u8.length);

        if (chunkType === "MTrk") {
          let absTick = 0;
          let runningStatus = 0;

          while (tOffset < tEnd) {
            let delta = 0;
            while (tOffset < tEnd) {
              const b = u8[tOffset++];
              delta = (delta << 7) | (b & 0x7F);
              if (!(b & 0x80)) break;
            }
            absTick += delta;
            if (tOffset >= tEnd) break;

            let status = u8[tOffset++];
            if (!(status & 0x80)) {
              status = runningStatus;
              tOffset--;
            } else {
              runningStatus = status;
            }

            const evtType = status & 0xF0;
            const ch = status & 0x0F;

            if (evtType === 0x90) { // Note On / Note Off (vel 0)
              const note = u8[tOffset++];
              const vel = u8[tOffset++];
              events.push({ tick: absTick, channel: ch, type: vel > 0 ? 0x90 : 0x80, note, velocity: vel });
            } else if (evtType === 0x80) { // Note Off
              const note = u8[tOffset++];
              tOffset++; // skip off velocity
              events.push({ tick: absTick, channel: ch, type: 0x80, note, velocity: 0 });
            } else if (evtType === 0xC0) { // Program Change
              const p = u8[tOffset++];
              events.push({ tick: absTick, channel: ch, type: 0xC0, note: p, velocity: 0 });
            } else if (evtType === 0xB0) { // Control Change
              const cc = u8[tOffset++];
              const val = u8[tOffset++];
              events.push({ tick: absTick, channel: ch, type: 0xB0, note: cc, velocity: val });
            } else if (evtType === 0xE0) { // Pitch Bend
              const lsb = u8[tOffset++];
              const msb = u8[tOffset++];
              events.push({ tick: absTick, channel: ch, type: 0xE0, note: lsb, velocity: msb });
            } else if (evtType === 0xA0 || evtType === 0xD0) {
              tOffset += evtType === 0xA0 ? 2 : 1;
            } else if (status === 0xFF) { // Meta Event
              const metaType = u8[tOffset++];
              let metaLen = 0;
              while (tOffset < tEnd) {
                const b = u8[tOffset++];
                metaLen = (metaLen << 7) | (b & 0x7F);
                if (!(b & 0x80)) break;
              }
              if (metaType === 0x51 && metaLen === 3) {
                const microseconds = (u8[tOffset] << 16) | (u8[tOffset + 1] << 8) | u8[tOffset + 2];
                if (microseconds > 0) currentBpm = Math.round(60000000 / microseconds);
              }
              tOffset += metaLen;
            } else if (status === 0xF0 || status === 0xF7) {
              let syxLen = 0;
              while (tOffset < tEnd) {
                const b = u8[tOffset++];
                syxLen = (syxLen << 7) | (b & 0x7F);
                if (!(b & 0x80)) break;
              }
              tOffset += syxLen;
            }
          }
        }
        offset += 8 + chunkLen;
      }

      events.sort((a, b) => a.tick - b.tick);

      const secondsPerTick = 60 / (currentBpm * ppq);
      let lastTick = 0;

      events.forEach(ev => {
        const timeSec = startDelaySec + (ev.tick * secondsPerTick);
        if (ev.tick > lastTick) lastTick = ev.tick;

        const timerId = setTimeout(() => {
          if (!this.isPlaying) return;

          if (ev.type === 0x90) {
            this.noteOn(ev.channel, ev.note, ev.velocity, undefined, ctx.currentTime);
          } else if (ev.type === 0x80) {
            this.noteOff(ev.channel, ev.note, ctx.currentTime);
          } else if (ev.type === 0xC0) {
            this.setChannelProgram(ev.channel, ev.note);
          } else if (ev.type === 0xB0) {
            if (ev.note === 7) this.setChannelVolume(ev.channel, ev.velocity, ctx.currentTime);
            else if (ev.note === 10) this.setChannelPan(ev.channel, ev.velocity, ctx.currentTime);
            else if (ev.note === 11) this.setChannelExpression(ev.channel, ev.velocity, ctx.currentTime);
            else if (ev.note === 64) this.setChannelSustain(ev.channel, ev.velocity >= 64, ctx.currentTime);
          } else if (ev.type === 0xE0) {
            const bend = ((ev.velocity << 7) | ev.note) - 8192;
            this.setChannelPitchBend(ev.channel, bend, ctx.currentTime);
          }
        }, timeSec * 1000);

        this.playbackTimeoutIds.push(timerId);
      });

      const totalDurationSec = startDelaySec + (lastTick * secondsPerTick);
      const endTimer = setTimeout(() => {
        if (this.isPlaying) {
          this.isPlaying = false;
          this.allNotesOff();
          onEnded?.();
        }
      }, (totalDurationSec + 0.5) * 1000);
      this.playbackTimeoutIds.push(endTimer);

    } catch (e) {
      console.log("SpessaSynth MIDI playback failed:", e);
      this.isPlaying = false;
    }
  }

  public stopMidi() {
    this.isPlaying = false;
    this.playbackTimeoutIds.forEach(id => clearTimeout(id));
    this.playbackTimeoutIds = [];
    this.allNotesOff();
  }

  public isMidiPlaying(): boolean {
    return this.isPlaying;
  }

  // --- MIDI CONTROLLER CHANNEL CONFIGURATION & CC METHODS ---

  public setChannelVolume(channel: number, volume: number, atTime?: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const vol = Math.max(0, Math.min(127, volume));
    if (this.channelStates[ch]) {
      this.channelStates[ch].volume = vol;
    }
    this.updateChannelGainNode(ch, atTime);
  }

  public setChannelExpression(channel: number, expression: number, atTime?: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const expr = Math.max(0, Math.min(127, expression));
    if (this.channelStates[ch]) {
      this.channelStates[ch].expression = expr;
    }
    this.updateChannelGainNode(ch, atTime);
  }

  public setChannelSustain(channel: number, active: boolean, atTime?: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const chState = this.channelStates[ch];
    if (!chState) return;
    chState.sustainPedal = active;

    if (!active) {
      const releaseTime = this.resolveTime(atTime);
      const list = this.activeOscillators[ch] || [];
      for (const oscRec of list) {
        if (oscRec.pendingRelease && !oscRec.hasScheduledStop) {
          oscRec.release(releaseTime);
        }
      }
    }
  }

  public setChannelPan(channel: number, pan: number, atTime?: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const p = Math.max(0, Math.min(127, pan));
    if (this.channelStates[ch]) {
      this.channelStates[ch].pan = p;
    }
    if (this.channelPanners[ch] && this.audioCtx) {
      const panRatio = (p - 64) / 64;
      const t = this.resolveTime(atTime);
      this.channelPanners[ch].pan.setValueAtTime(Math.max(-1.0, Math.min(1.0, panRatio)), t);
    }
  }

  public setChannelBank(channel: number, bank: number) {
    const ch = Math.max(0, Math.min(15, channel));
    if (this.channelStates[ch]) {
      this.channelStates[ch].bank = Math.max(0, Math.min(128, bank));
    }
  }

  public setChannelProgram(channel: number, program: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const prog = Math.max(0, Math.min(127, program));
    if (this.channelStates[ch]) {
      this.channelStates[ch].program = prog;
      this.channelStates[ch].programName = ch === 9 
        ? "GM Standard Drum Kit" 
        : (DEFAULT_GM_PROGRAMS[prog] || `Program ${prog}`);
    }
  }

  public setChannelMute(channel: number, isMuted: boolean) {
    const ch = Math.max(0, Math.min(15, channel));
    if (this.channelStates[ch]) {
      this.channelStates[ch].isMuted = isMuted;
    }
    if (isMuted) {
      this.noteOff(ch);
    }
    this.updateChannelGainNode(ch);
    this.notifyChannelStateListeners();
  }

  public setChannelPitchBend(channel: number, bend: number, atTime?: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const clampedBend = Math.max(-8192, Math.min(8191, bend));
    if (this.channelStates[ch]) {
      this.channelStates[ch].pitchBend = clampedBend;
      const range = this.channelStates[ch].pitchBendRange || 2;
      const bendSemitones = (clampedBend / 8192) * range;
      const t = this.resolveTime(atTime);

      (this.activeOscillators[ch] || []).forEach(v => {
        try {
          if (v.osc) {
            const newFreq = Math.max(16, 440 * Math.pow(2, (v.baseNote + bendSemitones - 69) / 12));
            v.osc.frequency.setTargetAtTime(newFreq, t, 0.008);
            if (v.subOsc) {
              v.subOsc.frequency.setTargetAtTime(newFreq * v.subRatio, t, 0.008);
            }
          } else if (v.bufferSource) {
            if (v.usesPreInterpolatedBuffer) {
              const bendDelta = bendSemitones - (v.initialBendSemitones ?? 0);
              const baseRate = v.initialPlaybackRate ?? 1.0;
              const newRate = Math.max(0.0625, Math.min(16.0, baseRate * Math.pow(2, bendDelta / 12)));
              v.bufferSource.playbackRate.setTargetAtTime(newRate, t, 0.008);
            } else {
              const rootPitch = v.rootKey ?? 60;
              const corrSemis = (v.pitchCorrection ?? 0) / 100;
              const newRate = Math.max(0.0625, Math.min(16.0, Math.pow(2, (v.baseNote + bendSemitones - rootPitch + corrSemis) / 12)));
              v.bufferSource.playbackRate.setTargetAtTime(newRate, t, 0.008);
            }
          }
        } catch (e) {}
      });
    }
  }

  public setChannelPitchBendRange(channel: number, semitones: number) {
    const ch = Math.max(0, Math.min(15, channel));
    if (this.channelStates[ch]) {
      this.channelStates[ch].pitchBendRange = Math.max(1, Math.min(24, semitones));
    }
  }

  public setChannelPortamento(channel: number, enabled: boolean) {
    const ch = Math.max(0, Math.min(15, channel));
    if (this.channelStates[ch]) {
      this.channelStates[ch].portamentoEnabled = enabled;
    }
  }

  public setChannelPortamentoTime(channel: number, time: number) {
    const ch = Math.max(0, Math.min(15, channel));
    if (this.channelStates[ch]) {
      this.channelStates[ch].portamentoTime = Math.max(0, Math.min(127, time));
    }
  }

  public setChannelPortamentoControl(channel: number, sourceNote: number | null) {
    const ch = Math.max(0, Math.min(15, channel));
    if (this.channelStates[ch]) {
      this.channelStates[ch].portamentoControl = sourceNote !== null ? Math.max(0, Math.min(127, sourceNote)) : null;
    }
  }

  public resetChannelControllers(channel: number, atTime?: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const chState = this.channelStates[ch];
    if (!chState) return;
    chState.expression = 127;
    chState.pitchBend = 0;
    chState.portamentoEnabled = false;
    chState.portamentoControl = null;
    this.setChannelSustain(ch, false, atTime);
    this.updateChannelGainNode(ch, atTime);
  }

  public triggerPortamentoGlideTest(channel = 0, startNote = 48, endNote = 67) {
    this.setChannelPortamento(channel, true);
    this.noteOn(channel, startNote, 95, 0.28);
    setTimeout(() => {
      this.noteOn(channel, endNote, 100, 0.65);
    }, 130);
  }

  public allNotesOff(channel?: number, atTime?: number) {
    if (channel !== undefined) {
      this.noteOff(channel, undefined, atTime);
      return;
    }
    for (let i = 0; i < this.allVoiceRecords.length; i++) {
      try { this.allVoiceRecords[i].forceStop(); } catch (e) {}
    }
    this.lastTriggerAudioTime.fill(0);
    this.channelStates.forEach(ch => {
      ch.activeNoteCount = 0;
      ch.sustainPedal = false;
    });
    for (let i = 0; i < 16; i++) {
      this.noteOff(i);
    }
    // Schedule immediate node cleanup after quick fade-out
    setTimeout(() => {
      this.reapExpiredVoices();
    }, 70);
  }

  public allSoundOff() {
    this.allNotesOff();
    if (this.channelGains.length > 0 && this.audioCtx) {
      for (let i = 0; i < 16; i++) {
        this.channelGains[i]?.gain.setValueAtTime(0, this.audioCtx.currentTime);
      }
      setTimeout(() => {
        if (!this.audioCtx) return;
        for (let i = 0; i < 16; i++) {
          this.updateChannelGainNode(i);
        }
      }, 50);
    }
  }

  /**
   * General MIDI (GM) System Reset
   * Standard MIDI message: resets all controllers, programs, pitch bends, and centers pan
   */
  public sendGMReset(preserveMute = false): { message: string; timestamp: number } {
    this.allNotesOff();
    for (let i = 0; i < 16; i++) {
      const defProg = i === 9 ? 0 : i % 8;
      const wasMuted = preserveMute ? Boolean(this.channelStates[i]?.isMuted) : false;
      this.channelStates[i] = {
        index: i,
        bank: i === 9 ? 128 : 0,
        program: defProg,
        programName: i === 9 ? "GM Standard Drum Kit" : (DEFAULT_GM_PROGRAMS[defProg] || `Program ${defProg}`),
        volume: 100,
        expression: 127,
        pan: 64,
        pitchBend: 0,
        sustainPedal: false,
        isMuted: wasMuted,
        activeNoteCount: 0,
        pitchBendRange: 2,
        portamentoEnabled: false,
        portamentoTime: 64,
        portamentoControl: null,
        lastNote: null
      };
      this.setChannelVolume(i, 100);
      this.setChannelPan(i, 64);
      this.updateChannelGainNode(i);
    }
    this.notifyChannelStateListeners();
    return {
      message: "GM Reset: Sent SysEx F0 7E 7F 09 01 F7 + Controller Reset (CC 121 / 123)",
      timestamp: Date.now()
    };
  }

  /**
   * Roland GS System Reset
   * Emulates Roland GS SysEx (F0 41 10 42 12 40 00 7F 00 41 F7)
   */
  public sendGSReset(): { message: string; timestamp: number } {
    this.allNotesOff();
    for (let i = 0; i < 16; i++) {
      const defProg = 0;
      this.channelStates[i].bank = i === 9 ? 128 : 0;
      this.channelStates[i].program = defProg;
      this.channelStates[i].programName = i === 9 ? "GS Standard Drum Kit" : (DEFAULT_GM_PROGRAMS[defProg] || `Program ${defProg}`);
      this.channelStates[i].volume = 100;
      this.channelStates[i].expression = 127;
      this.channelStates[i].pan = 64;
      this.channelStates[i].pitchBend = 0;
      this.channelStates[i].sustainPedal = false;
      this.channelStates[i].pitchBendRange = 2;
      this.channelStates[i].portamentoEnabled = false;
      this.channelStates[i].portamentoTime = 64;
      this.channelStates[i].portamentoControl = null;
      this.channelStates[i].lastNote = null;
      this.channelStates[i].isMuted = false;
      this.setChannelVolume(i, 100);
      this.setChannelPan(i, 64);
    }
    this.notifyChannelStateListeners();
    return {
      message: "GS Reset: Sent SysEx F0 41 10 42 12 40 00 7F 00 41 F7 (Roland GS Mode)",
      timestamp: Date.now()
    };
  }

  /**
   * Yamaha XG System Reset
   * Emulates Yamaha XG SysEx (F0 43 10 4C 00 00 7E 00 F7)
   */
  public sendXGReset(): { message: string; timestamp: number } {
    this.allNotesOff();
    for (let i = 0; i < 16; i++) {
      this.channelStates[i].bank = i === 9 ? 128 : 0;
      this.channelStates[i].volume = 100;
      this.channelStates[i].expression = 127;
      this.channelStates[i].pan = 64;
      this.channelStates[i].pitchBend = 0;
      this.channelStates[i].sustainPedal = false;
      this.channelStates[i].isMuted = false;
      this.setChannelVolume(i, 100);
      this.setChannelPan(i, 64);
    }
    this.notifyChannelStateListeners();
    return {
      message: "XG Reset: Sent SysEx F0 43 10 4C 00 00 7E 00 F7 (Yamaha XG Mode)",
      timestamp: Date.now()
    };
  }

  /**
   * General MIDI 2 (GM2) System Reset
   */
  public sendGM2Reset(): { message: string; timestamp: number } {
    this.allNotesOff();
    for (let i = 0; i < 16; i++) {
      this.channelStates[i].bank = i === 9 ? 128 : 0;
      this.channelStates[i].expression = 127;
      this.channelStates[i].sustainPedal = false;
      this.channelStates[i].pitchBend = 0;
      this.setChannelVolume(i, 100);
      this.setChannelPan(i, 64);
    }
    this.notifyChannelStateListeners();
    return {
      message: "GM2 Reset: Sent SysEx F0 7E 7F 09 03 F7 (GM Level 2 Mode)",
      timestamp: Date.now()
    };
  }
}

// Global Singleton for SpessaSynth
export const SpessaSynth = new SpessaSynthEngine();
