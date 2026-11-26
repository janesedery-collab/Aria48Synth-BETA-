/**
 * FurnaceBridge.ts
 * Unified TypeScript Bridge + Binary Instrument/Wavetable/Sample/Song Parsers
 * for Headless Furnace Tracker (`aria_furnace_all.js` Emscripten C++ WASM).
 *
 * CRITICAL POLICY:
 * - Zero fallback Web Audio OscillatorNode synthesis!
 * - All DSP audio must come exclusively from the compiled C++/WASM `AriaFurnaceEngine` (`DivEngine`).
 * - Supports hot-swapping custom `.js` / `.wasm` Furnace builds via WASM Engine Manager.
 * - Full reactive state + binary parsers/exporters for `.fur`, `.fui`, `.dmp`, `.opm`, `.fuw`, `.wav`, `.dmc`, `.brr`.
 */

import { WasmBundleStatus } from '../types';
import { AriaFurnaceNodeHandle, createAriaFurnaceNode } from './furnace-worklet';
import { parseFurnaceEffectToken } from './FurnaceEffectTable';
import { convertFamiTrackerToAriaPatterns, parseFamiTrackerBinary } from '../lib/chips/nes/famitrackerParser';
import type { FamiTrackerModule } from '../lib/chips/nes/types';

export const FURNACE_ENGINE_ID = 'furnace-divengine-wasm';
export const FURNACE_DEFAULT_JS_URL = '/wasm/aria_furnace_all.js';
export const FURNACE_DEFAULT_WASM_URL = '/wasm/aria_furnace_all.wasm';

export interface FurnaceChipCatalogItem {
  id: number;           // Furnace DivSystem numeric enum ID
  code: string;
  name: string;
  channels: number;
  cores: string[];      // e.g. ['Nuked-OPN2', 'ymfm']
  defaultClockHz: number;
  clockPresets: { label: string; hz: number }[];
  category: 'FM' | 'PSG' | 'SID' | 'Wavetable' | 'Sample/PCM' | 'Nintendo';
}

export const FURNACE_CHIP_CATALOG: FurnaceChipCatalogItem[] = [
  {
    id: 0x83,
    code: 'YM2612',
    name: 'Sega Genesis YM2612 (OPN2)',
    channels: 6,
    cores: ['Nuked-OPN2', 'ymfm'],
    defaultClockHz: 7670454,
    clockPresets: [
      { label: 'NTSC 60Hz (7.67 MHz)', hz: 7670454 },
      { label: 'PAL 50Hz (7.60 MHz)', hz: 7600489 },
    ],
    category: 'FM',
  },
  {
    id: 0x03,
    code: 'SN76489',
    name: 'TI SN76489 / Sega PSG',
    channels: 4,
    cores: ['MAME-SN76496', 'Nuked-PSG'],
    defaultClockHz: 3579545,
    clockPresets: [
      { label: 'NTSC 60Hz (3.58 MHz)', hz: 3579545 },
      { label: 'PAL 50Hz (3.55 MHz)', hz: 3546894 },
    ],
    category: 'PSG',
  },
  {
    id: 0x06,
    code: 'RP2A03',
    name: 'NES 2A03 APU',
    channels: 5,
    cores: ['NSFPlay', 'puNES'],
    defaultClockHz: 1789773,
    clockPresets: [
      { label: 'NTSC 60Hz (1.79 MHz)', hz: 1789773 },
      { label: 'PAL 50Hz (1.66 MHz)', hz: 1662607 },
    ],
    category: 'Nintendo',
  },
  {
    id: 0x88,
    code: 'VRC6',
    name: 'Konami VRC6 (NES)',
    channels: 3,
    cores: ['NSFPlay', 'VRC6-Ref'],
    defaultClockHz: 1789773,
    clockPresets: [{ label: 'NTSC 60Hz (1.79 MHz)', hz: 1789773 }],
    category: 'Nintendo',
  },
  {
    id: 0x8b,
    code: 'N163',
    name: 'Namco 163 (N163)',
    channels: 8,
    cores: ['NSFPlay'],
    defaultClockHz: 1789773,
    clockPresets: [{ label: 'NTSC 60Hz (1.79 MHz)', hz: 1789773 }],
    category: 'Wavetable',
  },
  {
    id: 0x8c,
    code: 'FDS',
    name: 'Famicom Disk System (FDS)',
    channels: 1,
    cores: ['NSFPlay', 'puNES'],
    defaultClockHz: 1789773,
    clockPresets: [{ label: 'NTSC 60Hz (1.79 MHz)', hz: 1789773 }],
    category: 'Wavetable',
  },
  {
    id: 0x85,
    code: 'VRC7',
    name: 'Konami VRC7 (OPLL FM)',
    channels: 6,
    cores: ['ymfm', 'Nuked-OPLL'],
    defaultClockHz: 3579545,
    clockPresets: [{ label: 'NTSC 60Hz (3.58 MHz)', hz: 3579545 }],
    category: 'FM',
  },
  {
    id: 0x89,
    code: 'MMC5',
    name: 'Nintendo MMC5 (NES)',
    channels: 3,
    cores: ['NSFPlay'],
    defaultClockHz: 1789773,
    clockPresets: [{ label: 'NTSC 60Hz (1.79 MHz)', hz: 1789773 }],
    category: 'Nintendo',
  },
  {
    id: 0x04,
    code: 'DMG',
    name: 'Game Boy DMG-01',
    channels: 4,
    cores: ['SameBoy', 'Gambatte'],
    defaultClockHz: 4194304,
    clockPresets: [{ label: 'Standard (4.19 MHz)', hz: 4194304 }],
    category: 'Nintendo',
  },
  {
    id: 0x87,
    code: 'SPC700',
    name: 'SNES SPC700 (S-DSP)',
    channels: 8,
    cores: ['snes_spc (blargg)'],
    defaultClockHz: 1024000,
    clockPresets: [{ label: '32kHz S-DSP (1.024 MHz)', hz: 1024000 }],
    category: 'Sample/PCM',
  },
  {
    id: 0x07,
    code: 'SID6581',
    name: 'C64 SID (MOS 6581)',
    channels: 3,
    cores: ['reSIDfp', 'reSID'],
    defaultClockHz: 985248,
    clockPresets: [
      { label: 'PAL 50Hz (985 kHz)', hz: 985248 },
      { label: 'NTSC 60Hz (1.02 MHz)', hz: 1022727 },
    ],
    category: 'SID',
  },
  {
    id: 0x47,
    code: 'SID8580',
    name: 'C64 SID (MOS 8580)',
    channels: 3,
    cores: ['reSIDfp', 'reSID'],
    defaultClockHz: 985248,
    clockPresets: [
      { label: 'PAL 50Hz (985 kHz)', hz: 985248 },
      { label: 'NTSC 60Hz (1.02 MHz)', hz: 1022727 },
    ],
    category: 'SID',
  },
  {
    id: 0x05,
    code: 'HuC6280',
    name: 'PC Engine HuC6280',
    channels: 6,
    cores: ['Mednafen-HuC', 'Furnace-HuC'],
    defaultClockHz: 3579545,
    clockPresets: [{ label: 'NTSC 60Hz (3.58 MHz)', hz: 3579545 }],
    category: 'Wavetable',
  },
  {
    id: 0x82,
    code: 'YM2151',
    name: 'Arcade Yamaha YM2151 (OPM)',
    channels: 8,
    cores: ['ymfm', 'Nuked-OPM'],
    defaultClockHz: 3579545,
    clockPresets: [
      { label: 'NTSC Arcade (3.58 MHz)', hz: 3579545 },
      { label: 'Sharp X68000 (4.00 MHz)', hz: 4000000 },
    ],
    category: 'FM',
  },
  {
    id: 0x8d,
    code: 'OPL3',
    name: 'Yamaha YMF262 (OPL3)',
    channels: 18,
    cores: ['ymfm', 'Nuked-OPL3'],
    defaultClockHz: 14318180,
    clockPresets: [{ label: 'ISA SoundBlaster (14.32 MHz)', hz: 14318180 }],
    category: 'FM',
  },
  {
    id: 0x80,
    code: 'AY8910',
    name: 'AY-3-8910 / YM2149F PSG',
    channels: 3,
    cores: ['Furnace-AY', 'MAME-AY'],
    defaultClockHz: 1750000,
    clockPresets: [
      { label: 'ZX Spectrum 128k (1.77 MHz)', hz: 1773400 },
      { label: 'MSX / CPC (1.79 MHz)', hz: 1789773 },
      { label: 'Atari ST (2.00 MHz)', hz: 2000000 },
    ],
    category: 'PSG',
  },
  {
    id: 0x90,
    code: 'POKEY',
    name: 'Atari 8-bit POKEY',
    channels: 4,
    cores: ['ASAP', 'mzpokeysnd'],
    defaultClockHz: 1789773,
    clockPresets: [
      { label: 'NTSC 60Hz (1.79 MHz)', hz: 1789773 },
      { label: 'PAL 50Hz (1.77 MHz)', hz: 1773447 },
    ],
    category: 'PSG',
  },
  {
    id: 0x8f,
    code: 'SCC',
    name: 'Konami SCC (K051649)',
    channels: 5,
    cores: ['Furnace-SCC'],
    defaultClockHz: 1789773,
    clockPresets: [{ label: 'MSX (1.79 MHz)', hz: 1789773 }],
    category: 'Wavetable',
  },
];

export interface FurnaceChipSlot {
  slotId: string;
  sysId: number;
  code: string;
  name: string;
  channels: number;
  core: string;
  availableCores: string[];
  clockHz: number;
  tuningHz: number;
  volume: number;   // 0..2
  pan: number;      // -1..1
  mute: boolean;
  solo: boolean;
}

export interface FurnaceFMOperator {
  tl: number;     // Total Level 0..127
  ar: number;     // Attack Rate 0..31
  dr: number;     // Decay Rate 0..31
  d2r: number;    // Sustain Decay Rate (D2R / SR) 0..31
  sl: number;     // Sustain Level 0..15
  rr: number;     // Release Rate 0..15
  mult: number;   // Multiplier 0..15
  dt: number;     // Detune 0..7 (3 = center)
  dt2: number;    // Coarse Detune 0..3 (OPM)
  rs: number;     // Rate Scale 0..3
  am: boolean;    // Amplitude Mod Enable
  ssgEnv: number; // SSG-EG 0..15
  ksr: boolean;   // Key Scale Rate (OPL)
  ksl: number;    // Key Scale Level 0..3 (OPL)
}

export interface FurnaceFMInstrument {
  name: string;
  is2Op: boolean;
  alg: number;    // 0..7
  fb: number;     // 0..7
  fms: number;    // 0..7
  ams: number;    // 0..3
  ops: [FurnaceFMOperator, FurnaceFMOperator, FurnaceFMOperator, FurnaceFMOperator];
}

export interface FurnaceWavetable {
  id: number;
  name: string;
  width: number;  // 1..256
  height: number; // 1..255
  data: number[];
}

export type SampleBitDepth = 1 | 4 | 8 | 16;

export interface FurnaceSample {
  id: number;
  name: string;
  rate: number;
  rootNote: number;
  bitDepth: SampleBitDepth;
  loopEnable: boolean;
  loopStart: number;
  loopEnd: number;
  pcm16: Int16Array;
}

export type MacroLaneType =
  | 'volume'
  | 'arpRel'
  | 'arpFixed'
  | 'duty'
  | 'wave'
  | 'pitch'
  | 'pan'
  | 'phaseReset'
  | 'ex1'
  | 'ex2'
  | 'ex3'
  | 'op1_tl'
  | 'op1_ar'
  | 'op1_dr'
  | 'op1_mult'
  | 'op2_tl'
  | 'op3_tl'
  | 'op4_tl';

