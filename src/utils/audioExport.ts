/**
 * audioExport.ts
 * Independent Offline Audio Renderer & Multi-Format Audio Exporter (WAV, MP3, MP2)
 *
 * Renders MIDI + active SoundFont, loaded AudioBuffers (MOD/WAV/MP3), or raw Tracker
 * pattern sequences completely offline using `spessasynth_core` — separate from live playback.
 */

import {
  BasicMIDI,
  BasicSoundBank,
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaSynthSequencer
} from 'spessasynth_core';
import { Mp3Encoder } from '@breezystack/lamejs';
import { WorkletSynthBridge } from '../engines/workletSynthBridge';
import { parseNoteNameToMidi } from '../components/AudioEngine';
import { getGmProgramForPreset } from './soundFontEngine';

export type AudioExportFormat = 'wav' | 'mp3' | 'mp2';

export interface ExportChannelMeta {
  id: number;
  chip?: string;
  soundFontPreset?: string;
  enabled?: boolean;
  mute?: boolean;
  volume?: number;
  pan?: number;
}

export interface OfflineSongSnapshot {
  songPatterns: any[][];
  channels: ExportChannelMeta[];
  bpm: number;
  baseSongBpm: number;
  trackTitle?: string | null;
  loadedAudioBuffer?: AudioBuffer | null;
  loadedMidiBuffer?: ArrayBuffer | null;
  soundBankBuffer?: ArrayBuffer | null;
}

export interface RenderedAudioData {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  durationSeconds: number;
  channelSignals: Float32Array[];
  channelLabels: string[];
}

const EXPORT_SAMPLE_RATE = 44100;

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function softLimitBuffer(buf: Float32Array) {
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (v > 0.95 || v < -0.95) {
      buf[i] = Math.tanh(v);
    }
  }
}

/**
 * Estimate duration of an audio buffer or tracker sequence in seconds
 */
export function estimateSnapshotDurationSeconds(snapshot: OfflineSongSnapshot): number {
  const rate = Math.max(0.25, Math.min(4.0, (snapshot.bpm || 125) / (snapshot.baseSongBpm || 125)));
  if (snapshot.loadedAudioBuffer) {
    return Math.max(1, snapshot.loadedAudioBuffer.duration / rate);
  }
  if (snapshot.loadedMidiBuffer) {
    try {
      const midi = BasicMIDI.fromArrayBuffer(snapshot.loadedMidiBuffer.slice(0));
      const baseDur = midi.midiTicksToSeconds(Math.max(1, midi.lastVoiceEventTick || 480));
      return Math.max(1, baseDur / rate);
    } catch {
      // fall through
    }
  }
  const pats = Math.max(1, snapshot.songPatterns?.length || 1);
  const secPerRow = 60 / Math.max(30, snapshot.bpm || 125) / 4;
  return Math.max(1, pats * 64 * secPerRow);
}

/**
 * Render an independent offline snapshot of the song (completely separate from live AudioContext playback)
 */
