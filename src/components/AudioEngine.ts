// @ts-ignore
import WebAudioTinySynth from 'webaudio-tinysynth';
import { Channel, SoundEnginesConfig } from '../types';
import { SpessaSynth, SPRESSASYNTH_ENGINE_ID } from '../engines/spressasynthLib';
import { WorkletSynthBridge } from '../engines/workletSynthBridge';
import { TinyRsidBridge, TINYRSID_ENGINE_ID } from '../engines/tinyRsidBridge';
import { onInterpolationModeChange } from '../engines/soundFontInterpolation';
import { BasicMIDI } from 'spessasynth_core';
import { WebScope, WEBSCOPE_ENGINE_ID, WEBSCOPE_PRESETS } from '../engines/webscopeOscilloscope';
import { getGmProgramForPreset } from '../utils/soundFontEngine';
import {
  getActiveSoundFontCookie,
  getDefaultSoundFontCookie,
  getSavedSoundFontsFromCookies,
  loadSavedSoundFontBinary,
  removeSavedSoundFontFromCookies,
  saveActiveSoundFontCookie,
  saveDefaultSoundFontCookie,
  saveSoundFontToCookiesAndCache
} from '../utils/cookieStorage';

export { SpessaSynth, SPRESSASYNTH_ENGINE_ID };
export { WorkletSynthBridge };
export { TinyRsidBridge, TINYRSID_ENGINE_ID };
export {
  SpessaSynthCore,
  SPRESSASYNTH_CORE_ENGINE_ID,
  SOUNDFONT_ACCEPT_ATTR,
  isSoundFontFileName
} from '../engines/spressasynthCore';
export { WebScope, WEBSCOPE_ENGINE_ID, WEBSCOPE_PRESETS };
export type { SoundEnginesConfig };

export interface SoundFontLoadingState {
  isLoading: boolean;
  soundFontName: string;
  progress: number;
  elapsedMs: number;
  durationMs: number;
}

const SOUNDFONT_SWAP_DURATION_MS = 3000;
let isRestoringSoundFonts = false;
let soundFontRestorePromise: Promise<void> | null = null;
const defaultSoundFontListeners: Array<(id: string) => void> = [];

let sfLoadingState: SoundFontLoadingState = {
  isLoading: false,
  soundFontName: '',
  progress: 0,
  elapsedMs: 0,
  durationMs: SOUNDFONT_SWAP_DURATION_MS
};
const sfLoadingListeners: Array<(state: SoundFontLoadingState) => void> = [];
let sfLoadingInterval: any = null;
let lastTriggeredSfSwapId = 'spessa-default-gm';
let lastTriggeredSfSwapAt = 0;

function notifySoundFontLoadingListeners() {
  const copy = { ...sfLoadingState };
  sfLoadingListeners.forEach(cb => {
    try { cb(copy); } catch (e) {}
  });
}

export function getSoundFontLoadingState(): SoundFontLoadingState {
  return { ...sfLoadingState };
}

export function onSoundFontLoadingChange(listener: (state: SoundFontLoadingState) => void): () => void {
  sfLoadingListeners.push(listener);
  return () => {
    const idx = sfLoadingListeners.indexOf(listener);
    if (idx !== -1) sfLoadingListeners.splice(idx, 1);
  };
}

/**
 * Triggers the 3-second SoundFont swap loading screen (pauses song for 3s and resumes afterwards).
 * Deduplicates rapid back-to-back calls for the exact same SoundFont ID within 250ms.
 */
export function triggerSoundFontSwapLoading(
  soundFontName?: string,
  swapId?: string,
  durationMs = SOUNDFONT_SWAP_DURATION_MS
): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const normalizedId = swapId || soundFontName || '';
  if (normalizedId && normalizedId === lastTriggeredSfSwapId && now - lastTriggeredSfSwapAt < 250 && sfLoadingState.isLoading) {
    return;
  }
  if (normalizedId) {
    lastTriggeredSfSwapId = normalizedId;
  }
  lastTriggeredSfSwapAt = now;

  if (sfLoadingInterval) {
    clearInterval(sfLoadingInterval);
    sfLoadingInterval = null;
  }

  const totalMs = Math.max(500, durationMs);
  const startAt = Date.now();
  const displayName = (soundFontName || 'SoundFont Bank').trim() || 'SoundFont Bank';

  sfLoadingState = {
    isLoading: true,
    soundFontName: displayName,
    progress: 0,
    elapsedMs: 0,
    durationMs: totalMs
  };
  notifySoundFontLoadingListeners();

  sfLoadingInterval = setInterval(() => {
    const elapsed = Date.now() - startAt;
    const pct = Math.min(100, Math.round((elapsed / totalMs) * 100));
    if (elapsed >= totalMs) {
      clearInterval(sfLoadingInterval);
      sfLoadingInterval = null;
      sfLoadingState = {
        isLoading: false,
        soundFontName: displayName,
        progress: 100,
        elapsedMs: totalMs,
        durationMs: totalMs
      };
      notifySoundFontLoadingListeners();
    } else {
      sfLoadingState = {
        isLoading: true,
        soundFontName: displayName,
        progress: pct,
        elapsedMs: elapsed,
        durationMs: totalMs
      };
      notifySoundFontLoadingListeners();
    }
  }, 33);
}

function notifyDefaultSoundFontListeners(id: string) {
  defaultSoundFontListeners.forEach(cb => {
    try { cb(id); } catch (e) {}
  });
}

export function getDefaultSoundFontId(): string {
  return getDefaultSoundFontCookie() || 'spessa-default-gm';
}

export function setDefaultSoundFontId(id: string): void {
  if (!id) return;
  const prevActive = SpessaSynth.getActiveSoundFont()?.id || lastTriggeredSfSwapId;
  saveDefaultSoundFontCookie(id);
  saveActiveSoundFontCookie(id);
  if (SpessaSynth.getLoadedSoundFonts().some(s => s.id === id)) {
    SpessaSynth.setActiveSoundFont(id);
  } else {
    void WorkletSynthBridge.setActiveSoundBank(id);
  }
  if (!isRestoringSoundFonts && id !== prevActive) {
    const sfName = SpessaSynth.getLoadedSoundFonts().find(s => s.id === id)?.name || id;
    triggerSoundFontSwapLoading(sfName, id);
  }
  notifyDefaultSoundFontListeners(id);
}

export function onDefaultSoundFontChange(listener: (id: string) => void): () => void {
  defaultSoundFontListeners.push(listener);
  return () => {
    const idx = defaultSoundFontListeners.indexOf(listener);
    if (idx !== -1) defaultSoundFontListeners.splice(idx, 1);
  };
}

export async function deleteSavedSoundFont(id: string): Promise<void> {
  if (!id || id === 'spessa-default-gm' || id === 'spessa-chiptune-sf2') return;
  const targetSf = SpessaSynth.getLoadedSoundFonts().find(s => s.id === id);
  const cookieEntries = getSavedSoundFontsFromCookies();
  const cookieEntry = cookieEntries.find(e => e.id === id);
  const fallbackNameOrFile = targetSf?.name || cookieEntry?.name || cookieEntry?.fileName;

  const wasDefault = getDefaultSoundFontCookie() === id;
  const wasActive = SpessaSynth.getActiveSoundFont()?.id === id;

  await removeSavedSoundFontFromCookies(id, fallbackNameOrFile);

  if (wasActive) {
    const remainingFonts = SpessaSynth.getLoadedSoundFonts().filter(s => s.id !== id);
    const nextFallbackId = remainingFonts[0]?.id || 'spessa-default-gm';
    lastTriggeredSfSwapId = nextFallbackId;
  }

  await WorkletSynthBridge.removeSoundBank(id);
  const removedFromCore = SpessaSynth.removeSoundFont(id);

  const nextActive = SpessaSynth.getActiveSoundFont()?.id || 'spessa-default-gm';
  if (!removedFromCore) {
    await WorkletSynthBridge.setActiveSoundBank(nextActive);
  }
  saveActiveSoundFontCookie(nextActive);

  if (wasDefault) {
    const nextDefault = getDefaultSoundFontCookie() || 'spessa-default-gm';
    notifyDefaultSoundFontListeners(nextDefault);
  }
}