export interface FurnaceMacroLane {
  type: MacroLaneType;
  label: string;
  min: number;
  max: number;
  speed: number;    // Tick divider 1..16
  loop: number;     // -1 = disabled, or step index
  release: number;  // -1 = disabled, or step index
  values: number[];
}

export interface FurnaceSIDParams {
  cutoff: number;     // 0..2047
  resonance: number;  // 0..15
  lp: boolean;
  bp: boolean;
  hp: boolean;
  notch: boolean;
  tri: boolean;
  saw: boolean;
  pulse: boolean;
  noise: boolean;
  ringMod: boolean;
  hardSync: boolean;
  pulseWidth: number; // 0..4095
}

export interface FurnacePSGParams {
  dutyCycle: number;      // 0..7
  lfsrMode: '15-bit' | '7-bit' | '17-bit';
  noiseFreq: number;      // 0..31
  envShape: number;       // 0..15
}

export interface FurnaceRuntimeState {
  engineEnabled: boolean;
  wasmStatus: WasmBundleStatus;
  wasmError: string | null;
  wasmSourceLabel: string;
  isPlaying: boolean;
  loadedSongName: string | null;
  systems: FurnaceChipSlot[];
  activeInstIndex: number;
  fm: FurnaceFMInstrument;
  wavetables: FurnaceWavetable[];
  activeWavetableIndex: number;
  samples: FurnaceSample[];
  activeSampleIndex: number;
  macros: Record<MacroLaneType, FurnaceMacroLane>;
  sid: FurnaceSIDParams;
  psg: FurnacePSGParams;
  totalChannels: number;
}

function createDefaultOp(tl: number, mult = 1, sl = 2, rr = 6): FurnaceFMOperator {
  return {
    tl,
    ar: 31,
    dr: 10,
    d2r: 4,
    sl,
    rr,
    mult,
    dt: 3,
    dt2: 0,
    rs: 0,
    am: false,
    ssgEnv: 0,
    ksr: false,
    ksl: 0,
  };
}

function createDefaultMacros(): Record<MacroLaneType, FurnaceMacroLane> {
  const mk = (
    type: MacroLaneType,
    label: string,
    min: number,
    max: number,
    values: number[],
    loop = -1,
    release = -1
  ): FurnaceMacroLane => ({
    type,
    label,
    min,
    max,
    speed: 1,
    loop,
    release,
    values,
  });

  return {
    volume: mk('volume', 'Volume', 0, 127, [127], -1, -1),
    arpRel: mk('arpRel', 'Arpeggio (Rel)', -24, 24, [], -1, -1),
    arpFixed: mk('arpFixed', 'Arpeggio (Fixed MIDI)', 0, 127, [], -1, -1),
    duty: mk('duty', 'Duty / Noise Mode', 0, 15, [], -1, -1),
    wave: mk('wave', 'Wavetable Index', 0, 63, [], -1, -1),
    pitch: mk('pitch', 'Pitch', -128, 127, [], -1, -1),
    pan: mk('pan', 'Panning (L/R)', -127, 127, [], -1, -1),
    phaseReset: mk('phaseReset', 'Phase Reset', 0, 1, [], -1, -1),
    ex1: mk('ex1', 'Ex1 (Filter / Feedback)', 0, 255, [], -1, -1),
    ex2: mk('ex2', 'Ex2 (Modulation)', 0, 255, [], -1, -1),
    ex3: mk('ex3', 'Ex3 (Aux Chip)', 0, 255, [], -1, -1),
    op1_tl: mk('op1_tl', 'OP1 Total Level', 0, 127, [], -1, -1),
    op1_ar: mk('op1_ar', 'OP1 Attack Rate', 0, 31, [], -1, -1),
    op1_dr: mk('op1_dr', 'OP1 Decay Rate', 0, 31, [], -1, -1),
    op1_mult: mk('op1_mult', 'OP1 Multiplier', 0, 15, [], -1, -1),
    op2_tl: mk('op2_tl', 'OP2 Total Level', 0, 127, [], -1, -1),
    op3_tl: mk('op3_tl', 'OP3 Total Level', 0, 127, [], -1, -1),
    op4_tl: mk('op4_tl', 'OP4 Total Level', 0, 127, [], -1, -1),
  };
}

function buildSineWave(width = 32, height = 31): number[] {
  return Array.from({ length: width }, (_, i) =>
    Math.max(0, Math.min(height, Math.round(((Math.sin((i / width) * Math.PI * 2) + 1) * 0.5) * height)))
  );
}

const MACRO_TYPE_CODE: Record<MacroLaneType, number> = {
  volume: 0,
  arpRel: 1,
  duty: 2,
  wave: 3,
  pitch: 4,
  pan: 5,
  phaseReset: 6,
  ex1: 7,
  ex2: 8,
  ex3: 9,
  arpFixed: 1,
  op1_tl: 10,
  op1_ar: 11,
  op1_dr: 12,
  op1_mult: 13,
  op2_tl: 10,
  op3_tl: 10,
  op4_tl: 10,
};

const MACRO_OP_INDEX: Partial<Record<MacroLaneType, number>> = {
  op1_tl: 0,
  op1_ar: 0,
  op1_dr: 0,
  op1_mult: 0,
  op2_tl: 1,
  op3_tl: 2,
  op4_tl: 3,
};

const VRC7_ROM_PATCHES: number[][] = [
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // 0: Custom
  [0x03, 0x21, 0x05, 0x06, 0xb8, 0x81, 0x42, 0x27], // 1: Buzzy Bell
  [0x13, 0x41, 0x13, 0x0d, 0xd8, 0xd6, 0x23, 0x12], // 2: Guitar
  [0x31, 0x11, 0x08, 0x08, 0xfa, 0x9a, 0x22, 0x02], // 3: Wurly
  [0x31, 0x61, 0x18, 0x07, 0x78, 0x64, 0x30, 0x27], // 4: Flute
  [0x22, 0x21, 0x1e, 0x06, 0xf0, 0x76, 0x08, 0x28], // 5: Clarinet
  [0x02, 0x01, 0x06, 0x00, 0xf0, 0xf2, 0x03, 0xf5], // 6: Synth
  [0x21, 0x61, 0x1d, 0x07, 0x82, 0x81, 0x16, 0x07], // 7: Trumpet
  [0x23, 0x21, 0x1a, 0x17, 0xcf, 0x72, 0x25, 0x17], // 8: Organ
  [0x15, 0x11, 0x25, 0x00, 0x4f, 0x71, 0x00, 0x11], // 9: Bells
  [0x85, 0x01, 0x12, 0x0f, 0x99, 0xa2, 0x40, 0x02], // 10: Vibes
  [0xa7, 0xc1, 0x69, 0x07, 0xf0, 0x77, 0x18, 0x07], // 11: Vibraphone
  [0x61, 0x22, 0x0d, 0x02, 0xc3, 0x7f, 0x24, 0x05], // 12: Tutti
  [0x01, 0x02, 0xd3, 0x05, 0xc2, 0xb2, 0x00, 0x01], // 13: Fretless
  [0x61, 0x62, 0x0c, 0x05, 0xf2, 0xf4, 0x00, 0x01], // 14: Synth Bass
  [0x21, 0x62, 0x0d, 0x00, 0x84, 0xf4, 0x00, 0x01], // 15: Sweep Bass
];

function decodeDpcmToInt16(u8: Uint8Array, initialCounter = 64): Int16Array<ArrayBuffer> {
  const totalBits = u8.length * 8;
  const pcm16 = new Int16Array(new ArrayBuffer(totalBits * 2));
  if (totalBits === 0) return pcm16;

  const raw = new Float32Array(totalBits);
  let counter = initialCounter >= 0 ? Math.max(0, Math.min(126, initialCounter)) : 64;
  for (let b = 0; b < u8.length; b++) {
    const byte = u8[b];
    for (let bit = 0; bit < 8; bit++) {
      if ((byte & (1 << bit)) !== 0) {
        if (counter <= 125) counter += 2;
      } else {
        if (counter >= 2) counter -= 2;
      }
      raw[b * 8 + bit] = (counter - 63.5) / 63.5;
    }
  }

  // 1-pole DC blocker removes hardware delta counter drift & maximizes punchy AC headroom
  const hp = new Float32Array(totalBits);
  let prevX = raw[0];
  let prevY = 0;
  let maxAbs = 0;
  for (let i = 0; i < totalBits; i++) {
    const x = raw[i];
    const y = x - prevX + 0.996 * prevY;
    prevX = x;
    prevY = y;
    hp[i] = y;
    const a = Math.abs(y);
    if (a > maxAbs) maxAbs = a;
  }

  const normScale = maxAbs > 0.002 ? Math.min(3.5, 0.85 / maxAbs) * 29000 : 24000;
  for (let i = 0; i < totalBits; i++) {
    const v = Math.round(hp[i] * normScale);
    pcm16[i] = Math.max(-32768, Math.min(32767, v));
  }
  return pcm16;
}

function ftmEffectToNumericId(code: string): number {
  const c = (code || '').toUpperCase();
  if (c === 'S') return 0xec; // Note Cut
  if (c === 'G') return 0xed; // Note Delay
  if (c === 'V') return 0x12; // Duty / Mode
  if (/^[0-9A-F]$/.test(c)) return parseInt(c, 16);
  if (c.length === 1) return 0x100 + c.charCodeAt(0); // 'P'->0x150, 'Q'->0x151, 'R'->0x152, 'W'->0x157, 'Y'->0x159, 'Z'->0x15A, '='->0x13D
  return -1;
}

class FurnaceBridgeEngine {
  public readonly engineId = FURNACE_ENGINE_ID;
  private listeners: Array<(state: FurnaceRuntimeState) => void> = [];
  private workletHandle: AriaFurnaceNodeHandle | null = null;
  private outputBus: AudioNode | null = null;
  private hostCtx: AudioContext | null = null;

  private wasmModule: any = null;
  private wasmEngine: any = null;
  private renderLPtr = 0;
  private renderRPtr = 0;
  private scopePtr = 0;
  private customJsUrl: string | null = null;
  private customWasmUrl: string | null = null;
  private scopeScratch = new Float32Array(1024);
  private pendingSongRaw: Uint8Array | null = null;
  private pendingSongKind: 'fur' | 'ftm' | null = null;
  private pendingGridSong: any = null;
  private pendingTempoScale = 1.0;
  private attachPromise: Promise<void> | null = null;
  private wasmLoadPromise: Promise<boolean> | null = null;
  private workletPrimed = false;
  private ftmChannelMapOverride: Array<{
    chipKind: number;
    tuningHz: number;
    freqMul?: number;
    ftmChipIdx?: number;
    volume: number;
    pan: number;
    defaultDuty: number;
  }> | null = null;
  private ftmInstrumentSyncList: Array<{
    instIdx: number;
    waveId?: number;
    vrc7Regs?: Uint8Array;
    ftmMacroSpec?: {
      arp?: { loop: number; release: number; mode: number; items: number[] };
      pitch?: { loop: number; release: number; mode: number; items: number[] };
      hiPitch?: { loop: number; release: number; mode: number; items: number[] };
    };
    macros: Array<{ code: number; speed: number; loop: number; release: number; mode: number; values: number[] }>;
    dpcmMaps: Array<{ note: number; sampleId: number; rateIdx: number; loop: boolean }>;
  }> = [];

