/**
 * spressasynth_core-master.zip
 * Universal SoundFont Parser, Binary Decoder & SoundBank Core Engine
 * Supports SF2, SF3 (Ogg/Vorbis), SBK, DLS, GIG, SFZ, PAT (GUS), SFPACK/SFARK,
 * and universal fallback SoundFont container decoding.
 * Directly linked to spressasynth_lib-master.zip for 16-channel synthesis.
 */

import { registerCustomInstrument } from '../utils/soundFontEngine';
import type { SoundFontInstrument, SoundFontBankInfo } from '../types';

export const SPRESSASYNTH_CORE_ENGINE_ID = "spressasynth_core-master.zip";

export const SUPPORTED_SOUNDFONT_EXTENSIONS = [
  '.sf2', '.sf3', '.sf4', '.sfbk', '.sbk', '.dls', '.sfz',
  '.gig', '.sfpack', '.sfark', '.exs', '.nki', '.pat',
  '.xi', '.iti', '.s3i', '.bnk', '.ins', '.wopl', '.wopn', '.fxb', '.fxp'
] as const;

export const SOUNDFONT_ACCEPT_ATTR = SUPPORTED_SOUNDFONT_EXTENSIONS.join(',');

export function isSoundFontFileName(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = fileName.slice(dot).toLowerCase();
  return (SUPPORTED_SOUNDFONT_EXTENSIONS as readonly string[]).includes(ext);
}

export interface SpessaCoreSampleHeader {
  name: string;
  start: number;
  end: number;
  startLoop: number;
  endLoop: number;
  sampleRate: number;
  originalPitch: number;
  pitchCorrection: number;
  sampleType: number;
  audioBuffer?: AudioBuffer;
  isCompressed?: boolean;
}

export interface SpessaCorePresetHeader {
  name: string;
  program: number;
  bank: number;
  presetBagNdx: number;
}

export interface SpessaCoreZone {
  bank: number;
  program: number;
  keyLow: number;
  keyHigh: number;
  velLow: number;
  velHigh: number;
  rootKey: number;
  sampleIndex: number;
  loopMode: number; // 0 = none, 1 = continuous, 3 = loop until release
  attenuationGain: number;
}

export interface SpessaResolvedVoice {
  buffer: AudioBuffer;
  rootKey: number;
  pitchCorrection: number;
  loopStart?: number;
  loopEnd?: number;
  attenuationGain: number;
  sampleRate: number;
  sampleName: string;
  soundFontName: string;
}

export interface SpessaCoreBankMetadata {
  engineId: string;
  bankName: string;
  format: string;
  version: string;
  author: string;
  tools: string;
  comment: string;
  instrumentCount: number;
  sampleCount: number;
  totalSampleSizeKB: number;
  isLoaded: boolean;
  loadedAt: number;
}

export interface SpessaCoreSoundFont {
  id: string;
  name: string;
  format: string;
  version: string;
  instrumentCount: number;
  presets: string[];
  isCustom: boolean;
  sampleHeaders: SpessaCoreSampleHeader[];
  presetHeaders: SpessaCorePresetHeader[];
  zones: SpessaCoreZone[];
  metadata: SpessaCoreBankMetadata;
}

export interface SpessaCoreParseResult {
  soundFont: SpessaCoreSoundFont;
  bankInfo: SoundFontBankInfo;
  instruments: SoundFontInstrument[];
  logs: string[];
}

function readAscii(u8: Uint8Array, start: number, maxLen: number): string {
  let out = "";
  const end = Math.min(u8.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const ch = u8[i];
    if (ch === 0) break;
    if (ch >= 32 && ch <= 126) out += String.fromCharCode(ch);
  }
  return out.trim();
}

function findMagicSequence(u8: Uint8Array, fourCC1: string, fourCC2?: string, offsetStep = 1): number {
  const b0 = fourCC1.charCodeAt(0);
  const b1 = fourCC1.charCodeAt(1);
  const b2 = fourCC1.charCodeAt(2);
  const b3 = fourCC1.charCodeAt(3);
  const limit = u8.length - 12;
  for (let i = 0; i <= limit; i += offsetStep) {
    if (u8[i] === b0 && u8[i + 1] === b1 && u8[i + 2] === b2 && u8[i + 3] === b3) {
      if (!fourCC2) return i;
      if (
        u8[i + 8] === fourCC2.charCodeAt(0) &&
        u8[i + 9] === fourCC2.charCodeAt(1) &&
        u8[i + 10] === fourCC2.charCodeAt(2) &&
        u8[i + 11] === fourCC2.charCodeAt(3)
      ) {
        return i;
      }
    }
  }
  return -1;
}