/**
 * Unified SoundFont ingestion pipeline:
 * Feeds ANY SoundFont (.sf2, .sf3, .dls, .sfz, .sbk, .gig, .pat, .sfpack, etc.)
 * into spressasynth_core-master.zip, WorkletSynthesizer (spessasynth_lib),
 * and saves the added SoundFont into browser cookies (+ IndexedDB backing for large banks).
 */
export async function loadSoundFontIntoCoreAndLib(
  arrayBuffer: ArrayBuffer,
  fileName: string,
  options?: { skipCookieSave?: boolean }
) {
  const ctx = getAudioContext() || SpessaSynth.init();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch (e) {}
  }
  const bufferCopy = arrayBuffer.slice(0);
  // Suppress intermediate Worklet switch until loadSoundBank stores bufferCopy cleanly
  const prevRestoring = isRestoringSoundFonts;
  isRestoringSoundFonts = true;
  let soundFont: ReturnType<typeof SpessaSynth.loadSoundFontAsync> extends Promise<infer R> ? R extends { soundFont: infer S } ? S : any : any;
  let coreResult: any;
  try {
    const res = await SpessaSynth.loadSoundFontAsync(arrayBuffer, fileName, ctx);
    soundFont = res.soundFont;
    coreResult = res.coreResult;
  } finally {
    isRestoringSoundFonts = prevRestoring;
  }

  try {
    await WorkletSynthBridge.loadSoundBank(bufferCopy, soundFont.id, true);
  } catch (e) {}

  if (!prevRestoring && soundFont?.id) {
    saveActiveSoundFontCookie(soundFont.id);
    if (soundFont.id !== lastTriggeredSfSwapId) {
      triggerSoundFontSwapLoading(soundFont.name || soundFont.id, soundFont.id);
    }
  }

  if (!options?.skipCookieSave) {
    try {
      await saveSoundFontToCookiesAndCache(fileName, arrayBuffer, soundFont.id, {
        name: soundFont.name,
        format: soundFont.format
      });
    } catch (e) {}
  }
  return {
    soundFont,
    bankInfo: coreResult.bankInfo,
    instruments: coreResult.instruments,
    logs: coreResult.logs
  };
}

/**
 * Restore all user-added SoundFonts saved in browser cookies across sessions,
 * and automatically activate the user's chosen Default SoundFont (or last active bank).
 */
export function restoreSavedSoundFontsFromCookies(): Promise<void> {
  if (soundFontRestorePromise) return soundFontRestorePromise;
  soundFontRestorePromise = (async () => {
    const savedEntries = getSavedSoundFontsFromCookies();
    const defaultSfId = getDefaultSoundFontCookie();
    const savedActiveId = getActiveSoundFontCookie();

    isRestoringSoundFonts = true;
    try {
      if (savedEntries.length > 0) {
        const ctx = getAudioContext() || SpessaSynth.init();
        // Load oldest -> newest so newest becomes active unless a specific default/active ID is preferred
        for (let i = savedEntries.length - 1; i >= 0; i--) {
          const entry = savedEntries[i];
          try {
            const buf = await loadSavedSoundFontBinary(entry);
            if (buf && buf.byteLength > 0) {
              const workletCopy = buf.slice(0);
              const { soundFont } = await SpessaSynth.loadSoundFontAsync(buf, entry.fileName, ctx, entry.id);
              await WorkletSynthBridge.loadSoundBank(workletCopy, soundFont.id, false);
            }
          } catch (err) {
            console.warn(`Could not restore SoundFont "${entry.fileName}" from cookies:`, err);
          }
        }
      }

      const loaded = SpessaSynth.getLoadedSoundFonts();
      const targetId =
        (defaultSfId && loaded.some(s => s.id === defaultSfId) ? defaultSfId : null) ||
        (savedActiveId && loaded.some(s => s.id === savedActiveId) ? savedActiveId : null);

      if (targetId) {
        SpessaSynth.setActiveSoundFont(targetId);
        await WorkletSynthBridge.setActiveSoundBank(targetId);
        lastTriggeredSfSwapId = targetId;
      } else {
        lastTriggeredSfSwapId = SpessaSynth.getActiveSoundFont()?.id || 'spessa-default-gm';
      }
    } finally {
      isRestoringSoundFonts = false;
    }
  })();
  return soundFontRestorePromise;
}

if (typeof window !== 'undefined') {
  SpessaSynth.onSoundFontChange((fonts, activeId) => {
    if (!isRestoringSoundFonts && activeId) {
      saveActiveSoundFontCookie(activeId);
      SpessaSynth.allSoundOff();
      void WorkletSynthBridge.setActiveSoundBank(activeId);
      if (activeId !== lastTriggeredSfSwapId) {
        const sfName = fonts.find(f => f.id === activeId)?.name || activeId;
        triggerSoundFontSwapLoading(sfName, activeId);
      }
    }
  });
  onInterpolationModeChange((mode) => {
    WorkletSynthBridge.setInterpolationMode(mode);
  });
}

export const DEFAULT_SOUND_ENGINES: SoundEnginesConfig = {
  spessaSynth: true,
  tinySynth: true,
  syntheticOsc: true,
  spessaSynthCore: true,
  tinyRSid: true,
};

let activeEnginesConfig: SoundEnginesConfig = (() => {
  try {
    const raw = localStorage.getItem('aria48_sound_engines');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        spessaSynth: typeof parsed.spessaSynth === 'boolean' ? parsed.spessaSynth : DEFAULT_SOUND_ENGINES.spessaSynth,
        tinySynth: typeof parsed.tinySynth === 'boolean' ? parsed.tinySynth : DEFAULT_SOUND_ENGINES.tinySynth,
        syntheticOsc: typeof parsed.syntheticOsc === 'boolean' ? parsed.syntheticOsc : DEFAULT_SOUND_ENGINES.syntheticOsc,
        spessaSynthCore: typeof parsed.spessaSynthCore === 'boolean' ? parsed.spessaSynthCore : DEFAULT_SOUND_ENGINES.spessaSynthCore,
        tinyRSid: typeof parsed.tinyRSid === 'boolean' ? parsed.tinyRSid : DEFAULT_SOUND_ENGINES.tinyRSid,
      };
    }
  } catch (e) {}
  return { ...DEFAULT_SOUND_ENGINES };
})();

if (typeof window !== 'undefined') {
  TinyRsidBridge.setEngineEnabled(activeEnginesConfig.tinyRSid);
}

const engineChangeListeners: ((config: SoundEnginesConfig) => void)[] = [];

export function getSoundEnginesConfig(): SoundEnginesConfig {
  return { ...activeEnginesConfig };
}

