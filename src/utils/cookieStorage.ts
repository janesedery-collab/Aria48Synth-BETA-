/**
 * Browser Cookie Storage Utility
 * Provides persistent read/write for user preferences (amplifier, oscilloscope, sound settings)
 * and added SoundFonts registry/binary persistence in browser cookies (+ IndexedDB backing for large banks).
 * Uses document.cookie with 365-day lifetime and SameSite=Lax, plus localStorage/IndexedDB redundancy.
 */

import { OscilloscopeConfig } from '../types';

export const COOKIE_AMPLIFIER_KEY = "aria48_osc_amplifier";
export const COOKIE_OSC_CONFIG_KEY = "aria48_osc_config";
export const COOKIE_ADDED_SOUNDFONTS_KEY = "aria48_added_soundfonts";
export const COOKIE_ACTIVE_SOUNDFONT_KEY = "aria48_active_soundfont";
const COOKIE_SF_CHUNK_PREFIX = "aria48_sf_c_";

// Safe cookie budget so large SF2/SF3 banks never trigger HTTP 431 Request Header Too Large
const MAX_COOKIE_BINARY_BYTES = 12 * 1024; // 12 KB raw (~16 KB base64) stored directly inside cookies
const COOKIE_CHUNK_SIZE = 3200;
const IDB_NAME = "aria48_soundfont_db";
const IDB_STORE = "soundfonts";

export interface SavedSoundFontCookieEntry {
  id: string;
  fileName: string;
  name: string;
  format: string;
  size: number;
  storedInCookieChunks: number;
  addedAt: number;
}

/**
 * Set a cookie in document.cookie with duration in days
 */
