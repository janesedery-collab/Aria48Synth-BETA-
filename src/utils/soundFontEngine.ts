import { SoundFontInstrument, SoundFontBankInfo } from '../types';
import { SpessaSynthCore } from '../engines/spressasynthCore';
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
  category: string;
  isCustom: boolean;
  samples: { [midiKey: number]: SoundFontSampleVoice } | SoundFontSampleVoice;
}

// Global in-memory SoundFont bank registry
let loadedBankInfo: SoundFontBankInfo = {
  name: "General MIDI Extended SoundBank",
  version: "2.10",
  instrumentCount: 65,
  author: "Aria48 Studio Engine",
  isLoaded: true
};

const registeredPresets: Map<string, SoundFontPresetData> = new Map();
let isBuiltInBankInitialized = false;

// Direct mapping of preset ID to standard General MIDI program number (0-127)
export const PRESET_GM_PROGRAM_MAP: Record<string, number> = {
  // Pianos & Keys (0-7)
  gm_piano: 0,
  gm_bright_piano: 1,
  gm_electric_grand: 2,
  gm_honky_tonk: 3,
  gm_epiano: 4,
  gm_epiano2: 5,
  gm_harpsichord: 6,
  gm_clavinet: 7,

  // Chromatic Percussion & Mallets (8-15)
  gm_celesta: 8,
  gm_glockenspiel: 9,
  gm_music_box: 10,
  gm_vibraphone: 11,
  gm_marimba: 12,
  gm_xylophone: 13,
  gm_tubular_bells: 14,

  // Organs & Accordions (16-23)
  gm_organ: 16,
  gm_percussive_organ: 17,
  gm_rock_organ: 18,
  gm_church_organ: 19,
  gm_reed_organ: 20,
  gm_accordion: 21,
  gm_harmonica: 22,

  // Guitars (24-31)
  gm_guitar: 24,
  gm_steel_guitar: 25,
  gm_jazz_guitar: 26,
  gm_clean_guitar: 27,
  gm_muted_guitar: 28,
  gm_overdriven_guitar: 29,
  gm_distortion_guitar: 30,
  gm_guitar_harmonics: 31,

  // Basses (32-39)
  gm_acoustic_bass: 32,
  gm_bass: 33,
  gm_pick_bass: 34,
  gm_fretless_bass: 35,
  gm_slap_bass1: 36,
  gm_slap_bass2: 37,
  gm_synth_bass1: 38,
  gm_synth_bass2: 39,

  // Strings & Orchestral (40-55)
  gm_violin: 40,
  gm_viola: 41,
  gm_cello: 42,
  gm_contrabass: 43,
  gm_pizzicato: 45,
  gm_harp: 46,
  gm_timpani: 47,
  gm_strings: 48,
  gm_synth_strings: 50,
  gm_choir: 52,
  gm_voice_ooh: 53,
  gm_orchestra_hit: 55,

  // Brass & Winds (56-79)
  gm_trumpet: 56,
  gm_trombone: 57,
  gm_tuba: 58,
  gm_muted_trumpet: 59,
  gm_french_horn: 60,
  gm_brass: 61,
  gm_synth_brass: 62,
  gm_soprano_sax: 64,
  gm_alto_sax: 65,
  gm_tenor_sax: 66,
  gm_baritone_sax: 67,
  gm_oboe: 68,
  gm_clarinet: 71,
  gm_piccolo: 72,
  gm_flute: 73,
  gm_pan_flute: 75,
  gm_whistle: 78,
  gm_ocarina: 79,

  // Synth Leads & Chiptune (80-87)
  gm_lead: 80,
  gm_saw_lead: 81,
  gm_chiptune: 82,
  gm_square_lead: 80,
  gm_fm_lead: 84,

  // Pads & SFX (88-103)
  gm_warm_pad: 89,
  gm_polysynth_pad: 90,
  gm_halo_pad: 94,
  gm_soundtrack: 97,
  gm_crystal: 98,

  // World (104-115)
  gm_sitar: 104,
  gm_banjo: 105,
  gm_shamisen: 106,
  gm_koto: 107,
  gm_kalimba: 108,
  gm_steel_drums: 114,

  // Percussion (116-128)
  gm_taiko: 116,
  gm_synth_drum: 118,
  gm_drums: 0,
  gm_electronic_drums: 0
};

export function getGmProgramForPreset(presetId?: string): number {
  if (!presetId) return 0;
  if (PRESET_GM_PROGRAM_MAP[presetId] !== undefined) {
    return PRESET_GM_PROGRAM_MAP[presetId];
  }
  const found = registeredPresets.get(presetId);
  if (found) return found.program;
  return 0;
}