export function setSoundEnginesConfig(config: Partial<SoundEnginesConfig>) {
  activeEnginesConfig = {
    spessaSynth: config.spessaSynth ?? activeEnginesConfig.spessaSynth,
    tinySynth: config.tinySynth ?? activeEnginesConfig.tinySynth,
    syntheticOsc: config.syntheticOsc ?? activeEnginesConfig.syntheticOsc,
    spessaSynthCore: config.spessaSynthCore ?? activeEnginesConfig.spessaSynthCore,
    tinyRSid: config.tinyRSid ?? activeEnginesConfig.tinyRSid,
  };
  
  if (tinySynthMasterGain && audioCtx) {
    tinySynthMasterGain.gain.setValueAtTime(activeEnginesConfig.tinySynth ? 0.55 : 0, audioCtx.currentTime);
  }
  if (syntheticMasterGain && audioCtx) {
    syntheticMasterGain.gain.setValueAtTime(activeEnginesConfig.syntheticOsc ? 0.35 : 0, audioCtx.currentTime);
  }
  const spessaMaster = SpessaSynth.getMasterGain();
  if (spessaMaster && audioCtx) {
    spessaMaster.gain.setValueAtTime(activeEnginesConfig.spessaSynthCore ? 0.7 : 0, audioCtx.currentTime);
  }
  WorkletSynthBridge.setMasterVolumeGain(activeEnginesConfig.spessaSynth ? 0.85 : 0);
  TinyRsidBridge.setEngineEnabled(activeEnginesConfig.tinyRSid);

  if (!activeEnginesConfig.syntheticOsc) {
    activeSyntheticVoices.forEach(v => { try { v.stop(); } catch(e) {} });
    activeSyntheticVoices.length = 0;
  }
  if (!activeEnginesConfig.spessaSynth) {
    WorkletSynthBridge.stopAll(false);
  }
  if (!activeEnginesConfig.spessaSynthCore) {
    SpessaSynth.allNotesOff();
  }
  if (!activeEnginesConfig.tinySynth && tinySynthInstance) {
    try {
      for (let ch = 0; ch < 16; ch++) tinySynthInstance.allSoundOff?.(ch);
    } catch(e) {}
  }

  engineChangeListeners.forEach(cb => cb({ ...activeEnginesConfig }));
  try {
    localStorage.setItem('aria48_sound_engines', JSON.stringify(activeEnginesConfig));
  } catch (e) {}
}

export function onSoundEnginesChange(callback: (config: SoundEnginesConfig) => void): () => void {
  engineChangeListeners.push(callback);
  return () => {
    const idx = engineChangeListeners.indexOf(callback);
    if (idx !== -1) engineChangeListeners.splice(idx, 1);
  };
}

let audioCtx: AudioContext | null = null;
let tinySynthInstance: any = null;
let tinySynthMasterGain: GainNode | null = null;
let tinySynthLimiter: DynamicsCompressorNode | null = null;
let syntheticMasterGain: GainNode | null = null;
let syntheticLimiter: DynamicsCompressorNode | null = null;
let directAudioMasterGain: GainNode | null = null;
let directAudioSource: AudioBufferSourceNode | null = null;
let directAudioBufferRef: AudioBuffer | null = null;
let directAudioStartCtxTime = 0;
let directAudioOffsetSec = 0;
let directAudioPlaybackRate = 1.0;
let isMidiPlayingInternal = false;
let midiBaseDurationSecCache = 0;
let midiMaxTickCache = 1;

interface ActiveOscVoice {
  stop: () => void;
  channelId: number;
}
const MAX_SYNTHETIC_VOICES = 64;
const activeSyntheticVoices: ActiveOscVoice[] = [];
let isTinySynthHooked = false;
let suppressHookForward = false;
let midiPlaybackWatchdogTimer: any = null;
let midiEndTailTimer: any = null;
let midiPlaybackGeneration = 0;
const scheduledForwardTimers = new Set<ReturnType<typeof setTimeout>>();
const scheduledNoteOffTimers = new Set<ReturnType<typeof setTimeout>>();

// TinySynth burst rate-limiter state (prevents WebAudioTinySynth 64-voice sort/prune lockup under 10,000 notes/sec)
const TS_BURST_WINDOW_MS = 50;
const TS_MAX_NOTES_PER_WINDOW = 24;
const TS_COALESCE_SEC = 0.006;
let tsBurstWindowStartMs = 0;
let tsBurstNoteCount = 0;
const tsLastNoteAt = new Float64Array(16 * 128);

function cancelAllScheduledNotesAndSilence(options?: { keepMidiPlayingFlag?: boolean }) {
  midiPlaybackGeneration++;

  scheduledForwardTimers.forEach((timerId) => clearTimeout(timerId));
  scheduledForwardTimers.clear();

  scheduledNoteOffTimers.forEach((timerId) => clearTimeout(timerId));
  scheduledNoteOffTimers.clear();

  tsLastNoteAt.fill(0);

  if (tinySynthInstance) {
    try {
      if (!options?.keepMidiPlayingFlag) {
        tinySynthInstance.stopMIDI?.();
      }
      for (let ch = 0; ch < 16; ch++) {
        tinySynthInstance.setSustain?.(ch, 0);
        tinySynthInstance.allSoundOff?.(ch);
      }
    } catch {}
  }

  SpessaSynth.allSoundOff();
  WorkletSynthBridge.stopAll(true);

  activeSyntheticVoices.forEach(v => {
    try { v.stop(); } catch {}
  });
  activeSyntheticVoices.length = 0;
}

function shouldUseWorkletPrimary(): boolean {
  const activeSf = SpessaSynth.getActiveSoundFont();
  if (activeSf?.id === 'spessa-chiptune-sf2') return false;
  if (activeSf?.isCustom && !WorkletSynthBridge.isActiveBankSupportedByWorklet()) {
    return false;
  }
  return WorkletSynthBridge.hasSoundBankReady();
}

/**
 * Mute / Unmute a specific MIDI channel (0-15) across SpessaSynth, WorkletSynthesizer, TinySynth, and Synthetic Oscillators.
 */
export function setMidiChannelMuted(channelIndex: number, isMuted: boolean): boolean {
  const ch = Math.max(0, Math.min(15, Math.floor(channelIndex)));
  SpessaSynth.setChannelMute(ch, isMuted);
  WorkletSynthBridge.muteChannel(ch, isMuted);

  if (isMuted) {
    if (tinySynthInstance) {
      try {
        tinySynthInstance.allSoundOff?.(ch);
      } catch (e) {}
    }
    for (let i = activeSyntheticVoices.length - 1; i >= 0; i--) {
      if ((activeSyntheticVoices[i].channelId - 1) % 16 === ch) {
        try { activeSyntheticVoices[i].stop(); } catch (e) {}
        activeSyntheticVoices.splice(i, 1);
      }
    }
  }
  return isMuted;
}

export function toggleMidiChannelMute(channelIndex: number): boolean {
  const ch = Math.max(0, Math.min(15, Math.floor(channelIndex)));
  const nextMuted = !(SpessaSynth.isChannelMuted(ch) || WorkletSynthBridge.isChannelMuted(ch));
  return setMidiChannelMuted(ch, nextMuted);
}

/**
 * Synchronize Aria48 channel mute, solo, enable, and panning states across
 * TinyRSid (WebSID), WorkletSynthesizer, and SpessaSynth.
 */
export function syncChannelMuteSolo(channels: Channel[]) {
  const anySolo = channels.some((c) => c.enabled && c.solo);
  for (let i = 0; i < Math.min(16, channels.length); i++) {
    const ch = channels[i];
    const effectiveMute = !ch.enabled || ch.mute || (anySolo && !ch.solo);
    setMidiChannelMuted(i, effectiveMute);
  }
  TinyRsidBridge.syncChannelStates(channels);
}

/**
 * Phase-Locked Sound Engine Synchronizer:
 * Hooks TinySynth's internal SMF event dispatcher (`send(msg, t)`).
 * Forwards ALL up-to-10,000 notes/sec events synchronously to SpessaSynth while shielding
 * TinySynth's heavier O(N log N) voice allocator from dense Black MIDI floods.
 */
