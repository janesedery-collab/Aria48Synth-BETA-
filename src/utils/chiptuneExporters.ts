/**
 * chiptuneExporters.ts
 * Real Binary Chiptune & Tracker Exporters:
 * - ProTracker MOD (.mod) — M.K. / 8CHN / 16CH / 32CH with octave-safe Amiga periods & 8-bit signed PCM
 * - FastTracker II XM (.xm) — Linear frequency table, delta-encoded 16-bit PCM samples, packed pattern data
 * - ScreamTracker 3 S3M (.s3m) — Parapointer layout, unsigned 8-bit SCRS PCM samples, packed rows
 * - Standard MIDI (.mid) — Format 0 SMF with proper Note On / Note Off tracking & Program Changes
 * - Tracker JSON (.json) — Structured Aria48 pattern & channel matrix
 */

import { Channel } from '../types';
import { getGmProgramForPreset, getRegisteredInstruments } from './soundFontEngine';

// Period lookup for ProTracker MOD (octaves 1..5)
const MOD_PERIOD_TABLE: { [note: string]: number } = {
  "C-1": 1712, "C#1": 1616, "D-1": 1525, "D#1": 1440, "E-1": 1357, "F-1": 1281, "F#1": 1209, "G-1": 1141, "G#1": 1077, "A-1": 1017, "A#1": 961, "B-1": 907,
  "C-2": 856,  "C#2": 808,  "D-2": 762,  "D#2": 720,  "E-2": 678,  "F-2": 640,  "F#2": 604,  "G-2": 570,  "G#2": 538,  "A-2": 508,  "A#2": 480,  "B-2": 453,
  "C-3": 428,  "C#3": 404,  "D-3": 381,  "D#3": 360,  "E-3": 339,  "F-3": 320,  "F#3": 302,  "G-3": 285,  "G#3": 269,  "A-3": 254,  "A#3": 240,  "B-3": 226,
  "C-4": 214,  "C#4": 202,  "D-4": 190,  "D#4": 180,  "E-4": 170,  "F-4": 160,  "F#4": 151,  "G-4": 143,  "G#4": 135,  "A-4": 127,  "A#4": 120,  "B-4": 113,
  "C-5": 107,  "C#5": 101,  "D-5": 95,   "D#5": 90,   "E-5": 85,   "F-5": 80,   "F#5": 75,   "G-5": 71,   "G#5": 67,   "A-5": 63,   "A#5": 60,   "B-5": 56
};

const NOTE_NAMES_SHARP = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
const NOTE_TO_SEMITONE: Record<string, number> = {
  C: 0, 'C#': 1, DB: 1,
  D: 2, 'D#': 3, EB: 3,
  E: 4,
  F: 5, 'F#': 6, GB: 6,
  G: 7, 'G#': 8, AB: 8,
  A: 9, 'A#': 10, BB: 10,
  B: 11
};

function writeAscii(u8: Uint8Array, offset: number, str: string, fixedLen?: number, padByte = 0): number {
  const clean = (str || '').replace(/[^\x20-\x7E]/g, ' ');
  if (fixedLen !== undefined) {
    for (let i = 0; i < fixedLen; i++) {
      u8[offset + i] = i < clean.length ? clean.charCodeAt(i) & 0x7F : padByte;
    }
    return offset + fixedLen;
  }
  for (let i = 0; i < clean.length; i++) {
    u8[offset + i] = clean.charCodeAt(i) & 0x7F;
  }
  return offset + clean.length;
}

function sanitizeFilename(title: string): string {
  const cleaned = (title || 'Aria48_Track')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned || 'Aria48_Track';
}

