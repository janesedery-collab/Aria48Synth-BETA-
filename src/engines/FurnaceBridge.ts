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
    volume: mk('volume', 'Volume', 0, 127, [127, 118, 108, 96, 86, 78, 72, 68], 4, 6),
    arpRel: mk('arpRel', 'Arpeggio (Rel)', -24, 24, [0, 4, 7, 12], 0, -1),
    arpFixed: mk('arpFixed', 'Arpeggio (Fixed MIDI)', 0, 127, [60, 64, 67], -1, -1),
    duty: mk('duty', 'Duty / Noise Mode', 0, 15, [2, 2, 1, 0], -1, -1),
    wave: mk('wave', 'Wavetable Index', 0, 63, [0, 0, 1, 2], 0, -1),
    pitch: mk('pitch', 'Pitch', -128, 127, [0, 0, 2, 0, -2, 0], 1, -1),
    pan: mk('pan', 'Panning (L/R)', -127, 127, [0, -32, 0, 32], 0, -1),
    phaseReset: mk('phaseReset', 'Phase Reset', 0, 1, [1, 0, 0, 0], -1, -1),
    ex1: mk('ex1', 'Ex1 (Filter / Feedback)', 0, 255, [64, 96, 128, 96], 0, -1),
    ex2: mk('ex2', 'Ex2 (Modulation)', 0, 255, [0, 32, 64, 32], 0, -1),
    ex3: mk('ex3', 'Ex3 (Aux Chip)', 0, 255, [0, 0, 0, 0], -1, -1),
    op1_tl: mk('op1_tl', 'OP1 Total Level', 0, 127, [24, 28, 32, 36], -1, -1),
    op1_ar: mk('op1_ar', 'OP1 Attack Rate', 0, 31, [31, 31, 31, 31], -1, -1),
    op1_dr: mk('op1_dr', 'OP1 Decay Rate', 0, 31, [10, 12, 12, 14], -1, -1),
    op1_mult: mk('op1_mult', 'OP1 Multiplier', 0, 15, [1, 1, 2, 1], 0, -1),
    op2_tl: mk('op2_tl', 'OP2 Total Level', 0, 127, [20, 22, 24, 26], -1, -1),
    op3_tl: mk('op3_tl', 'OP3 Total Level', 0, 127, [30, 34, 38, 42], -1, -1),
    op4_tl: mk('op4_tl', 'OP4 Total Level', 0, 127, [10, 12, 14, 16], -1, -1),
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
        createDefaultOp(24, 1, 3, 6),
        createDefaultOp(18, 2, 2, 7),
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
      this.workletHandle?.clear();
      this.workletHandle?.setActive(false);
    } else if (this.isWasmReady()) {
      this.workletHandle?.setActive(true);
    }
    this.notify();
  }

  /**
   * Connects the AriaFurnaceNode AudioWorkletNode into the MasterAudioRouter 'FURNACE' input bus.
   */
  public async attachToMasterRouter(ctx: AudioContext, destinationBus: AudioNode): Promise<void> {
    this.hostCtx = ctx;
    this.outputBus = destinationBus;
    if (!this.workletHandle) {
      this.workletHandle = await createAriaFurnaceNode(ctx, (missing) => {
        this.pumpWasmAudio(missing);
      });
    }
    if (this.workletHandle.node) {
      try {
        this.workletHandle.node.disconnect();
      } catch {}
      this.workletHandle.node.connect(destinationBus);
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

      const modImport = await import(/* @vite-ignore */ jsUrl);
      const factory =
        modImport?.default ||
        modImport?.createAriaFurnaceModule ||
        (typeof window !== 'undefined' ? (window as any).createAriaFurnaceModule : null);

      if (typeof factory !== 'function') {
        throw new Error('Loaded bundle does not export an Emscripten factory (createAriaFurnaceModule)');
      }

      const moduleInstance = await factory({
        locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
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
      this.workletHandle?.setActive(true);
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
      this.wasmEngine.clearSystems();
      this.state.systems.forEach((slot, idx) => {
        this.wasmEngine.addSystem(slot.sysId, slot.availableCores.indexOf(slot.core), slot.clockHz, slot.tuningHz);
        this.wasmEngine.setChipMix(idx, slot.volume, slot.pan, slot.mute, slot.solo);
      });
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
      this.state.samples.forEach((s) => this.pushSampleToWasm(s));
      (Object.values(this.state.macros) as FurnaceMacroLane[]).forEach((m) => this.pushMacroToWasm(m));
      this.pushSIDToWasm();
      this.pushPSGToWasm();
    } catch {}
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
    try {
      const len = Math.max(1, macro.values.length);
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
      this.pumpWasmAudio(512);
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
      const samples = new Int16Array(u8.length * 8);
      let level = 0;
      for (let b = 0; b < u8.length; b++) {
        const byte = u8[b];
        for (let bit = 0; bit < 8; bit++) {
          level += (byte & (1 << bit)) !== 0 ? 2 : -2;
          level = Math.max(-64, Math.min(63, level));
          samples[b * 8 + bit] = level * 450;
        }
      }
      pcm16 = samples;
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

    if (raw.length >= 64 && String.fromCharCode(...raw.slice(0, 15)) === '-Furnace module') {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const infoPtr = view.getUint32(20, true);
      if (infoPtr > 0 && infoPtr + 48 < raw.length) {
        const hz = view.getFloat32(infoPtr + 12, true);
        if (hz >= 30 && hz <= 300) {
          bpm = Math.round(hz * 2);
        }
        const sysCount = Math.min(32, Math.max(1, raw[infoPtr + 20] || 1));
        channelsCount = 0;
        for (let i = 0; i < sysCount; i++) {
          const sysId = raw[infoPtr + 24 + i];
          const match = FURNACE_CHIP_CATALOG.find((c) => c.id === sysId);
          if (match) {
            chipNames.push(match.name);
            channelsCount += match.channels;
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

    if (this.wasmEngine && this.wasmModule?.HEAPU8) {
      const ptr = this.wasmEngine.allocate(raw.length);
      this.wasmModule.HEAPU8.set(raw, ptr);
      this.wasmEngine.loadSong(ptr, raw.length);
      this.wasmEngine.deallocate(ptr);
    }

    this.state = {
      ...this.state,
      loadedSongName: title,
      isPlaying: this.isWasmReady(),
    };
    this.notify();

    return {
      title,
      bpm,
      channelsCount: Math.max(4, Math.min(48, channelsCount)),
      chipNames,
    };
  }
}

export const FurnaceBridge = new FurnaceBridgeEngine();