export function hookTinySynthEvents(synth: any) {
  if (!synth || isTinySynthHooked) return;
  const originalSend = synth.send.bind(synth);

  const dispatchImmediate = (msg: number[]) => {
    const status = msg && msg.length > 0 ? msg[0] : 0;
    const cmd = status & 0xf0;
    const ch = status & 0x0f;
    const isNoteOn = cmd === 0x90 && msg[2] > 0;
    const isNoteOff = cmd === 0x80 || (cmd === 0x90 && msg[2] === 0);

    // Suppress Note-On on muted MIDI channels across TinySynth, WorkletSynthesizer, and SpessaSynth
    if (isNoteOn && (SpessaSynth.isChannelMuted(ch) || WorkletSynthBridge.isChannelMuted(ch))) {
      return;
    }

    // 1. Process TinySynth voice synthesis only when enabled, with burst protection under Rush E density
    if (activeEnginesConfig.tinySynth || (!isNoteOn && !isNoteOff)) {
      let allowTinySynth = true;
      if (isNoteOn) {
        const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (nowPerf - tsBurstWindowStartMs >= TS_BURST_WINDOW_MS) {
          tsBurstWindowStartMs = nowPerf;
          tsBurstNoteCount = 0;
        }
        const key = (ch << 7) | (msg[1] & 0x7f);
        const evTime = audioCtx?.currentTime || 0;
        if (evTime - tsLastNoteAt[key] < TS_COALESCE_SEC && evTime >= tsLastNoteAt[key]) {
          allowTinySynth = false;
        } else if (tsBurstNoteCount >= TS_MAX_NOTES_PER_WINDOW) {
          allowTinySynth = false;
        } else {
          tsLastNoteAt[key] = evTime;
          tsBurstNoteCount++;
        }
      }
      if (allowTinySynth) {
        originalSend(msg);
      }
    }

    // 2. Forward full MIDI stream synchronously to WorkletSynthesizer (spessaSynth) & SpessaSynthCore (spessaSynthCore)
    if (!suppressHookForward && (activeEnginesConfig.spessaSynth || activeEnginesConfig.spessaSynthCore) && msg && msg.length > 0) {
      const workletPrimary = shouldUseWorkletPrimary() && activeEnginesConfig.spessaSynth;

      if (activeEnginesConfig.spessaSynth && WorkletSynthBridge.isReadySync()) {
        if (status === 0xff) {
          WorkletSynthBridge.sendGMSystemOn();
        } else {
          WorkletSynthBridge.sendRawMidiMessage(msg);
        }
      }

      if (activeEnginesConfig.spessaSynthCore && !workletPrimary) {
        if (cmd === 0x90) {
          const note = msg[1];
          const vel = msg[2];
          if (vel > 0) {
            SpessaSynth.noteOn(ch, note, vel);
          } else {
            SpessaSynth.noteOff(ch, note);
          }
        } else if (cmd === 0x80) {
          const note = msg[1];
          SpessaSynth.noteOff(ch, note);
        }
      }

      // Always keep SpessaSynth channel metadata synced
      if (cmd === 0xc0) {
        SpessaSynth.setChannelProgram(ch, msg[1]);
      } else if (cmd === 0xe0) {
        const bend = ((msg[2] << 7) | msg[1]) - 8192;
        SpessaSynth.setChannelPitchBend(ch, bend);
      } else if (cmd === 0xb0) {
        const cc = msg[1];
        const val = msg[2];
        if (cc === 0) SpessaSynth.setChannelBank(ch, val);
        else if (cc === 7) SpessaSynth.setChannelVolume(ch, val);
        else if (cc === 10) SpessaSynth.setChannelPan(ch, val);
        else if (cc === 11) SpessaSynth.setChannelExpression(ch, val);
        else if (cc === 64) SpessaSynth.setChannelSustain(ch, val >= 64);
        else if (cc === 65) SpessaSynth.setChannelPortamento(ch, val >= 64);
        else if (cc === 5) SpessaSynth.setChannelPortamentoTime(ch, val);
        else if (cc === 84) SpessaSynth.setChannelPortamentoControl(ch, val);
        else if (cc === 120 || cc === 123) SpessaSynth.allNotesOff(ch);
        else if (cc === 121) SpessaSynth.resetChannelControllers(ch);
      } else if (status === 0xff) {
        SpessaSynth.sendGMReset(true);
      }
    }
  };

  synth.send = function(msg: number[], t?: number) {
    if (!msg || msg.length === 0) return;

    // Schedule TinySynth lookahead events (up to 200ms preroll) in JS timers guarded by generation
    // so pausing or scrubbing the TimeBar cancels every future event instantaneously with zero orphaned queue notes!
    const curAudioTime = audioCtx?.currentTime || 0;
    const delayMs = typeof t === 'number' && Number.isFinite(t) ? (t - curAudioTime) * 1000 : 0;

    if (!suppressHookForward && delayMs > 8) {
      const genAtSchedule = midiPlaybackGeneration;
      const msgCopy = msg.slice();
      const timerId = setTimeout(() => {
        scheduledForwardTimers.delete(timerId);
        if (genAtSchedule !== midiPlaybackGeneration || !isMidiPlayingInternal) {
          return;
        }
        dispatchImmediate(msgCopy);
      }, Math.min(450, Math.round(delayMs)));
      scheduledForwardTimers.add(timerId);
      return;
    }

    dispatchImmediate(msg);
  };

  isTinySynthHooked = true;
}

function shapeTinySynthNoiseBuffer(synth: any, sampleRate: number) {
  try {
    const n0: AudioBuffer | undefined = synth?.noiseBuf?.n0;
    if (!n0 || (n0 as any).__ariaShaped) return;
    const data = n0.getChannelData(0);
    // 2-pole Biquad High-Pass Filter (>3.8 kHz) strips raw static-shaker mud from TinySynth drums
    const sr = n0.sampleRate || sampleRate || 44100;
    const w0 = (2 * Math.PI * Math.min(sr * 0.45, 3800)) / sr;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * 0.85);
    const a0 = 1 + alpha;
    const nb0 = ((1 + cosW0) / 2) / a0;
    const nb1 = (-(1 + cosW0)) / a0;
    const nb2 = ((1 + cosW0) / 2) / a0;
    const na1 = (-2 * cosW0) / a0;
    const na2 = (1 - alpha) / a0;

    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < data.length; i++) {
      const x0 = data[i];
      const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
      data[i] = Math.max(-0.95, Math.min(0.95, y0 * 0.40));
    }
    (n0 as any).__ariaShaped = true;
  } catch (e) {}
}

export function initTinySynth(ctx: AudioContext) {
  try {
    if (!tinySynthMasterGain) {
      tinySynthMasterGain = ctx.createGain();
      tinySynthMasterGain.gain.setValueAtTime(activeEnginesConfig.tinySynth ? 0.55 : 0, ctx.currentTime);

      tinySynthLimiter = ctx.createDynamicsCompressor();
      tinySynthLimiter.threshold.setValueAtTime(-7, ctx.currentTime);
      tinySynthLimiter.knee.setValueAtTime(6, ctx.currentTime);
      tinySynthLimiter.ratio.setValueAtTime(16, ctx.currentTime);
      tinySynthLimiter.attack.setValueAtTime(0.001, ctx.currentTime);
      tinySynthLimiter.release.setValueAtTime(0.08, ctx.currentTime);

      tinySynthMasterGain.connect(tinySynthLimiter);
      tinySynthLimiter.connect(ctx.destination);
    }
    if (!tinySynthInstance && typeof WebAudioTinySynth !== 'undefined') {
      tinySynthInstance = new WebAudioTinySynth({ quality: 1, useReverb: 0 });
    }
    if (tinySynthInstance) {
      tinySynthInstance.setAudioContext(ctx, tinySynthMasterGain);
      tinySynthInstance.setVoices?.(96);
      tinySynthInstance.setMasterVol(0.55);
      shapeTinySynthNoiseBuffer(tinySynthInstance, ctx.sampleRate);
      hookTinySynthEvents(tinySynthInstance);
    }
  } catch (err) {
    console.warn("TinySynth initialization note:", err);
  }
}

