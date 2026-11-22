/**
 * src/engines/NesWorkletEngine.ts
 * Clean TypeScript wrapper for Aria48 Tracker's FamiTracker (.ftm / .0cc / .dnm)
 * & bitphase `public/nes/nes_apu.wasm` AudioWorklet synthesizer.
 *
 * - Initializes AudioWorkletNode (`public/audio/nes-worklet.js`)
 * - Fetches and hot-loads `public/nes/nes_apu.wasm` (or user-provided `.wasm`)
 * - Routes stereo PCM directly into Aria48's Web Audio GainNode mixer & AnalyserNode
 * - Exposes loadModule, play, pause, stop, seek, subsong, mute/solo & live channel telemetry
 */

import { Channel, WasmBundleStatus } from '../types';
import {
  FamiTrackerModule,
  NesChannelLiveState,
  NesMachineStandard,
  NesPlaybackState,
} from '../lib/chips/nes/types';
import {
  convertFamiTrackerToAriaPatterns,
  parseFamiTrackerBinary,
} from '../lib/chips/nes/famitrackerParser';

export const NES_WORKLET_PROCESSOR_URL = '/audio/nes-worklet.js';
export const NES_APU_WASM_URL = '/nes/nes_apu.wasm';
export const FAMITRACKER_ENGINE_ID = 'bitphase-nes-famitracker-wasm';

export class NesWorkletEngineController {
  public readonly engineId = FAMITRACKER_ENGINE_ID;

  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private outputGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private initPromise: Promise<boolean> | null = null;
  private registeredCtxs = new WeakSet<AudioContext>();

  private currentModule: FamiTrackerModule | null = null;
  private channelScopes: Float32Array[] = [];
  private listeners: Array<(state: NesPlaybackState) => void> = [];
  private engineEnabled = true;

  private state: NesPlaybackState = {
    isReady: false,
    wasmLoaded: false,
    wasmSource: 'Built-in 2A03 + Dn-FT Worklet DSP (optional nes_apu.wasm not loaded)',
    wasmError: null,
    hasModuleLoaded: false,
    moduleTitle: '',
    moduleAuthor: '',
    moduleFormat: null,
    isPlaying: false,
    isPaused: false,
    activeSongIndex: 0,
    subsongsCount: 1,
    subsongNames: ['Track 1'],
    currentOrder: 0,
    totalOrders: 1,
    currentRow: 0,
    rowsPerPattern: 64,
    bpm: 150,
    speed: 6,
    machine: 'NTSC',
    expansionMask: 0,
    expansions: ['2A03'],
    elapsedSeconds: 0,
    estimatedDurationSeconds: 0,
    masterVolume: 0.95,
    channels: [],
  };