  private state: FurnaceRuntimeState = {
    engineEnabled: true,
    wasmStatus: 'unloaded',
    wasmError: null,
    wasmSourceLabel: 'No ARIA Furnace WASM loaded (ready to attach aria_furnace_all.js)',
    isPlaying: false,
    loadedSongName: null,
    systems: [
      {
        slotId: 'slot-0',
        sysId: 0x83,
        code: 'YM2612',
        name: 'Sega Genesis YM2612 (OPN2)',
        channels: 6,
        core: 'Nuked-OPN2',
        availableCores: ['Nuked-OPN2', 'ymfm'],
        clockHz: 7670454,
        tuningHz: 440,
        volume: 1.0,
        pan: 0,
        mute: false,
        solo: false,
      },
      {
        slotId: 'slot-1',
        sysId: 0x03,
        code: 'SN76489',
        name: 'TI SN76489 / Sega PSG',
        channels: 4,
        core: 'MAME-SN76496',
        availableCores: ['MAME-SN76496', 'Nuked-PSG'],
        clockHz: 3579545,
        tuningHz: 440,
        volume: 0.9,
        pan: 0,
        mute: false,
        solo: false,
      },
    ],
    activeInstIndex: 0,
    fm: {
      name: 'Genesis Bass 4-Op',
      is2Op: false,
      alg: 4,
      fb: 5,
      fms: 0,
      ams: 0,
      ops: [
        createDefaultOp(24, 2, 3, 6),
        createDefaultOp(18, 1, 2, 7),
        createDefaultOp(28, 1, 4, 5),
        createDefaultOp(8, 1, 1, 6),
      ],
    },
    wavetables: [
      { id: 0, name: 'Sine 32x32', width: 32, height: 31, data: buildSineWave(32, 31) },
      {
        id: 1,
        name: 'Sawtooth 32x15',
        width: 32,
        height: 15,
        data: Array.from({ length: 32 }, (_, i) => Math.round((i / 31) * 15)),
      },
    ],
    activeWavetableIndex: 0,
    samples: [],
    activeSampleIndex: 0,
    macros: createDefaultMacros(),
    sid: {
      cutoff: 1024,
      resonance: 6,
      lp: true,
      bp: false,
      hp: false,
      notch: false,
      tri: false,
      saw: true,
      pulse: true,
      noise: false,
      ringMod: false,
      hardSync: false,
      pulseWidth: 2048,
    },
    psg: {
      dutyCycle: 2,
      lfsrMode: '15-bit',
      noiseFreq: 16,
      envShape: 8,
    },
    totalChannels: 10,
  };

  public getState(): FurnaceRuntimeState {
    return this.state;
  }