export async function renderSongSnapshotOffline(
  snapshot: OfflineSongSnapshot,
  targetDurationSeconds = 0,
  onProgress?: (pct: number, stage: string) => void,
  signal?: AbortSignal
): Promise<RenderedAudioData> {
  const sampleRate = EXPORT_SAMPLE_RATE;
  const rate = Math.max(0.25, Math.min(4.0, (snapshot.bpm || 125) / (snapshot.baseSongBpm || 125)));

  const checkAbort = () => {
    if (signal?.aborted) {
      throw new DOMException('Export cancelled', 'AbortError');
    }
  };

  // --- CASE 1: PRE-DECODED AUDIO BUFFER (MOD / WAV / MP3) ---
  if (snapshot.loadedAudioBuffer) {
    const srcBuf = snapshot.loadedAudioBuffer;
    const srcRate = srcBuf.sampleRate || 44100;
    const srcL = srcBuf.getChannelData(0);
    const srcR = srcBuf.numberOfChannels > 1 ? srcBuf.getChannelData(1) : srcL;

    const fullDur = srcBuf.duration / rate;
    const finalDur = targetDurationSeconds > 0
      ? Math.max(0.5, Math.min(600, targetDurationSeconds))
      : Math.max(0.5, Math.min(600, fullDur));
    const totalSamples = Math.floor(finalDur * sampleRate);

    const outL = new Float32Array(totalSamples);
    const outR = new Float32Array(totalSamples);
    const channelSignals = Array.from({ length: 16 }, () => new Float32Array(totalSamples));

    const srcStep = (srcRate / sampleRate) * rate;
    const srcLen = srcL.length;

    let lp = 0;
    let bp = 0;
    for (let i = 0; i < totalSamples; i++) {
      if (i > 0 && i % 44100 === 0) {
        checkAbort();
        onProgress?.(Math.round((i / totalSamples) * 100), 'Rendering audio buffer');
        await yieldToMain();
      }
      const pos = (i * srcStep) % Math.max(1, srcLen);
      const idx0 = Math.floor(pos);
      const frac = pos - idx0;
      const idx1 = (idx0 + 1) % srcLen;

      const lVal = srcL[idx0] + frac * (srcL[idx1] - srcL[idx0]);
      const rVal = srcR[idx0] + frac * (srcR[idx1] - srcR[idx0]);
      outL[i] = lVal;
      outR[i] = rVal;

      const mono = (lVal + rVal) * 0.5;
      lp = lp * 0.96 + mono * 0.04;
      bp = bp * 0.8 + (mono - lp) * 0.2;
      const hi = mono - lp - bp;
      for (let ch = 0; ch < 16; ch++) {
        if (snapshot.channels[ch]?.mute) continue;
        const band = ch % 3 === 0 ? lp * 1.4 : ch % 3 === 1 ? bp * 1.6 : hi * 1.8;
        channelSignals[ch][i] = band;
      }
    }

    const channelLabels = Array.from({ length: 16 }, (_, idx) => {
      const ch = snapshot.channels[idx];
      return ch?.soundFontPreset?.replace(/^gm_/, '').toUpperCase() || ch?.chip?.split(' ')[0] || `CH${idx + 1}`;
    });

    onProgress?.(100, 'Audio snapshot ready');
    return {
      left: outL,
      right: outR,
      sampleRate,
      durationSeconds: finalDur,
      channelSignals,
      channelLabels
    };
  }

  // --- PREPARE ISOLATED OFFLINE SPESSASYNTH PROCESSOR (FOR MIDI & TRACKER) ---
  const bankBuffer = (snapshot.soundBankBuffer || WorkletSynthBridge.getActiveSoundBankBuffer()).slice(0);
  let soundBank: BasicSoundBank;
  try {
    soundBank = SoundBankLoader.fromArrayBuffer(bankBuffer);
  } catch {
    soundBank = SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile().slice(0));
  }

  const synth = new SpessaSynthProcessor(sampleRate, {
    eventsEnabled: false,
    effectsEnabled: true,
    maxBufferSize: 128
  });
  synth.soundBankManager.addSoundBank(soundBank, 'offline-main', 0, false);
  await synth.ready;

  const quantum = 128;
  const channelOutputs: Float32Array[][] = Array.from({ length: 16 }, () => [
    new Float32Array(quantum),
    new Float32Array(quantum)
  ]);

  // --- CASE 2: MIDI BUFFER OFFLINE RENDERING ---
  if (snapshot.loadedMidiBuffer) {
    const midi = BasicMIDI.fromArrayBuffer(snapshot.loadedMidiBuffer.slice(0));
    const seq = new SpessaSynthSequencer(synth);
    seq.loopCount = targetDurationSeconds > 0 ? Infinity : 0;
    seq.skipToFirstNoteOn = false;
    seq.loadNewSongList([midi]);
    seq.playbackRate = rate;
    seq.play();

    // Respect per-channel mutes from snapshot
    for (let ch = 0; ch < 16; ch++) {
      if (snapshot.channels[ch]?.mute) {
        synth.midiChannels[ch]?.setSystemParameter('isMuted', true);
      }
    }

    const songDur = Math.max(1, (seq.duration || 10) / rate);
    const finalDur = targetDurationSeconds > 0
      ? Math.max(0.5, Math.min(600, targetDurationSeconds))
      : Math.max(1, Math.min(600, songDur + 0.6));
    const totalSamples = Math.floor(finalDur * sampleRate);

    const outL = new Float32Array(totalSamples);
    const outR = new Float32Array(totalSamples);
    const channelSignals = Array.from({ length: 16 }, () => new Float32Array(totalSamples));

    const channelLabels = Array.from({ length: 16 }, (_, idx) => `CH${idx + 1}`);

    let offset = 0;
    let yieldCounter = 0;
    while (offset < totalSamples) {
      checkAbort();
      const count = Math.min(quantum, totalSamples - offset);
      for (let c = 0; c < 16; c++) {
        channelOutputs[c][0].fill(0);
        channelOutputs[c][1].fill(0);
      }

      seq.processTick();
      synth.process(outL, outR, offset, count, channelOutputs);

      for (let c = 0; c < 16; c++) {
        const dst = channelSignals[c];
        const chL = channelOutputs[c][0];
        const chR = channelOutputs[c][1];
        for (let i = 0; i < count; i++) {
          dst[offset + i] = (chL[i] + chR[i]) * 0.5;
        }
        const presetName = synth.midiChannels[c]?.preset?.name;
        if (presetName) {
          channelLabels[c] = presetName;
        }
      }

      offset += count;
      yieldCounter += count;
      if (yieldCounter >= 22050) {
        yieldCounter = 0;
        onProgress?.(Math.min(99, Math.round((offset / totalSamples) * 100)), 'Synthesizing MIDI + SoundFont offline');
        await yieldToMain();
      }
    }

    softLimitBuffer(outL);
    softLimitBuffer(outR);
    onProgress?.(100, 'Offline MIDI audio ready');
    return {
      left: outL,
      right: outR,
      sampleRate,
      durationSeconds: finalDur,
      channelSignals,
      channelLabels
    };
  }

  // --- CASE 3: PURE TRACKER PATTERNS OFFLINE RENDERING ---
  const patterns = snapshot.songPatterns && snapshot.songPatterns.length > 0
    ? snapshot.songPatterns
    : [[]];
  const secPerRow = 60 / Math.max(30, snapshot.bpm || 125) / 4;
  const samplesPerRow = Math.max(128, Math.round(secPerRow * sampleRate));
  const totalSequenceRows = Math.max(64, patterns.length * 64);
  const fullDur = (totalSequenceRows * samplesPerRow) / sampleRate;
  const finalDur = targetDurationSeconds > 0
    ? Math.max(0.5, Math.min(600, targetDurationSeconds))
    : Math.max(1, Math.min(600, fullDur + 0.5));
  const totalSamples = Math.floor(finalDur * sampleRate);

  const outL = new Float32Array(totalSamples);
  const outR = new Float32Array(totalSamples);
  const channelSignals = Array.from({ length: 16 }, () => new Float32Array(totalSamples));

  for (let ch = 0; ch < 16; ch++) {
    const chMeta = snapshot.channels[ch];
    const prog = getGmProgramForPreset(chMeta?.soundFontPreset);
    const isDrum = ch === 9 || chMeta?.soundFontPreset === 'gm_drums';
    synth.midiChannels[ch]?.setDrums(isDrum);
    synth.programChange(ch, prog);
    synth.controllerChange(ch, 7 as any, Math.round(((chMeta?.volume ?? 85) / 100) * 127));
    synth.controllerChange(ch, 10 as any, Math.round(((chMeta?.pan ?? 50) / 100) * 127));
    if (chMeta?.mute) {
      synth.midiChannels[ch]?.setSystemParameter('isMuted', true);
    }
  }

  const activeNotePerCh = new Int16Array(16).fill(-1);
  let lastTriggeredGlobalRow = -1;

  let offset = 0;
  let yieldCounter = 0;
  while (offset < totalSamples) {
    checkAbort();
    const globalRow = Math.floor(offset / samplesPerRow) % totalSequenceRows;
    if (globalRow !== lastTriggeredGlobalRow) {
      lastTriggeredGlobalRow = globalRow;
      const patIdx = Math.floor(globalRow / 64) % patterns.length;
      const rowIdx = globalRow % 64;
      const rowData = patterns[patIdx]?.[rowIdx];
      if (rowData) {
        for (let c = 0; c < 16; c++) {
          const chId = c + 1;
          const cell = rowData[chId];
          const chMeta = snapshot.channels[c];
          if (!chMeta?.enabled || chMeta?.mute) continue;
          if (!cell || !cell.note || cell.note === '---') continue;

          if (activeNotePerCh[c] >= 0) {
            synth.noteOff(c, activeNotePerCh[c]);
            activeNotePerCh[c] = -1;
          }

          if (cell.note !== '===' && cell.note !== 'OFF') {
            const midiNote = parseNoteNameToMidi(cell.note);
            if (midiNote !== null) {
              const vel = cell.vol && cell.vol !== '..'
                ? Math.min(127, Math.max(16, Math.round((parseInt(cell.vol, 16) / 99) * 127)))
                : 100;
              synth.noteOn(c, midiNote, vel);
              activeNotePerCh[c] = midiNote;
            }
          }
        }
      }
    }

    const count = Math.min(quantum, totalSamples - offset);
    for (let c = 0; c < 16; c++) {
      channelOutputs[c][0].fill(0);
      channelOutputs[c][1].fill(0);
    }

    synth.process(outL, outR, offset, count, channelOutputs);

    for (let c = 0; c < 16; c++) {
      const dst = channelSignals[c];
      const chL = channelOutputs[c][0];
      const chR = channelOutputs[c][1];
      for (let i = 0; i < count; i++) {
        dst[offset + i] = (chL[i] + chR[i]) * 0.5;
      }
    }

    offset += count;
    yieldCounter += count;
    if (yieldCounter >= 22050) {
      yieldCounter = 0;
      onProgress?.(Math.min(99, Math.round((offset / totalSamples) * 100)), 'Synthesizing tracker sequence offline');
      await yieldToMain();
    }
  }

  softLimitBuffer(outL);
  softLimitBuffer(outR);
  const channelLabels = Array.from({ length: 16 }, (_, c) =>
    synth.midiChannels[c]?.preset?.name ||
    snapshot.channels[c]?.soundFontPreset?.replace(/^gm_/, '').toUpperCase() ||
    `CH${c + 1}`
  );

  onProgress?.(100, 'Offline tracker audio ready');
  return {
    left: outL,
    right: outR,
    sampleRate,
    durationSeconds: finalDur,
    channelSignals,
    channelLabels
  };
}