  public subscribe(listener: (state: NesPlaybackState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  private notify() {
    const snap = this.getState();
    this.listeners.forEach((cb) => {
      try {
        cb(snap);
      } catch {}
    });
  }

  public getState(): NesPlaybackState {
    return {
      ...this.state,
      subsongNames: [...this.state.subsongNames],
      expansions: [...this.state.expansions],
      channels: this.state.channels.map((c) => ({ ...c })),
    };
  }

  public getOutputGainNode(): GainNode | null {
    return this.outputGain;
  }

  public getAnalyserNode(): AnalyserNode | null {
    return this.analyser;
  }

  public setEngineEnabled(enabled: boolean) {
    this.engineEnabled = enabled;
    if (this.outputGain && this.audioCtx) {
      this.outputGain.gain.setValueAtTime(
        enabled ? this.state.masterVolume : 0,
        this.audioCtx.currentTime
      );
    }
    if (!enabled && this.state.isPlaying) {
      this.pause();
    }
  }

  public setMasterVolume(ratio: number) {
    const clamped = Math.max(0, Math.min(1.5, ratio));
    this.state.masterVolume = clamped;
    if (this.outputGain && this.audioCtx && this.engineEnabled) {
      this.outputGain.gain.setValueAtTime(clamped, this.audioCtx.currentTime);
    }
    this.notify();
  }

  public routeOutputTo(destination: AudioNode) {
    if (!this.analyser && !this.outputGain) return;
    const source = this.analyser || this.outputGain!;
    try {
      source.disconnect();
    } catch {}
    try {
      source.connect(destination);
    } catch {}
  }

  public async attachToMasterRouter(ctx: AudioContext, destinationBus: AudioNode): Promise<boolean> {
    const ok = await this.init(ctx, destinationBus);
    this.routeOutputTo(destinationBus);
    return ok;
  }

  public async init(ctx: AudioContext, destinationBus?: AudioNode): Promise<boolean> {
    if (typeof window === 'undefined' || !ctx?.audioWorklet) return false;
    if (this.workletNode && this.audioCtx === ctx) {
      if (destinationBus) this.routeOutputTo(destinationBus);
      return true;
    }
    if (this.initPromise) return this.initPromise;

    this.audioCtx = ctx;
    this.initPromise = (async () => {
      try {
        if (!this.outputGain) {
          this.outputGain = ctx.createGain();
          this.outputGain.gain.setValueAtTime(
            this.engineEnabled ? this.state.masterVolume : 0,
            ctx.currentTime
          );
        }
        if (!this.analyser) {
          this.analyser = ctx.createAnalyser();
          this.analyser.fftSize = 1024;
          this.analyser.smoothingTimeConstant = 0.72;
          this.outputGain.connect(this.analyser);
        }
        this.analyser.connect(destinationBus || ctx.destination);

        if (!this.registeredCtxs.has(ctx)) {
          await ctx.audioWorklet.addModule(NES_WORKLET_PROCESSOR_URL);
          this.registeredCtxs.add(ctx);
        }

        const node = new AudioWorkletNode(ctx, 'aria-nes-worklet-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.port.onmessage = (ev) => this.handleWorkletMessage(ev.data);
        node.connect(this.outputGain);
        this.workletNode = node;
        this.state.isReady = true;

        // If a module was staged before AudioContext unlock, push it into the worklet now
        if (this.currentModule) {
          this.workletNode.port.postMessage({
            type: 'loadModule',
            module: this.currentModule,
            songIndex: this.state.activeSongIndex,
          });
        }

        // Automatically probe public/nes/nes_apu.wasm if the user copied bitphase WASM files
        void this.tryLoadWasmFromUrl(NES_APU_WASM_URL);
        this.notify();
        return true;
      } catch (err: any) {
        this.state.wasmError = err?.message || 'AudioWorklet initialization error';
        this.notify();
        return false;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  public async tryLoadWasmFromUrl(url = NES_APU_WASM_URL, label?: string): Promise<boolean> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return false;
      const contentType = resp.headers.get('content-type') || '';
      const bytes = await resp.arrayBuffer();
      if (bytes.byteLength < 64) return false;
      // Verify WASM magic header \0asm
      const magic = new Uint8Array(bytes, 0, 4);
      if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
        if (!contentType.includes('wasm')) return false;
      }
      return await this.loadWasmBuffer(bytes, label || url);
    } catch {
      return false;
    }
  }

  public async loadWasmBuffer(wasmBuffer: ArrayBuffer, label = 'nes_apu.wasm'): Promise<boolean> {
    if (!this.workletNode) return false;
    const copy = wasmBuffer.slice(0);
    this.state.wasmSource = label;
    this.workletNode.port.postMessage({ type: 'loadWasm', buffer: copy }, [copy]);
    return true;
  }

  private handleWorkletMessage(msg: any) {
    if (!msg || !msg.type) return;
    if (msg.type === 'wasmStatus') {
      this.state.wasmLoaded = Boolean(msg.loaded);
      this.state.wasmError = msg.error || null;
      if (msg.loaded && msg.source) {
        this.state.wasmSource = msg.source;
      }
      this.notify();
    } else if (msg.type === 'state') {
      this.state.isPlaying = Boolean(msg.isPlaying);
      this.state.isPaused = Boolean(msg.isPaused);
      this.state.activeSongIndex = msg.activeSongIndex ?? this.state.activeSongIndex;
      this.state.currentOrder = msg.currentOrder ?? this.state.currentOrder;
      this.state.currentRow = msg.currentRow ?? this.state.currentRow;
      this.state.speed = msg.speed ?? this.state.speed;
      if (msg.tempo) {
        this.state.bpm = Math.max(
          40,
          Math.min(300, Math.round((msg.tempo * 6) / Math.max(1, this.state.speed)))
        );
      }
      this.state.elapsedSeconds = msg.elapsedSeconds ?? this.state.elapsedSeconds;

      const lvls: number[] = msg.channelLevels || [];
      const notes: string[] = msg.channelNotes || [];
      const vols: number[] = msg.channelVolumes || [];
      const insts: number[] = msg.channelInsts || [];

      this.state.channels = this.state.channels.map((ch, idx) => ({
        ...ch,
        level: lvls[idx] ?? 0,
        activeNote: notes[idx] ?? ch.activeNote,
        volume: vols[idx] ?? ch.volume,
        activeInstrument: insts[idx] ?? ch.activeInstrument,
      }));

      const incomingScopes: number[][] = msg.scopes || [];
      for (let i = 0; i < incomingScopes.length; i++) {
        if (!this.channelScopes[i] || this.channelScopes[i].length !== incomingScopes[i].length) {
          this.channelScopes[i] = new Float32Array(incomingScopes[i].length);
        }
        this.channelScopes[i].set(incomingScopes[i]);
      }

      this.notify();
    }
  }

  public loadModule(arrayBuffer: ArrayBuffer, fileName = 'module.ftm'): FamiTrackerModule {
    const mod = parseFamiTrackerBinary(arrayBuffer, fileName);
    this.currentModule = mod;
    const conv = convertFamiTrackerToAriaPatterns(mod, 0);
    const song0 = mod.songs[0];

    const liveChannels: NesChannelLiveState[] = mod.channels.map((ch) => ({
      index: ch.index,
      name: ch.name,
      shortName: ch.shortName,
      chip: ch.chip,
      enabled: true,
      muted: false,
      solo: false,
      activeNote: '---',
      activeInstrument: -1,
      volume: 15,
      level: 0,
      triggerAge: 0,
    }));

    this.state = {
      ...this.state,
      hasModuleLoaded: true,
      moduleTitle: mod.title,
      moduleAuthor: mod.author,
      moduleFormat: mod.format,
      isPlaying: false,
      isPaused: false,
      activeSongIndex: 0,
      subsongsCount: mod.songs.length,
      subsongNames: mod.songs.map((s) => s.name),
      currentOrder: 0,
      totalOrders: Math.max(1, song0?.frameList.length || 1),
      currentRow: 0,
      rowsPerPattern: song0?.rowsPerPattern || 64,
      bpm: conv.bpm,
      speed: song0?.speed || 6,
      machine: mod.machine,
      expansionMask: mod.expansionMask,
      expansions: mod.expansions,
      elapsedSeconds: 0,
      estimatedDurationSeconds: conv.durationSeconds,
      channels: liveChannels,
    };

    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'loadModule',
        module: mod,
        songIndex: 0,
      });
    }
    this.notify();
    return mod;
  }

  public clearModule() {
    this.stop();
    this.currentModule = null;
    this.state = {
      ...this.state,
      hasModuleLoaded: false,
      moduleTitle: '',
      moduleAuthor: '',
      moduleFormat: null,
      channels: [],
      elapsedSeconds: 0,
      estimatedDurationSeconds: 0,
    };
    this.notify();
  }

  public getCurrentModule(): FamiTrackerModule | null {
    return this.currentModule;
  }

  public play() {
    if (!this.currentModule || !this.engineEnabled) return;
    if (this.audioCtx?.state === 'suspended') {
      void this.audioCtx.resume();
    }
    this.state.isPlaying = true;
    this.state.isPaused = false;
    this.workletNode?.port.postMessage({ type: 'play' });
    this.notify();
  }

  public pause() {
    this.state.isPlaying = false;
    this.state.isPaused = true;
    this.workletNode?.port.postMessage({ type: 'pause' });
    this.notify();
  }

  public stop() {
    this.state.isPlaying = false;
    this.state.isPaused = false;
    this.state.currentOrder = 0;
    this.state.currentRow = 0;
    this.state.elapsedSeconds = 0;
    this.workletNode?.port.postMessage({ type: 'stop' });
    this.notify();
  }

  public async previewNote(
    channelIndex: number,
    midiNote: number,
    velocity = 100,
    chip?: string,
    durationSec = 0.25,
    instrument = -1
  ): Promise<void> {
    if (!this.engineEnabled) return;
    const ctx = this.audioCtx || (typeof window !== 'undefined' ? (window as any)._gPlayerAudioCtx : null);
    if (!this.workletNode && ctx) {
      await this.init(ctx);
    }
    if (this.audioCtx?.state === 'suspended') {
      try { await this.audioCtx.resume(); } catch {}
    }
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'previewNote',
      channelIndex: Math.max(0, channelIndex | 0),
      midiNote,
      velocity,
      chip: chip || '2A03',
      durationSec,
      instrument,
    });
  }

  public stopPreviewChannel(channelIndex: number) {
    this.workletNode?.port.postMessage({
      type: 'stopPreviewChannel',
      channelIndex: Math.max(0, channelIndex | 0),
    });
  }

  public seek(orderIndex: number, rowIndex = 0) {
    if (!this.currentModule) return;
    const clampedOrder = Math.max(0, Math.min(this.state.totalOrders - 1, orderIndex));
    const clampedRow = Math.max(0, Math.min(this.state.rowsPerPattern - 1, rowIndex));
    this.state.currentOrder = clampedOrder;
    this.state.currentRow = clampedRow;
    this.workletNode?.port.postMessage({ type: 'seek', order: clampedOrder, row: clampedRow });
    this.notify();
  }

  public seekSeconds(targetSeconds: number) {
    if (!this.currentModule || this.state.estimatedDurationSeconds <= 0) return;
    const ratio = Math.max(0, Math.min(1, targetSeconds / this.state.estimatedDurationSeconds));
    const totalRows = Math.max(1, this.state.totalOrders * this.state.rowsPerPattern);
    const globalRow = Math.floor(ratio * totalRows);
    const orderIdx = Math.floor(globalRow / this.state.rowsPerPattern);
    const rowIdx = globalRow % this.state.rowsPerPattern;
    this.state.elapsedSeconds = targetSeconds;
    this.seek(orderIdx, rowIdx);
  }

  public setSubsong(songIndex: number) {
    if (!this.currentModule || !this.currentModule.songs[songIndex]) return;
    const song = this.currentModule.songs[songIndex];
    const conv = convertFamiTrackerToAriaPatterns(this.currentModule, songIndex);
    this.state.activeSongIndex = songIndex;
    this.state.currentOrder = 0;
    this.state.currentRow = 0;
    this.state.totalOrders = Math.max(1, song.frameList.length);
    this.state.rowsPerPattern = song.rowsPerPattern || 64;
    this.state.bpm = conv.bpm;
    this.state.speed = song.speed || 6;
    this.state.estimatedDurationSeconds = conv.durationSeconds;
    this.state.elapsedSeconds = 0;
    this.workletNode?.port.postMessage({ type: 'setSubsong', index: songIndex });
    this.notify();
  }

  public setMachine(machine: NesMachineStandard) {
    this.state.machine = machine;
    this.workletNode?.port.postMessage({ type: 'setMachine', machine });
    this.notify();
  }

  public setChannelMute(channelIndex: number, muted: boolean) {
    if (!this.state.channels[channelIndex]) return;
    this.state.channels[channelIndex].muted = muted;
    this.pushMuteSolo();
    this.notify();
  }

  public setChannelSolo(channelIndex: number, solo: boolean) {
    if (!this.state.channels[channelIndex]) return;
    this.state.channels[channelIndex].solo = solo;
    this.pushMuteSolo();
    this.notify();
  }

  public syncChannelStates(channels: Channel[]) {
    if (this.state.channels.length === 0) return;
    let changed = false;
    this.state.channels.forEach((ftCh, idx) => {
      const uiCh = channels[idx];
      if (uiCh) {
        const nextMuted = Boolean(uiCh.mute) || !uiCh.enabled;
        const nextSolo = Boolean(uiCh.solo);
        if (ftCh.muted !== nextMuted || ftCh.solo !== nextSolo) {
          ftCh.muted = nextMuted;
          ftCh.solo = nextSolo;
          changed = true;
        }
      }
    });
    if (changed) {
      this.pushMuteSolo();
    }
  }

  private pushMuteSolo() {
    this.workletNode?.port.postMessage({
      type: 'setMuteSolo',
      mutes: this.state.channels.map((c) => c.muted),
      solos: this.state.channels.map((c) => c.solo),
    });
  }

  public getProgress(): { elapsedSeconds: number; totalSeconds: number; ratio: number } {
    const total = Math.max(1, this.state.estimatedDurationSeconds || 1);
    const elapsed = Math.max(0, Math.min(total, this.state.elapsedSeconds));
    return { elapsedSeconds: elapsed, totalSeconds: total, ratio: elapsed / total };
  }

  public getVoiceScopeSamples(
    channelIndex: number,
    target: Float32Array
  ): { hasData: boolean; peak: number; sumSq: number } {
    target.fill(0);
    const src = this.channelScopes[channelIndex];
    if (!src || src.length === 0 || !this.state.isPlaying) {
      return { hasData: false, peak: 0, sumSq: 0 };
    }
    let peak = 0;
    let sumSq = 0;
    const len = Math.min(target.length, src.length);
    for (let i = 0; i < len; i++) {
      const s = src[i];
      target[i] = s;
      const av = Math.abs(s);
      if (av > peak) peak = av;
      sumSq += av * av;
    }
    return { hasData: peak > 0.0008, peak, sumSq };
  }

  public getBundleStatus(): { status: WasmBundleStatus; label: string; error: string | null } {
    return {
      status: this.state.wasmLoaded ? 'ready' : this.state.isReady ? 'ready' : 'unloaded',
      label: this.state.wasmSource,
      error: this.state.wasmError,
    };
  }
}

export const NesWorkletEngine = new NesWorkletEngineController();
export const FamiTrackerEngine = NesWorkletEngine;