  public subscribe(listener: (state: FurnaceRuntimeState) => void): () => void {
    this.listeners.push(listener);
    listener(this.state);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  private notify() {
    const snap = { ...this.state };
    this.listeners.forEach((cb) => {
      try { cb(snap); } catch {}
    });
  }

  public isWasmReady(): boolean {
    return this.state.wasmStatus === 'ready' && Boolean(this.wasmEngine);
  }

  public setEngineEnabled(enabled: boolean) {
    this.state = { ...this.state, engineEnabled: enabled };
    if (!enabled) {
      this.workletPrimed = false;
      this.workletHandle?.clear();
      this.workletHandle?.setActive(false);
    } else if (this.isWasmReady()) {
      this.ensureWorkletStreaming();
    }
    this.notify();
  }

  /**
   * Ensures the default `/wasm/aria_furnace_all.js` + `.wasm` bundle is loaded once.
   */
  public ensureWasmLoaded(): Promise<boolean> {
    if (this.isWasmReady()) return Promise.resolve(true);
    if (this.wasmLoadPromise) return this.wasmLoadPromise;
    return this.loadWasmBundle();
  }

  /**
   * Connects the AriaFurnaceNode AudioWorkletNode into the MasterAudioRouter 'FURNACE' input bus
   * and automatically loads the compiled Furnace WASM engine if not already initialized.
   */
  public async attachToMasterRouter(ctx: AudioContext, destinationBus: AudioNode): Promise<void> {
    this.hostCtx = ctx;
    this.outputBus = destinationBus;

    if (!this.workletHandle) {
      if (!this.attachPromise) {
        this.attachPromise = createAriaFurnaceNode(ctx, (missing) => {
          this.pumpWasmAudio(missing);
        })
          .then((handle) => {
            this.workletHandle = handle;
          })
          .finally(() => {
            this.attachPromise = null;
          });
      }
      await this.attachPromise;
    }

    if (this.workletHandle?.node) {
      try {
        this.workletHandle.node.disconnect();
      } catch {}
      this.workletHandle.node.connect(destinationBus);
    }

    if (this.wasmEngine?.setSampleRate && ctx.sampleRate) {
      try {
        this.wasmEngine.setSampleRate(ctx.sampleRate);
      } catch {}
    }

    if (this.state.wasmStatus === 'unloaded') {
      void this.ensureWasmLoaded();
    } else if (this.isWasmReady() && this.state.engineEnabled) {
      this.ensureWorkletStreaming();
    }
  }

  private ensureWorkletStreaming() {
    if (!this.workletHandle || !this.state.engineEnabled || !this.isWasmReady()) return;
    if (!this.workletPrimed) {
      this.workletPrimed = true;
      this.workletHandle.setActive(true);
      this.pumpWasmAudio(1024);
      this.pumpWasmAudio(1024);
      this.pumpWasmAudio(1024);
      this.pumpWasmAudio(1024);
    }
  }

  /**
   * Loads `aria_furnace_all.js` (Emscripten ES6 module) + corresponding `.wasm`.
   * Zero fake oscillator fallback if the file has not yet been provided/compiled.
   */
  public async loadWasmBundle(
    jsUrlOrBlob?: string,
    wasmUrlOrBlob?: string,
    sourceLabel?: string
  ): Promise<boolean> {
    const isCustomSwap = Boolean(jsUrlOrBlob || wasmUrlOrBlob);
    if (!isCustomSwap && this.isWasmReady()) return true;
    if (!isCustomSwap && this.wasmLoadPromise) return this.wasmLoadPromise;

    const runLoad = async (): Promise<boolean> => {
      const jsUrl = jsUrlOrBlob || this.customJsUrl || FURNACE_DEFAULT_JS_URL;
      const wasmUrl = wasmUrlOrBlob || this.customWasmUrl || FURNACE_DEFAULT_WASM_URL;
      if (jsUrlOrBlob) this.customJsUrl = jsUrlOrBlob;
      if (wasmUrlOrBlob) this.customWasmUrl = wasmUrlOrBlob;

      this.state = {
        ...this.state,
        wasmStatus: 'loading',
        wasmError: null,
        wasmSourceLabel: sourceLabel || jsUrl,
      };
      this.notify();

      try {
        const probe = await fetch(jsUrl);
        if (!probe.ok) {
          throw new Error(`Furnace JS bundle unavailable (${probe.status}) at ${jsUrl}`);
        }
        const jsText = await probe.text();
        if (jsText.trimStart().startsWith('<!doctype') || jsText.trimStart().startsWith('<html')) {
          throw new Error('aria_furnace_all.js is not present in /public/wasm/. Load a compiled Emscripten bundle in WASM Engine Manager.');
        }

        const originBase = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
        const resolvedJsUrl = jsUrl.startsWith('blob:') || /^https?:\/\//i.test(jsUrl)
          ? jsUrl
          : new URL(jsUrl, originBase).href;
        const resolvedWasmUrl = wasmUrl.startsWith('blob:') || /^https?:\/\//i.test(wasmUrl)
          ? wasmUrl
          : new URL(wasmUrl, originBase).href;

        // Rewrite import.meta.url when importing via Blob URL so relative .wasm lookups & Vite public assets stay valid
        const moduleCode = jsText.includes('import.meta.url')
          ? jsText.replaceAll('import.meta.url', JSON.stringify(resolvedJsUrl))
          : jsText;
        const blobUrl = URL.createObjectURL(new Blob([moduleCode], { type: 'application/javascript' }));
        let modImport: any;
        try {
          modImport = await import(/* @vite-ignore */ blobUrl);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }

        const factory =
          modImport?.default ||
          modImport?.createAriaFurnaceModule ||
          (typeof window !== 'undefined' ? (window as any).createAriaFurnaceModule : null);

        if (typeof factory !== 'function') {
          throw new Error('Loaded bundle does not export an Emscripten factory (createAriaFurnaceModule)');
        }

        const moduleInstance = await factory({
          locateFile: (path: string) => (path.endsWith('.wasm') ? resolvedWasmUrl : path),
        });

        this.attachEmscriptenModule(moduleInstance, sourceLabel || jsUrl);
        return true;
      } catch (err: any) {
        this.state = {
          ...this.state,
          wasmStatus: 'unloaded',
          wasmError: err?.message || 'Furnace WASM binary not loaded',
        };
        this.notify();
        return false;
      }
    };

    const p = runLoad().finally(() => {
      if (this.wasmLoadPromise === p) {
        this.wasmLoadPromise = null;
      }
    });
    if (!isCustomSwap) {
      this.wasmLoadPromise = p;
    }
    return p;
  }

  /**
   * Binds a pre-instantiated Emscripten `aria_furnace_all` module (real WASM or test harness).
   */
  public attachEmscriptenModule(moduleInstance: any, label = 'Attached aria_furnace_all WASM') {
    this.wasmModule = moduleInstance;
    const EngineCtor = moduleInstance?.AriaFurnaceEngine;
    if (typeof EngineCtor !== 'function') {
      throw new Error('AriaFurnaceEngine Embind class missing on WASM module');
    }

    const engine = new EngineCtor();
    const sr = this.hostCtx?.sampleRate || 44100;
    engine.init(sr, 1024);

    if (this.renderLPtr && this.wasmEngine?.deallocate) {
      try { this.wasmEngine.deallocate(this.renderLPtr); } catch {}
    }
    this.wasmEngine = engine;
    this.renderLPtr = engine.allocate(1024 * 4);
    this.renderRPtr = engine.allocate(1024 * 4);
    this.scopePtr = engine.allocate(1024 * 4);

    this.state = {
      ...this.state,
      wasmStatus: 'ready',
      wasmError: null,
      wasmSourceLabel: label,
    };

    // Push staged chip stack, FM patch, wavetables, samples, macros, SID/PSG params into WASM
    this.syncFullStateToWasm();
    if (this.state.engineEnabled) {
      this.workletPrimed = false;
      this.ensureWorkletStreaming();
    }
    this.notify();
  }

  private pumpWasmAudio(frames = 1024) {
    if (!this.wasmEngine || !this.wasmModule || !this.state.engineEnabled || !this.workletHandle) return;
    const safeFrames = Math.min(1024, Math.max(128, frames));
    try {
      const rendered = this.wasmEngine.render(this.renderLPtr, this.renderRPtr, safeFrames);
      if (rendered > 0 && this.wasmModule.HEAPF32) {
        const lOffset = this.renderLPtr >> 2;
        const rOffset = this.renderRPtr >> 2;
        const left = this.wasmModule.HEAPF32.subarray(lOffset, lOffset + rendered);
        const right = this.wasmModule.HEAPF32.subarray(rOffset, rOffset + rendered);
        this.workletHandle.pushFrames(left, right);
      }
    } catch {}
  }

  public syncFullStateToWasm() {
    if (!this.wasmEngine) return;
    try {
      if (this.hostCtx?.sampleRate && typeof this.wasmEngine.setSampleRate === 'function') {
        this.wasmEngine.setSampleRate(this.hostCtx.sampleRate);
      }
      if (typeof this.wasmEngine.clearAllMacros === 'function') {
        this.wasmEngine.clearAllMacros();
      }
      if (this.pendingSongKind === 'fur' && this.pendingSongRaw && this.wasmModule?.HEAPU8) {
        const ptr = this.wasmEngine.allocate(this.pendingSongRaw.length);
        this.wasmModule.HEAPU8.set(this.pendingSongRaw, ptr);
        this.wasmEngine.loadSong(ptr, this.pendingSongRaw.length);
        this.wasmEngine.deallocate(ptr);
        this.wasmEngine.setTempoScale?.(this.pendingTempoScale);
        if (this.state.isPlaying) {
          try { this.wasmEngine.play?.(); } catch {}
        }
      } else if (this.pendingSongKind === 'ftm' && this.pendingGridSong) {
        this.wasmEngine.loadGridSong?.(this.pendingGridSong);
        this.wasmEngine.setTempoScale?.(this.pendingTempoScale);
        if (this.state.isPlaying) {
          try { this.wasmEngine.play?.(); } catch {}
        }
      }
      this.wasmEngine.clearSystems();
      this.state.systems.forEach((slot, idx) => {
        this.wasmEngine.addSystem(slot.sysId, slot.availableCores.indexOf(slot.core), slot.clockHz, slot.tuningHz);
        this.wasmEngine.setChipMix(idx, slot.volume, slot.pan, slot.mute, slot.solo);
      });
      if (typeof this.wasmEngine.setCustomChannelMap === 'function') {
        this.wasmEngine.setCustomChannelMap(this.ftmChannelMapOverride);
      }
      const instIdx = this.state.activeInstIndex;
      const fm = this.state.fm;
      this.wasmEngine.setFMGlobal(instIdx, fm.alg, fm.fb, fm.fms, fm.ams, fm.is2Op);
      fm.ops.forEach((op, opIdx) => {
        this.wasmEngine.setFMOperator(
          instIdx, opIdx,
          op.tl, op.ar, op.dr, op.d2r, op.sl, op.rr,
          op.mult, op.dt, op.dt2, op.rs, op.am ? 1 : 0, op.ssgEnv, op.ksr ? 1 : 0, op.ksl
        );
      });
      this.state.wavetables.forEach((w) => this.pushWavetableToWasm(w));
      if (typeof this.wasmEngine.clearSamples === 'function') {
        this.wasmEngine.clearSamples();
      }
      this.state.samples.forEach((s) => this.pushSampleToWasm(s));
      if (this.ftmInstrumentSyncList.length === 0) {
        (Object.values(this.state.macros) as FurnaceMacroLane[]).forEach((m) => this.pushMacroToWasm(m));
      } else {
        this.syncFtmInstrumentsToWasm();
      }
      this.pushSIDToWasm();
      this.pushPSGToWasm();
    } catch {}
  }

  private syncFtmInstrumentsToWasm() {
    if (!this.wasmEngine || !this.wasmModule?.HEAP32 || this.ftmInstrumentSyncList.length === 0) return;
    for (const entry of this.ftmInstrumentSyncList) {
      if (typeof entry.waveId === 'number' && typeof this.wasmEngine.setInstWaveId === 'function') {
        this.wasmEngine.setInstWaveId(entry.instIdx, entry.waveId);
      }
      if (entry.ftmMacroSpec && typeof this.wasmEngine.setFtmMacros === 'function') {
        this.wasmEngine.setFtmMacros(entry.instIdx, entry.ftmMacroSpec);
      }
      if (entry.vrc7Regs && entry.vrc7Regs.length >= 8) {
        const r = entry.vrc7Regs;
        const fb = r[3] & 0x07;
        this.wasmEngine.setFMGlobal(entry.instIdx, 0, fb, 0, 0, true);
        const modTl = r[2] & 0x3f;
        const modAr = (r[4] >> 4) & 0x0f;
        const modDr = r[4] & 0x0f;
        const modSl = (r[6] >> 4) & 0x0f;
        const modRr = r[6] & 0x0f;
        const modMult = r[0] & 0x0f;
        const carAr = (r[5] >> 4) & 0x0f;
        const carDr = r[5] & 0x0f;
        const carSl = (r[7] >> 4) & 0x0f;
        const carRr = r[7] & 0x0f;
        const carMult = r[1] & 0x0f;
        this.wasmEngine.setFMOperator(entry.instIdx, 0, Math.min(127, modTl * 2), modAr * 2 + 1, modDr * 2, 0, modSl, modRr, modMult, 3, 0, 0, (r[0] & 0x80) ? 1 : 0, 0, 0, 0);
        this.wasmEngine.setFMOperator(entry.instIdx, 1, 8, carAr * 2 + 1, carDr * 2, 0, carSl, carRr, carMult, 3, 0, 0, (r[1] & 0x80) ? 1 : 0, 0, 0, 0);
      }
      for (const m of entry.macros) {
        if (m.values.length === 0) continue;
        const ptr = this.wasmEngine.allocate(m.values.length * 4);
        const heap = this.wasmModule.HEAP32 as Int32Array;
        const base = ptr >> 2;
        for (let i = 0; i < m.values.length; i++) {
          heap[base + i] = m.values[i];
        }
        this.wasmEngine.setMacro(
          entry.instIdx,
          -1,
          m.code,
          m.speed,
          m.loop,
          m.release,
          m.mode,
          ptr,
          m.values.length
        );
        this.wasmEngine.deallocate(ptr);
      }
      if (typeof this.wasmEngine.setDpcmMap === 'function') {
        for (const dpcm of entry.dpcmMaps) {
          this.wasmEngine.setDpcmMap(entry.instIdx, dpcm.note, dpcm.sampleId, dpcm.rateIdx, dpcm.loop);
        }
      }
    }
  }

  public play() {
    if (!this.state.engineEnabled) return;
    if (this.wasmEngine && (this.pendingSongKind === 'fur' || this.pendingSongKind === 'ftm')) {
      try {
        this.wasmEngine.setTempoScale?.(this.pendingTempoScale);
        this.wasmEngine.play?.();
      } catch {}
    }
    if (this.isWasmReady()) {
      this.ensureWorkletStreaming();
    }
    if (!this.state.isPlaying) {
      this.state = { ...this.state, isPlaying: true };
      this.notify();
    }
  }

  public pause() {
    if (this.wasmEngine) {
      try { this.wasmEngine.stop?.(); } catch {}
    }
    this.workletPrimed = false;
    this.workletHandle?.clear();
    this.workletHandle?.setActive(false);
    if (this.state.isPlaying) {
      this.state = { ...this.state, isPlaying: false };
      this.notify();
    }
  }

  public stop() {
    this.pause();
  }

  public setTempoScale(scale: number) {
    const safeScale = Number.isFinite(scale) && scale > 0.1 && scale < 4.0 ? scale : 1.0;
    this.pendingTempoScale = safeScale;
    if (this.wasmEngine) {
      try { this.wasmEngine.setTempoScale?.(safeScale); } catch {}
    }
  }

  public seekToRatio(ratio: number) {
    const r = Math.max(0, Math.min(0.999, Number(ratio) || 0));
    if (this.wasmEngine) {
      try { this.wasmEngine.seekToRatio?.(r); } catch {}
    }
    this.workletHandle?.clear();
    this.workletPrimed = false;
    if (this.state.isPlaying && this.isWasmReady()) {
      this.ensureWorkletStreaming();
    }
  }

  public getPlaybackProgress(): {
    orderIdx: number;
    rowIdx: number;
    elapsedSeconds: number;
    totalSeconds: number;
    ratio: number;
    isPlaying: boolean;
  } {
    if (this.wasmEngine?.getPlaybackProgress) {
      try {
        return this.wasmEngine.getPlaybackProgress();
      } catch {}
    }
    return {
      orderIdx: 0,
      rowIdx: 0,
      elapsedSeconds: 0,
      totalSeconds: 0,
      ratio: 0,
      isPlaying: this.state.isPlaying,
    };
  }

  public clearLoadedSong() {
    this.pendingSongRaw = null;
    this.pendingSongKind = null;
    this.pendingGridSong = null;
    this.pendingTempoScale = 1.0;
    this.ftmInstrumentSyncList = [];
    this.ftmChannelMapOverride = null;
    if (this.wasmEngine) {
      try { this.wasmEngine.loadGridSong?.(null); } catch {}
      try { this.wasmEngine.setCustomChannelMap?.(null); } catch {}
      try { this.wasmEngine.stop?.(); } catch {}
    }
    this.workletPrimed = false;
    this.workletHandle?.clear();
    this.workletHandle?.setActive(false);
    if (this.state.loadedSongName !== null || this.state.isPlaying) {
      this.state = { ...this.state, loadedSongName: null, isPlaying: false };
      this.notify();
    }
  }

  // --- SYSTEM RACK OPERATIONS ---

  public addSystem(chipId: number) {
    const def = FURNACE_CHIP_CATALOG.find((c) => c.id === chipId) || FURNACE_CHIP_CATALOG[0];
    const slot: FurnaceChipSlot = {
      slotId: `slot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sysId: def.id,
      code: def.code,
      name: def.name,
      channels: def.channels,
      core: def.cores[0],
      availableCores: def.cores,
      clockHz: def.defaultClockHz,
      tuningHz: 440,
      volume: 1.0,
      pan: 0,
      mute: false,
      solo: false,
    };
    const nextSystems = [...this.state.systems, slot];
    this.state = {
      ...this.state,
      systems: nextSystems,
      totalChannels: nextSystems.reduce((sum, s) => sum + s.channels, 0),
    };
    if (this.wasmEngine) {
      this.wasmEngine.addSystem(slot.sysId, 0, slot.clockHz, slot.tuningHz);
    }
    this.notify();
  }

  public removeSystem(slotIndex: number) {
    if (this.state.systems.length <= 1) return;
    const nextSystems = this.state.systems.filter((_, idx) => idx !== slotIndex);
    this.state = {
      ...this.state,
      systems: nextSystems,
      totalChannels: nextSystems.reduce((sum, s) => sum + s.channels, 0),
    };
    if (this.wasmEngine) {
      this.wasmEngine.removeSystem(slotIndex);
    }
    this.notify();
  }

  public updateSystemSlot(slotIndex: number, patch: Partial<FurnaceChipSlot>) {
    const nextSystems = this.state.systems.map((slot, idx) =>
      idx === slotIndex ? { ...slot, ...patch } : slot
    );
    this.state = { ...this.state, systems: nextSystems };
    const updated = nextSystems[slotIndex];
    if (this.wasmEngine && updated) {
      if (patch.core !== undefined) this.wasmEngine.setCore(slotIndex, updated.core.toLowerCase());
      if (patch.clockHz !== undefined) this.wasmEngine.setClock(slotIndex, updated.clockHz);
      if (patch.tuningHz !== undefined) this.wasmEngine.setTuning(slotIndex, updated.tuningHz);
      if (
        patch.volume !== undefined ||
        patch.pan !== undefined ||
        patch.mute !== undefined ||
        patch.solo !== undefined
      ) {
        this.wasmEngine.setChipMix(slotIndex, updated.volume, updated.pan, updated.mute, updated.solo);
      }
    }
    this.notify();
  }

  // --- FM INSTRUMENT EDITOR ---

  public updateFMGlobal(patch: Partial<Pick<FurnaceFMInstrument, 'name' | 'is2Op' | 'alg' | 'fb' | 'fms' | 'ams'>>) {
    const fm = { ...this.state.fm, ...patch };
    this.state = { ...this.state, fm };
    if (this.wasmEngine) {
      this.wasmEngine.setFMGlobal(this.state.activeInstIndex, fm.alg, fm.fb, fm.fms, fm.ams, fm.is2Op);
    }
    this.notify();
  }

  public updateFMOperator(opIndex: number, patch: Partial<FurnaceFMOperator>) {
    if (opIndex < 0 || opIndex > 3) return;
    const ops = [...this.state.fm.ops] as FurnaceFMInstrument['ops'];
    ops[opIndex] = { ...ops[opIndex], ...patch };
    const fm = { ...this.state.fm, ops };
    this.state = { ...this.state, fm };
    const op = ops[opIndex];
    if (this.wasmEngine) {
      this.wasmEngine.setFMOperator(
        this.state.activeInstIndex,
        opIndex,
        op.tl, op.ar, op.dr, op.d2r, op.sl, op.rr,
        op.mult, op.dt, op.dt2, op.rs, op.am ? 1 : 0, op.ssgEnv, op.ksr ? 1 : 0, op.ksl
      );
    }
    this.notify();
  }

  // --- WAVETABLE (.FUW) EDITOR ---

  public setActiveWavetable(index: number) {
    if (index < 0 || index >= this.state.wavetables.length) return;
    this.state = { ...this.state, activeWavetableIndex: index };
    this.notify();
  }

  public addWavetable(name = `Wave ${this.state.wavetables.length}`): number {
    const id = this.state.wavetables.length;
    const wave: FurnaceWavetable = {
      id,
      name,
      width: 32,
      height: 31,
      data: buildSineWave(32, 31),
    };
    this.state = {
      ...this.state,
      wavetables: [...this.state.wavetables, wave],
      activeWavetableIndex: id,
    };
    this.pushWavetableToWasm(wave);
    this.notify();
    return id;
  }

  public updateWavetable(index: number, patch: Partial<FurnaceWavetable>) {
    const next = this.state.wavetables.map((w, idx) => {
      if (idx !== index) return w;
      const width = Math.max(1, Math.min(256, patch.width ?? w.width));
      const height = Math.max(1, Math.min(255, patch.height ?? w.height));
      let data = patch.data ? [...patch.data] : [...w.data];
      if (data.length !== width) {
        const resized = new Array<number>(width);
        for (let i = 0; i < width; i++) {
          const srcIdx = Math.min(data.length - 1, Math.floor((i / width) * data.length));
          resized[i] = Math.max(0, Math.min(height, data[srcIdx] ?? 0));
        }
        data = resized;
      } else {
        data = data.map((v) => Math.max(0, Math.min(height, Math.round(v))));
      }
      return { ...w, ...patch, width, height, data };
    });
    this.state = { ...this.state, wavetables: next };
    if (next[index]) this.pushWavetableToWasm(next[index]);
    this.notify();
  }

  private pushWavetableToWasm(wave: FurnaceWavetable) {
    if (!this.wasmEngine || !this.wasmModule?.HEAP32) return;
    try {
      const ptr = this.wasmEngine.allocate(wave.width * 4);
      const heap = this.wasmModule.HEAP32 as Int32Array;
      const base = ptr >> 2;
      for (let i = 0; i < wave.width; i++) {
        heap[base + i] = wave.data[i] ?? 0;
      }
      this.wasmEngine.uploadWavetable(wave.id, wave.width, wave.height, ptr);
      this.wasmEngine.deallocate(ptr);
    } catch {}
  }

  // --- SAMPLE / PCM / BRR EDITOR ---

  public addOrReplaceSample(sample: Omit<FurnaceSample, 'id'>, targetIdx?: number): number {
    const id = targetIdx ?? this.state.samples.length;
    const entry: FurnaceSample = { ...sample, id };
    const next = [...this.state.samples];
    if (id < next.length) next[id] = entry;
    else next.push(entry);
    this.state = {
      ...this.state,
      samples: next,
      activeSampleIndex: id,
    };
    this.pushSampleToWasm(entry);
    this.notify();
    return id;
  }

  public updateSample(index: number, patch: Partial<FurnaceSample>) {
    const next = this.state.samples.map((s, idx) => (idx === index ? { ...s, ...patch } : s));
    this.state = { ...this.state, samples: next };
    if (next[index]) this.pushSampleToWasm(next[index]);
    this.notify();
  }

  public setActiveSample(index: number) {
    this.state = { ...this.state, activeSampleIndex: Math.max(0, index) };
    this.notify();
  }

  private pushSampleToWasm(sample: FurnaceSample) {
    if (!this.wasmEngine || !this.wasmModule?.HEAP16 || sample.pcm16.length === 0) return;
    try {
      const ptr = this.wasmEngine.allocate(sample.pcm16.length * 2);
      this.wasmModule.HEAP16.set(sample.pcm16, ptr >> 1);
      this.wasmEngine.uploadSample(
        sample.id,
        sample.rate,
        sample.bitDepth,
        sample.loopEnable ? sample.loopStart : -1,
        sample.loopEnable ? sample.loopEnd : -1,
        ptr,
        sample.pcm16.length
      );
      this.wasmEngine.deallocate(ptr);
    } catch {}
  }

  // --- MACRO SEQUENCER ---

  public updateMacro(type: MacroLaneType, patch: Partial<FurnaceMacroLane>) {
    const cur = this.state.macros[type];
    if (!cur) return;
    const values = patch.values
      ? patch.values.map((v) => Math.max(cur.min, Math.min(cur.max, Math.round(v))))
      : cur.values;
    const nextMacro: FurnaceMacroLane = {
      ...cur,
      ...patch,
      values,
      loop: Math.max(-1, Math.min(values.length - 1, patch.loop ?? cur.loop)),
      release: Math.max(-1, Math.min(values.length - 1, patch.release ?? cur.release)),
      speed: Math.max(1, Math.min(16, patch.speed ?? cur.speed)),
    };
    this.state = {
      ...this.state,
      macros: { ...this.state.macros, [type]: nextMacro },
    };
    this.pushMacroToWasm(nextMacro);
    this.notify();
  }

  private pushMacroToWasm(macro: FurnaceMacroLane) {
    if (!this.wasmEngine || !this.wasmModule?.HEAP32) return;
    if (macro.values.length === 0) return;
    try {
      const len = macro.values.length;
      const ptr = this.wasmEngine.allocate(len * 4);
      const base = ptr >> 2;
      for (let i = 0; i < macro.values.length; i++) {
        this.wasmModule.HEAP32[base + i] = macro.values[i];
      }
      const opIdx = MACRO_OP_INDEX[macro.type] ?? -1;
      const code = MACRO_TYPE_CODE[macro.type] ?? 0;
      const mode = macro.type === 'arpFixed' ? 1 : 0;
      this.wasmEngine.setMacro(
        this.state.activeInstIndex,
        opIdx,
        code,
        macro.speed,
        macro.loop,
        macro.release,
        mode,
        ptr,
        macro.values.length
      );
      this.wasmEngine.deallocate(ptr);
    } catch {}
  }

  // --- SID & PSG CHIP CONTROLS ---

  public updateSIDParams(patch: Partial<FurnaceSIDParams>) {
    const sid = { ...this.state.sid, ...patch };
    this.state = { ...this.state, sid };
    this.pushSIDToWasm();
    this.notify();
  }

  private pushSIDToWasm() {
    if (!this.wasmEngine) return;
    const s = this.state.sid;
    const filterMask = (s.lp ? 1 : 0) | (s.bp ? 2 : 0) | (s.hp ? 4 : 0) | (s.notch ? 8 : 0);
    const waveMask = (s.tri ? 1 : 0) | (s.saw ? 2 : 0) | (s.pulse ? 4 : 0) | (s.noise ? 8 : 0);
    try {
      this.wasmEngine.setSIDParams(
        this.state.activeInstIndex,
        s.cutoff,
        s.resonance,
        filterMask,
        waveMask,
        s.pulseWidth,
        s.ringMod,
        s.hardSync
      );
    } catch {}
  }

  public updatePSGParams(patch: Partial<FurnacePSGParams>) {
    const psg = { ...this.state.psg, ...patch };
    this.state = { ...this.state, psg };
    this.pushPSGToWasm();
    this.notify();
  }

  private pushPSGToWasm() {
    if (!this.wasmEngine) return;
    const p = this.state.psg;
    const lfsrCode = p.lfsrMode === '7-bit' ? 1 : p.lfsrMode === '17-bit' ? 2 : 0;
    try {
      this.wasmEngine.setPSGParams(this.state.activeInstIndex, p.dutyCycle, lfsrCode, p.noiseFreq);
    } catch {}
  }

  // --- LIVE NOTE / EFFECT DISPATCH TO WASM ONLY ---

  public noteOn(channel: number, midiNote: number, velocity = 100, instIndex = this.state.activeInstIndex): boolean {
    if (!this.state.engineEnabled || !this.wasmEngine) return false;
    try {
      this.wasmEngine.noteOn(channel, midiNote, velocity, instIndex);
      this.ensureWorkletStreaming();
      return true;
    } catch {
      return false;
    }
  }

  public noteOff(channel: number): void {
    if (!this.wasmEngine) return;
    try {
      this.wasmEngine.noteOff(channel);
    } catch {}
  }

  public sendEffect(channel: number, fxToken: string): void {
    if (!this.state.engineEnabled || !this.wasmEngine) return;
    const parsed = parseFurnaceEffectToken(fxToken);
    if (!parsed) return;
    try {
      this.wasmEngine.setEffect(channel, parsed.effectId, parsed.effectVal);
    } catch {}
  }

  public getChannelScopeSamples(channelIndex: number, target: Float32Array): {
    hasData: boolean;
    peak: number;
    sumSq: number;
  } {
    target.fill(0);
    if (!this.wasmEngine || !this.wasmModule?.HEAPF32 || !this.scopePtr) {
      return { hasData: false, peak: 0, sumSq: 0 };
    }
    try {
      const len = Math.min(target.length, 1024);
      const count = this.wasmEngine.getChannelScope(channelIndex, this.scopePtr, len);
      if (count <= 0) return { hasData: false, peak: 0, sumSq: 0 };
      const base = this.scopePtr >> 2;
      const heap = this.wasmModule.HEAPF32 as Float32Array;
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < len; i++) {
        const s = heap[base + i] || 0;
        target[i] = s;
        const av = Math.abs(s);
        if (av > peak) peak = av;
        sumSq += av * av;
      }
      return { hasData: peak > 0.0005, peak, sumSq };
    } catch {
      return { hasData: false, peak: 0, sumSq: 0 };
    }
  }

  // --- BINARY FORMAT PARSERS & EXPORTERS (.fui, .dmp, .opm, .fuw, .wav, .dmc, .brr, .fur) ---

  public importFUI(buffer: ArrayBuffer, fileName = 'instrument.fui'): FurnaceFMInstrument {
    const u8 = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const magic = String.fromCharCode(...u8.slice(0, 4));
    let fm = { ...this.state.fm, name: fileName.replace(/\.[^.]+$/, '') };

    if (magic === 'FINS' && u8.length >= 16) {
      // New Furnace FINS instrument format
      let offset = 8;
      while (offset + 4 <= u8.length) {
        const tag = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
        const size = offset + 6 <= u8.length ? view.getUint16(offset + 4, true) : 0;
        if (tag === 'FM' && offset + 10 < u8.length) {
          const dataOff = offset + 6;
          const flags = u8[dataOff];
          fm.alg = (u8[dataOff + 1] >> 4) & 7;
          fm.fb = u8[dataOff + 1] & 7;
          fm.fms = u8[dataOff + 2] & 7;
          fm.ams = (u8[dataOff + 2] >> 3) & 3;
          fm.is2Op = (flags & 0x0f) <= 2;
          const opCount = Math.min(4, Math.max(2, flags & 0x0f));
          const ops = [...fm.ops] as FurnaceFMInstrument['ops'];
          for (let i = 0; i < opCount && dataOff + 4 + i * 8 + 7 < u8.length; i++) {
            const o = dataOff + 4 + i * 8;
            ops[i] = {
              ...ops[i],
              am: (u8[o] & 0x80) !== 0,
              ar: u8[o] & 0x1f,
              dr: u8[o + 1] & 0x1f,
              mult: u8[o + 2] & 0x0f,
              dt: (u8[o + 2] >> 4) & 0x07,
              d2r: u8[o + 3] & 0x1f,
              ksl: (u8[o + 3] >> 6) & 0x03,
              tl: u8[o + 4] & 0x7f,
              sl: (u8[o + 5] >> 4) & 0x0f,
              rr: u8[o + 5] & 0x0f,
              rs: (u8[o + 6] >> 6) & 0x03,
              ssgEnv: u8[o + 6] & 0x0f,
              dt2: (u8[o + 7] >> 5) & 0x03,
            };
          }
          fm.ops = ops;
          break;
        }
        if (tag === 'EN' || size <= 0) break;
        offset += 6 + size;
      }
    } else if (magic === '-INS' && u8.length >= 64) {
      // Legacy Furnace INST header fallback
      fm.alg = u8[48] & 7;
      fm.fb = u8[49] & 7;
    }

    this.state = { ...this.state, fm };
    if (this.wasmEngine && this.wasmModule?.HEAPU8) {
      const ptr = this.wasmEngine.allocate(u8.length);
      this.wasmModule.HEAPU8.set(u8, ptr);
      this.wasmEngine.uploadInstrumentFUI(this.state.activeInstIndex, ptr, u8.length);
      this.wasmEngine.deallocate(ptr);
    }
    this.syncFullStateToWasm();
    this.notify();
    return fm;
  }

  public exportFUI(): Uint8Array {
    const fm = this.state.fm;
    const opBytes = 4 + 4 * 8;
    const total = 8 + (6 + opBytes) + 6;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set([0x46, 0x49, 0x4e, 0x53], 0); // "FINS"
    view.setUint16(4, 210, true);          // format version
    out[6] = 1;                            // FM type

    // "FM  " feature block (offset 8)
    out.set([0x46, 0x4d, 0x00, 0x00], 8);
    out[8] = 0x46; out[9] = 0x4d; out[10] = 0x00; out[11] = 0x00;
    view.setUint16(12, opBytes, true);
    const d = 14;
    out[d] = (fm.is2Op ? 2 : 4) | 0xf0;
    out[d + 1] = ((fm.alg & 7) << 4) | (fm.fb & 7);
    out[d + 2] = ((fm.ams & 3) << 3) | (fm.fms & 7);
    out[d + 3] = 0;

    for (let i = 0; i < 4; i++) {
      const op = fm.ops[i];
      const o = d + 4 + i * 8;
      out[o] = (op.am ? 0x80 : 0) | (op.ar & 0x1f);
      out[o + 1] = op.dr & 0x1f;
      out[o + 2] = ((op.dt & 7) << 4) | (op.mult & 0x0f);
      out[o + 3] = ((op.ksl & 3) << 6) | (op.d2r & 0x1f);
      out[o + 4] = op.tl & 0x7f;
      out[o + 5] = ((op.sl & 0x0f) << 4) | (op.rr & 0x0f);
      out[o + 6] = ((op.rs & 3) << 6) | (op.ssgEnv & 0x0f);
      out[o + 7] = (op.dt2 & 3) << 5;
    }

    const endOff = d + opBytes;
    out.set([0x45, 0x4e, 0x44, 0x00], endOff); // "END\0"
    return out;
  }

  public importDMP(buffer: ArrayBuffer, fileName = 'preset.dmp'): FurnaceFMInstrument {
    const u8 = new Uint8Array(buffer);
    const fm = { ...this.state.fm, name: fileName.replace(/\.[^.]+$/, '') };
    if (u8.length >= 47) {
      // DefleMask v11+ YM2612 preset layout
      const off = u8[0] >= 11 ? 3 : 2;
      if (off + 44 <= u8.length) {
        fm.fms = u8[off] & 7;
        fm.fb = u8[off + 1] & 7;
        fm.alg = u8[off + 2] & 7;
        fm.ams = u8[off + 3] & 3;
        const ops = [...fm.ops] as FurnaceFMInstrument['ops'];
        for (let i = 0; i < 4; i++) {
          const o = off + 4 + i * 11;
          ops[i] = {
            ...ops[i],
            mult: u8[o] & 0x0f,
            tl: u8[o + 1] & 0x7f,
            ar: u8[o + 2] & 0x1f,
            dr: u8[o + 3] & 0x1f,
            sl: u8[o + 4] & 0x0f,
            rr: u8[o + 5] & 0x0f,
            am: (u8[o + 6] & 1) !== 0,
            rs: u8[o + 7] & 3,
            dt: u8[o + 8] & 7,
            d2r: u8[o + 9] & 0x1f,
            ssgEnv: u8[o + 10] & 0x0f,
          };
        }
        fm.ops = ops;
      }
    }
    this.state = { ...this.state, fm };
    this.syncFullStateToWasm();
    this.notify();
    return fm;
  }

  public exportDMP(): Uint8Array {
    const fm = this.state.fm;
    const out = new Uint8Array(51);
    out[0] = 11; // DefleMask v11
    out[1] = 2;  // YM2612
    out[2] = 1;  // FM mode
    out[3] = fm.fms & 7;
    out[4] = fm.fb & 7;
    out[5] = fm.alg & 7;
    out[6] = fm.ams & 3;
    for (let i = 0; i < 4; i++) {
      const op = fm.ops[i];
      const o = 7 + i * 11;
      out[o] = op.mult & 0x0f;
      out[o + 1] = op.tl & 0x7f;
      out[o + 2] = op.ar & 0x1f;
      out[o + 3] = op.dr & 0x1f;
      out[o + 4] = op.sl & 0x0f;
      out[o + 5] = op.rr & 0x0f;
      out[o + 6] = op.am ? 1 : 0;
      out[o + 7] = op.rs & 3;
      out[o + 8] = op.dt & 7;
      out[o + 9] = op.d2r & 0x1f;
      out[o + 10] = op.ssgEnv & 0x0f;
    }
    return out;
  }

  public importOPM(text: string, fileName = 'preset.opm'): FurnaceFMInstrument {
    const fm = { ...this.state.fm, name: fileName.replace(/\.[^.]+$/, '') };
    const lines = text.split(/\r?\n/);
    const ops = [...fm.ops] as FurnaceFMInstrument['ops'];
    const opLabels = ['M1:', 'C1:', 'M2:', 'C2:'];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('CH:')) {
        const nums = trimmed.replace('CH:', '').trim().split(/\s+/).map(Number);
        if (nums.length >= 3) {
          fm.fb = nums[1] & 7;
          fm.alg = nums[2] & 7;
          fm.ams = (nums[3] ?? 0) & 3;
          fm.fms = (nums[4] ?? 0) & 7;
        }
      } else {
        const idx = opLabels.findIndex((lbl) => trimmed.startsWith(lbl));
        if (idx !== -1) {
          const nums = trimmed.slice(3).trim().split(/\s+/).map(Number);
          if (nums.length >= 10) {
            ops[idx] = {
              ...ops[idx],
              ar: nums[0] & 31,
              dr: nums[1] & 31,
              d2r: nums[2] & 31,
              rr: nums[3] & 15,
              sl: nums[4] & 15,
              tl: nums[5] & 127,
              rs: nums[6] & 3,
              mult: nums[7] & 15,
              dt: nums[8] & 7,
              dt2: nums[9] & 3,
              am: (nums[10] ?? 0) > 0,
            };
          }
        }
      }
    }
    fm.ops = ops;
    this.state = { ...this.state, fm };
    this.syncFullStateToWasm();
    this.notify();
    return fm;
  }

  public exportOPM(): string {
    const fm = this.state.fm;
    const labels = ['M1', 'C1', 'M2', 'C2'];
    const lines = [
      '// Aria 48 Furnace OPM Export',
      `@:0 ${fm.name}`,
      `LFO: 0 0 0 0 0`,
      `CH: 64 ${fm.fb} ${fm.alg} ${fm.ams} ${fm.fms} 120 0`,
    ];
    fm.ops.forEach((op, idx) => {
      lines.push(
        `${labels[idx]}: ${op.ar} ${op.dr} ${op.d2r} ${op.rr} ${op.sl} ${op.tl} ${op.rs} ${op.mult} ${op.dt} ${op.dt2} ${op.am ? 128 : 0}`
      );
    });
    return lines.join('\n') + '\n';
  }

  public importFUW(buffer: ArrayBuffer, fileName = 'wave.fuw'): FurnaceWavetable {
    const u8 = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let width = 32;
    let height = 31;
    let data: number[] = [];
    const magic = String.fromCharCode(...u8.slice(0, 4));
    if (magic === 'WAVE' && u8.length >= 24) {
      width = Math.max(1, Math.min(256, view.getUint32(12, true)));
      height = Math.max(1, Math.min(255, view.getUint32(16, true)));
      const headerOff = 24;
      for (let i = 0; i < width && headerOff + i * 4 + 3 < u8.length; i++) {
        data.push(Math.max(0, Math.min(height, view.getInt32(headerOff + i * 4, true))));
      }
    } else {
      width = Math.max(1, Math.min(256, u8.length));
      height = 255;
      data = Array.from(u8.slice(0, width));
    }
    if (data.length === 0) data = buildSineWave(width, height);

    const idx = this.addWavetable(fileName.replace(/\.[^.]+$/, ''));
    this.updateWavetable(idx, { width, height, data });
    return this.state.wavetables[idx];
  }

  public exportFUW(wave: FurnaceWavetable): Uint8Array {
    const out = new Uint8Array(24 + wave.width * 4);
    const view = new DataView(out.buffer);
    out.set([0x57, 0x41, 0x56, 0x45], 0); // "WAVE"
    view.setUint16(4, 210, true);
    view.setUint32(12, wave.width, true);
    view.setUint32(16, wave.height, true);
    for (let i = 0; i < wave.width; i++) {
      view.setInt32(24 + i * 4, wave.data[i] ?? 0, true);
    }
    return out;
  }

  /**
   * Decodes `.wav` (PCM), `.dmc` (1-bit NES DPCM), or `.brr` (SNES 4-bit ADPCM) into Int16 PCM.
   */
  public importSampleFile(buffer: ArrayBuffer, fileName: string): FurnaceSample {
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    const u8 = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let pcm16 = new Int16Array(0);
    let rate = 16000;
    let bitDepth: SampleBitDepth = 16;

    if (ext === '.dmc') {
      bitDepth = 1;
      rate = 33144;
      pcm16 = decodeDpcmToInt16(u8, 64);
    } else if (ext === '.brr') {
      bitDepth = 4;
      rate = 32000;
      const blocks = Math.floor(u8.length / 9);
      const out = new Int16Array(blocks * 16);
      let s1 = 0;
      let s2 = 0;
      for (let b = 0; b < blocks; b++) {
        const hdr = u8[b * 9];
        const shift = (hdr >> 4) & 0x0f;
        const filter = (hdr >> 2) & 0x03;
        for (let i = 0; i < 8; i++) {
          const byte = u8[b * 9 + 1 + i];
          for (let n = 0; n < 2; n++) {
            let nibble = n === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
            if (nibble >= 8) nibble -= 16;
            let sample = shift <= 12 ? (nibble << shift) >> 1 : nibble < 0 ? -2048 : 0;
            if (filter === 1) sample += s1 + ((-s1) >> 4);
            else if (filter === 2) sample += (s1 << 1) + ((-((s1 << 1) + s1)) >> 5) - s2 + (s2 >> 4);
            else if (filter === 3) sample += (s1 << 1) + ((-(s1 * 13)) >> 6) - s2 + ((s2 * 3) >> 4);
            sample = Math.max(-32768, Math.min(32767, sample));
            s2 = s1;
            s1 = sample;
            out[b * 16 + i * 2 + n] = sample;
          }
        }
        if ((hdr & 1) !== 0) break;
      }
      pcm16 = out;
    } else {
      // RIFF WAVE parser (PCM 8/16-bit mono/stereo)
      if (u8.length >= 44 && String.fromCharCode(...u8.slice(0, 4)) === 'RIFF') {
        let off = 12;
        let channels = 1;
        let bits = 16;
        while (off + 8 <= u8.length) {
          const chunkId = String.fromCharCode(...u8.slice(off, off + 4));
          const chunkLen = view.getUint32(off + 4, true);
          if (chunkId === 'fmt ' && off + 24 <= u8.length) {
            channels = Math.max(1, view.getUint16(off + 10, true));
            rate = view.getUint32(off + 12, true) || 16000;
            bits = view.getUint16(off + 22, true) || 16;
            bitDepth = bits <= 8 ? 8 : 16;
          } else if (chunkId === 'data') {
            const dataStart = off + 8;
            const dataEnd = Math.min(u8.length, dataStart + chunkLen);
            if (bits <= 8) {
              const count = Math.floor((dataEnd - dataStart) / channels);
              pcm16 = new Int16Array(count);
              for (let i = 0; i < count; i++) {
                pcm16[i] = (u8[dataStart + i * channels] - 128) << 8;
              }
            } else {
              const count = Math.floor((dataEnd - dataStart) / (2 * channels));
              pcm16 = new Int16Array(count);
              for (let i = 0; i < count; i++) {
                pcm16[i] = view.getInt16(dataStart + i * 2 * channels, true);
              }
            }
            break;
          }
          off += 8 + chunkLen + (chunkLen % 2);
        }
      }
    }

    const id = this.addOrReplaceSample({
      name: fileName.replace(/\.[^.]+$/, ''),
      rate,
      rootNote: 60,
      bitDepth,
      loopEnable: false,
      loopStart: 0,
      loopEnd: Math.max(0, pcm16.length - 1),
      pcm16,
    });
    return this.state.samples[id];
  }

  /**
   * Loads a `.fur` Furnace song binary (zlib-compressed or raw) into Furnace WASM and updates track state.
   */
  public async loadFurBuffer(arrayBuffer: ArrayBuffer, fileName = 'song.fur'): Promise<{
    title: string;
    bpm: number;
    channelsCount: number;
    chipNames: string[];
  }> {
    let raw = new Uint8Array(arrayBuffer);
    // Zlib-compressed .fur starts with 0x78 (CMF)
    if (raw.length > 2 && raw[0] === 0x78 && typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate');
        const stream = new Blob([raw]).stream().pipeThrough(ds);
        const decompressed = await new Response(stream).arrayBuffer();
        raw = new Uint8Array(decompressed);
      } catch {}
    }

    let title = fileName.replace(/\.[^.]+$/, '');
    let bpm = 125;
    let channelsCount = 10;
    const chipNames: string[] = [];

    const nextFurSystems: FurnaceChipSlot[] = [];

    if (raw.length >= 64 && String.fromCharCode(...raw.slice(0, 15)) === '-Furnace module') {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const infoPtr = view.getUint32(20, true);
      if (infoPtr > 0 && infoPtr + 48 < raw.length) {
        const timeBase = Math.max(0, Math.min(8, raw[infoPtr + 8] || 0));
        const speed1 = Math.max(1, raw[infoPtr + 9] || 6);
        const speed2 = Math.max(1, raw[infoPtr + 10] || speed1);
        const avgSpeed = Math.max(1, (speed1 + speed2) * 0.5);
        const hzRaw = view.getFloat32(infoPtr + 12, true);
        const hz = Number.isFinite(hzRaw) && hzRaw >= 10 && hzRaw <= 400 ? hzRaw : 60;
        bpm = Math.max(40, Math.min(300, Math.round((15 * hz) / (avgSpeed * (timeBase + 1)))));

        channelsCount = 0;
        for (let i = 0; i < 32 && infoPtr + 32 + i < raw.length; i++) {
          const sysId = raw[infoPtr + 32 + i];
          if (!sysId) break;
          const match = FURNACE_CHIP_CATALOG.find((c) => c.id === sysId);
          if (match) {
            chipNames.push(match.name);
            channelsCount += match.channels;
            nextFurSystems.push({
              slotId: `fur-slot-${i}-${Date.now()}`,
              sysId: match.id,
              code: match.code,
              name: match.name,
              channels: match.channels,
              core: match.cores[0],
              availableCores: match.cores,
              clockHz: match.defaultClockHz,
              tuningHz: 440,
              volume: 1.0,
              pan: 0,
              mute: false,
              solo: false,
            });
          }
        }
        if (channelsCount <= 0) channelsCount = 8;
      }
      // Extract null-terminated song name around info strings if present
      const infoTextStart = Math.min(raw.length, (infoPtr || 64) + 128);
      let s = '';
      for (let i = infoTextStart; i < Math.min(raw.length, infoTextStart + 64); i++) {
        if (raw[i] === 0) break;
        if (raw[i] >= 32 && raw[i] < 127) s += String.fromCharCode(raw[i]);
      }
      if (s.trim().length >= 2) title = s.trim();
    }

    this.pendingSongRaw = raw;
    this.pendingSongKind = 'fur';
    this.pendingGridSong = null;
    this.pendingTempoScale = 1.0;
    this.ftmInstrumentSyncList = [];
    this.ftmChannelMapOverride = null;

    this.state = {
      ...this.state,
      ...(nextFurSystems.length > 0
        ? {
            systems: nextFurSystems,
            totalChannels: nextFurSystems.reduce((sum, sys) => sum + sys.channels, 0),
          }
        : {}),
      loadedSongName: title,
      isPlaying: false,
    };
    this.syncFullStateToWasm();
    this.notify();

    return {
      title,
      bpm,
      channelsCount: Math.max(4, Math.min(48, channelsCount)),
      chipNames,
    };
  }

  /**
   * Diverts a FamiTracker (.ftm, .0cc, .dnm) module into the Furnace Tracker engine:
   * configures Furnace DivSystem chip racks (RP2A03 + VRC6/VRC7/FDS/MMC5/N163/AY8910),
   * decodes 1-bit DPCM samples into Furnace's Sample Bank, maps FTM sequences & DPCM maps
   * for ALL instruments to Furnace macros, and syncs everything to `AriaFurnaceEngine`.
   */
  public loadFamiTrackerBuffer(
    arrayBuffer: ArrayBuffer,
    fileName = 'module.ftm',
    preParsedMod?: FamiTrackerModule
  ): {
    title: string;
    bpm: number;
    channelsCount: number;
    chipNames: string[];
  } {
    const mod = preParsedMod || parseFamiTrackerBinary(arrayBuffer, fileName);
    const clockHz = mod.machine === 'PAL' ? 1662607 : 1789773;

    this.pendingSongRaw = new Uint8Array(arrayBuffer);
    this.pendingSongKind = 'ftm';

    const expToCode = (exp: string): { code: string; customName?: string; channelsOverride?: number } => {
      switch (exp) {
        case 'VRC6':
          return { code: 'VRC6' };
        case 'VRC7':
          return { code: 'VRC7' };
        case 'FDS':
          return { code: 'FDS' };
        case 'MMC5':
          return { code: 'MMC5', channelsOverride: 2 };
        case 'N163':
          return { code: 'N163', channelsOverride: Math.max(1, Math.min(8, mod.n163Channels || 1)) };
        case 'Sunsoft 5B':
          return { code: 'AY8910', customName: 'Sunsoft 5B (Furnace AY)' };
        default:
          return { code: 'RP2A03' };
      }
    };

    const nextSystems: FurnaceChipSlot[] = [];
    const expList = mod.expansions.length > 0 ? mod.expansions : ['2A03'];
    expList.forEach((exp, idx) => {
      const mapped = expToCode(exp);
      const def =
        FURNACE_CHIP_CATALOG.find((c) => c.code === mapped.code) ||
        FURNACE_CHIP_CATALOG.find((c) => c.code === 'RP2A03')!;
      nextSystems.push({
        slotId: `ftm-slot-${idx}-${Date.now()}`,
        sysId: def.id,
        code: def.code,
        name: mapped.customName || def.name,
        channels: mapped.channelsOverride ?? def.channels,
        core: def.cores[0],
        availableCores: def.cores,
        clockHz: def.code === 'VRC7' ? 3579545 : clockHz,
        tuningHz: 440,
        volume: 1.0,
        pan: 0,
        mute: false,
        solo: false,
      });
    });

    // Decode 1-bit DPCM samples into Int16 PCM buffers for Furnace Sample Bank & DivEngine upload
    const dmcIdxBySampleIndex = new Map<number, number>();
    const initialDeltaBySampleIndex = new Map<number, number>();
    for (const ins of mod.instruments) {
      if (Array.isArray(ins.dpcmMap)) {
        for (const entry of ins.dpcmMap) {
          if (entry && entry.sampleIndex >= 0 && entry.deltaCounter >= 0 && !initialDeltaBySampleIndex.has(entry.sampleIndex)) {
            initialDeltaBySampleIndex.set(entry.sampleIndex, entry.deltaCounter);
          }
        }
      }
    }
    const decodedSamples: FurnaceSample[] = mod.dpcmSamples.map((dmc, idx) => {
      dmcIdxBySampleIndex.set(dmc.index, idx);
      const startCounter = initialDeltaBySampleIndex.get(dmc.index) ?? 64;
      const pcm16 = decodeDpcmToInt16(dmc.data, startCounter);
      return {
        id: idx,
        name: dmc.name || `DPCM #${dmc.index}`,
        rate: 33144,
        rootNote: 60,
        bitDepth: 1,
        loopEnable: false,
        loopStart: 0,
        loopEnd: Math.max(0, pcm16.length - 1),
        pcm16,
      };
    });

