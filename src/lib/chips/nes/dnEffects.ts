/**
 * src/lib/chips/nes/dnEffects.ts
 * Complete FamiTracker, 0CC-FamiTracker, and Dn-FamiTracker (Dn-help)
 * Effect Reference, Expansion Chip Channel Maps & Playback Helpers.
 *
 * Covers:
 * - Standard 2A03 effects (0xy, 1xx, 2xx, 3xx, 4xy, 7xy, Axy, Bxx, Cxx, Dxx, Exx, Fxx, Gxx, Hxy, Ixy, Pxx, Qxy, Rxy, Sxx, Vxx, Wxx, Xxx, Yxx, Zxx)
 * - Dn-FamiTracker exclusive extensions from Dn-Programming-Core-Management/Dn-help:
 *     =xx (Phase Reset on 2A03/VRC6/FDS/N163)
 *     Nxy (Inverse / Target Volume Slide)
 *     Kxx (Frequency Multiplier)
 *     Jxx (Sunsoft 5B Hardware Envelope Shape)
 */

import {
  ExpansionChipName,
  FAMITRACKER_EXPANSION,
  FamiTrackerChannelDescriptor,
} from './types';

export interface DnEffectDoc {
  cmd: string;
  name: string;
  syntax: string;
  category: 'Pitch' | 'Volume' | 'Timing' | 'DPCM' | 'Expansion' | 'Dn-Ext';
  description: string;
  isDnSpecific?: boolean;
}

