/**
 * SpessaSynth WorkletSynthesizer Bridge (spessasynth_lib v4.4.8)
 *
 * Manages the singleton WorkletSynthesizer running inside Web Audio's AudioWorklet
 * thread (`/spessasynth_processor.min.js`) with:
 * - Full 16-channel MIDI Matrix (plus expanded channels 16–47 for Aria48's 48 tracks)
 * - Automatic initialization (`await synth.isReady`) & fallback SF2 via BasicSoundBank
 * - Two-way UI synchronization via `synth.eventHandler`
 * - Native CC control (0–127), individual CC Lock (including 128 = Preset/Program Lock),
 *   Drums toggle, Mute & Solo, Pitch Wheel (-8192..8191 + RPN 0 range 0–24),
 *   Velocity Curve / Sensitivity (GS/XG SysEx + software shaping), Pedals,
 *   GS/XG Tone Shaping / Envelopes / Vibrato / Effects, and GM/GS/XG SysEx Resets.
 */

import { Sequencer, WorkletSynthesizer } from 'spessasynth_lib';
import {
  BasicMIDI,
  BasicSoundBank,
  InterpolationTypes,
  MIDIController,
  MIDIPatchFull,
  SoundBankLoader
} from 'spessasynth_core';
import { SoundFontInterpolationMode } from '../types';
import { DEFAULT_GM_PROGRAMS } from './spressasynthLib';
import { getInterpolationMode } from './soundFontInterpolation';

export type VelocityCurveType = 'linear' | 'soft' | 'hard' | 'fixed';

export interface SequenceSamplePresetInfo {
  name: string;
  bankMSB: number;
  bankLSB: number;
  program: number;
  isDrum: boolean;
}

export interface LoadedSequenceMetadata {
  fileName: string;
  title: string;
  format: string;
  isTrackerConverted: boolean;
  patternCount: number;
  rowCount: number;
  activeChannels: number[]; // 0-indexed MIDI channels
  samplePresets: SequenceSamplePresetInfo[];
  hasEmbeddedSoundBank: boolean;
  durationSeconds: number;
  bpm: number;
  tracksCount: number;
}

export interface WebMidiPortInfo {
  id: string;
  name: string;
  manufacturer: string;
  state: string;
  connection: string;
}

export interface WebMidiState {
  supported: boolean;
  status: 'uninitialized' | 'ready' | 'blocked' | 'unsupported';
  sysexEnabled: boolean;
  sandboxBlocked: boolean;
  errorMessage: string | null;
  inputs: WebMidiPortInfo[];
  outputs: WebMidiPortInfo[];
  selectedInputId: string;
  selectedOutputId: string;
  midiThruEnabled: boolean;
  inputChannelFilter: 'all' | number; // 'all' or 0..15 (MIDI CH 1-16)
  midiOutEnabled: boolean;
  muteInternalOnMidiOut: boolean;
  lastInputActivity: string | null;
  lastOutputActivity: string | null;
}

export interface WorkletChannelMixerState {
  channel: number;
  bankMSB: number;
  bankLSB: number;
  program: number;
  patchName: string;
  isDrum: boolean;
  isMuted: boolean;
  isSolo: boolean;
  presetLocked: boolean;
  pitchWheel: number;       // Signed -8192 to 8191 (0 = center)
  pitchWheelRange: number;  // Semitones 0 to 24
  pitchWheelLocked: boolean;
  velocityCurve: VelocityCurveType;
  velocityDepth: number;    // 0 to 127 (64 = normal)
  velocityOffset: number;   // 0 to 127 (64 = normal)
  cc: Record<number, number>;
  lockedCCs: Record<number, boolean>;
  activeNotes: number[];
  voiceCount: number;
}

export const WORKLET_CC = {
  BANK_MSB: 0,
  MOD_WHEEL: 1,
  PORTAMENTO_TIME: 5,
  VOLUME: 7,
  PAN: 10,
  EXPRESSION: 11,
  BANK_LSB: 32,
  SUSTAIN: 64,
  PORTAMENTO_ON: 65,
  SOSTENUTO: 66,
  SOFT_PEDAL: 67,
  RESONANCE: 71,
  RELEASE_TIME: 72,
  ATTACK_TIME: 73,
  CUTOFF: 74,
  DECAY_TIME: 75,
  VIBRATO_RATE: 76,
  VIBRATO_DEPTH: 77,
  VIBRATO_DELAY: 78,
  PORTAMENTO_CTRL: 84,
  REVERB: 91,
  CHORUS: 93,
  DELAY_VARIATION: 94,
  ALL_SOUND_OFF: 120,
  RESET_ALL_CONTROLLERS: 121,
  ALL_NOTES_OFF: 123,
  PRESET_LOCK_VIRTUAL: 128
} as const;

export const LOCKABLE_MIXER_CCS: number[] = [
  WORKLET_CC.MOD_WHEEL,
  WORKLET_CC.PORTAMENTO_TIME,
  WORKLET_CC.VOLUME,
  WORKLET_CC.PAN,
  WORKLET_CC.EXPRESSION,
  WORKLET_CC.SUSTAIN,
  WORKLET_CC.PORTAMENTO_ON,
  WORKLET_CC.SOSTENUTO,
  WORKLET_CC.SOFT_PEDAL,
  WORKLET_CC.RESONANCE,
  WORKLET_CC.RELEASE_TIME,
  WORKLET_CC.ATTACK_TIME,
  WORKLET_CC.CUTOFF,
  WORKLET_CC.DECAY_TIME,
  WORKLET_CC.VIBRATO_RATE,
  WORKLET_CC.VIBRATO_DEPTH,
  WORKLET_CC.VIBRATO_DELAY,
  WORKLET_CC.PORTAMENTO_CTRL,
  WORKLET_CC.REVERB,
  WORKLET_CC.CHORUS,
  WORKLET_CC.DELAY_VARIATION
];

const DEFAULT_CC_VALUES: Record<number, number> = {
  [WORKLET_CC.MOD_WHEEL]: 0,
  [WORKLET_CC.PORTAMENTO_TIME]: 0,
  [WORKLET_CC.VOLUME]: 100,
  [WORKLET_CC.PAN]: 64,
  [WORKLET_CC.EXPRESSION]: 127,
  [WORKLET_CC.SUSTAIN]: 0,
  [WORKLET_CC.PORTAMENTO_ON]: 0,
  [WORKLET_CC.SOSTENUTO]: 0,
  [WORKLET_CC.SOFT_PEDAL]: 0,
  [WORKLET_CC.RESONANCE]: 64,
  [WORKLET_CC.RELEASE_TIME]: 64,
  [WORKLET_CC.ATTACK_TIME]: 64,
  [WORKLET_CC.CUTOFF]: 64,
  [WORKLET_CC.DECAY_TIME]: 64,
  [WORKLET_CC.VIBRATO_RATE]: 64,
  [WORKLET_CC.VIBRATO_DEPTH]: 64,
  [WORKLET_CC.VIBRATO_DELAY]: 64,
  [WORKLET_CC.PORTAMENTO_CTRL]: 60,
  [WORKLET_CC.REVERB]: 40,
  [WORKLET_CC.CHORUS]: 0,
  [WORKLET_CC.DELAY_VARIATION]: 0
};

function createDefaultChannelState(ch: number): WorkletChannelMixerState {
  const isDrum = ch % 16 === 9;
  const program = isDrum ? 0 : (ch % 8);
  return {
    channel: ch,
    bankMSB: isDrum ? 128 : 0,
    bankLSB: 0,
    program,
    patchName: isDrum ? 'Standard Drum Kit' : (DEFAULT_GM_PROGRAMS[program] || `Program ${program}`),
    isDrum,
    isMuted: false,
    isSolo: false,
    presetLocked: false,
    pitchWheel: 0,
    pitchWheelRange: 2,
    pitchWheelLocked: false,
    velocityCurve: 'linear',
    velocityDepth: 64,
    velocityOffset: 64,
    cc: { ...DEFAULT_CC_VALUES },
    lockedCCs: {},
    activeNotes: [],
    voiceCount: 0
  };
}

function channelToGSPart(ch: number): number {
  const c = ch % 16;
  if (c === 9) return 0;
  if (c < 9) return c + 1;
  return c;
}

const PRIMARY_WORKLET_BANK_ID = 'aria-active-bank';
export const SPESSASYNTH_PROCESSOR_CDN_URL =
  'https://cdn.jsdelivr.net/npm/spessasynth_lib@4.4.9/dist/spessasynth_processor.min.js';

function isWorkletSupportedSoundBank(buf: ArrayBuffer, idOrName = ''): boolean {
  if (!buf || buf.byteLength < 12) return false;
  const u8 = new Uint8Array(buf, 0, 12);
  // RIFF (SF2, SF3, DLS, SFe RIFF....sfen) or RIFS (64-bit SFe / SF2)
  const isRiff = u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46;
  const isRifs = u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x53;
  if (isRiff || isRifs) return true;
  const lower = idOrName.toLowerCase();
  if (lower.endsWith('.sfe') || lower.endsWith('.sf2') || lower.endsWith('.sf3') || lower.endsWith('.dls')) {
    return true;
  }
  try {
    const parsed = SoundBankLoader.fromArrayBuffer(buf.slice(0));
    return Boolean(parsed && parsed.presets && parsed.presets.length > 0);
  } catch {
    return false;
  }
}

async function addWorkletModuleWithCdnFallback(ctx: AudioContext): Promise<void> {
  try {
    await ctx.audioWorklet.addModule('/spessasynth_processor.min.js');
    return;
  } catch {
    // Fallback to matching jsDelivr CDN build
  }
  const resp = await fetch(SPESSASYNTH_PROCESSOR_CDN_URL, { mode: 'cors' });
  if (!resp.ok) {
    throw new Error(`Failed to load SpessaSynth processor (${resp.status})`);
  }
  const code = await resp.text();
  if (!code || code.length < 1024) {
    throw new Error('Empty SpessaSynth processor script');
  }
  const blobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(blobUrl);
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }
}

class WorkletSynthController {
  private audioCtx: AudioContext | null = null;
  private synth: WorkletSynthesizer | null = null;
  private initPromise: Promise<WorkletSynthesizer | null> | null = null;
  private registeredContexts = new WeakSet<BaseAudioContext>();
  private workletReady = false;
  private requestedChannelCount = 16;
  private defaultBankLoaded = false;
  private customBanksLoaded = new Set<string>();
  private soundBankBuffers = new Map<string, ArrayBuffer>();
  private activeBankId: string = 'aria-default-bank';
  private activeBankSupportedByWorklet = true;
  private isReplacingSoundBank = false;
  private bankSwitchGen = 0;
  private bankSwitchQueue: Promise<void> = Promise.resolve();

  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private silentVizSink: GainNode | null = null;
  private channelAnalysers: AnalyserNode[] = [];

