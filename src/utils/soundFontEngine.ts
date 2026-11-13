import { SoundFontInstrument, SoundFontBankInfo } from '../types';
import { SpessaSynthCore } from '../engines/spressasynthCore';
import { getInterpolationMode, interpolateSampleBuffer } from '../engines/soundFontInterpolation';
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

    // Helper: generate concert-pitch harmonic tone with proper phase-integrated vibrato
    function createHarmonicBuffer(
      seconds: number, 
      harmonics: { mult: number; gain: number }[], 
      decayRate: number,
      attackSec = 0.01,
      vibratoFreq = 0,
      vibratoDepth = 0,
      noiseAmt = 0,
      rootKey = 60
    ): AudioBuffer {
      const buffer = ctx.createBuffer(1, Math.floor(sampleRate * seconds), sampleRate);
      const data = buffer.getChannelData(0);
      const f0 = 440 * Math.pow(2, (rootKey - 69) / 12);
      const phases = new Float64Array(harmonics.length);
      const twoPiOverSr = (2 * Math.PI) / sampleRate;

      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const attack = attackSec > 0 ? Math.min(1.0, t / attackSec) : 1.0;
        const decay = Math.exp(-t * decayRate);
        // Smooth vibrato ramp-in after 0.15s and proper phase integration so depth stays subtle
        const vibFade = vibratoFreq > 0 ? Math.min(1.0, Math.max(0, (t - 0.12) / 0.25)) : 0;
        const vibRatio = vibratoFreq > 0 ? 1.0 + (Math.sin(2 * Math.PI * vibratoFreq * t) * (vibratoDepth / 261.63)) * vibFade : 1.0;

        let sum = 0;
        for (let hIdx = 0; hIdx < harmonics.length; hIdx++) {
          const h = harmonics[hIdx];
          phases[hIdx] += f0 * h.mult * vibRatio * twoPiOverSr;
          sum += h.gain * Math.sin(phases[hIdx]);
        }
        if (noiseAmt > 0) {
          sum += (Math.random() * 2 - 1) * noiseAmt;
        }
        data[i] = sum * attack * decay;
      }
      return buffer;
    }

    // Helper: generate FM bell/piano tone at exact rootKey concert pitch
    function createFmBuffer(
      seconds: number,
      carrierMult: number,
      modMult: number,
      modIndex: number,
      decayRate: number,
      modDecayRate: number,
      rootKey = 60
    ): AudioBuffer {
      const buffer = ctx.createBuffer(1, Math.floor(sampleRate * seconds), sampleRate);
      const data = buffer.getChannelData(0);
      const f0 = 440 * Math.pow(2, (rootKey - 69) / 12);
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const attack = Math.min(1.0, t / 0.005);
        const decay = Math.exp(-t * decayRate);
        const mod = Math.sin(2 * Math.PI * f0 * modMult * t) * modIndex * Math.exp(-t * modDecayRate);
        data[i] = Math.sin(2 * Math.PI * f0 * carrierMult * t + mod) * attack * decay * 0.75;
      }
      return buffer;
    }

    // Helper: generate Pulse/Square wave tone at exact rootKey concert pitch
    function createPulseBuffer(seconds: number, duty = 0.5, decayRate = 2.0, rootKey = 60): AudioBuffer {
      const buffer = ctx.createBuffer(1, Math.floor(sampleRate * seconds), sampleRate);
      const data = buffer.getChannelData(0);
      const f0 = 440 * Math.pow(2, (rootKey - 69) / 12);
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const attack = Math.min(1.0, t / 0.004);
        const phase = (f0 * t) % 1;
        const val = phase < duty ? 0.6 : -0.6;
        data[i] = val * attack * Math.exp(-t * decayRate);
      }
      return buffer;
    }

    const instrumentDefs: Array<{
      id: string;
      name: string;
      category: string;
      prog: number;
      bank?: number;
      gen: (rk: number) => AudioBuffer;
      gain?: number;
      rootKey?: number;
    }> = [
      // 1. Pianos & Keyboards
      {
        id: "gm_piano",
        name: "000: Acoustic Grand Piano",
        category: "Pianos & Keyboards",
        prog: 0,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.5}, {mult:2, gain:0.3}, {mult:3, gain:0.15}, {mult:4, gain:0.05}], 2.8, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_bright_piano",
        name: "001: Bright Acoustic Piano",
        category: "Pianos & Keyboards",
        prog: 1,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.4}, {mult:2, gain:0.35}, {mult:3, gain:0.25}, {mult:4, gain:0.15}], 2.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_electric_grand",
        name: "002: Electric Grand Piano",
        category: "Pianos & Keyboards",
        prog: 2,
        gen: (rk) => createFmBuffer(1.8, 1, 2, 1.4, 2.4, 4.0, rk)
      },
      {
        id: "gm_honky_tonk",
        name: "003: Honky-tonk Piano",
        category: "Pianos & Keyboards",
        prog: 3,
        gen: (rk) => createHarmonicBuffer(1.6, [{mult:1, gain:0.45}, {mult:1.008, gain:0.4}, {mult:2, gain:0.25}], 3.0, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_epiano",
        name: "004: Electric Piano 1 (Rhodes)",
        category: "Pianos & Keyboards",
        prog: 4,
        gen: (rk) => createFmBuffer(1.8, 1, 2, 1.2, 2.2, 4.0, rk)
      },
      {
        id: "gm_epiano2",
        name: "005: Electric Piano 2 (Chorused DX7)",
        category: "Pianos & Keyboards",
        prog: 5,
        gen: (rk) => createFmBuffer(2.0, 1, 3, 1.8, 2.0, 3.5, rk)
      },
      {
        id: "gm_harpsichord",
        name: "006: Harpsichord (Baroque)",
        category: "Pianos & Keyboards",
        prog: 6,
        gen: (rk) => createHarmonicBuffer(1.5, [{mult:1, gain:0.3}, {mult:2, gain:0.3}, {mult:3, gain:0.25}, {mult:4, gain:0.2}], 3.8, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_clavinet",
        name: "007: Clavinet (Funk)",
        category: "Pianos & Keyboards",
        prog: 7,
        gen: (rk) => createPulseBuffer(1.4, 0.25, 4.0, rk)
      },

      // 2. Chromatic & Mallets
      {
        id: "gm_celesta",
        name: "008: Celesta Bell",
        category: "Chromatic Percussion",
        prog: 8,
        rootKey: 72,
        gen: (rk) => createHarmonicBuffer(1.5, [{mult:1, gain:0.6}, {mult:4, gain:0.3}], 3.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_glockenspiel",
        name: "009: Glockenspiel",
        category: "Chromatic Percussion",
        prog: 9,
        rootKey: 72,
        gen: (rk) => createHarmonicBuffer(1.6, [{mult:1, gain:0.5}, {mult:3, gain:0.3}, {mult:6, gain:0.15}], 2.8, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_music_box",
        name: "010: Music Box",
        category: "Chromatic Percussion",
        prog: 10,
        rootKey: 72,
        gen: (rk) => createHarmonicBuffer(1.4, [{mult:1, gain:0.6}, {mult:5, gain:0.25}], 3.2, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_vibraphone",
        name: "011: Vibraphone",
        category: "Chromatic Percussion",
        prog: 11,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.6}, {mult:2, gain:0.2}], 2.0, 0.01, 5.5, 2.0, 0, rk)
      },
      {
        id: "gm_marimba",
        name: "012: Marimba",
        category: "Chromatic Percussion",
        prog: 12,
        gen: (rk) => createHarmonicBuffer(1.0, [{mult:1, gain:0.7}, {mult:3, gain:0.2}], 5.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_xylophone",
        name: "013: Xylophone",
        category: "Chromatic Percussion",
        prog: 13,
        gen: (rk) => createHarmonicBuffer(0.8, [{mult:1, gain:0.6}, {mult:4, gain:0.3}], 7.0, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_tubular_bells",
        name: "014: Tubular Bells / Chimes",
        category: "Chromatic Percussion",
        prog: 14,
        gen: (rk) => createHarmonicBuffer(2.5, [{mult:1, gain:0.45}, {mult:2.76, gain:0.28}, {mult:5.4, gain:0.18}], 1.8, 0.01, 0, 0, 0, rk)
      },

      // 3. Organs & Accordions
      {
        id: "gm_organ",
        name: "016: Drawbar Organ (Hammond B3)",
        category: "Organs & Accordions",
        prog: 16,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:3, gain:0.2}, {mult:4, gain:0.1}], 0.4, 0.02, 0, 0, 0, rk)
      },
      {
        id: "gm_percussive_organ",
        name: "017: Percussive Jazz Organ",
        category: "Organs & Accordions",
        prog: 17,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.45}, {mult:2, gain:0.35}, {mult:4, gain:0.3}], 1.5, 0.005, 0, 0, 0, rk)
      },
      {
        id: "gm_rock_organ",
        name: "018: Rock Overdrive Organ",
        category: "Organs & Accordions",
        prog: 18,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.35}, {mult:2, gain:0.3}, {mult:3, gain:0.25}, {mult:5, gain:0.2}], 0.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_church_organ",
        name: "019: Church Pipe Organ",
        category: "Organs & Accordions",
        prog: 19,
        gen: (rk) => createHarmonicBuffer(2.5, [{mult:0.5, gain:0.3}, {mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:4, gain:0.2}], 0.3, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_reed_organ",
        name: "020: Reed Organ",
        category: "Organs & Accordions",
        prog: 20,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:2, gain:0.25}, {mult:3, gain:0.25}], 0.8, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_accordion",
        name: "021: French Accordion (Musette)",
        category: "Organs & Accordions",
        prog: 21,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:1.006, gain:0.4}, {mult:2, gain:0.2}], 0.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_harmonica",
        name: "022: Blues Harmonica",
        category: "Organs & Accordions",
        prog: 22,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:3, gain:0.2}], 0.6, 0.05, 5, 1.5, 0, rk)
      },

      // 4. Guitars
      {
        id: "gm_guitar",
        name: "024: Acoustic Nylon Guitar",
        category: "Guitars",
        prog: 24,
        gen: (rk) => createHarmonicBuffer(1.6, [{mult:1, gain:0.6}, {mult:2, gain:0.3}, {mult:3, gain:0.1}], 3.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_steel_guitar",
        name: "025: Acoustic Steel Guitar",
        category: "Guitars",
        prog: 25,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.5}, {mult:2, gain:0.35}, {mult:3, gain:0.2}, {mult:4, gain:0.1}], 3.0, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_jazz_guitar",
        name: "026: Hollowbody Jazz Guitar",
        category: "Guitars",
        prog: 26,
        gen: (rk) => createHarmonicBuffer(1.6, [{mult:1, gain:0.65}, {mult:2, gain:0.25}, {mult:3, gain:0.08}], 3.2, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_clean_guitar",
        name: "027: Clean Electric Guitar",
        category: "Guitars",
        prog: 27,
        gen: (rk) => createHarmonicBuffer(1.7, [{mult:1, gain:0.55}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 2.8, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_muted_guitar",
        name: "028: Muted Electric Guitar",
        category: "Guitars",
        prog: 28,
        gen: (rk) => createHarmonicBuffer(0.6, [{mult:1, gain:0.7}, {mult:2, gain:0.25}], 8.0, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_overdriven_guitar",
        name: "029: Overdriven Blues Guitar",
        category: "Guitars",
        prog: 29,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.4}, {mult:2, gain:0.35}, {mult:3, gain:0.3}, {mult:4, gain:0.2}], 2.2, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_distortion_guitar",
        name: "030: Distortion Rock Guitar",
        category: "Guitars",
        prog: 30,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.35}, {mult:2, gain:0.3}, {mult:3, gain:0.25}, {mult:4, gain:0.2}, {mult:5, gain:0.15}], 1.8, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_guitar_harmonics",
        name: "031: Guitar Harmonics",
        category: "Guitars",
        prog: 31,
        rootKey: 72,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.7}, {mult:2, gain:0.2}], 2.0, 0.01, 0, 0, 0, rk)
      },

      // 5. Basses
      {
        id: "gm_acoustic_bass",
        name: "032: Acoustic Upright Bass",
        category: "Basses",
        prog: 32,
        rootKey: 36,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.75}, {mult:2, gain:0.2}, {mult:3, gain:0.05}], 3.0, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_bass",
        name: "033: Electric Finger Bass",
        category: "Basses",
        prog: 33,
        rootKey: 36,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.7}, {mult:2, gain:0.25}, {mult:3, gain:0.05}], 2.8, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_pick_bass",
        name: "034: Electric Pick Bass",
        category: "Basses",
        prog: 34,
        rootKey: 36,
        gen: (rk) => createHarmonicBuffer(1.6, [{mult:1, gain:0.6}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 3.2, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_fretless_bass",
        name: "035: Fretless Bass",
        category: "Basses",
        prog: 35,
        rootKey: 36,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.7}, {mult:2, gain:0.25}], 2.5, 0.02, 4.5, 1.0, 0, rk)
      },
      {
        id: "gm_slap_bass1",
        name: "036: Slap Bass 1",
        category: "Basses",
        prog: 36,
        rootKey: 36,
        gen: (rk) => createHarmonicBuffer(1.4, [{mult:1, gain:0.6}, {mult:2, gain:0.35}, {mult:4, gain:0.25}], 4.2, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_slap_bass2",
        name: "037: Slap Bass 2",
        category: "Basses",
        prog: 37,
        rootKey: 36,
        gen: (rk) => createHarmonicBuffer(1.2, [{mult:1, gain:0.55}, {mult:3, gain:0.35}, {mult:5, gain:0.2}], 4.8, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_synth_bass1",
        name: "038: Synth Bass 1 (Acid Resonant)",
        category: "Basses",
        prog: 38,
        rootKey: 36,
        gen: (rk) => createPulseBuffer(1.5, 0.35, 3.5, rk)
      },
      {
        id: "gm_synth_bass2",
        name: "039: Synth Bass 2 (Sub Saw)",
        category: "Basses",
        prog: 39,
        rootKey: 36,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.65}, {mult:2, gain:0.3}], 2.5, 0.01, 0, 0, 0, rk)
      },

      // 6. Strings & Orchestral
      {
        id: "gm_violin",
        name: "040: Solo Violin",
        category: "Strings & Orchestral",
        prog: 40,
        rootKey: 64,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.45}, {mult:2, gain:0.28}, {mult:3, gain:0.18}], 0.8, 0.06, 5.2, 1.5, 0, rk)
      },
      {
        id: "gm_viola",
        name: "041: Solo Viola",
        category: "Strings & Orchestral",
        prog: 41,
        rootKey: 55,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.48}, {mult:2, gain:0.28}, {mult:3, gain:0.14}], 0.8, 0.06, 5.0, 1.4, 0, rk)
      },
      {
        id: "gm_cello",
        name: "042: Solo Cello",
        category: "Strings & Orchestral",
        prog: 42,
        rootKey: 48,
        gen: (rk) => createHarmonicBuffer(2.4, [{mult:1, gain:0.52}, {mult:2, gain:0.28}, {mult:3, gain:0.12}], 0.7, 0.07, 4.8, 1.2, 0, rk)
      },
      {
        id: "gm_contrabass",
        name: "043: Orchestral Contrabass",
        category: "Strings & Orchestral",
        prog: 43,
        rootKey: 36,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.6}, {mult:2, gain:0.25}], 0.9, 0.08, 0, 0, 0, rk)
      },
      {
        id: "gm_pizzicato",
        name: "045: Pizzicato Strings",
        category: "Strings & Orchestral",
        prog: 45,
        gen: (rk) => createHarmonicBuffer(0.8, [{mult:1, gain:0.6}, {mult:2, gain:0.3}], 6.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_harp",
        name: "046: Orchestral Concert Harp",
        category: "Strings & Orchestral",
        prog: 46,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.6}, {mult:2, gain:0.25}, {mult:3, gain:0.1}], 2.2, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_timpani",
        name: "047: Concert Timpani",
        category: "Strings & Orchestral",
        prog: 47,
        rootKey: 48,
        gen: (rk) => createHarmonicBuffer(1.4, [{mult:1, gain:0.75}, {mult:1.48, gain:0.25}], 3.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_strings",
        name: "048: String Ensemble (Symphonic)",
        category: "Strings & Orchestral",
        prog: 48,
        gen: (rk) => createHarmonicBuffer(2.8, [{mult:1, gain:0.4}, {mult:1.003, gain:0.35}, {mult:2, gain:0.2}, {mult:2.004, gain:0.08}], 0.6, 0.12, 0, 0, 0, rk)
      },
      {
        id: "gm_synth_strings",
        name: "050: Synth Strings (Solina/Juno)",
        category: "Strings & Orchestral",
        prog: 50,
        gen: (rk) => createHarmonicBuffer(2.6, [{mult:1, gain:0.4}, {mult:1.005, gain:0.35}, {mult:2, gain:0.2}], 0.6, 0.1, 0, 0, 0, rk)
      },
      {
        id: "gm_choir",
        name: "052: Choir Aahs (Angelic)",
        category: "Strings & Orchestral",
        prog: 52,
        gen: (rk) => createHarmonicBuffer(2.6, [{mult:1, gain:0.55}, {mult:2, gain:0.2}, {mult:3, gain:0.15}], 0.5, 0.15, 0, 0, 0, rk)
      },
      {
        id: "gm_voice_ooh",
        name: "053: Voice Oohs",
        category: "Strings & Orchestral",
        prog: 53,
        gen: (rk) => createHarmonicBuffer(2.4, [{mult:1, gain:0.65}, {mult:2, gain:0.2}], 0.6, 0.12, 0, 0, 0, rk)
      },
      {
        id: "gm_orchestra_hit",
        name: "055: 80s Orchestra Hit",
        category: "Strings & Orchestral",
        prog: 55,
        gen: (rk) => createHarmonicBuffer(1.0, [{mult:1, gain:0.45}, {mult:2, gain:0.3}, {mult:3, gain:0.18}, {mult:4, gain:0.12}], 4.0, 0.01, 0, 0, 0, rk)
      },

      // 7. Brass & Woodwinds
      {
        id: "gm_trumpet",
        name: "056: Solo Trumpet",
        category: "Brass & Woodwinds",
        prog: 56,
        rootKey: 64,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.35}, {mult:2, gain:0.3}, {mult:3, gain:0.2}, {mult:4, gain:0.15}], 1.0, 0.04, 0, 0, 0, rk)
      },
      {
        id: "gm_trombone",
        name: "057: Tenor Trombone",
        category: "Brass & Woodwinds",
        prog: 57,
        rootKey: 48,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 1.0, 0.05, 0, 0, 0, rk)
      },
      {
        id: "gm_tuba",
        name: "058: Bass Tuba",
        category: "Brass & Woodwinds",
        prog: 58,
        rootKey: 36,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.55}, {mult:2, gain:0.25}], 1.1, 0.06, 0, 0, 0, rk)
      },
      {
        id: "gm_muted_trumpet",
        name: "059: Harmon Muted Trumpet",
        category: "Brass & Woodwinds",
        prog: 59,
        rootKey: 64,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.35}, {mult:3, gain:0.35}, {mult:5, gain:0.2}], 1.2, 0.03, 0, 0, 0, rk)
      },
      {
        id: "gm_french_horn",
        name: "060: French Horn",
        category: "Brass & Woodwinds",
        prog: 60,
        rootKey: 52,
        gen: (rk) => createHarmonicBuffer(2.4, [{mult:1, gain:0.45}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 0.8, 0.08, 0, 0, 0, rk)
      },
      {
        id: "gm_brass",
        name: "061: Brass Section (Fanfare)",
        category: "Brass & Woodwinds",
        prog: 61,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.3}, {mult:2, gain:0.25}, {mult:3, gain:0.2}, {mult:4, gain:0.15}, {mult:5, gain:0.1}], 0.9, 0.05, 0, 0, 0, rk)
      },
      {
        id: "gm_synth_brass",
        name: "062: Synth Brass 1 (Jump/OB-X)",
        category: "Brass & Woodwinds",
        prog: 62,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.35}, {mult:1.004, gain:0.35}, {mult:2, gain:0.2}], 0.9, 0.06, 0, 0, 0, rk)
      },
      {
        id: "gm_soprano_sax",
        name: "064: Soprano Saxophone",
        category: "Brass & Woodwinds",
        prog: 64,
        rootKey: 64,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:2, gain:0.3}, {mult:3, gain:0.2}], 1.0, 0.05, 5.0, 1.5, 0, rk)
      },
      {
        id: "gm_alto_sax",
        name: "065: Alto Saxophone",
        category: "Brass & Woodwinds",
        prog: 65,
        rootKey: 57,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.42}, {mult:2, gain:0.3}, {mult:3, gain:0.18}], 0.9, 0.05, 5.0, 1.4, 0, rk)
      },
      {
        id: "gm_tenor_sax",
        name: "066: Tenor Saxophone",
        category: "Brass & Woodwinds",
        prog: 66,
        rootKey: 50,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.45}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 0.9, 0.05, 4.8, 1.2, 0, rk)
      },
      {
        id: "gm_baritone_sax",
        name: "067: Baritone Saxophone",
        category: "Brass & Woodwinds",
        prog: 67,
        rootKey: 42,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.5}, {mult:2, gain:0.28}, {mult:3, gain:0.12}], 1.0, 0.06, 0, 0, 0, rk)
      },
      {
        id: "gm_oboe",
        name: "068: Orchestral Oboe",
        category: "Brass & Woodwinds",
        prog: 68,
        rootKey: 64,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.35}, {mult:2, gain:0.32}, {mult:3, gain:0.2}], 0.8, 0.06, 5.0, 1.2, 0, rk)
      },
      {
        id: "gm_clarinet",
        name: "071: Concert Clarinet",
        category: "Brass & Woodwinds",
        prog: 71,
        rootKey: 60,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.5}, {mult:3, gain:0.35}, {mult:5, gain:0.1}], 0.8, 0.05, 0, 0, 0, rk)
      },
      {
        id: "gm_piccolo",
        name: "072: Concert Piccolo",
        category: "Brass & Woodwinds",
        prog: 72,
        rootKey: 72,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.7}, {mult:2, gain:0.2}], 1.2, 0.04, 5.5, 1.5, 0, rk)
      },
      {
        id: "gm_flute",
        name: "073: Concert Flute",
        category: "Brass & Woodwinds",
        prog: 73,
        rootKey: 72,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.65}, {mult:2, gain:0.15}], 1.0, 0.06, 5.0, 1.2, 0.02, rk)
      },
      {
        id: "gm_pan_flute",
        name: "075: Andean Pan Flute",
        category: "Brass & Woodwinds",
        prog: 75,
        rootKey: 64,
        gen: (rk) => createHarmonicBuffer(2.2, [{mult:1, gain:0.6}, {mult:2, gain:0.2}], 1.1, 0.08, 4.5, 1.2, 0.04, rk)
      },
      {
        id: "gm_whistle",
        name: "078: Penny Whistle",
        category: "Brass & Woodwinds",
        prog: 78,
        rootKey: 72,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.8}, {mult:2, gain:0.15}], 1.2, 0.04, 5.0, 1.4, 0, rk)
      },
      {
        id: "gm_ocarina",
        name: "079: Legend Ocarina",
        category: "Brass & Woodwinds",
        prog: 79,
        rootKey: 64,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.7}, {mult:2, gain:0.15}], 1.0, 0.06, 4.5, 1.0, 0.015, rk)
      },

      // 8. Synth Leads & Chiptune
      {
        id: "gm_lead",
        name: "080: Synth Lead (8-Bit Pulse)",
        category: "Synth Leads & Chiptune",
        prog: 80,
        gen: (rk) => createPulseBuffer(1.8, 0.4, 2.0, rk)
      },
      {
        id: "gm_saw_lead",
        name: "081: Sawtooth Lead (Eurodance)",
        category: "Synth Leads & Chiptune",
        prog: 81,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.4}, {mult:2, gain:0.25}, {mult:3, gain:0.18}, {mult:4, gain:0.12}], 1.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_chiptune",
        name: "082: Chiptune Arp (Game Boy)",
        category: "Synth Leads & Chiptune",
        prog: 82,
        gen: (rk) => createPulseBuffer(1.5, 0.25, 2.2, rk)
      },
      {
        id: "gm_square_lead",
        name: "083: Chiptune 50% Duty (NES)",
        category: "Synth Leads & Chiptune",
        prog: 80,
        gen: (rk) => createPulseBuffer(1.6, 0.5, 2.0, rk)
      },
      {
        id: "gm_fm_lead",
        name: "084: FM 4-Op Lead (Genesis)",
        category: "Synth Leads & Chiptune",
        prog: 84,
        gen: (rk) => createFmBuffer(1.8, 1, 2, 2.2, 2.0, 3.0, rk)
      },

      // 9. Pads & Atmospheres
      {
        id: "gm_warm_pad",
        name: "089: Warm Analog Pad (Jupiter-8)",
        category: "Pads & Atmospheres",
        prog: 89,
        gen: (rk) => createHarmonicBuffer(3.0, [{mult:1, gain:0.42}, {mult:1.002, gain:0.38}, {mult:2, gain:0.15}], 0.4, 0.2, 0, 0, 0, rk)
      },
      {
        id: "gm_polysynth_pad",
        name: "090: Polysynth Pad",
        category: "Pads & Atmospheres",
        prog: 90,
        gen: (rk) => createHarmonicBuffer(2.8, [{mult:1, gain:0.38}, {mult:2, gain:0.3}, {mult:3, gain:0.15}], 0.5, 0.15, 0, 0, 0, rk)
      },
      {
        id: "gm_halo_pad",
        name: "094: Halo Shimmer Pad",
        category: "Pads & Atmospheres",
        prog: 94,
        gen: (rk) => createFmBuffer(3.0, 1, 2, 1.1, 0.5, 1.2, rk)
      },
      {
        id: "gm_soundtrack",
        name: "097: Sci-Fi Soundtrack",
        category: "Pads & Atmospheres",
        prog: 97,
        gen: (rk) => createHarmonicBuffer(2.8, [{mult:1, gain:0.5}, {mult:1.003, gain:0.3}, {mult:2, gain:0.2}], 0.6, 0.15, 0, 0, 0, rk)
      },
      {
        id: "gm_crystal",
        name: "098: Crystal Bell FX",
        category: "Pads & Atmospheres",
        prog: 98,
        gen: (rk) => createFmBuffer(2.4, 1, 3, 1.6, 1.8, 2.5, rk)
      },

      // 10. World & Ethnic
      {
        id: "gm_sitar",
        name: "104: Indian Sitar",
        category: "World & Ethnic",
        prog: 104,
        gen: (rk) => createHarmonicBuffer(2.0, [{mult:1, gain:0.45}, {mult:2, gain:0.3}, {mult:3, gain:0.2}, {mult:4, gain:0.15}], 2.2, 0.01, 4.5, 1.2, 0, rk)
      },
      {
        id: "gm_banjo",
        name: "105: 5-String Country Banjo",
        category: "World & Ethnic",
        prog: 105,
        gen: (rk) => createHarmonicBuffer(1.2, [{mult:1, gain:0.6}, {mult:2, gain:0.35}, {mult:3, gain:0.15}], 4.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_shamisen",
        name: "106: Traditional Shamisen",
        category: "World & Ethnic",
        prog: 106,
        gen: (rk) => createHarmonicBuffer(1.3, [{mult:1, gain:0.65}, {mult:2, gain:0.3}], 4.0, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_koto",
        name: "107: Japanese 13-String Koto",
        category: "World & Ethnic",
        prog: 107,
        gen: (rk) => createHarmonicBuffer(1.8, [{mult:1, gain:0.6}, {mult:2, gain:0.25}, {mult:3, gain:0.1}], 3.0, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_kalimba",
        name: "108: African Kalimba / Thumb Piano",
        category: "World & Ethnic",
        prog: 108,
        gen: (rk) => createHarmonicBuffer(1.5, [{mult:1, gain:0.7}, {mult:3, gain:0.2}], 3.5, 0.01, 0, 0, 0, rk)
      },
      {
        id: "gm_steel_drums",
        name: "114: Caribbean Steel Drums",
        category: "World & Ethnic",
        prog: 114,
        gen: (rk) => createFmBuffer(1.8, 1, 2.5, 1.8, 2.5, 4.0, rk)
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
          let phase = 0;
          for (let i = 0; i < data.length; i++) {
            const t = i / sampleRate;
            const pitch = 90 * Math.exp(-t * 12) + 45;
            phase += (2 * Math.PI * pitch) / sampleRate;
            data[i] = Math.sin(phase) * Math.exp(-t * 5) * 0.95;
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
          let phase = 0;
          for (let i = 0; i < data.length; i++) {
            const t = i / sampleRate;
            const pitch = 280 * Math.exp(-t * 22) + 60;
            phase += (2 * Math.PI * pitch) / sampleRate;
            data[i] = Math.sin(phase) * Math.exp(-t * 8) * 0.9;
          }
          return buf;
        }
      }
    ];

    // Register all instruments (passing inst.rootKey so every buffer matches its exact pitch!)
    for (const inst of instrumentDefs) {
      const rk = inst.rootKey || 60;
      const buffer = inst.gen(rk);
      registeredPresets.set(inst.id, {
        id: inst.id,
        name: inst.name,
        category: inst.category,
        bank: inst.bank || 0,
        program: inst.prog,
        isCustom: false,
        samples: {
          buffer,
          rootKey: rk,
          sampleRate,
          baseGain: inst.gain || 0.85
        }
      });
    }

    // 12. GM Standard Drums: Filtered studio PCM drums (Zero raw static shakers!)
    // Seeded deterministic PRNG + 2-pole Biquad HPF/LPF/BPF helper for crisp, clean percussion transients
    let drumSeed = 0x5f3759df;
    const nextRand = () => {
      drumSeed = (drumSeed * 1664525 + 1013904223) >>> 0;
      return (drumSeed / 0x80000000) - 1.0;
    };

    const filterBiquad = (
      input: Float32Array,
      type: 'hpf' | 'lpf' | 'bpf',
      freq: number,
      q = 0.707
    ): Float32Array => {
      const out = new Float32Array(input.length);
      const w0 = (2 * Math.PI * Math.min(sampleRate * 0.45, Math.max(20, freq))) / sampleRate;
      const cosW0 = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));

      let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
      if (type === 'hpf') {
        b0 = (1 + cosW0) / 2;
        b1 = -(1 + cosW0);
        b2 = (1 + cosW0) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosW0;
        a2 = 1 - alpha;
      } else if (type === 'lpf') {
        b0 = (1 - cosW0) / 2;
        b1 = 1 - cosW0;
        b2 = (1 - cosW0) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosW0;
        a2 = 1 - alpha;
      } else {
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cosW0;
        a2 = 1 - alpha;
      }

      const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0;
      const na1 = a1 / a0, na2 = a2 / a0;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < input.length; i++) {
        const x0 = input[i];
        const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
        out[i] = y0;
        x2 = x1; x1 = x0;
        y2 = y1; y1 = y0;
      }
      return out;
    };

    const metallicSquareSum = (t: number): number => {
      const freqs = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
      let sum = 0;
      for (let k = 0; k < freqs.length; k++) {
        const s = Math.sin(2 * Math.PI * freqs[k] * t);
        // Band-limited soft square partials prevent harsh digital fuzz
        sum += Math.tanh(s * 2.4);
      }
      return sum / freqs.length;
    };

    // Kick (35/36): Deep sub punch + crisp 3ms beater transient + warm saturation
    const kickBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.42), sampleRate);
    const kickData = kickBuf.getChannelData(0);
    let kickPhase = 0;
    for (let i = 0; i < kickData.length; i++) {
      const t = i / sampleRate;
      const pitch = 158 * Math.exp(-t * 42) + 45;
      kickPhase += (2 * Math.PI * pitch) / sampleRate;
      const subBody = Math.sin(kickPhase) * Math.exp(-t * 10.5);
      const click = Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t * 420) * 0.35;
      kickData[i] = Math.tanh((subBody + click) * 1.18) * 0.94;
    }

    // Snare (38/40): Tuned dual-mode drum shell + crisp HPF/LPF filtered snare wires (zero mud/static)
    const snareLen = Math.floor(sampleRate * 0.28);
    const snareNoiseRaw = new Float32Array(snareLen);
    for (let i = 0; i < snareLen; i++) snareNoiseRaw[i] = nextRand();
    const snareWires = filterBiquad(filterBiquad(snareNoiseRaw, 'hpf', 1800, 0.8), 'lpf', 7600, 0.7);
    const snareBuf = ctx.createBuffer(1, snareLen, sampleRate);
    const snareData = snareBuf.getChannelData(0);
    let snarePhase = 0;
    for (let i = 0; i < snareLen; i++) {
      const t = i / sampleRate;
      const shellFreq = 215 * Math.exp(-t * 28) + 178;
      snarePhase += (2 * Math.PI * shellFreq) / sampleRate;
      const body = (Math.sin(snarePhase) * 0.65 + Math.sin(snarePhase * 1.78) * 0.28) * Math.exp(-t * 22);
      const wires = snareWires[i] * Math.exp(-t * 15) * 0.62;
      const snap = Math.sin(2 * Math.PI * 1400 * t) * Math.exp(-t * 180) * 0.18;
      snareData[i] = Math.tanh((body + wires + snap) * 1.05) * 0.9;
    }

    // Rimshot / Claves / Woodblock (37, 75, 76, 77): Woody resonant ping
    const rimBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.09), sampleRate);
    const rimData = rimBuf.getChannelData(0);
    for (let i = 0; i < rimData.length; i++) {
      const t = i / sampleRate;
      const woody = Math.sin(2 * Math.PI * 860 * t) * 0.55 + Math.sin(2 * Math.PI * 1680 * t) * 0.35;
      rimData[i] = woody * Math.exp(-t * 72) * 0.85;
    }

    // Hand Clap (39): 3 micro-slaps strictly band-passed around 950-2400 Hz
    const clapLen = Math.floor(sampleRate * 0.26);
    const clapRaw = new Float32Array(clapLen);
    for (let i = 0; i < clapLen; i++) clapRaw[i] = nextRand();
    const clapFiltered = filterBiquad(clapRaw, 'bpf', 1450, 1.35);
    const clapBuf = ctx.createBuffer(1, clapLen, sampleRate);
    const clapData = clapBuf.getChannelData(0);
    for (let i = 0; i < clapLen; i++) {
      const t = i / sampleRate;
      const e1 = Math.exp(-Math.max(0, t) * 140);
      const e2 = t >= 0.011 ? Math.exp(-(t - 0.011) * 140) : 0;
      const e3 = t >= 0.022 ? Math.exp(-(t - 0.022) * 18) : 0;
      const env = Math.max(e1, e2, e3);
      clapData[i] = Math.tanh(clapFiltered[i] * env * 2.1) * 0.85;
    }

    // Closed Hi-Hat (42, 44): TR-808 6-oscillator metallic ring + strict >6.8kHz HPF (zero static)
    const closedHatLen = Math.floor(sampleRate * 0.075);
    const closedHatRaw = new Float32Array(closedHatLen);
    for (let i = 0; i < closedHatLen; i++) {
      const t = i / sampleRate;
      closedHatRaw[i] = metallicSquareSum(t) * 0.82 + nextRand() * 0.18;
    }
    const closedHatFiltered = filterBiquad(closedHatRaw, 'hpf', 6800, 0.95);
    const closedHatBuf = ctx.createBuffer(1, closedHatLen, sampleRate);
    const closedHatData = closedHatBuf.getChannelData(0);
    for (let i = 0; i < closedHatLen; i++) {
      const t = i / sampleRate;
      closedHatData[i] = Math.tanh(closedHatFiltered[i] * 1.45) * Math.exp(-t * 78) * 0.72;
    }

    // Open Hi-Hat (46): Shimmering metallic decay + >6.5kHz HPF
    const openHatLen = Math.floor(sampleRate * 0.34);
    const openHatRaw = new Float32Array(openHatLen);
    for (let i = 0; i < openHatLen; i++) {
      const t = i / sampleRate;
      openHatRaw[i] = metallicSquareSum(t) * 0.84 + nextRand() * 0.16;
    }
    const openHatFiltered = filterBiquad(openHatRaw, 'hpf', 6500, 0.9);
    const openHatBuf = ctx.createBuffer(1, openHatLen, sampleRate);
    const openHatData = openHatBuf.getChannelData(0);
    for (let i = 0; i < openHatLen; i++) {
      const t = i / sampleRate;
      openHatData[i] = Math.tanh(openHatFiltered[i] * 1.35) * Math.exp(-t * 10.5) * 0.68;
    }

    // Tuned Toms (41, 43, 45, 47, 48, 50): Pure resonant membrane sweep per tom pitch
    const createTomBuf = (startFreq: number, endFreq: number) => {
      const buf = ctx.createBuffer(1, Math.floor(sampleRate * 0.36), sampleRate);
      const data = buf.getChannelData(0);
      let phase = 0;
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const pitch = (startFreq - endFreq) * Math.exp(-t * 16) + endFreq;
        phase += (2 * Math.PI * pitch) / sampleRate;
        data[i] = Math.tanh((Math.sin(phase) + Math.sin(phase * 1.52) * 0.15) * Math.exp(-t * 9.5)) * 0.9;
      }
      return buf;
    };
    const lowFloorTomBuf = createTomBuf(128, 76);
    const highFloorTomBuf = createTomBuf(150, 92);
    const lowTomBuf = createTomBuf(178, 110);
    const lowMidTomBuf = createTomBuf(212, 132);
    const hiMidTomBuf = createTomBuf(248, 158);
    const highTomBuf = createTomBuf(295, 192);

    // Crash / Ride Cymbals (49, 51, 52, 55, 57, 59): Bronze shimmer + >5.5kHz HPF
    const crashLen = Math.floor(sampleRate * 0.72);
    const crashRaw = new Float32Array(crashLen);
    for (let i = 0; i < crashLen; i++) {
      const t = i / sampleRate;
      crashRaw[i] = metallicSquareSum(t * 1.13) * 0.8 + nextRand() * 0.2;
    }
    const crashFiltered = filterBiquad(crashRaw, 'hpf', 5500, 0.85);
    const crashBuf = ctx.createBuffer(1, crashLen, sampleRate);
    const crashData = crashBuf.getChannelData(0);
    for (let i = 0; i < crashLen; i++) {
      const t = i / sampleRate;
      crashData[i] = Math.tanh(crashFiltered[i] * 1.25) * Math.exp(-t * 4.8) * 0.62;
    }

    // Ride Bell (53): Clear metallic bell chime + light bronze ring
    const bellBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.45), sampleRate);
    const bellData = bellBuf.getChannelData(0);
    for (let i = 0; i < bellData.length; i++) {
      const t = i / sampleRate;
      const harmonicBell =
        Math.sin(2 * Math.PI * 1240 * t) * 0.45 +
        Math.sin(2 * Math.PI * 1980 * t) * 0.3 +
        metallicSquareSum(t) * 0.25;
      bellData[i] = harmonicBell * Math.exp(-t * 9.0) * 0.72;
    }

    // Cowbell (56): Iconic 808 540Hz + 800Hz square/sine cowbell
    const cowbellBuf = ctx.createBuffer(1, Math.floor(sampleRate * 0.24), sampleRate);
    const cowbellData = cowbellBuf.getChannelData(0);
    for (let i = 0; i < cowbellData.length; i++) {
      const t = i / sampleRate;
      const cw = Math.tanh(Math.sin(2 * Math.PI * 540 * t) * 1.8) * 0.5 +
                 Math.tanh(Math.sin(2 * Math.PI * 800 * t) * 1.8) * 0.5;
      cowbellData[i] = cw * Math.exp(-t * 18) * 0.72;
    }

    // Shaker / Tambourine (54, 69, 70): Crisp high-passed metallic jingle (>7.4kHz)
    const shakerLen = Math.floor(sampleRate * 0.11);
    const shakerRaw = new Float32Array(shakerLen);
    for (let i = 0; i < shakerLen; i++) shakerRaw[i] = nextRand();
    const shakerFiltered = filterBiquad(shakerRaw, 'hpf', 7400, 1.1);
    const shakerBuf = ctx.createBuffer(1, shakerLen, sampleRate);
    const shakerData = shakerBuf.getChannelData(0);
    for (let i = 0; i < shakerLen; i++) {
      const t = i / sampleRate;
      const env = Math.sin(Math.min(1, t / 0.015) * (Math.PI / 2)) * Math.exp(-t * 36);
      shakerData[i] = Math.tanh(shakerFiltered[i] * 1.4) * env * 0.58;
    }

    const drumKeyMap: { [key: number]: SoundFontSampleVoice } = {
      35: { buffer: kickBuf, rootKey: 35, sampleRate, baseGain: 1.0 },
      36: { buffer: kickBuf, rootKey: 36, sampleRate, baseGain: 1.0 },
      37: { buffer: rimBuf, rootKey: 37, sampleRate, baseGain: 0.85 },
      38: { buffer: snareBuf, rootKey: 38, sampleRate, baseGain: 0.95 },
      39: { buffer: clapBuf, rootKey: 39, sampleRate, baseGain: 0.88 },
      40: { buffer: snareBuf, rootKey: 40, sampleRate, baseGain: 0.95 },
      42: { buffer: closedHatBuf, rootKey: 42, sampleRate, baseGain: 0.78 },
      44: { buffer: closedHatBuf, rootKey: 44, sampleRate, baseGain: 0.74 },
      46: { buffer: openHatBuf, rootKey: 46, sampleRate, baseGain: 0.76 },
      41: { buffer: lowFloorTomBuf, rootKey: 41, sampleRate, baseGain: 0.9 },
      43: { buffer: highFloorTomBuf, rootKey: 43, sampleRate, baseGain: 0.9 },
      45: { buffer: lowTomBuf, rootKey: 45, sampleRate, baseGain: 0.9 },
      47: { buffer: lowMidTomBuf, rootKey: 47, sampleRate, baseGain: 0.9 },
      48: { buffer: hiMidTomBuf, rootKey: 48, sampleRate, baseGain: 0.9 },
      50: { buffer: highTomBuf, rootKey: 50, sampleRate, baseGain: 0.9 },
      49: { buffer: crashBuf, rootKey: 49, sampleRate, baseGain: 0.72 },
      51: { buffer: crashBuf, rootKey: 51, sampleRate, baseGain: 0.68 },
      52: { buffer: crashBuf, rootKey: 52, sampleRate, baseGain: 0.68 },
      53: { buffer: bellBuf, rootKey: 53, sampleRate, baseGain: 0.78 },
      54: { buffer: shakerBuf, rootKey: 54, sampleRate, baseGain: 0.68 },
      55: { buffer: crashBuf, rootKey: 55, sampleRate, baseGain: 0.68 },
      56: { buffer: cowbellBuf, rootKey: 56, sampleRate, baseGain: 0.74 },
      57: { buffer: crashBuf, rootKey: 57, sampleRate, baseGain: 0.7 },
      59: { buffer: crashBuf, rootKey: 59, sampleRate, baseGain: 0.65 },
      69: { buffer: shakerBuf, rootKey: 69, sampleRate, baseGain: 0.65 },
      70: { buffer: shakerBuf, rootKey: 70, sampleRate, baseGain: 0.65 },
      75: { buffer: rimBuf, rootKey: 75, sampleRate, baseGain: 0.8 },
      76: { buffer: rimBuf, rootKey: 76, sampleRate, baseGain: 0.8 },
      77: { buffer: rimBuf, rootKey: 77, sampleRate, baseGain: 0.8 }
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
 * Register custom audio sample into SoundFont Engine (used by MOD/XM/SF2/SF3/DLS/SFZ decoders)
 */
export function registerCustomInstrument(
  id: string, 
  name: string, 
  buffer: AudioBuffer, 
  rootKey = 60, 
  sampleRate = 44100,
  loopStart?: number,
  loopEnd?: number,
  category = "Custom SF2/Samples",
  program?: number,
  bank = 0
) {
  registeredPresets.set(id, {
    id,
    name,
    category,
    bank,
    program: program !== undefined ? program : registeredPresets.size,
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
 * Parse any binary or definition SoundFont (.sf2, .sf3, .dls, .sfz, .sbk, .gig, .pat, etc.)
 * Directly powered by spressasynth_core-master.zip as the responsible reader
 * and linked to spressasynth_lib-master.zip and the audio engine!
 */
export async function parseSoundFontFile(
  arrayBuffer: ArrayBuffer, 
  fileName: string,
  audioCtx: AudioContext
): Promise<{ bankInfo: SoundFontBankInfo; instruments: SoundFontInstrument[]; logs: string[] }> {
  const result = await SpessaSynthCore.parseAsync(arrayBuffer, audioCtx, fileName);
  loadedBankInfo = result.bankInfo;
  return {
    bankInfo: result.bankInfo,
    instruments: getAvailableSoundFontInstruments(),
    logs: result.logs
  };
}


/**
 * Resolve built-in SoundBank sample buffer by MIDI bank/program/note so built-in SoundFonts
 * also pass through the configured Tracker DSP interpolation algorithm.
 */
export function getBuiltInSoundFontVoice(
  ctx: AudioContext,
  bank: number,
  program: number,
  midiNote: number
): {
  buffer: AudioBuffer;
  rootKey: number;
  pitchCorrection: number;
  loopStart?: number;
  loopEnd?: number;
  attenuationGain: number;
} | null {
  try {
    initBuiltInSoundFont(ctx);

    let chosenPreset: SoundFontPresetData | undefined;
    if (bank === 128) {
      chosenPreset = registeredPresets.get('gm_drums');
    } else {
      for (const preset of registeredPresets.values()) {
        if (!preset.isCustom && preset.bank === 0 && preset.program === program) {
          chosenPreset = preset;
          break;
        }
      }
      if (!chosenPreset) {
        // Fallback to nearest GM instrument family program
        let bestDist = 9999;
        for (const preset of registeredPresets.values()) {
          if (!preset.isCustom && preset.bank === 0) {
            const dist = Math.abs(preset.program - program);
            if (dist < bestDist) {
              bestDist = dist;
              chosenPreset = preset;
            }
          }
        }
      }
    }

    if (!chosenPreset) return null;

    let sample: SoundFontSampleVoice | null = null;
    if ((chosenPreset.samples as any).buffer) {
      sample = chosenPreset.samples as SoundFontSampleVoice;
    } else {
      const map = chosenPreset.samples as { [midiKey: number]: SoundFontSampleVoice };
      sample = map[midiNote];
      if (!sample && bank === 128) {
        // Return null for unmapped exotic percussion notes so fallback drum synthesis handles them cleanly
        // instead of substituting a heavy kick drum!
        return null;
      }
      if (!sample) {
        const vals = Object.values(map);
        if (vals.length > 0) sample = vals[0];
      }
    }
    if (!sample || !sample.buffer) return null;

    const loopStartSec =
      sample.loopStart !== undefined && sample.loopEnd !== undefined && sample.loopEnd > sample.loopStart
        ? sample.loopStart / (sample.sampleRate || 44100)
        : undefined;
    const loopEndSec =
      sample.loopStart !== undefined && sample.loopEnd !== undefined && sample.loopEnd > sample.loopStart
        ? sample.loopEnd / (sample.sampleRate || 44100)
        : undefined;

    return {
      buffer: sample.buffer,
      rootKey: sample.rootKey || 60,
      pitchCorrection: 0,
      loopStart: loopStartSec,
      loopEnd: loopEndSec,
      attenuationGain: sample.baseGain ?? 1.0
    };
  } catch {
    return null;
  }
}

/**
 * Play a SoundFont note with realistic sample pitch-shifting, Tracker DSP interpolation, and ADSR gain envelope
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

    const rawLoopStart =
      sample.loopStart !== undefined && sample.loopEnd !== undefined && sample.loopEnd > sample.loopStart
        ? sample.loopStart / sample.sampleRate
        : undefined;
    const rawLoopEnd =
      sample.loopStart !== undefined && sample.loopEnd !== undefined && sample.loopEnd > sample.loopStart
        ? sample.loopEnd / sample.sampleRate
        : undefined;

    const interp = interpolateSampleBuffer(
      ctx,
      sample.buffer,
      playbackRate,
      getInterpolationMode(),
      rawLoopStart,
      rawLoopEnd
    );

    const source = ctx.createBufferSource();
    source.buffer = interp.buffer;
    source.playbackRate.setValueAtTime(interp.playbackRate || 1.0, ctx.currentTime);

    if (interp.loopStart !== undefined && interp.loopEnd !== undefined && interp.loopEnd > interp.loopStart) {
      source.loop = true;
      source.loopStart = interp.loopStart;
      source.loopEnd = interp.loopEnd;
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