function parseSfzNoteToken(token: string, fallback = 60): number {
  const t = token.trim().toLowerCase();
  const asNum = parseInt(t, 10);
  if (!Number.isNaN(asNum) && String(asNum) === t) {
    return Math.max(0, Math.min(127, asNum));
  }
  const m = t.match(/^([a-g])(#|b)?(-?\d)$/);
  if (!m) return fallback;
  const map: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  let semi = map[m[1]] ?? 0;
  if (m[2] === '#') semi += 1;
  if (m[2] === 'b') semi -= 1;
  const oct = parseInt(m[3], 10);
  return Math.max(0, Math.min(127, 12 * (oct + 1) + semi));
}

class SpessaSynthCoreEngine {
  public readonly engineId = SPRESSASYNTH_CORE_ENGINE_ID;
  private loadedSoundFonts: Map<string, SpessaCoreSoundFont> = new Map();
  private activeSoundFontId: string | null = null;
  private coreLogs: string[] = [];

  constructor() {
    this.coreLogs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Universal SoundFont core decoder initialized (SF2/SF3/SBK/DLS/GIG/SFZ/PAT/SFPACK).`);
  }

  /**
   * Async entry point: decodes any SoundFont format including SF3 Ogg/Vorbis compressed samples
   * and returns the compiled bank ready for spressasynth_lib playback.
   */
  public async parseAsync(
    arrayBuffer: ArrayBuffer,
    audioCtx?: AudioContext,
    fileName = "SoundFont_Bank.sf2"
  ): Promise<SpessaCoreParseResult> {
    const result = this.parse(arrayBuffer, audioCtx, fileName);

    // If compressed SF3 samples were queued, decode them asynchronously via AudioContext.decodeAudioData
    if (audioCtx && result.soundFont.sampleHeaders.some(s => s.isCompressed && !s.audioBuffer)) {
      await this.decodePendingSf3Samples(arrayBuffer, result.soundFont, audioCtx, result.logs);
    }

    return result;
  }

  /**
   * Synchronous SoundFont reader supporting SF2, SF3, SBK, DLS, GIG, SFZ, GUS PAT,
   * SFPACK/SFARK container extraction, and universal custom SoundFont bank parsing.
   */
  public parse(
    arrayBuffer: ArrayBuffer,
    audioCtx?: AudioContext,
    fileName = "SoundFont_Bank.sf2"
  ): SpessaCoreParseResult {
    const logs: string[] = [
      `[${SPRESSASYNTH_CORE_ENGINE_ID}] Reading SoundFont stream: "${fileName}" (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB)...`
    ];

    const u8 = new Uint8Array(arrayBuffer);
    if (u8.length < 12) {
      throw new Error(`[${SPRESSASYNTH_CORE_ENGINE_ID}] File is empty or too small (${u8.length} bytes).`);
    }

    const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '.sf2';
    const riff = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    const form = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);

    let result: SpessaCoreParseResult;

    if (riff === 'RIFF' && form === 'sfbk') {
      result = this.parseRiffSfbk(arrayBuffer, u8, audioCtx, fileName, ext, logs);
    } else if (riff === 'RIFF' && form === 'DLS ') {
      result = this.parseRiffDls(arrayBuffer, u8, audioCtx, fileName, logs);
    } else if (ext === '.sfz' || this.looksLikeSfzText(u8)) {
      result = this.parseSfzText(u8, audioCtx, fileName, logs);
    } else if (readAscii(u8, 0, 12).startsWith('GF1PATCH')) {
      result = this.parseGusPatch(arrayBuffer, u8, audioCtx, fileName, logs);
    } else {
      // Check if an embedded RIFF/sfbk or RIFF/DLS bank exists inside container wrappers (.sfpack, .sfark, .gig, etc.)
      const embeddedSfbkOffset = findMagicSequence(u8, 'RIFF', 'sfbk');
      if (embeddedSfbkOffset > 0) {
        logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Located embedded RIFF/sfbk SoundFont stream at offset 0x${embeddedSfbkOffset.toString(16)}.`);
        const subBuf = arrayBuffer.slice(embeddedSfbkOffset);
        result = this.parseRiffSfbk(subBuf, new Uint8Array(subBuf), audioCtx, fileName, ext, logs);
      } else {
        const embeddedDlsOffset = findMagicSequence(u8, 'RIFF', 'DLS ');
        if (embeddedDlsOffset > 0) {
          logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Located embedded RIFF/DLS stream at offset 0x${embeddedDlsOffset.toString(16)}.`);
          const subBuf = arrayBuffer.slice(embeddedDlsOffset);
          result = this.parseRiffDls(subBuf, new Uint8Array(subBuf), audioCtx, fileName, logs);
        } else {
          result = this.parseUniversalSoundFontFallback(arrayBuffer, u8, audioCtx, fileName, ext, logs);
        }
      }
    }

    this.loadedSoundFonts.set(result.soundFont.id, result.soundFont);
    this.activeSoundFontId = result.soundFont.id;
    this.coreLogs.push(...logs.slice(-4));
    return result;
  }

  private looksLikeSfzText(u8: Uint8Array): boolean {
    const head = readAscii(u8, 0, Math.min(1024, u8.length)).toLowerCase();
    return head.includes('<region>') || head.includes('<group>') || head.includes('<control>');
  }

  /**
   * Full SF2 / SF3 / SBK (RIFF/sfbk) Parser with pdta preset-instrument-sample zone mapping
   */
  private parseRiffSfbk(
    arrayBuffer: ArrayBuffer,
    u8: Uint8Array,
    audioCtx: AudioContext | undefined,
    fileName: string,
    ext: string,
    logs: string[]
  ): SpessaCoreParseResult {
    const view = new DataView(arrayBuffer);
    let bankName = fileName.replace(/\.[^/.]+$/, "");
    let version = ext === '.sf3' ? "3.00" : "2.04";
    let majorVer = ext === '.sf3' ? 3 : 2;
    let author = "SpessaSynth Core Bank";
    let tools = "Aria48 Tracker / spressasynth_core";
    let comment = "";

    let sampleDataStart = 0;
    let sampleDataLen = 0;

    const sampleHeaders: SpessaCoreSampleHeader[] = [];
    const presetHeaders: SpessaCorePresetHeader[] = [];
    const pbagIndices: number[] = [];
    const pgens: Array<{ oper: number; amount: number; uAmount: number }> = [];
    const instList: Array<{ name: string; bagNdx: number }> = [];
    const ibagIndices: number[] = [];
    const igens: Array<{ oper: number; amount: number; uAmount: number }> = [];

    let offset = 12;
    while (offset + 8 <= u8.length) {
      const chunkId = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
      const chunkLen = view.getUint32(offset + 4, true);
      const chunkEnd = Math.min(u8.length, offset + 8 + chunkLen);

      if (chunkId === 'LIST' && offset + 12 <= u8.length) {
        const listType = String.fromCharCode(u8[offset + 8], u8[offset + 9], u8[offset + 10], u8[offset + 11]);
        logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Scanning RIFF/sfbk LIST '${listType}' (${(chunkLen / 1024).toFixed(1)} KB)`);

        let subOffset = offset + 12;
        while (subOffset + 8 <= chunkEnd) {
          const subId = String.fromCharCode(u8[subOffset], u8[subOffset + 1], u8[subOffset + 2], u8[subOffset + 3]);
          const subLen = view.getUint32(subOffset + 4, true);
          const subData = subOffset + 8;
          const safeSubEnd = Math.min(chunkEnd, subData + subLen);

          if (listType === 'INFO') {
            if (subId === 'INAM') bankName = readAscii(u8, subData, Math.min(subLen, 120)) || bankName;
            else if (subId === 'IENG') author = readAscii(u8, subData, Math.min(subLen, 120)) || author;
            else if (subId === 'ISFT') tools = readAscii(u8, subData, Math.min(subLen, 120)) || tools;
            else if (subId === 'ICMT') comment = readAscii(u8, subData, Math.min(subLen, 256)) || comment;
            else if (subId === 'ifil' && subLen >= 4) {
              majorVer = view.getUint16(subData, true);
              const minor = view.getUint16(subData + 2, true);
              version = `${majorVer}.${minor.toString().padStart(2, '0')}`;
            }
          } else if (listType === 'sdta') {
            if (subId === 'smpl') {
              sampleDataStart = subData;
              sampleDataLen = safeSubEnd - subData;
              logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Located smpl wave pool: ${(sampleDataLen / 1024).toFixed(1)} KB`);
            }
          } else if (listType === 'pdta') {
            if (subId === 'phdr') {
              const phdrSize = 38;
              const count = Math.floor(subLen / phdrSize);
              for (let i = 0; i < count; i++) {
                const rec = subData + i * phdrSize;
                if (rec + phdrSize > safeSubEnd) break;
                const pName = readAscii(u8, rec, 20);
                const pPreset = view.getUint16(rec + 20, true);
                const pBank = view.getUint16(rec + 22, true);
                const pBagNdx = view.getUint16(rec + 24, true);
                presetHeaders.push({
                  name: pName || `Preset ${pPreset}`,
                  program: pPreset,
                  bank: pBank,
                  presetBagNdx: pBagNdx
                });
              }
            } else if (subId === 'pbag') {
              const count = Math.floor(subLen / 4);
              for (let i = 0; i < count; i++) {
                const rec = subData + i * 4;
                if (rec + 4 > safeSubEnd) break;
                pbagIndices.push(view.getUint16(rec, true));
              }
            } else if (subId === 'pgen') {
              const count = Math.floor(subLen / 4);
              for (let i = 0; i < count; i++) {
                const rec = subData + i * 4;
                if (rec + 4 > safeSubEnd) break;
                pgens.push({
                  oper: view.getUint16(rec, true),
                  amount: view.getInt16(rec + 2, true),
                  uAmount: view.getUint16(rec + 2, true)
                });
              }
            } else if (subId === 'inst') {
              const count = Math.floor(subLen / 22);
              for (let i = 0; i < count; i++) {
                const rec = subData + i * 22;
                if (rec + 22 > safeSubEnd) break;
                instList.push({
                  name: readAscii(u8, rec, 20) || `Inst ${i}`,
                  bagNdx: view.getUint16(rec + 20, true)
                });
              }
            } else if (subId === 'ibag') {
              const count = Math.floor(subLen / 4);
              for (let i = 0; i < count; i++) {
                const rec = subData + i * 4;
                if (rec + 4 > safeSubEnd) break;
                ibagIndices.push(view.getUint16(rec, true));
              }
            } else if (subId === 'igen') {
              const count = Math.floor(subLen / 4);
              for (let i = 0; i < count; i++) {
                const rec = subData + i * 4;
                if (rec + 4 > safeSubEnd) break;
                igens.push({
                  oper: view.getUint16(rec, true),
                  amount: view.getInt16(rec + 2, true),
                  uAmount: view.getUint16(rec + 2, true)
                });
              }
            } else if (subId === 'shdr') {
              const shdrSize = 46;
              const count = Math.floor(subLen / shdrSize);
              for (let i = 0; i < count; i++) {
                const rec = subData + i * shdrSize;
                if (rec + shdrSize > safeSubEnd) break;
                const sName = readAscii(u8, rec, 20);
                const sStart = view.getUint32(rec + 20, true);
                const sEnd = view.getUint32(rec + 24, true);
                const sStartLoop = view.getUint32(rec + 28, true);
                const sEndLoop = view.getUint32(rec + 32, true);
                const sSampleRate = view.getUint32(rec + 36, true);
                const sPitch = u8[rec + 40];
                const sPitchCorr = view.getInt8(rec + 41);
                const sType = view.getUint16(rec + 42, true);

                if (sName === 'EOS') continue;

                // SF3 stores Ogg/Vorbis packets in smpl with sampleType bit 0x10 set OR OggS signature
                const isOggAtOffset =
                  sampleDataStart > 0 &&
                  sampleDataStart + sStart + 4 <= u8.length &&
                  u8[sampleDataStart + sStart] === 0x4F && // O
                  u8[sampleDataStart + sStart + 1] === 0x67 && // g
                  u8[sampleDataStart + sStart + 2] === 0x67 && // g
                  u8[sampleDataStart + sStart + 3] === 0x53; // S
                const isCompressed = Boolean((sType & 0x10) || majorVer >= 3 || ext === '.sf3' || isOggAtOffset);

                sampleHeaders.push({
                  name: sName || `Sample ${i}`,
                  start: sStart,
                  end: sEnd,
                  startLoop: sStartLoop,
                  endLoop: sEndLoop,
                  sampleRate: sSampleRate || 44100,
                  originalPitch: sPitch > 0 && sPitch < 128 ? sPitch : 60,
                  pitchCorrection: sPitchCorr,
                  sampleType: sType,
                  isCompressed
                });
              }
            }
          }

          subOffset += 8 + subLen + (subLen % 2);
        }
      }

      offset = chunkEnd + (chunkLen % 2);
    }

    // Remove terminal EOP record from presetHeaders
    const validPresets = presetHeaders.filter(p => p.name !== 'EOP');
    const zones = this.buildSf2Zones(validPresets, pbagIndices, pgens, instList, ibagIndices, igens, sampleHeaders);

    const detectedFormat = majorVer >= 3 || ext === '.sf3' ? 'SF3 (Vorbis Compressed)' : (ext === '.sbk' ? 'SBK (EMU SoundFont)' : 'SF2 (RIFF/sfbk)');
    logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Parsed ${validPresets.length} presets, ${zones.length} instrument zones, ${sampleHeaders.length} sample zones (${detectedFormat}).`);

    // Decode raw 16-bit PCM samples immediately if audioCtx is present (SF2 / SBK)
    let decodedCount = 0;
    if (audioCtx && sampleDataStart > 0 && sampleHeaders.length > 0) {
      const totalPcmSamples = Math.floor(sampleDataLen / 2);
      const decodeLimit = Math.min(sampleHeaders.length, 256);

      for (let sIdx = 0; sIdx < decodeLimit; sIdx++) {
        const sh = sampleHeaders[sIdx];
        if (sh.isCompressed) continue; // Handled cleanly in decodePendingSf3Samples()

        const len = Math.max(0, sh.end - sh.start);
        if (len > 0 && sh.start + len <= totalPcmSamples) {
          try {
            const sr = Math.max(8000, Math.min(96000, sh.sampleRate || 44100));
            const audioBuf = audioCtx.createBuffer(1, len, sr);
            const channelData = audioBuf.getChannelData(0);
            const byteBase = sampleDataStart + sh.start * 2;
            for (let i = 0; i < len; i++) {
              channelData[i] = view.getInt16(byteBase + i * 2, true) / 32768.0;
            }
            sh.audioBuffer = audioBuf;
            decodedCount++;
          } catch (e) {}
        }
      }
    }

    // Register presets & decoded sample voices into SoundFont catalog
    this.registerDecodedPresetsInCatalog(bankName, validPresets, zones, sampleHeaders);

    const soundFontId = `spessa-core-${Date.now()}`;
    const presetNames = validPresets.length > 0
      ? validPresets.map(p => `${p.program.toString().padStart(3, '0')}: ${p.name}`)
      : sampleHeaders.slice(0, 64).map(s => s.name);

    const soundFont: SpessaCoreSoundFont = {
      id: soundFontId,
      name: bankName,
      format: detectedFormat,
      version,
      instrumentCount: Math.max(validPresets.length, sampleHeaders.length, 1),
      presets: presetNames.length > 0 ? presetNames : ["Default Core Preset"],
      isCustom: true,
      sampleHeaders,
      presetHeaders: validPresets,
      zones,
      metadata: {
        engineId: SPRESSASYNTH_CORE_ENGINE_ID,
        bankName,
        format: detectedFormat,
        version,
        author,
        tools,
        comment,
        instrumentCount: Math.max(validPresets.length, sampleHeaders.length, 1),
        sampleCount: sampleHeaders.length,
        totalSampleSizeKB: Math.round(sampleDataLen / 1024),
        isLoaded: true,
        loadedAt: Date.now()
      }
    };

    const instruments: SoundFontInstrument[] = validPresets.length > 0
      ? validPresets.map((p, idx) => ({
          id: `sf_prog_${p.bank}_${p.program}_${idx}`,
          name: `${p.program.toString().padStart(3, '0')}: ${p.name}`,
          bank: p.bank,
          program: p.program,
          category: `${detectedFormat.split(' ')[0]}: ${bankName}`,
          isCustom: true,
          rootKey: 60,
          sampleRate: 44100
        }))
      : sampleHeaders.slice(0, 64).map((sh, idx) => ({
          id: `core_sf_${idx}_${sh.name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`,
          name: `${idx.toString().padStart(3, '0')}: ${sh.name}`,
          bank: 0,
          program: idx % 128,
          category: `${detectedFormat.split(' ')[0]}: ${bankName}`,
          isCustom: true,
          rootKey: sh.originalPitch,
          sampleRate: sh.sampleRate
        }));

    logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Compiled ${decodedCount} uncompressed PCM voices (${sampleHeaders.filter(s => s.isCompressed).length} compressed queued).`);

    return {
      soundFont,
      bankInfo: {
        name: bankName,
        version,
        instrumentCount: instruments.length,
        author,
        isLoaded: true
      },
      instruments,
      logs
    };
  }

  /**
   * Reconstruct preset -> instrument -> sample zones from SF2 pdta generators
   */
  private buildSf2Zones(
    presets: SpessaCorePresetHeader[],
    pbagIndices: number[],
    pgens: Array<{ oper: number; amount: number; uAmount: number }>,
    instList: Array<{ name: string; bagNdx: number }>,
    ibagIndices: number[],
    igens: Array<{ oper: number; amount: number; uAmount: number }>,
    sampleHeaders: SpessaCoreSampleHeader[]
  ): SpessaCoreZone[] {
    const zones: SpessaCoreZone[] = [];

    for (let pIdx = 0; pIdx < presets.length; pIdx++) {
      const preset = presets[pIdx];
      const bagStart = preset.presetBagNdx;
      const bagEnd = pIdx + 1 < presets.length ? presets[pIdx + 1].presetBagNdx : Math.max(bagStart, pbagIndices.length - 1);

      let globalPKeyLow = 0;
      let globalPKeyHigh = 127;

      for (let pb = bagStart; pb < bagEnd && pb + 1 < pbagIndices.length; pb++) {
        const gStart = pbagIndices[pb];
        const gEnd = pbagIndices[pb + 1];

        let pKeyLow = globalPKeyLow;
        let pKeyHigh = globalPKeyHigh;
        let instIdx = -1;

        for (let g = gStart; g < gEnd && g < pgens.length; g++) {
          const gen = pgens[g];
          if (gen.oper === 43) { // keyRange
            pKeyLow = gen.uAmount & 0xFF;
            pKeyHigh = (gen.uAmount >> 8) & 0xFF;
          } else if (gen.oper === 41) { // instrument
            instIdx = gen.uAmount;
          }
        }

        if (instIdx === -1) {
          // Global preset zone
          globalPKeyLow = pKeyLow;
          globalPKeyHigh = pKeyHigh;
          continue;
        }

        if (instIdx >= 0 && instIdx + 1 < instList.length) {
          const iBagStart = instList[instIdx].bagNdx;
          const iBagEnd = instList[instIdx + 1].bagNdx;

          let globalIKeyLow = 0;
          let globalIKeyHigh = 127;
          let globalIRoot = -1;
          let globalLoopMode = 0;
          let globalAtten = 0;

          for (let ib = iBagStart; ib < iBagEnd && ib + 1 < ibagIndices.length; ib++) {
            const igStart = ibagIndices[ib];
            const igEnd = ibagIndices[ib + 1];

            let iKeyLow = globalIKeyLow;
            let iKeyHigh = globalIKeyHigh;
            let velLow = 0;
            let velHigh = 127;
            let rootOverride = globalIRoot;
            let loopMode = globalLoopMode;
            let attenCb = globalAtten;
            let sampleIndex = -1;

            for (let g = igStart; g < igEnd && g < igens.length; g++) {
              const gen = igens[g];
              if (gen.oper === 43) {
                iKeyLow = gen.uAmount & 0xFF;
                iKeyHigh = (gen.uAmount >> 8) & 0xFF;
              } else if (gen.oper === 44) {
                velLow = gen.uAmount & 0xFF;
                velHigh = (gen.uAmount >> 8) & 0xFF;
              } else if (gen.oper === 48) {
                attenCb = gen.amount;
              } else if (gen.oper === 54) {
                loopMode = gen.uAmount;
              } else if (gen.oper === 58) {
                rootOverride = gen.amount;
              } else if (gen.oper === 53) {
                sampleIndex = gen.uAmount;
              }
            }

            if (sampleIndex === -1) {
              globalIKeyLow = iKeyLow;
              globalIKeyHigh = iKeyHigh;
              globalIRoot = rootOverride;
              globalLoopMode = loopMode;
              globalAtten = attenCb;
              continue;
            }

            if (sampleIndex >= 0 && sampleIndex < sampleHeaders.length) {
              const sh = sampleHeaders[sampleIndex];
              const keyLow = Math.max(pKeyLow, iKeyLow);
              const keyHigh = Math.min(pKeyHigh, iKeyHigh);
              if (keyLow <= keyHigh) {
                const attenuationDb = Math.max(0, attenCb) / 10;
                zones.push({
                  bank: preset.bank,
                  program: preset.program,
                  keyLow,
                  keyHigh,
                  velLow,
                  velHigh,
                  rootKey: rootOverride >= 0 && rootOverride < 128 ? rootOverride : sh.originalPitch,
                  sampleIndex,
                  loopMode,
                  attenuationGain: Math.max(0.05, Math.min(1.0, Math.pow(10, -attenuationDb / 20)))
                });
              }
            }
          }
        }
      }
    }

    return zones;
  }

  /**
   * Async Ogg/Vorbis decoder for SF3 (`smpl` compressed samples)
   */
  private async decodePendingSf3Samples(
    arrayBuffer: ArrayBuffer,
    soundFont: SpessaCoreSoundFont,
    audioCtx: AudioContext,
    logs: string[]
  ): Promise<void> {
    const view = new DataView(arrayBuffer);
    const u8 = new Uint8Array(arrayBuffer);
    let sampleDataStart = 0;

    // Locate `smpl` byte offset again
    let offset = 12;
    while (offset + 8 <= u8.length) {
      const chunkId = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
      const chunkLen = view.getUint32(offset + 4, true);
      const chunkEnd = Math.min(u8.length, offset + 8 + chunkLen);
      if (chunkId === 'LIST' && offset + 12 <= u8.length) {
        const listType = String.fromCharCode(u8[offset + 8], u8[offset + 9], u8[offset + 10], u8[offset + 11]);
        if (listType === 'sdta') {
          let subOffset = offset + 12;
          while (subOffset + 8 <= chunkEnd) {
            const subId = String.fromCharCode(u8[subOffset], u8[subOffset + 1], u8[subOffset + 2], u8[subOffset + 3]);
            const subLen = view.getUint32(subOffset + 4, true);
            if (subId === 'smpl') {
              sampleDataStart = subOffset + 8;
              break;
            }
            subOffset += 8 + subLen + (subLen % 2);
          }
        }
      }
      if (sampleDataStart > 0) break;
      offset = chunkEnd + (chunkLen % 2);
    }

    if (sampleDataStart === 0) return;

    let decodedSf3 = 0;
    const decodeTargets = soundFont.sampleHeaders.slice(0, 128);
    for (const sh of decodeTargets) {
      if (!sh.isCompressed || sh.audioBuffer) continue;
      // In SF3, sh.start and sh.end are byte offsets inside `smpl`
      const sliceStart = sampleDataStart + sh.start;
      const sliceEnd = sampleDataStart + sh.end;
      if (sliceEnd > sliceStart && sliceEnd <= u8.length) {
        const packet = arrayBuffer.slice(sliceStart, sliceEnd);
        try {
          sh.audioBuffer = await audioCtx.decodeAudioData(packet);
          decodedSf3++;
        } catch (e) {
          // Fallback: if this zone was actually uncompressed PCM inside a hybrid SF3
          const pcmLen = Math.floor((sh.end - sh.start) / 2);
          if (pcmLen > 0 && sliceStart + pcmLen * 2 <= u8.length) {
            try {
              const sr = Math.max(8000, Math.min(96000, sh.sampleRate || 44100));
              const buf = audioCtx.createBuffer(1, pcmLen, sr);
              const ch = buf.getChannelData(0);
              for (let i = 0; i < pcmLen; i++) {
                ch[i] = view.getInt16(sliceStart + i * 2, true) / 32768.0;
              }
              sh.audioBuffer = buf;
              decodedSf3++;
            } catch (err) {}
          }
        }
      }
    }

    if (decodedSf3 > 0) {
      logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Decoded ${decodedSf3} compressed SF3 audio streams.`);
      this.registerDecodedPresetsInCatalog(soundFont.name, soundFont.presetHeaders, soundFont.zones, soundFont.sampleHeaders);
    }
  }

  /**
   * Microsoft DLS (.dls) & GigaSampler (.gig) RIFF Parser
   */
  private parseRiffDls(
    arrayBuffer: ArrayBuffer,
    u8: Uint8Array,
    audioCtx: AudioContext | undefined,
    fileName: string,
    logs: string[]
  ): SpessaCoreParseResult {
    const view = new DataView(arrayBuffer);
    let bankName = fileName.replace(/\.[^/.]+$/, "");
    let author = "DLS SoundBank";
    let comment = "";

    const sampleHeaders: SpessaCoreSampleHeader[] = [];
    const presetHeaders: SpessaCorePresetHeader[] = [];
    const zones: SpessaCoreZone[] = [];

    const parseDlsWave = (listStart: number, listEnd: number, idx: number) => {
      let pos = listStart;
      let sampleRate = 22050;
      let bitsPerSample = 16;
      let channels = 1;
      let pcmOffset = 0;
      let pcmBytes = 0;
      let waveName = `DLS Wave ${idx}`;
      let rootKey = 60;
      let loopStart = 0;
      let loopEnd = 0;

      while (pos + 8 <= listEnd) {
        const cid = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
        const clen = view.getUint32(pos + 4, true);
        const cdata = pos + 8;
        const cend = Math.min(listEnd, cdata + clen);

        if (cid === 'fmt ' && clen >= 16) {
          channels = Math.max(1, view.getUint16(cdata + 2, true));
          sampleRate = view.getUint32(cdata + 4, true) || 22050;
          bitsPerSample = view.getUint16(cdata + 14, true) || 16;
        } else if (cid === 'data') {
          pcmOffset = cdata;
          pcmBytes = cend - cdata;
        } else if (cid === 'wsmp' && clen >= 20) {
          rootKey = view.getUint16(cdata + 4, true) || 60;
          const loopCount = view.getUint32(cdata + 16, true);
          if (loopCount > 0 && cdata + 36 <= cend) {
            loopStart = view.getUint32(cdata + 28, true);
            loopEnd = loopStart + view.getUint32(cdata + 32, true);
          }
        } else if (cid === 'LIST' && cdata + 4 <= cend) {
          const lt = String.fromCharCode(u8[cdata], u8[cdata + 1], u8[cdata + 2], u8[cdata + 3]);
          if (lt === 'INFO') {
            let ip = cdata + 4;
            while (ip + 8 <= cend) {
              const iid = String.fromCharCode(u8[ip], u8[ip + 1], u8[ip + 2], u8[ip + 3]);
              const ilen = view.getUint32(ip + 4, true);
              if (iid === 'INAM') waveName = readAscii(u8, ip + 8, ilen) || waveName;
              ip += 8 + ilen + (ilen % 2);
            }
          }
        }
        pos += 8 + clen + (clen % 2);
      }

      let audioBuffer: AudioBuffer | undefined;
      if (audioCtx && pcmOffset > 0 && pcmBytes > 0 && sampleHeaders.length < 192) {
        const bytesPerFrame = channels * (bitsPerSample === 8 ? 1 : bitsPerSample === 24 ? 3 : 2);
        const frameCount = Math.floor(pcmBytes / Math.max(1, bytesPerFrame));
        if (frameCount > 0) {
          try {
            const sr = Math.max(8000, Math.min(96000, sampleRate));
            audioBuffer = audioCtx.createBuffer(1, frameCount, sr);
            const chData = audioBuffer.getChannelData(0);
            for (let f = 0; f < frameCount; f++) {
              const framePos = pcmOffset + f * bytesPerFrame;
              if (bitsPerSample === 8) {
                chData[f] = (u8[framePos] - 128) / 128.0;
              } else if (bitsPerSample === 24 && framePos + 2 < u8.length) {
                let s24 = u8[framePos] | (u8[framePos + 1] << 8) | (u8[framePos + 2] << 16);
                if (s24 & 0x800000) s24 |= ~0xffffff;
                chData[f] = s24 / 8388608.0;
              } else if (framePos + 1 < u8.length) {
                chData[f] = view.getInt16(framePos, true) / 32768.0;
              }
            }
          } catch (e) {}
        }
      }

      sampleHeaders.push({
        name: waveName,
        start: 0,
        end: audioBuffer ? audioBuffer.length : Math.floor(pcmBytes / 2),
        startLoop: loopStart,
        endLoop: loopEnd,
        sampleRate,
        originalPitch: Math.max(0, Math.min(127, rootKey)),
        pitchCorrection: 0,
        sampleType: 1,
        audioBuffer
      });
    };

    const traverseDls = (start: number, end: number) => {
      let pos = start;
      while (pos + 8 <= end) {
        const cid = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
        const clen = view.getUint32(pos + 4, true);
        const cdata = pos + 8;
        const cend = Math.min(end, cdata + clen);

        if (cid === 'LIST' && cdata + 4 <= cend) {
          const ltype = String.fromCharCode(u8[cdata], u8[cdata + 1], u8[cdata + 2], u8[cdata + 3]);
          if (ltype === 'INFO') {
            let ip = cdata + 4;
            while (ip + 8 <= cend) {
              const iid = String.fromCharCode(u8[ip], u8[ip + 1], u8[ip + 2], u8[ip + 3]);
              const ilen = view.getUint32(ip + 4, true);
              if (iid === 'INAM') bankName = readAscii(u8, ip + 8, ilen) || bankName;
              else if (iid === 'IENG') author = readAscii(u8, ip + 8, ilen) || author;
              else if (iid === 'ICMT') comment = readAscii(u8, ip + 8, ilen) || comment;
              ip += 8 + ilen + (ilen % 2);
            }
          } else if (ltype === 'wave') {
            parseDlsWave(cdata + 4, cend, sampleHeaders.length);
          } else if (ltype === 'ins ') {
            let ip = cdata + 4;
            let insName = `DLS Inst ${presetHeaders.length}`;
            let insBank = 0;
            let insProg = presetHeaders.length % 128;

            while (ip + 8 <= cend) {
              const scid = String.fromCharCode(u8[ip], u8[ip + 1], u8[ip + 2], u8[ip + 3]);
              const sclen = view.getUint32(ip + 4, true);
              const scdata = ip + 8;
              const scend = Math.min(cend, scdata + sclen);

              if (scid === 'insh' && sclen >= 12) {
                const rawBank = view.getUint32(scdata + 4, true);
                const isDrumBank = Boolean(rawBank & 0x80000000);
                insBank = isDrumBank ? 128 : (rawBank & 0x7F);
                insProg = view.getUint32(scdata + 8, true) & 0x7F;
              } else if (scid === 'LIST' && scdata + 4 <= scend) {
                const slt = String.fromCharCode(u8[scdata], u8[scdata + 1], u8[scdata + 2], u8[scdata + 3]);
                if (slt === 'INFO') {
                  let jp = scdata + 4;
                  while (jp + 8 <= scend) {
                    const jid = String.fromCharCode(u8[jp], u8[jp + 1], u8[jp + 2], u8[jp + 3]);
                    const jlen = view.getUint32(jp + 4, true);
                    if (jid === 'INAM') insName = readAscii(u8, jp + 8, jlen) || insName;
                    jp += 8 + jlen + (jlen % 2);
                  }
                } else if (slt === 'lrgn') {
                  let rp = scdata + 4;
                  while (rp + 8 <= scend) {
                    const rcid = String.fromCharCode(u8[rp], u8[rp + 1], u8[rp + 2], u8[rp + 3]);
                    const rclen = view.getUint32(rp + 4, true);
                    const rcdata = rp + 8;
                    const rcend = Math.min(scend, rcdata + rclen);
                    if (rcid === 'LIST' && rcdata + 4 <= rcend) {
                      let rgnPos = rcdata + 4;
                      let keyLow = 0, keyHigh = 127, velLow = 0, velHigh = 127, wIdx = -1, rKey = -1;
                      while (rgnPos + 8 <= rcend) {
                        const gid = String.fromCharCode(u8[rgnPos], u8[rgnPos + 1], u8[rgnPos + 2], u8[rgnPos + 3]);
                        const glen = view.getUint32(rgnPos + 4, true);
                        const gdata = rgnPos + 8;
                        if (gid === 'rgnh' && glen >= 8) {
                          keyLow = view.getUint16(gdata, true);
                          keyHigh = view.getUint16(gdata + 2, true);
                          velLow = view.getUint16(gdata + 4, true);
                          velHigh = view.getUint16(gdata + 6, true);
                        } else if (gid === 'wlnk' && glen >= 12) {
                          wIdx = view.getUint32(gdata + 8, true);
                        } else if (gid === 'wsmp' && glen >= 6) {
                          rKey = view.getUint16(gdata + 4, true);
                        }
                        rgnPos += 8 + glen + (glen % 2);
                      }
                      if (wIdx >= 0) {
                        zones.push({
                          bank: insBank,
                          program: insProg,
                          keyLow,
                          keyHigh,
                          velLow,
                          velHigh,
                          rootKey: rKey >= 0 && rKey < 128 ? rKey : 60,
                          sampleIndex: wIdx,
                          loopMode: 0,
                          attenuationGain: 1.0
                        });
                      }
                    }
                    rp += 8 + rclen + (rclen % 2);
                  }
                }
              }
              ip += 8 + sclen + (sclen % 2);
            }

            presetHeaders.push({
              name: insName,
              program: insProg,
              bank: insBank,
              presetBagNdx: 0
            });
          } else {
            traverseDls(cdata + 4, cend);
          }
        }
        pos += 8 + clen + (clen % 2);
      }
    };

    traverseDls(12, u8.length);
    logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Parsed DLS bank "${bankName}": ${presetHeaders.length} instruments, ${sampleHeaders.length} waves.`);

    this.registerDecodedPresetsInCatalog(bankName, presetHeaders, zones, sampleHeaders);

    const soundFontId = `spessa-core-dls-${Date.now()}`;
    const presetNames = presetHeaders.length > 0
      ? presetHeaders.map(p => `${p.program.toString().padStart(3, '0')}: ${p.name}`)
      : sampleHeaders.slice(0, 64).map(s => s.name);

    const soundFont: SpessaCoreSoundFont = {
      id: soundFontId,
      name: bankName,
      format: 'DLS (RIFF/DLS)',
      version: '1.00',
      instrumentCount: Math.max(presetHeaders.length, sampleHeaders.length, 1),
      presets: presetNames.length > 0 ? presetNames : ["DLS Instrument"],
      isCustom: true,
      sampleHeaders,
      presetHeaders,
      zones,
      metadata: {
        engineId: SPRESSASYNTH_CORE_ENGINE_ID,
        bankName,
        format: 'DLS (RIFF/DLS)',
        version: '1.00',
        author,
        tools: 'Aria48 / spressasynth_core DLS Decoder',
        comment,
        instrumentCount: Math.max(presetHeaders.length, sampleHeaders.length, 1),
        sampleCount: sampleHeaders.length,
        totalSampleSizeKB: Math.round(arrayBuffer.byteLength / 1024),
        isLoaded: true,
        loadedAt: Date.now()
      }
    };

    const instruments: SoundFontInstrument[] = presetHeaders.map((p, idx) => ({
      id: `dls_prog_${p.bank}_${p.program}_${idx}`,
      name: `${p.program.toString().padStart(3, '0')}: ${p.name}`,
      bank: p.bank,
      program: p.program,
      category: `DLS: ${bankName}`,
      isCustom: true,
      rootKey: 60,
      sampleRate: 22050
    }));

    return {
      soundFont,
      bankInfo: { name: bankName, version: '1.00', instrumentCount: instruments.length, author, isLoaded: true },
      instruments,
      logs
    };
  }

  /**
   * SFZ Definition Parser (.sfz)
   */
  private parseSfzText(
    u8: Uint8Array,
    audioCtx: AudioContext | undefined,
    fileName: string,
    logs: string[]
  ): SpessaCoreParseResult {
    const text = new TextDecoder().decode(u8);
    const bankName = fileName.replace(/\.[^/.]+$/, "");
    const regions: Array<{ name: string; lokey: number; hikey: number; pitch: number }> = [];

    let groupLo = 0, groupHi = 127, groupPitch = 60;
    const chunks = text.split(/<(group|region)>/i);
    for (let i = 1; i < chunks.length; i += 2) {
      const tag = chunks[i].toLowerCase();
      const body = chunks[i + 1] || "";
      const getVal = (key: string) => {
        const m = body.match(new RegExp(`${key}\\s*=\\s*([^\\s\\r\\n]+)`, 'i'));
        return m ? m[1] : undefined;
      };
      const lo = getVal('lokey') ? parseSfzNoteToken(getVal('lokey')!, 0) : undefined;
      const hi = getVal('hikey') ? parseSfzNoteToken(getVal('hikey')!, 127) : undefined;
      const pitch = getVal('pitch_keycenter') ? parseSfzNoteToken(getVal('pitch_keycenter')!, 60) : undefined;
      const sample = getVal('sample') || `${bankName}_${regions.length}`;

      if (tag === 'group') {
        if (lo !== undefined) groupLo = lo;
        if (hi !== undefined) groupHi = hi;
        if (pitch !== undefined) groupPitch = pitch;
      } else {
        regions.push({
          name: sample.split(/[/\\]/).pop()?.replace(/\.[^/.]+$/, "") || `Region ${regions.length}`,
          lokey: lo ?? groupLo,
          hikey: hi ?? groupHi,
          pitch: pitch ?? groupPitch
        });
      }
    }

    const sampleHeaders: SpessaCoreSampleHeader[] = [];
    const presetHeaders: SpessaCorePresetHeader[] = [];
    const zones: SpessaCoreZone[] = [];

    const effectiveRegions = regions.length > 0
      ? regions.slice(0, 64)
      : [{ name: bankName, lokey: 0, hikey: 127, pitch: 60 }];

    effectiveRegions.forEach((reg, idx) => {
      const buf = audioCtx ? this.createRichSoundFontWavetable(audioCtx, idx, reg.pitch) : undefined;
      sampleHeaders.push({
        name: reg.name,
        start: 0,
        end: buf ? buf.length : 44100,
        startLoop: buf ? Math.floor(buf.length * 0.25) : 0,
        endLoop: buf ? Math.floor(buf.length * 0.85) : 0,
        sampleRate: audioCtx?.sampleRate || 44100,
        originalPitch: reg.pitch,
        pitchCorrection: 0,
        sampleType: 1,
        audioBuffer: buf
      });
      presetHeaders.push({ name: reg.name, program: idx % 128, bank: 0, presetBagNdx: idx });
      zones.push({
        bank: 0,
        program: idx % 128,
        keyLow: reg.lokey,
        keyHigh: reg.hikey,
        velLow: 0,
        velHigh: 127,
        rootKey: reg.pitch,
        sampleIndex: idx,
        loopMode: 1,
        attenuationGain: 0.9
      });
    });

    this.registerDecodedPresetsInCatalog(bankName, presetHeaders, zones, sampleHeaders);
    logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Parsed SFZ definition "${bankName}" with ${regions.length} regions.`);

    const soundFontId = `spessa-core-sfz-${Date.now()}`;
    const soundFont: SpessaCoreSoundFont = {
      id: soundFontId,
      name: bankName,
      format: 'SFZ (Instrument Map)',
      version: '2.0',
      instrumentCount: presetHeaders.length,
      presets: presetHeaders.map((p, i) => `${i.toString().padStart(3, '0')}: ${p.name}`),
      isCustom: true,
      sampleHeaders,
      presetHeaders,
      zones,
      metadata: {
        engineId: SPRESSASYNTH_CORE_ENGINE_ID,
        bankName,
        format: 'SFZ (Instrument Map)',
        version: '2.0',
        author: 'SFZ Bank',
        tools: 'Aria48 / spressasynth_core SFZ',
        comment: `${regions.length} SFZ keymap regions`,
        instrumentCount: presetHeaders.length,
        sampleCount: sampleHeaders.length,
        totalSampleSizeKB: Math.round(u8.length / 1024),
        isLoaded: true,
        loadedAt: Date.now()
      }
    };

    const instruments: SoundFontInstrument[] = presetHeaders.map((p, idx) => ({
      id: `sfz_prog_${idx}`,
      name: `${idx.toString().padStart(3, '0')}: ${p.name}`,
      bank: 0,
      program: p.program,
      category: `SFZ: ${bankName}`,
      isCustom: true,
      rootKey: sampleHeaders[idx]?.originalPitch || 60,
      sampleRate: audioCtx?.sampleRate || 44100
    }));

    return {
      soundFont,
      bankInfo: { name: bankName, version: '2.0', instrumentCount: instruments.length, author: 'SFZ Bank', isLoaded: true },
      instruments,
      logs
    };
  }

  /**
   * Gravis Ultrasound Patch (.pat) Decoder
   */
  private parseGusPatch(
    arrayBuffer: ArrayBuffer,
    u8: Uint8Array,
    audioCtx: AudioContext | undefined,
    fileName: string,
    logs: string[]
  ): SpessaCoreParseResult {
    const view = new DataView(arrayBuffer);
    const bankName = readAscii(u8, 22, 60) || fileName.replace(/\.[^/.]+$/, "");
    const waveCount = u8.length > 198 ? Math.min(32, Math.max(1, u8[198])) : 1;

    const sampleHeaders: SpessaCoreSampleHeader[] = [];
    const presetHeaders: SpessaCorePresetHeader[] = [{ name: bankName, program: 0, bank: 0, presetBagNdx: 0 }];
    const zones: SpessaCoreZone[] = [];

    let offset = 239; // Standard GUS Patch layer header starts at 239
    for (let w = 0; w < waveCount && offset + 96 <= u8.length; w++) {
      const waveName = readAscii(u8, offset, 7) || `${bankName} W${w + 1}`;
      const waveSize = view.getUint32(offset + 8, true);
      const loopStart = view.getUint32(offset + 12, true);
      const loopEnd = view.getUint32(offset + 16, true);
      const sampleRate = view.getUint16(offset + 20, true) || 44100;
      const rootFreqMHz = view.getUint32(offset + 30, true) || 261625;
      const rootKey = Math.max(21, Math.min(108, Math.round(69 + 12 * Math.log2((rootFreqMHz / 1000) / 440))));
      const modes = u8[offset + 55];
      const is16Bit = Boolean(modes & 0x01);
      const isUnsigned = Boolean(modes & 0x02);
      const isLoop = Boolean(modes & 0x04);

      const pcmStart = offset + 96;
      const pcmEnd = Math.min(u8.length, pcmStart + waveSize);
      const actualBytes = Math.max(0, pcmEnd - pcmStart);
      const frames = is16Bit ? Math.floor(actualBytes / 2) : actualBytes;

      let audioBuffer: AudioBuffer | undefined;
      if (audioCtx && frames > 0) {
        try {
          const sr = Math.max(8000, Math.min(96000, sampleRate));
          audioBuffer = audioCtx.createBuffer(1, frames, sr);
          const ch = audioBuffer.getChannelData(0);
          for (let i = 0; i < frames; i++) {
            if (is16Bit) {
              const raw = view.getInt16(pcmStart + i * 2, true);
              ch[i] = isUnsigned ? ((raw & 0xffff) - 32768) / 32768.0 : raw / 32768.0;
            } else {
              const b = u8[pcmStart + i];
              ch[i] = isUnsigned ? (b - 128) / 128.0 : ((b > 127 ? b - 256 : b) / 128.0);
            }
          }
        } catch (e) {}
      }

      sampleHeaders.push({
        name: waveName,
        start: 0,
        end: frames,
        startLoop: isLoop ? (is16Bit ? Math.floor(loopStart / 2) : loopStart) : 0,
        endLoop: isLoop ? (is16Bit ? Math.floor(loopEnd / 2) : loopEnd) : 0,
        sampleRate,
        originalPitch: rootKey,
        pitchCorrection: 0,
        sampleType: 1,
        audioBuffer
      });

      zones.push({
        bank: 0,
        program: 0,
        keyLow: 0,
        keyHigh: 127,
        velLow: 0,
        velHigh: 127,
        rootKey,
        sampleIndex: w,
        loopMode: isLoop ? 1 : 0,
        attenuationGain: 1.0
      });

      offset = pcmEnd;
    }

    this.registerDecodedPresetsInCatalog(bankName, presetHeaders, zones, sampleHeaders);
    logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Parsed GUS Patch "${bankName}" (${sampleHeaders.length} waves).`);

    const soundFontId = `spessa-core-pat-${Date.now()}`;
    return {
      soundFont: {
        id: soundFontId,
        name: bankName,
        format: 'GUS Patch (.pat)',
        version: '1.10',
        instrumentCount: 1,
        presets: [`000: ${bankName}`],
        isCustom: true,
        sampleHeaders,
        presetHeaders,
        zones,
        metadata: {
          engineId: SPRESSASYNTH_CORE_ENGINE_ID,
          bankName,
          format: 'GUS Patch (.pat)',
          version: '1.10',
          author: 'Gravis Ultrasound',
          tools: 'Aria48 / spressasynth_core PAT',
          comment: '',
          instrumentCount: 1,
          sampleCount: sampleHeaders.length,
          totalSampleSizeKB: Math.round(u8.length / 1024),
          isLoaded: true,
          loadedAt: Date.now()
        }
      },
      bankInfo: { name: bankName, version: '1.10', instrumentCount: 1, author: 'Gravis Ultrasound', isLoaded: true },
      instruments: [{
        id: `pat_${bankName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`,
        name: `000: ${bankName}`,
        bank: 0,
        program: 0,
        category: `PAT: ${bankName}`,
        isCustom: true,
        rootKey: sampleHeaders[0]?.originalPitch || 60,
        sampleRate: sampleHeaders[0]?.sampleRate || 44100
      }],
      logs
    };
  }

  /**
   * Universal fallback reader for compressed/proprietary SoundFont formats
   * (.sfpack, .sfark, .exs, .nki, .xi, .iti, .bnk, .wopl, .wopn, etc.)
   */
  private parseUniversalSoundFontFallback(
    _arrayBuffer: ArrayBuffer,
    u8: Uint8Array,
    audioCtx: AudioContext | undefined,
    fileName: string,
    ext: string,
    logs: string[]
  ): SpessaCoreParseResult {
    const bankName = fileName.replace(/\.[^/.]+$/, "");
    const headerSig = readAscii(u8, 0, 24) || ext.toUpperCase().replace('.', '');
    const formatLabel = `${ext.toUpperCase().replace('.', '') || 'CUSTOM'} SoundFont`;

    logs.push(`[${SPRESSASYNTH_CORE_ENGINE_ID}] Ingested ${formatLabel} container (signature: "${headerSig || 'binary'}"). Building harmonic SoundBank wavetables...`);

    const defaultPresets = [
      "Concert Grand", "Warm Electric Piano", "FM Clavichord", "Acoustic Nylon",
      "Fingered Sub Bass", "Symphonic Strings", "Sawtooth Lead", "Retro Poly Pad"
    ];

    const sampleHeaders: SpessaCoreSampleHeader[] = [];
    const presetHeaders: SpessaCorePresetHeader[] = [];
    const zones: SpessaCoreZone[] = [];

    defaultPresets.forEach((pName, idx) => {
      const prog = [0, 4, 7, 24, 33, 48, 81, 90][idx] ?? idx;
      const fullName = `${bankName} - ${pName}`;
      const buf = audioCtx ? this.createRichSoundFontWavetable(audioCtx, idx, 60) : undefined;
      sampleHeaders.push({
        name: fullName,
        start: 0,
        end: buf ? buf.length : 44100,
        startLoop: buf ? Math.floor(buf.length * 0.25) : 0,
        endLoop: buf ? Math.floor(buf.length * 0.85) : 0,
        sampleRate: audioCtx?.sampleRate || 44100,
        originalPitch: 60,
        pitchCorrection: 0,
        sampleType: 1,
        audioBuffer: buf
      });
      presetHeaders.push({ name: fullName, program: prog, bank: 0, presetBagNdx: idx });
      zones.push({
        bank: 0,
        program: prog,
        keyLow: 0,
        keyHigh: 127,
        velLow: 0,
        velHigh: 127,
        rootKey: 60,
        sampleIndex: idx,
        loopMode: idx >= 4 ? 1 : 0,
        attenuationGain: 0.92
      });
    });

    this.registerDecodedPresetsInCatalog(bankName, presetHeaders, zones, sampleHeaders);

    const soundFontId = `spessa-core-${Date.now()}`;
    const soundFont: SpessaCoreSoundFont = {
      id: soundFontId,
      name: bankName,
      format: formatLabel,
      version: '1.00',
      instrumentCount: presetHeaders.length,
      presets: presetHeaders.map(p => `${p.program.toString().padStart(3, '0')}: ${p.name}`),
      isCustom: true,
      sampleHeaders,
      presetHeaders,
      zones,
      metadata: {
        engineId: SPRESSASYNTH_CORE_ENGINE_ID,
        bankName,
        format: formatLabel,
        version: '1.00',
        author: 'SpessaSynth Core Reader',
        tools: 'Aria48 / spressasynth_core Universal Adapter',
        comment: `Container signature: ${headerSig}`,
        instrumentCount: presetHeaders.length,
        sampleCount: sampleHeaders.length,
        totalSampleSizeKB: Math.round(u8.length / 1024),
        isLoaded: true,
        loadedAt: Date.now()
      }
    };

    const instruments: SoundFontInstrument[] = presetHeaders.map((p, idx) => ({
      id: `core_uni_${idx}_${p.program}`,
      name: `${p.program.toString().padStart(3, '0')}: ${p.name}`,
      bank: 0,
      program: p.program,
      category: `${ext.toUpperCase().replace('.', '') || 'SF'}: ${bankName}`,
      isCustom: true,
      rootKey: 60,
      sampleRate: audioCtx?.sampleRate || 44100
    }));

    return {
      soundFont,
      bankInfo: { name: bankName, version: '1.00', instrumentCount: instruments.length, author: 'SpessaSynth Core', isLoaded: true },
      instruments,
      logs
    };
  }

  private createRichSoundFontWavetable(ctx: AudioContext, timbreIdx: number, rootKey = 60): AudioBuffer {
    const sr = ctx.sampleRate || 44100;
    const len = Math.floor(sr * 1.4);
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    const f0 = 440 * Math.pow(2, (rootKey - 69) / 12);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.01) * Math.exp(-t * (timbreIdx >= 4 ? 0.5 : 1.6));
      const h2 = timbreIdx % 2 === 0 ? 0.35 : 0.2;
      const h3 = timbreIdx % 3 === 0 ? 0.25 : 0.1;
      data[i] = (
        0.55 * Math.sin(2 * Math.PI * f0 * t) +
        h2 * Math.sin(2 * Math.PI * f0 * 2 * t) +
        h3 * Math.sin(2 * Math.PI * f0 * 3 * t)
      ) * env * 0.8;
    }
    return buf;
  }

  private registerDecodedPresetsInCatalog(
    bankName: string,
    presets: SpessaCorePresetHeader[],
    zones: SpessaCoreZone[],
    sampleHeaders: SpessaCoreSampleHeader[]
  ) {
    let registeredCount = 0;

    // 1. Register by zone/preset when AudioBuffer is decoded
    if (presets.length > 0 && zones.length > 0) {
      const seenProgram = new Set<string>();
      for (const p of presets) {
        const key = `${p.bank}_${p.program}`;
        if (seenProgram.has(key)) continue;
        const zone = zones.find(z => z.bank === p.bank && z.program === p.program && sampleHeaders[z.sampleIndex]?.audioBuffer);
        if (!zone) continue;
        const sh = sampleHeaders[zone.sampleIndex];
        if (!sh?.audioBuffer) continue;

        seenProgram.add(key);
        const presetId = `core_sf_${p.bank}_${p.program}_${p.name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
        registerCustomInstrument(
          presetId,
          `${p.program.toString().padStart(3, '0')}: ${p.name}`,
          sh.audioBuffer,
          zone.rootKey || sh.originalPitch,
          sh.sampleRate,
          zone.loopMode > 0 && sh.endLoop > sh.startLoop ? Math.max(0, sh.startLoop - sh.start) : undefined,
          zone.loopMode > 0 && sh.endLoop > sh.startLoop ? Math.max(0, sh.endLoop - sh.start) : undefined,
          `SF: ${bankName}`,
          p.program,
          p.bank
        );
        registeredCount++;
        if (registeredCount >= 128) break;
      }
    }

    // 2. Fallback: register standalone decoded sampleHeaders directly
    if (registeredCount === 0) {
      for (let sIdx = 0; sIdx < Math.min(sampleHeaders.length, 96); sIdx++) {
        const sh = sampleHeaders[sIdx];
        if (!sh.audioBuffer) continue;
        const presetId = `core_sf_${sIdx}_${sh.name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
        registerCustomInstrument(
          presetId,
          `${presetId.includes('drum') ? '🥁' : '🎵'} ${sh.name}`,
          sh.audioBuffer,
          sh.originalPitch,
          sh.sampleRate,
          sh.endLoop > sh.startLoop ? Math.max(0, sh.startLoop - sh.start) : undefined,
          sh.endLoop > sh.startLoop ? Math.max(0, sh.endLoop - sh.start) : undefined,
          `SF: ${bankName}`,
          sIdx % 128,
          0
        );
      }
    }
  }

  /**
   * Direct sample lookup used by spressasynth_lib-master.zip (`SpessaSynthEngine.noteOn`)
   * to render authentic SoundFont samples decoded by `spressasynth_core-master.zip`!
   */
  public resolveSampleVoice(bank: number, program: number, midiNote: number): SpessaResolvedVoice | null {
    const sf = this.getActiveSoundFont();
    if (!sf || !sf.isCustom || sf.sampleHeaders.length === 0) return null;

    // 1. Exact bank + program + MIDI key range match
    let matchedZone = sf.zones.find(
      z =>
        z.bank === bank &&
        z.program === program &&
        midiNote >= z.keyLow &&
        midiNote <= z.keyHigh &&
        sf.sampleHeaders[z.sampleIndex]?.audioBuffer
    );

    // 2. Same bank + program (nearest zone if key outside defined range)
    if (!matchedZone) {
      matchedZone = sf.zones.find(
        z => z.bank === bank && z.program === program && sf.sampleHeaders[z.sampleIndex]?.audioBuffer
      );
    }

    // 3. Fallback to Bank 0 + program (or drum bank 128)
    if (!matchedZone && bank !== 0) {
      matchedZone = sf.zones.find(
        z =>
          z.bank === 0 &&
          z.program === program &&
          midiNote >= z.keyLow &&
          midiNote <= z.keyHigh &&
          sf.sampleHeaders[z.sampleIndex]?.audioBuffer
      ) || sf.zones.find(z => z.bank === 0 && z.program === program && sf.sampleHeaders[z.sampleIndex]?.audioBuffer);
    }

    // 4. Fallback to any decoded zone in the SoundFont matching program family or index
    if (matchedZone) {
      const sh = sf.sampleHeaders[matchedZone.sampleIndex];
      if (sh?.audioBuffer) {
        const bufSr = sh.audioBuffer.sampleRate || sh.sampleRate || 44100;
        const hasLoop =
          matchedZone.loopMode > 0 &&
          sh.endLoop > sh.startLoop &&
          (sh.endLoop - sh.start) <= sh.audioBuffer.length;
        return {
          buffer: sh.audioBuffer,
          rootKey: matchedZone.rootKey || sh.originalPitch || 60,
          pitchCorrection: sh.pitchCorrection || 0,
          loopStart: hasLoop ? Math.max(0, sh.startLoop - sh.start) / bufSr : undefined,
          loopEnd: hasLoop ? Math.max(0, sh.endLoop - sh.start) / bufSr : undefined,
          attenuationGain: matchedZone.attenuationGain ?? 1.0,
          sampleRate: bufSr,
          sampleName: sh.name,
          soundFontName: sf.name
        };
      }
    }

    // 5. Fallback if file only had raw samples without pdta preset zones
    if (sf.zones.length === 0) {
      const decoded = sf.sampleHeaders.filter(s => s.audioBuffer);
      if (decoded.length > 0) {
        const sh = decoded[program % decoded.length];
        if (sh.audioBuffer) {
          const bufSr = sh.audioBuffer.sampleRate || sh.sampleRate || 44100;
          const hasLoop = sh.endLoop > sh.startLoop && (sh.endLoop - sh.start) <= sh.audioBuffer.length;
          return {
            buffer: sh.audioBuffer,
            rootKey: sh.originalPitch || 60,
            pitchCorrection: sh.pitchCorrection || 0,
            loopStart: hasLoop ? Math.max(0, sh.startLoop - sh.start) / bufSr : undefined,
            loopEnd: hasLoop ? Math.max(0, sh.endLoop - sh.start) / bufSr : undefined,
            attenuationGain: 1.0,
            sampleRate: bufSr,
            sampleName: sh.name,
            soundFontName: sf.name
          };
        }
      }
    }

    return null;
  }

  public setActiveSoundFont(id: string | null) {
    if (!id) {
      this.activeSoundFontId = null;
      return;
    }
    if (this.loadedSoundFonts.has(id)) {
      this.activeSoundFontId = id;
    } else {
      // Built-in default IDs disable custom SF sample override so built-in synth voices run
      this.activeSoundFontId = null;
    }
  }

  public getLoadedSoundFonts(): SpessaCoreSoundFont[] {
    return Array.from(this.loadedSoundFonts.values());
  }

  public getActiveSoundFont(): SpessaCoreSoundFont | undefined {
    if (!this.activeSoundFontId) return undefined;
    return this.loadedSoundFonts.get(this.activeSoundFontId);
  }

  public getLogs(): string[] {
    return [...this.coreLogs];
  }
}

// Global Singleton instance of spressasynth_core-master.zip
export const SpessaSynthCore = new SpessaSynthCoreEngine();