export const DN_FAMITRACKER_EFFECTS: Record<string, DnEffectDoc> = {
  '0': {
    cmd: '0',
    name: 'Arpeggio',
    syntax: '0xy',
    category: 'Pitch',
    description: 'Cycles rapidly between base note, +x semitones, and +y semitones per tick (000 disables).',
  },
  '1': {
    cmd: '1',
    name: 'Slide Up',
    syntax: '1xx',
    category: 'Pitch',
    description: 'Continuously increases channel frequency (or decreases hardware period) by xx units/tick.',
  },
  '2': {
    cmd: '2',
    name: 'Slide Down',
    syntax: '2xx',
    category: 'Pitch',
    description: 'Continuously decreases channel frequency (or increases hardware period) by xx units/tick.',
  },
  '3': {
    cmd: '3',
    name: 'Automatic Portamento',
    syntax: '3xx',
    category: 'Pitch',
    description: 'Smoothly glides pitch from previous note toward current target note at speed xx.',
  },
  '4': {
    cmd: '4',
    name: 'Vibrato',
    syntax: '4xy',
    category: 'Pitch',
    description: 'Modulates pitch using speed x (0–F) and depth y (0–F). Respects Old/New Dn-FamiTracker vibrato.',
  },
  '7': {
    cmd: '7',
    name: 'Tremolo',
    syntax: '7xy',
    category: 'Volume',
    description: 'Oscillates channel volume at rate x and depth y.',
  },
  'A': {
    cmd: 'A',
    name: 'Volume Slide',
    syntax: 'Axy',
    category: 'Volume',
    description: 'Slides channel volume up by x/16 or down by y/16 units per tick.',
  },
  'B': {
    cmd: 'B',
    name: 'Jump to Order',
    syntax: 'Bxx',
    category: 'Timing',
    description: 'Immediately jumps playback to order frame xx (hex) at the end of the row.',
  },
  'C': {
    cmd: 'C',
    name: 'Halt Song',
    syntax: 'Cxx',
    category: 'Timing',
    description: 'Stops FamiTracker playback immediately at this row.',
  },
  'D': {
    cmd: 'D',
    name: 'Skip to Next Order',
    syntax: 'Dxx',
    category: 'Timing',
    description: 'Skips to row xx of the next order frame.',
  },
  'E': {
    cmd: 'E',
    name: 'Extended Volume / FDS Bias',
    syntax: 'Exx',
    category: 'Volume',
    description: 'Sets direct sub-tick volume or FDS volume modulation level (00–FF).',
  },
  'F': {
    cmd: 'F',
    name: 'Set Speed / Tempo',
    syntax: 'Fxx',
    category: 'Timing',
    description: 'Sets tick speed (01–1F) or BPM tempo (20–FF) depending on split point.',
  },
  'G': {
    cmd: 'G',
    name: 'Note Delay',
    syntax: 'Gxx',
    category: 'Timing',
    description: 'Delays triggering the note on this row by xx ticks.',
  },
  'H': {
    cmd: 'H',
    name: 'Hardware Sweep Up / FDS Mod Depth',
    syntax: 'Hxy',
    category: 'Expansion',
    description: 'Triggers 2A03 hardware sweep up (x=period, y=shift) or sets FDS modulation depth.',
  },
  'I': {
    cmd: 'I',
    name: 'Hardware Sweep Down / FDS Mod Rate',
    syntax: 'Ixy',
    category: 'Expansion',
    description: 'Triggers 2A03 hardware sweep down or sets FDS high modulator frequency byte.',
  },
  'J': {
    cmd: 'J',
    name: 'Sunsoft 5B Envelope / 5B Auto-Period',
    syntax: 'Jxx',
    category: 'Expansion',
    description: 'Sets Sunsoft 5B AY hardware envelope shape ($08–$0E) or auto-envelope ratio.',
    isDnSpecific: true,
  },
  'K': {
    cmd: 'K',
    name: 'Frequency Multiplier (Dn-FT)',
    syntax: 'Kxx',
    category: 'Dn-Ext',
    description: 'Dn-FamiTracker: Multiplies channel pitch frequency factor (1.0x + xx scaling) cleanly across chips.',
    isDnSpecific: true,
  },
  'L': {
    cmd: 'L',
    name: 'Release Delay',
    syntax: 'Lxx',
    category: 'Timing',
    description: '0CC/Dn-FT: Delays triggering macro release point by xx ticks.',
  },
  'M': {
    cmd: 'M',
    name: 'Delayed Channel Echo / Mirror',
    syntax: 'Mxy',
    category: 'Timing',
    description: '0CC/Dn-FT: Queues echo/retrigger on tick x.',
  },
  'N': {
    cmd: 'N',
    name: 'Inverse / Target Volume Slide (Dn-FT)',
    syntax: 'Nxy',
    category: 'Dn-Ext',
    description: 'Dn-FamiTracker: Smoothly slides volume toward target level y (0–F) over x ticks.',
    isDnSpecific: true,
  },
  'O': {
    cmd: 'O',
    name: 'Groove Select',
    syntax: 'Oxx',
    category: 'Timing',
    description: 'Selects uneven tick groove index xx from the song groove table.',
  },
  'P': {
    cmd: 'P',
    name: 'Fine Pitch Detune',
    syntax: 'Pxx',
    category: 'Pitch',
    description: 'Offsets channel pitch around $80 center (P80 = center, <80 flatter/higher, >80 sharper/lower).',
  },
  'Q': {
    cmd: 'Q',
    name: 'Note Slide Up',
    syntax: 'Qxy',
    category: 'Pitch',
    description: 'Slides pitch upward at speed x by y semitones and locks on target semitone.',
  },
  'R': {
    cmd: 'R',
    name: 'Note Slide Down',
    syntax: 'Rxy',
    category: 'Pitch',
    description: 'Slides pitch downward at speed x by y semitones and locks on target semitone.',
  },
  'S': {
    cmd: 'S',
    name: 'Delayed Note Cut',
    syntax: 'Sxx',
    category: 'Timing',
    description: 'Silences channel note after xx ticks (or sets Triangle linear counter length).',
  },
  'T': {
    cmd: 'T',
    name: 'Transpose',
    syntax: 'Txy',
    category: 'Pitch',
    description: '0CC/Dn-FT: Transposes current row pitch by +/- semitones.',
  },
  'V': {
    cmd: 'V',
    name: 'Duty Cycle / Timbre / VRC7 Patch',
    syntax: 'Vxx',
    category: 'Expansion',
    description: 'Selects Pulse duty (0=12.5%, 1=25%, 2=50%, 3=75%), Noise mode (1=short), VRC6 duty (0–7), or VRC7 patch.',
  },
  'W': {
    cmd: 'W',
    name: 'DPCM Pitch / 5B Noise Frequency',
    syntax: 'Wxx',
    category: 'Expansion',
    description: 'Sets Sunsoft 5B noise period (00–1F) or overrides DPCM playback pitch rate (00–0F).',
  },
  'X': {
    cmd: 'X',
    name: 'DPCM Sample Retrigger',
    syntax: 'Xxx',
    category: 'DPCM',
    description: 'Retriggers active DPCM sample every xx frames.',
  },
  'Y': {
    cmd: 'Y',
    name: 'DPCM Sample Offset',
    syntax: 'Yxx',
    category: 'DPCM',
    description: 'Starts DPCM sample playback at byte offset xx * 64.',
  },
  'Z': {
    cmd: 'Z',
    name: 'DPCM Delta / N163 Wave / FDS Mod Bias',
    syntax: 'Zxx',
    category: 'Expansion',
    description: 'Writes 7-bit DPCM delta counter ($00–$7F), selects N163 wave buffer, or sets FDS mod bias.',
  },
  '=': {
    cmd: '=',
    name: 'Phase Reset (Dn-FT)',
    syntax: '=xx',
    category: 'Dn-Ext',
    description: 'Dn-FamiTracker: Resets oscillator phase accumulator (and 2A03 sweep/phase) cleanly.',
    isDnSpecific: true,
  },
};

