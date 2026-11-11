import { SoundFontInstrument, SoundFontBankInfo } from '../types';
export type { SoundFontInstrument, SoundFontBankInfo };

export interface SoundFontSampleVoice {
  buffer: AudioBuffer;
  rootKey: number;
  sampleRate: number;
  loopStart?: number;
  loopEnd?: number;
  baseGain?: number;
}

export interface SoundFontPresetData {
  id: string;
  name: string;
  bank: number;
  program: number;
  isCustom: boolean;
  samples: { [midiKey: number]: SoundFontSampleVoice } | SoundFontSampleVoice;
}

// Global in-memory SoundFont bank registry
let loadedBankInfo: SoundFontBankInfo = {
  name: "General MIDI Compact SoundBank",
  version: "2.04",
  instrumentCount: 14,
  author: "Aria48 Studio Engine",
  isLoaded: true
};

const registeredPresets: Map<string, SoundFontPresetData> = new Map();
let isBuiltInBankInitialized = false;

/**
 * Generate synthetic PCM AudioBuffers for classic General MIDI instruments
 */
export function initBuiltInSoundFont(ctx: AudioContext) {
  if (isBuiltInBankInitialized) return;

  try {
    const sampleRate = ctx.sampleRate || 44100;

    // 1. Acoustic Grand Piano (Rich harmonic decay with percussive strike)
    const pianoBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 2.0), sampleRate);
    const pianoData = pianoBuffer.getChannelData(0);
    for (let i = 0; i < pianoData.length; i++) {
      const t = i / sampleRate;
      const decay = Math.exp(-t * 2.8);
      // Fundamental + 2nd, 3rd, 4th harmonics with slight detune
      const val = 0.5 * Math.sin(2 * Math.PI * 261.63 * t) +
                  0.3 * Math.sin(2 * Math.PI * 523.25 * t * 1.002) +
                  0.15 * Math.sin(2 * Math.PI * 784.88 * t) +
                  0.05 * Math.sin(2 * Math.PI * 1046.50 * t);
      pianoData[i] = val * decay;
    }
    registeredPresets.set("gm_piano", {
      id: "gm_piano",
      name: "000: Acoustic Grand Piano",
      bank: 0,
      program: 0,
      isCustom: false,
      samples: { buffer: pianoBuffer, rootKey: 60, sampleRate, baseGain: 1.0 }
    });

    // 2. Electric Piano (Rhodes/FM bell tone)
    const epBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 1.8), sampleRate);
    const epData = epBuffer.getChannelData(0);
    for (let i = 0; i < epData.length; i++) {
      const t = i / sampleRate;
      const decay = Math.exp(-t * 2.2);
      const mod = Math.sin(2 * Math.PI * 261.63 * 2 * t) * Math.exp(-t * 4.0);
      epData[i] = Math.sin(2 * Math.PI * 261.63 * t + 1.2 * mod) * decay * 0.7;
    }
    registeredPresets.set("gm_epiano", {
      id: "gm_epiano",
      name: "004: Electric Piano (DX/FM)",
      bank: 0,
      program: 4,
      isCustom: false,
      samples: { buffer: epBuffer, rootKey: 60, sampleRate, baseGain: 0.9 }
    });

    // 3. Church / Drawbar Organ (Full sustained tone)
    const organBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 2.5), sampleRate);
    const organData = organBuffer.getChannelData(0);
    for (let i = 0; i < organData.length; i++) {
      const t = i / sampleRate;
      const decay = t > 2.0 ? Math.exp(-(t - 2.0) * 10) : 1.0;
      const val = 0.4 * Math.sin(2 * Math.PI * 261.63 * t) +
                  0.3 * Math.sin(2 * Math.PI * 523.25 * t) +
                  0.2 * Math.sin(2 * Math.PI * 784.88 * t) +
                  0.1 * Math.sin(2 * Math.PI * 1046.5 * t);
      organData[i] = val * decay * 0.7;
    }
    registeredPresets.set("gm_organ", {
      id: "gm_organ",
      name: "016: Drawbar Organ",
      bank: 0,
      program: 16,
      isCustom: false,
      samples: { buffer: organBuffer, rootKey: 60, sampleRate, baseGain: 0.85 }
    });

    // 4. Acoustic Nylon Guitar
    const guitarBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 1.6), sampleRate);
    const guitarData = guitarBuffer.getChannelData(0);
    for (let i = 0; i < guitarData.length; i++) {
      const t = i / sampleRate;
      const decay = Math.exp(-t * 3.5);
      const val = 0.6 * Math.sin(2 * Math.PI * 261.63 * t) +
                  0.3 * Math.sin(2 * Math.PI * 523.25 * t) +
                  0.1 * Math.sin(2 * Math.PI * 784.88 * t);
      guitarData[i] = val * decay * 0.8;
    }
    registeredPresets.set("gm_guitar", {
      id: "gm_guitar",
      name: "024: Acoustic Guitar",
      bank: 0,
      program: 24,
      isCustom: false,
      samples: { buffer: guitarBuffer, rootKey: 60, sampleRate, baseGain: 0.85 }
    });

    // 5. Electric Bass / Slap Bass
    const bassBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 1.8), sampleRate);
    const bassData = bassBuffer.getChannelData(0);
    for (let i = 0; i < bassData.length; i++) {
      const t = i / sampleRate;
      const decay = Math.exp(-t * 3.0);
      const val = 0.7 * Math.sin(2 * Math.PI * 130.81 * t) +
                  0.25 * Math.sin(2 * Math.PI * 261.63 * t) +
                  0.05 * Math.sin(2 * Math.PI * 392.43 * t);
      bassData[i] = val * decay * 0.95;
    }
    registeredPresets.set("gm_bass", {
      id: "gm_bass",
      name: "033: Electric Bass",
      bank: 0,
      program: 33,
      isCustom: false,
      samples: { buffer: bassBuffer, rootKey: 48, sampleRate, baseGain: 1.0 }
    });

    // 6. String Ensemble (Warm slow attack, lush sustain)
    const stringsBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 2.8), sampleRate);
    const stringsData = stringsBuffer.getChannelData(0);
    for (let i = 0; i < stringsData.length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1.0, t / 0.15);
      const release = t > 2.3 ? Math.exp(-(t - 2.3) * 6) : 1.0;
      // Slight chorus detune
      const val = 0.35 * Math.sin(2 * Math.PI * 261.63 * t) +
                  0.35 * Math.sin(2 * Math.PI * 262.3 * t) +
                  0.20 * Math.sin(2 * Math.PI * 523.25 * t) +
                  0.10 * Math.sin(2 * Math.PI * 524.4 * t);
      stringsData[i] = val * attack * release * 0.7;
    }
    registeredPresets.set("gm_strings", {
      id: "gm_strings",
      name: "048: String Ensemble",
      bank: 0,
      program: 48,
      isCustom: false,
      samples: { buffer: stringsBuffer, rootKey: 60, sampleRate, baseGain: 0.85 }
    });

    // 7. Brass Section / Trumpet
    const brassBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 2.0), sampleRate);
    const brassData = brassBuffer.getChannelData(0);
    for (let i = 0; i < brassData.length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1.0, t / 0.08);
      const decay = t > 1.6 ? Math.exp(-(t - 1.6) * 8) : 1.0;
      // Brassy saw-rich harmonic series
      let sum = 0;
      for (let h = 1; h <= 6; h++) {
        sum += (1 / h) * Math.sin(2 * Math.PI * 261.63 * h * t);
      }
      brassData[i] = sum * 0.25 * attack * decay;
    }
    registeredPresets.set("gm_brass", {
      id: "gm_brass",
      name: "061: Brass Section",
      bank: 0,
      program: 61,
      isCustom: false,
      samples: { buffer: brassBuffer, rootKey: 60, sampleRate, baseGain: 0.9 }
    });

    // 8. Flute / Wooden Pipe
    const fluteBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 2.0), sampleRate);
    const fluteData = fluteBuffer.getChannelData(0);
    for (let i = 0; i < fluteData.length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1.0, t / 0.1);
      const decay = t > 1.6 ? Math.exp(-(t - 1.6) * 8) : 1.0;
      const vibrato = Math.sin(2 * Math.PI * 5 * t) * 3;
      const breathNoise = (Math.random() - 0.5) * 0.04;
      const val = Math.sin(2 * Math.PI * (523.25 + vibrato) * t) * 0.7 + breathNoise;
      fluteData[i] = val * attack * decay;
    }
    registeredPresets.set("gm_flute", {
      id: "gm_flute",
      name: "073: Concert Flute",
      bank: 0,
      program: 73,
      isCustom: false,
      samples: { buffer: fluteBuffer, rootKey: 72, sampleRate, baseGain: 0.8 }
    });

    // 9. Synth Lead (Retro Pulse/Square with lowpass bite)
    const leadBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 1.8), sampleRate);
    const leadData = leadBuffer.getChannelData(0);
    for (let i = 0; i < leadData.length; i++) {
      const t = i / sampleRate;
      const phase = (261.63 * t) % 1;
      const square = phase < 0.4 ? 0.6 : -0.6;
      const decay = Math.exp(-t * 2.0);
      leadData[i] = square * decay * 0.7;
    }
    registeredPresets.set("gm_lead", {
      id: "gm_lead",
      name: "080: Synth Lead (8-Bit Pulse)",
      bank: 0,
      program: 80,
      isCustom: false,
      samples: { buffer: leadBuffer, rootKey: 60, sampleRate, baseGain: 0.85 }
    });

    // 10. Chiptune Arp Lead
    const arpBuffer = ctx.createBuffer(1, Math.floor(sampleRate * 1.5), sampleRate);
    const arpData = arpBuffer.getChannelData(0);
    for (let i = 0; i < arpData.length; i++) {
      const t = i / sampleRate;
      const arpFreqs = [261.63, 329.63, 392.00, 523.25];
      const step = Math.floor(t * 16) % arpFreqs.length;
      const freq = arpFreqs[step];
      const phase = (freq * t) % 1;
      const val = (phase < 0.5 ? 0.5 : -0.5) * Math.exp(-t * 1.5);
      arpData[i] = val * 0.7;
    }
    registeredPresets.set("gm_chiptune", {
      id: "gm_chiptune",
      name: "081: Chiptune Arpeggiator",
      bank: 0,
      program: 81,
      isCustom: false,
      samples: { buffer: arpBuffer, rootKey: 60, sampleRate, baseGain: 0.85 }
    });

    // 11. GM Standard Drums: Kick, Snare, Hi-Hat, Tom, Cymbal
    // Generate specialized percussive PCM buffers for realistic drum tracking
    const kickBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.4), sampleRate);
    const kickData = kickBuf.getChannelData(0);
    for (let i = 0; i < kickData.length; i++) {
      const t = i / sampleRate;
      const pitch = 150 * Math.exp(-t * 38) + 42;
      kickData[i] = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t * 12) * 0.95;
    }

    const snareBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.35), sampleRate);
    const snareData = snareBuf.getChannelData(0);
    for (let i = 0; i < snareData.length; i++) {
      const t = i / sampleRate;
      const tone = Math.sin(2 * Math.PI * 185 * Math.exp(-t * 15) * t) * 0.45;
      const noise = (Math.random() * 2 - 1) * 0.55;
      snareData[i] = (tone + noise) * Math.exp(-t * 14) * 0.9;
    }

    const closedHatBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.08), sampleRate);
    const closedHatData = closedHatBuf.getChannelData(0);
    for (let i = 0; i < closedHatData.length; i++) {
      const t = i / sampleRate;
      const noise = (Math.random() * 2 - 1) * 0.8;
      closedHatData[i] = noise * Math.exp(-t * 70);
    }

    const openHatBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.45), sampleRate);
    const openHatData = openHatBuf.getChannelData(0);
    for (let i = 0; i < openHatData.length; i++) {
      const t = i / sampleRate;
      const noise = (Math.random() * 2 - 1) * 0.75;
      openHatData[i] = noise * Math.exp(-t * 8);
    }

    const tomBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.4), sampleRate);
    const tomData = tomBuf.getChannelData(0);
    for (let i = 0; i < tomData.length; i++) {
      const t = i / sampleRate;
      const pitch = 160 * Math.exp(-t * 15) + 65;
      tomData[i] = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t * 9) * 0.9;
    }

    const crashBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.8), sampleRate);
    const crashData = crashBuf.getChannelData(0);
    for (let i = 0; i < crashData.length; i++) {
      const t = i / sampleRate;
      const noise = (Math.random() * 2 - 1) * 0.7;
      crashData[i] = noise * Math.exp(-t * 4);
    }

    const drumKeyMap: { [key: number]: SoundFontSampleVoice } = {
      35: { buffer: kickBuf, rootKey: 35, sampleRate, baseGain: 1.0 },
      36: { buffer: kickBuf, rootKey: 36, sampleRate, baseGain: 1.0 },
      38: { buffer: snareBuf, rootKey: 38, sampleRate, baseGain: 0.95 },
      40: { buffer: snareBuf, rootKey: 40, sampleRate, baseGain: 0.95 },
      42: { buffer: closedHatBuf, rootKey: 42, sampleRate, baseGain: 0.85 },
      44: { buffer: closedHatBuf, rootKey: 44, sampleRate, baseGain: 0.8 },
      46: { buffer: openHatBuf, rootKey: 46, sampleRate, baseGain: 0.85 },
      41: { buffer: tomBuf, rootKey: 41, sampleRate, baseGain: 0.9 },
      43: { buffer: tomBuf, rootKey: 43, sampleRate, baseGain: 0.9 },
      45: { buffer: tomBuf, rootKey: 45, sampleRate, baseGain: 0.9 },
      47: { buffer: tomBuf, rootKey: 47, sampleRate, baseGain: 0.9 },
      48: { buffer: tomBuf, rootKey: 48, sampleRate, baseGain: 0.9 },
      50: { buffer: tomBuf, rootKey: 50, sampleRate, baseGain: 0.9 },
      49: { buffer: crashBuf, rootKey: 49, sampleRate, baseGain: 0.8 },
      51: { buffer: crashBuf, rootKey: 51, sampleRate, baseGain: 0.75 },
      57: { buffer: crashBuf, rootKey: 57, sampleRate, baseGain: 0.75 }
    };

    registeredPresets.set("gm_drums", {
      id: "gm_drums",
      name: "128: GM Rhythm Drumkit",
      bank: 128,
      program: 0,
      isCustom: false,
      samples: drumKeyMap
    });

    isBuiltInBankInitialized = true;
  } catch (err) {
    console.log("Built-in SoundFont init skipped:", err);
  }
}

