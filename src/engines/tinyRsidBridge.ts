/**
 * tinyRsidBridge.ts
 * TypeScript Bridge for Jürgen Wothke's Official Bitbucket WebSID (Tiny'R'Sid)
 * WASM C64 Emulator & Companion WebAudio Player (`scriptprocessor_player.js` + `channelstreamer.js`).
 *
 * Features:
 * - Multi-SID support (1SID / 2SID / 3SID, up to 9 voices across $D400 + 2nd/3rd SID addresses)
 * - Live MOS 6581 / MOS 8580 chip filter switching (`setSID6581`)
 * - Live PAL 50Hz / NTSC 60Hz clock override (`setNTSC`)
 * - Multi-subtune switching (`emu_set_subsong`, 0-based index)
 * - Per-voice mute & solo wiring (`enableVoice(sidIdx, voice, on)`)
 * - Real-time per-voice trace buffers via `ChannelStreamer` -> 16-Channel Vector Oscilloscope Matrix
 * - Exact HVSC `Songlengths.md5` duration & `STIL.txt` integration with subtune auto-advance
 */

import { Channel } from '../types';
import { C64_BASIC_ROM_B64, C64_CHAR_ROM_B64, C64_KERNAL_ROM_B64 } from './c64Roms';
import {
  HvscLookupResult,
  SidHeaderMetadata,
  lookupHvscForSid,
  onHvscCacheChange,
  parseSidHeader,
  restoreHvscCachesFromIndexedDB
} from '../utils/hvscManager';

export const TINYRSID_ENGINE_ID = 'websid-tinyrsid-wasm';

export type SidChipOverride = 'auto' | '6581' | '8580';
export type SidClockOverride = 'auto' | 'pal' | 'ntsc';

export interface SidRuntimeState {
  hasSidLoaded: boolean;
  isPlaying: boolean;
  fileName: string;
  metadata: SidHeaderMetadata | null;
  hvsc: HvscLookupResult | null;
  currentSubtune: number; // 1-based
  totalSubtunes: number;
  chipModelOverride: SidChipOverride;
  clockOverride: SidClockOverride;
  activeChipModel: 'MOS 6581' | 'MOS 8580';
  activeClock: 'PAL 50Hz' | 'NTSC 60Hz';
  activeChipsCount: 1 | 2 | 3;
  activeSidBaseAddresses: number[];
  elapsedSeconds: number;
  durationSeconds: number;
  voiceMutes: boolean[]; // 9 voices (CH 01..09)
  engineEnabled: boolean;
}

const DEFAULT_FALLBACK_SID_DURATION_SEC = 135; // 2:15 fallback when Songlengths.md5 has no entry

declare global {
  interface Window {
    WASM_SEARCH_PATH?: string;
    _gPlayerAudioCtx?: AudioContext;
    ScriptNodePlayer?: any;
    ChannelStreamer?: any;
    SIDBackendAdapter?: any;
    spp_backend_state_SID?: any;
  }
}

function resolveGlobalSymbol(name: string): any {
  if (typeof window === 'undefined') return undefined;
  const direct = (window as any)[name];
  if (direct) return direct;
  try {
    return (0, eval)(`typeof ${name} !== "undefined" ? ${name} : undefined`);
  } catch {
    return undefined;
  }
}

function loadClassicScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-aria-websid-src="${src}"]`) as HTMLScriptElement | null;
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
    script.setAttribute('data-aria-websid-src', src);
    script.onload = () => {
      (script as any).__loaded = true;
      resolve();
    };
    script.onerror = () => {
      (script as any).__failed = true;
      script.remove();
      reject(new Error(`Failed loading script ${src}`));
    };
    document.head.appendChild(script);
  });
}

class TinyRsidBridgeClass {
  private scriptsLoadPromise: Promise<void> | null = null;
  private backend: any = null;
  private streamer: any = null;
  private playerReady = false;
  private playerInitPromise: Promise<void> | null = null;
  private currentBuffer: ArrayBuffer | null = null;
  private loadedBufferSignature: string | null = null;
  private loadedSubtune: number | null = null;
  private pendingSeekReload = false;
  private playGeneration = 0;
  private virtualSongIndex = 0;
  private seekBaseSeconds = 0;
  private playPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastChannelsSnapshot: Channel[] = [];
  private onSongEndedCallback: (() => void) | null = null;
  private endedLock = false;
  private listeners = new Set<(state: SidRuntimeState) => void>();

  private state: SidRuntimeState = {
    hasSidLoaded: false,
    isPlaying: false,
    fileName: '',
    metadata: null,
    hvsc: null,
    currentSubtune: 1,
    totalSubtunes: 1,
    chipModelOverride: 'auto',
    clockOverride: 'auto',
    activeChipModel: 'MOS 6581',
    activeClock: 'PAL 50Hz',
    activeChipsCount: 1,
    activeSidBaseAddresses: [0xd400],
    elapsedSeconds: 0,
    durationSeconds: DEFAULT_FALLBACK_SID_DURATION_SEC,
    voiceMutes: Array(9).fill(false),
    engineEnabled: true
  };

  constructor() {
    if (typeof window !== 'undefined') {
      void restoreHvscCachesFromIndexedDB();
      onHvscCacheChange(() => {
        if (this.state.metadata) {
          const refreshed = lookupHvscForSid(this.state.metadata, this.state.currentSubtune);
          const nextDur = refreshed.activeSubtuneDurationSec ?? DEFAULT_FALLBACK_SID_DURATION_SEC;
          this.state = {
            ...this.state,
            hvsc: refreshed,
            durationSeconds: nextDur
          };
          this.notify();
        }
      });
    }
  }

  public getState(): SidRuntimeState {
    return {
      ...this.state,
      voiceMutes: [...this.state.voiceMutes],
      activeSidBaseAddresses: [...this.state.activeSidBaseAddresses]
    };
  }

  public subscribe(listener: (state: SidRuntimeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    const snap = this.getState();
    this.listeners.forEach((cb) => {
      try { cb(snap); } catch {}
    });
  }

  private async ensureScriptsLoaded(): Promise<void> {
    if (this.scriptsLoadPromise) return this.scriptsLoadPromise;
    this.scriptsLoadPromise = (async () => {
      try {
        window.WASM_SEARCH_PATH = '/websid/';
        await loadClassicScript('/websid/webaudio-player.js');
        await loadClassicScript('/websid/channelstreamer.js');
        await loadClassicScript('/websid/backend_websid.js');
      } catch (err) {
        this.scriptsLoadPromise = null;
        throw err;
      }
    })();
    return this.scriptsLoadPromise;
  }

  private async ensurePlayerInitialized(ctx: AudioContext): Promise<void> {
    if (typeof window === 'undefined') return;
    window._gPlayerAudioCtx = ctx;

    if (this.playerReady && this.backend && window.ScriptNodePlayer?.getInstance?.()) {
      return;
    }
    if (this.playerInitPromise) {
      return this.playerInitPromise;
    }

    this.playerInitPromise = (async () => {
      try {
        await this.ensureScriptsLoaded();
        window._gPlayerAudioCtx = ctx;

        const SIDAdapterCtor = resolveGlobalSymbol('SIDBackendAdapter');
        const ScriptPlayer = resolveGlobalSymbol('ScriptNodePlayer');
        const ChannelStreamerCtor = resolveGlobalSymbol('ChannelStreamer');

        if (!SIDAdapterCtor || !ScriptPlayer || !ChannelStreamerCtor) {
          throw new Error('WebSID scripts loaded without expected constructors');
        }

        if (!window.SIDBackendAdapter) window.SIDBackendAdapter = SIDAdapterCtor;
        if (!window.ScriptNodePlayer) window.ScriptNodePlayer = ScriptPlayer;
        if (!window.ChannelStreamer) window.ChannelStreamer = ChannelStreamerCtor;

        this.backend = new SIDAdapterCtor(
          C64_BASIC_ROM_B64,
          C64_CHAR_ROM_B64,
          C64_KERNAL_ROM_B64,
          undefined,
          true
        );
        this.backend.setProcessorBufSize(4096 << 1);
        this.streamer = new ChannelStreamerCtor(3, true);

        await ScriptPlayer.initialize(
          this.backend,
          () => this.handleNaturalTrackEnd(),
          [],
          false,
          this.streamer
        );

        const player = ScriptPlayer.getInstance();
        if (player) {
          player.setVolume(this.state.engineEnabled ? 0.9 : 0.001);
        }
        this.playerReady = true;
      } catch (err) {
        this.playerInitPromise = null;
        this.playerReady = false;
        throw err;
      }
    })();

    return this.playerInitPromise;
  }

  /**
   * Registers parsed SID metadata without necessarily starting audio yet (e.g. on import/convert preview).
   */
  public registerSidFile(arrayBuffer: ArrayBuffer, fileName: string, subtune1Based?: number): SidRuntimeState {
    const incomingSlice = arrayBuffer.slice(0);
    const meta = parseSidHeader(incomingSlice, fileName);
    const isSameTune =
      this.state.hasSidLoaded &&
      this.state.metadata?.md5 === meta.md5 &&
      this.state.fileName === fileName;

    this.currentBuffer = incomingSlice;
    const sub = Math.max(
      1,
      Math.min(meta.songs, subtune1Based || (isSameTune ? this.state.currentSubtune : meta.startSong) || 1)
    );
    const hvsc = lookupHvscForSid(meta, sub);
    const durationSec = hvsc.activeSubtuneDurationSec ?? DEFAULT_FALLBACK_SID_DURATION_SEC;

    const addrs = [0xd400];
    if (meta.secondSIDAddress) addrs.push(meta.secondSIDAddress);
    if (meta.thirdSIDAddress) addrs.push(meta.thirdSIDAddress);

    const chipOverride = isSameTune ? this.state.chipModelOverride : 'auto';
    const clockOverride = isSameTune ? this.state.clockOverride : 'auto';
    const use6581 =
      chipOverride === '6581' ? true : chipOverride === '8580' ? false : meta.defaultIs6581;
    const useNtsc =
      clockOverride === 'ntsc' ? true : clockOverride === 'pal' ? false : meta.isNtscDefault;

    if (!isSameTune) {
      this.seekBaseSeconds = 0;
      this.loadedBufferSignature = null;
      this.loadedSubtune = null;
      this.pendingSeekReload = true;
    }

    this.state = {
      ...this.state,
      hasSidLoaded: true,
      fileName,
      metadata: meta,
      hvsc,
      currentSubtune: sub,
      totalSubtunes: meta.songs,
      chipModelOverride: chipOverride,
      clockOverride: clockOverride,
      activeChipModel: use6581 ? 'MOS 6581' : 'MOS 8580',
      activeClock: useNtsc ? 'NTSC 60Hz' : 'PAL 50Hz',
      activeChipsCount: meta.chipCount,
      activeSidBaseAddresses: addrs,
      elapsedSeconds: isSameTune ? this.state.elapsedSeconds : 0,
      durationSeconds: durationSec
    };
    this.notify();
    return this.getState();
  }

  public clearLoadedSid() {
    this.playGeneration++;
    this.stop();
    this.currentBuffer = null;
    this.loadedBufferSignature = null;
    this.loadedSubtune = null;
    this.pendingSeekReload = false;
    this.seekBaseSeconds = 0;
    this.state = {
      ...this.state,
      hasSidLoaded: false,
      isPlaying: false,
      fileName: '',
      metadata: null,
      hvsc: null,
      currentSubtune: 1,
      totalSubtunes: 1,
      chipModelOverride: 'auto',
      clockOverride: 'auto',
      activeChipModel: 'MOS 6581',
      activeClock: 'PAL 50Hz',
      activeChipsCount: 1,
      activeSidBaseAddresses: [0xd400],
      elapsedSeconds: 0,
      durationSeconds: DEFAULT_FALLBACK_SID_DURATION_SEC
    };
    this.notify();
  }

  public async playSid(
    ctx: AudioContext,
    arrayBuffer?: ArrayBuffer,
    fileName?: string,
    options?: {
      subtune1Based?: number;
      seekSeconds?: number;
      channels?: Channel[];
      onSongEnded?: () => void;
    }
  ): Promise<boolean> {
    const gen = ++this.playGeneration;

    if (options?.onSongEnded) {
      this.onSongEndedCallback = options.onSongEnded;
    }
    if (options?.channels) {
      this.lastChannelsSnapshot = options.channels;
    }

    const bufToUse = arrayBuffer ? arrayBuffer.slice(0) : this.currentBuffer;
    const nameToUse = fileName || this.state.fileName || 'tune.sid';
    if (!bufToUse) return false;

    const incomingMeta = parseSidHeader(bufToUse, nameToUse);
    const incomingSig = `${incomingMeta.md5}:${bufToUse.byteLength}:${nameToUse}`;
    const isNewFile =
      !this.state.metadata ||
      this.state.metadata.md5 !== incomingMeta.md5 ||
      this.state.fileName !== nameToUse;

    if (isNewFile) {
      this.registerSidFile(bufToUse, nameToUse, options?.subtune1Based);
    } else if (options?.subtune1Based && options.subtune1Based !== this.state.currentSubtune) {
      return this.setSubtune(options.subtune1Based, ctx);
    }

    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch {}
    }

    await this.ensurePlayerInitialized(ctx);
    if (gen !== this.playGeneration) return false;

    const ScriptPlayer = window.ScriptNodePlayer;
    const player = ScriptPlayer?.getInstance?.();
    if (!player || !this.backend) return false;

    this.endedLock = false;
    const meta = this.state.metadata!;
    const targetSub = Math.max(1, Math.min(meta.songs, options?.subtune1Based || this.state.currentSubtune || meta.startSong));
    const currentPausedElapsed = this.state.elapsedSeconds || this.seekBaseSeconds || 0;
    const targetSeek = Math.max(0, options?.seekSeconds ?? currentPausedElapsed);

    // Fast-path clean resume when the exact same SID file + subtune is already loaded and paused (without explicit seek jump)
    const canResumeInPlace =
      this.loadedBufferSignature === incomingSig &&
      this.loadedSubtune === targetSub &&
      !this.pendingSeekReload &&
      Math.abs(targetSeek - currentPausedElapsed) < 0.35 &&
      Boolean(player.getSongInfo?.());

    if (canResumeInPlace) {
      this.applyChipAndClockSettings();
      if (this.lastChannelsSnapshot.length > 0) {
        this.syncChannelStates(this.lastChannelsSnapshot);
      } else {
        this.applyVoiceMutesToBackend();
      }
      player.setVolume(this.state.engineEnabled ? 0.9 : 0.001);
      try {
        player.resume();
        if (player.isPaused?.()) {
          player.play();
        }
      } catch {}

      this.state = {
        ...this.state,
        isPlaying: true
      };
      this.startProgressPoll();
      this.notify();
      return true;
    }

    // Pause first cleanly before loading new track
    try { player.pause(); } catch {}

    const safeFileName = nameToUse.split(/[/\\]/).pop() || 'tune.sid';
    const virtualPath = `/tmp/aria_${++this.virtualSongIndex}_${safeFileName}`;

    await ScriptPlayer.loadFileData([
      { xname: virtualPath, fileBuffer: bufToUse.slice(0) }
    ]);
    if (gen !== this.playGeneration) return false;

    const hvsc = lookupHvscForSid(meta, targetSub);
    const durSec = hvsc.activeSubtuneDurationSec ?? DEFAULT_FALLBACK_SID_DURATION_SEC;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`WebSID load timed out for ${safeFileName}`));
        }
      }, 10000);

      ScriptPlayer.loadMusicFromURL(
        virtualPath,
        {
          track: targetSub - 1, // WebSID emu_set_subsong uses 0-based index
          traceSID: true
        },
        (err: any) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(typeof err === 'string' ? err : `WebSID failed loading ${safeFileName}`));
          }
        }
      ).then(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      }, (err: any) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    if (gen !== this.playGeneration) {
      try { player.pause(); } catch {}
      return false;
    }

    // Query detected SID count & base addresses from emulator
    const emuChips = Math.max(1, Math.min(3, this.backend.countSIDs?.() || meta.chipCount)) as 1 | 2 | 3;
    const addrs: number[] = [];
    for (let s = 0; s < emuChips; s++) {
      const base = this.backend.getSIDBaseAddr?.(s);
      if (base) addrs.push(base);
    }

    // Apply stereo panning across 1SID / 2SID / 3SID
    this.applyDefaultStereoPanning(emuChips);

    // Apply chip model & clock overrides (or header defaults)
    this.applyChipAndClockSettings();

    // Fast-step emulator if resuming/seeking to targetSeek > 0.2s
    if (targetSeek > 0.2 && this.backend.Module?.ccall) {
      const fps = this.state.activeClock === 'NTSC 60Hz' ? 60 : 50;
      const framesToStep = Math.min(12000, Math.round(targetSeek * fps));
      for (let f = 0; f < framesToStep; f++) {
        this.backend.Module.ccall('emu_compute_audio_samples', 'number');
      }
      this.seekBaseSeconds = targetSeek;
    } else {
      this.seekBaseSeconds = targetSeek;
    }

    // Re-apply mute/solo & pan masks across active voices
    if (this.lastChannelsSnapshot.length > 0) {
      this.syncChannelStates(this.lastChannelsSnapshot);
    } else {
      this.applyVoiceMutesToBackend();
    }

    this.loadedBufferSignature = incomingSig;
    this.loadedSubtune = targetSub;
    this.pendingSeekReload = false;

    player.setVolume(this.state.engineEnabled ? 0.9 : 0.001);
    player.play();

    this.state = {
      ...this.state,
      isPlaying: true,
      currentSubtune: targetSub,
      hvsc,
      activeChipsCount: emuChips,
      activeSidBaseAddresses: addrs.length > 0 ? addrs : this.state.activeSidBaseAddresses,
      elapsedSeconds: this.seekBaseSeconds,
      durationSeconds: durSec
    };
    this.startProgressPoll();
    this.notify();
    return true;
  }

  public pause() {
    this.playGeneration++;
    let nextElapsed = this.state.elapsedSeconds;
    try {
      const player = window.ScriptNodePlayer?.getInstance();
      if (player) {
        const curPlaytime = Number(player.getCurrentPlaytime?.() || 0);
        if (this.state.isPlaying && isFinite(curPlaytime) && curPlaytime >= 0) {
          nextElapsed = Math.min(this.state.durationSeconds, this.seekBaseSeconds + curPlaytime);
        }
        player.pause();
      }
    } catch {}
    this.stopProgressPoll();
    if (this.state.isPlaying) {
      this.state = {
        ...this.state,
        isPlaying: false,
        elapsedSeconds: nextElapsed
      };
      this.notify();
    }
  }

  public async resume(ctx: AudioContext): Promise<void> {
    if (!this.currentBuffer) return;
    await this.playSid(ctx, undefined, this.state.fileName, {
      subtune1Based: this.state.currentSubtune,
      seekSeconds: this.pendingSeekReload ? this.seekBaseSeconds : undefined,
      channels: this.lastChannelsSnapshot
    });
  }

  public stop() {
    this.playGeneration++;
    try {
      const player = window.ScriptNodePlayer?.getInstance();
      if (player) {
        player.pause();
      }
    } catch {}
    this.stopProgressPoll();
    this.seekBaseSeconds = 0;
    this.pendingSeekReload = true;
    if (this.state.isPlaying || this.state.elapsedSeconds !== 0) {
      this.state = {
        ...this.state,
        isPlaying: false,
        elapsedSeconds: 0
      };
      this.notify();
    }
  }

  public async seekSeconds(targetSeconds: number, ctx?: AudioContext): Promise<void> {
    const clamped = Math.max(0, Math.min(Math.max(1, this.state.durationSeconds - 0.1), targetSeconds));
    this.seekBaseSeconds = clamped;
    this.pendingSeekReload = true;
    this.state = { ...this.state, elapsedSeconds: clamped };
    this.notify();

    if (this.state.isPlaying && this.currentBuffer && ctx) {
      await this.playSid(ctx, this.currentBuffer, this.state.fileName, {
        subtune1Based: this.state.currentSubtune,
        seekSeconds: clamped,
        channels: this.lastChannelsSnapshot
      });
    }
  }

  public async setSubtune(subtune1Based: number, ctx?: AudioContext): Promise<boolean> {
    if (!this.state.metadata) return false;
    const clamped = Math.max(1, Math.min(this.state.metadata.songs, subtune1Based));
    const hvsc = lookupHvscForSid(this.state.metadata, clamped);
    const durSec = hvsc.activeSubtuneDurationSec ?? DEFAULT_FALLBACK_SID_DURATION_SEC;

    this.seekBaseSeconds = 0;
    this.pendingSeekReload = true;
    this.loadedSubtune = null;
    this.state = {
      ...this.state,
      currentSubtune: clamped,
      hvsc,
      elapsedSeconds: 0,
      durationSeconds: durSec
    };
    this.notify();

    if (this.currentBuffer && ctx) {
      if (this.state.isPlaying) {
        return this.playSid(ctx, this.currentBuffer, this.state.fileName, {
          subtune1Based: clamped,
          seekSeconds: 0,
          channels: this.lastChannelsSnapshot
        });
      }
    }
    return true;
  }

  public setChipModelOverride(override: SidChipOverride) {
    const meta = this.state.metadata;
    const use6581 =
      override === '6581'
        ? true
        : override === '8580'
          ? false
          : meta
            ? meta.defaultIs6581
            : true;

    if (this.backend?.isAdapterReady?.()) {
      try {
        this.backend.setSID6581(use6581 ? 1 : 0);
      } catch {}
    }

    this.state = {
      ...this.state,
      chipModelOverride: override,
      activeChipModel: use6581 ? 'MOS 6581' : 'MOS 8580'
    };
    this.notify();
  }

  public setClockOverride(override: SidClockOverride) {
    const meta = this.state.metadata;
    const useNtsc =
      override === 'ntsc'
        ? true
        : override === 'pal'
          ? false
          : meta
            ? meta.isNtscDefault
            : false;

    if (this.backend?.isAdapterReady?.()) {
      try {
        this.backend.setNTSC(useNtsc ? 1 : 0);
      } catch {}
    }

    this.state = {
      ...this.state,
      clockOverride: override,
      activeClock: useNtsc ? 'NTSC 60Hz' : 'PAL 50Hz'
    };
    this.notify();
  }

  public setEngineEnabled(enabled: boolean) {
    this.state = { ...this.state, engineEnabled: enabled };
    try {
      const player = window.ScriptNodePlayer?.getInstance();
      if (player) {
        player.setVolume(enabled ? 0.9 : 0.001);
      }
    } catch {}
    this.notify();
  }

  /**
   * Sync Aria48 Channel mute/solo/enable/pan state (CH 01..09) into WebSID per-voice controls.
   */
  public syncChannelStates(channels: Channel[]) {
    this.lastChannelsSnapshot = channels;
    const relevant = channels.slice(0, 9);
    const anySolo = relevant.some((c) => c.enabled && c.solo);

    const nextMutes = relevant.map((ch) => {
      return !ch.enabled || ch.mute || (anySolo && !ch.solo);
    });

    this.state = {
      ...this.state,
      voiceMutes: nextMutes
    };
    this.applyVoiceMutesToBackend();

    if (this.backend?.isAdapterReady?.()) {
      for (let i = 0; i < relevant.length; i++) {
        const sidIdx = Math.floor(i / 3);
        const voiceIdx = i % 3;
        const panNorm = Math.max(0, Math.min(1, (relevant[i]?.pan ?? 50) / 100));
        try {
          this.backend.setPanning?.(sidIdx, voiceIdx, panNorm);
        } catch {}
      }
    }
    this.notify();
  }

  private applyVoiceMutesToBackend() {
    if (!this.backend?.isAdapterReady?.()) return;
    for (let i = 0; i < 9; i++) {
      const sidIdx = Math.floor(i / 3);
      const voiceIdx = i % 3;
      const on = this.state.voiceMutes[i] ? 0 : 1;
      try {
        this.backend.enableVoice?.(sidIdx, voiceIdx, on);
      } catch {}
    }
  }

  private applyChipAndClockSettings() {
    if (!this.backend?.isAdapterReady?.()) return;
    const meta = this.state.metadata;
    const use6581 =
      this.state.chipModelOverride === '6581'
        ? true
        : this.state.chipModelOverride === '8580'
          ? false
          : meta
            ? meta.defaultIs6581
            : true;

    const useNtsc =
      this.state.clockOverride === 'ntsc'
        ? true
        : this.state.clockOverride === 'pal'
          ? false
          : meta
            ? meta.isNtscDefault
            : false;

    try {
      this.backend.setSID6581?.(use6581 ? 1 : 0);
      this.backend.setNTSC?.(useNtsc ? 1 : 0);
    } catch {}

    this.state = {
      ...this.state,
      activeChipModel: use6581 ? 'MOS 6581' : 'MOS 8580',
      activeClock: useNtsc ? 'NTSC 60Hz' : 'PAL 50Hz'
    };
  }

  private applyDefaultStereoPanning(chipCount: number) {
    if (!this.backend?.isAdapterReady?.()) return;
    try {
      this.backend.setStereoLevel?.(24576);
      if (chipCount === 1) {
        this.backend.setPanning?.(0, 0, 0.5);
        this.backend.setPanning?.(0, 1, 0.35);
        this.backend.setPanning?.(0, 2, 0.65);
      } else if (chipCount === 2) {
        // 2SID stereo separation: SID1 Left, SID2 Right
        this.backend.setPanning?.(0, 0, 0.25);
        this.backend.setPanning?.(0, 1, 0.30);
        this.backend.setPanning?.(0, 2, 0.20);
        this.backend.setPanning?.(1, 0, 0.75);
        this.backend.setPanning?.(1, 1, 0.70);
        this.backend.setPanning?.(1, 2, 0.80);
      } else if (chipCount >= 3) {
        // 3SID L / C / R
        this.backend.setPanning?.(0, 0, 0.18);
        this.backend.setPanning?.(0, 1, 0.22);
        this.backend.setPanning?.(0, 2, 0.25);
        this.backend.setPanning?.(1, 0, 0.50);
        this.backend.setPanning?.(1, 1, 0.45);
        this.backend.setPanning?.(1, 2, 0.55);
        this.backend.setPanning?.(2, 0, 0.82);
        this.backend.setPanning?.(2, 1, 0.78);
        this.backend.setPanning?.(2, 2, 0.75);
      }
    } catch {}
  }

  /**
   * Reads real-time per-voice audio waveform samples from WebSID's ChannelStreamer
   * for channels CH 01..09 (mapped to SID1 V1..V3, SID2 V1..V3, SID3 V1..V3).
   */
  public getVoiceScopeSamples(channelIndex0Based: number, targetBuf: Float32Array): {
    hasData: boolean;
    peak: number;
    sumSq: number;
  } {
    if (
      !this.state.isPlaying ||
      !this.state.hasSidLoaded ||
      !this.state.engineEnabled ||
      !this.streamer ||
      channelIndex0Based < 0 ||
      channelIndex0Based >= 9
    ) {
      return { hasData: false, peak: 0, sumSq: 0 };
    }

    const activeVoicesMax = this.state.activeChipsCount * 3;
    if (channelIndex0Based >= activeVoicesMax || this.state.voiceMutes[channelIndex0Based]) {
      return { hasData: false, peak: 0, sumSq: 0 };
    }

    const sidIdx = Math.floor(channelIndex0Based / 3);
    const voiceIdx = channelIndex0Based % 3;
    // Adapter.cpp allocates 4 trace streams per SID chip (0=V1, 1=V2, 2=V3, 3=Digi)
    const traceStreamIdx = sidIdx * 4 + voiceIdx;

    try {
      const numStreams = Number(this.streamer.getNumStreams?.() || 0);
      if (traceStreamIdx >= numStreams) {
        return { hasData: false, peak: 0, sumSq: 0 };
      }

      const raw = this.streamer.getData?.(traceStreamIdx) as Float32Array | undefined;
      if (!raw || raw.length === 0) {
        return { hasData: false, peak: 0, sumSq: 0 };
      }

      const copyLen = Math.min(targetBuf.length, raw.length);
      let peak = 0;
      let sumSq = 0;
      const step = raw.length > targetBuf.length ? raw.length / targetBuf.length : 1;

      for (let i = 0; i < copyLen; i++) {
        const srcIdx = Math.min(raw.length - 1, Math.floor(i * step));
        const val = raw[srcIdx] || 0;
        targetBuf[i] = val;
        const abs = Math.abs(val);
        if (abs > peak) peak = abs;
        sumSq += abs * abs;
      }
      if (copyLen < targetBuf.length) {
        targetBuf.fill(0, copyLen);
      }

      return {
        hasData: peak > 0.0005,
        peak,
        sumSq
      };
    } catch {
      return { hasData: false, peak: 0, sumSq: 0 };
    }
  }

  public getProgress(): {
    playing: boolean;
    elapsedSeconds: number;
    durationSeconds: number;
    ratio: number;
  } {
    let elapsed = this.seekBaseSeconds;
    if (this.state.isPlaying) {
      try {
        const player = window.ScriptNodePlayer?.getInstance();
        const pt = Number(player?.getCurrentPlaytime?.() || 0);
        if (isFinite(pt) && pt >= 0) {
          elapsed = this.seekBaseSeconds + pt;
        }
      } catch {}
    }
    const dur = Math.max(1, this.state.durationSeconds || DEFAULT_FALLBACK_SID_DURATION_SEC);
    const clampedElapsed = Math.max(0, Math.min(dur, elapsed));
    return {
      playing: this.state.isPlaying,
      elapsedSeconds: clampedElapsed,
      durationSeconds: dur,
      ratio: Math.max(0, Math.min(1, clampedElapsed / dur))
    };
  }

  private startProgressPoll() {
    this.stopProgressPoll();
    this.playPollTimer = setInterval(() => {
      if (!this.state.isPlaying) return;
      const prog = this.getProgress();
      this.state = {
        ...this.state,
        elapsedSeconds: prog.elapsedSeconds
      };
      this.notify();

      if (prog.elapsedSeconds >= prog.durationSeconds - 0.05) {
        this.handleNaturalTrackEnd();
      }
    }, 80);
  }

  private stopProgressPoll() {
    if (this.playPollTimer) {
      clearInterval(this.playPollTimer);
      this.playPollTimer = null;
    }
  }

  private handleNaturalTrackEnd() {
    if (this.endedLock || !this.state.isPlaying) return;
    this.endedLock = true;

    const total = this.state.totalSubtunes;
    const cur = this.state.currentSubtune;

    if (cur < total && this.currentBuffer && window._gPlayerAudioCtx) {
      const nextSub = cur + 1;
      void this.playSid(window._gPlayerAudioCtx, this.currentBuffer, this.state.fileName, {
        subtune1Based: nextSub,
        seekSeconds: 0,
        channels: this.lastChannelsSnapshot
      });
      return;
    }

    this.stop();
    this.onSongEndedCallback?.();
  }
}

export const TinyRsidBridge = new TinyRsidBridgeClass();