  private channelStates: WorkletChannelMixerState[] = Array.from({ length: 48 }, (_, i) =>
    createDefaultChannelState(i)
  );
  private preSoloMutes: boolean[] | null = null;
  private presetList: MIDIPatchFull[] = [];
  private listeners = new Set<() => void>();
  private logListeners = new Set<(msg: string) => void>();
  private targetMasterGainValue = 0.85;

  // Sequencer & BasicMIDI state
  private sequencer: Sequencer | null = null;
  private currentBasicMIDI: BasicMIDI | null = null;
  private currentOriginalFileName = '';
  private currentSequenceBuffer: ArrayBuffer | null = null;
  private currentSequenceMetadata: LoadedSequenceMetadata | null = null;
  private sequencerPlaying = false;
  private sequencerEndedCallback: (() => void) | null = null;
  private sequencerWatchdogTimer: any = null;
  private loadedSequencerKey = '';

  // Web MIDI Input/Output state
  private midiAccess: MIDIAccess | null = null;
  private midiInitPromise: Promise<WebMidiState> | null = null;
  private attachedMidiInput: MIDIInput | null = null;
  private boundOutputProxy: { send: (data: number[]) => void } | null = null;
  private webMidiState: WebMidiState = {
    supported: typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function',
    status: 'uninitialized',
    sysexEnabled: false,
    sandboxBlocked: false,
    errorMessage: null,
    inputs: [],
    outputs: [],
    selectedInputId: '',
    selectedOutputId: '',
    midiThruEnabled: true,
    inputChannelFilter: 'all',
    midiOutEnabled: false,
    muteInternalOnMidiOut: false,
    lastInputActivity: null,
    lastOutputActivity: null
  };

  public getSynth(): WorkletSynthesizer | null {
    return this.synth;
  }

  public getSequencer(): Sequencer | null {
    return this.sequencer;
  }

  public getCurrentBasicMIDI(): BasicMIDI | null {
    return this.currentBasicMIDI;
  }

  public getCurrentOriginalFileName(): string {
    return this.currentOriginalFileName;
  }

  public getSequenceMetadata(): LoadedSequenceMetadata | null {
    return this.currentSequenceMetadata;
  }

  public getWebMidiState(): WebMidiState {
    return {
      ...this.webMidiState,
      inputs: [...this.webMidiState.inputs],
      outputs: [...this.webMidiState.outputs]
    };
  }

  public isReadySync(): boolean {
    return Boolean(this.synth && this.workletReady);
  }

  public hasSoundBankReady(): boolean {
    return Boolean(
      this.synth &&
      this.workletReady &&
      this.activeBankSupportedByWorklet &&
      (this.defaultBankLoaded || this.customBanksLoaded.size > 0)
    );
  }

  public hasCustomSoundBankActive(): boolean {
    return Boolean(
      this.synth &&
      this.workletReady &&
      this.activeBankSupportedByWorklet &&
      this.customBanksLoaded.size > 0 &&
      this.activeBankId !== 'aria-default-bank' &&
      this.activeBankId !== 'spessa-default-gm' &&
      this.activeBankId !== 'spessa-chiptune-sf2'
    );
  }

  public isActiveBankSupportedByWorklet(): boolean {
    return this.activeBankSupportedByWorklet;
  }

  public getPresetList(): MIDIPatchFull[] {
    if (this.presetList.length > 0) return this.presetList;
    if (this.synth?.presetList && this.synth.presetList.length > 0) {
      return this.synth.presetList;
    }
    return [];
  }

  public getChannelStates(limit = 16): WorkletChannelMixerState[] {
    return this.channelStates.slice(0, limit).map(s => ({
      ...s,
      cc: { ...s.cc },
      lockedCCs: { ...s.lockedCCs },
      activeNotes: [...s.activeNotes]
    }));
  }

  public getChannelState(ch: number): WorkletChannelMixerState {
    const idx = Math.max(0, Math.min(47, Math.floor(ch)));
    const s = this.channelStates[idx] || createDefaultChannelState(idx);
    return {
      ...s,
      cc: { ...s.cc },
      lockedCCs: { ...s.lockedCCs },
      activeNotes: [...s.activeNotes]
    };
  }

  public getChannelAnalyser(channelIndex: number): AnalyserNode | null {
    const idx = Math.max(0, Math.min(15, Math.floor(channelIndex)));
    return this.channelAnalysers[idx] || null;
  }

