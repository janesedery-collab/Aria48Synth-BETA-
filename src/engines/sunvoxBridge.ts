/**
 * sunvoxBridge.ts
 * Native SunVox WebAssembly / JavaScript Engine Bridge for Aria48 Tracker
 * Loads official SunVox WASM distribution from jsDelivr CDN:
 * - https://cdn.jsdelivr.net/npm/sunvoxjs/sunvox.js
 * - https://cdn.jsdelivr.net/npm/sunvoxjs/sunvox_lib_loader.js
 * - https://cdn.jsdelivr.net/npm/sunvoxjs/sunvox.wasm
 */

export const SUNVOX_ENGINE_ID = 'sunvox-wasm-cdn';
export const SUNVOX_JS_CDN_URL = 'https://cdn.jsdelivr.net/npm/sunvoxjs/sunvox.js';
export const SUNVOX_LOADER_CDN_URL = 'https://cdn.jsdelivr.net/npm/sunvoxjs/sunvox_lib_loader.js';
export const SUNVOX_WASM_CDN_URL = 'https://cdn.jsdelivr.net/npm/sunvoxjs/sunvox.wasm';

const SV_INIT_FLAG_USER_AUDIO_CALLBACK = 1 << 1; // 2
const SV_INIT_FLAG_AUDIO_FLOAT32 = 1 << 3;       // 8
const SV_INIT_FLAG_ONE_THREAD = 1 << 4;          // 16

export interface SunVoxModuleInfo {
  id: number;
  name: string;
  flags: number;
  isGenerator: boolean;
}

export interface SunVoxRuntimeState {
  hasSunVoxLoaded: boolean;
  isPlaying: boolean;
  isReady: boolean;
  isLoading: boolean;
  fileName: string;
  songName: string;
  bpm: number;
  tpl: number;
  totalLines: number;
  currentLine: number;
  totalFrames: number;
  durationSeconds: number;
  elapsedSeconds: number;
  moduleCount: number;
  activeModules: SunVoxModuleInfo[];
  masterVolume: number; // 0..100
  engineEnabled: boolean;
  error: string | null;
}

declare global {
  interface Window {
    SunVoxLib?: (overrides?: Record<string, any>) => any;
    svlib?: any;
    sda_ctx?: AudioContext;
  }
}

function resolveGlobalSymbol(name: string): any {
  if (typeof window === 'undefined') return undefined;
  const direct = (window as any)[name];
  if (direct !== undefined) return direct;
  try {
    return (0, eval)(`typeof ${name} !== "undefined" ? ${name} : undefined`);
  } catch {
    return undefined;
  }
}

function loadClassicScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-aria-sunvox-src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if ((existing as any).__loaded) {
        resolve();
        return;
      }
      if ((existing as any).__failed) {
        existing.remove();
      } else {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Failed loading ${src}`)), { once: true });
        return;
      }
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-aria-sunvox-src', src);
    script.onload = () => {
      (script as any).__loaded = true;
      resolve();
    };
    script.onerror = () => {
      (script as any).__failed = true;
      script.remove();
      reject(new Error(`Failed loading SunVox script ${src}`));
    };
    document.head.appendChild(script);
  });
}

function bufferSignature(buf: ArrayBuffer, fileName: string): string {
  const len = buf.byteLength;
  const u8 = new Uint8Array(buf, 0, Math.min(32, len));
  let hash = 0;
  for (let i = 0; i < u8.length; i++) {
    hash = ((hash << 5) - hash + u8[i]) | 0;
  }
  return `${fileName}:${len}:${hash}`;
}

class SunVoxBridgeController {
  private initPromise: Promise<boolean> | null = null;
  private wasmReady = false;
  private audioInitialized = false;
  private slotOpened = false;
  private activeSampleRate = 44100;
  private usingUserAudioCallback = false;

  private hostAudioCtx: AudioContext | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private masterGainNode: GainNode | null = null;
  private callbackInterleavedBuf = new Float32Array(2048 * 2);
  private renderedScopeL = new Float32Array(2048);
  private renderedScopeR = new Float32Array(2048);
  private renderedFramesCount = 0;

  private currentBuffer: ArrayBuffer | null = null;
  private loadedSignature: string | null = null;
  private inFlightLoadPromise: Promise<boolean> | null = null;
  private inFlightLoadSig: string | null = null;
  private isLoadedSynthModule = false;
  private loadedSynthModuleId = -1;

  private pausedLine = 0;
  private playGeneration = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onSongEndedCallback: (() => void) | null = null;
  private endedTriggered = false;
  private listeners = new Set<(state: SunVoxRuntimeState) => void>();
  private scopeInt16Scratch = new Int16Array(1024);
  private gestureUnlockBound = false;

  private state: SunVoxRuntimeState = {
    hasSunVoxLoaded: false,
    isPlaying: false,
    isReady: false,
    isLoading: false,
    fileName: '',
    songName: '',
    bpm: 125,
    tpl: 6,
    totalLines: 64,
    currentLine: 0,
    totalFrames: 0,
    durationSeconds: 180,
    elapsedSeconds: 0,
    moduleCount: 0,
    activeModules: [],
    masterVolume: 85,
    engineEnabled: true,
    error: null
  };

  public subscribe(listener: (state: SunVoxRuntimeState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const snap = this.getState();
    this.listeners.forEach(cb => {
      try { cb(snap); } catch {}
    });
  }

  public getState(): SunVoxRuntimeState {
    return {
      ...this.state,
      activeModules: this.state.activeModules.map(m => ({ ...m }))
    };
  }

  public isLoaded(): boolean {
    return this.state.hasSunVoxLoaded && Boolean(this.currentBuffer);
  }

  public setHostAudioContext(ctx: AudioContext | null | undefined) {
    if (!ctx) return;
    this.hostAudioCtx = ctx;
    if (this.audioInitialized && this.usingUserAudioCallback && !this.scriptNode) {
      this.attachWebAudioCallbackGraph(ctx);
    }
  }

  public resumeAudioContextSync() {
    try {
      if (this.hostAudioCtx && this.hostAudioCtx.state === 'suspended') {
        void this.hostAudioCtx.resume().catch(() => {});
      }
      const sdaCtx = resolveGlobalSymbol('sda_ctx') as AudioContext | undefined;
      if (sdaCtx && sdaCtx.state === 'suspended') {
        void sdaCtx.resume().catch(() => {});
      }
    } catch {}
  }

  private bindGestureAutoUnlock() {
    if (this.gestureUnlockBound || typeof window === 'undefined') return;
    this.gestureUnlockBound = true;
    const unlock = () => {
      this.resumeAudioContextSync();
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true, passive: true });
    window.addEventListener('click', unlock, { capture: true, passive: true });
  }

  public setEngineEnabled(enabled: boolean) {
    this.state = { ...this.state, engineEnabled: enabled };
    this.applyVolumeToEngine();
    this.notify();
  }

  public setMasterVolume(volumePct: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(volumePct)));
    this.state = { ...this.state, masterVolume: clamped };
    this.applyVolumeToEngine();
    this.notify();
  }

  private applyVolumeToEngine() {
    const effectiveRatio = this.state.engineEnabled ? Math.max(0, Math.min(1, this.state.masterVolume / 100)) : 0;
    if (this.masterGainNode && this.hostAudioCtx) {
      try {
        this.masterGainNode.gain.setTargetAtTime(effectiveRatio, this.hostAudioCtx.currentTime, 0.015);
      } catch {
        this.masterGainNode.gain.value = effectiveRatio;
      }
    }
    if (!this.audioInitialized || !this.slotOpened) return;
    const sv_volume = resolveGlobalSymbol('sv_volume');
    if (typeof sv_volume === 'function') {
      const vol256 = Math.max(0, Math.min(256, Math.round(effectiveRatio * 256)));
      try {
        sv_volume(0, vol256);
      } catch {}
    }
  }

  private attachWebAudioCallbackGraph(ctx: AudioContext) {
    if (this.scriptNode) return;
    const bufferSize = 2048;
    let keepAliveGain: GainNode | null = null;
    try {
      const osc = ctx.createOscillator();
      keepAliveGain = ctx.createGain();
      keepAliveGain.gain.value = 0;
      osc.connect(keepAliveGain);
      osc.start();
    } catch {
      keepAliveGain = null;
    }

    const node = ctx.createScriptProcessor(bufferSize, keepAliveGain ? 1 : 0, 2);
    if (keepAliveGain) {
      try { keepAliveGain.connect(node); } catch {}
    }

    const gain = ctx.createGain();
    const effectiveRatio = this.state.engineEnabled ? Math.max(0, Math.min(1, this.state.masterVolume / 100)) : 0;
    gain.gain.value = effectiveRatio;

    node.onaudioprocess = (e: AudioProcessingEvent) => {
      const out = e.outputBuffer;
      const outL = out.getChannelData(0);
      const outR = out.numberOfChannels >= 2 ? out.getChannelData(1) : outL;
      const frames = out.length;

      if (!this.state.isPlaying || !this.audioInitialized || !this.slotOpened) {
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
        return;
      }

      const sv_audio_callback = resolveGlobalSymbol('sv_audio_callback');
      const sv_get_ticks = resolveGlobalSymbol('sv_get_ticks');
      if (typeof sv_audio_callback !== 'function') {
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
        return;
      }

      if (this.callbackInterleavedBuf.length < frames * 2) {
        this.callbackInterleavedBuf = new Float32Array(frames * 2);
      }
      if (this.renderedScopeL.length !== frames) {
        this.renderedScopeL = new Float32Array(frames);
        this.renderedScopeR = new Float32Array(frames);
      }

      try {
        const ticks = typeof sv_get_ticks === 'function' ? sv_get_ticks() : 0;
        sv_audio_callback(this.callbackInterleavedBuf, frames, 0, ticks);
        const buf = this.callbackInterleavedBuf;
        for (let i = 0; i < frames; i++) {
          const l = buf[i * 2];
          const r = buf[i * 2 + 1];
          outL[i] = l;
          outR[i] = r;
          this.renderedScopeL[i] = l;
          this.renderedScopeR[i] = r;
        }
        this.renderedFramesCount += frames;
      } catch (err) {
        console.warn('SunVox sv_audio_callback error:', err);
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
      }
    };

    node.connect(gain);
    gain.connect(ctx.destination);
    this.scriptNode = node;
    this.masterGainNode = gain;
  }

  public async ensureInitialized(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    if (this.wasmReady && this.audioInitialized && this.slotOpened) {
      if (this.usingUserAudioCallback && this.hostAudioCtx && !this.scriptNode) {
        this.attachWebAudioCallbackGraph(this.hostAudioCtx);
      }
      return true;
    }
    if (this.initPromise) return this.initPromise;

    this.bindGestureAutoUnlock();
    this.state = { ...this.state, isLoading: true, error: null };
    this.notify();

    this.initPromise = (async () => {
      try {
        // Pre-fetch sunvox.wasm in parallel with sunvox.js so Emscripten skips streaming/relative path lookups
        const wasmFetchPromise = fetch(SUNVOX_WASM_CDN_URL, { mode: 'cors' })
          .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined))
          .catch(() => undefined);

        if (!resolveGlobalSymbol('SunVoxLib')) {
          await loadClassicScript(SUNVOX_JS_CDN_URL);
        }

        const rawCtor = resolveGlobalSymbol('SunVoxLib');
        if (typeof rawCtor !== 'function') {
          throw new Error('SunVoxLib constructor missing after loading sunvox.js');
        }

        const wasmBinary = await wasmFetchPromise;

        let markRuntimeReady!: () => void;
        const runtimeReadyPromise = new Promise<void>((resolve) => {
          markRuntimeReady = resolve;
        });

        // Wrap SunVoxLib BEFORE loading sunvox_lib_loader.js so Emscripten receives wasmBinary + CDN locateFile
        const existingSvInit = resolveGlobalSymbol('sv_init');
        if (typeof existingSvInit !== 'function') {
          if (!(rawCtor as any).__ariaWrapped) {
            const wrappedCtor = function (moduleArg: Record<string, any> = {}) {
              const userOnInit = moduleArg?.onRuntimeInitialized;
              const instance = rawCtor({
                ...(wasmBinary ? { wasmBinary } : {}),
                locateFile: (path: string) => {
                  if (path.endsWith('.wasm')) return SUNVOX_WASM_CDN_URL;
                  return `https://cdn.jsdelivr.net/npm/sunvoxjs/${path}`;
                },
                ...moduleArg,
                onRuntimeInitialized: () => {
                  try { userOnInit?.(); } catch {}
                  markRuntimeReady();
                }
              });
              if (instance && instance.calledRun) {
                markRuntimeReady();
              }
              return instance;
            };
            (wrappedCtor as any).__ariaWrapped = true;
            (window as any).SunVoxLib = wrappedCtor;
          }

          await loadClassicScript(SUNVOX_LOADER_CDN_URL);
        } else {
          markRuntimeReady();
        }

        const svlib = resolveGlobalSymbol('svlib');
        if (svlib?.calledRun) {
          markRuntimeReady();
        }

        // Wait for WASM runtime compilation/instantiation (bounded safety timeout 20s)
        await new Promise<void>((res, rej) => {
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearInterval(checkInterval);
            clearTimeout(timeoutId);
            if (err) rej(err);
            else res();
          };
          const checkInterval = setInterval(() => {
            const lib = resolveGlobalSymbol('svlib');
            if (lib?.calledRun) {
              markRuntimeReady();
              finish();
            }
          }, 50);
          const timeoutId = setTimeout(() => {
            finish(new Error('Timed out waiting for sunvox.wasm initialization'));
          }, 20000);
          void runtimeReadyPromise.then(() => finish());
        });

        this.wasmReady = true;

        const sv_init = resolveGlobalSymbol('sv_init');
        const sv_open_slot = resolveGlobalSymbol('sv_open_slot');
        if (typeof sv_init !== 'function' || typeof sv_open_slot !== 'function') {
          throw new Error('SunVox API functions (sv_init / sv_open_slot) not registered');
        }

        if (!this.audioInitialized) {
          // Prefer routing SunVox through Aria48's unlocked host AudioContext via SV_INIT_FLAG_USER_AUDIO_CALLBACK
          // so browsers never mute playback on an async-created suspended AudioContext.
          const hostCtx = this.hostAudioCtx || (resolveGlobalSymbol('_gPlayerAudioCtx') as AudioContext | undefined) || null;
          if (hostCtx && !this.hostAudioCtx) {
            this.hostAudioCtx = hostCtx;
          }
          let initRc = -1;
          if (hostCtx) {
            const sr = Math.max(22050, Math.min(192000, hostCtx.sampleRate || 44100));
            const flags = SV_INIT_FLAG_USER_AUDIO_CALLBACK | SV_INIT_FLAG_AUDIO_FLOAT32 | SV_INIT_FLAG_ONE_THREAD;
            initRc = sv_init(0, sr, 2, flags);
            if (initRc >= 0) {
              this.activeSampleRate = sr;
              this.usingUserAudioCallback = true;
              this.attachWebAudioCallbackGraph(hostCtx);
            }
          }

          if (initRc < 0) {
            initRc = sv_init(0, 44100, 2, 0);
            if (initRc < 0) {
              throw new Error(`sv_init failed with code ${initRc}`);
            }
            const sdaCtx = resolveGlobalSymbol('sda_ctx') as AudioContext | undefined;
            this.activeSampleRate = sdaCtx?.sampleRate || 44100;
            this.usingUserAudioCallback = false;
            this.resumeAudioContextSync();
          }

          this.audioInitialized = true;
        }

        if (!this.slotOpened) {
          const openRc = sv_open_slot(0);
          if (openRc !== 0) {
            throw new Error(`sv_open_slot(0) failed with code ${openRc}`);
          }
          this.slotOpened = true;
        }

        this.state = {
          ...this.state,
          isReady: true,
          isLoading: false,
          error: null
        };
        this.applyVolumeToEngine();
        this.notify();
        return true;
      } catch (err: any) {
        this.initPromise = null;
        this.state = {
          ...this.state,
          isReady: false,
          isLoading: false,
          error: err?.message || 'SunVox WASM initialization failed'
        };
        this.notify();
        return false;
      }
    })();

    return this.initPromise;
  }

  private inspectLoadedProject(fallbackName: string) {
    const sv_get_song_name = resolveGlobalSymbol('sv_get_song_name');
    const sv_get_song_bpm = resolveGlobalSymbol('sv_get_song_bpm');
    const sv_get_song_tpl = resolveGlobalSymbol('sv_get_song_tpl');
    const sv_get_song_length_frames = resolveGlobalSymbol('sv_get_song_length_frames');
    const sv_get_song_length_lines = resolveGlobalSymbol('sv_get_song_length_lines');
    const sv_get_number_of_modules = resolveGlobalSymbol('sv_get_number_of_modules');
    const sv_get_module_flags = resolveGlobalSymbol('sv_get_module_flags');
    const sv_get_module_name = resolveGlobalSymbol('sv_get_module_name');

    const rawName = typeof sv_get_song_name === 'function' ? String(sv_get_song_name(0) || '').trim() : '';
    const songName = rawName || fallbackName.replace(/\.[^/.]+$/, '') || 'SunVox Project';
    const bpm = Math.max(30, Math.min(320, (typeof sv_get_song_bpm === 'function' ? sv_get_song_bpm(0) : 125) || 125));
    const tpl = Math.max(1, (typeof sv_get_song_tpl === 'function' ? sv_get_song_tpl(0) : 6) || 6);
    const totalFrames = Math.max(0, (typeof sv_get_song_length_frames === 'function' ? sv_get_song_length_frames(0) : 0) || 0);
    const totalLines = Math.max(1, (typeof sv_get_song_length_lines === 'function' ? sv_get_song_length_lines(0) : 64) || 64);
    const sr = Math.max(22050, this.activeSampleRate || 44100);
    const durationSeconds = totalFrames > 0 ? Math.max(1, totalFrames / sr) : 180;
    const moduleCount = Math.max(0, (typeof sv_get_number_of_modules === 'function' ? sv_get_number_of_modules(0) : 0) || 0);

    const activeModules: SunVoxModuleInfo[] = [];
    for (let m = 1; m < Math.min(256, moduleCount); m++) {
      const flags = typeof sv_get_module_flags === 'function' ? sv_get_module_flags(0, m) : 0;
      if ((flags & 1) !== 0) {
        const modName = (typeof sv_get_module_name === 'function' ? sv_get_module_name(0, m) : '') || `Mod ${m}`;
        activeModules.push({
          id: m,
          name: String(modName).trim() || `Mod ${m}`,
          flags,
          isGenerator: (flags & 8) !== 0
        });
      }
    }
    // Order generator modules before effect modules so channel scopes 1..N lock onto sound sources first
    activeModules.sort((a, b) => Number(b.isGenerator) - Number(a.isGenerator) || a.id - b.id);

    this.state = {
      ...this.state,
      songName,
      bpm,
      tpl,
      totalLines,
      totalFrames,
      durationSeconds,
      moduleCount,
      activeModules
    };
  }

  public registerSunVoxFile(arrayBuffer: ArrayBuffer, fileName: string): SunVoxRuntimeState {
    const copy = arrayBuffer.slice(0);
    const sig = bufferSignature(copy, fileName);
    if (this.loadedSignature !== sig) {
      this.pausedLine = 0;
      this.endedTriggered = false;
    }
    this.currentBuffer = copy;
    this.state = {
      ...this.state,
      hasSunVoxLoaded: true,
      fileName,
      songName: fileName.replace(/\.[^/.]+$/, '') || 'SunVox Project',
      currentLine: 0,
      elapsedSeconds: 0,
      error: null
    };
    this.notify();

    // Pre-initialize WASM engine and load into slot 0 asynchronously so real metadata populates right away
    void this.loadBufferIntoSlot(copy, fileName);
    return this.getState();
  }

  private async loadBufferIntoSlot(arrayBuffer: ArrayBuffer, fileName: string): Promise<boolean> {
    const sig = bufferSignature(arrayBuffer, fileName);
    if (this.inFlightLoadPromise && this.inFlightLoadSig === sig) {
      return this.inFlightLoadPromise;
    }

    const doLoad = (async () => {
      const ok = await this.ensureInitialized();
      if (!ok) return false;

      if (this.loadedSignature === sig) {
        return true;
      }

      const sv_stop = resolveGlobalSymbol('sv_stop');
      const sv_load_from_memory = resolveGlobalSymbol('sv_load_from_memory');
      const sv_load_module_from_memory = resolveGlobalSymbol('sv_load_module_from_memory');
      const sv_connect_module = resolveGlobalSymbol('sv_connect_module');
      const sv_lock_slot = resolveGlobalSymbol('sv_lock_slot');
      const sv_unlock_slot = resolveGlobalSymbol('sv_unlock_slot');
      const sv_close_slot = resolveGlobalSymbol('sv_close_slot');
      const sv_open_slot = resolveGlobalSymbol('sv_open_slot');
      const sv_set_autostop = resolveGlobalSymbol('sv_set_autostop');

      if (typeof sv_load_from_memory !== 'function') return false;

      try {
        sv_stop?.(0);
      } catch {}

      const bytes = new Uint8Array(arrayBuffer);
      let rc = sv_load_from_memory(0, bytes);
      this.isLoadedSynthModule = false;
      this.loadedSynthModuleId = -1;

      if (rc !== 0 && fileName.toLowerCase().endsWith('.sunsynth') && typeof sv_load_module_from_memory === 'function') {
        try {
          sv_close_slot?.(0);
          sv_open_slot?.(0);
          sv_lock_slot?.(0);
          const modId = sv_load_module_from_memory(0, bytes, 0, 0, 0);
          if (typeof modId === 'number' && modId >= 0) {
            sv_connect_module?.(0, modId, 0);
            this.isLoadedSynthModule = true;
            this.loadedSynthModuleId = modId;
            rc = 0;
          }
          sv_unlock_slot?.(0);
        } catch {
          try { sv_unlock_slot?.(0); } catch {}
        }
      }

      if (rc !== 0) {
        this.state = {
          ...this.state,
          error: `SunVox could not load "${fileName}" (error code ${rc})`
        };
        this.notify();
        return false;
      }

      this.loadedSignature = sig;
      this.pausedLine = 0;
      this.endedTriggered = false;
      sv_set_autostop?.(0, 1);
      this.applyVolumeToEngine();
      this.inspectLoadedProject(fileName);
      this.notify();
      return true;
    })();

    this.inFlightLoadSig = sig;
    this.inFlightLoadPromise = doLoad;
    try {
      return await doLoad;
    } finally {
      if (this.inFlightLoadPromise === doLoad) {
        this.inFlightLoadPromise = null;
        this.inFlightLoadSig = null;
      }
    }
  }

  public clearLoadedSunVox() {
    this.stop();
    this.currentBuffer = null;
    this.loadedSignature = null;
    this.inFlightLoadPromise = null;
    this.inFlightLoadSig = null;
    this.isLoadedSynthModule = false;
    this.loadedSynthModuleId = -1;
    this.pausedLine = 0;
    this.endedTriggered = false;
    this.state = {
      ...this.state,
      hasSunVoxLoaded: false,
      isPlaying: false,
      fileName: '',
      songName: '',
      currentLine: 0,
      elapsedSeconds: 0,
      moduleCount: 0,
      activeModules: [],
      error: null
    };
    this.notify();
  }

  public async playSunVox(
    arrayBuffer?: ArrayBuffer,
    fileName?: string,
    options?: { seekRatio?: number; onSongEnded?: () => void }
  ): Promise<boolean> {
    const buf = arrayBuffer ? arrayBuffer.slice(0) : this.currentBuffer;
    const name = fileName || this.state.fileName || 'project.sunvox';
    if (!buf) return false;

    // Resume audio contexts synchronously BEFORE awaiting WASM initialization
    this.resumeAudioContextSync();

    this.currentBuffer = buf;
    this.onSongEndedCallback = options?.onSongEnded || null;
    this.endedTriggered = false;
    this.renderedFramesCount = 0;
    const gen = ++this.playGeneration;

    const loaded = await this.loadBufferIntoSlot(buf, name);
    if (!loaded || gen !== this.playGeneration) return false;

    this.resumeAudioContextSync();
    this.applyVolumeToEngine();

    const sv_play_from_beginning = resolveGlobalSymbol('sv_play_from_beginning');
    const sv_play = resolveGlobalSymbol('sv_play');
    const sv_rewind = resolveGlobalSymbol('sv_rewind');
    const sv_set_autostop = resolveGlobalSymbol('sv_set_autostop');
    const sv_send_event = resolveGlobalSymbol('sv_send_event');

    sv_set_autostop?.(0, 1);

    if (this.isLoadedSynthModule && this.loadedSynthModuleId >= 0 && typeof sv_send_event === 'function') {
      sv_play_from_beginning?.(0);
      sv_send_event(0, 0, 60, 127, this.loadedSynthModuleId + 1, 0, 0);
    } else {
      const totalLines = Math.max(1, this.state.totalLines || 64);
      if (typeof options?.seekRatio === 'number' && options.seekRatio > 0.001) {
        const targetLine = Math.max(0, Math.min(totalLines - 1, Math.round(options.seekRatio * totalLines)));
        sv_rewind?.(0, targetLine);
        sv_play?.(0);
        this.pausedLine = targetLine;
      } else if (this.pausedLine > 0 && this.pausedLine < totalLines - 1) {
        sv_rewind?.(0, this.pausedLine);
        sv_play?.(0);
      } else {
        this.pausedLine = 0;
        if (typeof sv_play_from_beginning === 'function') {
          sv_play_from_beginning(0);
        } else {
          sv_rewind?.(0, 0);
          sv_play?.(0);
        }
      }
    }

    this.state = {
      ...this.state,
      hasSunVoxLoaded: true,
      isPlaying: true,
      fileName: name,
      error: null
    };
    this.notify();
    this.startProgressPolling();
    return true;
  }

  public pause() {
    this.playGeneration++;
    this.stopProgressPolling();
    if (this.audioInitialized && this.slotOpened) {
      const sv_get_current_line = resolveGlobalSymbol('sv_get_current_line');
      const sv_stop = resolveGlobalSymbol('sv_stop');
      try {
        if (typeof sv_get_current_line === 'function') {
          this.pausedLine = Math.max(0, sv_get_current_line(0) || 0);
        }
        sv_stop?.(0);
      } catch {}
    }
    if (this.state.isPlaying) {
      this.state = { ...this.state, isPlaying: false };
      this.notify();
    }
  }

  public stop() {
    this.playGeneration++;
    this.stopProgressPolling();
    this.pausedLine = 0;
    this.renderedFramesCount = 0;
    if (this.audioInitialized && this.slotOpened) {
      const sv_stop = resolveGlobalSymbol('sv_stop');
      const sv_rewind = resolveGlobalSymbol('sv_rewind');
      try {
        sv_stop?.(0);
        sv_stop?.(0);
        sv_rewind?.(0, 0);
      } catch {}
    }
    this.state = {
      ...this.state,
      isPlaying: false,
      currentLine: 0,
      elapsedSeconds: 0
    };
    this.notify();
  }

  public seekRatio(ratio0to1: number) {
    const clamped = Math.max(0, Math.min(0.999, ratio0to1));
    const totalLines = Math.max(1, this.state.totalLines || 64);
    const targetLine = Math.max(0, Math.min(totalLines - 1, Math.round(clamped * totalLines)));
    const elapsedSeconds = clamped * Math.max(1, this.state.durationSeconds || 180);
    this.pausedLine = targetLine;
    this.endedTriggered = false;

    if (this.audioInitialized && this.slotOpened) {
      this.resumeAudioContextSync();
      const sv_rewind = resolveGlobalSymbol('sv_rewind');
      const sv_play = resolveGlobalSymbol('sv_play');
      try {
        sv_rewind?.(0, targetLine);
        if (this.state.isPlaying) {
          sv_play?.(0);
        }
      } catch {}
    }

    this.state = {
      ...this.state,
      currentLine: targetLine,
      elapsedSeconds
    };
    this.notify();
  }

  public seekSeconds(targetSeconds: number) {
    const dur = Math.max(1, this.state.durationSeconds || 180);
    this.seekRatio(targetSeconds / dur);
  }

  public getProgress(): {
    playing: boolean;
    currentLine: number;
    totalLines: number;
    elapsedSeconds: number;
    durationSeconds: number;
    ratio: number;
  } {
    const dur = Math.max(1, this.state.durationSeconds || 180);
    const totalLines = Math.max(1, this.state.totalLines || 64);
    let line = this.state.currentLine;

    if (this.state.isPlaying && this.audioInitialized && this.slotOpened) {
      const sv_get_current_line = resolveGlobalSymbol('sv_get_current_line');
      if (typeof sv_get_current_line === 'function') {
        const raw = sv_get_current_line(0);
        if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
          line = Math.min(totalLines, raw);
        }
      }
    }

    const ratio = Math.max(0, Math.min(1, line / totalLines));
    return {
      playing: this.state.isPlaying,
      currentLine: line,
      totalLines,
      elapsedSeconds: ratio * dur,
      durationSeconds: dur,
      ratio
    };
  }

  public getModuleScopeSamples(
    channelIndex0Based: number,
    outBuf: Float32Array
  ): { hasData: boolean; peak: number; sumSq: number } {
    if (!this.state.hasSunVoxLoaded || !this.state.isPlaying || !this.audioInitialized || !this.slotOpened || !this.state.engineEnabled) {
      return { hasData: false, peak: 0, sumSq: 0 };
    }
    const sv_get_module_scope2 = resolveGlobalSymbol('sv_get_module_scope2');

    if (typeof sv_get_module_scope2 === 'function') {
      const mods = this.state.activeModules;
      const modId =
        mods.length > 0 && channelIndex0Based < mods.length
          ? mods[channelIndex0Based].id
          : 0;
      const stereoChannel = modId === 0 ? channelIndex0Based % 2 : 0;

      if (this.scopeInt16Scratch.length !== outBuf.length) {
        this.scopeInt16Scratch = new Int16Array(outBuf.length);
      }

      try {
        const readCount = sv_get_module_scope2(0, modId, stereoChannel, this.scopeInt16Scratch, outBuf.length);
        if (typeof readCount === 'number' && readCount > 0) {
          let peak = 0;
          let sumSq = 0;
          const limit = Math.min(outBuf.length, readCount);
          for (let i = 0; i < limit; i++) {
            const s = this.scopeInt16Scratch[i] / 32768.0;
            outBuf[i] = s;
            const av = Math.abs(s);
            if (av > peak) peak = av;
            sumSq += s * s;
          }
          for (let i = limit; i < outBuf.length; i++) {
            outBuf[i] = 0;
          }
          if (peak > 0.0005) {
            return { hasData: true, peak, sumSq };
          }
        }
      } catch {}
    }

    // Fallback: use live rendered stereo buffer for master output visualization
    if (this.usingUserAudioCallback && this.renderedFramesCount > 0) {
      const src = channelIndex0Based % 2 === 0 ? this.renderedScopeL : this.renderedScopeR;
      const limit = Math.min(outBuf.length, src.length);
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < limit; i++) {
        const s = src[i];
        outBuf[i] = s;
        const av = Math.abs(s);
        if (av > peak) peak = av;
        sumSq += s * s;
      }
      for (let i = limit; i < outBuf.length; i++) {
        outBuf[i] = 0;
      }
      return { hasData: peak > 0.0005, peak, sumSq };
    }

    return { hasData: false, peak: 0, sumSq: 0 };
  }

  private startProgressPolling() {
    this.stopProgressPolling();
    this.pollTimer = setInterval(() => {
      if (!this.state.isPlaying || !this.audioInitialized || !this.slotOpened) return;
      const sv_get_current_line = resolveGlobalSymbol('sv_get_current_line');
      const sv_end_of_song = resolveGlobalSymbol('sv_end_of_song');
      const rawLine = typeof sv_get_current_line === 'function' ? sv_get_current_line(0) : this.state.currentLine;
      const line = typeof rawLine === 'number' && rawLine >= 0 ? rawLine : this.state.currentLine;
      const totalLines = Math.max(1, this.state.totalLines || 64);
      const dur = Math.max(1, this.state.durationSeconds || 180);
      const elapsedSeconds = Math.max(0, Math.min(dur, (line / totalLines) * dur));

      this.state = {
        ...this.state,
        currentLine: line,
        elapsedSeconds
      };

      const hasStartedAudio = !this.usingUserAudioCallback
        ? line > 0
        : (this.renderedFramesCount >= 8192 && line > 0);
      const ended = !this.isLoadedSynthModule && hasStartedAudio && typeof sv_end_of_song === 'function' && sv_end_of_song(0) !== 0;
      if (ended && !this.endedTriggered) {
        this.endedTriggered = true;
        this.pausedLine = 0;
        this.state = {
          ...this.state,
          isPlaying: false,
          currentLine: 0,
          elapsedSeconds: 0
        };
        this.stopProgressPolling();
        this.notify();
        this.onSongEndedCallback?.();
        return;
      }
      this.notify();
    }, 80);
  }

  private stopProgressPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

export const SunVoxBridge = new SunVoxBridgeController();
