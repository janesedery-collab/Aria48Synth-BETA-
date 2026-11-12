/**
 * Browser Cookie Storage Utility
 * Provides persistent read/write for user preferences (amplifier, oscilloscope, sound settings)
 * Uses document.cookie with 365-day lifetime and SameSite=Lax, plus localStorage mirroring
 */

import { OscilloscopeConfig } from '../types';

export const COOKIE_AMPLIFIER_KEY = "aria48_osc_amplifier";
export const COOKIE_OSC_CONFIG_KEY = "aria48_osc_config";

/**
 * Set a cookie in document.cookie with duration in days
 */
export function setCookie(name: string, value: string, days = 365) {
  if (typeof document === 'undefined') return;
  try {
    const maxAge = days * 24 * 60 * 60;
    // Set cookie with path=/ and SameSite=Lax for reliable persistence
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; max-age=${maxAge}; path=/; SameSite=Lax`;
  } catch (e) {
    console.warn("Cookie write error:", e);
  }

  // Also mirror to localStorage for redundancy
  try {
    localStorage.setItem(name, value);
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
      let c = cookies[i].trim();
      if (c.indexOf(nameEQ) === 0) {
        return decodeURIComponent(c.substring(nameEQ.length));
      }
    }
  } catch (e) {
    console.warn("Cookie read error:", e);
  }

  // Fallback to localStorage if cookie not found
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
