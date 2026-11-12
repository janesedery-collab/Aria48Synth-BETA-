// @ts-ignore
import WebAudioTinySynth from 'webaudio-tinysynth';
import { Channel, SoundEnginesConfig } from '../types';
import { SpessaSynth, SPRESSASYNTH_ENGINE_ID } from '../engines/spressasynthLib';
import { Chiptune3, CHIPTUNE3_ENGINE_ID } from '../engines/chiptune3';
import { WebScope, WEBSCOPE_ENGINE_ID, WEBSCOPE_PRESETS } from '../engines/webscopeOscilloscope';
import { getGmProgramForPreset } from '../utils/soundFontEngine';

export { SpessaSynth, SPRESSASYNTH_ENGINE_ID };
export {
  SpessaSynthCore,
  SPRESSASYNTH_CORE_ENGINE_ID,
  SOUNDFONT_ACCEPT_ATTR,
  isSoundFontFileName
} from '../engines/spressasynthCore';
export { Chiptune3, CHIPTUNE3_ENGINE_ID };
export { WebScope, WEBSCOPE_ENGINE_ID, WEBSCOPE_PRESETS };
export type { SoundEnginesConfig };

/**
 * Unified SoundFont ingestion pipeline:
 * Feeds ANY SoundFont (.sf2, .sf3, .dls, .sfz, .sbk, .gig, .pat, .sfpack, etc.)
 * into spressasynth_core-master.zip and links decoded banks & sample zones directly into spressasynth_lib-master.zip.
 */
export async function loadSoundFontIntoCoreAndLib(arrayBuffer: ArrayBuffer, fileName: string) {
  const ctx = getAudioContext() || SpessaSynth.init();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch (e) {}
  }
  const { soundFont, coreResult } = await SpessaSynth.loadSoundFontAsync(arrayBuffer, fileName, ctx);
  return {
    soundFont,
    bankInfo: coreResult.bankInfo,
    instruments: coreResult.instruments,
    logs: coreResult.logs
  };
}

export const DEFAULT_SOUND_ENGINES: SoundEnginesConfig = {
  spessaSynth: true,
  tinySynth: true,
  syntheticOsc: true,
  chiptune3: true,
};

let activeEnginesConfig: SoundEnginesConfig = (() => {
  try {
    const saved = localStorage.getItem('aria48_sound_engines');
    if (saved) return { ...DEFAULT_SOUND_ENGINES, ...JSON.parse(saved) };
  } catch (e) {}
  return { ...DEFAULT_SOUND_ENGINES };
})();

const engineChangeListeners: ((config: SoundEnginesConfig) => void)[] = [];

export function getSoundEnginesConfig(): SoundEnginesConfig {
  return { ...activeEnginesConfig };
}