export function setCookie(name: string, value: string, days = 365) {
  if (typeof document === 'undefined') return;
  try {
    const maxAge = days * 24 * 60 * 60;
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; max-age=${maxAge}; path=/; SameSite=Lax`;
  } catch (e) {
    console.warn("Cookie write error:", e);
  }

  try {
    localStorage.setItem(name, value);
  } catch (e) {}
}

/**
 * Delete a cookie from document.cookie and localStorage
 */
export function deleteCookie(name: string) {
  if (typeof document === 'undefined') return;
  try {
    document.cookie = `${encodeURIComponent(name)}=; max-age=0; path=/; SameSite=Lax`;
  } catch (e) {}
  try {
    localStorage.removeItem(name);
  } catch (e) {}
}

/**
 * Retrieve cookie value by name from document.cookie
 */
export function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const nameEQ = encodeURIComponent(name) + "=";
    const cookies = document.cookie.split(';');
    for (let i = 0; i < cookies.length; i++) {
      const c = cookies[i].trim();
      if (c.indexOf(nameEQ) === 0) {
        return decodeURIComponent(c.substring(nameEQ.length));
      }
    }
  } catch (e) {
    console.warn("Cookie read error:", e);
  }

  try {
    const fallback = localStorage.getItem(name);
    if (fallback !== null) return fallback;
  } catch (e) {}

  return null;
}

/**
 * Save oscilloscope waveform amplifier multiplier into browser cookies
 */
export function saveAmplifier(amp: number): void {
  const bounded = Math.max(0.2, Math.min(12.0, Number(amp) || 1.0));
  setCookie(COOKIE_AMPLIFIER_KEY, bounded.toFixed(2), 365);
}

/**
 * Read saved waveform amplifier multiplier from browser cookies (defaults to 1.0)
 */
export function getSavedAmplifier(): number {
  const val = getCookie(COOKIE_AMPLIFIER_KEY);
  if (val !== null) {
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed >= 0.2 && parsed <= 12.0) {
      return parsed;
    }
  }
  return 1.0;
}

/**
 * Save complete oscilloscope configuration into browser cookies
 */
export function saveOscConfig(config: OscilloscopeConfig): void {
  try {
    if (config.amplifier !== undefined) {
      saveAmplifier(config.amplifier);
    }
    setCookie(COOKIE_OSC_CONFIG_KEY, JSON.stringify(config), 365);
  } catch (e) {}
}

/**
 * Read saved oscilloscope configuration from browser cookies
 */
export function getSavedOscConfig(): Partial<OscilloscopeConfig> {
  const val = getCookie(COOKIE_OSC_CONFIG_KEY);
  if (val !== null) {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    } catch (e) {}
  }
  return {};
}

// ============================================================================
// ADDED SOUNDFONTS COOKIE + INDEXEDDB PERSISTENCE
// ============================================================================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function openSoundFontDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function putSoundFontBinaryInIDB(id: string, buffer: ArrayBuffer): Promise<void> {
  const db = await openSoundFontDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put(buffer.slice(0), id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function getSoundFontBinaryFromIDB(id: string): Promise<ArrayBuffer | null> {
  const db = await openSoundFontDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(id);
      req.onsuccess = () => {
        const res = req.result;
        resolve(res instanceof ArrayBuffer ? res : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function deleteSoundFontBinaryFromIDB(id: string): Promise<void> {
  const db = await openSoundFontDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function sanitizeCookieKey(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
}

function clearSoundFontCookieChunks(id: string, maxChunks = 16) {
  const safeId = sanitizeCookieKey(id);
  for (let i = 0; i < maxChunks; i++) {
    const key = `${COOKIE_SF_CHUNK_PREFIX}${safeId}_${i}`;
    if (getCookie(key) !== null) {
      deleteCookie(key);
    } else if (i > 0) {
      break;
    }
  }
}

export function saveActiveSoundFontCookie(id: string): void {
  if (!id) return;
  setCookie(COOKIE_ACTIVE_SOUNDFONT_KEY, id, 365);
}

export function getActiveSoundFontCookie(): string | null {
  return getCookie(COOKIE_ACTIVE_SOUNDFONT_KEY);
}

export function getSavedSoundFontsFromCookies(): SavedSoundFontCookieEntry[] {
  const raw = getCookie(COOKIE_ADDED_SOUNDFONTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Save an added SoundFont's metadata into browser cookies (`document.cookie`),
 * write compact binary chunks directly into cookies when within safe header limits,
 * and store the full binary in IndexedDB so large `.sf2`/`.sf3`/`.dls` files persist reliably.
 */
export async function saveSoundFontToCookiesAndCache(
  fileName: string,
  arrayBuffer: ArrayBuffer,
  id: string,
  meta?: { name?: string; format?: string }
): Promise<SavedSoundFontCookieEntry> {
  const safeId = sanitizeCookieKey(id);
  let storedInCookieChunks = 0;

  // Store full binary in IndexedDB first so multi-MB SoundFonts always restore cleanly
  await putSoundFontBinaryInIDB(id, arrayBuffer);

  // Also store compact SoundFonts directly inside document.cookie chunks
  const existingEntries = getSavedSoundFontsFromCookies().filter(e => e.id !== id && e.fileName !== fileName);
  const currentChunkTotalBytes = existingEntries.reduce((acc, e) => acc + (e.storedInCookieChunks || 0) * COOKIE_CHUNK_SIZE, 0);

  if (arrayBuffer.byteLength <= MAX_COOKIE_BINARY_BYTES && currentChunkTotalBytes < 18000) {
    try {
      const b64 = arrayBufferToBase64(arrayBuffer);
      const chunksCount = Math.ceil(b64.length / COOKIE_CHUNK_SIZE);
      for (let i = 0; i < chunksCount; i++) {
        const chunk = b64.slice(i * COOKIE_CHUNK_SIZE, (i + 1) * COOKIE_CHUNK_SIZE);
        setCookie(`${COOKIE_SF_CHUNK_PREFIX}${safeId}_${i}`, chunk, 365);
      }
      storedInCookieChunks = chunksCount;
    } catch {
      clearSoundFontCookieChunks(id);
      storedInCookieChunks = 0;
    }
  } else {
    clearSoundFontCookieChunks(id);
  }

  const entry: SavedSoundFontCookieEntry = {
    id,
    fileName,
    name: meta?.name || fileName.replace(/\.[^/.]+$/, ""),
    format: meta?.format || 'SoundBank',
    size: arrayBuffer.byteLength,
    storedInCookieChunks,
    addedAt: Date.now()
  };

  // Keep up to 8 most recently added SoundFonts in the cookie manifest
  const updated = [entry, ...existingEntries].slice(0, 8);
  setCookie(COOKIE_ADDED_SOUNDFONTS_KEY, JSON.stringify(updated), 365);
  saveActiveSoundFontCookie(id);

  return entry;
}

/**
 * Retrieve saved SoundFont binary from browser cookies chunks or IndexedDB cache
 */
export async function loadSavedSoundFontBinary(entry: SavedSoundFontCookieEntry): Promise<ArrayBuffer | null> {
  // Try IndexedDB first (fastest, works for any file size)
  const idbBuf = await getSoundFontBinaryFromIDB(entry.id);
  if (idbBuf && idbBuf.byteLength > 0) {
    return idbBuf;
  }

  // Fallback: reconstruct from browser cookie chunks
  if (entry.storedInCookieChunks > 0) {
    const safeId = sanitizeCookieKey(entry.id);
    let b64 = "";
    for (let i = 0; i < entry.storedInCookieChunks; i++) {
      const part = getCookie(`${COOKIE_SF_CHUNK_PREFIX}${safeId}_${i}`);
      if (!part) return null;
      b64 += part;
    }
    try {
      return base64ToArrayBuffer(b64);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Remove an added SoundFont from browser cookies and IndexedDB cache
 */
export async function removeSavedSoundFontFromCookies(id: string): Promise<void> {
  clearSoundFontCookieChunks(id);
  await deleteSoundFontBinaryFromIDB(id);
  const remaining = getSavedSoundFontsFromCookies().filter(e => e.id !== id);
  setCookie(COOKIE_ADDED_SOUNDFONTS_KEY, JSON.stringify(remaining), 365);
}