export function decodeExpansionMask(mask: number): ExpansionChipName[] {
  const list: ExpansionChipName[] = ['2A03'];
  if (mask & FAMITRACKER_EXPANSION.VRC6) list.push('VRC6');
  if (mask & FAMITRACKER_EXPANSION.VRC7) list.push('VRC7');
  if (mask & FAMITRACKER_EXPANSION.FDS) list.push('FDS');
  if (mask & FAMITRACKER_EXPANSION.MMC5) list.push('MMC5');
  if (mask & FAMITRACKER_EXPANSION.N163) list.push('N163');
  if (mask & FAMITRACKER_EXPANSION.SUNSOFT_5B) list.push('Sunsoft 5B');
  return list;
}

export function channelIdToDescriptor(
  chanId: number,
  index: number
): FamiTrackerChannelDescriptor {
  if (chanId === 0) return { index, chip: '2A03', subChannel: 0, name: 'Pulse 1', shortName: 'PU1', fxColumns: 1 };
  if (chanId === 1) return { index, chip: '2A03', subChannel: 1, name: 'Pulse 2', shortName: 'PU2', fxColumns: 1 };
  if (chanId === 2) return { index, chip: '2A03', subChannel: 2, name: 'Triangle', shortName: 'TRI', fxColumns: 1 };
  if (chanId === 3) return { index, chip: '2A03', subChannel: 3, name: 'Noise', shortName: 'NOI', fxColumns: 1 };
  if (chanId === 4) return { index, chip: '2A03', subChannel: 4, name: 'DPCM', shortName: 'DMC', fxColumns: 1 };
  if (chanId >= 5 && chanId <= 7) {
    const sub = chanId - 5;
    return {
      index,
      chip: 'VRC6',
      subChannel: sub,
      name: sub === 2 ? 'VRC6 Sawtooth' : `VRC6 Pulse ${sub + 1}`,
      shortName: sub === 2 ? 'SAW' : `V6${sub + 1}`,
      fxColumns: 1,
    };
  }
  if (chanId >= 8 && chanId <= 10) {
    const sub = chanId - 8;
    return { index, chip: 'MMC5', subChannel: sub, name: `MMC5 Pulse ${sub + 1}`, shortName: `MM${sub + 1}`, fxColumns: 1 };
  }
  if (chanId >= 11 && chanId <= 18) {
    const sub = chanId - 11;
    return { index, chip: 'N163', subChannel: sub, name: `Namco 163 #${sub + 1}`, shortName: `N${sub + 1}`, fxColumns: 1 };
  }
  if (chanId === 19) {
    return { index, chip: 'FDS', subChannel: 0, name: 'FDS Wavetable', shortName: 'FDS', fxColumns: 1 };
  }
  if (chanId >= 20 && chanId <= 25) {
    const sub = chanId - 20;
    return { index, chip: 'VRC7', subChannel: sub, name: `VRC7 FM ${sub + 1}`, shortName: `FM${sub + 1}`, fxColumns: 1 };
  }
  if (chanId >= 26 && chanId <= 28) {
    const sub = chanId - 26;
    return { index, chip: 'Sunsoft 5B', subChannel: sub, name: `Sunsoft 5B #${sub + 1}`, shortName: `5B${sub + 1}`, fxColumns: 1 };
  }
  return { index, chip: '2A03', subChannel: index, name: `CH ${index + 1}`, shortName: `CH${index + 1}`, fxColumns: 1 };
}