function parseCellNoteToMidi(noteStr?: string): number | null {
  if (!noteStr) return null;
  const trimmed = noteStr.trim().toUpperCase();
  if (!trimmed || trimmed === '---' || trimmed === '...' || trimmed === '..') return null;
  if (trimmed === '===' || trimmed === 'OFF' || trimmed === '^^^') return -1;

  const match = trimmed.match(/^([A-G][#B]?)-?([0-9])$/);
  if (!match) return null;
  const semi = NOTE_TO_SEMITONE[match[1]];
  const oct = parseInt(match[2], 10);
  if (semi === undefined || isNaN(oct)) return null;
  return Math.max(0, Math.min(127, 12 * (oct + 1) + semi));
}

function midiToModPeriod(midi: number): number {
  let m = midi;
  while (m < 24) m += 12; // Clamp below C-1 up by octaves
  while (m > 83) m -= 12; // Clamp above B-5 down by octaves
  const oct = Math.floor(m / 12) - 1;
  const semi = m % 12;
  const key = `${NOTE_NAMES_SHARP[semi]}${oct}`;
  return MOD_PERIOD_TABLE[key] || 214;
}

function parseCellVol64(volStr?: string): number | null {
  if (!volStr || volStr === '..' || volStr === '--') return null;
  const parsed = parseInt(volStr, 16);
  if (isNaN(parsed)) return null;
  if (parsed <= 64) return Math.max(0, parsed);
  return Math.max(0, Math.min(64, Math.round((parsed / 127) * 64)));
}

function parseCellInstIndex(instStr?: string, maxInst = 31): number {
  if (!instStr || instStr === '..' || instStr === '--') return 0;
  const parsed = parseInt(instStr, 16);
  if (isNaN(parsed) || parsed <= 0) return 0;
  return ((parsed - 1) % maxInst) + 1;
}

function detectHighestUsedChannel(songPatterns: any[][], channels: Channel[]): number {
  let maxCh = 0;
  for (const pat of songPatterns) {
    if (!Array.isArray(pat)) continue;
    for (const row of pat) {
      if (!row || typeof row !== 'object') continue;
      for (const [k, cell] of Object.entries(row)) {
        const chId = parseInt(k, 10);
        if (isNaN(chId) || chId < 1 || chId > 48) continue;
        const c = cell as { note?: string; inst?: string; vol?: string } | undefined;
        if (c && ((c.note && c.note !== '---') || (c.inst && c.inst !== '..') || (c.vol && c.vol !== '..'))) {
          if (chId > maxCh) maxCh = chId;
        }
      }
    }
  }
  if (maxCh === 0 && Array.isArray(channels)) {
    for (const ch of channels) {
      if (ch.enabled && ch.id > maxCh) maxCh = ch.id;
    }
  }
  return Math.max(4, maxCh || 4);
}

interface SynthSampleEntry {
  name: string;
  pcm16: Int16Array; // Centered at 0, length even, tuned so 1 cycle matches C-4 @ 8363 Hz
  pcm8: Int8Array;   // Signed 8-bit PCM for MOD/S3M
  loopStart: number;
  loopLength: number;
  volume: number;
}

function buildTrackerSampleBank(count = 31): SynthSampleEntry[] {
  let registeredInsts: Array<{ name?: string; audioBuffer?: AudioBuffer }> = [];
  try {
    registeredInsts = getRegisteredInstruments();
  } catch {
    registeredInsts = [];
  }

  const samples: SynthSampleEntry[] = [];
  for (let i = 0; i < count; i++) {
    const inst = registeredInsts.length > 0 ? registeredInsts[i % registeredInsts.length] : undefined;

    if (inst && inst.audioBuffer && typeof inst.audioBuffer.getChannelData === 'function') {
      try {
        const data = inst.audioBuffer.getChannelData(0);
        const targetRate = 8363;
        const srcRate = inst.audioBuffer.sampleRate || 44100;
        const ratio = srcRate / targetRate;
        const outLenRaw = Math.min(32768, Math.max(64, Math.floor(data.length / ratio)));
        const outLen = outLenRaw - (outLenRaw % 2);
        const pcm16 = new Int16Array(outLen);
        const pcm8 = new Int8Array(outLen);
        for (let j = 0; j < outLen; j++) {
          const srcIdx = Math.min(data.length - 1, Math.floor(j * ratio));
          const s = Math.max(-1, Math.min(1, data[srcIdx] || 0));
          pcm16[j] = Math.round(s * 32700);
          pcm8[j] = Math.max(-128, Math.min(127, Math.round(s * 127)));
        }
        samples.push({
          name: (inst.name || `Inst_${i + 1}`).slice(0, 22),
          pcm16,
          pcm8,
          loopStart: 0,
          loopLength: 0,
          volume: 64
        });
        continue;
      } catch {
        // Fallback to waveform synth below
      }
    }

    // Synthesize clean retro chiptune PCM tuned accurately for C-4 @ 8363 Hz (C4 = 261.626 Hz -> ~31.965 samples/cycle)
    const sampleRate = 8363;
    const baseFreq = 261.625565;
    const pcmLen = i === 9 ? 1024 : 2048; // Percussion vs melodic
    const pcm16 = new Int16Array(pcmLen);
    const pcm8 = new Int8Array(pcmLen);
    const waveType = i % 4; // 0: pulse, 1: saw, 2: triangle/sine mix, 3: bright FM

    for (let j = 0; j < pcmLen; j++) {
      const t = j / sampleRate;
      const phase = (t * baseFreq) % 1;
      const decay = Math.exp(-t * 5.2);
      let raw = 0;
      if (i === 9) {
        // Crisp retro snare/noise burst
        const noise = Math.sin(j * 12.9898) * 43758.5453;
        const frac = noise - Math.floor(noise);
        raw = (frac * 2 - 1) * Math.exp(-t * 18);
      } else if (waveType === 0) {
        // Warm 25% pulse wave
        raw = (phase < 0.25 ? 0.8 : -0.8) * decay;
      } else if (waveType === 1) {
        // Rich sawtooth
        raw = ((1 - 2 * phase) * 0.78) * decay;
      } else if (waveType === 2) {
        // Pure chiptune triangle
        raw = ((phase < 0.5 ? (4 * phase - 1) : (3 - 4 * phase)) * 0.88) * decay;
      } else {
        // 2-op FM bell/pluck
        const mod = Math.sin(2 * Math.PI * baseFreq * 2 * t) * Math.exp(-t * 9) * 1.4;
        raw = Math.sin(2 * Math.PI * baseFreq * t + mod) * 0.85 * decay;
      }
      pcm16[j] = Math.max(-32767, Math.min(32767, Math.round(raw * 29000)));
      pcm8[j] = Math.max(-128, Math.min(127, Math.round(raw * 116)));
    }

    samples.push({
      name: `Aria48_Sample_${(i + 1).toString().padStart(2, '0')}`,
      pcm16,
      pcm8,
      loopStart: 0,
      loopLength: 0,
      volume: 64
    });
  }
  return samples;
}

function normalizePatterns(songPatterns: any[][]): any[][] {
  if (!Array.isArray(songPatterns) || songPatterns.length === 0) {
    return [Array.from({ length: 64 }, () => ({}))];
  }
  return songPatterns.map((p) => (Array.isArray(p) ? p : []));
}

/**
 * Resolve row cell mapped into target channel count [0 .. channelsCount - 1]
 * Folding any overflow channels gently so high-channel tracker/MIDI songs don't lose voices.
 */
function resolveRowChannels(rowData: any, channelsCount: number): Array<any | null> {
  const mapped = new Array(channelsCount).fill(null);
  if (!rowData || typeof rowData !== 'object') return mapped;

  for (let ch = 1; ch <= channelsCount; ch++) {
    if (rowData[ch]) {
      mapped[ch - 1] = rowData[ch];
    }
  }
  // Fold channels beyond channelsCount if any active note sits there
  for (const [k, cell] of Object.entries(rowData)) {
    const chId = parseInt(k, 10);
    if (isNaN(chId) || chId <= channelsCount || chId > 48) continue;
    const c = cell as any;
    if (c && c.note && c.note !== '---') {
      const targetIdx = (chId - 1) % channelsCount;
      if (!mapped[targetIdx] || !mapped[targetIdx].note || mapped[targetIdx].note === '---') {
        mapped[targetIdx] = c;
      }
    }
  }
  return mapped;
}

/**
 * Generate Authentic Commodore Amiga ProTracker (.mod) Module Binary
 * Supports 4ch ("M.K."), 8ch ("8CHN"), 16ch ("16CH"), and 32ch ("32CH")
 */
export function generateProTrackerModBuffer(
  songPatterns: any[][],
  title = "Aria48 Tracker Track",
  bpm = 125,
  channels: Channel[] = []
): ArrayBuffer {
  const patterns = normalizePatterns(songPatterns);
  const highestCh = detectHighestUsedChannel(patterns, channels);
  let channelsCount = 4;
  let signature = "M.K.";
  if (highestCh > 16) {
    channelsCount = 32;
    signature = "32CH";
  } else if (highestCh > 8) {
    channelsCount = 16;
    signature = "16CH";
  } else if (highestCh > 4) {
    channelsCount = 8;
    signature = "8CHN";
  }

  const numPatterns = Math.min(128, Math.max(1, patterns.length));
  const modSamples = buildTrackerSampleBank(31);

  let totalSampleBytes = 0;
  for (const s of modSamples) {
    totalSampleBytes += s.pcm8.byteLength;
  }

  const headerLength = 1084;
  const patternBytes = 64 * channelsCount * 4;
  const totalModBytes = headerLength + numPatterns * patternBytes + totalSampleBytes;

  const buffer = new ArrayBuffer(totalModBytes);
  const u8 = new Uint8Array(buffer);

  // 1. Song Title (20 bytes)
  writeAscii(u8, 0, title, 20, 0);

  // 2. 31 Sample Headers (30 bytes each)
  for (let i = 0; i < 31; i++) {
    const smp = modSamples[i];
    const off = 20 + i * 30;
    const lengthWords = Math.floor(smp.pcm8.byteLength / 2);
    writeAscii(u8, off, smp.name, 22, 0);
    u8[off + 22] = (lengthWords >> 8) & 0xFF;
    u8[off + 23] = lengthWords & 0xFF;
    u8[off + 24] = 0; // Finetune 0
    u8[off + 25] = smp.volume & 0x7F;
    u8[off + 26] = 0; // Loop start high
    u8[off + 27] = 0; // Loop start low
    u8[off + 28] = 0; // Loop length high (1 word = no loop in ProTracker)
    u8[off + 29] = 1;
  }

  // 3. Song Length & Restart Position
  u8[950] = numPatterns;
  u8[951] = 127;

  // 4. Order List (128 bytes)
  for (let i = 0; i < 128; i++) {
    u8[952 + i] = i < numPatterns ? i : 0;
  }

  // 5. Signature
  writeAscii(u8, 1080, signature, 4, 0);

  // 6. Pattern Data (64 rows * channelsCount * 4 bytes)
  const clampedBpm = Math.max(32, Math.min(255, Math.round(bpm || 125)));
  let pOffset = 1084;

  for (let pIdx = 0; pIdx < numPatterns; pIdx++) {
    const pat = patterns[pIdx] || [];
    for (let row = 0; row < 64; row++) {
      const rowCells = resolveRowChannels(pat[row], channelsCount);
      for (let ch = 0; ch < channelsCount; ch++) {
        const cell = rowCells[ch] || {};
        const midiNote = parseCellNoteToMidi(cell.note);
        const isNoteOff = midiNote === -1;
        const period = midiNote !== null && midiNote >= 0 ? midiToModPeriod(midiNote) : 0;
        const parsedInst = parseCellInstIndex(cell.inst, 31);
        const fallbackInst = (ch === 9 ? 10 : ((ch % 16) + 1));
        const instNum = period > 0 ? (parsedInst || fallbackInst) : parsedInst;

        let effect = 0;
        let effectParam = 0;

        if (isNoteOff) {
          effect = 0x0C;
          effectParam = 0;
        } else if (cell.delay && cell.delay !== "000" && cell.delay !== "...") {
          const delayVal = parseInt(cell.delay, 10);
          if (!isNaN(delayVal) && delayVal > 0) {
            effect = 0x09;
            effectParam = Math.min(255, delayVal);
          }
        } else {
          const vol64 = parseCellVol64(cell.vol);
          if (vol64 !== null && period > 0) {
            effect = 0x0C;
            effectParam = vol64;
          }
        }

        // Stamp BPM tempo on Pattern 0 Row 0 Ch 0 if no other effect occupies it
        if (pIdx === 0 && row === 0 && ch === 0 && effect === 0) {
          effect = 0x0F;
          effectParam = clampedBpm;
        }

        const b0 = ((instNum & 0x10) ? 0x10 : 0) | ((period >> 8) & 0x0F);
        const b1 = period & 0xFF;
        const b2 = ((instNum & 0x0F) << 4) | (effect & 0x0F);
        const b3 = effectParam & 0xFF;

        u8[pOffset++] = b0;
        u8[pOffset++] = b1;
        u8[pOffset++] = b2;
        u8[pOffset++] = b3;
      }
    }
  }

  // 7. Append 8-bit Signed PCM Sample Data
  for (let i = 0; i < 31; i++) {
    const pcm = modSamples[i].pcm8;
    u8.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), pOffset);
    pOffset += pcm.byteLength;
  }

  return buffer;
}

/**
 * Generate Authentic FastTracker II Extended Module (.xm) Binary
 * Supports up to 32 channels, linear frequency table, packed XM patterns,
 * and 16-bit delta-encoded PCM samples.
 */
export function generateFastTrackerXmBuffer(
  songPatterns: any[][],
  title = "Aria48 XM Track",
  bpm = 125,
  channels: Channel[] = []
): ArrayBuffer {
  const patterns = normalizePatterns(songPatterns);
  const highestCh = detectHighestUsedChannel(patterns, channels);
  // XM requires an even number of channels (2..32)
  const channelsCount = Math.max(4, Math.min(32, highestCh + (highestCh % 2)));
  const numPatterns = Math.min(256, Math.max(1, patterns.length));
  const numInstruments = 16;
  const clampedBpm = Math.max(32, Math.min(255, Math.round(bpm || 125)));
  const sampleBank = buildTrackerSampleBank(numInstruments);

  // Build XM header (336 bytes)
  const headerBytes = new Uint8Array(336);
  const headerDv = new DataView(headerBytes.buffer);
  writeAscii(headerBytes, 0, "Extended Module: ", 17, 32);
  writeAscii(headerBytes, 17, title, 20, 32);
  headerBytes[37] = 0x1A;
  writeAscii(headerBytes, 38, "Aria48 Tracker v2.4 ", 20, 32);
  headerDv.setUint16(58, 0x0104, true); // Version 1.04
  headerDv.setUint32(60, 276, true);    // Header size from offset 60
  headerDv.setUint16(64, numPatterns, true); // Song length
  headerDv.setUint16(66, 0, true);           // Restart position
  headerDv.setUint16(68, channelsCount, true);
  headerDv.setUint16(70, numPatterns, true);
  headerDv.setUint16(72, numInstruments, true);
  headerDv.setUint16(74, 1, true);           // Linear frequency table
  headerDv.setUint16(76, 6, true);           // Default speed (ticks/row)
  headerDv.setUint16(78, clampedBpm, true);  // Default BPM
  for (let i = 0; i < 256; i++) {
    headerBytes[80 + i] = i < numPatterns ? i : 0;
  }

  // Build Pattern blocks
  const patternBlocks: Uint8Array[] = [];
  for (let pIdx = 0; pIdx < numPatterns; pIdx++) {
    const pat = patterns[pIdx] || [];
    const packedRows: number[] = [];

    for (let row = 0; row < 64; row++) {
      const rowCells = resolveRowChannels(pat[row], channelsCount);
      for (let ch = 0; ch < channelsCount; ch++) {
        const cell = rowCells[ch] || {};
        const midiNote = parseCellNoteToMidi(cell.note);
        let xmNote = 0;
        if (midiNote === -1) {
          xmNote = 97; // Key Off
        } else if (midiNote !== null && midiNote >= 0) {
          // XM note 1 = C-0 (MIDI 12), 49 = C-4 (MIDI 60)
          xmNote = Math.max(1, Math.min(96, midiNote - 11));
        }

        const parsedInst = parseCellInstIndex(cell.inst, numInstruments);
        const instNum = xmNote > 0 && xmNote <= 96 ? (parsedInst || ((ch % numInstruments) + 1)) : parsedInst;
        const vol64 = parseCellVol64(cell.vol);
        const xmVol = vol64 !== null ? 0x10 + vol64 : 0;
        const fx = 0;
        const fxParam = 0;

        if (xmNote === 0 && instNum === 0 && xmVol === 0 && fx === 0 && fxParam === 0) {
          packedRows.push(0x80); // Empty cell compressed to 1 byte
        } else {
          let flag = 0x80;
          if (xmNote !== 0) flag |= 0x01;
          if (instNum !== 0) flag |= 0x02;
          if (xmVol !== 0) flag |= 0x04;
          if (fx !== 0) flag |= 0x08;
          if (fxParam !== 0) flag |= 0x10;
          packedRows.push(flag);
          if (flag & 0x01) packedRows.push(xmNote & 0xFF);
          if (flag & 0x02) packedRows.push(instNum & 0xFF);
          if (flag & 0x04) packedRows.push(xmVol & 0xFF);
          if (flag & 0x08) packedRows.push(fx & 0xFF);
          if (flag & 0x10) packedRows.push(fxParam & 0xFF);
        }
      }
    }

    const patBlock = new Uint8Array(9 + packedRows.length);
    const patDv = new DataView(patBlock.buffer);
    patDv.setUint32(0, 9, true); // Pattern header length
    patBlock[4] = 0;             // Packing type 0
    patDv.setUint16(5, 64, true); // 64 rows
    patDv.setUint16(7, packedRows.length, true);
    patBlock.set(packedRows, 9);
    patternBlocks.push(patBlock);
  }

  // Build Instrument + Sample blocks
  const instBlocks: Uint8Array[] = [];
  for (let i = 0; i < numInstruments; i++) {
    const smp = sampleBank[i];
    const pcm16 = smp.pcm16;
    const sampleBytesLen = pcm16.byteLength;

    // 263-byte instrument header + 40-byte sample header + delta-encoded 16-bit PCM
    const block = new Uint8Array(263 + 40 + sampleBytesLen);
    const dv = new DataView(block.buffer);

    dv.setUint32(0, 263, true); // Instrument header size
    writeAscii(block, 4, smp.name, 22, 0);
    block[26] = 0;              // Type 0
    dv.setUint16(27, 1, true);  // 1 sample
    dv.setUint32(29, 40, true); // Sample header size (40)
    // Sample keymap (96 bytes at 33..128) already 0 (sample 0)
    // Volume/panning envelopes & fadeout
    dv.setUint16(239, 0x0800, true); // Volume fadeout

    // Sample header at offset 263
    const sOff = 263;
    dv.setUint32(sOff + 0, sampleBytesLen, true); // Length in bytes
    dv.setUint32(sOff + 4, 0, true);              // Loop start
    dv.setUint32(sOff + 8, 0, true);              // Loop length
    block[sOff + 12] = smp.volume & 0x7F;         // Volume (0..64)
    block[sOff + 13] = 0;                         // Finetune (signed int8)
    block[sOff + 14] = 0x10;                      // Type: bit 4 = 16-bit sample, no loop
    block[sOff + 15] = 128;                       // Center panning
    block[sOff + 16] = 0;                         // Relative note 0 (C-4 @ 8363 Hz)
    block[sOff + 17] = 0;                         // Reserved
    writeAscii(block, sOff + 18, smp.name, 22, 0);

    // Write delta-encoded signed 16-bit LE PCM samples
    let prev = 0;
    const pcmOffset = 263 + 40;
    for (let j = 0; j < pcm16.length; j++) {
      const curr = pcm16[j];
      const delta = (curr - prev) & 0xFFFF;
      prev = curr;
      dv.setInt16(pcmOffset + j * 2, delta > 32767 ? delta - 65536 : delta, true);
    }

    instBlocks.push(block);
  }

  // Assemble complete XM binary
  let totalLen = headerBytes.length;
  for (const pb of patternBlocks) totalLen += pb.length;
  for (const ib of instBlocks) totalLen += ib.length;

  const out = new Uint8Array(totalLen);
  let cursor = 0;
  out.set(headerBytes, cursor);
  cursor += headerBytes.length;
  for (const pb of patternBlocks) {
    out.set(pb, cursor);
    cursor += pb.length;
  }
  for (const ib of instBlocks) {
    out.set(ib, cursor);
    cursor += ib.length;
  }

  return out.buffer;
}

/**
 * Generate Authentic ScreamTracker 3 (.s3m) Module Binary
 * Uses 16-byte paragraph alignment, SCRM/SCRS signatures, unsigned 8-bit PCM, and packed patterns.
 */
export function generateScreamTrackerS3mBuffer(
  songPatterns: any[][],
  title = "Aria48 S3M Track",
  bpm = 125,
  channels: Channel[] = []
): ArrayBuffer {
  const patterns = normalizePatterns(songPatterns);
  const highestCh = detectHighestUsedChannel(patterns, channels);
  const channelsCount = Math.max(4, Math.min(16, highestCh));
  const numPatterns = Math.min(100, Math.max(1, patterns.length));
  // ST3 specification requires ordNum to be even
  const ordNum = numPatterns + (numPatterns % 2);
  const insNum = 16;
  const clampedBpm = Math.max(32, Math.min(255, Math.round(bpm || 125)));
  const sampleBank = buildTrackerSampleBank(insNum);

  const align16 = (n: number) => (n + 15) & ~15;

  // Build packed patterns first so we know exact lengths
  const packedPatterns: Uint8Array[] = [];
  for (let pIdx = 0; pIdx < numPatterns; pIdx++) {
    const pat = patterns[pIdx] || [];
    const bytes: number[] = [];

    for (let row = 0; row < 64; row++) {
      const rowCells = resolveRowChannels(pat[row], channelsCount);
      for (let ch = 0; ch < channelsCount; ch++) {
        const cell = rowCells[ch] || {};
        const midiNote = parseCellNoteToMidi(cell.note);
        let s3mNote: number | null = null;
        if (midiNote === -1) {
          s3mNote = 254; // Note cut
        } else if (midiNote !== null && midiNote >= 0) {
          const clampedMidi = Math.max(12, Math.min(107, midiNote));
          const oct = Math.floor(clampedMidi / 12) - 1;
          const semi = clampedMidi % 12;
          s3mNote = ((oct & 0x0F) << 4) | (semi & 0x0F);
        }

        const parsedInst = parseCellInstIndex(cell.inst, insNum);
        const instNum = s3mNote !== null && s3mNote !== 254 ? (parsedInst || ((ch % insNum) + 1)) : 0;
        const vol64 = parseCellVol64(cell.vol);
        const hasNoteOrInst = s3mNote !== null;
        const hasVol = vol64 !== null && s3mNote !== 254;

        let cmd = 0;
        let info = 0;
        if (pIdx === 0 && row === 0 && ch === 0) {
          cmd = 20; // 'T' - Set Tempo (BPM)
          info = clampedBpm;
        }
        const hasCmd = cmd !== 0;

        if (hasNoteOrInst || hasVol || hasCmd) {
          let flags = ch & 0x1F;
          if (hasNoteOrInst) flags |= 0x20;
          if (hasVol) flags |= 0x40;
          if (hasCmd) flags |= 0x80;
          bytes.push(flags);
          if (hasNoteOrInst) {
            bytes.push(s3mNote! & 0xFF);
            bytes.push(instNum & 0xFF);
          }
          if (hasVol) {
            bytes.push(Math.max(0, Math.min(64, vol64!)));
          }
          if (hasCmd) {
            bytes.push(cmd & 0xFF);
            bytes.push(info & 0xFF);
          }
        }
      }
      bytes.push(0x00); // End of row
    }

    const totalPatLen = 2 + bytes.length;
    const patBuf = new Uint8Array(align16(totalPatLen));
    const dv = new DataView(patBuf.buffer);
    dv.setUint16(0, totalPatLen, true);
    patBuf.set(bytes, 2);
    packedPatterns.push(patBuf);
  }

  // Calculate paragraph-aligned offsets:
  // Header (96 bytes) + OrdNum (ordNum bytes) + PtrTable ((insNum + numPatterns) * 2 bytes)
  const ptrTableOffset = 96 + ordNum;
  const headerTotalRaw = ptrTableOffset + (insNum + numPatterns) * 2;
  let cursor = align16(headerTotalRaw);

  const instOffsets: number[] = [];
  for (let i = 0; i < insNum; i++) {
    instOffsets.push(cursor);
    cursor += align16(80);
  }

  const patternOffsets: number[] = [];
  for (let p = 0; p < numPatterns; p++) {
    patternOffsets.push(cursor);
    cursor += packedPatterns[p].length;
  }

  const sampleDataOffsets: number[] = [];
  for (let i = 0; i < insNum; i++) {
    sampleDataOffsets.push(cursor);
    cursor += align16(sampleBank[i].pcm8.length);
  }

  const buffer = new ArrayBuffer(cursor);
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  // 1. S3M File Header (96 bytes)
  writeAscii(u8, 0, title, 28, 0);
  u8[28] = 0x1A;
  u8[29] = 16; // ST3 module type
  dv.setUint16(30, 0, true);
  dv.setUint16(32, ordNum, true);
  dv.setUint16(34, insNum, true);
  dv.setUint16(36, numPatterns, true);
  dv.setUint16(38, 0, true);      // Flags
  dv.setUint16(40, 0x1320, true); // Cwt/v ST3.20
  dv.setUint16(42, 2, true);      // Ffi = 2 (unsigned 8-bit PCM)
  writeAscii(u8, 44, "SCRM", 4, 0);
  u8[48] = 64;                    // Global volume
  u8[49] = 6;                     // Initial speed
  u8[50] = clampedBpm;            // Initial tempo
  u8[51] = 0xB0;                  // Master volume: stereo + 48
  u8[52] = 16;                    // Ultra click removal
  u8[53] = 0;                     // Default pan flag off
  // Channel settings (32 bytes at offset 64): alternate left (0..7) and right (8..15)
  for (let c = 0; c < 32; c++) {
    if (c < channelsCount) {
      u8[64 + c] = (c % 2 === 0) ? (c >> 1) : 8 + (c >> 1);
    } else {
      u8[64 + c] = 255;
    }
  }

  // 2. Order List
  for (let i = 0; i < ordNum; i++) {
    u8[96 + i] = i < numPatterns ? i : 255;
  }

  // 3. Parapointers for Instruments and Patterns
  for (let i = 0; i < insNum; i++) {
    dv.setUint16(ptrTableOffset + i * 2, instOffsets[i] >> 4, true);
  }
  for (let p = 0; p < numPatterns; p++) {
    dv.setUint16(ptrTableOffset + (insNum + p) * 2, patternOffsets[p] >> 4, true);
  }

  // 4. Write 80-byte SCRS Sample Headers + Unsigned PCM data
  for (let i = 0; i < insNum; i++) {
    const smp = sampleBank[i];
    const off = instOffsets[i];
    const dataOff = sampleDataOffsets[i];
    const memPara = dataOff >> 4;

    u8[off + 0] = 1; // Type 1 = PCM sample
    writeAscii(u8, off + 1, `SMP${(i + 1).toString().padStart(2, '0')}.WAV`, 12, 0);
    u8[off + 13] = (memPara >> 16) & 0xFF;
    dv.setUint16(off + 14, memPara & 0xFFFF, true);
    dv.setUint32(off + 16, smp.pcm8.length, true); // Length
    dv.setUint32(off + 20, 0, true);               // Loop begin
    dv.setUint32(off + 24, 0, true);               // Loop end
    u8[off + 28] = smp.volume & 0x7F;              // Default volume
    u8[off + 29] = 0;                              // Reserved
    u8[off + 30] = 0;                              // Pack = uncompressed
    u8[off + 31] = 0;                              // Flags (no loop, 8-bit mono)
    dv.setUint32(off + 32, 8363, true);            // C2Spd (Hz for middle C)
    writeAscii(u8, off + 48, smp.name, 28, 0);
    writeAscii(u8, off + 76, "SCRS", 4, 0);

    // Write unsigned 8-bit PCM (signed + 128)
    for (let j = 0; j < smp.pcm8.length; j++) {
      u8[dataOff + j] = (smp.pcm8[j] + 128) & 0xFF;
    }
  }

  // 5. Write Pattern Blocks
  for (let p = 0; p < numPatterns; p++) {
    u8.set(packedPatterns[p], patternOffsets[p]);
  }

  return buffer;
}

function pushVlq(out: number[], value: number) {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7F];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7F) | 0x80);
    v >>= 7;
  }
  out.push(...bytes);
}