export function initSyntheticEngine(ctx: AudioContext) {
  try {
    if (!syntheticMasterGain) {
      syntheticMasterGain = ctx.createGain();
      syntheticMasterGain.gain.setValueAtTime(0.35, ctx.currentTime);

      syntheticLimiter = ctx.createDynamicsCompressor();
      syntheticLimiter.threshold.setValueAtTime(-7, ctx.currentTime);
      syntheticLimiter.knee.setValueAtTime(6, ctx.currentTime);
      syntheticLimiter.ratio.setValueAtTime(16, ctx.currentTime);
      syntheticLimiter.attack.setValueAtTime(0.001, ctx.currentTime);
      syntheticLimiter.release.setValueAtTime(0.08, ctx.currentTime);

      syntheticMasterGain.connect(syntheticLimiter);
      syntheticLimiter.connect(ctx.destination);
    }
    if (!directAudioMasterGain) {
      directAudioMasterGain = ctx.createGain();
      directAudioMasterGain.gain.setValueAtTime(0.85, ctx.currentTime);
      directAudioMasterGain.connect(ctx.destination);
    }
    WebScope.initDirectAudioMatrix(ctx);
  } catch (e) {}
}

export function getAudioContext(): AudioContext | null {
  if (!audioCtx && typeof window !== 'undefined') {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
      (window as any)._gPlayerAudioCtx = audioCtx;
      SpessaSynth.init(audioCtx);
      void WorkletSynthBridge.init(audioCtx);
      initTinySynth(audioCtx);
      initSyntheticEngine(audioCtx);
    }
  }
  return audioCtx;
}

export function unlockAudioContextSync(): AudioContext | null {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try {
      void ctx.resume();
    } catch {}
  }
  return ctx;
}

if (typeof window !== 'undefined') {
  const resumeSuspendedAudio = () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      try {
        void audioCtx.resume();
      } catch {}
    }
  };
  window.addEventListener('pointerdown', resumeSuspendedAudio, { passive: true });
  window.addEventListener('keydown', resumeSuspendedAudio, { passive: true });
}

export function getTinySynth(): any {
  if (!tinySynthInstance) {
    const ctx = getAudioContext();
    if (ctx) initTinySynth(ctx);
  }
  return tinySynthInstance;
}

export function getTinySynthMasterGain(): GainNode | null {
  getAudioContext();
  return tinySynthMasterGain;
}

export function getSyntheticMasterGain(): GainNode | null {
  getAudioContext();
  return syntheticMasterGain;
}

export function getDirectAudioMasterGain(): GainNode | null {
  getAudioContext();
  return directAudioMasterGain;
}

let useWorkletSequencerActive = false;
let activeSequenceFileNameCache = 'sequence.mid';

/**
 * Dynamically scale SpessaSynth Sequencer & WebAudioTinySynth MIDI playback speed according to BPM controller.
 */
export function setMidiTempoBpm(targetBpm: number, baseSongBpm?: number) {
  if (useWorkletSequencerActive) {
    const meta = WorkletSynthBridge.getSequenceMetadata();
    const baseBpm = Math.max(30, meta?.bpm || baseSongBpm || 125);
    const clampedTarget = Math.max(30, Math.min(320, Number(targetBpm) || baseBpm));
    const rate = Math.max(0.25, Math.min(4.0, clampedTarget / baseBpm));
    WorkletSynthBridge.setSequencerPlaybackRate(rate);
  }

  const synth = tinySynthInstance;
  if (!synth || !synth.song) return;

  const baseBpm = Math.max(30, (synth as any).__ariaBaseBpm || baseSongBpm || 120);
  const baseTimebase = (synth as any).__ariaBaseTimebase || synth.song.timebase || 1920;
  if (!(synth as any).__ariaBaseTimebase) {
    (synth as any).__ariaBaseTimebase = baseTimebase;
  }

  const clampedTarget = Math.max(30, Math.min(320, Number(targetBpm) || baseBpm));
  const rate = Math.max(0.25, Math.min(4.0, clampedTarget / baseBpm));

  synth.song.timebase = baseTimebase * rate;
  const activeTempo = Math.max(20, synth.song.tempo || baseBpm);
  synth.tick2Time = (4 * 60) / activeTempo / synth.song.timebase;
}

function computeMidiBaseDurationSec(synth: any): number {
  const ev = synth?.song?.ev;
  const timebase = (synth as any).__ariaBaseTimebase || synth?.song?.timebase || 1920;
  const maxTick = Math.max(1, synth?.maxTick || 1);
  const fallbackBpm = Math.max(30, (synth as any).__ariaBaseBpm || synth?.song?.tempo || 120);
  if (!Array.isArray(ev) || ev.length === 0) {
    return Math.max(1, maxTick * ((4 * 60) / fallbackBpm / timebase));
  }
  let tempo = fallbackBpm;
  let prevTick = 0;
  let total = 0;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    const tick = typeof e.t === 'number' ? e.t : prevTick;
    if (tick > prevTick) {
      total += (tick - prevTick) * ((4 * 60) / Math.max(20, tempo) / timebase);
      prevTick = tick;
    }
    if (e.m && e.m[0] === 0xff51 && e.m[1] > 0) {
      tempo = e.m[1];
    }
  }
  if (maxTick > prevTick) {
    total += (maxTick - prevTick) * ((4 * 60) / Math.max(20, tempo) / timebase);
  }
  return Math.max(1, total);
}

export function syncInitialMidiInstruments(arrayBuffer: ArrayBuffer, fileName = 'sequence.mid') {
  try {
    activeSequenceFileNameCache = fileName || 'sequence.mid';
    const midi = BasicMIDI.fromArrayBuffer(arrayBuffer.slice(0), fileName);
    // Embedded SoundBanks (MOD/XM/S3M) manage their own auto-generated sample presets via Sequencer
    if (midi?.embeddedSoundBank && midi.embeddedSoundBank.byteLength > 12) {
      return;
    }

    const bankMSB = new Int16Array(16).fill(0);
    const bankLSB = new Int16Array(16).fill(0);
    const firstProg = new Int16Array(16).fill(-1);
    const tracks = midi?.tracks || [];
    for (const trk of tracks) {
      const events = trk?.events || [];
      for (const ev of events) {
        const status = ev?.statusByte || 0;
        const cmd = status & 0xf0;
        const ch = status & 0x0f;
        const data = ev?.data;
        if (!data || ch < 0 || ch > 15) continue;
        if (cmd === 0xb0) {
          const cc = data[0];
          const val = data[1];
          if (cc === 0 && firstProg[ch] === -1) bankMSB[ch] = val;
          else if (cc === 32 && firstProg[ch] === -1) bankLSB[ch] = val;
        } else if (cmd === 0xc0 && firstProg[ch] === -1) {
          firstProg[ch] = data[0] & 0x7f;
        }
      }
    }
    for (let ch = 0; ch < 16; ch++) {
      const prog = firstProg[ch] >= 0 ? firstProg[ch] : 0;
      const msb = ch === 9 ? 128 : Math.max(0, bankMSB[ch]);
      const lsb = Math.max(0, bankLSB[ch]);
      SpessaSynth.setChannelBank(ch, msb);
      SpessaSynth.setChannelProgram(ch, prog);
      if (!WorkletSynthBridge.getChannelState(ch).presetLocked) {
        WorkletSynthBridge.selectPreset(ch, msb, lsb, prog, ch === 9);
      }
    }
  } catch (err) {
    console.warn('MIDI initial instrument sync note:', err);
  }
}