    // Build wavetable slots for FDS / N163 instruments (slots 0..1 reserved for defaults, 2+ for song waves)
    const nextWavetables: FurnaceWavetable[] = [
      { id: 0, name: 'Sine 32x32', width: 32, height: 31, data: buildSineWave(32, 31) },
      {
        id: 1,
        name: 'Sawtooth 32x15',
        width: 32,
        height: 15,
        data: Array.from({ length: 32 }, (_, i) => Math.round((i / 31) * 15)),
      },
    ];
    let nextWaveSlot = 2;

    // Build per-instrument macro + DPCM + wavetable + VRC7 mappings for EVERY FamiTracker instrument
    const syncEntries: typeof this.ftmInstrumentSyncList = [];
    for (const ins of mod.instruments) {
      const findSeq = (seqType: number, seqIdx: number) =>
        seqIdx >= 0
          ? mod.sequences.find((s) => s.type === seqType && s.index === seqIdx && s.chip === ins.chip) ||
            mod.sequences.find((s) => s.type === seqType && s.index === seqIdx)
          : undefined;

      const macros: Array<{ code: number; speed: number; loop: number; release: number; mode: number; values: number[] }> = [];
      const ftmMacroSpec: NonNullable<typeof this.ftmInstrumentSyncList[number]['ftmMacroSpec']> = {};

      const volSeq = findSeq(0, ins.seqIndices[0]);
      if (volSeq && volSeq.items.length > 0) {
        macros.push({
          code: 0,
          speed: 1,
          loop: volSeq.loopPoint,
          release: volSeq.releasePoint,
          mode: 0,
          values: volSeq.items.map((v) => Math.max(0, Math.min(127, Math.round((Math.max(0, v) / 15) * 127)))),
        });
      }
      const arpSeq = findSeq(1, ins.seqIndices[1]);
      if (arpSeq && arpSeq.items.length > 0) {
        const isFixedArp = arpSeq.setting === 1;
        let arpValues: number[];
        if (isFixedArp) {
          arpValues = arpSeq.items.map((v) => {
            const unsignedNote = v < 0 ? v + 256 : v;
            return Math.max(12, Math.min(119, unsignedNote + 12));
          });
        } else if (arpSeq.setting === 2) {
          let acc = 0;
          arpValues = arpSeq.items.map((v) => {
            const delta = v > 127 ? v - 256 : v;
            acc = Math.max(-36, Math.min(36, acc + delta));
            return acc;
          });
        } else if (arpSeq.setting === 3) {
          arpValues = arpSeq.items.map((v) => {
            const signed6 = ((v & 0x3f) << 26) >> 26;
            return Math.max(-36, Math.min(36, signed6));
          });
        } else {
          arpValues = arpSeq.items.map((v) => Math.max(-36, Math.min(36, v > 127 ? v - 256 : v)));
        }
        ftmMacroSpec.arp = {
          loop: arpSeq.loopPoint,
          release: arpSeq.releasePoint,
          mode: isFixedArp ? 1 : 0,
          items: arpValues,
        };
        macros.push({
          code: 1,
          speed: 1,
          loop: arpSeq.loopPoint,
          release: arpSeq.releasePoint,
          mode: isFixedArp ? 1 : 0,
          values: arpValues,
        });
      }
      const pitchSeq = findSeq(2, ins.seqIndices[2]);
      if (pitchSeq && pitchSeq.items.length > 0) {
        const pitchVals = pitchSeq.items.map((v) => Math.max(-128, Math.min(127, v > 127 ? v - 256 : v)));
        ftmMacroSpec.pitch = {
          loop: pitchSeq.loopPoint,
          release: pitchSeq.releasePoint,
          mode: pitchSeq.setting === 1 ? 1 : 0,
          items: pitchVals,
        };
        macros.push({
          code: 4,
          speed: 1,
          loop: pitchSeq.loopPoint,
          release: pitchSeq.releasePoint,
          mode: 2, // Mode 2 tells WASM Lane 3 not to clobber exact period-space pitch computed by stepGridTick
          values: pitchVals,
        });
      }
      const hiPitchSeq = findSeq(3, ins.seqIndices[3]);
      if (hiPitchSeq && hiPitchSeq.items.length > 0) {
        ftmMacroSpec.hiPitch = {
          loop: hiPitchSeq.loopPoint,
          release: hiPitchSeq.releasePoint,
          mode: hiPitchSeq.setting === 1 ? 1 : 0,
          items: hiPitchSeq.items.map((v) => Math.max(-128, Math.min(127, v > 127 ? v - 256 : v))),
        };
      }
      const dutySeq = findSeq(4, ins.seqIndices[4]);
      if (dutySeq && dutySeq.items.length > 0) {
        macros.push({
          code: 2,
          speed: 1,
          loop: dutySeq.loopPoint,
          release: dutySeq.releasePoint,
          mode: 0,
          values: dutySeq.items.map((v) => Math.max(0, Math.min(15, v))),
        });
      }

      const dpcmMaps: Array<{ note: number; sampleId: number; rateIdx: number; loop: boolean }> = [];
      if (Array.isArray(ins.dpcmMap)) {
        ins.dpcmMap.forEach((entry, k) => {
          if (entry && entry.sampleIndex >= 0) {
            const mappedSampleId = dmcIdxBySampleIndex.get(entry.sampleIndex) ?? entry.sampleIndex;
            dpcmMaps.push({
              note: k + 12, // FTM C-0 (k=0) -> MIDI 12
              sampleId: mappedSampleId,
              rateIdx: Math.max(0, Math.min(15, entry.pitch ?? 15)),
              loop: Boolean(entry.loop),
            });
          }
        });
      }

      let waveId: number | undefined;
      if (ins.chip === 'FDS' && ins.fdsWave && ins.fdsWave.length > 0 && nextWaveSlot < 250) {
        waveId = nextWaveSlot++;
        nextWavetables.push({
          id: waveId,
          name: `${ins.name} FDS`,
          width: ins.fdsWave.length,
          height: 63,
          data: Array.from(ins.fdsWave),
        });
      } else if (ins.chip === 'N163' && ins.n163Waves && ins.n163Waves.length > 0 && nextWaveSlot < 250) {
        waveId = nextWaveSlot;
        for (const w of ins.n163Waves) {
          if (nextWaveSlot >= 250) break;
          nextWavetables.push({
            id: nextWaveSlot++,
            name: `${ins.name} N163`,
            width: w.length,
            height: 15,
            data: Array.from(w),
          });
        }
      }

      let vrc7Regs: Uint8Array | undefined;
      if (ins.chip === 'VRC7') {
        const patchIdx = ins.vrc7Patch ?? 0;
        if (patchIdx === 0 && ins.vrc7CustomRegs && ins.vrc7CustomRegs.length >= 8) {
          vrc7Regs = ins.vrc7CustomRegs;
        } else if (patchIdx > 0 && patchIdx < VRC7_ROM_PATCHES.length) {
          vrc7Regs = Uint8Array.from(VRC7_ROM_PATCHES[patchIdx]);
        } else {
          vrc7Regs = Uint8Array.from(VRC7_ROM_PATCHES[1]);
        }
      }

      syncEntries.push({ instIdx: ins.index, waveId, vrc7Regs, ftmMacroSpec, macros, dpcmMaps });
    }
    this.ftmInstrumentSyncList = syncEntries;