export function buildFamiTrackerChannelDescriptors(
  expansionMask: number,
  n163Channels = 1,
  headerChannelIds?: number[]
): FamiTrackerChannelDescriptor[] {
  if (Array.isArray(headerChannelIds) && headerChannelIds.length >= 5) {
    return headerChannelIds.map((id, idx) => channelIdToDescriptor(id, idx));
  }

  const channels: FamiTrackerChannelDescriptor[] = [
    { index: 0, chip: '2A03', subChannel: 0, name: 'Pulse 1', shortName: 'PU1', fxColumns: 1 },
    { index: 1, chip: '2A03', subChannel: 1, name: 'Pulse 2', shortName: 'PU2', fxColumns: 1 },
    { index: 2, chip: '2A03', subChannel: 2, name: 'Triangle', shortName: 'TRI', fxColumns: 1 },
    { index: 3, chip: '2A03', subChannel: 3, name: 'Noise', shortName: 'NOI', fxColumns: 1 },
    { index: 4, chip: '2A03', subChannel: 4, name: 'DPCM', shortName: 'DMC', fxColumns: 1 },
  ];

  const pushCh = (chip: ExpansionChipName, subChannel: number, name: string, shortName: string) => {
    channels.push({
      index: channels.length,
      chip,
      subChannel,
      name,
      shortName,
      fxColumns: 1,
    });
  };

  if (expansionMask & FAMITRACKER_EXPANSION.VRC6) {
    pushCh('VRC6', 0, 'VRC6 Pulse 1', 'V61');
    pushCh('VRC6', 1, 'VRC6 Pulse 2', 'V62');
    pushCh('VRC6', 2, 'VRC6 Sawtooth', 'SAW');
  }
  if (expansionMask & FAMITRACKER_EXPANSION.VRC7) {
    for (let i = 0; i < 6; i++) {
      pushCh('VRC7', i, `VRC7 FM ${i + 1}`, `FM${i + 1}`);
    }
  }
  if (expansionMask & FAMITRACKER_EXPANSION.FDS) {
    pushCh('FDS', 0, 'FDS Wavetable', 'FDS');
  }
  if (expansionMask & FAMITRACKER_EXPANSION.MMC5) {
    pushCh('MMC5', 0, 'MMC5 Pulse 1', 'MM1');
    pushCh('MMC5', 1, 'MMC5 Pulse 2', 'MM2');
  }
  if (expansionMask & FAMITRACKER_EXPANSION.N163) {
    const count = Math.max(1, Math.min(8, n163Channels || 1));
    for (let i = 0; i < count; i++) {
      pushCh('N163', i, `Namco 163 #${i + 1}`, `N${i + 1}`);
    }
  }
  if (expansionMask & FAMITRACKER_EXPANSION.SUNSOFT_5B) {
    pushCh('Sunsoft 5B', 0, 'Sunsoft 5B #1', '5B1');
    pushCh('Sunsoft 5B', 1, 'Sunsoft 5B #2', '5B2');
    pushCh('Sunsoft 5B', 2, 'Sunsoft 5B #3', '5B3');
  }

  return channels;
}

export function describeDnFamiTrackerEffect(token?: string | null): {
  title: string;
  detail: string;
  isDnSpecific: boolean;
} {
  const cleaned = (token || '').trim().toUpperCase();
  if (!cleaned || cleaned === '...' || cleaned === '....') {
    return { title: 'No Effect', detail: 'Empty FamiTracker effect cell.', isDnSpecific: false };
  }
  const cmd = cleaned[0];
  const doc = DN_FAMITRACKER_EFFECTS[cmd];
  if (!doc) {
    return {
      title: `FX ${cleaned}`,
      detail: 'FamiTracker / Dn-FamiTracker pattern command.',
      isDnSpecific: false,
    };
  }
  return {
    title: `${cleaned} · ${doc.name} (${doc.syntax})`,
    detail: doc.description,
    isDnSpecific: Boolean(doc.isDnSpecific),
  };
}