export function setSoundEnginesConfig(config: Partial<SoundEnginesConfig>) {
  activeEnginesConfig = { ...activeEnginesConfig, ...config };
  
  if (tinySynthMasterGain && audioCtx) {
    tinySynthMasterGain.gain.setValueAtTime(activeEnginesConfig.tinySynth ? 0.55 : 0, audioCtx.currentTime);
  }
  if (syntheticMasterGain && audioCtx) {
    syntheticMasterGain.gain.setValueAtTime(activeEnginesConfig.syntheticOsc ? 0.35 : 0, audioCtx.currentTime);
  }
  const spessaMaster = SpessaSynth.getMasterGain();
  if (spessaMaster && audioCtx) {
    spessaMaster.gain.setValueAtTime(activeEnginesConfig.spessaSynth ? 0.7 : 0, audioCtx.currentTime);
  }
  const chipMaster = Chiptune3.getMasterGain();
  if (chipMaster && audioCtx) {
    chipMaster.gain.setValueAtTime(activeEnginesConfig.chiptune3 ? 0.85 : 0, audioCtx.currentTime);
  }

  if (!activeEnginesConfig.syntheticOsc) {
    activeSyntheticVoices.forEach(v => { try { v.stop(); } catch(e) {} });
    activeSyntheticVoices.length = 0;
  }
  if (!activeEnginesConfig.spessaSynth) {
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
let syntheticMasterGain: GainNode | null = null;
let directAudioSource: AudioBufferSourceNode | null = null;
let isMidiPlayingInternal = false;

interface ActiveOscVoice {
  stop: () => void;
  channelId: number;
}
const activeSyntheticVoices: ActiveOscVoice[] = [];
let isTinySynthHooked = false;
let suppressHookForward = false;
let midiPlaybackWatchdogTimer: any = null;
let midiEndTailTimer: any = null;

/**
 * Phase-Locked Sound Engine Synchronizer:
 * Hooks TinySynth's internal SMF event dispatcher (`send(msg, t)`).
 * Because TinySynth accurately parses all tracks, deltas, and mid-song tempo meta-events (0xff51),
 * mirroring each event synchronously to SpessaSynth with the EXACT same sub-millisecond audio timestamp `t`
 * guarantees 100% phase-locked, zero-latency synchronization between both engines across all songs!
 */
export function hookTinySynthEvents(synth: any) {
  if (!synth || isTinySynthHooked) return;
  const originalSend = synth.send.bind(synth);

  synth.send = function(msg: number[], t?: number) {
    // 1. Process TinySynth voice synthesis
    originalSend(msg, t);

    // 2. Synchronously forward to SpessaSynth on the exact same audio timeline
    if (!suppressHookForward && activeEnginesConfig.spessaSynth && msg && msg.length > 0) {
      const status = msg[0];
      const cmd = status & 0xf0;
      const ch = status & 0x0f;

      if (cmd === 0x90) { // Note On / Note Off (vel === 0)
        const note = msg[1];
        const vel = msg[2];
        if (vel > 0) {
          SpessaSynth.noteOn(ch, note, vel, undefined, t);
        } else {
          SpessaSynth.noteOff(ch, note, t);
        }
      } else if (cmd === 0x80) { // Note Off
        const note = msg[1];
        SpessaSynth.noteOff(ch, note, t);
      } else if (cmd === 0xc0) { // Program Change
        const prog = msg[1];
        SpessaSynth.setChannelProgram(ch, prog);
      } else if (cmd === 0xe0) { // Pitch Bend
        const bend = ((msg[2] << 7) | msg[1]) - 8192;
        SpessaSynth.setChannelPitchBend(ch, bend, t);
      } else if (cmd === 0xb0) { // Control Change
        const cc = msg[1];
        const val = msg[2];
        if (cc === 0) {
          SpessaSynth.setChannelBank(ch, val);
        } else if (cc === 7) {
          SpessaSynth.setChannelVolume(ch, val, t);
        } else if (cc === 10) {
          SpessaSynth.setChannelPan(ch, val, t);
        } else if (cc === 11) {
          SpessaSynth.setChannelExpression(ch, val, t);
        } else if (cc === 64) {
          SpessaSynth.setChannelSustain(ch, val >= 64, t);
        } else if (cc === 65) {
          SpessaSynth.setChannelPortamento(ch, val >= 64);
        } else if (cc === 5) {
          SpessaSynth.setChannelPortamentoTime(ch, val);
        } else if (cc === 84) {
          SpessaSynth.setChannelPortamentoControl(ch, val);
        } else if (cc === 120 || cc === 123) {
          SpessaSynth.allNotesOff(ch, t);
        } else if (cc === 121) {
          SpessaSynth.resetChannelControllers(ch, t);
        }
      } else if (status === 0xff) {
        SpessaSynth.sendGMReset();
      }
    }
  };

  isTinySynthHooked = true;
}

export function initTinySynth(ctx: AudioContext) {
  try {
    if (!tinySynthMasterGain) {
      tinySynthMasterGain = ctx.createGain();
      tinySynthMasterGain.gain.setValueAtTime(activeEnginesConfig.tinySynth ? 0.55 : 0, ctx.currentTime);
      tinySynthMasterGain.connect(ctx.destination);
    }
    if (!tinySynthInstance && typeof WebAudioTinySynth !== 'undefined') {
      tinySynthInstance = new WebAudioTinySynth({ quality: 1, useReverb: 0 });
    }
    if (tinySynthInstance) {
      // Connect to the shared AudioContext and dedicated master gain node
      // to guarantee zero clock drift and exact phase alignment with SpessaSynth
      tinySynthInstance.setAudioContext(ctx, tinySynthMasterGain);
      tinySynthInstance.setMasterVol(0.55);
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
      syntheticMasterGain.connect(ctx.destination);
    }
  } catch (e) {}
}

export function getAudioContext(): AudioContext | null {
  if (!audioCtx && typeof window !== 'undefined') {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
      SpessaSynth.init(audioCtx);
      Chiptune3.init(audioCtx);
      initTinySynth(audioCtx);
      initSyntheticEngine(audioCtx);
    }
  }
  return audioCtx;
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

/**
 * Phase-locked Synchronized MIDI Player
 * TinySynth's master sequencer dynamically parses delta ticks, multi-tracks, and tempo changes (0xff51).
 * Both SpessaSynth and WebAudioTinySynth receive all events simultaneously on the shared AudioContext timeline,
 * eliminating sound engine delay, desync on tempo changes, and phasing jitter!
 */
export function playMidiBuffer(arrayBuffer: ArrayBuffer, onEnded?: () => void) {
  try {
    stopMidiPlayback();
    stopDirectAudio();

    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    const synth = getTinySynth();
    if (synth) {
      hookTinySynthEvents(synth);

      // Reset SpessaSynth channel states cleanly before launching synchronized playback
      SpessaSynth.sendGMReset();

      // Load SMF binary and launch synchronized playback
      synth.loadMIDI(arrayBuffer);
      synth.playMIDI();
      isMidiPlayingInternal = true;

      // Watchdog interval detects when master sequencer reaches end of song
      if (midiPlaybackWatchdogTimer) clearInterval(midiPlaybackWatchdogTimer);
      if (midiEndTailTimer) {
        clearTimeout(midiEndTailTimer);
        midiEndTailTimer = null;
      }
      midiPlaybackWatchdogTimer = setInterval(() => {
        const status = synth.getPlayStatus?.();
        if (status && !status.play && isMidiPlayingInternal) {
          isMidiPlayingInternal = false;
          clearInterval(midiPlaybackWatchdogTimer);
          midiPlaybackWatchdogTimer = null;
          // Allow TinySynth's 200ms lookahead buffer + final note release tail to finish naturally
          midiEndTailTimer = setTimeout(() => {
            midiEndTailTimer = null;
            SpessaSynth.allNotesOff();
            onEnded?.();
          }, 320);
        }
      }, 150);
    }
  } catch (err) {
    console.log("MIDI playback error:", err);
  }
}

export function stopMidiPlayback() {
  try {
    if (midiPlaybackWatchdogTimer) {
      clearInterval(midiPlaybackWatchdogTimer);
      midiPlaybackWatchdogTimer = null;
    }
    if (midiEndTailTimer) {
      clearTimeout(midiEndTailTimer);
      midiEndTailTimer = null;
    }
    if (tinySynthInstance) {
      tinySynthInstance.stopMIDI();
      for (let ch = 0; ch < 16; ch++) {
        tinySynthInstance.allSoundOff?.(ch);
      }
    }
    SpessaSynth.allNotesOff();
    isMidiPlayingInternal = false;
  } catch (e) {}
}

export function getMidiPlayStatus(): { play: boolean; curTick: number; maxTick: number } {
  if (tinySynthInstance) {
    const st = tinySynthInstance.getPlayStatus?.();
    if (st) {
      return { play: isMidiPlayingInternal || !!st.play, curTick: st.curTick || 0, maxTick: st.maxTick || 1 };
    }
  }
  return { play: isMidiPlayingInternal, curTick: 0, maxTick: 1 };
}

export function isMidiPlaying(): boolean {
  return isMidiPlayingInternal;
}


/**
 * Authentic Amiga ProTracker PCM Module Renderer
 * Converts MOD files (8-bit signed PCM samples, Amiga periods, orders, and effects)
 * directly into a CD-quality stereo AudioBuffer with zero synthetic beeping!
 */
export function renderModToAudioBuffer(arrayBuffer: ArrayBuffer, ctx: AudioContext): AudioBuffer | null {
  try {
    const u8 = new Uint8Array(arrayBuffer);
    if (u8.length < 1084) return null;

    // Check signature
    let signature = "";
    for (let i = 1080; i < 1084; i++) {
      signature += String.fromCharCode(u8[i]);
    }
    let channelsCount = 4;
    const sigMatch = signature.match(/(\d+)CH/);
    const cnMatch = signature.match(/(\d+)CN/);
    if (sigMatch) channelsCount = parseInt(sigMatch[1], 10);
    else if (cnMatch) channelsCount = parseInt(cnMatch[1], 10);
    else if (signature === "M.K." || signature === "M!K!" || signature === "FLT4") channelsCount = 4;
    else if (signature === "CD81" || signature === "OCTA") channelsCount = 8;

    // Read 31 Sample Headers
    interface ModSample {
      name: string;
      lengthBytes: number;
      finetune: number;
      volume: number;
      loopStart: number;
      loopLength: number;
      pcm: Float32Array | null;
    }
    // Read 31 Sample Headers
    interface ModSample {
      name: string;
      lengthBytes: number;
      finetune: number;
      volume: number;
      loopStart: number;
      loopLength: number;
      pcm: Float32Array | null;
    }
    const samples: ModSample[] = [];
    let totalSampleBytes = 0;
    for (let sIdx = 0; sIdx < 31; sIdx++) {
      const hOffset = 20 + sIdx * 30;
      let sName = "";
      for (let c = 0; c < 22; c++) {
        const char = u8[hOffset + c];
        if (char > 32 && char < 127) sName += String.fromCharCode(char);
      }
      const lenWords = (u8[hOffset + 22] << 8) | u8[hOffset + 23];
      const lengthBytes = lenWords * 2;
      let finetune = u8[hOffset + 24] & 0x0F;
      if (finetune > 7) finetune -= 16; // signed 4-bit finetune (-8 to +7)
      const volume = Math.min(64, u8[hOffset + 25]);
      const repStartWords = (u8[hOffset + 26] << 8) | u8[hOffset + 27];
      const repLenWords = (u8[hOffset + 28] << 8) | u8[hOffset + 29];
      const loopStart = repStartWords * 2;
      const loopLength = repLenWords * 2;

      totalSampleBytes += lengthBytes;

      samples.push({
        name: sName.trim() || `Sample ${sIdx + 1}`,
        lengthBytes,
        finetune,
        volume,
        loopStart,
        loopLength,
        pcm: null
      });
    }

    const songLength = u8[950] || 1;
    const orderList: number[] = [];
    let maxPatternIdx = 0;
    // CRITICAL: Scan strictly within active songLength orders (0 .. songLength - 1).
    // Residual bytes in 952 + songLength .. 127 are uninitialized in many tracker files!
    for (let i = 0; i < songLength; i++) {
      const p = u8[952 + i];
      orderList.push(p);
      if (p < 128 && p > maxPatternIdx) maxPatternIdx = p;
    }

    // Extract 8-bit signed PCM data for each sample
    const patternDataStart = 1084;
    const patternBytes = 64 * channelsCount * 4;
    const sampleStartFromPatterns = patternDataStart + (maxPatternIdx + 1) * patternBytes;

    // Authentic Amiga ProTracker standard: sample 1 starts immediately after patterns
    let sampleDataOffset = sampleStartFromPatterns;
    // Fallback if calculated start is beyond EOF (truncated file)
    if (sampleStartFromPatterns + totalSampleBytes > u8.length) {
      const sampleStartFromEnd = arrayBuffer.byteLength - totalSampleBytes;
      if (sampleStartFromEnd >= patternDataStart) {
        sampleDataOffset = sampleStartFromEnd;
      }
    }

    for (let sIdx = 0; sIdx < 31; sIdx++) {
      const smp = samples[sIdx];
      if (smp.lengthBytes > 0 && sampleDataOffset < u8.length) {
        const readLen = Math.min(smp.lengthBytes, u8.length - sampleDataOffset);
        const s8 = new Int8Array(arrayBuffer, sampleDataOffset, readLen);
        const floatPcm = new Float32Array(smp.lengthBytes);
        for (let i = 0; i < readLen; i++) {
          floatPcm[i] = s8[i] / 128.0;
        }
        smp.pcm = floatPcm;
        sampleDataOffset += readLen;
      }
    }

    // Output sample rate and buffers
    const sampleRate = ctx.sampleRate || 44100;
    const amigaClock = 3546895; // PAL Amiga Clock

    // Channel state
    interface RenderChannel {
      sampleIdx: number;
      samplePos: number;
      period: number;
      volume: number;
      sampleRateRatio: number;
      panLeft: number;
      panRight: number;
      portamentoTarget: number;
      portamentoSpeed: number;
    }

    const channelStates: RenderChannel[] = [];
    for (let c = 0; c < channelsCount; c++) {
      let panL = 0.5, panR = 0.5;
      if (channelsCount === 4) {
        if (c === 0 || c === 3) { panL = 0.8; panR = 0.2; }
        else { panL = 0.2; panR = 0.8; }
      } else {
        const panRatio = c / Math.max(1, channelsCount - 1);
        panL = 1 - panRatio * 0.7;
        panR = 0.3 + panRatio * 0.7;
      }
      channelStates.push({
        sampleIdx: -1,
        samplePos: 0,
        period: 0,
        volume: 64,
        sampleRateRatio: 0,
        panLeft: panL,
        panRight: panR,
        portamentoTarget: 0,
        portamentoSpeed: 0
      });
    }

    let speed = 6;     // ticks per row
    let tempo = 125;   // BPM
    let maxOrderLimit = Math.min(orderList.length, 128);

    // Estimate frames
    const estimatedSeconds = maxOrderLimit * 64 * (6 / (2.5 * tempo));
    const maxSeconds = Math.min(estimatedSeconds, 360);
    const maxFrames = Math.floor(maxSeconds * sampleRate);

    const outLeft = new Float32Array(maxFrames);
    const outRight = new Float32Array(maxFrames);
    let outOffset = 0;

    let orderIdx = 0;
    let nextRowToPlay = 0;

    orderLoop: while (orderIdx < maxOrderLimit && outOffset < maxFrames) {
      const pIdx = orderList[orderIdx];
      const pOffset = patternDataStart + pIdx * patternBytes;
      if (pOffset + patternBytes > u8.length) break;

      let row = nextRowToPlay;
      nextRowToPlay = 0;

      while (row < 64 && outOffset < maxFrames) {
        let patternBreakRow = -1;
        let positionJumpOrder = -1;

        // Process row events at tick 0
        for (let ch = 0; ch < channelsCount; ch++) {
          const cellOffset = pOffset + (row * channelsCount * 4) + (ch * 4);
          const b0 = u8[cellOffset];
          const b1 = u8[cellOffset + 1];
          const b2 = u8[cellOffset + 2];
          const b3 = u8[cellOffset + 3];

          const period = ((b0 & 0x0F) << 8) | b1;
          const instIdx = (b0 & 0xF0) | ((b2 & 0xF0) >> 4);
          const effect = b2 & 0x0F;
          const effectParam = b3;

          const chState = channelStates[ch];

          if (instIdx > 0 && instIdx <= 31) {
            chState.sampleIdx = instIdx - 1;
            chState.volume = samples[chState.sampleIdx]?.volume ?? 64;
          }

          if (period > 0) {
            if (effect === 0x03) {
              // Tone Portamento
              chState.portamentoTarget = period;
              if (effectParam > 0) chState.portamentoSpeed = effectParam;
            } else {
              chState.period = period;
              chState.samplePos = 0;
              const smp = chState.sampleIdx >= 0 ? samples[chState.sampleIdx] : null;
              const fine = smp ? smp.finetune : 0;
              const tunedPeriod = fine !== 0 ? period * Math.pow(2, -fine / 96) : period;
              const playFreq = amigaClock / (tunedPeriod * 2);
              chState.sampleRateRatio = Math.max(0.01, Math.min(8.0, playFreq / sampleRate));
            }
          }

          // Effects Processing
          if (effect === 0x0C) { // Set volume
            chState.volume = Math.max(0, Math.min(64, effectParam));
          } else if (effect === 0x0F) { // Set speed / tempo
            if (effectParam <= 32 && effectParam > 0) {
              speed = effectParam;
            } else if (effectParam > 32) {
              tempo = effectParam;
            }
          } else if (effect === 0x0B) { // Position Jump
            positionJumpOrder = effectParam;
          } else if (effect === 0x0D) { // Pattern Break
            const high = (effectParam >> 4) & 0x0F;
            const low = effectParam & 0x0F;
            patternBreakRow = (high * 10) + low;
          }
        }

        // Render all ticks for this row
        const samplesPerTick = Math.max(1, Math.round(sampleRate / (2.5 * tempo)));
        for (let t = 0; t < speed; t++) {
          // Non-zero tick effects: Portamento / Volume Slides
          if (t > 0) {
            for (let ch = 0; ch < channelsCount; ch++) {
              const cellOffset = pOffset + (row * channelsCount * 4) + (ch * 4);
              const b2 = u8[cellOffset + 2];
              const b3 = u8[cellOffset + 3];
              const effect = b2 & 0x0F;
              const effectParam = b3;
              const chState = channelStates[ch];

              if (effect === 0x01 && chState.period > 0) { // Portamento Up
                chState.period = Math.max(56, chState.period - effectParam);
                const smp = chState.sampleIdx >= 0 ? samples[chState.sampleIdx] : null;
                const fine = smp ? smp.finetune : 0;
                const tunedPeriod = fine !== 0 ? chState.period * Math.pow(2, -fine / 96) : chState.period;
                chState.sampleRateRatio = (amigaClock / (tunedPeriod * 2)) / sampleRate;
              } else if (effect === 0x02 && chState.period > 0) { // Portamento Down
                chState.period = Math.min(1712, chState.period + effectParam);
                const smp = chState.sampleIdx >= 0 ? samples[chState.sampleIdx] : null;
                const fine = smp ? smp.finetune : 0;
                const tunedPeriod = fine !== 0 ? chState.period * Math.pow(2, -fine / 96) : chState.period;
                chState.sampleRateRatio = (amigaClock / (tunedPeriod * 2)) / sampleRate;
              } else if (effect === 0x03 && chState.period > 0 && chState.portamentoTarget > 0) { // Tone Portamento
                if (chState.period < chState.portamentoTarget) {
                  chState.period = Math.min(chState.portamentoTarget, chState.period + chState.portamentoSpeed);
                } else if (chState.period > chState.portamentoTarget) {
                  chState.period = Math.max(chState.portamentoTarget, chState.period - chState.portamentoSpeed);
                }
                const smp = chState.sampleIdx >= 0 ? samples[chState.sampleIdx] : null;
                const fine = smp ? smp.finetune : 0;
                const tunedPeriod = fine !== 0 ? chState.period * Math.pow(2, -fine / 96) : chState.period;
                chState.sampleRateRatio = (amigaClock / (tunedPeriod * 2)) / sampleRate;
              } else if (effect === 0x0A) { // Volume Slide
                const up = (effectParam >> 4) & 0x0F;
                const down = effectParam & 0x0F;
                if (up > 0) chState.volume = Math.min(64, chState.volume + up);
                else if (down > 0) chState.volume = Math.max(0, chState.volume - down);
              }
            }
          }

          for (let s = 0; s < samplesPerTick; s++) {
            if (outOffset >= maxFrames) break orderLoop;

            let sampleMixL = 0;
            let sampleMixR = 0;

            for (let ch = 0; ch < channelsCount; ch++) {
              const chState = channelStates[ch];
              if (chState.sampleIdx >= 0 && chState.sampleRateRatio > 0) {
                const smp = samples[chState.sampleIdx];
                if (smp && smp.pcm) {
                  const pcm = smp.pcm;
                  const intPos = Math.floor(chState.samplePos);
                  const frac = chState.samplePos - intPos;
                  const loopEnd = Math.min(pcm.length, smp.loopStart + smp.loopLength);
                  const validLoopLen = loopEnd - smp.loopStart;
                  const hasLoop = smp.loopLength > 2 && smp.loopStart < pcm.length && validLoopLen > 2;

                  if (intPos >= 0 && intPos < pcm.length) {
                    const s0 = pcm[intPos];
                    // Linear interpolation to eliminate high-frequency glitching
                    let s1 = s0;
                    if (intPos + 1 < pcm.length) {
                      s1 = pcm[intPos + 1];
                    } else if (hasLoop) {
                      s1 = pcm[smp.loopStart];
                    }

                    const sampleVal = (s0 + frac * (s1 - s0)) * (chState.volume / 64);
                    if (!isNaN(sampleVal)) {
                      sampleMixL += sampleVal * chState.panLeft;
                      sampleMixR += sampleVal * chState.panRight;
                    }
                  }

                  // Advance position
                  chState.samplePos += chState.sampleRateRatio;

                  // Handle authentic looping with bounds protection
                  if (hasLoop) {
                    if (chState.samplePos >= loopEnd) {
                      chState.samplePos = smp.loopStart + ((chState.samplePos - loopEnd) % validLoopLen);
                    }
                  } else if (chState.samplePos >= pcm.length) {
                    chState.sampleIdx = -1; // End of non-looping sample
                  }
                }
              }
            }

            // Authentic soft saturation limiter prevents harsh digital clipping/buzzing
            outLeft[outOffset] = Math.tanh(sampleMixL * 0.45);
            outRight[outOffset] = Math.tanh(sampleMixR * 0.45);
            outOffset++;
          }
        }

        // Handle Pattern Break or Position Jump at end of row
        if (positionJumpOrder >= 0) {
          orderIdx = positionJumpOrder;
          nextRowToPlay = patternBreakRow >= 0 ? Math.min(63, patternBreakRow) : 0;
          continue orderLoop;
        } else if (patternBreakRow >= 0) {
          orderIdx++;
          nextRowToPlay = Math.min(63, patternBreakRow);
          continue orderLoop;
        }

        row++;
      }

      orderIdx++;
    }

    if (outOffset === 0) return null;

    // Slice to exact length rendered
    const finalBuffer = ctx.createBuffer(2, outOffset, sampleRate);
    finalBuffer.getChannelData(0).set(outLeft.subarray(0, outOffset));
    finalBuffer.getChannelData(1).set(outRight.subarray(0, outOffset));
    return finalBuffer;

  } catch (err) {
    console.log("MOD PCM rendering failed:", err);
    return null;
  }
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

  setTimeout(() => {
    const idx = activeSyntheticVoices.indexOf(voiceRecord);
    if (idx !== -1) activeSyntheticVoices.splice(idx, 1);
  }, (duration + 0.1) * 1000);
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
    const volNorm = Math.round((volume / 100) * 127);
    const freq = midiNoteToFrequency(midiNum);

    // CRITICAL: Precise 5ms lookahead audio timestamp ensures all sound engines
    // (SpessaSynth, WebAudioTinySynth, and Synthetic Oscillators)
    // start simultaneously on the exact same audio buffer frame with zero engine delay!
    const targetTime = ctx.currentTime + 0.005;

    const gmProg = getGmProgramForPreset(soundFontPreset);

    // 1. SpessaSynth Engine
    if (activeEnginesConfig.spessaSynth) {
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
          tinySynthInstance.send([0xC0 | chIdx, gmProg], targetTime);
        }
        tinySynthInstance.send([0x90 | chIdx, midiNum, volNorm], targetTime);
        tinySynthInstance.send([0x80 | chIdx, midiNum, 0], targetTime + duration);
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
  SpessaSynth.noteOff(chIdx);
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
  SpessaSynth.allNotesOff();
  if (tinySynthInstance) {
    try {
      for (let ch = 0; ch < 16; ch++) {
        tinySynthInstance.allSoundOff?.(ch);
      }
    } catch (e) {}
  }
  activeSyntheticVoices.forEach(v => {
    try { v.stop(); } catch (e) {}
  });
  activeSyntheticVoices.length = 0;
  stopDirectAudio();
  stopMidiPlayback();
}

/**
 * Play authentic decoded direct audio stream (for rendered MOD, WAV, MP3)
 * Feeds exclusively through Chiptune-3.zip master gain and 16-channel visualizer
 */
export function playDirectAudio(buffer: AudioBuffer, startOffset = 0, onEnded?: () => void) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    stopDirectAudio();

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Connect exclusively to Chiptune-3.zip tracker engine
    Chiptune3.init(ctx);
    const masterGain = Chiptune3.getMasterGain();
    if (masterGain) {
      masterGain.gain.setValueAtTime(activeEnginesConfig.chiptune3 ? 0.85 : 0, ctx.currentTime);
      source.connect(masterGain);
    } else {
      source.connect(ctx.destination);
    }

    // Feed Chiptune-3.zip 16-channel distributor so webscope-oscilloscope monitors all 16 channels!
    Chiptune3.init(ctx);
    const analysers = Chiptune3.getAllChannelAnalysers();
    for (let i = 0; i < analysers.length; i++) {
      try {
        source.connect(analysers[i]);
      } catch (e) {}
    }

    if (onEnded) {
      source.onended = onEnded;
    }
    source.start(0, startOffset);
    directAudioSource = source;
  } catch (e) {
    console.log("Direct audio playback failed:", e);
  }
}

export function stopDirectAudio() {
  if (directAudioSource) {
    try {
      directAudioSource.stop();
      directAudioSource.disconnect();
    } catch (e) {}
    directAudioSource = null;
  }
  Chiptune3.stopChiptune();
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
        directAudioSource.playbackRate.setValueAtTime(boundedRate, ctx.currentTime);
      } else {
        directAudioSource.playbackRate.value = boundedRate;
      }
    }
  } catch (e) {
    console.log("Audio playback rate adjustment bypassed:", e);
  }
}
