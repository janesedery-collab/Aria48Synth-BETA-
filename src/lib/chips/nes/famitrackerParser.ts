/**
 * src/lib/chips/nes/famitrackerParser.ts
 * Real binary parser for FamiTracker (.ftm), 0CC-FamiTracker (.0cc),
 * and Dn-FamiTracker (.dnm) module files.
 *
 * Reads the official chunked block layout:
 *   Header Magic -> dwVersion ->
 *   [ PARAMS | INFO | HEADER | INSTRUMENTS | SEQUENCES | FRAMES | PATTERNS | DPCM SAMPLES |
 *     SEQUENCES_VRC6 | SEQUENCES_N163 | SEQUENCES_S5B | GROOVES | DETUNETABLES | END ]
 */

import {
  ExpansionChipName,
  FAMITRACKER_EXPANSION,
  FamiTrackerDpcmSample,
  FamiTrackerEffectEntry,
  FamiTrackerInstrument,
  FamiTrackerModule,
  FamiTrackerPatternCell,
  FamiTrackerSequence,
  FamiTrackerSong,
  NesMachineStandard,
} from './types';
import { buildFamiTrackerChannelDescriptors, decodeExpansionMask } from './dnEffects';

const FTM_NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

// Standard FamiTracker effect ID table (mapped by binary enum id from FamiTracker source)
const FTM_EFFECT_CHARS = [
  '.', // 0: EF_NONE
  'F', // 1: EF_SPEED
  'B', // 2: EF_JUMP
  'D', // 3: EF_SKIP
  'C', // 4: EF_HALT
  'E', // 5: EF_VOLUME
  '3', // 6: EF_PORTAMENTO
  '.', // 7: EF_PORTAOFF (legacy)
  'H', // 8: EF_SWEEPUP
  'I', // 9: EF_SWEEPDOWN
  '0', // 10: EF_ARPEGGIO
  '4', // 11: EF_VIBRATO
  '7', // 12: EF_TREMOLO
  'P', // 13: EF_PITCH
  'G', // 14: EF_DELAY
  'Z', // 15: EF_DAC
  '1', // 16: EF_PORTA_UP
  '2', // 17: EF_PORTA_DOWN
  'V', // 18: EF_DUTY_CYCLE
  'Y', // 19: EF_SAMPLE_OFFSET
  'Q', // 20: EF_SLIDE_UP
  'R', // 21: EF_SLIDE_DOWN
  'A', // 22: EF_VOLUME_SLIDE
  'S', // 23: EF_NOTE_CUT
  'X', // 24: EF_RETRIGGER
  'S', // 25: EF_DELAYED_VOLUME (legacy alias)
  'W', // 26: EF_DPCM_PITCH / FDS_MOD_SPEED_HI
  'J', // 27: EF_SUNSOFT_ENV_TYPE / FDS_MOD_DEPTH
  'H', // 28: EF_FDS_MOD_SPEED_HI
  'I', // 29: EF_FDS_MOD_SPEED_LO
  'Z', // 30: EF_FDS_MOD_BIAS
  'O', // 31: EF_GROOVE
  'T', // 32: EF_TRANSPOSE
  'N', // 33: EF_N163_WAVE_BUFFER / Dn target vol slide
  'L', // 34: EF_NOTE_RELEASE
  '=', // 35: EF_PHASE_RESET (Dn-FamiTracker)
  'K', // 36: EF_FREQ_MULTIPLIER (Dn-FamiTracker)
];

class BinaryCursor {
  public pos = 0;
  private u8: Uint8Array;
  private view: DataView;

  constructor(buffer: ArrayBuffer) {
    this.u8 = new Uint8Array(buffer);
    this.view = new DataView(buffer);
  }

  public get length(): number {
    return this.u8.length;
  }

  public remaining(): number {
    return Math.max(0, this.u8.length - this.pos);
  }

  public u8Read(): number {
    if (this.pos >= this.u8.length) return 0;
    return this.u8[this.pos++];
  }

  public i8Read(): number {
    if (this.pos >= this.u8.length) return 0;
    const v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }

  public u16Read(): number {
    if (this.pos + 2 > this.u8.length) return 0;
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  public u32Read(): number {
    if (this.pos + 4 > this.u8.length) return 0;
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  public i32Read(): number {
    if (this.pos + 4 > this.u8.length) return 0;
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  public fixedString(byteLen: number): string {
    const end = Math.min(this.u8.length, this.pos + byteLen);
    let zeroAt = end;
    for (let i = this.pos; i < end; i++) {
      if (this.u8[i] === 0) {
        zeroAt = i;
        break;
      }
    }
    const raw = this.u8.subarray(this.pos, zeroAt);
    this.pos = end;
    try {
      return new TextDecoder('utf-8', { fatal: false })
        .decode(raw)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim();
    } catch {
      let out = '';
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] >= 0x20 && raw[i] <= 0x7e) out += String.fromCharCode(raw[i]);
      }
      return out.trim();
    }
  }

