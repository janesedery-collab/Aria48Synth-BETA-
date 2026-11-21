/**
 * sunvoxBridge.ts
 * Overhauled Native SunVox v2.1.4 WebAssembly / JavaScript Engine Bridge for Aria48 Tracker
 * Uses official WarmPlace SunVox library assets hosted locally at /sunvox/:
 * - /sunvox/sunvox.js
 * - /sunvox/sunvox_lib_loader.js
 * - /sunvox/sunvox.wasm
 */

export const SUNVOX_ENGINE_ID = 'sunvox-wasm-2.1.4';
export const SUNVOX_JS_URL = '/sunvox/sunvox.js';
export const SUNVOX_LOADER_URL = '/sunvox/sunvox_lib_loader.js';
export const SUNVOX_WASM_URL = '/sunvox/sunvox.wasm';

const SV_INIT_FLAG_NO_DEBUG_OUTPUT = 1 << 0; // 1
const SV_INIT_FLAG_USER_AUDIO_CALLBACK = 1 << 1; // 2
const SV_INIT_FLAG_AUDIO_INT16 = 1 << 2; // 4
const SV_INIT_FLAG_AUDIO_FLOAT32 = 1 << 3; // 8
const SV_INIT_FLAG_ONE_THREAD = 1 << 4; // 16

const SV_MODULE_FLAG_EXISTS = 1 << 0; // 1
const SV_MODULE_FLAG_GENERATOR = 1 << 1; // 2
const SV_MODULE_FLAG_EFFECT = 1 << 2; // 4
const SV_MODULE_FLAG_MUTE = 1 << 3; // 8
const SV_MODULE_FLAG_SOLO = 1 << 4; // 16
const SV_MODULE_FLAG_BYPASS = 1 << 5; // 32

const NON_AUDIO_MODULE_TYPES = new Set([
  'MultiSynth',
  'Pitch2Ctl',
  'Velocity2Ctl',
  'Sound2Ctl',
  'Feedback',
  'GPIO',
  'Output',
]);

const SUNVOX_EFFECT_NAMES: Record<number, string> = {
  0x01: '01 Slide Up',
  0x02: '02 Slide Down',
  0x03: '03 Slide Note',
  0x04: '04 Vibrato',
  0x07: '07 Phase Offset',
  0x08: '08 Arpeggio',
  0x09: '09 Sample Offset',
  0x0a: '0A Slide Vol',
  0x0f: '0F Tempo/TPL',
  0x11: '11 Fineslide Up',
  0x12: '12 Fineslide Dn',
  0x13: '13 Auto Vibrato',
  0x14: '14 Fine Volume',
  0x19: '19 Re-Trigger',
  0x1c: '1C Note Cut',
  0x1d: '1D Note Delay',
  0x20: '20 Probability',
  0x21: '21 Random Pitch',
  0x22: '22 Random Vel',
  0x30: '30 Stop Song',
};

export interface SunVoxModuleInfo {
  id: number;
  name: string;
  type: string;
  flags: number;
  isGenerator: boolean;
  isEffect: boolean;
  isMuted: boolean;
}

export interface SunVoxEffectActivity {
  id: string;
  modNum?: number;
  name: string;
  type: string;
  category: 'dsp' | 'pattern';
  staticUses: number;
  hitCount: number;
  liveLevel: number; // 0..1
  brightness: number; // 0.15..1.0
}

