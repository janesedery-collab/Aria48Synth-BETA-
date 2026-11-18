/**
 * hvscManager.ts
 * Pure TypeScript Commodore 64 SID (PSID/RSID v1-v4) Binary Header Parser,
 * RFC 1321 MD5 Hasher, and HVSC Songlengths.md5 + STIL.txt Parser & IndexedDB Cache.
 */

export type SidChipModelType = 'MOS 6581' | 'MOS 8580' | 'MOS 6581 / 8580' | 'Unknown';
export type SidClockType = 'PAL 50Hz' | 'NTSC 60Hz' | 'PAL / NTSC' | 'Unknown';

export interface SidHeaderMetadata {
  isValid: boolean;
  magic: 'PSID' | 'RSID' | 'MUS' | 'UNKNOWN';
  version: number;
  dataOffset: number;
  loadAddress: number;
  initAddress: number;
  playAddress: number;
  songs: number;
  startSong: number;
  speedFlags: number;
  title: string;
  author: string;
  released: string;
  flags: number;
  clock: SidClockType;
  isNtscDefault: boolean;
  chipModel: SidChipModelType;
  sid2Model: SidChipModelType;
  sid3Model: SidChipModelType;
  defaultIs6581: boolean;
  chipCount: 1 | 2 | 3;
  chipCountLabel: '1SID' | '2SID' | '3SID';
  secondSIDAddress: number | null;
  thirdSIDAddress: number | null;
  isComputeMus: boolean;
  isBasicRsid: boolean;
  md5: string;
  legacyMd5: string;
  fileSize: number;
  fileName: string;
}

export interface SonglengthEntry {
  md5: string;
  hvscPath?: string;
  durationsSec: number[];
  formattedDurations: string[];
}

export interface StilSubtuneNote {
  subtune: number;
  text: string;
}

export interface StilEntry {
  hvscPath: string;
  fileName: string;
  title?: string;
  author?: string;
  artist?: string;
  comment?: string;
  subtuneNotes: StilSubtuneNote[];
  rawBlock: string;
}

export interface HvscLookupResult {
  songlength: SonglengthEntry | null;
  stil: StilEntry | null;
  matchedBy: 'md5' | 'legacyMd5' | 'path' | 'filename' | 'none';
  subtuneDurationsSec: number[];
  activeSubtuneDurationSec: number | null;
}

export interface HvscCacheStats {
  songlengthsCount: number;
  stilCount: number;
  songlengthsUpdatedAt: number | null;
  stilUpdatedAt: number | null;
}

const DB_NAME = 'aria48_hvsc_cache_v1';
const DB_VERSION = 1;
const STORE_NAME = 'hvsc_blobs';
const STATS_LS_KEY = 'aria48_hvsc_cache_stats';

// In-memory runtime indices for O(1) instant lookups across tabs
let songlengthMap = new Map<string, SonglengthEntry>();
let stilByPathMap = new Map<string, StilEntry>();
let stilByFilenameMap = new Map<string, StilEntry[]>();
let cacheStats: HvscCacheStats = {
  songlengthsCount: 0,
  stilCount: 0,
  songlengthsUpdatedAt: null,
  stilUpdatedAt: null
};
let initHydrationPromise: Promise<void> | null = null;
const hvscListeners = new Set<(stats: HvscCacheStats) => void>();

function notifyHvscListeners() {
  const snapshot = { ...cacheStats };
  hvscListeners.forEach((cb) => {
    try { cb(snapshot); } catch {}
  });
}

export function onHvscCacheChange(listener: (stats: HvscCacheStats) => void): () => void {
  hvscListeners.add(listener);
  return () => hvscListeners.delete(listener);
}

export function getHvscCacheStats(): HvscCacheStats {
  if (cacheStats.songlengthsCount === 0 && cacheStats.stilCount === 0 && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(STATS_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            songlengthsCount: Number(parsed.songlengthsCount) || 0,
            stilCount: Number(parsed.stilCount) || 0,
            songlengthsUpdatedAt: parsed.songlengthsUpdatedAt || null,
            stilUpdatedAt: parsed.stilUpdatedAt || null
          };
        }
      }
    } catch {}
  }
  return { ...cacheStats };
}

