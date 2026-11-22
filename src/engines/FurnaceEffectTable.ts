/**
 * FurnaceEffectTable.ts
 * Complete Furnace Tracker pattern effect command table, parser, validator,
 * and real-time status bar description formatter for FX1-FX4 columns.
 */

export interface FurnaceEffectSpec {
  code: string;         // Two-hex-digit effect prefix, e.g. '00', '04', 'EC'
  syntax: string;       // Display syntax, e.g. '00xy', 'ECxx'
  name: string;         // Short effect name
  category: 'pitch' | 'volume' | 'timing' | 'chip' | 'global' | 'fm';
  description: string;  // Detailed explanation
  formatParam?: (x: number, y: number, xx: number) => string;
}

export const FURNACE_EFFECT_SPECS: FurnaceEffectSpec[] = [
  {
    code: '00',
    syntax: '00xy',
    name: 'Arpeggio',
    category: 'pitch',
    description: 'Rapidly cycles pitch across base note, +x semitones, and +y semitones every tick.',
    formatParam: (x, y) => `Base / +${x} / +${y} st`,
  },
  {
    code: '01',
    syntax: '01xx',
    name: 'Pitch Slide Up',
    category: 'pitch',
    description: 'Continuously slides channel pitch upward by xx units per tick.',
    formatParam: (_x, _y, xx) => `Up speed ${xx}`,
  },
  {
    code: '02',
    syntax: '02xx',
    name: 'Pitch Slide Down',
    category: 'pitch',
    description: 'Continuously slides channel pitch downward by xx units per tick.',
    formatParam: (_x, _y, xx) => `Down speed ${xx}`,
  },
  {
    code: '03',
    syntax: '03xx',
    name: 'Tone Portamento',
    category: 'pitch',
    description: 'Glides pitch smoothly toward the row note at speed xx (00 = continue previous slide).',
    formatParam: (_x, _y, xx) => (xx === 0 ? 'Continue glide' : `Glide speed ${xx}`),
  },
  {
    code: '04',
    syntax: '04xy',
    name: 'Vibrato',
    category: 'pitch',
    description: 'Modulates pitch with speed x and depth y (00 stops vibrato).',
    formatParam: (x, y) => (x === 0 && y === 0 ? 'Vibrato Off' : `Speed ${x}, Depth ${y}`),
  },
  {
    code: '07',
    syntax: '07xy',
    name: 'Tremolo',
    category: 'volume',
    description: 'Modulates channel volume with speed x and depth y (00 stops tremolo).',
    formatParam: (x, y) => (x === 0 && y === 0 ? 'Tremolo Off' : `Speed ${x}, Depth ${y}`),
  },
  {
    code: '08',
    syntax: '08xx',
    name: 'Set Panning',
    category: 'volume',
    description: 'Sets stereo balance (00 = Full Left, 80 = Center, FF = Full Right).',
    formatParam: (_x, _y, xx) => (xx === 0x80 ? 'Center (50/50)' : xx < 0x80 ? `Left (${Math.round(((0x80 - xx) / 0x80) * 100)}%)` : `Right (${Math.round(((xx - 0x80) / 0x7f) * 100)}%)`),
  },
  {
    code: '09',
    syntax: '09xx',
    name: 'Set Speed 1',
    category: 'timing',
    description: 'Sets groove Speed 1 (ticks per odd row) or timing divider xx.',
    formatParam: (_x, _y, xx) => `${xx} ticks/row`,
  },
  {
    code: '0F',
    syntax: '0Fxx',
    name: 'Set Speed 2 / Tempo',
    category: 'timing',
    description: 'Sets groove Speed 2 (ticks per even row) or overall speed xx.',
    formatParam: (_x, _y, xx) => `${xx} ticks/row`,
  },
  {
    code: '0A',
    syntax: '0Axy',
    name: 'Volume Slide',
    category: 'volume',
    description: 'Slides channel volume up by x or down by y each tick.',
    formatParam: (x, y) => (x > 0 ? `Fade Up +${x}` : y > 0 ? `Fade Down -${y}` : 'Slide Off'),
  },
  {
    code: '0B',
    syntax: '0Bxx',
    name: 'Jump to Order',
    category: 'global',
    description: 'Immediately jumps song playback to order table index xx.',
    formatParam: (_x, _y, xx) => `Order $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: '0D',
    syntax: '0Dxx',
    name: 'Pattern Break',
    category: 'global',
    description: 'Advances to the next order starting at row xx.',
    formatParam: (_x, _y, xx) => `Next order @ row $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: '10',
    syntax: '10xx',
    name: 'Waveform / LFO Setup',
    category: 'chip',
    description: 'Selects wavetable/waveform index or sets FM LFO speed/enable depending on chip.',
    formatParam: (_x, _y, xx) => `Wave/Mode $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: '11',
    syntax: '11xx',
    name: 'FM Feedback / Duty',
    category: 'fm',
    description: 'Sets FM carrier feedback level (0-7) or PSG pulse duty step.',
    formatParam: (_x, _y, xx) => `FB/Duty ${xx & 0x0f}`,
  },
  {
    code: '12',
    syntax: '12xx',
    name: 'Op1 Total Level / Duty',
    category: 'fm',
    description: 'Sets FM Operator 1 attenuation (TL 00-7F) or high-precision duty cycle.',
    formatParam: (_x, _y, xx) => `Level $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: '13',
    syntax: '13xx',
    name: 'Op2 Total Level',
    category: 'fm',
    description: 'Sets FM Operator 2 attenuation (TL 00-7F).',
    formatParam: (_x, _y, xx) => `Op2 TL $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: '14',
    syntax: '14xx',
    name: 'Op3 Total Level',
    category: 'fm',
    description: 'Sets FM Operator 3 attenuation (TL 00-7F).',
    formatParam: (_x, _y, xx) => `Op3 TL $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: '15',
    syntax: '15xx',
    name: 'Op4 Total Level',
    category: 'fm',
    description: 'Sets FM Operator 4 attenuation (TL 00-7F).',
    formatParam: (_x, _y, xx) => `Op4 TL $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: '17',
    syntax: '17xx',
    name: 'DAC / PCM Mode',
    category: 'chip',
    description: 'Toggles YM2612 DAC channel enable (00 = FM Ch6, 01 = 8-bit PCM DAC) or sample trigger mode.',
    formatParam: (_x, _y, xx) => (xx > 0 ? 'DAC Enabled' : 'DAC Disabled'),
  },
  {
    code: '18',
    syntax: '18xx',
    name: 'ExtCh3 / Filter Mode',
    category: 'chip',
    description: 'Toggles YM2612 Extended Channel 3 per-operator mode or chip hardware filter/mode.',
    formatParam: (_x, _y, xx) => (xx > 0 ? 'Extended Mode ON' : 'Normal Mode'),
  },
  {
    code: '19',
    syntax: '19xx',
    name: 'ADSR Attack Rate / Sync',
    category: 'fm',
    description: 'Sets FM Attack Rate (AR) override or SID hard sync toggle.',
    formatParam: (_x, _y, xx) => `Param $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: '20',
    syntax: '20xx',
    name: 'SID Filter Cutoff',
    category: 'chip',
    description: 'Sets C64 SID analog low/band/high-pass filter cutoff or resonance offset.',
    formatParam: (_x, _y, xx) => `Cutoff $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: 'E1',
    syntax: 'E1xy',
    name: 'Note Slide Up',
    category: 'pitch',
    description: 'Glides pitch up by y semitones at speed x.',
    formatParam: (x, y) => `+${y} st @ spd ${x}`,
  },
  {
    code: 'E2',
    syntax: 'E2xy',
    name: 'Note Slide Down',
    category: 'pitch',
    description: 'Glides pitch down by y semitones at speed x.',
    formatParam: (x, y) => `-${y} st @ spd ${x}`,
  },
  {
    code: 'EA',
    syntax: 'EAxx',
    name: 'Legato',
    category: 'pitch',
    description: 'Enables/disables legato key-on suppression across rows (01 = On, 00 = Off).',
    formatParam: (_x, _y, xx) => (xx > 0 ? 'Legato ON' : 'Legato OFF'),
  },
  {
    code: 'EC',
    syntax: 'ECxx',
    name: 'Note Cut',
    category: 'timing',
    description: 'Cuts (silences) the note after xx ticks within the current row.',
    formatParam: (_x, _y, xx) => `Cut at tick ${xx}`,
  },
  {
    code: 'ED',
    syntax: 'EDxx',
    name: 'Note Delay',
    category: 'timing',
    description: 'Delays triggering the note and instrument on this row by xx ticks.',
    formatParam: (_x, _y, xx) => `Delay ${xx} ticks`,
  },
  {
    code: 'EE',
    syntax: 'EExx',
    name: 'Send Sync Signal',
    category: 'global',
    description: 'Sends hardware/external sync marker xx.',
    formatParam: (_x, _y, xx) => `Sync $${xx.toString(16).toUpperCase().padStart(2, '0')}`,
  },
  {
    code: 'F0',
    syntax: 'F0xx',
    name: 'Set BPM',
    category: 'timing',
    description: 'Sets virtual engine tempo in beats per minute (xx in hex).',
    formatParam: (_x, _y, xx) => `${xx} BPM`,
  },
];

const SPEC_MAP = new Map<string, FurnaceEffectSpec>(
  FURNACE_EFFECT_SPECS.map((s) => [s.code.toUpperCase(), s])
);

export interface ParsedFurnaceEffect {
  raw: string;
  code: string;
  effectId: number;
  effectVal: number;
  x: number;
  y: number;
  spec: FurnaceEffectSpec | null;
}

/**
 * Normalizes a pattern effect string (e.g. "0448", "ec06", "....") into a strict 4-char token or "....".
 */
export function normalizeEffectToken(raw?: string | null): string {
  if (!raw) return '....';
  const cleaned = raw.trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (cleaned.length === 0) return '....';
  return cleaned.padEnd(4, '0').slice(0, 4);
}

/**
 * Parses a 4-character hex Furnace effect token into numeric ID + argument bytes + spec metadata.
 */
export function parseFurnaceEffectToken(raw?: string | null): ParsedFurnaceEffect | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed || trimmed === '....' || trimmed === '----') {
    return null;
  }
  const hex = trimmed.replace(/[^0-9A-F]/g, '');
  if (hex.length < 2) return null;
  const token = hex.padEnd(4, '0').slice(0, 4);
  const code = token.slice(0, 2);
  const argHex = token.slice(2, 4);
  const effectId = parseInt(code, 16);
  const effectVal = parseInt(argHex, 16);
  if (Number.isNaN(effectId) || Number.isNaN(effectVal)) return null;
  return {
    raw: token,
    code,
    effectId,
    effectVal,
    x: (effectVal >> 4) & 0x0f,
    y: effectVal & 0x0f,
    spec: SPEC_MAP.get(code) || null,
  };
}

/**
 * Returns a human-readable live status bar description for the hovered or selected effect cell.
 */
export function describeFurnaceEffect(raw?: string | null): {
  title: string;
  detail: string;
  category: string;
} {
  const parsed = parseFurnaceEffectToken(raw);
  if (!parsed) {
    return {
      title: 'Empty Effect Slot',
      detail: 'Click to assign a Furnace command (00xy Arp, 01/02 Slide, 03xx Porta, 04xy Vib, 08xx Pan, ECxx Cut, EDxx Delay)',
      category: 'none',
    };
  }
  if (!parsed.spec) {
    return {
      title: `FX ${parsed.raw}`,
      detail: `Chip-specific Furnace effect $${parsed.code} with parameter $${parsed.effectVal.toString(16).toUpperCase().padStart(2, '0')}.`,
      category: 'chip',
    };
  }
  const paramSummary = parsed.spec.formatParam
    ? ` (${parsed.spec.formatParam(parsed.x, parsed.y, parsed.effectVal)})`
    : '';
  return {
    title: `${parsed.raw} · ${parsed.spec.name}${paramSummary}`,
    detail: parsed.spec.description,
    category: parsed.spec.category,
  };
}