    // Populate UI macro preview from clean neutral lanes + first valid 2A03 instrument
    const nextMacros = createDefaultMacros();
    const first2A03Inst = mod.instruments.find((ins) => ins.chip === '2A03') || mod.instruments[0];
    if (first2A03Inst) {
      const entry = syncEntries.find((e) => e.instIdx === first2A03Inst.index);
      const volM = entry?.macros.find((m) => m.code === 0);
      if (volM) nextMacros.volume = { ...nextMacros.volume, values: volM.values, loop: volM.loop, release: volM.release };
      const arpM = entry?.macros.find((m) => m.code === 1);
      if (arpM) {
        if (arpM.mode === 1) {
          nextMacros.arpFixed = { ...nextMacros.arpFixed, values: arpM.values, loop: arpM.loop, release: arpM.release };
        } else {
          nextMacros.arpRel = { ...nextMacros.arpRel, values: arpM.values, loop: arpM.loop, release: arpM.release };
        }
      }
      const pitchM = entry?.macros.find((m) => m.code === 4);
      if (pitchM) nextMacros.pitch = { ...nextMacros.pitch, values: pitchM.values, loop: pitchM.loop, release: pitchM.release };
      const dutyM = entry?.macros.find((m) => m.code === 2);
      if (dutyM) nextMacros.duty = { ...nextMacros.duty, values: dutyM.values, loop: dutyM.loop, release: dutyM.release };
    }

