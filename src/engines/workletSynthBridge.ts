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

import { WorkletSynthesizer } from 'spessasynth_lib';
import {
  BasicSoundBank,
  InterpolationTypes,
  MIDIController,
  MIDIPatchFull
} from 'spessasynth_core';
import { SoundFontInterpolationMode } from '../types';
import { DEFAULT_GM_PROGRAMS } from './spressasynthLib';
import { getInterpolationMode } from './soundFontInterpolation';

export type VelocityCurveType = 'linear' | 'soft' | 'hard' | 'fixed';

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

  public getSynth(): WorkletSynthesizer | null {
    return this.synth;
  }

  public isReadySync(): boolean {
    return Boolean(this.synth && this.workletReady);
  }

  public hasSoundBankReady(): boolean {
    return Boolean(
      this.synth &&
      this.workletReady &&
      (this.defaultBankLoaded || this.customBanksLoaded.size > 0)
    );
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
    if (this.masterGain && this.audioCtx) {
      try {
        this.masterGain.gain.setTargetAtTime(this.targetMasterGainValue, this.audioCtx.currentTime, 0.01);
      } catch {
        this.masterGain.gain.value = this.targetMasterGainValue;
      }
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
          await ctx.audioWorklet.addModule('/spessasynth_processor.min.js');
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

        // Load minimal valid SF2 bank so presetList is always populated before custom SF2 uploads
        try {
          const defaultBankBuffer = BasicSoundBank.getSampleSoundBankFile().slice(0);
          await synth.soundBankManager.addSoundBank(defaultBankBuffer, 'aria-default-bank', 0);
          this.defaultBankLoaded = true;
        } catch (bankErr) {
          console.warn('Could not load default SpessaSynth sample bank:', bankErr);
        }

        // Apply active interpolation preference
        this.setInterpolationMode(getInterpolationMode());

        // Hydrate preset list once ready & SoundBank loaded
        if (synth.presetList && synth.presetList.length > 0) {
          this.presetList = this.sortPresets(synth.presetList);
        }

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
        this.masterGain.gain.setValueAtTime(this.targetMasterGainValue, ctx.currentTime);

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
      // Re-resolve displayed patch names against updated preset list
      this.channelStates.forEach((st) => {
        const match = this.findMatchingPreset(st.bankMSB, st.bankLSB, st.program, st.isDrum);
        if (match) {
          st.patchName = match.name;
        }
      });
      this.notifyListeners();
    });

    eh.addEvent('programChange', 'aria48-mixer-prog', (ev) => {
      const st = this.channelStates[ev.channel];
      if (!st) return;
      st.bankMSB = ev.bankMSB;
      st.bankLSB = ev.bankLSB;
      st.program = ev.program;
      st.isDrum = Boolean(ev.isDrum || ev.isGMGSDrum);
      st.patchName = ev.name || st.patchName;
      this.notifyListeners();
    });

    eh.addEvent('controllerChange', 'aria48-mixer-cc', (ev) => {
      const st = this.channelStates[ev.channel];
      if (!st) return;
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
    });

    eh.addEvent('channelParamChange', 'aria48-mixer-param', (ev) => {
      const st = this.channelStates[ev.channel];
      if (!st) return;
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
    });

    eh.addEvent('noteOn', 'aria48-mixer-noteon', (ev) => {
      const st = this.channelStates[ev.channel];
      if (!st) return;
      if (!st.activeNotes.includes(ev.midiNote)) {
        st.activeNotes.push(ev.midiNote);
        this.notifyListeners();
      }
    });

    eh.addEvent('noteOff', 'aria48-mixer-noteoff', (ev) => {
      const st = this.channelStates[ev.channel];
      if (!st) return;
      const idx = st.activeNotes.indexOf(ev.midiNote);
      if (idx !== -1) {
        st.activeNotes.splice(idx, 1);
        this.notifyListeners();
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
    return this.presetList.find(
      p => p.program === program && Boolean(p.isDrum) === Boolean(isDrum)
    );
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
    // Only native spessasynth_core binary soundbanks (.sf2, .sf3, .dls) go to WorkletSynthesizer's SoundBankManager
    const synth = await this.init();
    if (!synth) return false;
    try {
      const bankCopy = arrayBuffer.slice(0);
      await synth.soundBankManager.addSoundBank(bankCopy.slice(0), id, 0);
      this.customBanksLoaded.add(id);
      this.soundBankBuffers.set(id, bankCopy);
      if (makePrimary) {
        this.activeBankId = id;
        const rest = synth.soundBankManager.priorityOrder.filter(b => b !== id && b !== 'aria-default-bank');
        const nextOrder = [id, ...rest];
        if (this.defaultBankLoaded) nextOrder.push('aria-default-bank');
        synth.soundBankManager.priorityOrder = nextOrder;
      }
      if (synth.presetList?.length) {
        this.presetList = this.sortPresets(synth.presetList);
      }
      this.notifyListeners();
      this.emitLog(`Loaded SoundBank "${id}" into WorkletSynthesizer (${this.presetList.length} presets)`);
      return true;
    } catch (err) {
      // Non-SF2/SF3/DLS custom banks (e.g., SFZ/PAT/SBK) remain handled by JS SpessaSynthCore gracefully
      console.warn(`WorkletSynthesizer SoundBank note for "${lower}":`, err);
      return false;
    }
  }

  public setActiveSoundBank(id: string) {
    if (!this.synth) return;
    const order = this.synth.soundBankManager.priorityOrder;
    if (!order.includes(id)) return;
    this.activeBankId = id;
    const rest = order.filter(b => b !== id && b !== 'aria-default-bank');
    const nextOrder = [id, ...rest];
    if (this.defaultBankLoaded && id !== 'aria-default-bank') {
      nextOrder.push('aria-default-bank');
    }
    this.synth.soundBankManager.priorityOrder = nextOrder;
    if (this.synth.presetList?.length) {
      this.presetList = this.sortPresets(this.synth.presetList);
    }
    this.notifyListeners();
  }

  public async removeSoundBank(id: string) {
    if (!this.synth || id === 'aria-default-bank') return;
    if (!this.customBanksLoaded.has(id)) return;
    try {
      await this.synth.soundBankManager.deleteSoundBank(id);
      this.customBanksLoaded.delete(id);
      this.soundBankBuffers.delete(id);
      if (this.activeBankId === id) {
        this.activeBankId = this.synth.soundBankManager.priorityOrder[0] || 'aria-default-bank';
      }
      if (this.synth.presetList?.length) {
        this.presetList = this.sortPresets(this.synth.presetList);
      }
      this.notifyListeners();
    } catch (e) {}
  }

  public getActiveSoundBankBuffer(): ArrayBuffer {
    const active = this.soundBankBuffers.get(this.activeBankId);
    if (active && active.byteLength > 0) {
      return active.slice(0);
    }
    for (const buf of this.soundBankBuffers.values()) {
      if (buf && buf.byteLength > 0) {
        return buf.slice(0);
      }
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
    if (!this.synth) return;
    this.synth.systemExclusive(messageData, channelOffset);
  }

  // --- NOTE TRIGGERING & PLAYBACK SYNC ---

  public noteOn(channel: number, midiNote: number, velocity: number, atAudioTime?: number) {
    const ch = this.resolveTargetChannel(channel);
    const st = this.channelStates[ch];
    if (!this.synth || !this.workletReady || st?.isMuted) return;

    const curvedVel = this.mapVelocityWithCurve(ch, velocity);
    const opts = atAudioTime !== undefined && Number.isFinite(atAudioTime) ? { time: atAudioTime } : undefined;
    this.synth.noteOn(ch, midiNote, curvedVel, opts);
  }

  public noteOff(channel: number, midiNote: number, atAudioTime?: number) {
    const ch = this.resolveTargetChannel(channel);
    if (!this.synth || !this.workletReady) return;
    const opts = atAudioTime !== undefined && Number.isFinite(atAudioTime) ? { time: atAudioTime } : undefined;
    this.synth.noteOff(ch, midiNote, opts);
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

  public stopAll(force = false) {
    if (this.synth && this.workletReady) {
      this.synth.stopAll(force);
    }
    this.channelStates.forEach(s => { s.activeNotes = []; });
    this.notifyListeners();
  }

  // --- GLOBAL SYSTEM RESETS ---

  public sendGMSystemOn() {
    if (!this.synth) return;
    this.synth.systemExclusive([0x7e, 0x7f, 0x09, 0x01, 0xf7]);
    this.emitLog('Global SysEx: GM System On (F0 7E 7F 09 01 F7)');
  }

  public sendGSReset() {
    if (!this.synth) return;
    this.synth.systemExclusive([0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7]);
    this.emitLog('Global SysEx: Roland GS Reset (F0 41 10 42 12 40 00 7F 00 41 F7)');
  }

  public sendXGSystemOn() {
    if (!this.synth) return;
    this.synth.systemExclusive([0x43, 0x10, 0x4c, 0x00, 0x00, 0x7e, 0x00, 0xf7]);
    this.emitLog('Global SysEx: Yamaha XG System On (F0 43 10 4C 00 00 7E 00 F7)');
  }

  public sendAllSoundOff() {
    if (!this.synth) return;
    const count = this.synth.midiChannels.length || 16;
    for (let ch = 0; ch < count; ch++) {
      this.synth.controllerChange(ch, WORKLET_CC.ALL_SOUND_OFF as MIDIController, 0);
    }
    this.synth.stopAll(true);
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
}

export const WorkletSynthBridge = new WorkletSynthController();