  public nullString(maxBytes = 256): string {
    const start = this.pos;
    let read = 0;
    while (this.pos < this.u8.length && read < maxBytes) {
      const b = this.u8[this.pos++];
      read++;
      if (b === 0) break;
    }
    const end = this.pos > start && this.u8[this.pos - 1] === 0 ? this.pos - 1 : this.pos;
    const raw = this.u8.subarray(start, end);
    try {
      return new TextDecoder('utf-8', { fatal: false })
        .decode(raw)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim();
    } catch {
      let out = '';
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] >= 0x20 && raw[i] <= 0x7e) out += String.fromCharCode(raw[i]);
      }
      return out.trim();
    }
  }

  public lenString(): string {
    const len = this.u32Read();
    if (len === 0 || len > 4096) return '';
    return this.fixedString(len);
  }

  public bytes(n: number): Uint8Array {
    const end = Math.min(this.u8.length, this.pos + Math.max(0, n));
    const slice = this.u8.slice(this.pos, end);
    this.pos = end;
    return slice;
  }

  public seek(offset: number) {
    this.pos = Math.max(0, Math.min(this.u8.length, offset));
  }
}

export function formatFamiTrackerNote(note: number, octave: number): {
  noteId: number;
  noteName: string;
} {
  if (note === 0) return { noteId: 0, noteName: '---' };
  if (note === 14) return { noteId: 97, noteName: '===' }; // NOTE_HALT / CUT
  if (note === 13) return { noteId: 98, noteName: 'OFF' }; // NOTE_RELEASE
  if (note >= 1 && note <= 12) {
    const idx = note - 1;
    const clampedOct = Math.max(0, Math.min(7, octave));
    const noteId = clampedOct * 12 + idx + 1;
    return { noteId, noteName: `${FTM_NOTE_NAMES[idx]}${clampedOct}` };
  }
  return { noteId: 0, noteName: '---' };
}

function instTypeToChip(instType: number): ExpansionChipName {
  switch (instType) {
    case 2:
      return 'VRC6';
    case 3:
      return 'VRC7';
    case 4:
      return 'FDS';
    case 5:
      return 'N163';
    case 6:
      return 'Sunsoft 5B';
    default:
      return '2A03';
  }
}

function decodeEffectPair(effCode: number, effParam: number): FamiTrackerEffectEntry | null {
  if (effCode <= 0) return null;
  const cmdChar =
    effCode < FTM_EFFECT_CHARS.length
      ? FTM_EFFECT_CHARS[effCode]
      : effCode >= 0x20 && effCode <= 0x7e
        ? String.fromCharCode(effCode).toUpperCase()
        : '.';
  if (!cmdChar || cmdChar === '.') return null;
  const hex = Math.max(0, Math.min(255, effParam))
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  return {
    code: cmdChar,
    param: effParam & 0xff,
    token: `${cmdChar}${hex}`,
  };
}

function toAriaFxToken(eff: FamiTrackerEffectEntry): string {
  // Preserve 4-char Aria48 cell tokens cleanly while distinguishing Dn-FT extensions
  const hex = eff.param.toString(16).toUpperCase().padStart(2, '0');
  if (eff.code === '=') return `=${hex}`;
  if (eff.code === 'N') return `N${hex}`;
  if (eff.code === 'K') return `K${hex}`;
  if (eff.code === 'J') return `J${hex}`;
  if (/^[0-9A-F]$/.test(eff.code)) return `0${eff.code}${hex}`;
  return `${eff.code}${hex}`.padEnd(4, ' ').trim();
}

export function isFamiTrackerFileName(fileName: string): boolean {
  const lower = (fileName || '').toLowerCase();
  return lower.endsWith('.ftm') || lower.endsWith('.0cc') || lower.endsWith('.dnm');
}