/**
 * Register custom audio sample into SoundFont Engine (used by MOD/XM/SF2 decoders)
 */
export function registerCustomInstrument(
  id: string, 
  name: string, 
  buffer: AudioBuffer, 
  rootKey = 60, 
  sampleRate = 44100,
  loopStart?: number,
  loopEnd?: number
) {
  registeredPresets.set(id, {
    id,
    name,
    bank: 1,
    program: registeredPresets.size,
    isCustom: true,
    samples: {
      buffer,
      rootKey,
      sampleRate,
      loopStart,
      loopEnd,
      baseGain: 1.0
    }
  });
  loadedBankInfo.instrumentCount = registeredPresets.size;
}

/**
 * Return list of all available instruments (built-in + uploaded SF2/SF3)
 */
export function getAvailableSoundFontInstruments(): SoundFontInstrument[] {
  const list: SoundFontInstrument[] = [];
  registeredPresets.forEach((preset) => {
    const sample = Array.isArray(preset.samples) ? preset.samples[0] : (preset.samples as any).buffer ? preset.samples as SoundFontSampleVoice : null;
    list.push({
      id: preset.id,
      name: preset.name,
      bank: preset.bank,
      program: preset.program,
      isCustom: preset.isCustom,
      rootKey: sample?.rootKey || 60,
      sampleRate: sample?.sampleRate || 44100
    });
  });
  return list;
}

