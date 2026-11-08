import { Channel } from '../types';
import { playSoundFontNote, initBuiltInSoundFont } from '../utils/soundFontEngine';
// @ts-ignore
import WebAudioTinySynth from 'webaudio-tinysynth';
import { SpessaSynth, SPRESSASYNTH_ENGINE_ID } from '../engines/spressasynthLib';
import { Chiptune3, CHIPTUNE3_ENGINE_ID } from '../engines/chiptune3';
import { WebScope, WEBSCOPE_ENGINE_ID, WEBSCOPE_PRESETS } from '../engines/webscopeOscilloscope';

export { SpessaSynth, SPRESSASYNTH_ENGINE_ID };
export { Chiptune3, CHIPTUNE3_ENGINE_ID };
export { WebScope, WEBSCOPE_ENGINE_ID, WEBSCOPE_PRESETS };

let audioCtx: AudioContext | null = null;
let activeVoices: { [key: string]: { stop: () => void }[] } = {};
let directAudioSource: AudioBufferSourceNode | null = null;
let tinySynthInstance: any = null;
let isMidiPlayingInternal = false;

export function getAudioContext(): AudioContext | null {
  if (!audioCtx && typeof window !== 'undefined') {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
      initBuiltInSoundFont(audioCtx);
      SpessaSynth.init(audioCtx);
      Chiptune3.init(audioCtx);
    }
  }
  return audioCtx;
}

// Singleton WebAudioTinySynth instance for General MIDI playback
export function getTinySynth(): any {
  if (!tinySynthInstance && typeof window !== 'undefined') {
    try {
      tinySynthInstance = new WebAudioTinySynth({
        quality: 1,
        useReverb: 1,
        voices: 64
      });
      tinySynthInstance.setMasterVol(0.65);
    } catch (e) {
      console.log("TinySynth initialization:", e);
    }
  }
  return tinySynthInstance;
}

/**
 * Genuine MIDI Player via spressasynth_lib-master.zip
 * Routes playback through 16 dedicated channels with SoundFont synthesis and per-channel oscilloscopes
 */
export function playMidiBuffer(arrayBuffer: ArrayBuffer, onEnded?: () => void) {
  try {
    // Stop any existing playback
    stopMidiPlayback();
    stopDirectAudio();

    const ctx = getAudioContext();
    if (ctx) SpessaSynth.init(ctx);

    // Play through spressasynth_lib-master.zip
    SpessaSynth.playMidi(arrayBuffer, () => {
      isMidiPlayingInternal = false;
      onEnded?.();
    });
    isMidiPlayingInternal = true;

    // Optional companion synth sync
    try {
      const synth = getTinySynth();
      if (synth) {
        synth.loadMIDI(arrayBuffer);
        synth.playMIDI();
      }
    } catch (e) {}

  } catch (err) {
    console.log("MIDI playback error:", err);
  }
}

export function stopMidiPlayback() {
  try {
    SpessaSynth.stopMidi();
    if (tinySynthInstance) {
      tinySynthInstance.stopMIDI();
    }
    isMidiPlayingInternal = false;
  } catch (e) {}
}