function persistCacheStatsToLs() {
  try {
    localStorage.setItem(STATS_LS_KEY, JSON.stringify(cacheStats));
  } catch {}
}

// --- RFC 1321 PURE TYPESCRIPT MD5 IMPLEMENTATION ---
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

export function computeMd5Hex(data: Uint8Array): string {
  const origLen = data.length;
  const bitLen = origLen * 8;
  const padLen = ((56 - ((origLen + 1) % 64)) + 64) % 64;
  const totalLen = origLen + 1 + padLen + 8;

  const buf = new Uint8Array(totalLen);
  buf.set(data, 0);
  buf[origLen] = 0x80;

  const view = new DataView(buf.buffer);
  // 64-bit little-endian length in bits
  view.setUint32(totalLen - 8, bitLen >>> 0, true);
  view.setUint32(totalLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301 >>> 0;
  let b0 = 0xefcdab89 >>> 0;
  let c0 = 0x98badcfe >>> 0;
  let d0 = 0x10325476 >>> 0;

  const M = new Uint32Array(16);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(offset + j * 4, true);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F = 0;
      let g = 0;
      if (i < 16) {
        F = (B & C) | ((~B) & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | ((~D) & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | (~D));
        g = (7 * i) % 16;
      }

      const temp = D;
      D = C;
      C = B;
      const sum = (A + F + MD5_K[i] + M[g]) >>> 0;
      const s = MD5_S[i];
      const rotated = ((sum << s) | (sum >>> (32 - s))) >>> 0;
      B = (B + rotated) >>> 0;
      A = temp;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);

  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += out[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function readExtAsciiString(u8: Uint8Array, start: number, maxLen: number): string {
  let out = '';
  const end = Math.min(u8.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const b = u8[i];
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out.trim();
}

function decodeSidAddressByte(byteVal: number): number | null {
  // Valid PSID v3/v4 SID2/SID3 base addresses encode $D420..$D7E0 (0x42..0x7E even)
  // or $DE00..$DFE0 (0xE0..0xFE even)
  if (byteVal === 0 || (byteVal & 0x01) !== 0) return null;
  if ((byteVal >= 0x42 && byteVal <= 0x7e) || (byteVal >= 0xe0 && byteVal <= 0xfe)) {
    return 0xd000 + (byteVal << 4);
  }
  return null;
}

function decodeSidModelBits(bits: number): SidChipModelType {
  switch (bits & 0x03) {
    case 1: return 'MOS 6581';
    case 2: return 'MOS 8580';
    case 3: return 'MOS 6581 / 8580';
    default: return 'Unknown';
  }
}

function decodeClockBits(bits: number): SidClockType {
  switch (bits & 0x03) {
    case 1: return 'PAL 50Hz';
    case 2: return 'NTSC 60Hz';
    case 3: return 'PAL / NTSC';
    default: return 'Unknown';
  }
}

/**
 * Computes legacy pre-HVSC#69 PSID MD5 hash (code bytes + init/play/songs/speed + NTSC flag)
 * as secondary fallback alongside the modern full-file MD5.
 */
function computeLegacyPsidMd5(
  u8: Uint8Array,
  dataOffset: number,
  headerLoadAddr: number,
  initAddr: number,
  playAddr: number,
  songs: number,
  speedFlags: number,
  isNtscOnly: boolean
): string {
  try {
    const bodyStart = headerLoadAddr === 0 ? Math.min(u8.length, dataOffset + 2) : Math.min(u8.length, dataOffset);
    const body = u8.subarray(bodyStart);
    const extraLen = 6 + songs + (isNtscOnly ? 1 : 0);
    const combined = new Uint8Array(body.length + extraLen);
    combined.set(body, 0);
    let p = body.length;
    combined[p++] = initAddr & 0xff;
    combined[p++] = (initAddr >> 8) & 0xff;
    combined[p++] = playAddr & 0xff;
    combined[p++] = (playAddr >> 8) & 0xff;
    combined[p++] = songs & 0xff;
    combined[p++] = (songs >> 8) & 0xff;
    for (let i = 0; i < songs; i++) {
      const bitIdx = Math.min(i, 31);
      combined[p++] = ((speedFlags >>> bitIdx) & 1) !== 0 ? 60 : 0;
    }
    if (isNtscOnly) {
      combined[p++] = 0x02;
    }
    return computeMd5Hex(combined);
  } catch {
    return '';
  }
}

export function formatHexAddr(addr: number | null | undefined): string {
  if (addr === null || addr === undefined || isNaN(addr)) return '$0000';
  return `$${addr.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function formatTimeMsPrecise(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  const wholeSecs = Math.floor(rem);
  const ms = Math.round((rem - wholeSecs) * 1000);
  const msStr = ms > 0 ? `.${ms.toString().padStart(3, '0')}` : '';
  return `${mins}:${wholeSecs.toString().padStart(2, '0')}${msStr}`;
}

/**
 * Full PSID / RSID v1-v4 Binary Header Parser + MD5 calculation
 */
export function parseSidHeader(arrayBuffer: ArrayBuffer, fileName = 'tune.sid'): SidHeaderMetadata {
  const u8 = new Uint8Array(arrayBuffer);
  const md5 = computeMd5Hex(u8);

  const magicStr = u8.length >= 4
    ? String.fromCharCode(u8[0], u8[1], u8[2], u8[3])
    : '';
  const isPsid = magicStr === 'PSID';
  const isRsid = magicStr === 'RSID';

  if ((!isPsid && !isRsid) || u8.length < 0x76) {
    return {
      isValid: false,
      magic: fileName.toLowerCase().endsWith('.mus') ? 'MUS' : 'UNKNOWN',
      version: 0,
      dataOffset: 0,
      loadAddress: 0,
      initAddress: 0,
      playAddress: 0,
      songs: 1,
      startSong: 1,
      speedFlags: 0,
      title: fileName.replace(/\.[^/.]+$/, ''),
      author: 'Unknown',
      released: 'Unknown',
      flags: 0,
      clock: 'PAL 50Hz',
      isNtscDefault: false,
      chipModel: 'MOS 6581',
      sid2Model: 'Unknown',
      sid3Model: 'Unknown',
      defaultIs6581: true,
      chipCount: 1,
      chipCountLabel: '1SID',
      secondSIDAddress: null,
      thirdSIDAddress: null,
      isComputeMus: false,
      isBasicRsid: false,
      md5,
      legacyMd5: '',
      fileSize: u8.length,
      fileName
    };
  }

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint16(0x04, false);
  const dataOffset = dv.getUint16(0x06, false);
  const rawLoadAddress = dv.getUint16(0x08, false);
  let loadAddress = rawLoadAddress;
  if (loadAddress === 0 && dataOffset + 2 <= u8.length) {
    loadAddress = u8[dataOffset] | (u8[dataOffset + 1] << 8);
  }
  const initAddress = dv.getUint16(0x0a, false);
  const playAddress = dv.getUint16(0x0c, false);
  const songs = Math.max(1, dv.getUint16(0x0e, false));
  const rawStartSong = dv.getUint16(0x10, false);
  const startSong = Math.max(1, Math.min(songs, rawStartSong || 1));
  const speedFlags = dv.getUint32(0x12, false);

  const title = readExtAsciiString(u8, 0x16, 32) || fileName.replace(/\.[^/.]+$/, '');
  const author = readExtAsciiString(u8, 0x36, 32) || 'Unknown';
  const released = readExtAsciiString(u8, 0x56, 32) || 'Unknown';

  let flags = 0;
  let secondSIDAddress: number | null = null;
  let thirdSIDAddress: number | null = null;

  if (version >= 2 && u8.length >= 0x7c) {
    flags = dv.getUint16(0x76, false);
    if (version >= 3) {
      secondSIDAddress = decodeSidAddressByte(u8[0x7a]);
    }
    if (version >= 4 && secondSIDAddress !== null) {
      thirdSIDAddress = decodeSidAddressByte(u8[0x7b]);
    }
  }

  const isComputeMus = (flags & 0x01) !== 0;
  const isBasicRsid = isRsid && (flags & 0x02) !== 0;
  const clockBits = (flags >> 2) & 0x03;
  const sid1Bits = (flags >> 4) & 0x03;
  const sid2Bits = (flags >> 6) & 0x03;
  const sid3Bits = (flags >> 8) & 0x03;

  const clock = decodeClockBits(clockBits);
  const isNtscDefault = clockBits === 2;
  const chipModel = sid1Bits === 0 ? 'MOS 6581' : decodeSidModelBits(sid1Bits);
  const sid2Model = sid2Bits === 0 ? chipModel : decodeSidModelBits(sid2Bits);
  const sid3Model = sid3Bits === 0 ? chipModel : decodeSidModelBits(sid3Bits);
  const defaultIs6581 = sid1Bits !== 2; // MOS 8580 = 2

  const chipCount: 1 | 2 | 3 =
    secondSIDAddress !== null && thirdSIDAddress !== null
      ? 3
      : secondSIDAddress !== null
        ? 2
        : 1;
  const chipCountLabel: '1SID' | '2SID' | '3SID' =
    chipCount === 3 ? '3SID' : chipCount === 2 ? '2SID' : '1SID';

  const legacyMd5 = computeLegacyPsidMd5(
    u8,
    dataOffset,
    rawLoadAddrSafe(rawLoadAddress),
    initAddress,
    playAddress,
    songs,
    speedFlags,
    isNtscDefault
  );

  return {
    isValid: true,
    magic: isRsid ? 'RSID' : 'PSID',
    version,
    dataOffset,
    loadAddress,
    initAddress,
    playAddress,
    songs,
    startSong,
    speedFlags,
    title,
    author,
    released,
    flags,
    clock,
    isNtscDefault,
    chipModel,
    sid2Model,
    sid3Model,
    defaultIs6581,
    chipCount,
    chipCountLabel,
    secondSIDAddress,
    thirdSIDAddress,
    isComputeMus,
    isBasicRsid,
    md5,
    legacyMd5,
    fileSize: u8.length,
    fileName
  };
}

function rawLoadAddrSafe(v: number): number {
  return v & 0xffff;
}

// --- SONG LENGTHS (.MD5) PARSER ---
function parseDurationTokenSec(token: string): number | null {
  const cleaned = token.trim().replace(/\([^)]*\)/g, '');
  if (!cleaned) return null;
  const parts = cleaned.split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseFloat(parts[1]);
    if (!isNaN(m) && !isNaN(s) && m >= 0 && s >= 0) {
      return Math.max(0.5, m * 60 + s);
    }
  } else if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseFloat(parts[2]);
    if (!isNaN(h) && !isNaN(m) && !isNaN(s)) {
      return Math.max(0.5, h * 3600 + m * 60 + s);
    }
  }
  return null;
}

export function parseSonglengthsText(rawText: string): Map<string, SonglengthEntry> {
  const map = new Map<string, SonglengthEntry>();
  const lines = rawText.split(/\r?\n/);
  let lastPath: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith(';')) {
      const comment = line.slice(1).trim();
      if (comment.includes('/') || comment.toLowerCase().endsWith('.sid')) {
        lastPath = comment;
      }
      continue;
    }
    if (line.startsWith('[')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === 32) {
      const md5 = line.slice(0, 32).toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(md5)) continue;
      const rhs = line.slice(eqIdx + 1).trim();
      const rawTokens = rhs.split(/\s+/).filter(Boolean);
      const durationsSec: number[] = [];
      const formattedDurations: string[] = [];

      for (const tok of rawTokens) {
        const sec = parseDurationTokenSec(tok);
        if (sec !== null) {
          durationsSec.push(sec);
          formattedDurations.push(tok);
        }
      }

      if (durationsSec.length > 0) {
        map.set(md5, {
          md5,
          hvscPath: lastPath,
          durationsSec,
          formattedDurations
        });
      }
      lastPath = undefined;
    }
  }
  return map;
}

// --- STIL.TXT PARSER ---
export function parseStilText(rawText: string): {
  byPath: Map<string, StilEntry>;
  byFilename: Map<string, StilEntry[]>;
} {
  const byPath = new Map<string, StilEntry>();
  const byFilename = new Map<string, StilEntry[]>();

  const lines = rawText.split(/\r?\n/);
  let currentPath: string | null = null;
  let currentLines: string[] = [];

  const flushEntry = () => {
    if (!currentPath) return;
    const rawBlock = currentLines.join('\n').trim();
    const normPath = currentPath.trim().replace(/\\/g, '/');
    const lowerPath = normPath.toLowerCase();
    const slashIdx = lowerPath.lastIndexOf('/');
    const fileName = slashIdx >= 0 ? lowerPath.slice(slashIdx + 1) : lowerPath;

    let title: string | undefined;
    let author: string | undefined;
    let artist: string | undefined;
    const generalComments: string[] = [];
    const subtuneNotes: StilSubtuneNote[] = [];

    let activeSubtune: number | null = null;
    let activeSubtuneLines: string[] = [];

    const flushSubtune = () => {
      if (activeSubtune !== null && activeSubtuneLines.length > 0) {
        subtuneNotes.push({
          subtune: activeSubtune,
          text: activeSubtuneLines.join('\n').trim()
        });
      }
      activeSubtune = null;
      activeSubtuneLines = [];
    };

    for (const rawLine of currentLines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const subMatch = trimmed.match(/^\(#(\d+)\)$/);
      if (subMatch) {
        flushSubtune();
        activeSubtune = parseInt(subMatch[1], 10);
        continue;
      }

      if (activeSubtune !== null) {
        activeSubtuneLines.push(trimmed);
      } else {
        if (trimmed.startsWith('TITLE:')) {
          title = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('AUTHOR:')) {
          author = trimmed.slice(7).trim();
        } else if (trimmed.startsWith('ARTIST:')) {
          artist = trimmed.slice(7).trim();
        }
        generalComments.push(trimmed);
      }
    }
    flushSubtune();

    const entry: StilEntry = {
      hvscPath: normPath,
      fileName,
      title,
      author,
      artist,
      comment: generalComments.join('\n').trim() || undefined,
      subtuneNotes,
      rawBlock
    };

    byPath.set(lowerPath, entry);
    const existing = byFilename.get(fileName) || [];
    existing.push(entry);
    byFilename.set(fileName, existing);

    currentPath = null;
    currentLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }
    if (trimmed.startsWith('/') && trimmed.toLowerCase().includes('.sid')) {
      flushEntry();
      currentPath = trimmed;
      currentLines = [];
      continue;
    }
    if (currentPath !== null) {
      if (!trimmed && currentLines.length > 0) {
        // Blank line terminates an entry block in standard HVSC STIL.txt
        flushEntry();
      } else if (trimmed) {
        currentLines.push(line);
      }
    }
  }
  flushEntry();

  return { byPath, byFilename };
}

// --- INDEXEDDB PERSISTENCE FOR LARGE HVSC FILES ---
function openHvscDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPutText(key: string, text: string): Promise<void> {
  const db = await openHvscDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(text, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbGetText(key: string): Promise<string | null> {
  const db = await openHvscDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbDeleteKey(key: string): Promise<void> {
  const db = await openHvscDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function restoreHvscCachesFromIndexedDB(): Promise<void> {
  if (initHydrationPromise) return initHydrationPromise;
  initHydrationPromise = (async () => {
    const [rawSonglengths, rawStil] = await Promise.all([
      idbGetText('songlengths_md5'),
      idbGetText('stil_txt')
    ]);
    if (rawSonglengths) {
      songlengthMap = parseSonglengthsText(rawSonglengths);
      cacheStats.songlengthsCount = songlengthMap.size;
      if (!cacheStats.songlengthsUpdatedAt) cacheStats.songlengthsUpdatedAt = Date.now();
    }
    if (rawStil) {
      const parsedStil = parseStilText(rawStil);
      stilByPathMap = parsedStil.byPath;
      stilByFilenameMap = parsedStil.byFilename;
      cacheStats.stilCount = parsedStil.byPath.size;
      if (!cacheStats.stilUpdatedAt) cacheStats.stilUpdatedAt = Date.now();
    }
    persistCacheStatsToLs();
    notifyHvscListeners();
  })();
  return initHydrationPromise;
}

export async function loadAndCacheSonglengthsMd5(rawText: string): Promise<{ count: number }> {
  const parsed = parseSonglengthsText(rawText);
  songlengthMap = parsed;
  cacheStats = {
    ...cacheStats,
    songlengthsCount: parsed.size,
    songlengthsUpdatedAt: Date.now()
  };
  await idbPutText('songlengths_md5', rawText);
  persistCacheStatsToLs();
  notifyHvscListeners();
  return { count: parsed.size };
}

export async function loadAndCacheStilTxt(rawText: string): Promise<{ count: number }> {
  const parsed = parseStilText(rawText);
  stilByPathMap = parsed.byPath;
  stilByFilenameMap = parsed.byFilename;
  cacheStats = {
    ...cacheStats,
    stilCount: parsed.byPath.size,
    stilUpdatedAt: Date.now()
  };
  await idbPutText('stil_txt', rawText);
  persistCacheStatsToLs();
  notifyHvscListeners();
  return { count: parsed.byPath.size };
}

export async function clearHvscCache(target: 'songlengths' | 'stil' | 'all' = 'all'): Promise<void> {
  if (target === 'songlengths' || target === 'all') {
    songlengthMap.clear();
    cacheStats.songlengthsCount = 0;
    cacheStats.songlengthsUpdatedAt = null;
    await idbDeleteKey('songlengths_md5');
  }
  if (target === 'stil' || target === 'all') {
    stilByPathMap.clear();
    stilByFilenameMap.clear();
    cacheStats.stilCount = 0;
    cacheStats.stilUpdatedAt = null;
    await idbDeleteKey('stil_txt');
  }
  persistCacheStatsToLs();
  notifyHvscListeners();
}

export function lookupHvscForSid(
  sidMeta: SidHeaderMetadata,
  subtune1Based?: number
): HvscLookupResult {
  const activeSub = subtune1Based || sidMeta.startSong || 1;
  let songlength: SonglengthEntry | null = null;
  let matchedBy: HvscLookupResult['matchedBy'] = 'none';

  const modernEntry = songlengthMap.get(sidMeta.md5.toLowerCase());
  if (modernEntry) {
    songlength = modernEntry;
    matchedBy = 'md5';
  } else if (sidMeta.legacyMd5) {
    const legacyEntry = songlengthMap.get(sidMeta.legacyMd5.toLowerCase());
    if (legacyEntry) {
      songlength = legacyEntry;
      matchedBy = 'legacyMd5';
    }
  }

  let stil: StilEntry | null = null;
  if (songlength?.hvscPath) {
    const normalizedPath = songlength.hvscPath.trim().replace(/\\/g, '/').toLowerCase();
    const byPath = stilByPathMap.get(normalizedPath);
    if (byPath) {
      stil = byPath;
    }
  }

  if (!stil && sidMeta.fileName) {
    const baseName = sidMeta.fileName.split(/[/\\]/).pop()?.toLowerCase() || '';
    const candidates = baseName ? stilByFilenameMap.get(baseName) : undefined;
    if (candidates && candidates.length > 0) {
      if (candidates.length === 1) {
        stil = candidates[0];
      } else {
        const lowerTitle = sidMeta.title.toLowerCase();
        const lowerAuthor = sidMeta.author.toLowerCase();
        stil =
          candidates.find(
            (c) =>
              (c.title && lowerTitle && c.title.toLowerCase().includes(lowerTitle)) ||
              (c.author && lowerAuthor && c.author.toLowerCase().includes(lowerAuthor)) ||
              (c.hvscPath.toLowerCase().includes(lowerAuthor.split(' ')[0] || '___'))
          ) || candidates[0];
      }
      if (matchedBy === 'none') {
        matchedBy = 'filename';
      }
    }
  }

  const subtuneDurationsSec = songlength ? songlength.durationsSec : [];
  const idx = Math.max(0, activeSub - 1);
  const activeSubtuneDurationSec =
    subtuneDurationsSec[idx] !== undefined
      ? subtuneDurationsSec[idx]
      : subtuneDurationsSec[0] ?? null;

  return {
    songlength,
    stil,
    matchedBy,
    subtuneDurationsSec,
    activeSubtuneDurationSec
  };
}