function playMidiViaTinySynthFallback(
  arrayBuffer: ArrayBuffer,
  onEnded?: () => void,
  targetBpm?: number,
  baseSongBpm?: number,
  initialSeekRatio = 0
) {
  const synth = getTinySynth();
  if (!synth) return;
  hookTinySynthEvents(synth);

  SpessaSynth.sendGMReset(true);
  WorkletSynthBridge.stopAll(true);
  syncInitialMidiInstruments(arrayBuffer, activeSequenceFileNameCache);

  synth.loadMIDI(arrayBuffer);
  if (synth.song) {
    (synth as any).__ariaBaseTimebase = synth.song.timebase || 1920;
    const firstTempoEv = Array.isArray(synth.song.ev)
      ? synth.song.ev.find((ev: any) => ev?.m?.[0] === 0xff51)
      : null;
    (synth as any).__ariaBaseBpm = baseSongBpm || firstTempoEv?.m?.[1] || synth.song.tempo || 120;
  }

  const status = synth.getPlayStatus?.();
  midiMaxTickCache = Math.max(1, status?.maxTick || synth.maxTick || 1);
  midiBaseDurationSecCache = computeMidiBaseDurationSec(synth);

  if (initialSeekRatio > 0) {
    const startTick = Math.round(Math.max(0, Math.min(0.995, initialSeekRatio)) * midiMaxTickCache);
    suppressHookForward = true;
    try {
      synth.locateMIDI?.(startTick);
    } finally {
      suppressHookForward = false;
    }
  }

  synth.playMIDI();
  if (targetBpm) {
    setMidiTempoBpm(targetBpm, baseSongBpm);
  }

  if (initialSeekRatio > 0 && Array.isArray(synth.pg)) {
    for (let ch = 0; ch < 16; ch++) {
      const prog = synth.pg[ch];
      if (typeof prog === 'number') {
        SpessaSynth.setChannelProgram(ch, prog);
        if (!WorkletSynthBridge.getChannelState(ch).presetLocked) {
          WorkletSynthBridge.programChange(ch, prog);
        }
      }
    }
  }

  isMidiPlayingInternal = true;

  if (midiPlaybackWatchdogTimer) clearInterval(midiPlaybackWatchdogTimer);
  if (midiEndTailTimer) {
    clearTimeout(midiEndTailTimer);
    midiEndTailTimer = null;
  }
  midiPlaybackWatchdogTimer = setInterval(() => {
    const curStatus = synth.getPlayStatus?.();
    if (curStatus && !curStatus.play && isMidiPlayingInternal) {
      isMidiPlayingInternal = false;
      clearInterval(midiPlaybackWatchdogTimer);
      midiPlaybackWatchdogTimer = null;
      midiEndTailTimer = setTimeout(() => {
        midiEndTailTimer = null;
        SpessaSynth.allNotesOff();
        onEnded?.();
      }, 320);
    }
  }, 150);
}

/**
 * Unified SpessaSynth Sequencer + WorkletSynthesizer Player
 * Supports Standard MIDI (.mid/.midi/.kar/.rmi/.xmf) AND converted Amiga/PC Tracker modules (.mod/.xm/.s3m)
 * parsed via spessasynth_core BasicMIDI, with automatic fallback to TinySynth for plain SMF if worklet is unavailable.
 */
export function playMidiBuffer(
  arrayBuffer: ArrayBuffer,
  onEnded?: () => void,
  targetBpm?: number,
  baseSongBpm?: number,
  initialSeekRatio = 0,
  fileName?: string
) {
  try {
    TinyRsidBridge.stop();
    stopMidiPlayback();
    stopDirectAudio();

    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    const resolvedFileName = fileName || WorkletSynthBridge.getCurrentOriginalFileName() || activeSequenceFileNameCache || 'sequence.mid';
    activeSequenceFileNameCache = resolvedFileName;

    const genAtStart = ++midiPlaybackGeneration;
    isMidiPlayingInternal = true;
    useWorkletSequencerActive = true;

    const meta = WorkletSynthBridge.getSequenceMetadata();
    const baseBpm = Math.max(30, meta?.bpm || baseSongBpm || 125);
    const clampedTarget = Math.max(30, Math.min(320, Number(targetBpm) || baseBpm));
    const rate = Math.max(0.25, Math.min(4.0, clampedTarget / baseBpm));

    SpessaSynth.sendGMReset(true);
    WorkletSynthBridge.stopAll(true);

    void WorkletSynthBridge.init(ctx).then(async () => {
      if (midiPlaybackGeneration !== genAtStart || !isMidiPlayingInternal) return;

      const started = await WorkletSynthBridge.playSequencerFromBuffer(
        arrayBuffer,
        resolvedFileName,
        initialSeekRatio,
        rate,
        () => {
          if (midiPlaybackGeneration === genAtStart) {
            isMidiPlayingInternal = false;
            useWorkletSequencerActive = false;
            SpessaSynth.allNotesOff();
            onEnded?.();
          }
        }
      );

      if (!started && midiPlaybackGeneration === genAtStart && isMidiPlayingInternal) {
        useWorkletSequencerActive = false;
        playMidiViaTinySynthFallback(arrayBuffer, onEnded, targetBpm, baseSongBpm, initialSeekRatio);
      }
    });
  } catch (err) {
    console.log("MIDI playback error:", err);
  }
}

export function seekMidiPlayback(ratio0to1: number, targetBpm?: number, baseSongBpm?: number) {
  if (useWorkletSequencerActive) {
    WorkletSynthBridge.seekSequencer(ratio0to1);
    if (targetBpm) {
      setMidiTempoBpm(targetBpm, baseSongBpm);
    }
    return;
  }

  const synth = tinySynthInstance;
  if (!synth || !synth.song) return;
  const clamped = Math.max(0, Math.min(0.995, ratio0to1));
  const st = synth.getPlayStatus?.();
  const maxTick = Math.max(1, st?.maxTick || synth.maxTick || midiMaxTickCache || 1);
  const targetTick = Math.round(clamped * maxTick);

  // Cancel all pending lookahead notes and hard-silence previous timestamp voices/sustain
  cancelAllScheduledNotesAndSilence({ keepMidiPlayingFlag: true });

  suppressHookForward = true;
  try {
    synth.locateMIDI?.(targetTick);
    // Clear any leftover sustain after locateMIDI so sought timestamp starts cleanly without overlapping tails
    for (let ch = 0; ch < 16; ch++) {
      synth.setSustain?.(ch, 0);
    }
  } finally {
    suppressHookForward = false;
  }

  if (Array.isArray(synth.pg)) {
    for (let ch = 0; ch < 16; ch++) {
      const prog = synth.pg[ch];
      if (typeof prog === 'number') {
        SpessaSynth.setChannelProgram(ch, prog);
        if (WorkletSynthBridge.isReadySync() && !WorkletSynthBridge.getChannelState(ch).presetLocked) {
          WorkletSynthBridge.programChange(ch, prog);
        }
      }
    }
  }

  if (targetBpm) {
    setMidiTempoBpm(targetBpm, baseSongBpm);
  }
}

export function stopMidiPlayback() {
  try {
    isMidiPlayingInternal = false;
    useWorkletSequencerActive = false;
    WorkletSynthBridge.pauseSequencer();
    if (midiPlaybackWatchdogTimer) {
      clearInterval(midiPlaybackWatchdogTimer);
      midiPlaybackWatchdogTimer = null;
    }
    if (midiEndTailTimer) {
      clearTimeout(midiEndTailTimer);
      midiEndTailTimer = null;
    }
    cancelAllScheduledNotesAndSilence();
  } catch (e) {}
}

export function getMidiPlayStatus(): { play: boolean; curTick: number; maxTick: number } {
  if (useWorkletSequencerActive) {
    const seqProg = WorkletSynthBridge.getSequencerProgress(1);
    return {
      play: isMidiPlayingInternal || seqProg.play,
      curTick: Math.round(seqProg.ratio * 10000),
      maxTick: 10000
    };
  }

  if (tinySynthInstance) {
    const st = tinySynthInstance.getPlayStatus?.();
    if (st) {
      return { play: isMidiPlayingInternal || !!st.play, curTick: st.curTick || 0, maxTick: st.maxTick || 1 };
    }
  }
  return { play: isMidiPlayingInternal, curTick: 0, maxTick: 1 };
}

