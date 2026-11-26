/**
 * src/lib/chips/nes/types.ts
 * Clean strict TypeScript interfaces for FamiTracker (.ftm), 0CC-FamiTracker (.0cc),
 * and Dn-FamiTracker (.dnm) module parsing (played through Furnace Tracker engine).
 */

export const FAMITRACKER_EXPANSION = {
  NONE: 0x00,
  VRC6: 0x01,
  VRC7: 0x02,
  FDS: 0x04,
  MMC5: 0x08,
  N163: 0x10,
  SUNSOFT_5B: 0x20,
} as const;

export type ExpansionChipName =
  | '2A03'
  | 'VRC6'
  | 'VRC7'
  | 'FDS'
  | 'MMC5'
  | 'N163'
  | 'Sunsoft 5B';

export type NesMachineStandard = 'NTSC' | 'PAL' | 'Dendy';

export interface FamiTrackerEffectEntry {
  code: string;   // Single-char or symbol command ('0'..'Z', '=')
  param: number;  // 0x00..0xFF
  token: string;  // Display token e.g. '037', 'F06', '=00', 'N24'
}

export interface FamiTrackerPatternCell {
  row: number;
  note: number;       // 0 = none, 1..96 (C-0..B-7), 97 = note cut (===), 98 = note release (---/OFF)
  noteName: string;   // 'C-4', '===', 'OFF', '---'
  instrument: number; // -1 = none
  volume: number;     // -1 = none, 0..15
  effects: FamiTrackerEffectEntry[];
}

export interface FamiTrackerSequence {
  index: number;
  type: number;       // 0=Volume, 1=Arpeggio, 2=Pitch, 3=HiPitch, 4=Duty/Noise
  chip: ExpansionChipName;
  loopPoint: number;  // -1 if none
  releasePoint: number; // -1 if none
  setting: number;    // Arp mode (0=abs,1=fixed,2=rel,3=scheme) or N163/FDS flags
  items: number[];
}

export interface FamiTrackerDpcmSample {
  index: number;
  name: string;
  data: Uint8Array;
}

export interface FamiTrackerInstrument {
  index: number;
  name: string;
  chip: ExpansionChipName;
  seqIndices: [number, number, number, number, number]; // Vol, Arp, Pitch, HiPitch, Duty
  dpcmMap?: { pitch: number; loop: boolean; sampleIndex: number; deltaCounter: number }[];
  vrc7Patch?: number;
  vrc7CustomRegs?: Uint8Array;
  fdsWave?: Uint8Array;
  fdsModTable?: Int8Array;
  fdsModSpeed?: number;
  fdsModDepth?: number;
  fdsModDelay?: number;
  n163WaveSize?: number;
  n163WavePos?: number;
  n163Waves?: Uint8Array[];
}

export interface FamiTrackerChannelDescriptor {
  index: number;          // 0-based channel index in module
  chip: ExpansionChipName;
  subChannel: number;
  name: string;           // e.g. 'Pulse 1', 'Pulse 2', 'Triangle', 'Noise', 'DPCM', '5B CH1'
  shortName: string;      // e.g. 'PU1', 'PU2', 'TRI', 'NOI', 'DMC', '5B1'
  fxColumns: number;      // 1..4
}

export interface FamiTrackerSong {
  index: number;
  name: string;
  speed: number;          // Ticks per row (default 6)
  tempo: number;          // BPM (default 150)
  rowsPerPattern: number; // 1..256 (default 64)
  framesCount: number;
  frameList: number[][];  // [orderIndex][channelIndex] = patternId
  // Map key `${channelIndex}:${patternId}` -> rows
  patterns: Record<string, FamiTrackerPatternCell[]>;
}

export interface FamiTrackerModule {
  format: 'ftm' | '0cc' | 'dnm';
  fileName: string;
  version: number;
  title: string;
  author: string;
  copyright: string;
  machine: NesMachineStandard;
  engineSpeedHz: number;  // 0 = default (60 NTSC / 50 PAL)
  vibratoStyle: number;   // 0 = old, 1 = new
  expansionMask: number;
  expansions: ExpansionChipName[];
  n163Channels: number;
  channelsCount: number;
  maxFxColumns?: number;
  channels: FamiTrackerChannelDescriptor[];
  songs: FamiTrackerSong[];
  sequences: FamiTrackerSequence[];
  instruments: FamiTrackerInstrument[];
  dpcmSamples: FamiTrackerDpcmSample[];
  detuneTable?: number[];
  parseNotes: string[];
}