/**
 * Generate synthetic PCM AudioBuffers for classic General MIDI & Vintage instruments
 */
export function initBuiltInSoundFont(ctx: AudioContext) {
  if (isBuiltInBankInitialized) return;

  try {
    const sampleRate = ctx.sampleRate || 44100;

    // Helper: generate synthetic harmonic tone
    function createHarmonicBuffer(
      seconds: number, 
      harmonics: { mult: number; gain: number }[], 
      decayRate: number,
      attackSec = 0.01,
      vibratoFreq = 0,
      vibratoDepth = 0,
      noiseAmt = 0
    ): AudioBuffer {
      const buffer = ctx.createBuffer(1, Math.floor(sampleRate * seconds), sampleRate);
      const data = buffer.getChannelData(0);
      const f0 = 261.63; // Middle C
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const attack = attackSec > 0 ? Math.min(1.0, t / attackSec) : 1.0;
        const decay = Math.exp(-t * decayRate);
        const vib = vibratoFreq > 0 ? Math.sin(2 * Math.PI * vibratoFreq * t) * vibratoDepth : 0;
        
        let sum = 0;
        for (const h of harmonics) {
          sum += h.gain * Math.sin(2 * Math.PI * (f0 * h.mult + vib) * t);
        }
        if (noiseAmt > 0) {
          sum += (Math.random() * 2 - 1) * noiseAmt;
        }
        data[i] = sum * attack * decay;
      }
      return buffer;
    }

    // Helper: generate FM bell/piano tone
    function createFmBuffer(
      seconds: number,
      carrierMult: number,
      modMult: number,
      modIndex: number,
      decayRate: number,
      modDecayRate: number
    ): AudioBuffer {
      const buffer = ctx.createBuffer(1, Math.floor(sampleRate * seconds), sampleRate);
      const data = buffer.getChannelData(0);
      const f0 = 261.63;
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const decay = Math.exp(-t * decayRate);
        const mod = Math.sin(2 * Math.PI * f0 * modMult * t) * modIndex * Math.exp(-t * modDecayRate);
        data[i] = Math.sin(2 * Math.PI * f0 * carrierMult * t + mod) * decay * 0.75;
      }
      return buffer;
    }

    // Helper: generate Pulse/Square wave tone
    function createPulseBuffer(seconds: number, duty = 0.5, decayRate = 2.0): AudioBuffer {
      const buffer = ctx.createBuffer(1, Math.floor(sampleRate * seconds), sampleRate);
      const data = buffer.getChannelData(0);
      const f0 = 261.63;
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const phase = (f0 * t) % 1;
        const val = phase < duty ? 0.6 : -0.6;
        data[i] = val * Math.exp(-t * decayRate);
      }
      return buffer;
    }

    const instrumentDefs: Array<{
      id: string;
      name: string;
      category: string;
      prog: number;
      bank?: number;
      gen: () => AudioBuffer;
      gain?: number;
      rootKey?: number;
    }> = [
      // 1. Pianos & Keyboards
      {
        id: "gm_piano",
        name: "000: Acoustic Grand Piano",
        category: "Pianos & Keyboards",
        prog: 0,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.5}, {mult:2, gain:0.3}, {mult:3, gain:0.15}, {mult:4, gain:0.05}], 2.8)
      },
      {
        id: "gm_bright_piano",
        name: "001: Bright Acoustic Piano",
        category: "Pianos & Keyboards",
        prog: 1,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.4}, {mult:2, gain:0.35}, {mult:3, gain:0.25}, {mult:4, gain:0.15}], 2.5)
      },
      {
        id: "gm_electric_grand",
        name: "002: Electric Grand Piano",
        category: "Pianos & Keyboards",
        prog: 2,
        gen: () => createFmBuffer(1.8, 1, 2, 1.4, 2.4, 4.0)
      },
      {
        id: "gm_honky_tonk",
        name: "003: Honky-tonk Piano",
        category: "Pianos & Keyboards",
        prog: 3,
        gen: () => createHarmonicBuffer(1.6, [{mult:1, gain:0.45}, {mult:1.008, gain:0.4}, {mult:2, gain:0.25}], 3.0)
      },
      {
        id: "gm_epiano",
        name: "004: Electric Piano 1 (Rhodes)",
        category: "Pianos & Keyboards",
        prog: 4,
        gen: () => createFmBuffer(1.8, 1, 2, 1.2, 2.2, 4.0)
      },
      {
        id: "gm_epiano2",
        name: "005: Electric Piano 2 (Chorused DX7)",
        category: "Pianos & Keyboards",
        prog: 5,
        gen: () => createFmBuffer(2.0, 1, 3, 1.8, 2.0, 3.5)
      },
      {
        id: "gm_harpsichord",
        name: "006: Harpsichord (Baroque)",
        category: "Pianos & Keyboards",
        prog: 6,
        gen: () => createHarmonicBuffer(1.5, [{mult:1, gain:0.3}, {mult:2, gain:0.3}, {mult:3, gain:0.25}, {mult:4, gain:0.2}], 3.8)
      },
      {
        id: "gm_clavinet",
        name: "007: Clavinet (Funk)",
        category: "Pianos & Keyboards",
        prog: 7,
        gen: () => createPulseBuffer(1.4, 0.25, 4.0)
      },

      // 2. Chromatic & Mallets
      {
        id: "gm_celesta",
        name: "008: Celesta Bell",
        category: "Chromatic Percussion",
        prog: 8,
        rootKey: 72,
        gen: () => createHarmonicBuffer(1.5, [{mult:1, gain:0.6}, {mult:4, gain:0.3}], 3.5)
      },
      {
        id: "gm_glockenspiel",
        name: "009: Glockenspiel",
        category: "Chromatic Percussion",
        prog: 9,
        rootKey: 72,
        gen: () => createHarmonicBuffer(1.6, [{mult:1, gain:0.5}, {mult:3, gain:0.3}, {mult:6, gain:0.15}], 2.8)
      },
      {
        id: "gm_music_box",
        name: "010: Music Box",
        category: "Chromatic Percussion",
        prog: 10,
        rootKey: 72,
        gen: () => createHarmonicBuffer(1.4, [{mult:1, gain:0.6}, {mult:5, gain:0.25}], 3.2)
      },
      {
        id: "gm_vibraphone",
        name: "011: Vibraphone",
        category: "Chromatic Percussion",
        prog: 11,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.6}, {mult:2, gain:0.2}], 2.0, 0.01, 5.5, 3.0)
      },
      {
        id: "gm_marimba",
        name: "012: Marimba",
        category: "Chromatic Percussion",
        prog: 12,
        gen: () => createHarmonicBuffer(1.0, [{mult:1, gain:0.7}, {mult:3, gain:0.2}], 5.5)
      },
      {
        id: "gm_xylophone",
        name: "013: Xylophone",
        category: "Chromatic Percussion",
        prog: 13,
        gen: () => createHarmonicBuffer(0.8, [{mult:1, gain:0.6}, {mult:4, gain:0.3}], 7.0)
      },
      {
        id: "gm_tubular_bells",
        name: "014: Tubular Bells / Chimes",
        category: "Chromatic Percussion",
        prog: 14,
        gen: () => createHarmonicBuffer(2.5, [{mult:1, gain:0.4}, {mult:2.76, gain:0.3}, {mult:5.4, gain:0.2}], 1.8)
      },

      // 3. Organs & Accordions
      {
        id: "gm_organ",
        name: "016: Drawbar Organ (Hammond B3)",
        category: "Organs & Accordions",
        prog: 16,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:3, gain:0.2}, {mult:4, gain:0.1}], 0.4, 0.02)
      },
      {
        id: "gm_percussive_organ",
        name: "017: Percussive Jazz Organ",
        category: "Organs & Accordions",
        prog: 17,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.45}, {mult:2, gain:0.35}, {mult:4, gain:0.3}], 1.5, 0.005)
      },
      {
        id: "gm_rock_organ",
        name: "018: Rock Overdrive Organ",
        category: "Organs & Accordions",
        prog: 18,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.35}, {mult:2, gain:0.3}, {mult:3, gain:0.25}, {mult:5, gain:0.2}], 0.5)
      },
      {
        id: "gm_church_organ",
        name: "019: Church Pipe Organ",
        category: "Organs & Accordions",
        prog: 19,
        gen: () => createHarmonicBuffer(2.5, [{mult:0.5, gain:0.3}, {mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:4, gain:0.2}], 0.3)
      },
      {
        id: "gm_reed_organ",
        name: "020: Reed Organ",
        category: "Organs & Accordions",
        prog: 20,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:2, gain:0.25}, {mult:3, gain:0.25}], 0.8)
      },
      {
        id: "gm_accordion",
        name: "021: French Accordion (Musette)",
        category: "Organs & Accordions",
        prog: 21,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:1.006, gain:0.4}, {mult:2, gain:0.2}], 0.5)
      },
      {
        id: "gm_harmonica",
        name: "022: Blues Harmonica",
        category: "Organs & Accordions",
        prog: 22,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:3, gain:0.2}], 0.6, 0.05, 5, 2)
      },

      // 4. Guitars
      {
        id: "gm_guitar",
        name: "024: Acoustic Nylon Guitar",
        category: "Guitars",
        prog: 24,
        gen: () => createHarmonicBuffer(1.6, [{mult:1, gain:0.6}, {mult:2, gain:0.3}, {mult:3, gain:0.1}], 3.5)
      },
      {
        id: "gm_steel_guitar",
        name: "025: Acoustic Steel Guitar",
        category: "Guitars",
        prog: 25,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.5}, {mult:2, gain:0.35}, {mult:3, gain:0.2}, {mult:4, gain:0.1}], 3.0)
      },
      {
        id: "gm_jazz_guitar",
        name: "026: Hollowbody Jazz Guitar",
        category: "Guitars",
        prog: 26,
        gen: () => createHarmonicBuffer(1.6, [{mult:1, gain:0.65}, {mult:2, gain:0.25}, {mult:3, gain:0.08}], 3.2)
      },
      {
        id: "gm_clean_guitar",
        name: "027: Clean Electric Guitar",
        category: "Guitars",
        prog: 27,
        gen: () => createHarmonicBuffer(1.7, [{mult:1, gain:0.55}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 2.8)
      },
      {
        id: "gm_muted_guitar",
        name: "028: Muted Electric Guitar",
        category: "Guitars",
        prog: 28,
        gen: () => createHarmonicBuffer(0.6, [{mult:1, gain:0.7}, {mult:2, gain:0.25}], 8.0)
      },
      {
        id: "gm_overdriven_guitar",
        name: "029: Overdriven Blues Guitar",
        category: "Guitars",
        prog: 29,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.4}, {mult:2, gain:0.35}, {mult:3, gain:0.3}, {mult:4, gain:0.2}], 2.2)
      },
      {
        id: "gm_distortion_guitar",
        name: "030: Distortion Rock Guitar",
        category: "Guitars",
        prog: 30,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.35}, {mult:2, gain:0.3}, {mult:3, gain:0.25}, {mult:4, gain:0.2}, {mult:5, gain:0.15}], 1.8)
      },
      {
        id: "gm_guitar_harmonics",
        name: "031: Guitar Harmonics",
        category: "Guitars",
        prog: 31,
        rootKey: 72,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.7}, {mult:2, gain:0.2}], 2.0)
      },

      // 5. Basses
      {
        id: "gm_acoustic_bass",
        name: "032: Acoustic Upright Bass",
        category: "Basses",
        prog: 32,
        rootKey: 36,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.75}, {mult:2, gain:0.2}, {mult:3, gain:0.05}], 3.0)
      },
      {
        id: "gm_bass",
        name: "033: Electric Finger Bass",
        category: "Basses",
        prog: 33,
        rootKey: 36,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.7}, {mult:2, gain:0.25}, {mult:3, gain:0.05}], 2.8)
      },
      {
        id: "gm_pick_bass",
        name: "034: Electric Pick Bass",
        category: "Basses",
        prog: 34,
        rootKey: 36,
        gen: () => createHarmonicBuffer(1.6, [{mult:1, gain:0.6}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 3.2)
      },
      {
        id: "gm_fretless_bass",
        name: "035: Fretless Bass",
        category: "Basses",
        prog: 35,
        rootKey: 36,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.7}, {mult:2, gain:0.25}], 2.5, 0.02, 4.5, 1.5)
      },
      {
        id: "gm_slap_bass1",
        name: "036: Slap Bass 1",
        category: "Basses",
        prog: 36,
        rootKey: 36,
        gen: () => createHarmonicBuffer(1.4, [{mult:1, gain:0.6}, {mult:2, gain:0.35}, {mult:4, gain:0.25}], 4.2)
      },
      {
        id: "gm_slap_bass2",
        name: "037: Slap Bass 2",
        category: "Basses",
        prog: 37,
        rootKey: 36,
        gen: () => createHarmonicBuffer(1.2, [{mult:1, gain:0.55}, {mult:3, gain:0.35}, {mult:5, gain:0.2}], 4.8)
      },
      {
        id: "gm_synth_bass1",
        name: "038: Synth Bass 1 (Acid Resonant)",
        category: "Basses",
        prog: 38,
        rootKey: 36,
        gen: () => createPulseBuffer(1.5, 0.35, 3.5)
      },
      {
        id: "gm_synth_bass2",
        name: "039: Synth Bass 2 (Sub Saw)",
        category: "Basses",
        prog: 39,
        rootKey: 36,
        gen: () => createHarmonicBuffer(1.8, [{mult:0.5, gain:0.6}, {mult:1, gain:0.4}], 2.5)
      },

      // 6. Strings & Orchestral
      {
        id: "gm_violin",
        name: "040: Solo Violin",
        category: "Strings & Orchestral",
        prog: 40,
        rootKey: 64,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:3, gain:0.2}], 0.8, 0.08, 5.5, 3.0)
      },
      {
        id: "gm_viola",
        name: "041: Solo Viola",
        category: "Strings & Orchestral",
        prog: 41,
        rootKey: 55,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.45}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 0.8, 0.08, 5.0, 2.5)
      },
      {
        id: "gm_cello",
        name: "042: Solo Cello",
        category: "Strings & Orchestral",
        prog: 42,
        rootKey: 48,
        gen: () => createHarmonicBuffer(2.4, [{mult:1, gain:0.5}, {mult:2, gain:0.3}, {mult:3, gain:0.1}], 0.7, 0.09, 4.8, 2.0)
      },
      {
        id: "gm_contrabass",
        name: "043: Orchestral Contrabass",
        category: "Strings & Orchestral",
        prog: 43,
        rootKey: 36,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.6}, {mult:2, gain:0.25}], 0.9, 0.1)
      },
      {
        id: "gm_pizzicato",
        name: "045: Pizzicato Strings",
        category: "Strings & Orchestral",
        prog: 45,
        gen: () => createHarmonicBuffer(0.8, [{mult:1, gain:0.6}, {mult:2, gain:0.3}], 6.5)
      },
      {
        id: "gm_harp",
        name: "046: Orchestral Concert Harp",
        category: "Strings & Orchestral",
        prog: 46,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.6}, {mult:2, gain:0.25}, {mult:3, gain:0.1}], 2.2)
      },
      {
        id: "gm_timpani",
        name: "047: Concert Timpani",
        category: "Strings & Orchestral",
        prog: 47,
        rootKey: 48,
        gen: () => createHarmonicBuffer(1.4, [{mult:1, gain:0.7}, {mult:1.48, gain:0.3}], 3.5)
      },
      {
        id: "gm_strings",
        name: "048: String Ensemble (Symphonic)",
        category: "Strings & Orchestral",
        prog: 48,
        gen: () => createHarmonicBuffer(2.8, [{mult:1, gain:0.35}, {mult:1.004, gain:0.35}, {mult:2, gain:0.2}, {mult:2.006, gain:0.1}], 0.6, 0.15)
      },
      {
        id: "gm_synth_strings",
        name: "050: Synth Strings (Solina/Juno)",
        category: "Strings & Orchestral",
        prog: 50,
        gen: () => createHarmonicBuffer(2.6, [{mult:1, gain:0.35}, {mult:1.008, gain:0.35}, {mult:2, gain:0.2}], 0.6, 0.12)
      },
      {
        id: "gm_choir",
        name: "052: Choir Aahs (Angelic)",
        category: "Strings & Orchestral",
        prog: 52,
        gen: () => createHarmonicBuffer(2.6, [{mult:1, gain:0.5}, {mult:2, gain:0.2}, {mult:3, gain:0.2}], 0.5, 0.2)
      },
      {
        id: "gm_voice_ooh",
        name: "053: Voice Oohs",
        category: "Strings & Orchestral",
        prog: 53,
        gen: () => createHarmonicBuffer(2.4, [{mult:1, gain:0.6}, {mult:2, gain:0.25}], 0.6, 0.18)
      },
      {
        id: "gm_orchestra_hit",
        name: "055: 80s Orchestra Hit",
        category: "Strings & Orchestral",
        prog: 55,
        gen: () => createHarmonicBuffer(1.0, [{mult:1, gain:0.3}, {mult:1.5, gain:0.25}, {mult:2, gain:0.25}, {mult:2.5, gain:0.2}], 4.0)
      },

      // 7. Brass & Woodwinds
      {
        id: "gm_trumpet",
        name: "056: Solo Trumpet",
        category: "Brass & Woodwinds",
        prog: 56,
        rootKey: 64,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.35}, {mult:2, gain:0.3}, {mult:3, gain:0.2}, {mult:4, gain:0.15}], 1.0, 0.04)
      },
      {
        id: "gm_trombone",
        name: "057: Tenor Trombone",
        category: "Brass & Woodwinds",
        prog: 57,
        rootKey: 48,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 1.0, 0.05)
      },
      {
        id: "gm_tuba",
        name: "058: Bass Tuba",
        category: "Brass & Woodwinds",
        prog: 58,
        rootKey: 36,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.55}, {mult:2, gain:0.25}], 1.1, 0.06)
      },
      {
        id: "gm_muted_trumpet",
        name: "059: Harmon Muted Trumpet",
        category: "Brass & Woodwinds",
        prog: 59,
        rootKey: 64,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.25}, {mult:3, gain:0.4}, {mult:5, gain:0.25}], 1.2, 0.03)
      },
      {
        id: "gm_french_horn",
        name: "060: French Horn",
        category: "Brass & Woodwinds",
        prog: 60,
        rootKey: 52,
        gen: () => createHarmonicBuffer(2.4, [{mult:1, gain:0.45}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 0.8, 0.08)
      },
      {
        id: "gm_brass",
        name: "061: Brass Section (Fanfare)",
        category: "Brass & Woodwinds",
        prog: 61,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.3}, {mult:2, gain:0.25}, {mult:3, gain:0.2}, {mult:4, gain:0.15}, {mult:5, gain:0.1}], 0.9, 0.05)
      },
      {
        id: "gm_synth_brass",
        name: "062: Synth Brass 1 (Jump/OB-X)",
        category: "Brass & Woodwinds",
        prog: 62,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.35}, {mult:1.005, gain:0.35}, {mult:2, gain:0.2}], 0.9, 0.06)
      },
      {
        id: "gm_soprano_sax",
        name: "064: Soprano Saxophone",
        category: "Brass & Woodwinds",
        prog: 64,
        rootKey: 64,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:3, gain:0.2}], 1.0, 0.05, 5.0, 2.5)
      },
      {
        id: "gm_alto_sax",
        name: "065: Alto Saxophone",
        category: "Brass & Woodwinds",
        prog: 65,
        rootKey: 57,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.42}, {mult:2, gain:0.3}, {mult:3, gain:0.18}], 0.9, 0.05, 5.0, 2.5)
      },
      {
        id: "gm_tenor_sax",
        name: "066: Tenor Saxophone",
        category: "Brass & Woodwinds",
        prog: 66,
        rootKey: 50,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.45}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 0.9, 0.05, 4.8, 2.0)
      },
      {
        id: "gm_baritone_sax",
        name: "067: Baritone Saxophone",
        category: "Brass & Woodwinds",
        prog: 67,
        rootKey: 42,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.5}, {mult:2, gain:0.28}, {mult:3, gain:0.12}], 1.0, 0.06)
      },
      {
        id: "gm_oboe",
        name: "068: Orchestral Oboe",
        category: "Brass & Woodwinds",
        prog: 68,
        rootKey: 64,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.3}, {mult:2, gain:0.35}, {mult:3, gain:0.2}], 0.8, 0.06, 5.2, 2.0)
      },
      {
        id: "gm_clarinet",
        name: "071: Concert Clarinet",
        category: "Brass & Woodwinds",
        prog: 71,
        rootKey: 60,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.5}, {mult:3, gain:0.35}, {mult:5, gain:0.1}], 0.8, 0.05)
      },
      {
        id: "gm_piccolo",
        name: "072: Concert Piccolo",
        category: "Brass & Woodwinds",
        prog: 72,
        rootKey: 72,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.7}, {mult:2, gain:0.2}], 1.2, 0.04, 6.0, 3.0)
      },
      {
        id: "gm_flute",
        name: "073: Concert Flute",
        category: "Brass & Woodwinds",
        prog: 73,
        rootKey: 72,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.65}, {mult:2, gain:0.15}], 1.0, 0.08, 5.0, 2.5, 0.03)
      },
      {
        id: "gm_pan_flute",
        name: "075: Andean Pan Flute",
        category: "Brass & Woodwinds",
        prog: 75,
        rootKey: 64,
        gen: () => createHarmonicBuffer(2.2, [{mult:1, gain:0.6}, {mult:2, gain:0.2}], 1.1, 0.1, 4.5, 3.0, 0.06)
      },
      {
        id: "gm_whistle",
        name: "078: Penny Whistle",
        category: "Brass & Woodwinds",
        prog: 78,
        rootKey: 72,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.8}, {mult:2, gain:0.15}], 1.2, 0.04, 5.5, 3.0)
      },
      {
        id: "gm_ocarina",
        name: "079: Legend Ocarina",
        category: "Brass & Woodwinds",
        prog: 79,
        rootKey: 64,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.7}, {mult:2, gain:0.15}], 1.0, 0.08, 4.5, 2.0, 0.02)
      },

      // 8. Synth Leads & Chiptune
      {
        id: "gm_lead",
        name: "080: Synth Lead (8-Bit Pulse)",
        category: "Synth Leads & Chiptune",
        prog: 80,
        gen: () => createPulseBuffer(1.8, 0.4, 2.0)
      },
      {
        id: "gm_saw_lead",
        name: "081: Sawtooth Lead (Eurodance)",
        category: "Synth Leads & Chiptune",
        prog: 81,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:2, gain:0.25}, {mult:3, gain:0.18}, {mult:4, gain:0.12}], 1.5)
      },
      {
        id: "gm_chiptune",
        name: "082: Chiptune Arp (Game Boy)",
        category: "Synth Leads & Chiptune",
        prog: 82,
        gen: () => createPulseBuffer(1.5, 0.25, 2.2)
      },
      {
        id: "gm_square_lead",
        name: "083: Chiptune 50% Duty (NES)",
        category: "Synth Leads & Chiptune",
        prog: 80,
        gen: () => createPulseBuffer(1.6, 0.5, 2.0)
      },
      {
        id: "gm_fm_lead",
        name: "084: FM 4-Op Lead (Genesis)",
        category: "Synth Leads & Chiptune",
        prog: 84,
        gen: () => createFmBuffer(1.8, 1, 2, 2.2, 2.0, 3.0)
      },

      // 9. Pads & Atmospheres
      {
        id: "gm_warm_pad",
        name: "089: Warm Analog Pad (Jupiter-8)",
        category: "Pads & Atmospheres",
        prog: 89,
        gen: () => createHarmonicBuffer(3.0, [{mult:1, gain:0.4}, {mult:1.003, gain:0.4}, {mult:2, gain:0.15}], 0.4, 0.3)
      },
      {
        id: "gm_polysynth_pad",
        name: "090: Polysynth Pad",
        category: "Pads & Atmospheres",
        prog: 90,
        gen: () => createHarmonicBuffer(2.8, [{mult:1, gain:0.35}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 0.5, 0.2)
      },
      {
        id: "gm_halo_pad",
        name: "094: Halo Shimmer Pad",
        category: "Pads & Atmospheres",
        prog: 94,
        gen: () => createFmBuffer(3.0, 1, 4, 1.5, 0.5, 1.2)
      },
      {
        id: "gm_soundtrack",
        name: "097: Sci-Fi Soundtrack",
        category: "Pads & Atmospheres",
        prog: 97,
        gen: () => createHarmonicBuffer(2.8, [{mult:1, gain:0.4}, {mult:1.5, gain:0.3}, {mult:2.01, gain:0.2}], 0.6, 0.25)
      },
      {
        id: "gm_crystal",
        name: "098: Crystal Bell FX",
        category: "Pads & Atmospheres",
        prog: 98,
        gen: () => createFmBuffer(2.4, 1, 3.5, 2.0, 1.8, 2.5)
      },

      // 10. World & Ethnic
      {
        id: "gm_sitar",
        name: "104: Indian Sitar",
        category: "World & Ethnic",
        prog: 104,
        gen: () => createHarmonicBuffer(2.0, [{mult:1, gain:0.45}, {mult:2, gain:0.3}, {mult:3, gain:0.2}, {mult:4, gain:0.15}], 2.2, 0.01, 5.0, 4.0)
      },
      {
        id: "gm_banjo",
        name: "105: 5-String Country Banjo",
        category: "World & Ethnic",
        prog: 105,
        gen: () => createHarmonicBuffer(1.2, [{mult:1, gain:0.6}, {mult:2, gain:0.35}, {mult:3, gain:0.15}], 4.5)
      },
      {
        id: "gm_shamisen",
        name: "106: Traditional Shamisen",
        category: "World & Ethnic",
        prog: 106,
        gen: () => createHarmonicBuffer(1.3, [{mult:1, gain:0.65}, {mult:2, gain:0.3}], 4.0)
      },
      {
        id: "gm_koto",
        name: "107: Japanese 13-String Koto",
        category: "World & Ethnic",
        prog: 107,
        gen: () => createHarmonicBuffer(1.8, [{mult:1, gain:0.6}, {mult:2, gain:0.25}, {mult:3, gain:0.1}], 3.0)
      },
      {
        id: "gm_kalimba",
        name: "108: African Kalimba / Thumb Piano",
        category: "World & Ethnic",
        prog: 108,
        gen: () => createHarmonicBuffer(1.5, [{mult:1, gain:0.7}, {mult:3, gain:0.2}], 3.5)
      },
      {
        id: "gm_steel_drums",
        name: "114: Caribbean Steel Drums",
        category: "World & Ethnic",
        prog: 114,
        gen: () => createFmBuffer(1.8, 1, 2.5, 1.8, 2.5, 4.0)
      },

      // 11. Percussion
      {
        id: "gm_taiko",
        name: "116: Taiko War Drum",
        category: "Drums & Percussion",
        prog: 116,
        rootKey: 36,
        gen: () => {
          const buf = ctx.createBuffer(1, Math.floor(sampleRate * 0.8), sampleRate);
          const data = buf.getChannelData(0);
          for (let i = 0; i < data.length; i++) {
            const t = i / sampleRate;
            const pitch = 90 * Math.exp(-t * 12) + 45;
            data[i] = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t * 5) * 0.95;
          }
          return buf;
        }
      },
      {
        id: "gm_synth_drum",
        name: "118: Space Synth Drum (Simmons)",
        category: "Drums & Percussion",
        prog: 118,
        rootKey: 48,
        gen: () => {
          const buf = ctx.createBuffer(1, Math.floor(sampleRate * 0.5), sampleRate);
          const data = buf.getChannelData(0);
          for (let i = 0; i < data.length; i++) {
            const t = i / sampleRate;
            const pitch = 350 * Math.exp(-t * 22) + 60;
            data[i] = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t * 8) * 0.9;
          }
          return buf;
        }
      }
    ];

    // Register all instruments
    for (const inst of instrumentDefs) {
      const buffer = inst.gen();
      registeredPresets.set(inst.id, {
        id: inst.id,
        name: inst.name,
        category: inst.category,
        bank: inst.bank || 0,
        program: inst.prog,
        isCustom: false,
        samples: {
          buffer,
          rootKey: inst.rootKey || 60,
          sampleRate,
          baseGain: inst.gain || 0.85
        }
      });
    }

    // 12. GM Standard Drums: Kick, Snare, Hi-Hat, Tom, Cymbal
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
      category: "Drums & Percussion",
      bank: 128,
      program: 0,
      isCustom: false,
      samples: drumKeyMap
    });

    registeredPresets.set("gm_electronic_drums", {
      id: "gm_electronic_drums",
      name: "129: TR-808 Electro Kit",
      category: "Drums & Percussion",
      bank: 128,
      program: 24,
      isCustom: false,
      samples: drumKeyMap
    });

    loadedBankInfo.instrumentCount = registeredPresets.size;
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
  loopEnd?: number,
  category = "Custom SF2/Samples"
) {
  registeredPresets.set(id, {
    id,
    name,
    category,
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
      category: preset.category,
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
      category: preset.category,
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
 * Directly powered by spressasynth_core-master.zip as the responsible reader
 * and linked to spressasynth_lib-master.zip and the audio engine!
 */
export async function parseSoundFontFile(
  arrayBuffer: ArrayBuffer, 
  fileName: string,
  audioCtx: AudioContext
): Promise<{ bankInfo: SoundFontBankInfo; instruments: SoundFontInstrument[]; logs: string[] }> {
  const result = SpessaSynthCore.parse(arrayBuffer, audioCtx, fileName);
  loadedBankInfo = result.bankInfo;
  return {
    bankInfo: result.bankInfo,
    instruments: getAvailableSoundFontInstruments(),
    logs: result.logs
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
    const isDrum = preset.id === 'gm_drums' || preset.id === 'gm_electronic_drums' || preset.bank === 128;
    const playbackRate = isDrum ? 1.0 : Math.max(0.0625, Math.min(16.0, Math.pow(2, (midiNote - rootKey) / 12)));

    const source = ctx.createBufferSource();
    source.buffer = sample.buffer;
    source.playbackRate.setValueAtTime(playbackRate, ctx.currentTime);

    if (sample.loopStart !== undefined && sample.loopEnd !== undefined && sample.loopEnd > sample.loopStart) {
      source.loop = true;
      source.loopStart = sample.loopStart / sample.sampleRate;
      source.loopEnd = sample.loopEnd / sample.sampleRate;
    }

    const gainNode = ctx.createGain();
    const targetVolume = (volume / 100) * (sample.baseGain || 1.0) * 0.16;
    
    gainNode.gain.setValueAtTime(targetVolume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

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