export function getMidiPlaybackProgress(targetBpm?: number, baseSongBpm?: number): {
  play: boolean;
  curTick: number;
  maxTick: number;
  ratio: number;
  elapsedSeconds: number;
  totalSeconds: number;
} {
  if (useWorkletSequencerActive) {
    const meta = WorkletSynthBridge.getSequenceMetadata();
    const baseBpm = Math.max(30, meta?.bpm || baseSongBpm || 125);
    const curTargetBpm = Math.max(30, Math.min(320, targetBpm || baseBpm));
    const rate = Math.max(0.25, Math.min(4.0, curTargetBpm / baseBpm));
    const seqProg = WorkletSynthBridge.getSequencerProgress(rate);
    return {
      play: isMidiPlayingInternal || seqProg.play,
      curTick: Math.round(seqProg.ratio * 10000),
      maxTick: 10000,
      ratio: seqProg.ratio,
      elapsedSeconds: seqProg.elapsedSeconds,
      totalSeconds: seqProg.totalSeconds
    };
  }

  const st = getMidiPlayStatus();
  const maxTick = Math.max(1, st.maxTick || midiMaxTickCache || 1);
  const curTick = Math.max(0, Math.min(maxTick, st.curTick || 0));
  const ratio = Math.max(0, Math.min(1, curTick / maxTick));

  const synth = tinySynthInstance;
  const baseBpm = Math.max(30, (synth as any)?.__ariaBaseBpm || baseSongBpm || 120);
  const curTargetBpm = Math.max(30, Math.min(320, targetBpm || baseBpm));
  const rate = Math.max(0.25, Math.min(4.0, curTargetBpm / baseBpm));

  const baseTotal = midiBaseDurationSecCache > 0 ? midiBaseDurationSecCache : 60;
  const totalSeconds = Math.max(0.5, baseTotal / rate);
  const elapsedSeconds = ratio * totalSeconds;
  return {
    play: st.play,
    curTick,
    maxTick,
    ratio,
    elapsedSeconds,
    totalSeconds
  };
}

export function isMidiPlaying(): boolean {
  return isMidiPlayingInternal;
}
// Convert MIDI note number to frequency in Hz
export function midiNoteToFrequency(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

// Map note names (e.g., "C-4", "D#3", "A-5") to MIDI key numbers
export function parseNoteNameToMidi(noteName: string): number | null {
  if (!noteName || noteName === '---' || noteName === '===' || noteName === 'OFF') return null;
  const noteMap: { [key: string]: number } = { 
    C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 
  };
  const match = noteName.match(/^([A-G]#?)-?([0-9])$/);
  if (!match) return null;
  const noteLetter = match[1];
  const octave = parseInt(match[2], 10);
  if (isNaN(octave) || noteMap[noteLetter] === undefined) return null;
  return 12 * (octave + 1) + noteMap[noteLetter];
}

/**
 * Redundant Synthetic Oscillator Engine
 * Emulates vintage chiptune hardware architectures (YM2612, SID, Paula, DMG, AY-3)
 * Phase-locked to targetTime with zero latency
 */
function playSyntheticOscillator(
  ctx: AudioContext,
  channelId: number,
  chip: string,
  freq: number,
  targetTime: number,
  duration: number,
  vol: number,
  panVal: number
) {
  if (!syntheticMasterGain) initSyntheticEngine(ctx);
  if (!syntheticMasterGain) return;

  while (activeSyntheticVoices.length >= MAX_SYNTHETIC_VOICES) {
    const oldest = activeSyntheticVoices.shift();
    if (oldest) {
      try { oldest.stop(); } catch (e) {}
    }
  }

  const osc = ctx.createOscillator();
  const subOsc = ctx.createOscillator();
  const voiceGain = ctx.createGain();
  const panner = ctx.createStereoPanner();

  // Stereo placement
  panner.pan.setValueAtTime(Math.max(-1, Math.min(1, (panVal - 50) / 50)), targetTime);

  const chipLower = (chip || '').toLowerCase();
  let subRatio = 0.5;

  if (chipLower.includes('yamaha') || chipLower.includes('ym2612') || chipLower.includes('sega')) {
    osc.type = 'sawtooth';
    subOsc.type = 'sine';
    subRatio = 2.0;
  } else if (chipLower.includes('sid') || chipLower.includes('c64')) {
    osc.type = 'square';
    subOsc.type = 'triangle';
    subRatio = 1.003;
  } else if (chipLower.includes('game boy') || chipLower.includes('dmg')) {
    osc.type = 'square';
    subOsc.type = 'square';
    subRatio = 0.5;
  } else if (chipLower.includes('paula') || chipLower.includes('amiga')) {
    osc.type = 'triangle';
    subOsc.type = 'square';
    subRatio = 1.0;
  } else if (chipLower.includes('ay-3') || chipLower.includes('zx')) {
    osc.type = 'square';
    subOsc.type = 'square';
    subRatio = 1.004;
  } else {
    osc.type = 'sawtooth';
    subOsc.type = 'triangle';
    subRatio = 0.5;
  }

  osc.frequency.setValueAtTime(freq, targetTime);
  subOsc.frequency.setValueAtTime(freq * subRatio, targetTime);

  const amp = vol * 0.16;
  voiceGain.gain.setValueAtTime(0.0001, targetTime);
  voiceGain.gain.linearRampToValueAtTime(amp, targetTime + 0.008);
  voiceGain.gain.exponentialRampToValueAtTime(amp * 0.65, targetTime + 0.06);
  voiceGain.gain.exponentialRampToValueAtTime(0.0001, targetTime + duration);

  osc.connect(voiceGain);
  subOsc.connect(voiceGain);
  voiceGain.connect(panner);
  panner.connect(syntheticMasterGain);

  osc.start(targetTime);
  subOsc.start(targetTime);
  osc.stop(targetTime + duration + 0.04);
  subOsc.stop(targetTime + duration + 0.04);

  const voiceRecord: ActiveOscVoice = {
    channelId,
    stop: () => {
      try {
        voiceGain.gain.cancelScheduledValues(ctx.currentTime);
        voiceGain.gain.setValueAtTime(0.0001, ctx.currentTime);
        osc.stop(ctx.currentTime + 0.01);
        subOsc.stop(ctx.currentTime + 0.01);
      } catch (e) {}
    }
  };
  activeSyntheticVoices.push(voiceRecord);

  osc.onended = () => {
    try {
      osc.disconnect();
      subOsc.disconnect();
      voiceGain.disconnect();
      panner.disconnect();
    } catch (e) {}
    const idx = activeSyntheticVoices.indexOf(voiceRecord);
    if (idx !== -1) activeSyntheticVoices.splice(idx, 1);
  };
}

// Single-note trigger for interactive auditing when user clicks or edits notes in tracker
export function playNote(
  channelId: number, 
  chip: string, 
  noteName: string, 
  duration = 0.22, 
  volume = 80, 
  pan = 50,
  soundFontPreset?: string
) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    if (noteName === '===' || noteName === 'OFF') {
      stopChannelSound(channelId);
      return;
    }

    const midiNum = parseNoteNameToMidi(noteName);
    if (midiNum === null) return;

    const chIdx = (channelId - 1) % 16;
    const workletChIdx = Math.max(0, Math.min(47, channelId - 1));
    if (SpessaSynth.isChannelMuted(chIdx) || WorkletSynthBridge.isChannelMuted(workletChIdx)) return;

    const volNorm = Math.round((volume / 100) * 127);
    const freq = midiNoteToFrequency(midiNum);

    // CRITICAL: Precise 5ms lookahead audio timestamp ensures all sound engines
    // (WorkletSynthesizer / SpessaSynth, WebAudioTinySynth, and Synthetic Oscillators)
    // start simultaneously on the exact same audio buffer frame with zero engine delay!
    const targetTime = ctx.currentTime + 0.005;

    const gmProg = getGmProgramForPreset(soundFontPreset);
    const noteGen = midiPlaybackGeneration;
    const durMs = Math.max(30, Math.round(duration * 1000));

    // 1. SpessaSynth Lib (WorkletSynthesizer) & spressasynth_core (PCM Sample Resolver)
    if (activeEnginesConfig.spessaSynth && shouldUseWorkletPrimary()) {
      if (soundFontPreset && !WorkletSynthBridge.getChannelState(workletChIdx).presetLocked) {
        WorkletSynthBridge.programChange(workletChIdx, gmProg);
      }
      // Trigger immediately and schedule noteOff in generation-guarded JS timer so Pause/Seek cancels cleanly
      WorkletSynthBridge.noteOn(workletChIdx, midiNum, volNorm);
      const offTimer = setTimeout(() => {
        scheduledNoteOffTimers.delete(offTimer);
        if (noteGen !== midiPlaybackGeneration) return;
        WorkletSynthBridge.noteOff(workletChIdx, midiNum);
      }, durMs);
      scheduledNoteOffTimers.add(offTimer);
    } else if (activeEnginesConfig.spessaSynthCore) {
      if (soundFontPreset) {
        SpessaSynth.setChannelProgram(chIdx, gmProg);
      }
      SpessaSynth.noteOn(chIdx, midiNum, volNorm, duration, targetTime);
    }

    // 2. WebAudio TinySynth Engine (suppress hook forwarding so SpessaSynth isn't double-triggered)
    if (activeEnginesConfig.tinySynth && tinySynthInstance) {
      try {
        suppressHookForward = true;
        if (soundFontPreset) {
          tinySynthInstance.send([0xC0 | chIdx, gmProg]);
        }
        tinySynthInstance.send([0x90 | chIdx, midiNum, volNorm]);
        const tsOffTimer = setTimeout(() => {
          scheduledNoteOffTimers.delete(tsOffTimer);
          if (noteGen !== midiPlaybackGeneration || !tinySynthInstance) return;
          suppressHookForward = true;
          try {
            tinySynthInstance.send([0x80 | chIdx, midiNum, 0]);
          } finally {
            suppressHookForward = false;
          }
        }, durMs);
        scheduledNoteOffTimers.add(tsOffTimer);
      } catch (e) {
      } finally {
        suppressHookForward = false;
      }
    }

    // 3. Redundant Synthetic Oscillators Layer
    if (activeEnginesConfig.syntheticOsc) {
      playSyntheticOscillator(ctx, channelId, chip, freq, targetTime, duration, volume / 100, pan);
    }

  } catch (error) {
    console.log("Audio synthesis preview bypassed:", error);
  }
}

export function stopChannelSound(channelId: number) {
  const chIdx = (channelId - 1) % 16;
  const workletChIdx = Math.max(0, Math.min(47, channelId - 1));
  SpessaSynth.noteOff(chIdx);
  for (let n = 0; n < 128; n++) {
    // Only turn off active sounding notes tracked on this WorkletSynthesizer channel
    if (WorkletSynthBridge.getChannelState(workletChIdx).activeNotes.includes(n)) {
      WorkletSynthBridge.noteOff(workletChIdx, n);
    }
  }
  if (tinySynthInstance) {
    try {
      tinySynthInstance.allSoundOff?.(chIdx);
    } catch (e) {}
  }
  for (let i = activeSyntheticVoices.length - 1; i >= 0; i--) {
    if (activeSyntheticVoices[i].channelId === channelId) {
      activeSyntheticVoices[i].stop();
      activeSyntheticVoices.splice(i, 1);
    }
  }
}

export function stopAllChannelsSound() {
  stopDirectAudio();
  stopMidiPlayback();
  TinyRsidBridge.pause();
  cancelAllScheduledNotesAndSilence();
}

/**
 * TinyRSid / WebSID C64 SID WASM Emulator Playback Controls
 */
export async function playSidBuffer(
  arrayBuffer: ArrayBuffer,
  fileName: string,
  options?: {
    subtune1Based?: number;
    seekSeconds?: number;
    channels?: Channel[];
    onSongEnded?: () => void;
  }
): Promise<boolean> {
  try {
    stopDirectAudio();
    stopMidiPlayback();
    cancelAllScheduledNotesAndSilence();

    const ctx = unlockAudioContextSync();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch {}
    }

    const ok = await TinyRsidBridge.playSid(ctx, arrayBuffer, fileName, options);
    if (!ok) {
      console.warn('TinyRSid playback did not start for:', fileName);
    }
    return ok;
  } catch (err) {
    console.warn('TinyRSid playback error:', err);
    return false;
  }
}