/**
 * Generate Standard MIDI (.mid) Format 0 Binary File
 * Includes proper Note On / Note Off pairing, Program Changes, and multi-byte VLQ deltas.
 */
export function generateMidiFileBuffer(
  songPatterns: any[][],
  bpm = 120,
  title = "Aria48 MIDI Track",
  channels: Channel[] = []
): ArrayBuffer {
  const patterns = normalizePatterns(songPatterns);
  const ppq = 480;
  const tracksBytes: number[] = [];

  const titleBytes = Array.from(title.slice(0, 64)).map(c => c.charCodeAt(0) & 0x7F);
  tracksBytes.push(0x00, 0xFF, 0x03, titleBytes.length, ...titleBytes);

  const clampedBpm = Math.max(20, Math.min(300, bpm || 120));
  const tempoMicros = Math.round(60000000 / clampedBpm);
  tracksBytes.push(
    0x00, 0xFF, 0x51, 0x03,
    (tempoMicros >> 16) & 0xFF,
    (tempoMicros >> 8) & 0xFF,
    tempoMicros & 0xFF
  );

  // Set initial Program Changes for channels 0..15 (skipping drum channel 9)
  for (let ch = 0; ch < 16; ch++) {
    if (ch === 9) continue;
    const chObj = channels[ch];
    const prog = chObj?.soundFontPreset ? getGmProgramForPreset(chObj.soundFontPreset) : (ch === 0 ? 0 : ch === 1 ? 4 : ch === 2 ? 48 : 80);
    tracksBytes.push(0x00, 0xC0 | ch, Math.max(0, Math.min(127, prog)));
  }

  const ticksPerRow = Math.round(ppq / 4); // 16th-note step
  let currentDelta = 0;
  const activeNotes: Record<number, number | null> = {};

  patterns.forEach(pat => {
    for (let row = 0; row < 64; row++) {
      const rowCells = resolveRowChannels(pat[row], 16);

      for (let ch = 0; ch < 16; ch++) {
        const cell = rowCells[ch];
        if (!cell) continue;
        const midiNote = parseCellNoteToMidi(cell.note);
        if (midiNote === null) continue;

        const midiCh = ch & 0x0F;
        // Turn off previous sounding note on this channel
        const prev = activeNotes[midiCh];
        if (prev !== undefined && prev !== null) {
          pushVlq(tracksBytes, currentDelta);
          currentDelta = 0;
          tracksBytes.push(0x80 | midiCh, prev, 0);
          activeNotes[midiCh] = null;
        }

        if (midiNote >= 0) {
          const volRaw = cell.vol && cell.vol !== '..' ? parseInt(cell.vol, 16) : 96;
          const velocity = isNaN(volRaw) ? 96 : Math.max(1, Math.min(127, volRaw));
          pushVlq(tracksBytes, currentDelta);
          currentDelta = 0;
          tracksBytes.push(0x90 | midiCh, midiNote, velocity);
          activeNotes[midiCh] = midiNote;
        }
      }

      currentDelta += ticksPerRow;
    }
  });

  // Flush remaining active notes cleanly before End of Track
  for (let ch = 0; ch < 16; ch++) {
    const prev = activeNotes[ch];
    if (prev !== undefined && prev !== null) {
      pushVlq(tracksBytes, currentDelta);
      currentDelta = 0;
      tracksBytes.push(0x80 | ch, prev, 0);
      activeNotes[ch] = null;
    }
  }

  pushVlq(tracksBytes, currentDelta);
  tracksBytes.push(0xFF, 0x2F, 0x00);

  const totalLength = 14 + 8 + tracksBytes.length;
  const buffer = new ArrayBuffer(totalLength);
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);

  writeAscii(u8, 0, "MThd");
  view.setUint32(4, 6, false);
  view.setUint16(8, 0, false); // Format 0
  view.setUint16(10, 1, false); // 1 track
  view.setUint16(12, ppq, false);

  writeAscii(u8, 14, "MTrk");
  view.setUint32(18, tracksBytes.length, false);
  u8.set(tracksBytes, 22);

  return buffer;
}