/**
 * Return instruments including underlying audio buffers for binary export
 */
export function getRegisteredInstruments(): Array<SoundFontInstrument & { audioBuffer?: AudioBuffer }> {
  const list: Array<SoundFontInstrument & { audioBuffer?: AudioBuffer }> = [];
  registeredPresets.forEach((preset) => {
    let sample: SoundFontSampleVoice | null = null;
    if ((preset.samples as any)?.buffer) {
      sample = preset.samples as SoundFontSampleVoice;
    } else if (preset.samples) {
      const vals = Object.values(preset.samples);
      if (vals.length > 0) sample = vals[0] as SoundFontSampleVoice;
    }
    list.push({
      id: preset.id,
      name: preset.name,
      bank: preset.bank,
      program: preset.program,
      isCustom: preset.isCustom,
      rootKey: sample?.rootKey || 60,
      sampleRate: sample?.sampleRate || 44100,
      audioBuffer: sample?.buffer
    });
  });
  return list;
}

export function getSoundFontBankInfo(): SoundFontBankInfo {
  return {
    ...loadedBankInfo,
    instrumentCount: registeredPresets.size
  };
}

/**
 * Parse an authentic binary SoundFont 2 (.sf2) or SoundFont 3 (.sf3) file
 */
export async function parseSoundFontFile(
  arrayBuffer: ArrayBuffer, 
  fileName: string,
  audioCtx: AudioContext
): Promise<{ bankInfo: SoundFontBankInfo; instruments: SoundFontInstrument[]; logs: string[] }> {
  const logs: string[] = [
    `[SF2/SF3] Initializing parser for: ${fileName} (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB)...`
  ];
  const u8 = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // Check RIFF header
  const riffMagic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (riffMagic !== 'RIFF') {
    throw new Error("Invalid SoundFont file: Missing 'RIFF' header signature");
  }

  const formatMagic = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
  if (formatMagic !== 'sfbk') {
    throw new Error(`Unsupported SoundFont format '${formatMagic}'. Expected 'sfbk'.`);
  }

  logs.push(`[SF2/SF3] Valid SoundFont Bank 'sfbk' verified.`);

  let bankName = fileName.replace(/\.[^/.]+$/, "");
  let bankVersion = "2.04";
  let bankAuthor = "Custom SoundFont";
  let sampleDataStart = 0;
  let sampleDataLen = 0;
  const sampleHeaders: any[] = [];
  const presetHeaders: any[] = [];

  // Traverse RIFF LIST chunks
  let offset = 12;
  while (offset + 8 <= u8.length) {
    const chunkId = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
    const chunkLen = view.getUint32(offset + 4, true);
    const chunkEnd = offset + 8 + chunkLen;

    if (chunkId === 'LIST') {
      const listType = String.fromCharCode(u8[offset + 8], u8[offset + 9], u8[offset + 10], u8[offset + 11]);
      logs.push(`[SF2/SF3] Processing Chunk: LIST '${listType}' (size: ${(chunkLen / 1024).toFixed(1)} KB)`);

      let subOffset = offset + 12;
      while (subOffset + 8 <= chunkEnd && subOffset + 8 <= u8.length) {
        const subId = String.fromCharCode(u8[subOffset], u8[subOffset + 1], u8[subOffset + 2], u8[subOffset + 3]);
        const subLen = view.getUint32(subOffset + 4, true);
        const subData = subOffset + 8;

        if (listType === 'INFO') {
          // Metadata subchunks
          let str = "";
          for (let s = 0; s < Math.min(subLen, 64); s++) {
            if (u8[subData + s] === 0) break;
            str += String.fromCharCode(u8[subData + s]);
          }
          if (subId === 'INAM' && str.trim()) bankName = str.trim();
          if (subId === 'IENG' && str.trim()) bankAuthor = str.trim();
          if (subId === 'ifil') {
            const major = view.getUint16(subData, true);
            const minor = view.getUint16(subData + 2, true);
            bankVersion = `${major}.${minor}`;
          }
        } else if (listType === 'sdta') {
          // PCM Sample data
          if (subId === 'smpl') {
            sampleDataStart = subData;
            sampleDataLen = subLen;
            logs.push(`[SF2/SF3] Found 16-bit PCM Sample Stream: ${(subLen / 1024).toFixed(1)} KB`);
          }
        } else if (listType === 'pdta') {
          // Sample Headers (shdr)
          if (subId === 'shdr') {
            const shdrSize = 46;
            const count = Math.floor(subLen / shdrSize);
            logs.push(`[SF2/SF3] Sample Headers found: ${count}`);
            for (let i = 0; i < count; i++) {
              const rec = subData + (i * shdrSize);
              let sName = "";
              for (let n = 0; n < 20; n++) {
                if (u8[rec + n] === 0) break;
                sName += String.fromCharCode(u8[rec + n]);
              }
              const sStart = view.getUint32(rec + 20, true);
              const sEnd = view.getUint32(rec + 24, true);
              const sStartLoop = view.getUint32(rec + 28, true);
              const sEndLoop = view.getUint32(rec + 32, true);
              const sSampleRate = view.getUint32(rec + 36, true);
              const sOriginalPitch = u8[rec + 40];
              const sPitchCorrection = view.getInt8(rec + 41);

              if (sName.trim() && sEnd > sStart) {
                sampleHeaders.push({
                  name: sName.trim(),
                  start: sStart,
                  end: sEnd,
                  startLoop: sStartLoop,
                  endLoop: sEndLoop,
                  sampleRate: sSampleRate || 44100,
                  rootKey: sOriginalPitch > 0 && sOriginalPitch < 128 ? sOriginalPitch : 60,
                  pitchCorrection: sPitchCorrection
                });
              }
            }
          } else if (subId === 'phdr') {
            // Preset Headers (phdr)
            const phdrSize = 38;
            const pCount = Math.floor(subLen / phdrSize);
            logs.push(`[SF2/SF3] Presets found: ${pCount}`);
            for (let i = 0; i < pCount; i++) {
              const rec = subData + (i * phdrSize);
              let pName = "";
              for (let n = 0; n < 20; n++) {
                if (u8[rec + n] === 0) break;
                pName += String.fromCharCode(u8[rec + n]);
              }
              const pPreset = view.getUint16(rec + 20, true);
              const pBank = view.getUint16(rec + 22, true);
              if (pName.trim() && pName !== 'EOP') {
                presetHeaders.push({
                  name: pName.trim(),
                  program: pPreset,
                  bank: pBank
                });
              }
            }
          }
        }
        subOffset += 8 + subLen + (subLen % 2); // Word aligned
      }
    }
    offset = chunkEnd + (chunkLen % 2);
  }

  logs.push(`[SF2/SF3] Bank Name: "${bankName}", Version: ${bankVersion}, Author: ${bankAuthor}`);

  // Convert raw 16-bit PCM sample data into playable AudioBuffers
  let extractedCount = 0;
  if (sampleDataStart > 0 && sampleHeaders.length > 0) {
    const sampleInt16 = new Int16Array(
      arrayBuffer, 
      sampleDataStart, 
      Math.floor(sampleDataLen / 2)
    );

    // Limit to 32 most important instruments to prevent memory explosion in sandbox
    const samplesToLoad = sampleHeaders.slice(0, 32);
    for (const sh of samplesToLoad) {
      const len = Math.max(1, sh.end - sh.start);
      if (sh.start + len <= sampleInt16.length) {
        const audioBuf = audioCtx.createBuffer(1, len, sh.sampleRate || 44100);
        const channelData = audioBuf.getChannelData(0);
        for (let s = 0; s < len; s++) {
          channelData[s] = sampleInt16[sh.start + s] / 32768.0;
        }

        const presetId = `custom_sf_${extractedCount}_${sh.name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
        registeredPresets.set(presetId, {
          id: presetId,
          name: `${presetId.includes('drum') ? '🥁' : '🎵'} ${sh.name}`,
          bank: 0,
          program: extractedCount,
          isCustom: true,
          samples: {
            buffer: audioBuf,
            rootKey: sh.rootKey || 60,
            sampleRate: sh.sampleRate || 44100,
            loopStart: sh.startLoop > sh.start ? sh.startLoop - sh.start : undefined,
            loopEnd: sh.endLoop > sh.start ? sh.endLoop - sh.start : undefined,
            baseGain: 1.0
          }
        });
        extractedCount++;
      }
    }
  }

  // Update global bank info
  loadedBankInfo = {
    name: bankName,
    version: bankVersion,
    instrumentCount: registeredPresets.size,
    author: bankAuthor,
    isLoaded: true
  };

  const instrumentsList = getAvailableSoundFontInstruments();
  logs.push(`[SUCCESS] Loaded and compiled ${extractedCount} custom SoundFont instruments into Audio Engine!`);

  return {
    bankInfo: loadedBankInfo,
    instruments: instrumentsList,
    logs
  };
}

/**
 * Play a SoundFont note with realistic sample pitch-shifting and ADSR gain envelope
 */
export function playSoundFontNote(
  ctx: AudioContext,
  instrumentId: string,
  midiNote: number,
  duration = 0.25,
  volume = 80,
  pan = 50,
  destination?: AudioNode
): { source: AudioBufferSourceNode; gain: GainNode } | null {
  try {
    initBuiltInSoundFont(ctx);

    // Find preset by ID or fallback to standard GM piano
    let preset = registeredPresets.get(instrumentId);
    if (!preset) {
      // Look up by partial match or take first available
      preset = Array.from(registeredPresets.values()).find(p => p.id.includes(instrumentId)) ||
               registeredPresets.get("gm_piano");
    }

    if (!preset) return null;

    let sample: SoundFontSampleVoice | null = null;
    if ((preset.samples as any).buffer) {
      sample = preset.samples as SoundFontSampleVoice;
    } else {
      sample = (preset.samples as any)[midiNote] || Object.values(preset.samples)[0] as SoundFontSampleVoice;
    }

    if (!sample || !sample.buffer) return null;

    const rootKey = sample.rootKey || 60;
    const isDrum = preset.id === 'gm_drums' || preset.bank === 128;
    // Calculate pitch shift ratio: (target - root) / 12 (drums do not pitch shift)
    const playbackRate = isDrum ? 1.0 : Math.max(0.0625, Math.min(16.0, Math.pow(2, (midiNote - rootKey) / 12)));

    const source = ctx.createBufferSource();
    source.buffer = sample.buffer;
    source.playbackRate.setValueAtTime(playbackRate, ctx.currentTime);

    // Set loop points if available
    if (sample.loopStart !== undefined && sample.loopEnd !== undefined && sample.loopEnd > sample.loopStart) {
      source.loop = true;
      source.loopStart = sample.loopStart / sample.sampleRate;
      source.loopEnd = sample.loopEnd / sample.sampleRate;
    }

    const gainNode = ctx.createGain();
    const targetVolume = (volume / 100) * (sample.baseGain || 1.0) * 0.16;
    
    // Quick attack and smooth release
    gainNode.gain.setValueAtTime(targetVolume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    // Panning
    const panVal = (pan - 50) / 50;
    let panner: StereoPannerNode | PannerNode;
    if (ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      (panner as StereoPannerNode).pan.setValueAtTime(panVal, ctx.currentTime);
    } else {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      (panner as PannerNode).setPosition(panVal, 0, 1 - Math.abs(panVal));
    }

    source.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(destination || ctx.destination);

    source.start(ctx.currentTime);
    source.stop(ctx.currentTime + duration);

    return { source, gain: gainNode };
  } catch (err) {
    console.log("SoundFont playback skipped:", err);
    return null;
  }
}