/**
 * 1. Encode Stereo 16-bit PCM RIFF WAV (.wav)
 */
export function encodeWavBlob(left: Float32Array, right: Float32Array, sampleRate = EXPORT_SAMPLE_RATE): Blob {
  const numFrames = Math.min(left.length, right.length);
  const dataSize = numFrames * 4; // 2 channels * 2 bytes
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat 1 = PCM
  view.setUint16(22, 2, true); // NumChannels = 2
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // ByteRate
  view.setUint16(32, 4, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let pos = 44;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(pos, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(pos + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    pos += 4;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * 2. Encode Stereo MPEG-1 Audio Layer III (.mp3) using @breezystack/lamejs
 */
export async function encodeMp3Blob(
  left: Float32Array,
  right: Float32Array,
  sampleRate = EXPORT_SAMPLE_RATE,
  kbps = 192,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const numFrames = Math.min(left.length, right.length);
  const encoder = new Mp3Encoder(2, sampleRate, kbps);
  const blockSize = 1152;
  const leftInt16 = new Int16Array(blockSize);
  const rightInt16 = new Int16Array(blockSize);
  const chunks: BlobPart[] = [];

  for (let offset = 0; offset < numFrames; offset += blockSize) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const len = Math.min(blockSize, numFrames - offset);
    for (let i = 0; i < len; i++) {
      const l = Math.max(-1, Math.min(1, left[offset + i]));
      const r = Math.max(-1, Math.min(1, right[offset + i]));
      leftInt16[i] = l < 0 ? Math.round(l * 32768) : Math.round(l * 32767);
      rightInt16[i] = r < 0 ? Math.round(r * 32768) : Math.round(r * 32767);
    }
    const mp3buf = encoder.encodeBuffer(
      len === blockSize ? leftInt16 : leftInt16.subarray(0, len),
      len === blockSize ? rightInt16 : rightInt16.subarray(0, len)
    );
    if (mp3buf && mp3buf.length > 0) {
      chunks.push(new Uint8Array(mp3buf));
    }

    if ((offset / blockSize) % 40 === 0) {
      onProgress?.(Math.min(99, Math.round((offset / numFrames) * 100)));
      await yieldToMain();
    }
  }

  const endBuf = encoder.flush();
  if (endBuf && endBuf.length > 0) {
    chunks.push(new Uint8Array(endBuf));
  }
  onProgress?.(100);
  return new Blob(chunks, { type: 'audio/mpeg' });
}

// --- ISO/IEC 11172-3 MPEG-1 AUDIO LAYER II (.mp2) ENCODER ---

// Standard PQMF 512-tap prototype window coefficients C[0..511]
const MP2_WINDOW_C = (() => {
  const c = new Float64Array(512);
  for (let i = 0; i < 512; i++) {
    const n = i - 256;
    if (n === 0) {
      c[i] = 1 / 64;
    } else {
      // Sinc lowpass with cutoff pi/64, Hamming/Blackman shaped for low aliasing, sign flipped per odd block (ISO parity)
      const sinc = Math.sin((Math.PI * n) / 64) / (Math.PI * n);
      const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / 512);
      const blockSign = Math.floor(i / 64) % 2 === 1 ? -1 : 1;
      c[i] = sinc * win * blockSign * 2.0;
    }
  }
  return c;
})();

const MP2_ANAL_MATRIX = (() => {
  const m: Float64Array[] = [];
  for (let sb = 0; sb < 32; sb++) {
    const row = new Float64Array(64);
    for (let j = 0; j < 64; j++) {
      row[j] = Math.cos(((2 * sb + 1) * (j - 16) * Math.PI) / 64);
    }
    m.push(row);
  }
  return m;
})();

// ISO 11172-3 Scale Factors table (63 levels)
const MP2_SCALEFACTORS = (() => {
  const s = new Float64Array(63);
  for (let i = 0; i < 63; i++) {
    s[i] = 2.0 * Math.pow(2, -i / 3);
  }
  return s;
})();

// Table B.2a (44.1kHz, 128 kbps/ch stereo -> sblimit = 27)
// Per subband: nbal (bits for allocation index), and steps counts per allocation index
const MP2_NBAL = [
  4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  2, 2, 2, 2
];

// Quantization step tables for each subband band group (index 0 = unused / 0 bits)
// Using Table B.2a levels mapping index -> { steps, bitsPerTriplet, grouped }
interface Mp2QuantDef {
  steps: number;
  bits: number;
  grouped: boolean;
}

const Q_ALL: Mp2QuantDef[] = [
  { steps: 0, bits: 0, grouped: false },
  { steps: 3, bits: 5, grouped: true },
  { steps: 5, bits: 7, grouped: true },
  { steps: 7, bits: 9, grouped: false }, // 3*3
  { steps: 9, bits: 10, grouped: true },
  { steps: 15, bits: 12, grouped: false }, // 4*3
  { steps: 31, bits: 15, grouped: false }, // 5*3
  { steps: 63, bits: 18, grouped: false }, // 6*3
  { steps: 127, bits: 21, grouped: false },
  { steps: 255, bits: 24, grouped: false },
  { steps: 511, bits: 27, grouped: false },
  { steps: 1023, bits: 30, grouped: false },
  { steps: 2047, bits: 33, grouped: false },
  { steps: 4095, bits: 36, grouped: false },
  { steps: 8191, bits: 39, grouped: false },
  { steps: 65535, bits: 48, grouped: false }
];

// High-sb (sb 23..26) 2-bit allocation table (4 entries)
const Q_2BIT: Mp2QuantDef[] = [
  Q_ALL[0],
  Q_ALL[1], // 3 steps
  Q_ALL[2], // 5 steps
  Q_ALL[15] // 65535
];

// Mid-sb (sb 11..22) 3-bit allocation table (8 entries)
const Q_3BIT: Mp2QuantDef[] = [
  Q_ALL[0],
  Q_ALL[1],
  Q_ALL[2],
  Q_ALL[3],
  Q_ALL[4],
  Q_ALL[5],
  Q_ALL[6],
  Q_ALL[15]
];

// Low-sb (sb 0..2) 4-bit table maps idx 0..14 -> Q_ALL[0..14], idx 15 -> 65535
function getMp2QuantDef(sb: number, allocIdx: number): Mp2QuantDef {
  if (allocIdx <= 0) return Q_ALL[0];
  if (sb <= 2) return Q_ALL[Math.min(15, allocIdx)];
  if (sb <= 10) return allocIdx >= 15 ? Q_ALL[15] : Q_ALL[Math.min(14, allocIdx)];
  if (sb <= 22) return Q_3BIT[Math.min(7, allocIdx)];
  return Q_2BIT[Math.min(3, allocIdx)];
}

class BitWriter {
  private bytes: Uint8Array;
  private bitPos = 0;

  constructor(byteLength: number) {
    this.bytes = new Uint8Array(byteLength);
  }

  public writeBits(val: number, count: number) {
    for (let b = count - 1; b >= 0; b--) {
      const bit = (val >>> b) & 1;
      const byteIdx = this.bitPos >> 3;
      const bitIdx = 7 - (this.bitPos & 7);
      if (byteIdx < this.bytes.length && bit) {
        this.bytes[byteIdx] |= 1 << bitIdx;
      }
      this.bitPos++;
    }
  }

  public get buffer(): Uint8Array {
    return this.bytes;
  }
}

/**
 * 3. Encode Stereo MPEG-1 Audio Layer II (.mp2) at 256 kbps
 */
export async function encodeMp2Blob(
  left: Float32Array,
  right: Float32Array,
  sampleRate = EXPORT_SAMPLE_RATE,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const numSamples = Math.min(left.length, right.length);
  const frameSamples = 1152;
  const totalFrames = Math.ceil(numSamples / frameSamples);
  const bitrateBps = 256000;
  const sfCode = sampleRate === 48000 ? 1 : 0; // 44100 Hz = 0, 48000 Hz = 1
  const sblimit = 27;

  // PQMF circular state per channel
  const ringL = new Float64Array(512);
  const ringR = new Float64Array(512);
  const subbandsL = Array.from({ length: 32 }, () => new Float64Array(36));
  const subbandsR = Array.from({ length: 32 }, () => new Float64Array(36));
  const yScratch = new Float64Array(64);

  const runPqmfStep = (ring: Float64Array, src: Float32Array, srcPos: number, outSub: Float64Array[], slot: number) => {
    ring.copyWithin(32, 0, 480);
    for (let i = 0; i < 32; i++) {
      const idx = srcPos + i;
      ring[31 - i] = idx < src.length ? src[idx] : 0;
    }
    for (let j = 0; j < 64; j++) {
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        const wi = j + k * 64;
        sum += ring[wi] * MP2_WINDOW_C[wi];
      }
      yScratch[j] = sum;
    }
    for (let sb = 0; sb < 32; sb++) {
      const row = MP2_ANAL_MATRIX[sb];
      let val = 0;
      for (let j = 0; j < 64; j++) {
        val += row[j] * yScratch[j];
      }
      outSub[sb][slot] = val;
    }
  };

  const pickScaleFactorIdx = (samples: Float64Array, start: number, len: number): number => {
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const a = Math.abs(samples[start + i]);
      if (a > peak) peak = a;
    }
    let bestIdx = 62;
    for (let idx = 62; idx >= 0; idx--) {
      if (MP2_SCALEFACTORS[idx] >= peak) {
        bestIdx = idx;
      } else {
        break;
      }
    }
    return bestIdx;
  };

  const mp2Chunks: BlobPart[] = [];
  const exactBytesPerFrame = (144 * bitrateBps) / sampleRate;
  const baseFrameBytes = Math.floor(exactBytesPerFrame);
  const fracBytes = exactBytesPerFrame - baseFrameBytes;
  let padAccum = 0;

  const allocIdx = [new Uint8Array(sblimit), new Uint8Array(sblimit)];
  const scfIdx = [
    [new Uint8Array(3), new Uint8Array(3), new Uint8Array(3)],
  ];
  void scfIdx;
  const scfL = Array.from({ length: sblimit }, () => new Uint8Array(3));
  const scfR = Array.from({ length: sblimit }, () => new Uint8Array(3));
  const sbEnergy = [new Float64Array(sblimit), new Float64Array(sblimit)];

  for (let frame = 0; frame < totalFrames; frame++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const baseSample = frame * frameSamples;

    for (let slot = 0; slot < 36; slot++) {
      runPqmfStep(ringL, left, baseSample + slot * 32, subbandsL, slot);
      runPqmfStep(ringR, right, baseSample + slot * 32, subbandsR, slot);
    }

    padAccum += fracBytes;
    const padding = padAccum >= 1 ? 1 : 0;
    if (padding) padAccum -= 1;
    const frameBytes = baseFrameBytes + padding;
    const totalAvailBits = frameBytes * 8;

    // Header (32) + bitalloc (2 * 88 = 176) = 208 fixed overhead bits
    const fixedBits = 32 + 2 * MP2_NBAL.reduce((a, b) => a + b, 0);

    // Measure subband peaks & select scale factors (SCFSI = 2: 1 shared 6-bit scale factor per active sb for deterministic compact overhead)
    for (let sb = 0; sb < sblimit; sb++) {
      scfL[sb][0] = pickScaleFactorIdx(subbandsL[sb], 0, 36);
      scfR[sb][0] = pickScaleFactorIdx(subbandsR[sb], 0, 36);

      let eL = 0;
      let eR = 0;
      for (let i = 0; i < 36; i++) {
        eL += Math.abs(subbandsL[sb][i]);
        eR += Math.abs(subbandsR[sb][i]);
      }
      // Bias slightly toward lower-mid bands for perceptual clarity
      const weight = 1.0 - (sb / sblimit) * 0.45;
      sbEnergy[0][sb] = eL * weight;
      sbEnergy[1][sb] = eR * weight;
      allocIdx[0][sb] = 0;
      allocIdx[1][sb] = 0;
    }

    // Greedy water-filling bit allocation strictly within totalAvailBits
    const calcFrameBits = () => {
      let bits = fixedBits;
      for (let ch = 0; ch < 2; ch++) {
        for (let sb = 0; sb < sblimit; sb++) {
          const idx = allocIdx[ch][sb];
          if (idx > 0) {
            const def = getMp2QuantDef(sb, idx);
            bits += 2 + 6 + def.bits * 12; // SCFSI (2) + 1 shared SCF (6) + 12 triplets
          }
        }
      }
      return bits;
    };

    const maxAllocForSb = (sb: number) => (sb <= 2 ? 14 : sb <= 10 ? 14 : sb <= 22 ? 6 : 2);
    for (let pass = 0; pass < 420; pass++) {
      let bestCh = -1;
      let bestSb = -1;
      let bestScore = -1;
      const curBits = calcFrameBits();
      for (let ch = 0; ch < 2; ch++) {
        for (let sb = 0; sb < sblimit; sb++) {
          if (sbEnergy[ch][sb] <= 1e-6) continue;
          const curIdx = allocIdx[ch][sb];
          if (curIdx >= maxAllocForSb(sb)) continue;
          const nextDef = getMp2QuantDef(sb, curIdx + 1);
          const curDef = getMp2QuantDef(sb, curIdx);
          const extraBits = (curIdx === 0 ? 8 : 0) + (nextDef.bits - curDef.bits) * 12;
          if (curBits + extraBits > totalAvailBits) continue;
          const score = sbEnergy[ch][sb] / Math.max(1, curIdx + 1);
          if (score > bestScore) {
            bestScore = score;
            bestCh = ch;
            bestSb = sb;
          }
        }
      }
      if (bestCh === -1) break;
      allocIdx[bestCh][bestSb]++;
    }

    const writer = new BitWriter(frameBytes);
    // 32-bit MPEG-1 Layer II header: 11111111 111 1(MPEG1) 01(LayerII) 1(noCRC)
    // Byte 0: 0xFF, Byte 1: 0xFD
    // Byte 2: bitrateIdx(12=0xC)<<4 | sfCode<<2 | padding<<1 | 0
    // Byte 3: mode(0 stereo)<<6 | modeExt(0)<<4 | copy(0)<<3 | orig(1)<<2 | emph(0)
    writer.writeBits(0xff, 8);
    writer.writeBits(0xfd, 8);
    writer.writeBits((0x0c << 4) | (sfCode << 2) | (padding << 1), 8);
    writer.writeBits(0x04, 8);

    // 1. Write Bit Allocation table (channel 0 then 1 per subband)
    for (let sb = 0; sb < sblimit; sb++) {
      writer.writeBits(allocIdx[0][sb], MP2_NBAL[sb]);
      writer.writeBits(allocIdx[1][sb], MP2_NBAL[sb]);
    }

    // 2. Write SCFSI (2 = single shared scale factor for all 3 parts)
    for (let sb = 0; sb < sblimit; sb++) {
      if (allocIdx[0][sb] > 0) writer.writeBits(2, 2);
      if (allocIdx[1][sb] > 0) writer.writeBits(2, 2);
    }

    // 3. Write 6-bit Scale Factors
    for (let sb = 0; sb < sblimit; sb++) {
      if (allocIdx[0][sb] > 0) writer.writeBits(scfL[sb][0], 6);
      if (allocIdx[1][sb] > 0) writer.writeBits(scfR[sb][0], 6);
    }

    // 4. Write Quantized Subband Samples (12 granules of 3 samples per subband)
    for (let gr = 0; gr < 12; gr++) {
      for (let sb = 0; sb < sblimit; sb++) {
        for (let ch = 0; ch < 2; ch++) {
          const idx = allocIdx[ch][sb];
          if (idx === 0) continue;
          const def = getMp2QuantDef(sb, idx);
          const scf = MP2_SCALEFACTORS[ch === 0 ? scfL[sb][0] : scfR[sb][0]] || 1.0;
          const sbBuf = ch === 0 ? subbandsL[sb] : subbandsR[sb];

          const codes = [0, 0, 0];
          const halfSteps = (def.steps - 1) / 2;
          for (let s = 0; s < 3; s++) {
            const norm = Math.max(-0.9999, Math.min(0.9999, sbBuf[gr * 3 + s] / scf));
            // ISO 11172-3 symmetric quantizer code (MSB inverted sign offset)
            let q = Math.round((norm + 1.0) * halfSteps);
            q = Math.max(0, Math.min(def.steps - 1, q));
            codes[s] = q;
          }

          if (def.grouped) {
            const packed = codes[0] + def.steps * (codes[1] + def.steps * codes[2]);
            writer.writeBits(packed, def.bits);
          } else {
            const bitsPerSample = def.bits / 3;
            const msbMask = 1 << (bitsPerSample - 1);
            for (let s = 0; s < 3; s++) {
              // Invert MSB for two's-complement-like coding per ISO Layer II
              writer.writeBits(codes[s] ^ msbMask, bitsPerSample);
            }
          }
        }
      }
    }

    mp2Chunks.push(writer.buffer);

    if (frame % 25 === 0) {
      onProgress?.(Math.min(99, Math.round((frame / Math.max(1, totalFrames)) * 100)));
      await yieldToMain();
    }
  }

  onProgress?.(100);
  return new Blob(mp2Chunks, { type: 'audio/mpeg' });
}