    this.ftmChannelMapOverride = (mod.channels || []).slice(0, 48).map((ftCh) => {
      let chipKind = 2; // NES Pulse default
      let freqMul = 1.0;
      let ftmChipIdx = mod.machine === 'PAL' ? 1 : 0;
      let defaultDuty = ftCh.subChannel === 0 ? 1 : 2;
      if (ftCh.chip === '2A03') {
        chipKind =
          ftCh.subChannel === 2 ? 3 : ftCh.subChannel === 3 ? 4 : ftCh.subChannel === 4 ? 5 : 2;
        if (ftCh.subChannel === 2) {
          // FamiTracker Triangle plays 1 octave lower than Pulse for the same written note (CPU / (32*(P+1)))
          freqMul = 0.5;
        } else if (ftCh.subChannel === 3) {
          defaultDuty = 0; // Long white noise mode by default (short loop enabled explicitly via V01 or duty macro)
        }
      } else if (ftCh.chip === 'VRC6') {
        chipKind = ftCh.subChannel === 2 ? 7 : 6;
        if (ftCh.subChannel === 2) ftmChipIdx = 2;
      } else if (ftCh.chip === 'VRC7') {
        chipKind = 11;
        ftmChipIdx = 3;
      } else if (ftCh.chip === 'FDS') {
        chipKind = 8;
        ftmChipIdx = 4;
      } else if (ftCh.chip === 'N163') {
        chipKind = 8;
        ftmChipIdx = 5;
      } else if (ftCh.chip === 'MMC5') {
        chipKind = ftCh.subChannel < 2 ? 2 : 5;
      } else if (ftCh.chip === 'Sunsoft 5B') {
        chipKind = 1;
      }
      return {
        chipKind,
        tuningHz: 440,
        freqMul,
        ftmChipIdx,
        volume: 1.0,
        pan: 0.0,
        defaultDuty,
      };
    });