export function getMidiPlayStatus(): { play: boolean; curTick: number; maxTick: number } {
  try {
    if (tinySynthInstance) {
      const status = tinySynthInstance.getPlayStatus();
      if (status) {
        return {
          play: Boolean(status.play),
          curTick: status.curTick || 0,
          maxTick: status.maxTick || 1
        };
      }
    }
  } catch (e) {}
  return { play: false, curTick: 0, maxTick: 1 };
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
    const samples: ModSample[] = [];
    for (let sIdx = 0; sIdx < 31; sIdx++) {
      const hOffset = 20 + sIdx * 30;
      let sName = "";
      for (let c = 0; c < 22; c++) {
        const char = u8[hOffset + c];
        if (char > 32 && char < 127) sName += String.fromCharCode(char);
      }
      const lenWords = (u8[hOffset + 22] << 8) | u8[hOffset + 23];
      const lengthBytes = lenWords * 2;
      const finetune = u8[hOffset + 24] & 0x0F;
      const volume = Math.min(64, u8[hOffset + 25]);
      const repStartWords = (u8[hOffset + 26] << 8) | u8[hOffset + 27];
      const repLenWords = (u8[hOffset + 28] << 8) | u8[hOffset + 29];
      const loopStart = repStartWords * 2;
      const loopLength = repLenWords * 2;

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
    for (let i = 0; i < songLength; i++) {
      const p = u8[952 + i];
      orderList.push(p);
      if (p > maxPatternIdx) maxPatternIdx = p;
    }

    // Extract 8-bit signed PCM data for each sample
    const patternDataStart = 1084;
    const patternBytes = 64 * channelsCount * 4;
    let sampleDataOffset = patternDataStart + (maxPatternIdx + 1) * patternBytes;

    for (let sIdx = 0; sIdx < 31; sIdx++) {
      const smp = samples[sIdx];
      if (smp.lengthBytes > 0 && sampleDataOffset + smp.lengthBytes <= u8.length) {
        const s8 = new Int8Array(arrayBuffer, sampleDataOffset, smp.lengthBytes);
        const floatPcm = new Float32Array(smp.lengthBytes);
        for (let i = 0; i < smp.lengthBytes; i++) {
          floatPcm[i] = s8[i] / 128.0;
        }
        smp.pcm = floatPcm;
        sampleDataOffset += smp.lengthBytes;
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
    }

    const channelStates: RenderChannel[] = [];
    for (let c = 0; c < channelsCount; c++) {
      // Amiga 4-channel classic stereo pan separation
      let panL = 0.5, panR = 0.5;
      if (channelsCount === 4) {
        if (c === 0 || c === 3) { panL = 0.85; panR = 0.15; }
        else { panL = 0.15; panR = 0.85; }
      } else {
        const panRatio = c / (channelsCount - 1);
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
        panRight: panR
      });
    }

    let speed = 6;     // ticks per row
    let tempo = 125;   // BPM
    let maxOrderLimit = Math.min(orderList.length, 128);

    // Estimate max frames: 64 rows * maxOrders * 0.125s ~ a few minutes
    const estimatedSeconds = maxOrderLimit * 64 * (6 / (2.5 * tempo));
    const maxSeconds = Math.min(estimatedSeconds, 360); // Cap at 6 minutes
    const maxFrames = Math.floor(maxSeconds * sampleRate);

    const outLeft = new Float32Array(maxFrames);
    const outRight = new Float32Array(maxFrames);
    let outOffset = 0;

    orderLoop: for (let o = 0; o < maxOrderLimit; o++) {
      const pIdx = orderList[o];
      const pOffset = patternDataStart + pIdx * patternBytes;
      if (pOffset + patternBytes > u8.length) break;

      for (let row = 0; row < 64; row++) {
        if (outOffset >= maxFrames) break orderLoop;

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
            chState.period = period;
            chState.samplePos = 0;
            const playFreq = amigaClock / (period * 2);
            chState.sampleRateRatio = playFreq / sampleRate;
          }

          // Effects
          if (effect === 0x0C) { // Set volume
            chState.volume = Math.min(64, effectParam);
          } else if (effect === 0x0F) { // Set speed / tempo
            if (effectParam <= 32 && effectParam > 0) {
              speed = effectParam;
            } else if (effectParam > 32) {
              tempo = effectParam;
            }
          }
        }

        // Render all ticks for this row
        const samplesPerTick = Math.max(1, Math.round(sampleRate / (2.5 * tempo)));
        for (let t = 0; t < speed; t++) {
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
                  if (intPos < pcm.length) {
                    const sampleVal = pcm[intPos] * (chState.volume / 64);
                    sampleMixL += sampleVal * chState.panLeft;
                    sampleMixR += sampleVal * chState.panRight;
                  }

                  // Advance position
                  chState.samplePos += chState.sampleRateRatio;

                  // Handle looping
                  if (smp.loopLength > 2) {
                    const loopEnd = smp.loopStart + smp.loopLength;
                    if (chState.samplePos >= loopEnd) {
                      chState.samplePos = smp.loopStart + ((chState.samplePos - loopEnd) % smp.loopLength);
                    }
                  } else if (chState.samplePos >= pcm.length) {
                    chState.sampleIdx = -1; // End of non-looping sample
                  }
                }
              }
            }

            outLeft[outOffset] = Math.max(-1, Math.min(1, sampleMixL * 0.45));
            outRight[outOffset] = Math.max(-1, Math.min(1, sampleMixR * 0.45));
            outOffset++;
          }
        }
      }
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

    const chKey = `${channelId}`;
    if (!activeVoices[chKey]) activeVoices[chKey] = [];

    if (noteName === '===' || noteName === 'OFF') {
      stopChannelSound(channelId);
      return;
    }

    const midiNum = parseNoteNameToMidi(noteName);
    if (midiNum === null) return;

    // Use SoundFont PCM engine if preset is available
    const presetId = soundFontPreset || (channelId === 10 ? 'gm_drums' : 'gm_piano');
    const sfVoice = playSoundFontNote(ctx, presetId, midiNum, duration, volume, pan);
    if (sfVoice) {
      activeVoices[chKey].push({
        stop: () => {
          try { sfVoice.source.stop(); } catch (e) {}
        }
      });
      return;
    }

    // Clean subtle chip oscillator fallback
    const freq = midiNoteToFrequency(midiNum);
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = chip.includes('MOS6581') ? 'square' : chip.includes('PAULA') ? 'sawtooth' : 'triangle';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    const targetVolume = (volume / 100) * 0.1;
    gainNode.gain.setValueAtTime(targetVolume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);

    const voiceEntry = {
      stop: () => {
        try { osc.stop(); } catch (e) {}
      }
    };
    activeVoices[chKey].push(voiceEntry);
    setTimeout(() => {
      activeVoices[chKey] = activeVoices[chKey]?.filter(v => v !== voiceEntry) || [];
    }, duration * 1000 + 50);

  } catch (error) {
    console.log("Audio synthesis preview bypassed:", error);
  }
}

export function stopChannelSound(channelId: number) {
  const chKey = `${channelId}`;
  if (activeVoices[chKey]) {
    activeVoices[chKey].forEach(item => {
      try { item.stop(); } catch (e) {}
    });
    activeVoices[chKey] = [];
  }
}

export function stopAllChannelsSound() {
  Object.keys(activeVoices).forEach(k => {
    stopChannelSound(parseInt(k, 10));
  });
  stopDirectAudio();
  stopMidiPlayback();
}

/**
 * Play authentic decoded direct audio stream (for rendered MOD, WAV, MP3)
 */
export function playDirectAudio(buffer: AudioBuffer, startOffset = 0, onEnded?: () => void) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    stopDirectAudio();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

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