/**
 * High-level helper to export the current song snapshot directly to WAV, MP3, or MP2
 */
export async function exportSnapshotToAudioFile(
  snapshot: OfflineSongSnapshot,
  format: AudioExportFormat,
  onProgress?: (pct: number, stage: string) => void,
  signal?: AbortSignal
): Promise<{ blob: Blob; filename: string }> {
  const safeName = (snapshot.trackTitle || 'Aria48_Track').replace(/[^a-zA-Z0-9_-]/g, '_');
  const rendered = await renderSongSnapshotOffline(
    snapshot,
    0,
    (pct, stage) => onProgress?.(Math.round(pct * 0.6), stage),
    signal
  );

  let blob: Blob;
  if (format === 'wav') {
    onProgress?.(85, 'Packing 16-bit RIFF WAV');
    blob = encodeWavBlob(rendered.left, rendered.right, rendered.sampleRate);
    onProgress?.(100, 'WAV complete');
  } else if (format === 'mp3') {
    blob = await encodeMp3Blob(
      rendered.left,
      rendered.right,
      rendered.sampleRate,
      192,
      (pct) => onProgress?.(60 + Math.round(pct * 0.4), 'Encoding MP3 (192 kbps)'),
      signal
    );
  } else {
    blob = await encodeMp2Blob(
      rendered.left,
      rendered.right,
      rendered.sampleRate,
      (pct) => onProgress?.(60 + Math.round(pct * 0.4), 'Encoding MPEG-1 Layer II (.mp2)'),
      signal
    );
  }

  const filename = `${safeName}_${Date.now()}.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  return { blob, filename };
}
