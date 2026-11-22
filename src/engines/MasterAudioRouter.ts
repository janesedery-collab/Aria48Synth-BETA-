/**
 * MasterAudioRouter.ts
 * Unified AudioContext + 5-Engine Master Bus & Automatic Instrument/File Router
 * for Aria 48 Tracker.
 *
 * Connects all five engines into a single master mixer + limiter + spectrum/oscilloscope analyzer:
 *   1. FURNACE    (AriaFurnaceNode / aria_furnace_all.js WASM DivEngine chips)
 *   2. SF2/SFE    (SpessaSynthBridge spessasynth_core + spessasynth_lib worklet)
 *   3. TINYRSID   (TinyRSIDBridge WebSID C64 6581/8580 WASM + tinyrsid-worklet)
 *   4. SUNVOX     (SunVoxBridge sv_audio_callback + sunvox-worklet)
 *   5. TINYSYNTH  (TinySynthBridge keeping WebAudioTinySynth native oscillators intact)
 */

import { Channel, EngineKind, WasmBundleSlot } from '../types';
import { FurnaceBridge, FURNACE_DEFAULT_JS_URL, FURNACE_DEFAULT_WASM_URL } from './FurnaceBridge';
import { SpessaSynthAdapter } from './SpessaSynthBridge';
import { TinyRSIDAdapter } from './TinyRSIDAdapter';
import { SunVoxAdapter, SUNVOX_JS_URL, SUNVOX_WASM_URL } from './SunVoxAdapter';
import { TinySynthBridge } from './TinySynthBridge';
import {
  NesWorkletEngine,
  NES_WORKLET_PROCESSOR_URL,
  NES_APU_WASM_URL,
} from './NesWorkletEngine';

export interface EngineBusDescriptor {
  kind: EngineKind;
  gainNode: GainNode;
  analyser: AnalyserNode;
  enabled: boolean;
  gainValue: number;
}

class MasterAudioRouterEngine {
  private ctx: AudioContext | null = null;
  private buses = new Map<EngineKind, EngineBusDescriptor>();
  private busConfig = new Map<EngineKind, { enabled: boolean; gain: number }>([
    ['FURNACE', { enabled: true, gain: 1.0 }],
    ['FAMITRACKER', { enabled: true, gain: 0.95 }],
    ['SF2/SFE', { enabled: true, gain: 0.9 }],
    ['TINYRSID', { enabled: true, gain: 0.95 }],
    ['SUNVOX', { enabled: true, gain: 0.95 }],
    ['TINYSYNTH', { enabled: true, gain: 0.65 }],
  ]);
  private masterMixBus: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private timeDomainScratch = new Float32Array(1024);
  private spectrumScratch = new Uint8Array(512);
  private initialized = false;
  private listeners: Array<() => void> = [];

  public subscribe(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  private notify() {
    this.listeners.forEach((cb) => {
      try { cb(); } catch {}
    });
  }

  public init(ctx: AudioContext): AudioContext {
    if (this.initialized && this.ctx === ctx) return ctx;
    this.ctx = ctx;

    this.masterMixBus = ctx.createGain();
    this.masterMixBus.gain.setValueAtTime(1.0, ctx.currentTime);

    this.masterLimiter = ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.setValueAtTime(-4, ctx.currentTime);
    this.masterLimiter.knee.setValueAtTime(6, ctx.currentTime);
    this.masterLimiter.ratio.setValueAtTime(12, ctx.currentTime);
    this.masterLimiter.attack.setValueAtTime(0.002, ctx.currentTime);
    this.masterLimiter.release.setValueAtTime(0.08, ctx.currentTime);

    this.masterGain = ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.95, ctx.currentTime);

    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.masterAnalyser.smoothingTimeConstant = 0.78;
    this.timeDomainScratch = new Float32Array(this.masterAnalyser.fftSize);
    this.spectrumScratch = new Uint8Array(this.masterAnalyser.frequencyBinCount);

    this.masterMixBus.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterGain);
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(ctx.destination);