/**
 * Universal Chiptune & Tracker Exporter Trigger
 */
export function exportChiptuneFile(
  format: 'mod' | 'xm' | 's3m' | 'mid' | 'json',
  songPatterns: any[][],
  title = "Aria48_Track",
  bpm = 125,
  channels: Channel[] = []
): { filename: string; bytes: number } {
  const safeBase = sanitizeFilename(title);
  const patterns = normalizePatterns(songPatterns);
  let blob: Blob;
  const filename = `${safeBase}.${format}`;

  if (format === 'mod') {
    const modBuf = generateProTrackerModBuffer(patterns, title, bpm, channels);
    blob = new Blob([modBuf], { type: 'audio/x-mod' });
  } else if (format === 'xm') {
    const xmBuf = generateFastTrackerXmBuffer(patterns, title, bpm, channels);
    blob = new Blob([xmBuf], { type: 'audio/x-xm' });
  } else if (format === 's3m') {
    const s3mBuf = generateScreamTrackerS3mBuffer(patterns, title, bpm, channels);
    blob = new Blob([s3mBuf], { type: 'audio/x-s3m' });
  } else if (format === 'mid') {
    const midBuf = generateMidiFileBuffer(patterns, bpm, title, channels);
    blob = new Blob([midBuf], { type: 'audio/midi' });
  } else {
    const jsonStr = JSON.stringify({
      title,
      bpm,
      channelsCount: channels.length,
      patternsCount: patterns.length,
      patterns,
      channels
    }, null, 2);
    blob = new Blob([jsonStr], { type: 'application/json' });
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  return { filename, bytes: blob.size };
}