export function parseFamiTrackerBinary(
  buffer: ArrayBuffer,
  fileName = 'module.ftm'
): FamiTrackerModule {
  const lower = fileName.toLowerCase();
  const format: 'ftm' | '0cc' | 'dnm' = lower.endsWith('.dnm')
    ? 'dnm'
    : lower.endsWith('.0cc')
      ? '0cc'
      : 'ftm';

  const cur = new BinaryCursor(buffer);
  const parseNotes: string[] = [];

  // Read magic header (typically 18..22 bytes)
  const peekHeader = new TextDecoder('ascii', { fatal: false }).decode(
    new Uint8Array(buffer, 0, Math.min(32, buffer.byteLength))
  );

  let magicFound = false;
  let version = 0x0440;

  if (peekHeader.startsWith('Dn-FamiTracker Module')) {
    cur.seek(21);
    version = cur.u32Read();
    magicFound = true;
    parseNotes.push(`[DNM] Dn-FamiTracker binary module v0x${version.toString(16)}`);
  } else if (peekHeader.startsWith('0CC-FamiTracker Module')) {
    cur.seek(22);
    version = cur.u32Read();
    magicFound = true;
    parseNotes.push(`[0CC] 0CC-FamiTracker binary module v0x${version.toString(16)}`);
  } else if (peekHeader.startsWith('FamiTracker Module')) {
    cur.seek(18);
    version = cur.u32Read();
    magicFound = true;
    parseNotes.push(`[FTM] FamiTracker binary module v0x${version.toString(16)}`);
  } else {
    parseNotes.push(`[FTM] Custom/untagged ${format.toUpperCase()} binary, attempting block scan`);
  }

  let title = fileName.replace(/\.[^/.]+$/, '') || 'FamiTracker Module';
  let author = 'Unknown Composer';
  let copyright = '';
  let expansionMask = 0;
  let machine: NesMachineStandard = 'NTSC';
  let engineSpeedHz = 0;
  let vibratoStyle = 1;
  let n163Channels = 1;
  let parsedChannelsCount = 5;

  const songs: FamiTrackerSong[] = [
    {
      index: 0,
      name: 'Track 1',
      speed: 6,
      tempo: 150,
      rowsPerPattern: 64,
      framesCount: 1,
      frameList: [[0, 0, 0, 0, 0]],
      patterns: {},
    },
  ];
  const sequences: FamiTrackerSequence[] = [];
  const instruments: FamiTrackerInstrument[] = [];
  const dpcmSamples: FamiTrackerDpcmSample[] = [];
  const fxColumnsByChannel: number[] = [];
  const fxColumnsByTrack: number[][] = [[]];
  const headerChannelIds: number[] = [];

  const isPlausibleNameHeader = (pos: number): boolean => {
    if (pos + 4 > cur.length) return false;
    const saved = cur.pos;
    cur.seek(pos);
    const len = cur.u32Read();
    if (len > 128 || pos + 4 + len > cur.length) {
      cur.seek(saved);
      return false;
    }
    const bytes = cur.bytes(len);
    cur.seek(saved);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      // Allow ASCII printable, common whitespace (tab/nl), and UTF-8 continuation/leading bytes (>= 0x80)
      if (b !== 0 && ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f)) {
        return false;
      }
    }
    return true;
  };

  const tryReadSequencesLayout = (
    startPos: number,
    count: number,
    blockEnd: number,
    chipForBlock: ExpansionChipName,
    layout: 'v6' | 'v5' | 'v4' | 'v3' | 'v2' | 'v1'
  ): { ok: boolean; endPos: number; items: FamiTrackerSequence[] } => {
    const out: FamiTrackerSequence[] = [];
    cur.seek(startPos);
    for (let i = 0; i < count; i++) {
      const minHeader = layout === 'v1' ? 9 : layout === 'v4' ? 21 : layout === 'v3' ? 17 : 13;
      if (cur.pos + minHeader > blockEnd) return { ok: false, endPos: cur.pos, items: out };
      const seqIdx = cur.u32Read();
      const seqType = cur.u32Read();
      const itemCount = cur.u8Read();
      if (seqIdx > 512 || seqType > 5) return { ok: false, endPos: cur.pos, items: out };
      const loopPoint = layout === 'v1' ? -1 : cur.i32Read();
      const releasePoint = layout === 'v4' || layout === 'v3' ? cur.i32Read() : -1;
      const setting = layout === 'v4' ? cur.u32Read() : 0;
      if (loopPoint < -1 || loopPoint > 256 || releasePoint < -1 || releasePoint > 256 || setting > 64) {
        return { ok: false, endPos: cur.pos, items: out };
      }
      if (cur.pos + itemCount > blockEnd) return { ok: false, endPos: cur.pos, items: out };
      const items: number[] = [];
      for (let k = 0; k < itemCount; k++) {
        items.push(cur.i8Read());
      }
      out.push({
        index: seqIdx,
        type: seqType,
        chip: chipForBlock,
        loopPoint,
        releasePoint,
        setting,
        items,
      });
    }

    if (layout === 'v6') {
      if (cur.pos + count * 8 <= blockEnd) {
        for (let i = 0; i < count; i++) {
          const rel = cur.i32Read();
          const set = cur.u32Read();
          if (rel < -1 || rel > 256 || set > 64) {
            return { ok: false, endPos: cur.pos, items: out };
          }
          out[i].releasePoint = rel;
          out[i].setting = set;
        }
      }
    } else if (layout === 'v5') {
      if (cur.pos + count * 4 <= blockEnd) {
        for (let i = 0; i < count; i++) {
          const rel = cur.i32Read();
          if (rel < -1 || rel > 256) {
            return { ok: false, endPos: cur.pos, items: out };
          }
          out[i].releasePoint = rel;
        }
      }
    }

    return { ok: cur.pos === blockEnd, endPos: cur.pos, items: out };
  };

  if (magicFound) {
    let safety = 0;
    while (cur.remaining() >= 24 && safety++ < 256) {
      const blockId = cur.fixedString(16);
      if (!blockId || blockId === 'END') break;
      const blockVersion = cur.u32Read();
      const blockSize = cur.u32Read();
      const blockEnd = Math.min(cur.length, cur.pos + blockSize);

      try {
        if (blockId === 'PARAMS') {
          if (blockVersion === 1) {
            songs[0].speed = Math.max(1, cur.u32Read() || 6);
            parsedChannelsCount = cur.u32Read() || 5;
          } else {
            expansionMask = cur.u8Read();
            parsedChannelsCount = Math.max(5, cur.u32Read() || 5);
            const machineCode = cur.u32Read();
            machine = machineCode === 1 ? 'PAL' : machineCode === 2 ? 'Dendy' : 'NTSC';
            engineSpeedHz = cur.u32Read();
            if (blockVersion > 2) vibratoStyle = cur.u32Read();
            if (blockVersion >= 4) {
              cur.u32Read(); // highlight 1
              cur.u32Read(); // highlight 2
            }
            if (blockVersion >= 5 && (expansionMask & FAMITRACKER_EXPANSION.N163)) {
              n163Channels = Math.max(1, Math.min(8, cur.u32Read() || 1));
            }
            if (blockVersion >= 6) {
              cur.u32Read(); // speed split point
            }
          }
          parseNotes.push(
            `[PARAMS] Machine: ${machine} | ExpMask: 0x${expansionMask.toString(16).toUpperCase().padStart(2, '0')} | Channels: ${parsedChannelsCount}`
          );
        } else if (blockId === 'INFO') {
          const t = cur.fixedString(32);
          const a = cur.fixedString(32);
          const c = cur.fixedString(32);
          if (t) title = t;
          if (a) author = a;
          if (c) copyright = c;
          parseNotes.push(`[INFO] "${title}" by ${author}`);
        } else if (blockId === 'HEADER') {
          const trackCount = blockVersion >= 2 ? Math.max(1, cur.u8Read() + 1) : 1;
          while (songs.length < trackCount) {
            songs.push({
              index: songs.length,
              name: `Track ${songs.length + 1}`,
              speed: songs[0].speed,
              tempo: songs[0].tempo,
              rowsPerPattern: 64,
              framesCount: 1,
              frameList: [],
              patterns: {},
            });
          }
          while (fxColumnsByTrack.length < trackCount) {
            fxColumnsByTrack.push([]);
          }
          if (blockVersion >= 3) {
            for (let t = 0; t < trackCount && cur.pos < blockEnd; t++) {
              const sName = cur.nullString(64);
              if (sName) songs[t].name = sName;
            }
          }
          for (let ch = 0; ch < parsedChannelsCount && cur.pos < blockEnd; ch++) {
            const chanId = cur.u8Read(); // channel id
            headerChannelIds.push(chanId);
            for (let t = 0; t < trackCount && cur.pos < blockEnd; t++) {
              const fxCols = Math.max(1, Math.min(4, cur.u8Read() + 1));
              if (!fxColumnsByTrack[t]) fxColumnsByTrack[t] = [];
              fxColumnsByTrack[t][ch] = fxCols;
              if (t === 0) fxColumnsByChannel[ch] = fxCols;
            }
          }
        } else if (
          blockId === 'SEQUENCES' ||
          blockId === 'SEQUENCES_VRC6' ||
          blockId === 'SEQUENCES_N163' ||
          blockId === 'SEQUENCES_S5B'
        ) {
          const chipForBlock: ExpansionChipName =
            blockId === 'SEQUENCES_VRC6'
              ? 'VRC6'
              : blockId === 'SEQUENCES_N163'
                ? 'N163'
                : blockId === 'SEQUENCES_S5B'
                  ? 'Sunsoft 5B'
                  : '2A03';
          const count = Math.min(512, cur.u32Read());
          if (count > 0) {
            const startPos = cur.pos;
            const candidates: Array<'v6' | 'v5' | 'v4' | 'v3' | 'v2' | 'v1'> =
              blockId === 'SEQUENCES_N163' || blockId === 'SEQUENCES_S5B'
                ? ['v4', 'v6', 'v3', 'v2']
                : blockVersion >= 6
                  ? ['v6', 'v4', 'v5', 'v3', 'v2']
                  : blockVersion === 5
                    ? ['v6', 'v5', 'v4', 'v3', 'v2']
                    : blockVersion >= 3
                      ? ['v4', 'v3', 'v6', 'v2']
                      : blockVersion === 2
                        ? ['v2', 'v4', 'v3']
                        : ['v1', 'v2'];

            let chosen: FamiTrackerSequence[] | null = null;
            let bestItems: FamiTrackerSequence[] = [];
            let bestDelta = Number.MAX_SAFE_INTEGER;
            for (const lay of candidates) {
              const res = tryReadSequencesLayout(startPos, count, blockEnd, chipForBlock, lay);
              if (res.ok) {
                chosen = res.items;
                break;
              }
              const delta = Math.abs(blockEnd - res.endPos);
              if (
                res.items.length > bestItems.length ||
                (res.items.length === bestItems.length && delta < bestDelta)
              ) {
                bestItems = res.items;
                bestDelta = delta;
              }
            }
            const finalSeqs = chosen || bestItems;
            sequences.push(...finalSeqs);
          }
        } else if (blockId === 'INSTRUMENTS') {
          const count = Math.min(128, cur.u32Read());
          for (let i = 0; i < count && cur.pos + 5 <= blockEnd; i++) {
            const instIdx = cur.u32Read();
            const instType = cur.u8Read();
            const chip = instTypeToChip(instType);
            const seqIndices: [number, number, number, number, number] = [-1, -1, -1, -1, -1];
            const inst: FamiTrackerInstrument = {
              index: instIdx,
              name: `Inst ${instIdx.toString(16).toUpperCase().padStart(2, '0')}`,
              chip,
              seqIndices,
            };

            if (instType === 1 || instType === 2 || instType === 5 || instType === 6) {
              const seqCount = Math.min(5, cur.u32Read());
              for (let s = 0; s < seqCount && cur.pos + 5 <= blockEnd; s++) {
                const enabled = cur.u8Read();
                const idx = cur.u32Read();
                if (enabled) seqIndices[s] = idx;
              }

              if (instType === 1) {
                // 2A03 DPCM Keymap Table (v1: 72*2=144 bytes, v2..v5: 96*2=192 bytes, v6+: 96*3=288 bytes)
                const keysCount = blockVersion === 1 ? 72 : 96;
                const remainingBytes = blockEnd - cur.pos;
                let hasDeltaByte = blockVersion >= 6;
                if (blockVersion >= 6) {
                  // Verify 288 vs 192 bytes cleanly using the trailing instrument name length header
                  const canBe3 = remainingBytes >= keysCount * 3 + 4 && isPlausibleNameHeader(cur.pos + keysCount * 3);
                  const canBe2 = remainingBytes >= keysCount * 2 + 4 && isPlausibleNameHeader(cur.pos + keysCount * 2);
                  if (!canBe3 && canBe2) hasDeltaByte = false;
                } else if (remainingBytes >= keysCount * 3 + 4 && !isPlausibleNameHeader(cur.pos + keysCount * 2) && isPlausibleNameHeader(cur.pos + keysCount * 3)) {
                  hasDeltaByte = true;
                }
                const entryBytes = hasDeltaByte ? 3 : 2;
                if (cur.pos + keysCount * entryBytes <= blockEnd) {
                  const dpcmMap: { pitch: number; loop: boolean; sampleIndex: number; deltaCounter: number }[] =
                    Array.from({ length: 96 }, () => ({
                      pitch: 15,
                      loop: false,
                      sampleIndex: -1,
                      deltaCounter: -1,
                    }));
                  for (let k = 0; k < keysCount; k++) {
                    const sampleOneBased = cur.u8Read();
                    const rawPitch = cur.u8Read();
                    const rawDelta = hasDeltaByte ? cur.u8Read() : 255;
                    if (sampleOneBased > 0) {
                      dpcmMap[k] = {
                        sampleIndex: sampleOneBased - 1,
                        pitch: rawPitch & 0x0f,
                        loop: (rawPitch & 0x80) !== 0,
                        deltaCounter: rawDelta >= 128 ? -1 : rawDelta,
                      };
                    }
                  }
                  inst.dpcmMap = dpcmMap;
                }
              } else if (instType === 5) {
                // N163 Wave Size, Wave Pos, and Waveforms
                if (cur.pos + 8 <= blockEnd) {
                  const waveSize = Math.max(4, Math.min(256, cur.u32Read() || 32));
                  const wavePos = cur.u32Read();
                  let waveCount = 1;
                  if (cur.pos + 4 <= blockEnd) {
                    const posBeforeCount = cur.pos;
                    const candidateCount = cur.u32Read();
                    const hasCountAndName =
                      candidateCount > 0 &&
                      candidateCount <= 64 &&
                      posBeforeCount + 4 + candidateCount * waveSize + 4 <= blockEnd &&
                      isPlausibleNameHeader(posBeforeCount + 4 + candidateCount * waveSize);
                    const hasSingleWaveAndName =
                      posBeforeCount + waveSize + 4 <= blockEnd &&
                      isPlausibleNameHeader(posBeforeCount + waveSize);
                    if (hasCountAndName || (blockVersion >= 8 && candidateCount > 0 && candidateCount <= 64 && posBeforeCount + 4 + candidateCount * waveSize <= blockEnd)) {
                      waveCount = candidateCount;
                    } else if (hasSingleWaveAndName || !candidateCount || candidateCount > 64) {
                      cur.seek(posBeforeCount);
                    } else {
                      waveCount = candidateCount;
                    }
                  }
                  inst.n163WaveSize = waveSize;
                  inst.n163WavePos = wavePos;
                  const waves: Uint8Array[] = [];
                  for (let w = 0; w < waveCount && cur.pos + waveSize <= blockEnd; w++) {
                    waves.push(cur.bytes(waveSize));
                  }
                  if (waves.length > 0) inst.n163Waves = waves;
                }
              }
            } else if (instType === 3) {
              inst.vrc7Patch = cur.u32Read();
              inst.vrc7CustomRegs = cur.bytes(8);
            } else if (instType === 4) {
              inst.fdsWave = cur.bytes(64);
              inst.fdsModTable = new Int8Array(cur.bytes(32));
              inst.fdsModSpeed = cur.u32Read();
              inst.fdsModDepth = cur.u32Read();
              inst.fdsModDelay = cur.u32Read();
              // FDS instruments in v2+ embed 3 inline sequences (Vol, Arp, Pitch) before nameLen
              if (!isPlausibleNameHeader(cur.pos) && cur.pos + 13 < blockEnd) {
                for (let sType = 0; sType < 3 && cur.pos + 13 < blockEnd; sType++) {
                  const itemCount = cur.u8Read();
                  const loopPoint = cur.i32Read();
                  const releasePoint = cur.i32Read();
                  const setting = cur.u32Read();
                  if (cur.pos + itemCount > blockEnd) break;
                  const items: number[] = [];
                  for (let k = 0; k < itemCount; k++) items.push(cur.i8Read());
                  const syntheticSeqIdx = 1000 + instIdx * 4 + sType;
                  seqIndices[sType] = syntheticSeqIdx;
                  sequences.push({
                    index: syntheticSeqIdx,
                    type: sType,
                    chip: 'FDS',
                    loopPoint,
                    releasePoint,
                    setting,
                    items,
                  });
                }
              }
            }

            // Read instrument name length + characters
            if (cur.pos + 4 <= blockEnd) {
              const nameLen = cur.u32Read();
              if (nameLen > 0 && nameLen <= 128 && cur.pos + nameLen <= blockEnd) {
                const nm = cur.fixedString(nameLen);
                if (nm) inst.name = nm;
              }
            }
            instruments.push(inst);
          }
          parseNotes.push(`[INSTRUMENTS] Parsed ${instruments.length} instrument(s).`);
        } else if (blockId === 'FRAMES') {
          for (let t = 0; t < songs.length && cur.pos < blockEnd; t++) {
            const framesCount = Math.max(1, Math.min(256, cur.u32Read()));
            const speed = Math.max(1, cur.u32Read() || 6);
            const tempo = blockVersion >= 2 ? Math.max(30, cur.u32Read() || 150) : 150;
            const rowsPerPattern = Math.max(1, Math.min(256, cur.u32Read() || 64));
            const frameList: number[][] = [];
            for (let f = 0; f < framesCount && cur.pos < blockEnd; f++) {
              const chList: number[] = [];
              for (let ch = 0; ch < parsedChannelsCount && cur.pos < blockEnd; ch++) {
                chList.push(cur.u8Read());
              }
              frameList.push(chList);
            }
            songs[t].framesCount = framesCount;
            songs[t].speed = speed;
            songs[t].tempo = tempo;
            songs[t].rowsPerPattern = rowsPerPattern;
            songs[t].frameList = frameList;
          }
        } else if (blockId === 'PATTERNS') {
          const minHeaderBytes = blockVersion >= 2 ? 16 : 12;
          while (cur.pos + minHeaderBytes <= blockEnd) {
            const trackIdx = blockVersion >= 2 ? cur.u32Read() : 0;
            const channelIdx = cur.u32Read();
            const patternIdx = cur.u32Read();
            const itemCount = Math.min(1024, cur.u32Read());
            const targetSong = songs[trackIdx] || songs[0];
            const key = `${channelIdx}:${patternIdx}`;
            const rows: FamiTrackerPatternCell[] = targetSong.patterns[key] ? [...targetSong.patterns[key]] : [];
            const fxCols =
              blockVersion === 1
                ? 1
                : fxColumnsByTrack[trackIdx]?.[channelIdx] ?? fxColumnsByChannel[channelIdx] ?? 1;

            for (let k = 0; k < itemCount && cur.pos + 8 <= blockEnd; k++) {
              const row = cur.u32Read();
              const rawNote = cur.u8Read();
              const rawOctave = cur.u8Read();
              const rawInst = cur.u8Read();
              const rawVol = cur.u8Read();
              const fxList: FamiTrackerEffectEntry[] = [];
              for (let fc = 0; fc < fxCols && cur.pos + 2 <= blockEnd; fc++) {
                const effCode = cur.u8Read();
                const effParam = cur.u8Read();
                const parsedEff = decodeEffectPair(effCode, effParam);
                if (parsedEff) fxList.push(parsedEff);
              }

              const { noteId, noteName } = formatFamiTrackerNote(rawNote, rawOctave);
              rows.push({
                row,
                note: noteId,
                noteName,
                instrument: rawInst >= 64 ? -1 : rawInst,
                volume: rawVol >= 16 ? -1 : rawVol,
                effects: fxList,
              });
            }
            if (rows.length > 0) {
              targetSong.patterns[key] = rows;
            }
          }
          const totalPatCells = Object.values(songs[0].patterns).reduce((s, r) => s + r.length, 0);
          parseNotes.push(`[PATTERNS] Decoded ${totalPatCells} non-empty FamiTracker events.`);
        } else if (blockId === 'DPCM SAMPLES') {
          const count = Math.min(64, cur.u32Read());
          for (let i = 0; i < count && cur.pos < blockEnd; i++) {
            const entryStart = cur.pos;
            const looksLikeU8Idx = cur.pos + 9 <= blockEnd && isPlausibleNameHeader(cur.pos + 1);
            const looksLikeU32Idx = cur.pos + 12 <= blockEnd && isPlausibleNameHeader(cur.pos + 4);
            const idx = !looksLikeU8Idx && looksLikeU32Idx ? cur.u32Read() : cur.u8Read();
            const name = cur.lenString() || `DPCM_${idx}`;
            const rawSize = cur.u32Read();
            const size = Math.max(0, Math.min(blockEnd - cur.pos, Math.min(65536, rawSize)));
            if (cur.pos <= entryStart) break;
            const data = cur.bytes(size);
            dpcmSamples.push({ index: idx, name, data });
          }
          if (dpcmSamples.length > 0) {
            parseNotes.push(`[DPCM] Loaded ${dpcmSamples.length} hardware 1-bit delta sample(s).`);
          }
        }
      } catch (blockErr: any) {
        parseNotes.push(`[WARN] Partial read on block ${blockId}: ${blockErr?.message || 'truncated'}`);
      }

      cur.seek(blockEnd);
    }
  }

  // Ensure every song has a valid frameList and pattern fallback if empty
  const expansions = decodeExpansionMask(expansionMask);
  const channels = buildFamiTrackerChannelDescriptors(
    expansionMask,
    n163Channels,
    headerChannelIds.length >= parsedChannelsCount ? headerChannelIds : undefined
  );
  const effectiveChCount = Math.max(channels.length, parsedChannelsCount);

  // Populate parsed per-channel FX column widths and compute module max
  const parsedFxMax = Math.max(
    1,
    ...fxColumnsByChannel,
    ...fxColumnsByTrack.flat()
  );
  channels.forEach((ch, idx) => {
    ch.fxColumns = Math.max(1, Math.min(4, fxColumnsByChannel[idx] || parsedFxMax || 1));
  });

  songs.forEach((song) => {
    if (song.frameList.length === 0) {
      song.frameList = [Array.from({ length: effectiveChCount }, () => 0)];
      song.framesCount = 1;
    }
  });

  return {
    format,
    fileName,
    version,
    title,
    author,
    copyright,
    machine,
    engineSpeedHz,
    vibratoStyle,
    expansionMask,
    expansions,
    n163Channels,
    channelsCount: effectiveChCount,
    maxFxColumns: Math.max(1, Math.min(4, parsedFxMax)),
    channels,
    songs,
    sequences,
    instruments,
    dpcmSamples,
    parseNotes,
  };
}