    const totalCh = nextSystems.reduce((sum, s) => sum + s.channels, 0);
    const title = mod.title || fileName.replace(/\.[^/.]+$/, '');
    const song = mod.songs[0];
    const conv = convertFamiTrackerToAriaPatterns(mod, 0);
    const effectiveBpm = conv.bpm;

    const seqChCount = Math.min(48, Math.max(5, mod.channels.length || totalCh));
    const rowCap = Math.max(1, Math.min(256, song?.rowsPerPattern || conv.patterns.length || 64));
    const frameList = song?.frameList && song.frameList.length > 0 ? song.frameList : [Array.from({ length: seqChCount }, () => 0)];

    // Build gridOrders directly from parsed FTM cells so Pxx/Qxy/Rxy/Wxx/Yxx/Zxx/Hxy/Ixy/=xx never get mangled
    const gridOrders = frameList.map((orderPats) => {
      const patRows: Array<Array<{ midi: number; off: boolean; inst: number; vol: number; fx: Array<{ id: number; val: number }> }>> =
        Array.from({ length: rowCap }, () =>
          Array.from({ length: seqChCount }, () => ({ midi: -1, off: false, inst: -1, vol: -1, fx: [] }))
        );
      for (let ch = 0; ch < seqChCount; ch++) {
        const patId = orderPats[ch] ?? 0;
        const cells = song?.patterns[`${ch}:${patId}`] || [];
        for (const cell of cells) {
          if (cell.row < 0 || cell.row >= rowCap) continue;
          const off = cell.note === 97 || cell.note === 98;
          const midi = !off && cell.note >= 1 && cell.note <= 96 ? cell.note + 11 : -1;
          const vol = cell.volume >= 0 ? Math.min(100, Math.round((cell.volume / 15) * 100)) : -1;
          const fx: Array<{ id: number; val: number }> = [];
          for (const eff of cell.effects) {
            const id = ftmEffectToNumericId(eff.code);
            if (id >= 0) {
              fx.push({ id, val: eff.param & 0xff });
            }
          }
          patRows[cell.row][ch] = {
            midi,
            off,
            inst: cell.instrument >= 0 ? cell.instrument : -1,
            vol,
            fx,
          };
        }
      }
      return patRows;
    });

    this.pendingTempoScale = 1.0;
    this.pendingGridSong = {
      orders: gridOrders,
      channelCount: seqChCount,
      speed: Math.max(1, Math.min(31, song?.speed || 6)),
      tempo: Math.max(32, Math.min(255, song?.tempo || 150)),
      machine: mod.machine,
      engineSpeedHz: mod.engineSpeedHz || 0,
      vibratoStyle: mod.vibratoStyle ?? 1,
      detuneTable: mod.detuneTable,
      rowsPerPattern: rowCap,
    };

    this.state = {
      ...this.state,
      loadedSongName: title,
      systems: nextSystems,
      activeInstIndex: first2A03Inst?.index ?? 0,
      wavetables: nextWavetables,
      activeWavetableIndex: nextWavetables.length > 2 ? 2 : 0,
      samples: decodedSamples,
      activeSampleIndex: 0,
      macros: nextMacros,
      totalChannels: totalCh,
      isPlaying: false,
    };

    this.syncFullStateToWasm();
    this.notify();

    return {
      title,
      bpm: effectiveBpm,
      channelsCount: Math.max(5, Math.min(48, mod.channelsCount || totalCh)),
      chipNames: nextSystems.map((s) => s.name),
    };
  }
}

export const FurnaceBridge = new FurnaceBridgeEngine();