  public isChannelMuted(ch: number): boolean {
    const idx = Math.max(0, Math.min(47, Math.floor(ch)));
    return Boolean(this.channelStates[idx]?.isMuted);
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public onLog(listener: (msg: string) => void): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  private emitLog(msg: string) {
    this.logListeners.forEach(cb => {
      try { cb(msg); } catch {}
    });
  }

  private notifyListeners() {
    this.listeners.forEach(cb => {
      try { cb(); } catch {}
    });
  }

  public setMasterVolumeGain(gainValue: number) {
    this.targetMasterGainValue = Math.max(0, Math.min(1.5, gainValue));
    this.applyInternalSynthMuteState();
  }

  private applyInternalSynthMuteState() {
    if (!this.masterGain || !this.audioCtx) return;
    const shouldSilence = this.webMidiState.midiOutEnabled && this.webMidiState.muteInternalOnMidiOut;
    const effective = shouldSilence ? 0 : this.targetMasterGainValue;
    try {
      this.masterGain.gain.setTargetAtTime(effective, this.audioCtx.currentTime, 0.01);
    } catch {
      this.masterGain.gain.value = effective;
    }
  }

  public connectRecordingDestination(dest: AudioNode) {
    try {
      this.limiter?.connect(dest);
    } catch {}
  }

  public disconnectRecordingDestination(dest: AudioNode) {
    try {
      this.limiter?.disconnect(dest);
    } catch {}
  }

  public async init(externalCtx?: AudioContext): Promise<WorkletSynthesizer | null> {
    if (typeof window === 'undefined') return null;

    if (!this.audioCtx) {
      if (externalCtx) {
        this.audioCtx = externalCtx;
      } else {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioContextClass) {
          this.audioCtx = new AudioContextClass();
        }
      }
    }

    const ctx = this.audioCtx;
    if (!ctx || !ctx.audioWorklet) return null;

    if (this.synth && this.workletReady) return this.synth;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        if (!this.registeredContexts.has(ctx)) {
          await addWorkletModuleWithCdnFallback(ctx);
          this.registeredContexts.add(ctx);
        }

        const synth = new WorkletSynthesizer(ctx, {
          eventsEnabled: true,
          convolverMode: false
        });
        this.synth = synth;
        this.requestedChannelCount = synth.midiChannels.length || 16;

        // Attach two-way synchronization listeners immediately
        this.attachSynthEventHandlers(synth);

        // Setup master audio graph + isolated per-channel analysers (zero double-summing)
        this.setupAudioRouting(ctx, synth);

        // Wait until core processor inside AudioWorklet completes initialization
        await synth.isReady;
        this.workletReady = true;

        // Expand up to 48 channels when needed for Aria48 tracker
        this.ensureChannelCount(48);

        // Load single active bank slot with built-in SF2 bank so no SoundFonts ever mix presets
        try {
          const defaultBankBuffer = BasicSoundBank.getSampleSoundBankFile().slice(0);
          this.soundBankBuffers.set('aria-default-bank', defaultBankBuffer.slice(0));
          await synth.soundBankManager.addSoundBank(defaultBankBuffer, PRIMARY_WORKLET_BANK_ID, 0);
          this.defaultBankLoaded = true;
          this.activeBankSupportedByWorklet = true;
        } catch (bankErr) {
          console.warn('Could not load default SpessaSynth sample bank:', bankErr);
        }

        // Apply active interpolation preference
        this.setInterpolationMode(getInterpolationMode());

        // Hydrate preset list once ready & SoundBank loaded
        if (synth.presetList && synth.presetList.length > 0) {
          this.presetList = this.sortPresets(synth.presetList);
        }

        // Ensure Sequencer instance exists and mirrors active MIDI Out setting
        this.ensureSequencerInstance(synth);

        this.notifyListeners();
        this.emitLog(`WorkletSynthesizer ready (${this.presetList.length} presets, 48 channels active)`);
        return synth;
      } catch (err) {
        console.warn('WorkletSynthesizer initialization error:', err);
        this.initPromise = null;
        return null;
      }
    })();

    return this.initPromise;
  }

  private setupAudioRouting(ctx: AudioContext, synth: WorkletSynthesizer) {
    try {
      if (!this.masterGain) {
        this.masterGain = ctx.createGain();
        const shouldSilence = this.webMidiState.midiOutEnabled && this.webMidiState.muteInternalOnMidiOut;
        this.masterGain.gain.setValueAtTime(shouldSilence ? 0 : this.targetMasterGainValue, ctx.currentTime);

        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.threshold.setValueAtTime(-6, ctx.currentTime);
        this.limiter.knee.setValueAtTime(6, ctx.currentTime);
        this.limiter.ratio.setValueAtTime(14, ctx.currentTime);
        this.limiter.attack.setValueAtTime(0.001, ctx.currentTime);
        this.limiter.release.setValueAtTime(0.08, ctx.currentTime);

        this.masterGain.connect(this.limiter);
        this.limiter.connect(ctx.destination);
      }
      synth.connect(this.masterGain);

      if (!this.silentVizSink) {
        this.silentVizSink = ctx.createGain();
        this.silentVizSink.gain.setValueAtTime(0, ctx.currentTime);
        this.silentVizSink.connect(ctx.destination);
      }

      if (this.channelAnalysers.length === 0) {
        for (let ch = 0; ch < 16; ch++) {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.55;
          synth.connectChannel(analyser, ch);
          analyser.connect(this.silentVizSink);
          this.channelAnalysers.push(analyser);
        }
      }
    } catch (e) {
      console.warn('WorkletSynthesizer audio routing warning:', e);
    }
  }

  private sortPresets(list: MIDIPatchFull[]): MIDIPatchFull[] {
    return [...list].sort((a, b) => {
      if (Boolean(a.isDrum) !== Boolean(b.isDrum)) return a.isDrum ? 1 : -1;
      if (a.bankMSB !== b.bankMSB) return a.bankMSB - b.bankMSB;
      if (a.bankLSB !== b.bankLSB) return a.bankLSB - b.bankLSB;
      return a.program - b.program;
    });
  }

  private attachSynthEventHandlers(synth: WorkletSynthesizer) {
    const eh = synth.eventHandler;

    eh.addEvent('presetListChange', 'aria48-mixer-presets', (presets) => {
      this.presetList = this.sortPresets(presets || []);
      if (!this.isReplacingSoundBank) {
        // Re-resolve displayed patch names against updated preset list
        this.channelStates.forEach((st) => {
          const match = this.findMatchingPreset(st.bankMSB, st.bankLSB, st.program, st.isDrum);
          if (match) {
            st.patchName = match.name;
          }
        });
        this.notifyListeners();
      }
    });

    eh.addEvent('programChange', 'aria48-mixer-prog', (ev) => {
      if (this.isReplacingSoundBank) return;
      const st = this.channelStates[ev.channel];
      if (st) {
        st.bankMSB = ev.bankMSB;
        st.bankLSB = ev.bankLSB;
        st.program = ev.program;
        st.isDrum = Boolean(ev.isDrum || ev.isGMGSDrum);
        st.patchName = ev.name || st.patchName;
        this.notifyListeners();
      }
      // Forward Bank Select + Program Change to external MIDI Output when enabled
      if (this.webMidiState.midiOutEnabled && !this.sequencerExternalHandlingActive()) {
        const ch = ev.channel & 0x0f;
        this.sendToSelectedMidiOutput([0xb0 | ch, 0, ev.bankMSB & 0x7f]);
        this.sendToSelectedMidiOutput([0xb0 | ch, 32, ev.bankLSB & 0x7f]);
        this.sendToSelectedMidiOutput([0xc0 | ch, ev.program & 0x7f]);
      }
    });

    eh.addEvent('controllerChange', 'aria48-mixer-cc', (ev) => {
      const st = this.channelStates[ev.channel];
      if (st) {
        if (ev.controller === WORKLET_CC.RESET_ALL_CONTROLLERS) {
          Object.keys(DEFAULT_CC_VALUES).forEach((k) => {
            const ccNum = Number(k);
            // Per GM/RP15 reset behavior: Volume(7), Pan(10), Bank(0/32) are not reset by CC 121
            if (ccNum === WORKLET_CC.VOLUME || ccNum === WORKLET_CC.PAN) return;
            if (!st.lockedCCs[ccNum]) {
              st.cc[ccNum] = DEFAULT_CC_VALUES[ccNum];
            }
          });
          if (!st.lockedCCs[1000]) {
            st.pitchWheel = 0;
          }
        } else {
          st.cc[ev.controller] = ev.value;
        }
        this.notifyListeners();
      }
      if (this.webMidiState.midiOutEnabled && !this.sequencerExternalHandlingActive()) {
        const ch = ev.channel & 0x0f;
        this.sendToSelectedMidiOutput([0xb0 | ch, ev.controller & 0x7f, ev.value & 0x7f]);
      }
    });

    eh.addEvent('channelParamChange', 'aria48-mixer-param', (ev) => {
      const st = this.channelStates[ev.channel];
      if (st) {
        if (ev.parameter === 'pitchWheel') {
          st.pitchWheel = Math.max(-8192, Math.min(8191, Math.round(Number(ev.value) - 8192)));
        } else if (ev.parameter === 'pitchWheelRange') {
          st.pitchWheelRange = Math.max(0, Math.min(24, Number(ev.value)));
        } else if (ev.parameter === 'drumMap') {
          st.isDrum = Number(ev.value) > 0;
        } else if (ev.parameter === 'velocitySenseDepth') {
          st.velocityDepth = Math.max(0, Math.min(127, Math.round(Number(ev.value))));
        } else if (ev.parameter === 'velocitySenseOffset') {
          st.velocityOffset = Math.max(0, Math.min(127, Math.round(Number(ev.value))));
        }
        this.notifyListeners();
      }
      if (
        ev.parameter === 'pitchWheel' &&
        this.webMidiState.midiOutEnabled &&
        !this.sequencerExternalHandlingActive()
      ) {
        const ch = ev.channel & 0x0f;
        const val14 = Math.max(0, Math.min(16383, Math.round(Number(ev.value))));
        this.sendToSelectedMidiOutput([0xe0 | ch, val14 & 0x7f, (val14 >> 7) & 0x7f]);
      }
    });

    eh.addEvent('noteOn', 'aria48-mixer-noteon', (ev) => {
      const st = this.channelStates[ev.channel];
      if (st && !st.activeNotes.includes(ev.midiNote)) {
        st.activeNotes.push(ev.midiNote);
        this.notifyListeners();
      }
      if (this.webMidiState.midiOutEnabled && !this.sequencerExternalHandlingActive()) {
        const ch = ev.channel & 0x0f;
        this.sendToSelectedMidiOutput([0x90 | ch, ev.midiNote & 0x7f, (ev.velocity ?? 100) & 0x7f]);
      }
    });

    eh.addEvent('noteOff', 'aria48-mixer-noteoff', (ev) => {
      const st = this.channelStates[ev.channel];
      if (st) {
        const idx = st.activeNotes.indexOf(ev.midiNote);
        if (idx !== -1) {
          st.activeNotes.splice(idx, 1);
          this.notifyListeners();
        }
      }
      if (this.webMidiState.midiOutEnabled && !this.sequencerExternalHandlingActive()) {
        const ch = ev.channel & 0x0f;
        this.sendToSelectedMidiOutput([0x80 | ch, ev.midiNote & 0x7f, 0]);
      }
    });

    eh.addEvent('stopAll', 'aria48-mixer-stopall', (ev) => {
      if (ev.channel === -1 || ev.channel === undefined) {
        this.channelStates.forEach(s => { s.activeNotes = []; });
      } else if (this.channelStates[ev.channel]) {
        this.channelStates[ev.channel].activeNotes = [];
      }
      this.notifyListeners();
    });

    eh.addEvent('reset', 'aria48-mixer-reset', () => {
      if (this.isReplacingSoundBank) return;
      this.channelStates.forEach((st, idx) => {
        const next = createDefaultChannelState(idx);
        // Preserve locked controllers, presetLock, mute, and solo states across resets
        Object.keys(st.lockedCCs).forEach((ccKey) => {
          const ccNum = Number(ccKey);
          if (st.lockedCCs[ccNum]) {
            next.cc[ccNum] = st.cc[ccNum];
            next.lockedCCs[ccNum] = true;
          }
        });
        if (st.presetLocked) {
          next.presetLocked = true;
          next.bankMSB = st.bankMSB;
          next.bankLSB = st.bankLSB;
          next.program = st.program;
          next.patchName = st.patchName;
          next.isDrum = st.isDrum;
        }
        if (st.pitchWheelLocked) {
          next.pitchWheelLocked = true;
          next.pitchWheel = st.pitchWheel;
        }
        next.isMuted = st.isMuted;
        next.isSolo = st.isSolo;
        next.velocityCurve = st.velocityCurve;
        next.velocityDepth = st.velocityDepth;
        next.velocityOffset = st.velocityOffset;
        this.channelStates[idx] = next;
      });
      this.notifyListeners();
    });
  }

  private findMatchingPreset(bankMSB: number, bankLSB: number, program: number, isDrum: boolean): MIDIPatchFull | undefined {
    const exact = this.presetList.find(
      p => p.bankMSB === bankMSB && p.bankLSB === bankLSB && p.program === program && Boolean(p.isDrum) === Boolean(isDrum)
    );
    if (exact) return exact;
    const gmBaseBank = isDrum
      ? this.presetList.find(p => (p.bankMSB === 128 || p.bankMSB === 0) && p.bankLSB === 0 && p.program === program && p.isDrum)
      : this.presetList.find(p => p.bankMSB === 0 && p.bankLSB === 0 && p.program === program && !p.isDrum);
    if (gmBaseBank) return gmBaseBank;
    const sameProg = this.presetList.find(
      p => p.program === program && Boolean(p.isDrum) === Boolean(isDrum)
    );
    if (sameProg) return sameProg;
    return isDrum
      ? this.presetList.find(p => Boolean(p.isDrum))
      : this.presetList.find(p => !p.isDrum);
  }

  public ensureChannelCount(count: number) {
    if (!this.synth) return;
    const target = Math.max(16, Math.min(48, Math.floor(count)));
    const current = Math.max(this.synth.midiChannels.length, this.requestedChannelCount);
    if (target <= current) return;
    const toAdd = target - current;
    this.requestedChannelCount = target;
    for (let i = 0; i < toAdd; i++) {
      this.synth.addNewChannel();
    }
  }

  private resolveTargetChannel(ch: number): number {
    const c = Math.max(0, Math.min(47, Math.floor(ch)));
    if (this.synth && c >= this.synth.midiChannels.length) {
      this.ensureChannelCount(c + 1);
      if (c >= this.synth.midiChannels.length) {
        return c % Math.max(1, this.synth.midiChannels.length);
      }
    }
    return c;
  }

  // --- SOUNDFONT MANAGEMENT ---

  public async loadSoundBank(arrayBuffer: ArrayBuffer, id: string, makePrimary = true): Promise<boolean> {
    const lower = id.toLowerCase();
    // Native SF2, SF3, DLS, and SFe sound banks load directly into WorkletSynthesizer's single active slot
    if (!isWorkletSupportedSoundBank(arrayBuffer, lower)) {
      if (makePrimary) {
        this.activeBankId = id;
        this.activeBankSupportedByWorklet = false;
        this.notifyListeners();
      }
      return false;
    }

    const synth = await this.init();
    if (!synth) return false;
    try {
      const bankCopy = arrayBuffer.slice(0);
      this.customBanksLoaded.add(id);
      this.soundBankBuffers.set(id, bankCopy);
      if (makePrimary) {
        await this.setActiveSoundBank(id);
      }
      return true;
    } catch (err) {
      console.warn(`WorkletSynthesizer SoundBank note for "${lower}":`, err);
      return false;
    }
  }

  public setActiveSoundBank(id: string): Promise<void> {
    const mappedId =
      id === 'spessa-default-gm' || id === 'spessa-chiptune-sf2'
        ? 'aria-default-bank'
        : id;
    const reqGen = ++this.bankSwitchGen;

    const task = this.bankSwitchQueue.then(async () => {
      if (reqGen !== this.bankSwitchGen) return;
      const synth = await this.init();
      if (!synth || reqGen !== this.bankSwitchGen) return;

      const bankBuffer = this.soundBankBuffers.get(mappedId);
      if (!bankBuffer || bankBuffer.byteLength === 0) {
        // Non-Worklet custom bank (e.g., SFZ/PAT) or chiptune synth mode
        this.activeBankId = mappedId;
        this.activeBankSupportedByWorklet = false;
        this.notifyListeners();
        return;
      }

      // Snapshot every channel's musical preset & CC assignments BEFORE replacing the bank in-place
      const snapshots = this.channelStates.map(s => ({
        ...s,
        cc: { ...s.cc },
        lockedCCs: { ...s.lockedCCs }
      }));

      // Silence old bank's ringing voices immediately
      this.stopAll(true);
      this.isReplacingSoundBank = true;
      try {
        // Replace ONLY the single active bank slot in WorkletSynthesizer so presets from
        // previously loaded SoundFonts NEVER remain stacked or mix together!
        await synth.soundBankManager.addSoundBank(bankBuffer.slice(0), PRIMARY_WORKLET_BANK_ID, 0);
        if (reqGen !== this.bankSwitchGen) return;

        this.activeBankId = mappedId;
        this.activeBankSupportedByWorklet = id !== 'spessa-chiptune-sf2';

        if (synth.presetList?.length) {
          this.presetList = this.sortPresets(synth.presetList);
        }

        // Re-apply channel programs cleanly against the NEW SoundFont's preset list
        const chCount = Math.min(synth.midiChannels.length || 16, this.channelStates.length);
        for (let ch = 0; ch < chCount; ch++) {
          const snap = snapshots[ch];
          const st = this.channelStates[ch];
          if (!snap || !st) continue;

          const chObj = synth.midiChannels[ch];
          if (chObj) {
            chObj.setSystemParameter('presetLock', false);
            chObj.lockController(WORKLET_CC.BANK_MSB as MIDIController, false);
            chObj.lockController(WORKLET_CC.BANK_LSB as MIDIController, false);
            chObj.setDrums(snap.isDrum);
          }

          const resolved = this.findMatchingPreset(snap.bankMSB, snap.bankLSB, snap.program, snap.isDrum);
          const targetMSB = resolved ? resolved.bankMSB : (snap.isDrum ? 128 : 0);
          const targetLSB = resolved ? resolved.bankLSB : 0;
          const targetProg = resolved ? resolved.program : snap.program;

          synth.controllerChange(ch, WORKLET_CC.BANK_MSB as MIDIController, targetMSB);
          synth.controllerChange(ch, WORKLET_CC.BANK_LSB as MIDIController, targetLSB);
          synth.programChange(ch, targetProg);

          st.isDrum = snap.isDrum;
          st.bankMSB = targetMSB;
          st.bankLSB = targetLSB;
          st.program = targetProg;
          st.patchName = resolved?.name || (snap.isDrum ? 'Standard Drum Kit' : (DEFAULT_GM_PROGRAMS[targetProg] || `Program ${targetProg}`));

          // Re-apply mixer CCs, pitch wheel, mutes, velocity & locks cleanly
          for (const ccNum of LOCKABLE_MIXER_CCS) {
            if (ccNum === WORKLET_CC.SUSTAIN || ccNum === WORKLET_CC.SOSTENUTO) continue;
            const val = snap.cc[ccNum] ?? DEFAULT_CC_VALUES[ccNum];
            if (val !== undefined) {
              chObj?.lockController(ccNum as MIDIController, false);
              synth.controllerChange(ch, ccNum as MIDIController, val);
              st.cc[ccNum] = val;
            }
            if (snap.lockedCCs[ccNum]) {
              chObj?.lockController(ccNum as MIDIController, true);
              st.lockedCCs[ccNum] = true;
            }
          }

          st.pitchWheelRange = snap.pitchWheelRange;
          st.pitchWheel = snap.pitchWheel;
          st.pitchWheelLocked = snap.pitchWheelLocked;
          if (snap.pitchWheelRange !== 2) {
            synth.pitchWheelRange(ch, snap.pitchWheelRange);
          }
          if (snap.pitchWheel !== 0) {
            this.setPitchWheelSigned(ch, snap.pitchWheel, true);
          }
          if (snap.pitchWheelLocked) {
            chObj?.lockMIDIParameter('pitchWheel', true);
            chObj?.lockMIDIParameter('pitchWheelRange', true);
          }

          st.isMuted = snap.isMuted;
          st.isSolo = snap.isSolo;
          chObj?.setSystemParameter('isMuted', snap.isMuted);

          st.presetLocked = snap.presetLocked;
          if (snap.presetLocked) {
            chObj?.setSystemParameter('presetLock', true);
          }
          if (snap.lockedCCs[WORKLET_CC.BANK_MSB]) {
            st.lockedCCs[WORKLET_CC.BANK_MSB] = true;
            chObj?.lockController(WORKLET_CC.BANK_MSB as MIDIController, true);
          }
          if (snap.lockedCCs[WORKLET_CC.BANK_LSB]) {
            st.lockedCCs[WORKLET_CC.BANK_LSB] = true;
            chObj?.lockController(WORKLET_CC.BANK_LSB as MIDIController, true);
          }
        }

        this.notifyListeners();
        this.emitLog(`Activated SoundBank "${id}" cleanly (${this.presetList.length} presets, zero cross-bank mixing)`);
      } catch (err) {
        console.warn(`WorkletSynthesizer bank switch note for "${id}":`, err);
        this.activeBankSupportedByWorklet = false;
      } finally {
        this.isReplacingSoundBank = false;
      }
    }).catch(() => {});

    this.bankSwitchQueue = task;
    return task;
  }

  public async removeSoundBank(id: string) {
    if (id === 'aria-default-bank') return;
    this.customBanksLoaded.delete(id);
    this.soundBankBuffers.delete(id);
    if (this.activeBankId === id) {
      await this.setActiveSoundBank('aria-default-bank');
    } else {
      this.notifyListeners();
    }
  }

  public getActiveSoundBankBuffer(): ArrayBuffer {
    const active = this.soundBankBuffers.get(this.activeBankId);
    if (active && active.byteLength > 0) {
      return active.slice(0);
    }
    return BasicSoundBank.getSampleSoundBankFile().slice(0);
  }

  public setInterpolationMode(mode: SoundFontInterpolationMode) {
    if (!this.synth || !this.workletReady) return;
    let interp: number = InterpolationTypes.hermite;
    switch (mode) {
      case 'none':
        interp = InterpolationTypes.nearestNeighbor;
        break;
      case 'linear':
        interp = InterpolationTypes.linear;
        break;
      case 'cubic':
        interp = InterpolationTypes.hermite;
        break;
      case 'poly4':
        interp = InterpolationTypes.hermite;
        break;
      case 'sinc':
        interp = InterpolationTypes.sinc32;
        break;
    }
    try {
      this.synth.setSystemParameter('interpolationType', interp as 0 | 1 | 2 | 3 | 4);
    } catch (e) {}
  }

  // --- DIRECT WORKLET SYNTHESIZER CONTROL METHODS ---

  public selectPreset(channel: number, bankMSB: number, bankLSB: number, program: number, isDrum?: boolean) {
    const ch = this.resolveTargetChannel(channel);
    const st = this.channelStates[ch];
    if (!st) return;

    if (this.synth) {
      const wasPresetLocked = st.presetLocked;
      const wasBankMSBLocked = Boolean(st.lockedCCs[WORKLET_CC.BANK_MSB]);
      const wasBankLSBLocked = Boolean(st.lockedCCs[WORKLET_CC.BANK_LSB]);

      // Ensure explicit user preset selection applies immediately even if preset lock is enabled
      if (wasPresetLocked) this.synth.midiChannels[ch]?.setSystemParameter('presetLock', false);
      if (wasBankMSBLocked) this.synth.midiChannels[ch]?.lockController(WORKLET_CC.BANK_MSB as MIDIController, false);
      if (wasBankLSBLocked) this.synth.midiChannels[ch]?.lockController(WORKLET_CC.BANK_LSB as MIDIController, false);

      if (isDrum !== undefined && isDrum !== st.isDrum) {
        this.synth.midiChannels[ch]?.setDrums(isDrum);
      }

      this.synth.controllerChange(ch, WORKLET_CC.BANK_MSB as MIDIController, bankMSB);
      this.synth.controllerChange(ch, WORKLET_CC.BANK_LSB as MIDIController, bankLSB);
      this.synth.programChange(ch, program);

      if (wasPresetLocked) this.synth.midiChannels[ch]?.setSystemParameter('presetLock', true);
      if (wasBankMSBLocked) this.synth.midiChannels[ch]?.lockController(WORKLET_CC.BANK_MSB as MIDIController, true);
      if (wasBankLSBLocked) this.synth.midiChannels[ch]?.lockController(WORKLET_CC.BANK_LSB as MIDIController, true);
    }

    if (isDrum !== undefined) st.isDrum = isDrum;
    st.bankMSB = bankMSB;
    st.bankLSB = bankLSB;
    st.program = program;
    const match = this.findMatchingPreset(bankMSB, bankLSB, program, st.isDrum);
    st.patchName = match?.name || (st.isDrum ? 'GM Standard Drum Kit' : (DEFAULT_GM_PROGRAMS[program] || `Program ${program}`));
    this.notifyListeners();
    this.emitLog(
      `CH ${ch + 1}: Patch -> Bank ${bankMSB}:${bankLSB} Prog ${program} (${st.patchName})`
    );
  }

  public programChange(channel: number, program: number) {
    const ch = this.resolveTargetChannel(channel);
    const prog = Math.max(0, Math.min(127, Math.floor(program)));
    const st = this.channelStates[ch];
    if (st && !st.presetLocked) {
      st.program = prog;
      const match = this.findMatchingPreset(st.bankMSB, st.bankLSB, prog, st.isDrum);
      st.patchName = match?.name || (st.isDrum ? 'Standard Drum Kit' : (DEFAULT_GM_PROGRAMS[prog] || `Program ${prog}`));
      this.notifyListeners();
    }
    if (!this.synth) return;
    this.synth.programChange(ch, prog);
    if (this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
      this.sendToSelectedMidiOutput([0xc0 | (ch & 0x0f), prog & 0x7f]);
    }
  }

  public controllerChange(channel: number, ccNumber: number, value: number, fromUserUI = true) {
    const ch = this.resolveTargetChannel(channel);
    const st = this.channelStates[ch];
    const cc = Math.max(0, Math.min(127, Math.floor(ccNumber)));
    const val = Math.max(0, Math.min(127, Math.round(value)));

    if (!this.synth) return;

    const wasLocked = Boolean(st?.lockedCCs[cc]);
    if (fromUserUI && wasLocked) {
      // Allow manual UI override while keeping MIDI lock intact
      this.synth.midiChannels[ch]?.lockController(cc as MIDIController, false);
    }

    this.synth.controllerChange(ch, cc as MIDIController, val);

    if (fromUserUI && wasLocked) {
      this.synth.midiChannels[ch]?.lockController(cc as MIDIController, true);
    }

    if (st && cc !== WORKLET_CC.ALL_SOUND_OFF && cc !== WORKLET_CC.RESET_ALL_CONTROLLERS && cc !== WORKLET_CC.ALL_NOTES_OFF) {
      st.cc[cc] = val;
      this.notifyListeners();
    }
    if (fromUserUI && this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
      this.sendToSelectedMidiOutput([0xb0 | (ch & 0x0f), cc & 0x7f, val & 0x7f]);
    }
  }

  /**
   * Direct Pitch Wheel method accepting either:
   * - `pitchWheel(ch, msb, lsb)` (standard 7-bit MIDI MSB & LSB bytes)
   * - `pitchWheel(ch, val14)` (14-bit 0..16383)
   */
  public pitchWheel(channel: number, msbOrVal14: number, lsb?: number, fromUserUI = true) {
    const ch = this.resolveTargetChannel(channel);
    const st = this.channelStates[ch];
    if (!this.synth) return;

    const val14 =
      lsb !== undefined
        ? Math.max(0, Math.min(16383, ((msbOrVal14 & 0x7f) << 7) | (lsb & 0x7f)))
        : Math.max(0, Math.min(16383, Math.round(msbOrVal14)));

    const wasLocked = Boolean(st?.pitchWheelLocked);
    if (fromUserUI && wasLocked) {
      this.synth.midiChannels[ch]?.lockMIDIParameter('pitchWheel', false);
    }
    this.synth.pitchWheel(ch, val14);
    if (fromUserUI && wasLocked) {
      this.synth.midiChannels[ch]?.lockMIDIParameter('pitchWheel', true);
    }

    if (st) {
      st.pitchWheel = val14 - 8192;
      this.notifyListeners();
    }
    if (fromUserUI && this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
      this.sendToSelectedMidiOutput([0xe0 | (ch & 0x0f), val14 & 0x7f, (val14 >> 7) & 0x7f]);
    }
  }

  public setPitchWheelSigned(channel: number, signedValue: number, fromUserUI = true) {
    const clampedSigned = Math.max(-8192, Math.min(8191, Math.round(signedValue)));
    const val14 = clampedSigned + 8192;
    const lsb = val14 & 0x7f;
    const msb = (val14 >> 7) & 0x7f;
    this.pitchWheel(channel, msb, lsb, fromUserUI);
  }

  public pitchWheelRange(channel: number, semitones: number) {
    const ch = this.resolveTargetChannel(channel);
    const range = Math.max(0, Math.min(24, Math.round(semitones)));
    if (!this.synth) return;
    this.synth.pitchWheelRange(ch, range);
    if (this.channelStates[ch]) {
      this.channelStates[ch].pitchWheelRange = range;
      this.notifyListeners();
      this.emitLog(`CH ${ch + 1}: Pitch Bend Range (RPN 0) -> +/-${range} Semitones`);
    }
  }

  public setDrums(channel: number, isDrums: boolean) {
    const ch = this.resolveTargetChannel(channel);
    if (!this.synth) return;
    const libCh = this.synth.midiChannels[ch];
    libCh?.setDrums(isDrums);
    if (this.channelStates[ch]) {
      this.channelStates[ch].isDrum = isDrums;
      if (isDrums) {
        const firstDrum = this.presetList.find(p => p.isDrum);
        if (firstDrum) {
          this.selectPreset(ch, firstDrum.bankMSB, firstDrum.bankLSB, firstDrum.program, true);
        }
      } else {
        const match = this.presetList.find(p => !p.isDrum && p.program === this.channelStates[ch].program);
        if (match) {
          this.selectPreset(ch, match.bankMSB, match.bankLSB, match.program, false);
        }
      }
      this.notifyListeners();
      this.emitLog(`CH ${ch + 1}: Drum Mode ${isDrums ? 'ENABLED (Percussion Kit)' : 'DISABLED (Melodic)'}`);
    }
  }

  public muteChannel(channel: number, isMuted: boolean) {
    const ch = this.resolveTargetChannel(channel);
    if (this.synth) {
      this.synth.midiChannels[ch]?.setSystemParameter('isMuted', isMuted);
    }
    if (this.channelStates[ch]) {
      this.channelStates[ch].isMuted = isMuted;
      if (isMuted) {
        this.channelStates[ch].activeNotes = [];
      }
      this.notifyListeners();
    }
  }

  public toggleSoloChannel(channel: number) {
    const ch = Math.max(0, Math.min(15, Math.floor(channel)));
    const st = this.channelStates[ch];
    if (!st) return;

    const anyWasSolo = this.channelStates.slice(0, 16).some(s => s.isSolo);
    if (!anyWasSolo) {
      this.preSoloMutes = this.channelStates.slice(0, 16).map(s => s.isMuted);
    }

    st.isSolo = !st.isSolo;
    const soloActive = this.channelStates.slice(0, 16).some(s => s.isSolo);

    if (soloActive) {
      for (let i = 0; i < 16; i++) {
        this.muteChannel(i, !this.channelStates[i].isSolo);
      }
      this.emitLog(`CH ${ch + 1}: Solo ${st.isSolo ? 'ON' : 'OFF'}`);
    } else {
      const prior = this.preSoloMutes;
      this.preSoloMutes = null;
      for (let i = 0; i < 16; i++) {
        this.muteChannel(i, prior ? prior[i] : false);
      }
      this.emitLog('Solo cleared — restored channel mute states');
    }
    this.notifyListeners();
  }

  public lockController(channel: number, ccNumber: number, isLocked: boolean) {
    const ch = this.resolveTargetChannel(channel);
    const st = this.channelStates[ch];

    if (ccNumber === WORKLET_CC.PRESET_LOCK_VIRTUAL) {
      if (this.synth) {
        const libCh = this.synth.midiChannels[ch];
        libCh?.setSystemParameter('presetLock', isLocked);
        libCh?.lockController(WORKLET_CC.BANK_MSB as MIDIController, isLocked);
        libCh?.lockController(WORKLET_CC.BANK_LSB as MIDIController, isLocked);
      }
      if (st) {
        st.presetLocked = isLocked;
        st.lockedCCs[WORKLET_CC.BANK_MSB] = isLocked;
        st.lockedCCs[WORKLET_CC.BANK_LSB] = isLocked;
        this.notifyListeners();
        this.emitLog(`CH ${ch + 1}: Program / Bank Preset ${isLocked ? 'LOCKED' : 'UNLOCKED'}`);
      }
      return;
    }

    const cc = Math.max(0, Math.min(127, Math.floor(ccNumber)));
    if (this.synth) {
      this.synth.midiChannels[ch]?.lockController(cc as MIDIController, isLocked);
    }
    if (st) {
      st.lockedCCs[cc] = isLocked;
      this.notifyListeners();
    }
  }

  public lockPitchWheel(channel: number, isLocked: boolean) {
    const ch = this.resolveTargetChannel(channel);
    if (this.synth) {
      this.synth.midiChannels[ch]?.lockMIDIParameter('pitchWheel', isLocked);
      this.synth.midiChannels[ch]?.lockMIDIParameter('pitchWheelRange', isLocked);
    }
    if (this.channelStates[ch]) {
      this.channelStates[ch].pitchWheelLocked = isLocked;
      this.notifyListeners();
    }
  }

  public lockAllControllers(isLocked: boolean, channelOnly?: number) {
    const start = channelOnly !== undefined ? Math.max(0, Math.min(15, channelOnly)) : 0;
    const end = channelOnly !== undefined ? start : 15;
    for (let ch = start; ch <= end; ch++) {
      this.lockController(ch, WORKLET_CC.PRESET_LOCK_VIRTUAL, isLocked);
      this.lockPitchWheel(ch, isLocked);
      for (const cc of LOCKABLE_MIXER_CCS) {
        this.lockController(ch, cc, isLocked);
      }
    }
    this.emitLog(
      channelOnly !== undefined
        ? `CH ${channelOnly + 1}: ${isLocked ? 'Locked ALL' : 'Unlocked ALL'} controllers & preset`
        : `Global: ${isLocked ? 'Locked ALL' : 'Unlocked ALL'} controllers across Channels 1–16`
    );
  }

  public setVelocitySensitivity(
    channel: number,
    curve: VelocityCurveType,
    depth: number,
    offset = 64
  ) {
    const ch = this.resolveTargetChannel(channel);
    const st = this.channelStates[ch];
    const clampedDepth = Math.max(0, Math.min(127, Math.round(depth)));
    const clampedOffset = Math.max(0, Math.min(127, Math.round(offset)));

    if (st) {
      st.velocityCurve = curve;
      st.velocityDepth = clampedDepth;
      st.velocityOffset = clampedOffset;
      this.notifyListeners();
    }

    if (this.synth) {
      const part = channelToGSPart(ch);
      const offsetBlock = Math.floor(ch / 16) * 16;
      // GS Part Velocity Sense Depth (0x1A) & Offset (0x1B)
      this.synth.systemExclusive(
        [0x41, 0x10, 0x42, 0x12, 0x40, 0x10 | part, 0x1a, clampedDepth, 0x00, 0xf7],
        offsetBlock
      );
      this.synth.systemExclusive(
        [0x41, 0x10, 0x42, 0x12, 0x40, 0x10 | part, 0x1b, clampedOffset, 0x00, 0xf7],
        offsetBlock
      );
    }
    this.emitLog(`CH ${ch + 1}: Velocity Curve=${curve.toUpperCase()} Depth=${clampedDepth} Offset=${clampedOffset}`);
  }

  public mapVelocityWithCurve(channel: number, rawVelocity: number): number {
    const st = this.channelStates[Math.max(0, Math.min(47, Math.floor(channel)))];
    const v = Math.max(1, Math.min(127, rawVelocity));
    if (!st) return v;

    let norm = v / 127;
    if (st.velocityCurve === 'soft') {
      norm = Math.pow(norm, 0.62);
    } else if (st.velocityCurve === 'hard') {
      norm = Math.pow(norm, 1.65);
    } else if (st.velocityCurve === 'fixed') {
      norm = 1.0;
    }
    return Math.max(1, Math.min(127, Math.round(norm * 127)));
  }

  public systemExclusive(messageData: number[], channelOffset = 0) {
    if (this.synth) {
      this.synth.systemExclusive(messageData, channelOffset);
    }
    if (this.webMidiState.midiOutEnabled && messageData.length > 0) {
      const bytes = messageData[0] === 0xf0 ? [...messageData] : [0xf0, ...messageData];
      if (bytes[bytes.length - 1] !== 0xf7) bytes.push(0xf7);
      this.sendToSelectedMidiOutput(bytes);
    }
  }

  // --- NOTE TRIGGERING & PLAYBACK SYNC ---

  public noteOn(channel: number, midiNote: number, velocity: number, atAudioTime?: number) {
    const ch = this.resolveTargetChannel(channel);
    const st = this.channelStates[ch];
    if (!this.synth || !this.workletReady || st?.isMuted) return;

    const curvedVel = this.mapVelocityWithCurve(ch, velocity);
    const opts = atAudioTime !== undefined && Number.isFinite(atAudioTime) ? { time: atAudioTime } : undefined;
    this.synth.noteOn(ch, midiNote, curvedVel, opts);
    if (this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
      this.sendToSelectedMidiOutput([0x90 | (ch & 0x0f), midiNote & 0x7f, curvedVel & 0x7f]);
    }
  }

  public noteOff(channel: number, midiNote: number, atAudioTime?: number) {
    const ch = this.resolveTargetChannel(channel);
    if (!this.synth || !this.workletReady) return;
    const opts = atAudioTime !== undefined && Number.isFinite(atAudioTime) ? { time: atAudioTime } : undefined;
    this.synth.noteOff(ch, midiNote, opts);
    if (this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
      this.sendToSelectedMidiOutput([0x80 | (ch & 0x0f), midiNote & 0x7f, 0]);
    }
  }

  public sendRawMidiMessage(msg: number[], atAudioTime?: number) {
    if (!this.synth || !this.workletReady || !msg || msg.length === 0) return;
    const status = msg[0];
    const cmd = status & 0xf0;
    const ch = status & 0x0f;
    const opts = atAudioTime !== undefined && Number.isFinite(atAudioTime) ? { time: atAudioTime } : undefined;

    if (cmd === 0x90) {
      const note = msg[1] & 0x7f;
      const vel = msg[2] & 0x7f;
      if (vel > 0) {
        if (!this.channelStates[ch]?.isMuted) {
          const curvedVel = this.mapVelocityWithCurve(ch, vel);
          this.synth.noteOn(ch, note, curvedVel, opts);
        }
      } else {
        this.synth.noteOff(ch, note, opts);
      }
    } else if (cmd === 0x80) {
      this.synth.noteOff(ch, msg[1] & 0x7f, opts);
    } else if (cmd === 0xb0) {
      this.synth.controllerChange(ch, (msg[1] & 0x7f) as MIDIController, msg[2] & 0x7f, opts);
    } else if (cmd === 0xc0) {
      this.synth.programChange(ch, msg[1] & 0x7f, opts);
    } else if (cmd === 0xe0) {
      const val14 = ((msg[2] & 0x7f) << 7) | (msg[1] & 0x7f);
      this.synth.pitchWheel(ch, val14, opts);
    } else if (status === 0xf0) {
      this.synth.systemExclusive(msg.slice(1), 0, opts);
    }
  }

  public stopAll(force = true) {
    if (this.synth && this.workletReady) {
      const count = this.synth.midiChannels?.length || 16;
      for (let ch = 0; ch < count; ch++) {
        try {
          // Release sustain / sostenuto pedals so paused or scrubbed notes cannot stay held
          this.synth.controllerChange(ch, WORKLET_CC.SUSTAIN as MIDIController, 0);
          this.synth.controllerChange(ch, WORKLET_CC.SOSTENUTO as MIDIController, 0);
          if (force) {
            this.synth.controllerChange(ch, WORKLET_CC.ALL_SOUND_OFF as MIDIController, 0);
          }
        } catch {}
      }
      this.synth.stopAll(force);
    }
    this.channelStates.forEach(s => {
      s.activeNotes = [];
      s.cc[WORKLET_CC.SUSTAIN] = 0;
      s.cc[WORKLET_CC.SOSTENUTO] = 0;
    });
    this.notifyListeners();
  }

  // --- GLOBAL SYSTEM RESETS ---

  public sendGMSystemOn() {
    if (!this.synth) return;
    this.systemExclusive([0x7e, 0x7f, 0x09, 0x01, 0xf7]);
    this.emitLog('Global SysEx: GM System On (F0 7E 7F 09 01 F7)');
  }

  public sendGSReset() {
    if (!this.synth) return;
    this.systemExclusive([0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7]);
    this.emitLog('Global SysEx: Roland GS Reset (F0 41 10 42 12 40 00 7F 00 41 F7)');
  }

  public sendXGSystemOn() {
    if (!this.synth) return;
    this.systemExclusive([0x43, 0x10, 0x4c, 0x00, 0x00, 0x7e, 0x00, 0xf7]);
    this.emitLog('Global SysEx: Yamaha XG System On (F0 43 10 4C 00 00 7E 00 F7)');
  }

  public sendAllSoundOff() {
    if (this.synth) {
      const count = this.synth.midiChannels.length || 16;
      for (let ch = 0; ch < count; ch++) {
        try {
          this.synth.controllerChange(ch, WORKLET_CC.SUSTAIN as MIDIController, 0);
          this.synth.controllerChange(ch, WORKLET_CC.SOSTENUTO as MIDIController, 0);
          this.synth.controllerChange(ch, WORKLET_CC.ALL_SOUND_OFF as MIDIController, 0);
        } catch {}
      }
      this.synth.stopAll(true);
    }
    this.channelStates.forEach(s => {
      s.activeNotes = [];
      s.cc[WORKLET_CC.SUSTAIN] = 0;
      s.cc[WORKLET_CC.SOSTENUTO] = 0;
    });
    this.notifyListeners();
    this.emitLog('All Channels: All Sound Off (CC 120) & Stop All');
  }

  public sendResetAllControllers() {
    if (!this.synth) return;
    const count = this.synth.midiChannels.length || 16;
    for (let ch = 0; ch < count; ch++) {
      this.synth.controllerChange(ch, WORKLET_CC.RESET_ALL_CONTROLLERS as MIDIController, 0);
    }
    this.emitLog('All Channels: Reset All Controllers (CC 121)');
  }

  // --- SEQUENCER & BASICMIDI CONVERSION / .MID EXPORT ---

  private sequencerExternalHandlingActive(): boolean {
    return Boolean(
      this.sequencer &&
      this.sequencerPlaying &&
      this.webMidiState.midiOutEnabled &&
      this.boundOutputProxy
    );
  }

  private ensureSequencerInstance(synth: WorkletSynthesizer): Sequencer {
    if (this.sequencer && this.sequencer.synth === synth) {
      return this.sequencer;
    }
    const seq = new Sequencer(synth, { skipToFirstNoteOn: false });
    seq.loopCount = 0;

    seq.eventHandler.addEvent('songChange', 'aria48-seq-songchange', (data) => {
      if (this.currentSequenceMetadata && data?.midiData) {
        const dur = data.midiData.duration;
        if (dur > 0) {
          this.currentSequenceMetadata = {
            ...this.currentSequenceMetadata,
            durationSeconds: dur
          };
        }
      }
      this.notifyListeners();
    });

    seq.eventHandler.addEvent('songEnded', 'aria48-seq-ended', () => {
      this.sequencerPlaying = false;
      this.stopAll(true);
      this.sendAllNotesOffToMidiOut();
      const cb = this.sequencerEndedCallback;
      if (cb) {
        setTimeout(() => {
          if (!this.sequencerPlaying) cb();
        }, 120);
      }
      this.notifyListeners();
    });

    this.sequencer = seq;
    this.syncSequencerMidiOutput();
    return seq;
  }

  public extractBasicMidiMetadata(
    arrayBuffer: ArrayBuffer,
    fileName: string,
    patternCount = 1,
    rowCount = 64
  ): { basicMidi: BasicMIDI; metadata: LoadedSequenceMetadata } {
    const basicMidi = BasicMIDI.fromArrayBuffer(arrayBuffer.slice(0), fileName);
    const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.') + 1).toUpperCase() : 'MID';
    const isTrackerConverted = ['MOD', 'XM', 'S3M', 'IT'].includes(ext);

    let title = '';
    try {
      title = basicMidi.getName?.() || '';
    } catch {}
    if (!title) {
      title = fileName.replace(/\.[^.]+$/, '') || 'Untitled Sequence';
    }

    const activeChSet = new Set<number>();
    for (const trk of basicMidi.tracks || []) {
      for (const ev of trk.events || []) {
        const status = ev.statusByte || 0;
        if ((status & 0xf0) === 0x90 && ev.data && ev.data[1] > 0) {
          activeChSet.add(status & 0x0f);
        }
      }
    }
    const activeChannels = Array.from(activeChSet).sort((a, b) => a - b);

    const firstTempo = basicMidi.tempoChanges && basicMidi.tempoChanges.length > 0
      ? Math.round(basicMidi.tempoChanges[basicMidi.tempoChanges.length - 1].tempo || 125)
      : 125;
    const clampedBpm = Math.max(30, Math.min(320, firstTempo));

    const durationSeconds = basicMidi.duration > 0
      ? basicMidi.duration
      : Math.max(1, basicMidi.midiTicksToSeconds(Math.max(1, basicMidi.lastVoiceEventTick || basicMidi.timeDivision || 480)));

    const samplePresets: SequenceSamplePresetInfo[] = [];
    if (basicMidi.embeddedSoundBank && basicMidi.embeddedSoundBank.byteLength > 12) {
      try {
        const sb = SoundBankLoader.fromArrayBuffer(basicMidi.embeddedSoundBank.slice(0));
        for (const p of sb.presets || []) {
          samplePresets.push({
            name: p.name || `Preset ${p.program}`,
            bankMSB: p.bankMSB ?? 0,
            bankLSB: p.bankLSB ?? 0,
            program: p.program ?? 0,
            isDrum: Boolean(p.isDrum)
          });
        }
      } catch (sbErr) {
        console.warn('Embedded SoundBank preset inspection note:', sbErr);
      }
    }

    const metadata: LoadedSequenceMetadata = {
      fileName,
      title,
      format: ext,
      isTrackerConverted,
      patternCount,
      rowCount,
      activeChannels,
      samplePresets,
      hasEmbeddedSoundBank: Boolean(basicMidi.embeddedSoundBank),
      durationSeconds,
      bpm: clampedBpm,
      tracksCount: basicMidi.tracks?.length || 1
    };

    return { basicMidi, metadata };
  }

  public registerLoadedSequence(
    arrayBuffer: ArrayBuffer,
    fileName = 'sequence.mid',
    patternCount = 1,
    rowCount = 64
  ): LoadedSequenceMetadata | null {
    try {
      const copy = arrayBuffer.slice(0);
      const { basicMidi, metadata } = this.extractBasicMidiMetadata(copy, fileName, patternCount, rowCount);
      this.currentBasicMIDI = basicMidi;
      this.currentOriginalFileName = fileName;
      this.currentSequenceBuffer = copy;
      this.currentSequenceMetadata = metadata;
      this.loadedSequencerKey = `${fileName}:${copy.byteLength}`;

      if (this.synth && this.workletReady) {
        const seq = this.ensureSequencerInstance(this.synth);
        seq.pause();
        this.sequencerPlaying = false;
        seq.loadNewSongList([{ binary: copy.slice(0), fileName }]);
      }

      this.notifyListeners();
      this.emitLog(
        `Loaded ${metadata.format}: "${metadata.title}" (${metadata.activeChannels.length} ch, ${metadata.patternCount} pat / ${metadata.rowCount} rows${
          metadata.samplePresets.length > 0 ? `, ${metadata.samplePresets.length} embedded sample presets` : ''
        })`
      );
      return metadata;
    } catch (err) {
      console.warn('registerLoadedSequence note:', err);
      return null;
    }
  }

  public updateSequenceGridCounts(patternCount: number, rowCount: number) {
    if (!this.currentSequenceMetadata) return;
    this.currentSequenceMetadata = {
      ...this.currentSequenceMetadata,
      patternCount,
      rowCount
    };
    this.notifyListeners();
  }

  public clearCurrentSequence() {
    this.pauseSequencer();
    this.currentBasicMIDI = null;
    this.currentOriginalFileName = '';
    this.currentSequenceBuffer = null;
    this.currentSequenceMetadata = null;
    this.loadedSequencerKey = '';
    this.notifyListeners();
  }

  public async playSequencerFromBuffer(
    arrayBuffer: ArrayBuffer,
    fileName = 'sequence.mid',
    seekRatio = 0,
    playbackRate = 1,
    onEnded?: () => void
  ): Promise<boolean> {
    const synth = await this.init();
    if (!synth || !this.workletReady) return false;

    const key = `${fileName}:${arrayBuffer.byteLength}`;
    if (!this.currentBasicMIDI || this.loadedSequencerKey !== key) {
      this.registerLoadedSequence(
        arrayBuffer,
        fileName,
        this.currentSequenceMetadata?.patternCount || 1,
        this.currentSequenceMetadata?.rowCount || 64
      );
    }

    const seq = this.ensureSequencerInstance(synth);
    if (!this.sequencer || this.loadedSequencerKey !== key || !seq.midiData) {
      seq.loadNewSongList([{ binary: arrayBuffer.slice(0), fileName }]);
      this.loadedSequencerKey = key;
    }

    this.sequencerEndedCallback = onEnded || null;
    seq.playbackRate = Math.max(0.25, Math.min(4.0, playbackRate || 1));

    const totalDur = Math.max(
      0.5,
      seq.duration || this.currentSequenceMetadata?.durationSeconds || 10
    );
    const clampedRatio = Math.max(0, Math.min(0.995, seekRatio || 0));
    seq.currentTime = clampedRatio * totalDur;

    this.syncSequencerMidiOutput();
    seq.play();
    this.sequencerPlaying = true;

    if (this.sequencerWatchdogTimer) clearInterval(this.sequencerWatchdogTimer);
    this.sequencerWatchdogTimer = setInterval(() => {
      if (!this.sequencer || !this.sequencerPlaying) {
        clearInterval(this.sequencerWatchdogTimer);
        this.sequencerWatchdogTimer = null;
        return;
      }
      if (this.sequencer.isFinished || (this.sequencer.paused && this.sequencerPlaying)) {
        this.sequencerPlaying = false;
        clearInterval(this.sequencerWatchdogTimer);
        this.sequencerWatchdogTimer = null;
        this.stopAll(true);
        const cb = this.sequencerEndedCallback;
        if (cb) cb();
      }
    }, 150);

    this.notifyListeners();
    return true;
  }

  public pauseSequencer() {
    this.sequencerPlaying = false;
    if (this.sequencerWatchdogTimer) {
      clearInterval(this.sequencerWatchdogTimer);
      this.sequencerWatchdogTimer = null;
    }
    try {
      this.sequencer?.pause();
    } catch {}
    this.stopAll(true);
    this.sendAllNotesOffToMidiOut();
  }

  public seekSequencer(ratio0to1: number) {
    if (!this.sequencer) return;
    const clamped = Math.max(0, Math.min(0.995, ratio0to1));
    const dur = Math.max(0.5, this.sequencer.duration || this.currentSequenceMetadata?.durationSeconds || 10);
    this.stopAll(true);
    this.sendAllNotesOffToMidiOut();
    try {
      this.sequencer.currentTime = clamped * dur;
    } catch {}
  }

  public setSequencerPlaybackRate(rate: number) {
    if (!this.sequencer) return;
    try {
      this.sequencer.playbackRate = Math.max(0.25, Math.min(4.0, rate || 1));
    } catch {}
  }

  public isSequencerPlaying(): boolean {
    return this.sequencerPlaying && Boolean(this.sequencer && !this.sequencer.paused);
  }

  public getSequencerProgress(rate = 1): {
    play: boolean;
    currentTime: number;
    duration: number;
    ratio: number;
    elapsedSeconds: number;
    totalSeconds: number;
  } {
    const seq = this.sequencer;
    const baseDur = Math.max(0.5, seq?.duration || this.currentSequenceMetadata?.durationSeconds || 10);
    const rawCur = Math.max(0, Math.min(baseDur, seq ? seq.currentHighResolutionTime : 0));
    const ratio = Math.max(0, Math.min(1, rawCur / baseDur));
    const safeRate = Math.max(0.25, Math.min(4.0, rate || 1));
    const scaledTotal = Math.max(0.5, baseDur / safeRate);
    return {
      play: this.sequencerPlaying,
      currentTime: rawCur,
      duration: baseDur,
      ratio,
      elapsedSeconds: ratio * scaledTotal,
      totalSeconds: scaledTotal
    };
  }

  public exportCurrentBasicMIDIAsMid(): { filename: string; bytes: number } | null {
    const midi = this.currentBasicMIDI;
    if (!midi) return null;

    const midiBinary = midi.writeMIDI();
    const rawName = this.currentOriginalFileName || this.currentSequenceMetadata?.title || 'aria48_song';
    const baseName = rawName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-\s.]/g, '_').trim() || 'aria48_song';
    const downloadName = baseName.endsWith('_converted') ? `${baseName}.mid` : `${baseName}_converted.mid`;

    const blob = new Blob([midiBinary], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    this.emitLog(`Exported Standard MIDI: ${downloadName} (${(midiBinary.byteLength / 1024).toFixed(1)} KB)`);
    return { filename: downloadName, bytes: midiBinary.byteLength };
  }

  // --- WEB MIDI INPUT & OUTPUT (EXTERNAL KEYBOARDS & SYNTHS) ---

  public async requestWebMidiAccess(): Promise<WebMidiState> {
    if (this.midiAccess) {
      this.refreshWebMidiPorts();
      return this.getWebMidiState();
    }
    if (this.midiInitPromise) return this.midiInitPromise;

    this.midiInitPromise = (async () => {
      if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
        this.webMidiState = {
          ...this.webMidiState,
          supported: false,
          status: 'unsupported',
          sandboxBlocked: false,
          errorMessage: 'Web MIDI API (navigator.requestMIDIAccess) is not supported in this browser.'
        };
        this.emitLog('[WEB MIDI] Browser does not support navigator.requestMIDIAccess.');
        this.notifyListeners();
        return this.getWebMidiState();
      }

      try {
        let access: MIDIAccess | null = null;
        let sysexOk = false;
        try {
          access = await navigator.requestMIDIAccess({ sysex: true });
          sysexOk = Boolean(access.sysexEnabled);
        } catch (sysexErr: any) {
          // Retry without SysEx only if basic Web MIDI is permitted while SysEx prompt was declined
          const msg = String(sysexErr?.message || '');
          if (msg.toLowerCase().includes('sysex')) {
            access = await navigator.requestMIDIAccess({ sysex: false });
            sysexOk = false;
          } else {
            throw sysexErr;
          }
        }

        this.midiAccess = access;
        this.webMidiState = {
          ...this.webMidiState,
          supported: true,
          status: 'ready',
          sysexEnabled: sysexOk,
          sandboxBlocked: false,
          errorMessage: null
        };

        access.onstatechange = () => {
          this.refreshWebMidiPorts();
        };

        this.refreshWebMidiPorts();
        this.emitLog(
          `[WEB MIDI] Connected (SysEx: ${sysexOk ? 'ENABLED' : 'STANDARD'}) — ${this.webMidiState.inputs.length} input(s), ${this.webMidiState.outputs.length} output(s)`
        );
      } catch (err: any) {
        const rawMsg = err?.message || 'Permission denied or blocked by iframe sandbox policy.';
        const inIframe = typeof window !== 'undefined' && window.self !== window.top;
        const isSecurityOrPolicy =
          err?.name === 'SecurityError' ||
          rawMsg.toLowerCase().includes('policy') ||
          rawMsg.toLowerCase().includes('sandbox') ||
          rawMsg.toLowerCase().includes('permission') ||
          inIframe;

        this.webMidiState = {
          ...this.webMidiState,
          status: 'blocked',
          sandboxBlocked: isSecurityOrPolicy,
          errorMessage: isSecurityOrPolicy
            ? `Web MIDI access blocked by preview iframe sandbox permissions (${rawMsg}). Open Aria48 Tracker in a standalone browser tab for native hardware/virtual MIDI ports.`
            : `Web MIDI error: ${rawMsg}`
        };
        this.emitLog(`[WEB MIDI BLOCKED] ${this.webMidiState.errorMessage}`);
      } finally {
        this.midiInitPromise = null;
        this.notifyListeners();
      }

      return this.getWebMidiState();
    })();

    return this.midiInitPromise;
  }

  public refreshWebMidiPorts() {
    if (!this.midiAccess) return;

    const inputs: WebMidiPortInfo[] = [];
    this.midiAccess.inputs.forEach((inp) => {
      inputs.push({
        id: inp.id,
        name: inp.name || `MIDI Input (${inp.id.slice(0, 6)})`,
        manufacturer: inp.manufacturer || 'Generic',
        state: inp.state,
        connection: inp.connection
      });
    });

    const outputs: WebMidiPortInfo[] = [];
    this.midiAccess.outputs.forEach((out) => {
      outputs.push({
        id: out.id,
        name: out.name || `MIDI Output (${out.id.slice(0, 6)})`,
        manufacturer: out.manufacturer || 'Generic',
        state: out.state,
        connection: out.connection
      });
    });

    let nextInputId = this.webMidiState.selectedInputId;
    if (nextInputId && !inputs.some(i => i.id === nextInputId)) {
      nextInputId = '';
    }
    if (!nextInputId && inputs.length > 0) {
      nextInputId = inputs[0].id;
    }

    let nextOutputId = this.webMidiState.selectedOutputId;
    if (nextOutputId && !outputs.some(o => o.id === nextOutputId)) {
      nextOutputId = '';
    }
    if (!nextOutputId && outputs.length > 0) {
      nextOutputId = outputs[0].id;
    }

    this.webMidiState = {
      ...this.webMidiState,
      inputs,
      outputs,
      selectedInputId: nextInputId,
      selectedOutputId: nextOutputId
    };

    this.attachActiveMidiInput();
    this.syncSequencerMidiOutput();
    this.notifyListeners();
  }

  private attachActiveMidiInput() {
    if (this.attachedMidiInput) {
      this.attachedMidiInput.onmidimessage = null;
      this.attachedMidiInput = null;
    }
    if (!this.midiAccess || !this.webMidiState.selectedInputId) return;

    const inp = this.midiAccess.inputs.get(this.webMidiState.selectedInputId);
    if (!inp) return;

    try {
      void inp.open?.();
    } catch {}

    inp.onmidimessage = (ev: MIDIMessageEvent) => {
      this.handleIncomingWebMidiMessage(ev);
    };
    this.attachedMidiInput = inp;
  }

  private handleIncomingWebMidiMessage(ev: MIDIMessageEvent) {
    const data = ev.data;
    if (!data || data.length === 0) return;

    const status = data[0];
    // Ignore MIDI active sensing / timing clock flooding (0xF8..0xFF)
    if (status >= 0xf8) return;

    if (!this.webMidiState.midiThruEnabled) return;

    // Ensure AudioContext resumes smoothly on first keystroke
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {});
    }
    if (!this.synth) {
      void this.init();
    }

    if (status === 0xf0) {
      // SysEx message (strip leading 0xF0 for SpessaSynth systemExclusive)
      const sysexPayload = Array.from(data.slice(1));
      this.synth?.systemExclusive(sysexPayload, 0);
      if (this.webMidiState.midiOutEnabled) {
        this.sendToSelectedMidiOutput(Array.from(data));
      }
      this.webMidiState.lastInputActivity = `SysEx (${data.length} bytes)`;
      this.emitLog(`[MIDI IN] SysEx (${data.length} bytes) -> WorkletSynthesizer`);
      this.notifyListeners();
      return;
    }

    const cmd = status & 0xf0;
    const ch = status & 0x0f;
    const filter = this.webMidiState.inputChannelFilter;
    if (filter !== 'all' && ch !== filter) return;

    const d1 = data.length > 1 ? data[1] & 0x7f : 0;
    const d2 = data.length > 2 ? data[2] & 0x7f : 0;

    if (cmd === 0x90) {
      if (d2 > 0) {
        const curvedVel = this.mapVelocityWithCurve(ch, d2);
        this.synth?.noteOn(ch, d1, curvedVel);
        if (this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
          this.sendToSelectedMidiOutput([0x90 | ch, d1, curvedVel]);
        }
        this.webMidiState.lastInputActivity = `CH${ch + 1} NoteOn #${d1} vel=${d2}`;
      } else {
        this.synth?.noteOff(ch, d1);
        if (this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
          this.sendToSelectedMidiOutput([0x80 | ch, d1, 0]);
        }
        this.webMidiState.lastInputActivity = `CH${ch + 1} NoteOff #${d1}`;
      }
      this.notifyListeners();
    } else if (cmd === 0x80) {
      this.synth?.noteOff(ch, d1);
      if (this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
        this.sendToSelectedMidiOutput([0x80 | ch, d1, 0]);
      }
      this.webMidiState.lastInputActivity = `CH${ch + 1} NoteOff #${d1}`;
      this.notifyListeners();
    } else if (cmd === 0xb0) {
      this.synth?.controllerChange(ch, d1 as MIDIController, d2);
      if (this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
        this.sendToSelectedMidiOutput([0xb0 | ch, d1, d2]);
      }
      this.webMidiState.lastInputActivity = `CH${ch + 1} CC ${d1} = ${d2}`;
      this.notifyListeners();
    } else if (cmd === 0xc0) {
      this.synth?.programChange(ch, d1);
      if (this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
        this.sendToSelectedMidiOutput([0xc0 | ch, d1]);
      }
      this.webMidiState.lastInputActivity = `CH${ch + 1} Program ${d1}`;
      this.notifyListeners();
    } else if (cmd === 0xe0) {
      const val14 = (d2 << 7) | d1;
      this.synth?.pitchWheel(ch, val14);
      if (this.sequencerExternalHandlingActive() && this.webMidiState.midiOutEnabled) {
        this.sendToSelectedMidiOutput([0xe0 | ch, d1, d2]);
      }
      this.webMidiState.lastInputActivity = `CH${ch + 1} PitchBend ${val14 - 8192}`;
      this.notifyListeners();
    }
  }

  public setSelectedMidiInputId(id: string) {
    this.webMidiState = { ...this.webMidiState, selectedInputId: id };
    this.attachActiveMidiInput();
    this.notifyListeners();
  }

  public setMidiThruEnabled(enabled: boolean) {
    this.webMidiState = { ...this.webMidiState, midiThruEnabled: enabled };
    this.emitLog(`[WEB MIDI] MIDI Thru ${enabled ? 'ENABLED' : 'DISABLED'}`);
    this.notifyListeners();
  }

  public setInputChannelFilter(filter: 'all' | number) {
    this.webMidiState = { ...this.webMidiState, inputChannelFilter: filter };
    this.emitLog(`[WEB MIDI] Input Channel Filter -> ${filter === 'all' ? 'All Channels (1–16)' : `Channel ${filter + 1}`}`);
    this.notifyListeners();
  }

  public setSelectedMidiOutputId(id: string) {
    this.sendAllNotesOffToMidiOut();
    this.webMidiState = { ...this.webMidiState, selectedOutputId: id };
    this.syncSequencerMidiOutput();
    this.notifyListeners();
  }

  public setMidiOutEnabled(enabled: boolean) {
    if (!enabled) {
      this.sendAllNotesOffToMidiOut();
    }
    this.webMidiState = { ...this.webMidiState, midiOutEnabled: enabled };
    this.syncSequencerMidiOutput();
    this.applyInternalSynthMuteState();
    this.emitLog(`[WEB MIDI] External MIDI Out ${enabled ? 'ENABLED' : 'DISABLED'}`);
    this.notifyListeners();
  }

  public setMuteInternalOnMidiOut(mute: boolean) {
    this.webMidiState = { ...this.webMidiState, muteInternalOnMidiOut: mute };
    this.syncSequencerMidiOutput();
    this.applyInternalSynthMuteState();
    this.emitLog(`[WEB MIDI] Mute Internal Synth on MIDI Out: ${mute ? 'ON' : 'OFF'}`);
    this.notifyListeners();
  }

  private getSelectedMidiOutputPort(): MIDIOutput | null {
    if (!this.midiAccess || !this.webMidiState.selectedOutputId) return null;
    return this.midiAccess.outputs.get(this.webMidiState.selectedOutputId) || null;
  }

  public sendToSelectedMidiOutput(bytes: number[]) {
    if (!this.webMidiState.midiOutEnabled || !bytes || bytes.length === 0) return;
    const out = this.getSelectedMidiOutputPort();
    if (!out) return;

    // Skip SysEx if browser did not grant SysEx permission (avoids InvalidAccessError)
    if (bytes[0] === 0xf0 && !this.webMidiState.sysexEnabled) return;

    try {
      void out.open?.();
      out.send(bytes);
      const status = bytes[0];
      const cmd = status & 0xf0;
      const ch = (status & 0x0f) + 1;
      if (status === 0xf0) {
        this.webMidiState.lastOutputActivity = `SysEx (${bytes.length}B) -> ${out.name || 'MIDI Out'}`;
      } else if (cmd === 0x90 && bytes[2] > 0) {
        this.webMidiState.lastOutputActivity = `CH${ch} NoteOn #${bytes[1]} -> ${out.name || 'MIDI Out'}`;
      } else if (cmd === 0xc0) {
        this.webMidiState.lastOutputActivity = `CH${ch} Prog #${bytes[1]} -> ${out.name || 'MIDI Out'}`;
      } else if (cmd === 0xb0) {
        this.webMidiState.lastOutputActivity = `CH${ch} CC${bytes[1]}=${bytes[2]} -> ${out.name || 'MIDI Out'}`;
      }
    } catch (err) {
      console.warn('MIDIOutput send note:', err);
    }
  }

  private sendAllNotesOffToMidiOut() {
    const out = this.getSelectedMidiOutputPort();
    if (!out) return;
    try {
      for (let ch = 0; ch < 16; ch++) {
        out.send([0xb0 | ch, 64, 0]);
        out.send([0xb0 | ch, 120, 0]);
        out.send([0xb0 | ch, 123, 0]);
      }
    } catch {}
  }

  private syncSequencerMidiOutput() {
    const seq = this.sequencer;
    if (!seq) return;

    if (this.boundOutputProxy) {
      try { seq.disconnectMIDIOutput(this.boundOutputProxy); } catch {}
      this.boundOutputProxy = null;
    }

    const out = this.getSelectedMidiOutputPort();
    if (this.webMidiState.midiOutEnabled && out) {
      const proxy = {
        send: (data: number[]) => {
          this.sendToSelectedMidiOutput(data);
        }
      };
      this.boundOutputProxy = proxy;
      try {
        seq.connectMIDIOutput(proxy, 0);
        seq.externalMIDIPlayback = Boolean(this.webMidiState.muteInternalOnMidiOut);
      } catch (e) {
        console.warn('Sequencer MIDI output attach note:', e);
      }
    } else {
      seq.externalMIDIPlayback = false;
    }
  }
}

export const WorkletSynthBridge = new WorkletSynthController();