export interface SunVoxRuntimeState {
  hasSunVoxLoaded: boolean;
  isPlaying: boolean;
  isReady: boolean;
  isLoading: boolean;
  engineVersion: string;
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
  patternCount: number;
  activeModules: SunVoxModuleInfo[];
  effectsActivity: SunVoxEffectActivity[];
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

function setGlobalSymbol(name: string, value: any) {
  if (typeof window === 'undefined') return;
  (window as any)[name] = value;
  try {
    (window as any).__ariaSvAssignTmp = value;
    (0, eval)(`if (typeof ${name} !== "undefined") { ${name} = window.__ariaSvAssignTmp; }`);
  } catch {}
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
  const u8 = new Uint8Array(buf, 0, Math.min(64, len));
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
  private fxScopeInt16Scratch = new Int16Array(128);
  private gestureUnlockBound = false;
  private reinitSampleRateInFlight: Promise<void> | null = null;

  private state: SunVoxRuntimeState = {
    hasSunVoxLoaded: false,
    isPlaying: false,
    isReady: false,
    isLoading: false,
    engineVersion: '2.1.4',
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
    patternCount: 0,
    activeModules: [],
    effectsActivity: [],
    masterVolume: 85,
    engineEnabled: true,
    error: null,
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
    this.listeners.forEach((cb) => {
      try {
        cb(snap);
      } catch {}
    });
  }

  public getState(): SunVoxRuntimeState {
    return {
      ...this.state,
      activeModules: this.state.activeModules.map((m) => ({ ...m })),
      effectsActivity: this.state.effectsActivity.map((e) => ({ ...e })),
    };
  }

  public isLoaded(): boolean {
    return this.state.hasSunVoxLoaded && Boolean(this.currentBuffer);
  }

  public setHostAudioContext(ctx: AudioContext | null | undefined) {
    if (!ctx) return;
    this.hostAudioCtx = ctx;
    if (this.audioInitialized && this.usingUserAudioCallback) {
      if (!this.scriptNode) {
        this.attachWebAudioCallbackGraph(ctx);
      }
      if (Math.abs((ctx.sampleRate || 44100) - this.activeSampleRate) > 1 && !this.reinitSampleRateInFlight) {
        this.reinitSampleRateInFlight = this.alignEngineSampleRate(ctx.sampleRate).finally(() => {
          this.reinitSampleRateInFlight = null;
        });
      }
    }
  }

  private async alignEngineSampleRate(targetSr: number) {
    const safeSr = Math.max(22050, Math.min(192000, Math.round(targetSr || 44100)));
    if (Math.abs(safeSr - this.activeSampleRate) <= 1) return;
    const sv_stop = resolveGlobalSymbol('sv_stop');
    const sv_close_slot = resolveGlobalSymbol('sv_close_slot');
    const sv_deinit = resolveGlobalSymbol('sv_deinit');
    const sv_init = resolveGlobalSymbol('sv_init');
    const sv_open_slot = resolveGlobalSymbol('sv_open_slot');
    if (typeof sv_deinit !== 'function' || typeof sv_init !== 'function') return;

    const wasPlaying = this.state.isPlaying;
    try {
      sv_stop?.(0);
      if (this.slotOpened) sv_close_slot?.(0);
      sv_deinit();
      const flags =
        SV_INIT_FLAG_NO_DEBUG_OUTPUT |
        SV_INIT_FLAG_USER_AUDIO_CALLBACK |
        SV_INIT_FLAG_AUDIO_FLOAT32 |
        SV_INIT_FLAG_ONE_THREAD;
      const rc = sv_init(0, safeSr, 2, flags);
      if (rc >= 0) {
        this.activeSampleRate = safeSr;
        this.slotOpened = sv_open_slot?.(0) === 0;
        this.loadedSignature = null;
        if (this.currentBuffer && this.slotOpened) {
          await this.loadBufferIntoSlot(this.currentBuffer, this.state.fileName || 'project.sunvox');
          if (wasPlaying) {
            const sv_play = resolveGlobalSymbol('sv_play');
            const sv_rewind = resolveGlobalSymbol('sv_rewind');
            sv_rewind?.(0, this.pausedLine || this.state.currentLine || 0);
            sv_play?.(0);
          }
        }
      }
    } catch {}
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
    const effectiveRatio = this.state.engineEnabled
      ? Math.max(0, Math.min(1, this.state.masterVolume / 100))
      : 0;
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
      try {
        keepAliveGain.connect(node);
      } catch {}
    }

    const gain = ctx.createGain();
    const effectiveRatio = this.state.engineEnabled
      ? Math.max(0, Math.min(1, this.state.masterVolume / 100))
      : 0;
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
        // Pre-fetch local /sunvox/sunvox.wasm in parallel with /sunvox/sunvox.js
        const wasmFetchPromise = fetch(SUNVOX_WASM_URL)
          .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined))
          .catch(() => undefined);

        if (!resolveGlobalSymbol('SunVoxLib')) {
          await loadClassicScript(SUNVOX_JS_URL);
        }

        const rawCtor = resolveGlobalSymbol('SunVoxLib');
        if (typeof rawCtor !== 'function') {
          throw new Error('SunVoxLib constructor missing after loading /sunvox/sunvox.js');
        }

        const wasmBinary = await wasmFetchPromise;
        let markRuntimeReady!: (mod?: any) => void;
        const runtimeReadyPromise = new Promise<any>((resolve) => {
          markRuntimeReady = resolve;
        });

        // Wrap SunVoxLib BEFORE loading sunvox_lib_loader.js so Emscripten receives wasmBinary + local /sunvox/ locateFile
        const existingSvInit = resolveGlobalSymbol('sv_init');
        if (typeof existingSvInit !== 'function') {
          if (!(rawCtor as any).__ariaWrapped) {
            const wrappedCtor = function (moduleArg: Record<string, any> = {}) {
              const userOnInit = moduleArg?.onRuntimeInitialized;
              const modPromise = rawCtor({
                ...(wasmBinary ? { wasmBinary } : {}),
                locateFile: (path: string) => {
                  if (path.endsWith('.wasm')) return SUNVOX_WASM_URL;
                  return `/sunvox/${path}`;
                },
                ...moduleArg,
                onRuntimeInitialized: () => {
                  try {
                    userOnInit?.();
                  } catch {}
                },
              });
              if (modPromise && typeof modPromise.then === 'function') {
                void modPromise.then((resolvedModule: any) => {
                  setGlobalSymbol('svlib', resolvedModule);
                  markRuntimeReady(resolvedModule);
                });
              } else if (modPromise && modPromise.calledRun) {
                setGlobalSymbol('svlib', modPromise);
                markRuntimeReady(modPromise);
              }
              return modPromise;
            };
            (wrappedCtor as any).__ariaWrapped = true;
            setGlobalSymbol('SunVoxLib', wrappedCtor);
          }

          await loadClassicScript(SUNVOX_LOADER_URL);
        } else {
          markRuntimeReady(resolveGlobalSymbol('svlib'));
        }

        const currentSvlib = resolveGlobalSymbol('svlib');
        if (currentSvlib && typeof currentSvlib.then === 'function') {
          const resolvedMod = await Promise.race([
            currentSvlib,
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error('Timed out waiting for SunVox 2.1.4 WASM Promise')), 20000)
            ),
          ]);
          setGlobalSymbol('svlib', resolvedMod);
          markRuntimeReady(resolvedMod);
        } else if (currentSvlib?.calledRun || currentSvlib?._sv_init) {
          markRuntimeReady(currentSvlib);
        } else {
          await Promise.race([
            runtimeReadyPromise,
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error('Timed out waiting for /sunvox/sunvox.wasm initialization')), 20000)
            ),
          ]);
        }

        this.wasmReady = true;

        const sv_init = resolveGlobalSymbol('sv_init');
        const sv_open_slot = resolveGlobalSymbol('sv_open_slot');
        const sv_get_sample_rate = resolveGlobalSymbol('sv_get_sample_rate');
        if (typeof sv_init !== 'function' || typeof sv_open_slot !== 'function') {
          throw new Error('SunVox API functions (sv_init / sv_open_slot) not registered');
        }

        if (!this.audioInitialized) {
          const hostCtx =
            this.hostAudioCtx || (resolveGlobalSymbol('_gPlayerAudioCtx') as AudioContext | undefined) || null;
          if (hostCtx && !this.hostAudioCtx) {
            this.hostAudioCtx = hostCtx;
          }
          const targetSr = hostCtx
            ? Math.max(22050, Math.min(192000, Math.round(hostCtx.sampleRate || 44100)))
            : 44100;
          const callbackFlags =
            SV_INIT_FLAG_NO_DEBUG_OUTPUT |
            SV_INIT_FLAG_USER_AUDIO_CALLBACK |
            SV_INIT_FLAG_AUDIO_FLOAT32 |
            SV_INIT_FLAG_ONE_THREAD;

          const initRc = sv_init(0, targetSr, 2, callbackFlags);
          if (initRc < 0) {
            throw new Error(`sv_init failed with code ${initRc}`);
          }

          const verMajor = (initRc >> 16) & 0xff;
          const verMinor = (initRc >> 8) & 0xff;
          const verPatch = initRc & 0xff;
          const versionLabel = initRc > 0 ? `${verMajor}.${verMinor}.${verPatch}` : '2.1.4';

          const actualSr =
            (typeof sv_get_sample_rate === 'function' ? sv_get_sample_rate() : 0) || targetSr;
          this.activeSampleRate = actualSr;
          this.usingUserAudioCallback = true;
          if (hostCtx) {
            this.attachWebAudioCallbackGraph(hostCtx);
          }

          this.state = {
            ...this.state,
            engineVersion: versionLabel,
          };
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
          error: null,
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
          error: err?.message || 'SunVox WASM initialization failed',
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
    const sv_get_sample_rate = resolveGlobalSymbol('sv_get_sample_rate');
    const sv_get_number_of_modules = resolveGlobalSymbol('sv_get_number_of_modules');
    const sv_get_module_flags = resolveGlobalSymbol('sv_get_module_flags');
    const sv_get_module_name = resolveGlobalSymbol('sv_get_module_name');
    const sv_get_module_type = resolveGlobalSymbol('sv_get_module_type');
    const sv_get_number_of_patterns = resolveGlobalSymbol('sv_get_number_of_patterns');
    const sv_get_pattern_tracks = resolveGlobalSymbol('sv_get_pattern_tracks');
    const sv_get_pattern_lines = resolveGlobalSymbol('sv_get_pattern_lines');
    const sv_get_pattern_data = resolveGlobalSymbol('sv_get_pattern_data');

    const rawName = typeof sv_get_song_name === 'function' ? String(sv_get_song_name(0) || '').trim() : '';
    const songName = rawName || fallbackName.replace(/\.[^/.]+$/, '') || 'SunVox Project';
    const bpm = Math.max(30, Math.min(320, (typeof sv_get_song_bpm === 'function' ? sv_get_song_bpm(0) : 125) || 125));
    const tpl = Math.max(1, (typeof sv_get_song_tpl === 'function' ? sv_get_song_tpl(0) : 6) || 6);
    const totalFrames = Math.max(
      0,
      (typeof sv_get_song_length_frames === 'function' ? sv_get_song_length_frames(0) : 0) || 0
    );
    const totalLines = Math.max(
      1,
      (typeof sv_get_song_length_lines === 'function' ? sv_get_song_length_lines(0) : 64) || 64
    );
    const engineSr =
      (typeof sv_get_sample_rate === 'function' ? sv_get_sample_rate() : 0) || this.activeSampleRate || 44100;
    const sr = Math.max(22050, engineSr);
    const durationSeconds = totalFrames > 0 ? Math.max(1, totalFrames / sr) : 180;
    const moduleCount = Math.max(
      0,
      (typeof sv_get_number_of_modules === 'function' ? sv_get_number_of_modules(0) : 0) || 0
    );
    const patternCount = Math.max(
      0,
      (typeof sv_get_number_of_patterns === 'function' ? sv_get_number_of_patterns(0) : 0) || 0
    );

    const activeModules: SunVoxModuleInfo[] = [];
    const effectsActivity: SunVoxEffectActivity[] = [];
    const dspEffectOrder: SunVoxEffectActivity[] = [];

    for (let m = 1; m < Math.min(512, moduleCount); m++) {
      const flags = typeof sv_get_module_flags === 'function' ? sv_get_module_flags(0, m) : 0;
      if ((flags & SV_MODULE_FLAG_EXISTS) === 0) continue;

      const modName =
        (typeof sv_get_module_name === 'function' ? sv_get_module_name(0, m) : '') || `Mod ${m}`;
      const modType =
        (typeof sv_get_module_type === 'function' ? sv_get_module_type(0, m) : '') || 'Module';
      const isGenerator = (flags & SV_MODULE_FLAG_GENERATOR) !== 0;
      const isEffect = (flags & SV_MODULE_FLAG_EFFECT) !== 0;
      const isMuted = (flags & SV_MODULE_FLAG_MUTE) !== 0;

      activeModules.push({
        id: m,
        name: String(modName).trim() || `Mod ${m}`,
        type: String(modType).trim() || 'Module',
        flags,
        isGenerator,
        isEffect,
        isMuted,
      });

      if (isEffect) {
        dspEffectOrder.push({
          id: `dsp-${m}`,
          modNum: m,
          name: String(modName).trim() || String(modType).trim() || `FX ${m}`,
          type: String(modType).trim() || 'DSP Effect',
          category: 'dsp',
          staticUses: 1,
          hitCount: 0,
          liveLevel: 0,
          brightness: 0.22,
        });
      }
    }

    // Prioritize audio-emitting generators first, then audio MetaModules, then FX processors
    activeModules.sort((a, b) => {
      const aNonAudio = NON_AUDIO_MODULE_TYPES.has(a.type) ? 1 : 0;
      const bNonAudio = NON_AUDIO_MODULE_TYPES.has(b.type) ? 1 : 0;
      if (aNonAudio !== bNonAudio) return aNonAudio - bNonAudio;
      const aScore = a.isGenerator ? 0 : a.type === 'MetaModule' ? 1 : 2;
      const bScore = b.isGenerator ? 0 : b.type === 'MetaModule' ? 1 : 2;
      if (aScore !== bScore) return aScore - bScore;
      return a.id - b.id;
    });

    // Scan patterns for pattern effect commands & module controller automations
    const patEffectCounts = new Map<number, number>();
    let ctlAutoCount = 0;

    if (typeof sv_get_pattern_data === 'function') {
      for (let p = 0; p < Math.min(512, patternCount); p++) {
        const tracks = typeof sv_get_pattern_tracks === 'function' ? sv_get_pattern_tracks(0, p) : 0;
        const lines = typeof sv_get_pattern_lines === 'function' ? sv_get_pattern_lines(0, p) : 0;
        if (tracks <= 0 || lines <= 0) continue;
        const data = sv_get_pattern_data(0, p) as Uint8Array | null;
        if (!data || data.length < tracks * lines * 8) continue;

        const len = tracks * lines;
        for (let i = 0; i < len; i++) {
          const off = i * 8;
          const ctl = data[off + 4] | (data[off + 5] << 8);
          const ee = ctl & 0xff;
          const cc = (ctl >> 8) & 0xff;
          if (ee > 0) {
            patEffectCounts.set(ee, (patEffectCounts.get(ee) || 0) + 1);
          }
          if (cc > 0) {
            ctlAutoCount++;
          }
        }
      }
    }

    // Group DSP effects + pattern FX so brightness scales with how heavily each is used
    for (const dsp of dspEffectOrder) {
      effectsActivity.push(dsp);
    }

    if (ctlAutoCount > 0) {
      effectsActivity.push({
        id: 'pat-ctl',
        name: 'CTL Automation',
        type: 'Controller',
        category: 'pattern',
        staticUses: ctlAutoCount,
        hitCount: ctlAutoCount,
        liveLevel: 0.35,
        brightness: Math.min(0.95, 0.25 + Math.log10(1 + ctlAutoCount) * 0.22),
      });
    }

    Array.from(patEffectCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([code, count]) => {
        const hex = code.toString(16).padStart(2, '0').toUpperCase();
        effectsActivity.push({
          id: `pat-${hex}`,
          name: SUNVOX_EFFECT_NAMES[code] || `${hex} Effect`,
          type: 'Pattern FX',
          category: 'pattern',
          staticUses: count,
          hitCount: count,
          liveLevel: 0.25,
          brightness: Math.min(0.95, 0.22 + Math.log10(1 + count) * 0.24),
        });
      });

    this.state = {
      ...this.state,
      songName,
      bpm,
      tpl,
      totalLines,
      totalFrames,
      durationSeconds,
      moduleCount,
      patternCount,
      activeModules,
      effectsActivity,
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
      error: null,
    };
    this.notify();

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
          try {
            sv_unlock_slot?.(0);
          } catch {}
        }
      }

      if (rc !== 0) {
        this.state = {
          ...this.state,
          error: `SunVox could not load "${fileName}" (error code ${rc})`,
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
      patternCount: 0,
      activeModules: [],
      effectsActivity: [],
      error: null,
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

    this.resumeAudioContextSync();

    this.currentBuffer = buf;
    this.onSongEndedCallback = options?.onSongEnded || null;
    this.endedTriggered = false;
    this.renderedFramesCount = 0;
    const gen = ++this.playGeneration;

    const loaded = await this.loadBufferIntoSlot(buf, name);
    if (!loaded || gen !== this.playGeneration) return false;

    if (this.reinitSampleRateInFlight) {
      await this.reinitSampleRateInFlight;
    }
    if (gen !== this.playGeneration) return false;

    this.resumeAudioContextSync();
    if (this.hostAudioCtx && this.usingUserAudioCallback && !this.scriptNode) {
      this.attachWebAudioCallbackGraph(this.hostAudioCtx);
    }
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
      error: null,
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
      elapsedSeconds: 0,
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
      elapsedSeconds,
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
      ratio,
    };
  }

  public getModuleScopeSamples(
    channelIndex0Based: number,
    outBuf: Float32Array
  ): { hasData: boolean; peak: number; sumSq: number } {
    if (
      !this.state.hasSunVoxLoaded ||
      !this.state.isPlaying ||
      !this.audioInitialized ||
      !this.slotOpened ||
      !this.state.engineEnabled
    ) {
      return { hasData: false, peak: 0, sumSq: 0 };
    }
    const sv_get_module_scope2 = resolveGlobalSymbol('sv_get_module_scope2');

    if (typeof sv_get_module_scope2 === 'function') {
      const audioMods = this.state.activeModules.filter((m) => !NON_AUDIO_MODULE_TYPES.has(m.type));
      const mods = audioMods.length > 0 ? audioMods : this.state.activeModules;

      if (this.scopeInt16Scratch.length !== outBuf.length) {
        this.scopeInt16Scratch = new Int16Array(outBuf.length);
      }

      const tryReadModule = (modId: number, ch: number) => {
        try {
          const readCount = sv_get_module_scope2(0, modId, ch, this.scopeInt16Scratch, outBuf.length);
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
        return null;
      };

      const targetModId =
        mods.length > 0 && channelIndex0Based < mods.length ? mods[channelIndex0Based].id : 0;
      const primary = tryReadModule(targetModId, targetModId === 0 ? channelIndex0Based % 2 : 0);
      if (primary) return primary;

      // Channel 0 & 1 also fall back to Master Output L/R so main output always visualizes live energy
      if (targetModId !== 0 && channelIndex0Based < 2) {
        const masterFallback = tryReadModule(0, channelIndex0Based % 2);
        if (masterFallback) return masterFallback;
      }
    }

    // Fallback: use live rendered stereo buffer for master output visualization on L/R channels
    if (this.usingUserAudioCallback && this.renderedFramesCount > 0 && channelIndex0Based < 2) {
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

  private sampleLiveEffectsBrightness(effects: SunVoxEffectActivity[]): SunVoxEffectActivity[] {
    const sv_get_module_scope2 = resolveGlobalSymbol('sv_get_module_scope2');
    return effects.map((fx) => {
      if (fx.category === 'dsp' && typeof fx.modNum === 'number' && typeof sv_get_module_scope2 === 'function') {
        let peak = 0;
        let sumSq = 0;
        try {
          const readCount = sv_get_module_scope2(0, fx.modNum, 0, this.fxScopeInt16Scratch, 128);
          if (typeof readCount === 'number' && readCount > 0) {
            const lim = Math.min(128, readCount);
            for (let i = 0; i < lim; i++) {
              const s = Math.abs(this.fxScopeInt16Scratch[i] / 32768.0);
              if (s > peak) peak = s;
              sumSq += s * s;
            }
          }
        } catch {}

        const rms = Math.min(1, Math.sqrt(sumSq / 128) * 3.0);
        const level = Math.max(rms, peak * 0.85);
        const isTriggered = level > 0.012;
        const nextHitCount = isTriggered ? fx.hitCount + 1 : fx.hitCount;
        // Accumulated brightness rises steadily as the effect is used more + pulses with real-time RMS
        const accumulatedGlow = Math.min(0.75, Math.log10(1 + nextHitCount * 0.35) * 0.38);
        const nextBrightness = Math.max(0.18, Math.min(1.0, 0.18 + accumulatedGlow + level * 0.45));

        return {
          ...fx,
          hitCount: nextHitCount,
          liveLevel: level,
          brightness: nextBrightness,
        };
      }
      return fx;
    });
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
      const updatedEffects = this.sampleLiveEffectsBrightness(this.state.effectsActivity);

      this.state = {
        ...this.state,
        currentLine: line,
        elapsedSeconds,
        effectsActivity: updatedEffects,
      };

      const hasStartedAudio = !this.usingUserAudioCallback
        ? line > 0
        : this.renderedFramesCount >= 8192 && line > 0;
      const ended =
        !this.isLoadedSynthModule &&
        hasStartedAudio &&
        typeof sv_end_of_song === 'function' &&
        sv_end_of_song(0) !== 0;
      if (ended && !this.endedTriggered) {
        this.endedTriggered = true;
        this.pausedLine = 0;
        this.state = {
          ...this.state,
          isPlaying: false,
          currentLine: 0,
          elapsedSeconds: 0,
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