/**
 * Converts a parsed FamiTrackerModule into Aria48's pattern grid matrix + full metadata.
 */
export function convertFamiTrackerToAriaPatterns(
  mod: FamiTrackerModule,
  songIndex = 0
): {
  patterns: any[];
  allPatterns: any[][];
  bpm: number;
  durationSeconds: number;
  channelsCount: number;
  chipType: string;
} {
  const song = mod.songs[songIndex] || mod.songs[0];
  const chCount = Math.min(48, Math.max(5, mod.channels.length || mod.channelsCount));
  const rowCap = Math.max(1, Math.min(256, song.rowsPerPattern || 64));

  const allPatterns: any[][] = [];
  for (let orderIdx = 0; orderIdx < Math.min(128, song.frameList.length); orderIdx++) {
    const orderPats = song.frameList[orderIdx] || [];
    const patGrid: any[] = Array.from({ length: rowCap }, () => {
      const rowObj: any = {};
      for (let c = 1; c <= Math.max(8, chCount); c++) {
        rowObj[c] = { note: '---', inst: '..', vol: '..', delay: '000', fx: ['....', '....', '....', '....'] };
      }
      return rowObj;
    });

    for (let ch = 0; ch < chCount; ch++) {
      const patId = orderPats[ch] ?? 0;
      const cells = song.patterns[`${ch}:${patId}`] || [];
      for (const cell of cells) {
        if (cell.row >= 0 && cell.row < rowCap) {
          const fxTokens = ['....', '....', '....', '....'];
          cell.effects.slice(0, 4).forEach((fx, i) => {
            fxTokens[i] = toAriaFxToken(fx);
          });
          patGrid[cell.row][ch + 1] = {
            note: cell.noteName,
            inst: cell.instrument >= 0 ? cell.instrument.toString(16).toUpperCase().padStart(2, '0') : '..',
            vol: cell.volume >= 0 ? Math.min(100, Math.round((cell.volume / 15) * 99)).toString().padStart(2, '0') : '..',
            delay: '000',
            fx: fxTokens,
          };
        }
      }
    }
    allPatterns.push(patGrid);
  }

  if (allPatterns.length === 0) {
    allPatterns.push(
      Array.from({ length: rowCap }, () => {
        const rowObj: any = {};
        for (let c = 1; c <= 8; c++) {
          rowObj[c] = { note: '---', inst: '..', vol: '..', delay: '000', fx: ['....', '....', '....', '....'] };
        }
        return rowObj;
      })
    );
  }

  // Exact FamiTracker effective BPM formula: tempo * (6 / speed)
  const effectiveBpm = Math.max(
    40,
    Math.min(300, Math.round(((song.tempo || 150) * 6) / Math.max(1, song.speed || 6)))
  );
  const ticksPerSec = mod.machine === 'PAL' ? 50 : 60;
  const rowsPerSec = (ticksPerSec * ((song.tempo || 150) / 150)) / Math.max(1, song.speed || 6);
  const totalRows = Math.max(rowCap, song.frameList.length * rowCap);
  const durationSeconds = Math.max(8, totalRows / Math.max(1, rowsPerSec));

  const expLabel =
    mod.expansions.length > 1 ? ` + ${mod.expansions.slice(1).join('/')}` : '';
  const chipType = `RP2A03 (NES APU)${expLabel}`;

  return {
    patterns: allPatterns[0],
    allPatterns,
    bpm: effectiveBpm,
    durationSeconds,
    channelsCount: chCount,
    chipType,
  };
}