export function pauseSidPlayback() {
  TinyRsidBridge.pause();
}

export function stopSidPlayback() {
  TinyRsidBridge.stop();
}

export async function seekSidPlayback(targetSeconds: number): Promise<void> {
  const ctx = getAudioContext();
  await TinyRsidBridge.seekSeconds(targetSeconds, ctx || undefined);
}

export function getSidPlaybackProgress() {
  return TinyRsidBridge.getProgress();
}

/**
 * Play decoded direct audio stream (WAV, MP3, OGG)
 * Routes through native Web Audio master gain and feeds the 16-channel WebScope visualizer
 */
export function playDirectAudio(buffer: AudioBuffer, startOffset = 0, onEnded?: () => void) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    TinyRsidBridge.stop();
    stopDirectAudio();

    const safeOffset = Math.max(0, Math.min(Math.max(0, buffer.duration - 0.05), startOffset));
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    if (!directAudioMasterGain) {
      initSyntheticEngine(ctx);
    }
    if (directAudioMasterGain) {
      directAudioMasterGain.gain.setValueAtTime(0.85, ctx.currentTime);
      source.connect(directAudioMasterGain);
    } else {
      source.connect(ctx.destination);
    }

    WebScope.connectDirectAudioNode(ctx, source);
    WebScope.setDirectAudioPlaying(true);

    directAudioBufferRef = buffer;
    directAudioStartCtxTime = ctx.currentTime;
    directAudioOffsetSec = safeOffset;
    directAudioPlaybackRate = source.playbackRate?.value || 1.0;

    source.onended = () => {
      if (directAudioSource === source) {
        directAudioSource = null;
        WebScope.setDirectAudioPlaying(false);
        onEnded?.();
      }
    };
    source.start(0, safeOffset);
    directAudioSource = source;
  } catch (e) {
    console.log("Direct audio playback failed:", e);
  }
}

export function stopDirectAudio() {
  if (directAudioSource) {
    try {
      directAudioSource.onended = null;
      directAudioSource.stop();
      directAudioSource.disconnect();
    } catch (e) {}
    directAudioSource = null;
  }
  WebScope.setDirectAudioPlaying(false);
}

export function getDirectAudioProgress(): {
  playing: boolean;
  currentTime: number;
  duration: number;
  ratio: number;
} {
  if (!directAudioSource || !directAudioBufferRef || !audioCtx) {
    return {
      playing: false,
      currentTime: 0,
      duration: directAudioBufferRef?.duration || 0,
      ratio: 0
    };
  }
  const duration = Math.max(0.001, directAudioBufferRef.duration);
  const elapsed = Math.max(0, audioCtx.currentTime - directAudioStartCtxTime) * directAudioPlaybackRate;
  const cur = Math.max(0, Math.min(duration, directAudioOffsetSec + elapsed));
  return {
    playing: true,
    currentTime: cur,
    duration,
    ratio: Math.max(0, Math.min(1, cur / duration))
  };
}

/**
 * Dynamically adjust playback tempo/rate for active direct audio without stopping
 */
export function setAudioPlaybackRate(rate: number) {
  try {
    if (directAudioSource && directAudioSource.playbackRate) {
      const boundedRate = Math.max(0.25, Math.min(4.0, rate));
      const ctx = getAudioContext();
      if (ctx) {
        const elapsedAtOldRate = Math.max(0, ctx.currentTime - directAudioStartCtxTime) * directAudioPlaybackRate;
        directAudioOffsetSec = Math.min(
          directAudioBufferRef?.duration || 9999,
          directAudioOffsetSec + elapsedAtOldRate
        );
        directAudioStartCtxTime = ctx.currentTime;
        directAudioPlaybackRate = boundedRate;
        directAudioSource.playbackRate.setValueAtTime(boundedRate, ctx.currentTime);
      } else {
        directAudioPlaybackRate = boundedRate;
        directAudioSource.playbackRate.value = boundedRate;
      }
    }
  } catch (e) {
    console.log("Audio playback rate adjustment bypassed:", e);
  }
}