    this.busConfig.forEach((cfg, kind) => {
      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(cfg.enabled ? cfg.gain : 0, ctx.currentTime);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;
      gainNode.connect(analyser);
      analyser.connect(this.masterMixBus!);
      this.buses.set(kind, {
        kind,
        gainNode,
        analyser,
        enabled: cfg.enabled,
        gainValue: cfg.gain,
      });
    });

    this.initialized = true;

    // Attach engine nodes asynchronously without blocking UI
    void FurnaceBridge.attachToMasterRouter(ctx, this.getEngineInput('FURNACE')!);
    void NesWorkletEngine.attachToMasterRouter(ctx, this.getEngineInput('FAMITRACKER')!);
    void SpessaSynthAdapter.attachToMasterRouter(ctx, this.getEngineInput('SF2/SFE')!);
    void TinyRSIDAdapter.attachToMasterRouter(ctx, this.getEngineInput('TINYRSID')!);
    void SunVoxAdapter.attachToMasterRouter(ctx, this.getEngineInput('SUNVOX')!);

    return ctx;
  }

  public getAudioContext(): AudioContext | null {
    return this.ctx;
  }

  public getEngineInput(kind: EngineKind): GainNode | null {
    return this.buses.get(kind)?.gainNode || null;
  }

  public getEngineAnalyser(kind: EngineKind): AnalyserNode | null {
    return this.buses.get(kind)?.analyser || null;
  }

  public getMasterAnalyser(): AnalyserNode | null {
    return this.masterAnalyser;
  }

  public getMasterTimeDomain(): Float32Array {
    if (this.masterAnalyser) {
      this.masterAnalyser.getFloatTimeDomainData(this.timeDomainScratch);
    }
    return this.timeDomainScratch;
  }

  public getMasterSpectrum(): Uint8Array {
    if (this.masterAnalyser) {
      this.masterAnalyser.getByteFrequencyData(this.spectrumScratch);
    }
    return this.spectrumScratch;
  }

  public setEngineEnabled(kind: EngineKind, enabled: boolean) {
    const cfg = this.busConfig.get(kind);
    if (cfg) cfg.enabled = enabled;
    const bus = this.buses.get(kind);
    if (bus) {
      bus.enabled = enabled;
      if (this.ctx) {
        bus.gainNode.gain.setValueAtTime(enabled ? bus.gainValue : 0, this.ctx.currentTime);
      }
    }
    if (kind === 'FURNACE') FurnaceBridge.setEngineEnabled(enabled);
    if (kind === 'FAMITRACKER') NesWorkletEngine.setEngineEnabled(enabled);
    if (kind === 'TINYSYNTH') TinySynthBridge.setEnabled(enabled);
    this.notify();
  }

  public setEngineGain(kind: EngineKind, gain: number) {
    const clamped = Math.max(0, Math.min(2.0, gain));
    const cfg = this.busConfig.get(kind);
    if (cfg) cfg.gain = clamped;
    const bus = this.buses.get(kind);
    if (bus) {
      bus.gainValue = clamped;
      if (this.ctx && bus.enabled) {
        bus.gainNode.gain.setValueAtTime(clamped, this.ctx.currentTime);
      }
    }
    this.notify();
  }

  public setMasterVolume(volumeRatio: number) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1.5, volumeRatio)), this.ctx.currentTime);
    }
  }

  /**
   * Determines which engine owns a given uploaded file extension.
   */
  public detectEngineForFile(fileName: string): EngineKind {
    const lower = (fileName || '').toLowerCase();
    if (lower.endsWith('.ftm') || lower.endsWith('.0cc') || lower.endsWith('.dnm')) {
      return 'FAMITRACKER';
    }
    if (lower.endsWith('.fur') || lower.endsWith('.fui') || lower.endsWith('.fuw') || lower.endsWith('.dmp') || lower.endsWith('.opm')) {
      return 'FURNACE';
    }
    if (lower.endsWith('.sid') || lower.endsWith('.mus') || lower.endsWith('.str')) {
      return 'TINYRSID';
    }
    if (lower.endsWith('.sunvox') || lower.endsWith('.sunsynth')) {
      return 'SUNVOX';
    }
    if (lower.endsWith('.sf2') || lower.endsWith('.sf3') || lower.endsWith('.sfe') || lower.endsWith('.dls') || lower.endsWith('.sfz')) {
      return 'SF2/SFE';
    }
    if (lower.endsWith('.mid') || lower.endsWith('.midi') || lower.endsWith('.rmi') || lower.endsWith('.kar') || lower.endsWith('.mod') || lower.endsWith('.xm') || lower.endsWith('.s3m')) {
      return 'SF2/SFE';
    }
    return 'FURNACE';
  }

  /**
   * Determines target synthesis engine based on channel chip / instrument slot.
   */
  public detectEngineForChannel(ch?: Partial<Channel>): EngineKind {
    const chip = (ch?.chip || '').toLowerCase();
    const preset = (ch?.soundFontPreset || '').toLowerCase();
    if (chip.includes('sunvox')) return 'SUNVOX';
    if (preset.startsWith('tiny_') || chip.includes('tinysynth')) {
      return 'TINYSYNTH';
    }
    if (chip.includes('soundfont') || chip.includes('midi') || preset.startsWith('gm_')) {
      return 'SF2/SFE';
    }
    if (
      !preset.startsWith('fur_') &&
      !chip.includes('furnace') &&
      (chip.includes('famitracker') ||
        chip.includes('rp2a03') ||
        chip.includes('vrc6') ||
        chip.includes('vrc7') ||
        chip.includes('fds') ||
        chip.includes('n163') ||
        chip.includes('namco 163') ||
        chip.includes('sunsoft 5b'))
    ) {
      return 'FAMITRACKER';
    }
    if (
      preset.startsWith('fur_') ||
      chip.includes('furnace') ||
      chip.includes('ym2612') ||
      chip.includes('ymf262') ||
      chip.includes('opl3') ||
      chip.includes('ym2151') ||
      chip.includes('sn76489') ||
      chip.includes('dmg') ||
      chip.includes('spc700') ||
      chip.includes('huc6280') ||
      chip.includes('ay') ||
      chip.includes('pokey') ||
      chip.includes('scc')
    ) {
      return 'FURNACE';
    }
    if (chip.includes('sid') || chip.includes('6581') || chip.includes('8580')) {
      return TinyRSIDAdapter.getBundleStatus().status === 'ready' ? 'TINYRSID' : 'FURNACE';
    }
    if (preset.length > 0) {
      return 'SF2/SFE';
    }
    return 'FURNACE';
  }

  /**
   * Routes a note-on event directly to the selected or auto-detected engine.
   */
  public routeNoteOn(
    channelId: number,
    midiNote: number,
    velocity: number,
    options?: {
      engine?: EngineKind;
      channel?: Partial<Channel>;
      durationSec?: number;
      program?: number;
      furnaceInstIdx?: number;
    }
  ): EngineKind {
    const engine = options?.engine || this.detectEngineForChannel(options?.channel);
    const ch0 = Math.max(0, channelId - 1);
    if (engine === 'FAMITRACKER') {
      void NesWorkletEngine.previewNote(
        ch0,
        midiNote,
        velocity,
        options?.channel?.chip,
        options?.durationSec ?? 0.25
      );
    } else if (engine === 'FURNACE') {
      FurnaceBridge.noteOn(ch0, midiNote, velocity, options?.furnaceInstIdx);
    } else if (engine === 'TINYSYNTH') {
      TinySynthBridge.noteOn(ch0 % 16, midiNote, velocity, options?.program);
    } else if (engine === 'SF2/SFE') {
      SpessaSynthAdapter.noteOn(ch0, midiNote, velocity, options?.durationSec ?? 0.25, options?.program);
    }
    return engine;
  }

  public routeNoteOff(channelId: number, midiNote?: number, engine: EngineKind = 'FURNACE') {
    const ch0 = Math.max(0, channelId - 1);
    if (engine === 'FAMITRACKER') {
      NesWorkletEngine.stopPreviewChannel(ch0);
    } else if (engine === 'FURNACE') {
      FurnaceBridge.noteOff(ch0);
    } else if (engine === 'TINYSYNTH' && midiNote !== undefined) {
      TinySynthBridge.noteOff(ch0 % 16, midiNote);
    } else if (engine === 'SF2/SFE') {
      SpessaSynthAdapter.noteOff(ch0, midiNote);
    }
  }

  public routeEffect(channelId: number, fxToken: string, engine: EngineKind = 'FURNACE') {
    const ch0 = Math.max(0, channelId - 1);
    if (engine === 'FURNACE') {
      FurnaceBridge.sendEffect(ch0, fxToken);
    }
  }

  public getBusStatusList() {
    return Array.from(this.busConfig.entries()).map(([kind, cfg]) => {
      const bus = this.buses.get(kind);
      return {
        kind,
        enabled: bus ? bus.enabled : cfg.enabled,
        gain: bus ? bus.gainValue : cfg.gain,
      };
    });
  }

  /**
   * Returns inspectable WASM bundle state for the WASM Engine Manager Modal.
   */
  public getWasmBundles(): WasmBundleSlot[] {
    const fur = FurnaceBridge.getState();
    const sid = TinyRSIDAdapter.getBundleStatus();
    const sv = SunVoxAdapter.getBundleStatus();
    const nes = NesWorkletEngine.getBundleStatus();

    return [
      {
        id: 'famitracker',
        label: 'Bitphase NES APU / FamiTracker (nes_apu.wasm)',
        defaultJsUrl: NES_WORKLET_PROCESSOR_URL,
        defaultWasmUrl: NES_APU_WASM_URL,
        customJsName: nes.label,
        status: nes.status,
        error: nes.error,
      },
      {
        id: 'furnace',
        label: 'Furnace Headless (aria_furnace_all.js)',
        defaultJsUrl: FURNACE_DEFAULT_JS_URL,
        defaultWasmUrl: FURNACE_DEFAULT_WASM_URL,
        customJsName: fur.wasmSourceLabel,
        status: fur.wasmStatus,
        error: fur.wasmError,
      },
      {
        id: 'tinyrsid',
        label: 'TinyRSid / WebSID (tinyrsid.js)',
        defaultJsUrl: '/websid/tinyrsid.js',
        defaultWasmUrl: '/websid/websid.wasm',
        customJsName: sid.label,
        status: sid.status,
        error: sid.error,
      },
      {
        id: 'sunvox',
        label: 'SunVox 2.1.4 Modular (sunvox.js)',
        defaultJsUrl: SUNVOX_JS_URL,
        defaultWasmUrl: SUNVOX_WASM_URL,
        customJsName: sv.label,
        status: sv.status,
        error: sv.error,
      },
    ];
  }

  public async hotSwapWasmBundle(
    id: 'furnace' | 'tinyrsid' | 'sunvox' | 'famitracker',
    jsUrlOrBlob: string,
    wasmUrlOrBlob?: string,
    label?: string
  ): Promise<boolean> {
    let ok = false;
    if (id === 'famitracker') {
      ok = await NesWorkletEngine.tryLoadWasmFromUrl(wasmUrlOrBlob || NES_APU_WASM_URL, label);
    } else if (id === 'furnace') {
      ok = await FurnaceBridge.loadWasmBundle(jsUrlOrBlob, wasmUrlOrBlob, label);
    } else if (id === 'tinyrsid') {
      ok = await TinyRSIDAdapter.reloadWasmBundle(jsUrlOrBlob, wasmUrlOrBlob, label);
    } else if (id === 'sunvox') {
      ok = await SunVoxAdapter.reloadWasmBundle(jsUrlOrBlob, wasmUrlOrBlob, label);
    }
    this.notify();
    return ok;
  }
}

export const MasterAudioRouter = new MasterAudioRouterEngine();
