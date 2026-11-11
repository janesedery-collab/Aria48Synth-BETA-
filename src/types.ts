export interface Channel {
  id: number;
  enabled: boolean;
  chip: string;
  volume: number;
  pan: number;
  freqLow: number;  // EQ Low (dB)
  freqMid: number;  // EQ Mid (dB)
  freqHigh: number; // EQ High (dB)
  mute: boolean;
  solo: boolean;
  soundFontPreset?: string; // Optional SoundFont / GM instrument ID
}

export interface SoundFontInstrument {
  id: string;
  name: string;
  bank: number;
  program: number;
  sampleRate?: number;
  rootKey?: number;
  isCustom?: boolean;
}

export interface SoundFontBankInfo {
  name: string;
  version: string;
  instrumentCount: number;
  author?: string;
  isLoaded: boolean;
}

export type OscilloscopeSize = 'very-small' | 'small' | 'medium' | 'large' | 'very-large';

export interface OscilloscopeConfig {
  preset: 'protracker' | 'phosphor' | 'neon' | 'sunset' | 'cosmic' | 'copper';
  drawType: 'polygon' | 'solid' | 'dash' | 'dot';
  scanlines: boolean;
  glowBloom: boolean;
  gridDividers: boolean;
  noiseFloor: number; // 0 to 10
  amplifier: number; // 0.2 to 10.0 (multiplier for HTML5 waveform drawing height, default 1.0)
  size: OscilloscopeSize; // 'very-small' | 'small' | 'medium' | 'large' | 'very-large'
  phaseSync: boolean; // Stabilize waveform at zero-crossing (true) or free-drifting phase (false)
}

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  text: string;
  createdAt: any; // Firestore serverTimestamp or Date
  type: 'text' | 'track_share';
  trackId?: string;
  trackTitle?: string;
}

export interface ChiptuneTrack {
  id: string;
  title: string;
  authorId: string;
  authorName: string;
  bpm: number;
  chipType: string;
  tracksJson: string; // Serialized sound structure
  description?: string;
  likes: number;
  createdAt: any;
}

export const CHIPS = [
  'YM2612 (Sega FM)',
  'YMF262 (OPL3 FM)',
  'MOS6581 (C64 SID)',
  'PAULA (Amiga PCM)',
  'RP2A03 (NES APU)',
  'DMG-01 (Game Boy)',
  'SPC700 (SNES DSP)',
  'General MIDI (SoundFont)',
  'Virtual DAC',
  'Physical Chip (USB)'
] as const;

export const THEMES = [
  { id: 'furnace', name: 'UI: Furnace (Amiga Dark)' }
] as const;

export const MAX_CHANNELS = 48;
export const DEFAULT_PATTERN_ROWS = 64;
