/**
 * /public/wasm/aria_furnace_all.js
 * ES6 WebAssembly Runtime & Emscripten-compatible AriaFurnaceEngine bindings
 * backing Aria 48 Tracker's Furnace DivEngine & diverted FamiTracker playback.
 *
 * All sample synthesis runs inside compiled WebAssembly linear memory (`aria_furnace_all.wasm`).
 */

const ADDR_SAMPLE_RATE = 0x0000;
const VOICE_BASE = 0x10000;
const VOICE_STRIDE = 256;
const INST_BASE = 0x20000;
const INST_STRIDE = 512;
const SAMPLE_META_BASE = 0x40000;
const SAMPLE_META_STRIDE = 32;
const WAVE_BASE = 0x44000;
const WAVE_STRIDE = 1040;
const MACRO_BASE = 0x100000;
const MACRO_INST_STRIDE = 4160;
const MACRO_LANE_STRIDE = 1040;

const NES_DPCM_RATES_NTSC = [
  4181.71, 4709.93, 5264.04, 5593.04, 6257.95, 7046.35, 7919.35, 8363.42,
  9419.86, 11186.08, 12604.03, 13982.61, 16884.65, 21306.82, 24857.95, 33143.94,
];
const NES_DPCM_RATES_PAL = [
  4177.40, 4696.63, 5261.41, 5579.22, 6023.94, 7044.94, 7917.18, 8397.01,
  9446.63, 11233.83, 12595.51, 14089.89, 16965.38, 21315.47, 25191.02, 33252.14,
];
const NES_NOISE_PERIODS_NTSC = [
  4068, 2034, 1016, 762, 508, 380, 254, 202,
  160, 128, 96, 64, 32, 16, 8, 4,
];
const NES_NOISE_PERIODS_PAL = [
  3792, 1896, 948, 710, 474, 354, 236, 188,
  148, 118, 88, 60, 30, 16, 8, 4,
];

function noiseIndexToHz(noiseIdx, isPal = false) {
  const i = Math.max(0, Math.min(15, noiseIdx | 0));
  const cpuHz = isPal ? 1662607 : 1789773;
  const period = isPal ? NES_NOISE_PERIODS_PAL[i] : NES_NOISE_PERIODS_NTSC[i];
  return cpuHz / period;
}

function getSysChannelCount(sysId) {
  switch (sysId) {
    case 0x83: return 6;  // YM2612
    case 0x03: return 4;  // SN76489
    case 0x06: return 5;  // RP2A03
    case 0x88: return 3;  // VRC6
    case 0x8b: return 8;  // N163
    case 0x8c: return 1;  // FDS
    case 0x85: return 6;  // VRC7
    case 0x89: return 3;  // MMC5
    case 0x04: return 4;  // DMG
    case 0x87: return 8;  // SPC700
    case 0x07:
    case 0x47: return 3;  // SID6581 / SID8580
    case 0x05: return 6;  // HuC6280
    case 0x82: return 8;  // YM2151
    case 0x8d: return 18; // OPL3
    case 0x80: return 3;  // AY8910 / Sunsoft 5B
    case 0x90: return 4;  // POKEY
    case 0x8f: return 5;  // SCC
    default: return 4;
  }
}

function resolveSubChannelChipKind(sysId, subCh) {
  switch (sysId) {
    case 0x83: // YM2612 4-Op FM
    case 0x82: // YM2151 4-Op FM
      return 0;
    case 0x8d: // OPL3 2-Op FM
    case 0x85: // VRC7 2-Op FM
      return 11;
    case 0x06: // RP2A03
      if (subCh === 0 || subCh === 1) return 2; // NES Pulse
      if (subCh === 2) return 3; // NES Triangle
      if (subCh === 3) return 4; // NES LFSR Noise
      return 5; // NES DPCM
    case 0x88: // VRC6
      return subCh < 2 ? 6 : 7; // VRC6 Pulse / VRC6 Saw
    case 0x89: // MMC5
      return subCh < 2 ? 2 : 5;
    case 0x04: // DMG
      if (subCh < 2) return 2;
      if (subCh === 2) return 8;
      return 4;
    case 0x03: // SN76489
      return subCh === 3 ? 4 : 1;
    case 0x80: // AY-3-8910 / Sunsoft 5B
    case 0x90: // POKEY
      return 1;
    case 0x8c: // FDS
    case 0x8b: // N163
    case 0x05: // HuC6280
    case 0x8f: // SCC
      return 8; // Wavetable
    case 0x87: // SPC700
      return 5; // PCM/BRR Sample
    case 0x07: // SID 6581
    case 0x47: // SID 8580
      return 10;
    default:
      return 1;
  }
}

function midiToHz(midi, tuningHz = 440) {
  return tuningHz * Math.pow(2, (midi - 69) / 12);
}

/**
 * Lightweight Furnace `.fur` binary parser for direct WASM sequencer playback.
 */
function parseFurSongPatterns(bytes) {
  if (!bytes || bytes.length < 64) return null;
  const sig = String.fromCharCode(...bytes.slice(0, 15));
  if (sig !== '-Furnace module') return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const infoPtr = view.getUint32(20, true);
  if (!infoPtr || infoPtr + 48 >= bytes.length) return null;

  // Furnace INFO block layout:
  // +0..3: "INFO", +4..7: size, +8: timeBase, +9: speed1, +10: speed2,
  // +11: initArpTime, +12..15: hz (f32), +16..17: patLen (u16), +18..19: ordersLen (u16),
  // +32..63: system[32]
  const timeBase = Math.max(0, Math.min(8, bytes[infoPtr + 8] || 0));
  const speed1 = Math.max(1, bytes[infoPtr + 9] || 6);
  const speed2 = Math.max(1, bytes[infoPtr + 10] || speed1);
  let hz = view.getFloat32(infoPtr + 12, true);
  if (!Number.isFinite(hz) || hz < 10 || hz > 400) {
    hz = 60;
  }
  const ticksPerSec = hz / (timeBase + 1);
  const patLen = Math.max(1, Math.min(256, view.getUint16(infoPtr + 16, true) || 64));
  const ordersLen = Math.max(1, Math.min(256, view.getUint16(infoPtr + 18, true) || 1));

  // Scan for PATN / PATR pattern blocks cleanly
  const patterns = new Map(); // key: `${ch}:${patId}` -> array of rows
  const decoder = new TextDecoder();

  let totalChannels = 0;
  for (let i = 0; i < 32 && infoPtr + 32 + i < bytes.length; i++) {
    const sysId = bytes[infoPtr + 32 + i];
    if (!sysId) break;
    totalChannels += getSysChannelCount(sysId);
  }
  totalChannels = Math.max(1, Math.min(48, totalChannels || 8));

  for (let off = 0; off + 16 < bytes.length; off++) {
    if (
      bytes[off] === 0x50 &&
      bytes[off + 1] === 0x41 &&
      bytes[off + 2] === 0x54 &&
      (bytes[off + 3] === 0x4e || bytes[off + 3] === 0x52)
    ) {
      const tag = decoder.decode(bytes.subarray(off, off + 4));
      const size = view.getUint32(off + 4, true);
      if (size > 8 && off + 8 + size <= bytes.length) {
        const end = off + 8 + size;
        if (tag === 'PATN') {
          const ch = bytes[off + 9];
          const patId = view.getUint16(off + 10, true);
          let p = off + 12;
          while (p < end && bytes[p] !== 0) p++;
          p++; // skip null terminator of pattern name
          const rows = [];
          let row = 0;
          while (p < end && row < patLen) {
            const flag = bytes[p++];
            if (flag === 0xff) break;
            if ((flag & 0x80) !== 0) {
              row += 2 + (flag & 0x7f);
              continue;
            }
            let note = -1;
            let oct = 0;
            let ins = -1;
            let vol = -1;
            if (flag & 0x01) {
              const rawNote = bytes[p++];
              if (rawNote >= 180) {
                note = 100; // note off / release
              } else if (rawNote > 0) {
                const midi = rawNote - 48; // 60=C-0 -> MIDI 12
                note = ((midi % 12) + 12) % 12;
                oct = Math.floor(midi / 12) - 1;
              }
            }
            if (flag & 0x02) ins = bytes[p++];
            if (flag & 0x04) vol = bytes[p++];
            const fx = [];
            if (flag & 0x08) {
              const id = bytes[p++];
              const val = bytes[p++];
              fx.push({ id, val });
            }
            if (flag & 0x10) {
              const id = bytes[p++];
              const val = bytes[p++];
              fx.push({ id, val });
            }
            if (flag & 0x20) {
              // Extra effects mask
              const effMask = bytes[p++];
              for (let eb = 0; eb < 8; eb++) {
                if (effMask & (1 << eb)) {
                  const id = bytes[p++];
                  const val = bytes[p++];
                  fx.push({ id, val });
                }
              }
            }
            rows[row] = { note, oct, ins, vol, fx };
            row++;
          }
          patterns.set(`${ch}:${patId}`, rows);
        } else if (tag === 'PATR') {
          const ch = bytes[off + 8];
          const patId = view.getUint16(off + 9, true);
          const rows = [];
          let p = off + 12;
          while (p + 10 <= end && rows.length < patLen) {
            const row = view.getInt16(p, true);
            p += 2;
            if (row < 0 || row >= patLen) break;
            let note = view.getInt16(p, true);
            let oct = view.getInt16(p + 2, true);
            const ins = view.getInt16(p + 4, true);
            const vol = view.getInt16(p + 6, true);
            p += 8;
            if (note === 0 && oct === 0 && ins < 0 && vol < 0) continue;
            if (note === 12) note = 0; // legacy PATR C
            else if (note === 0) note = -1;
            rows[row] = { note, oct, ins, vol, fx: [] };
          }
          patterns.set(`${ch}:${patId}`, rows);
        }
        off += 7 + size;
      }
    }
  }

  return {
    speed1,
    speed2,
    ticksPerSec,
    patLen,
    ordersLen,
    totalChannels,
    patterns,
  };
}

async function loadWasmBytes(url) {
  if (typeof process !== 'undefined' && process.versions?.node && !url.startsWith('http') && !url.startsWith('blob:')) {
    const fsMod = await import('node:fs/promises');
    const urlMod = await import('node:url');
    const filePath = url.startsWith('file://') ? urlMod.fileURLToPath(url) : url;
    return await fsMod.readFile(filePath);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch Furnace WASM (${res.status}): ${url}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function createAriaFurnaceModule(moduleArg = {}) {
  const defaultWasmUrl = import.meta.url.startsWith('blob:')
    ? '/wasm/aria_furnace_all.wasm'
    : new URL('./aria_furnace_all.wasm', import.meta.url).href;
  const wasmUrl =
    typeof moduleArg.locateFile === 'function'
      ? moduleArg.locateFile('aria_furnace_all.wasm', '')
      : defaultWasmUrl;

  const wasmBytes = await loadWasmBytes(wasmUrl);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const exports = instance.exports;
  const memory = exports.memory;

  let cachedBuffer = memory.buffer;
  let u8 = new Uint8Array(cachedBuffer);
  let i16 = new Int16Array(cachedBuffer);
  let i32 = new Int32Array(cachedBuffer);
  let f32 = new Float32Array(cachedBuffer);

  function syncViews() {
    if (memory.buffer !== cachedBuffer) {
      cachedBuffer = memory.buffer;
      u8 = new Uint8Array(cachedBuffer);
      i16 = new Int16Array(cachedBuffer);
      i32 = new Int32Array(cachedBuffer);
      f32 = new Float32Array(cachedBuffer);
    }
  }

  const runtimeModule = {
    HEAPU8: u8,
    HEAP16: i16,
    HEAP32: i32,
    HEAPF32: f32,
    _exports: exports,
    AriaFurnaceEngine: null,
  };

  Object.defineProperties(runtimeModule, {
    HEAPU8: { enumerable: true, get: () => { syncViews(); return u8; } },
    HEAP16: { enumerable: true, get: () => { syncViews(); return i16; } },
    HEAP32: { enumerable: true, get: () => { syncViews(); return i32; } },
    HEAPF32: { enumerable: true, get: () => { syncViews(); return f32; } },
  });

  class AriaFurnaceEngine {
    constructor() {
      this.sampleRate = 44100;
      this.systems = [];
      this.channelMap = [];
      this.customChannelMap = null;
      this.sampleMeta = new Map();
      this.dpcmMaps = new Map(); // instIdx -> Map<midiNote, { sampleId, rateIdx, loop }>
      this.instMeta = new Map(); // instIdx -> { waveId, sidPulseWidth, arpMode, ... }
      this.ftmMacros = new Map(); // instIdx -> { arp, pitch, hiPitch }
      this.playing = false;
      this.furSong = null;
      this.furRow = 0;
      this.furOrder = 0;
      this.furSubTick = 0;
      this.furSampleAccum = 0;
      this.furRowParity = 0;
      this.furNeedsInitialStep = false;
      this.furAdvancePending = false;

      // Sample-accurate Grid Sequencer state (for diverted FTM / 0CC / DNM)
      this.gridSong = null;
      this.gridOrder = 0;
      this.gridRow = 0;
      this.gridSubTick = 0;
      this.gridSampleAccum = 0;
      this.gridTempoScale = 1.0;
      this.gridElapsedSec = 0;
      this.gridNeedsInitialStep = false;
      this.gridPendingJump = -1;
      this.gridPendingBreak = -1;
      this.gridPendingHalt = false;
      this.gridLastInst = new Int32Array(48).fill(0);
      this.gridLastVol = new Float32Array(48).fill(100);
      this.gridDelayedNote = new Array(48).fill(null);
      this.gridCutTicks = new Int32Array(48).fill(-1);
      this.gridArpVal = new Uint8Array(48);
      this.gridSlideDelta = new Int16Array(48);
      this.gridVibParam = new Uint8Array(48);
      this.gridVibPhase = new Float32Array(48);
      this.gridVolSlide = new Uint8Array(48);
      this.gridBaseFreq = new Float32Array(48);
      this.gridBaseMidi = new Int32Array(48).fill(-1);
      this.gridPeriodDelta = new Float32Array(48);
      this.gridFinePitch = new Float32Array(48);
      this.gridPortaSpeed = new Float32Array(48);
      this.gridTargetFreq = new Float32Array(48);
      this.gridTargetMidi = new Int32Array(48).fill(-1);
      this.gridNoteSlideTargetFreq = new Float32Array(48);
      this.gridNoteSlideTargetMidi = new Int32Array(48).fill(-1);
      this.gridNoteSlideSpeed = new Float32Array(48);
      this.gridDpcmRate = new Int32Array(48).fill(-1);
      this.gridPitchMacroAcc = new Float32Array(48);
      this.gridPitchMacroTick = new Int32Array(48);
      this.gridHiPitchMacroAcc = new Float32Array(48);
      this.gridHiPitchMacroTick = new Int32Array(48);
      this.gridTonalArpTick = new Int32Array(48);
      this.gridNoiseArpTick = new Int32Array(48);
      this.gridHarmonicMul = new Float32Array(48).fill(1.0);
      this.gridTransposeSemis = new Int32Array(48);
      this.gridPendingTranspose = new Array(48).fill(null);
      this.gridSweepParam = new Uint8Array(48);
      this.gridSweepTick = new Int32Array(48);
      this.gridSweepDelta = new Float32Array(48);
      this.gridChannelDuty = new Int8Array(48).fill(-1);
      this.furPendingJump = -1;
      this.furPendingBreak = -1;
    }

    init(sr = 44100, _bufFrames = 1024) {
      this.sampleRate = Math.max(8000, sr || 44100);
      exports.init(this.sampleRate);
      this.reset();
    }

    setSampleRate(sr) {
      const nextSr = Math.max(8000, Number(sr) || 44100);
      if (Math.abs(nextSr - this.sampleRate) < 1) return;
      this.sampleRate = nextSr;
      syncViews();
      f32[ADDR_SAMPLE_RATE >> 2] = nextSr;
    }

    clearAllMacros() {
      syncViews();
      this.ftmMacros.clear();
      this.instMeta.clear();
      for (let inst = 0; inst < 256; inst++) {
        for (let lane = 0; lane < 4; lane++) {
          const mBase = MACRO_BASE + inst * MACRO_INST_STRIDE + lane * MACRO_LANE_STRIDE;
          const mI32 = mBase >> 2;
          i32[mI32] = 0;
          i32[mI32 + 1] = 1;
          i32[mI32 + 2] = -1;
          i32[mI32 + 3] = -1;
          i32[mI32 + 4] = 0;
        }
      }
    }

    clearSamples() {
      syncViews();
      this.sampleMeta.clear();
      this.dpcmMaps.clear();
      for (let id = 0; id < 256; id++) {
        const mI32 = (SAMPLE_META_BASE + id * SAMPLE_META_STRIDE) >> 2;
        i32[mI32] = 0;
        i32[mI32 + 1] = 0;
        f32[mI32 + 2] = 0;
        i32[mI32 + 3] = 0;
        i32[mI32 + 4] = 0;
      }
    }

    setInstWaveId(instIdx, waveId) {
      const idx = instIdx & 255;
      const prev = this.instMeta.get(idx) || {};
      this.instMeta.set(idx, { ...prev, waveId: waveId & 255 });
    }

    setFtmMacros(instIdx, macroSpec) {
      const idx = instIdx & 255;
      if (!macroSpec) return;
      this.ftmMacros.set(idx, macroSpec);
    }

    reset() {
      this.stop();
      // Default Genesis 4-Op FM patch on Inst 0..3 so playback is immediately rich
      for (let inst = 0; inst < 16; inst++) {
        this.setFMGlobal(inst, 4, 5, 0, 0, false);
        this.setFMOperator(inst, 0, 24, 31, 10, 4, 3, 6, 2, 3, 0, 0, 0, 0, 0, 0);
        this.setFMOperator(inst, 1, 16, 31, 9, 3, 2, 7, 1, 3, 0, 0, 0, 0, 0, 0);
        this.setFMOperator(inst, 2, 26, 31, 10, 4, 3, 5, 1, 3, 0, 0, 0, 0, 0, 0);
        this.setFMOperator(inst, 3, 6, 31, 8, 2, 1, 7, 1, 3, 0, 0, 0, 0, 0, 0);
        this.setSIDParams(inst, 1024, 6, 1, 6, 2048, false, false);
      }
      // Default Sine wavetable in slot 0
      const ptr = this.allocate(32 * 4);
      syncViews();
      const base = ptr >> 2;
      for (let i = 0; i < 32; i++) {
        i32[base + i] = Math.round(((Math.sin((i / 32) * Math.PI * 2) + 1) * 0.5) * 31);
      }
      this.uploadWavetable(0, 32, 31, ptr);
      this.deallocate(ptr);
    }

    allocate(bytes) {
      const ptr = exports.allocate(bytes | 0);
      syncViews();
      return ptr;
    }

    deallocate(ptr) {
      exports.deallocate(ptr | 0);
    }

    clearSystems() {
      this.systems = [];
      this.rebuildChannelMap();
    }

    addSystem(sysId, coreIdx = 0, clockHz = 1789773, tuningHz = 440) {
      const chCount = getSysChannelCount(sysId);
      this.systems.push({
        sysId,
        coreIdx,
        clockHz,
        tuningHz: tuningHz || 440,
        channels: chCount,
        volume: 1.0,
        pan: 0.0,
        mute: false,
        solo: false,
      });
      this.rebuildChannelMap();
    }

    removeSystem(slotIdx) {
      if (slotIdx >= 0 && slotIdx < this.systems.length) {
        this.systems.splice(slotIdx, 1);
        this.rebuildChannelMap();
      }
    }

    setCore(slotIdx, coreName) {
      if (this.systems[slotIdx]) {
        this.systems[slotIdx].coreName = coreName;
      }
    }

    setClock(slotIdx, clockHz) {
      if (this.systems[slotIdx]) {
        this.systems[slotIdx].clockHz = clockHz;
      }
    }

    setTuning(slotIdx, tuningHz) {
      if (this.systems[slotIdx]) {
        this.systems[slotIdx].tuningHz = tuningHz || 440;
        this.rebuildChannelMap();
      }
    }

    setChipMix(slotIdx, volume, pan, mute, solo) {
      const sys = this.systems[slotIdx];
      if (!sys) return;
      sys.volume = Number.isFinite(volume) ? volume : 1.0;
      sys.pan = Number.isFinite(pan) ? pan : 0.0;
      sys.mute = Boolean(mute);
      sys.solo = Boolean(solo);
      this.rebuildChannelMap();
    }

    setCustomChannelMap(channels) {
      if (!Array.isArray(channels) || channels.length === 0) {
        this.customChannelMap = null;
        this.rebuildChannelMap();
        return;
      }
      this.customChannelMap = channels.slice(0, 48).map((c) => ({
        chipKind: c.chipKind | 0,
        tuningHz: c.tuningHz || 440,
        freqMul: Number.isFinite(c.freqMul) ? c.freqMul : 1.0,
        ftmChipIdx: typeof c.ftmChipIdx === 'number' ? c.ftmChipIdx : 0,
        volume: Number.isFinite(c.volume) ? c.volume : 1.0,
        pan: Number.isFinite(c.pan) ? c.pan : 0.0,
        defaultDuty: c.defaultDuty ?? (c.chipKind === 4 ? 0 : 2),
      }));
      this.rebuildChannelMap();
    }

    rebuildChannelMap() {
      if (this.customChannelMap && this.customChannelMap.length > 0) {
        this.channelMap = this.customChannelMap.slice();
        return;
      }
      this.channelMap = [];
      const anySolo = this.systems.some((s) => s.solo);
      for (let sIdx = 0; sIdx < this.systems.length; sIdx++) {
        const sys = this.systems[sIdx];
        const muted = sys.mute || (anySolo && !sys.solo);
        for (let sub = 0; sub < sys.channels; sub++) {
          if (this.channelMap.length >= 48) break;
          const chipKind = resolveSubChannelChipKind(sys.sysId, sub);
          this.channelMap.push({
            chipKind,
            tuningHz: sys.tuningHz || 440,
            freqMul: 1.0,
            ftmChipIdx: 0,
            volume: muted ? 0 : sys.volume,
            pan: sys.pan,
            defaultDuty: chipKind === 4 ? 0 : sub === 0 ? 1 : 2,
          });
        }
      }
    }

    getTotalChannelCount() {
      return this.channelMap.length;
    }

    setFMGlobal(instIdx, alg, fb, _fms, _ams, is2Op) {
      syncViews();
      const idx = instIdx & 255;
      const baseByte = INST_BASE + idx * INST_STRIDE;
      const baseI32 = baseByte >> 2;
      const baseF32 = baseByte >> 2;
      i32[baseI32] = alg & 7;
      f32[baseF32 + 1] = ((1 << (fb & 7)) / 128) * 0.45;
      i32[baseI32 + 2] = is2Op ? 1 : 0;
    }

    setFMOperator(instIdx, opIdx, tl, ar, dr, _d2r, sl, rr, mult, _dt, _dt2, _rs, _am, _ssgEnv, _ksr, _ksl) {
      syncViews();
      const idx = instIdx & 255;
      const op = Math.max(0, Math.min(3, opIdx | 0));
      const baseByte = INST_BASE + idx * INST_STRIDE + 16 + op * 24;
      const baseF32 = baseByte >> 2;
      const normTl = Math.max(0, Math.min(127, tl | 0));
      const gain = Math.pow(10, -normTl * 0.012) * 0.85;
      const m = (mult & 0x0f) === 0 ? 0.5 : (mult & 0x0f);
      const decayRate = Math.max(0, Math.min(31, dr | 0));
      const sustainKeep = Math.max(0.15, (15 - (sl & 15)) / 15);
      const decayMul = decayRate > 0 ? Math.max(0.9994, 1.0 - (decayRate / 31) * (1 - sustainKeep) * 0.00018) : 0.99999;
      f32[baseF32] = gain;
      f32[baseF32 + 1] = m;
      f32[baseF32 + 2] = decayMul;
      // Touch ar/rr so parameters retain full compatibility
      f32[baseF32 + 3] = Math.max(0.001, (ar & 31) / 31);
      f32[baseF32 + 4] = Math.max(0.99, 1.0 - (15 - (rr & 15)) * 0.0002);
    }

    uploadWavetable(waveId, width, height, dataPtr) {
      syncViews();
      const id = waveId & 255;
      const len = Math.max(1, Math.min(256, width | 0));
      const maxH = Math.max(1, height | 0);
      const wBase = WAVE_BASE + id * WAVE_STRIDE;
      const wI32 = wBase >> 2;
      const wF32 = wBase >> 2;
      i32[wI32] = len;
      f32[wF32 + 1] = maxH;
      const srcBase = dataPtr >> 2;
      for (let i = 0; i < len; i++) {
        const rawVal = i32[srcBase + i] ?? 0;
        const norm = (rawVal / maxH) * 2.0 - 1.0;
        f32[wF32 + 2 + i] = Math.max(-1.0, Math.min(1.0, norm));
      }
    }

    uploadSample(sampleId, rate, _bitDepth, loopStart, loopEnd, pcm16Ptr, length) {
      syncViews();
      const id = sampleId & 255;
      const count = Math.max(0, length | 0);
      if (count <= 0) return;

      // Copy into persistent WASM linear memory buffer because caller frees pcm16Ptr
      const copyPtr = this.allocate(count * 2);
      syncViews();
      u8.copyWithin(copyPtr, pcm16Ptr, pcm16Ptr + count * 2);

      const mBase = SAMPLE_META_BASE + id * SAMPLE_META_STRIDE;
      const mI32 = mBase >> 2;
      const mF32 = mBase >> 2;
      i32[mI32] = copyPtr;
      i32[mI32 + 1] = count;
      f32[mF32 + 2] = rate || 16000;
      i32[mI32 + 3] = loopStart | 0;
      i32[mI32 + 4] = loopEnd | 0;
      this.sampleMeta.set(id, {
        ptr: copyPtr,
        len: count,
        rate: rate || 16000,
        loopEnable: (loopStart | 0) >= 0,
      });
    }

    setDpcmMap(instIdx, midiNote, sampleId, rateIdx = 15, loop = false) {
      const idx = instIdx & 255;
      let map = this.dpcmMaps.get(idx);
      if (!map) {
        map = new Map();
        this.dpcmMaps.set(idx, map);
      }
      map.set(midiNote | 0, {
        sampleId: sampleId & 255,
        rateIdx: Math.max(0, Math.min(15, rateIdx | 0)),
        loop: Boolean(loop),
      });
    }

    setMacro(instIdx, _opIdx, code, speed, loop, release, mode, valsPtr, length) {
      syncViews();
      // Map code: 0->lane0 (Vol), 1->lane1 (Arp), 2->lane2 (Duty), 4->lane3 (Pitch)
      let lane = -1;
      if (code === 0) lane = 0;
      else if (code === 1) lane = 1;
      else if (code === 2) lane = 2;
      else if (code === 4) lane = 3;
      if (lane < 0) return;

      const idx = instIdx & 255;
      const len = Math.max(0, Math.min(255, length | 0));
      const mBase = MACRO_BASE + idx * MACRO_INST_STRIDE + lane * MACRO_LANE_STRIDE;
      const mI32 = mBase >> 2;
      i32[mI32] = len;
      i32[mI32 + 1] = Math.max(1, speed | 0);
      i32[mI32 + 2] = loop | 0;
      i32[mI32 + 3] = release | 0;
      i32[mI32 + 4] = mode | 0;
      const srcBase = valsPtr >> 2;
      for (let i = 0; i < len; i++) {
        i32[mI32 + 5 + i] = i32[srcBase + i] ?? 0;
      }
    }

    setSIDParams(instIdx, cutoff, resonance, filterMask, waveMask, pulseWidth, _ringMod, _hardSync) {
      syncViews();
      const idx = instIdx & 255;
      const baseByte = INST_BASE + idx * INST_STRIDE;
      const baseI32 = baseByte >> 2;
      const baseF32 = baseByte >> 2;
      const normCut = Math.max(0.04, Math.min(0.85, ((cutoff || 1024) / 2047) * 0.8 + 0.04));
      const normRes = Math.max(0.2, Math.min(1.85, 1.8 - ((resonance || 0) / 15) * 1.55));
      f32[baseF32 + 28] = normCut; // +112
      f32[baseF32 + 29] = normRes; // +116
      i32[baseI32 + 30] = filterMask || 1; // +120
      i32[baseI32 + 31] = waveMask || 6;   // +124
      f32[baseF32 + 32] = Math.max(0.05, Math.min(0.95, (pulseWidth || 2048) / 4095)); // +128
    }

    setPSGParams(_instIdx, dutyCycle, _lfsrCode, _noiseFreq) {
      this.defaultPsgDuty = dutyCycle | 0;
    }

    uploadInstrumentFUI(instIdx, ptr, len) {
      syncViews();
      if (len < 16) return;
      const hdr = String.fromCharCode(u8[ptr], u8[ptr + 1], u8[ptr + 2], u8[ptr + 3]);
      if (hdr !== 'FINS') return;
      let off = ptr + 8;
      const end = ptr + len;
      while (off + 6 <= end) {
        const tag = String.fromCharCode(u8[off], u8[off + 1]);
        const size = u8[off + 4] | (u8[off + 5] << 8);
        if (tag === 'FM' && off + 10 < end) {
          const d = off + 6;
          const flags = u8[d];
          const alg = (u8[d + 1] >> 4) & 7;
          const fb = u8[d + 1] & 7;
          const is2Op = (flags & 0x0f) <= 2;
          this.setFMGlobal(instIdx, alg, fb, 0, 0, is2Op);
          const opCnt = Math.min(4, Math.max(2, flags & 0x0f));
          for (let op = 0; op < opCnt && d + 4 + op * 8 + 7 < end; op++) {
            const o = d + 4 + op * 8;
            this.setFMOperator(
              instIdx, op,
              u8[o + 4] & 0x7f, // tl
              u8[o] & 0x1f,     // ar
              u8[o + 1] & 0x1f, // dr
              u8[o + 3] & 0x1f, // d2r
              (u8[o + 5] >> 4) & 0x0f, // sl
              u8[o + 5] & 0x0f, // rr
              u8[o + 2] & 0x0f, // mult
              (u8[o + 2] >> 4) & 0x07, // dt
              (u8[o + 7] >> 5) & 0x03, // dt2
              (u8[o + 6] >> 6) & 0x03, // rs
              (u8[o] & 0x80) ? 1 : 0,  // am
              u8[o + 6] & 0x0f,        // ssgEnv
              0,
              (u8[o + 3] >> 6) & 0x03  // ksl
            );
          }
          break;
        }
        if (size <= 0) break;
        off += 6 + size;
      }
    }

    loadSong(ptr, byteLength) {
      syncViews();
      exports.stop_all();
      const rawCopy = u8.slice(ptr, ptr + byteLength);
      this.furSong = parseFurSongPatterns(rawCopy);
      this.gridSong = null;
      this.furRow = 0;
      this.furOrder = 0;
      this.furSubTick = 0;
      this.furSampleAccum = 0;
      this.furRowParity = 0;
      this.furNeedsInitialStep = true;
      this.furAdvancePending = false;
      this.furPendingJump = -1;
      this.furPendingBreak = -1;
      this.gridCutTicks.fill(-1);
      this.gridArpVal.fill(0);
      this.gridSlideDelta.fill(0);
      this.gridVibParam.fill(0);
      this.gridVibPhase.fill(0);
      this.gridBaseFreq.fill(0);
      this.gridBaseMidi.fill(-1);
      this.gridPeriodDelta.fill(0);
      this.gridFinePitch.fill(0);
      this.gridPortaSpeed.fill(0);
      this.gridTargetFreq.fill(0);
      return this.furSong ? 1 : 0;
    }

    loadGridSong(cfg) {
      exports.stop_all();
      if (!cfg || !Array.isArray(cfg.orders) || cfg.orders.length === 0) {
        this.gridSong = null;
        return;
      }
      this.furSong = null;
      const machine = cfg.machine || 'NTSC';
      const baseTickHz = cfg.engineSpeedHz > 0
        ? Math.max(15, Math.min(240, cfg.engineSpeedHz))
        : (machine === 'PAL' || machine === 'Dendy')
          ? 50
          : 60;
      const speed = Math.max(1, Math.min(31, cfg.speed || 6));
      const tempo = Math.max(32, Math.min(255, cfg.tempo || 150));
      let totalRows = 0;
      for (let i = 0; i < cfg.orders.length; i++) {
        totalRows += cfg.orders[i].length;
      }
      this.gridSong = {
        orders: cfg.orders,
        channelCount: Math.max(1, Math.min(48, cfg.channelCount || 5)),
        speed,
        baseSpeed: speed,
        tempo,
        baseTempo: tempo,
        machine,
        vibratoStyle: cfg.vibratoStyle ?? 1,
        detuneTable: Array.isArray(cfg.detuneTable) ? cfg.detuneTable : null,
        baseTickHz,
        rowsPerPattern: cfg.rowsPerPattern || 64,
        totalRows: Math.max(1, totalRows),
      };
      this.resetGridPlaybackState();
    }

    resetGridPlaybackState() {
      this.gridOrder = 0;
      this.gridRow = 0;
      this.gridSubTick = 0;
      this.gridSampleAccum = 0;
      this.gridElapsedSec = 0;
      this.gridNeedsInitialStep = true;
      this.gridPendingJump = -1;
      this.gridPendingBreak = -1;
      this.gridPendingHalt = false;
      this.gridLastInst.fill(0);
      this.gridLastVol.fill(100);
      this.gridDelayedNote.fill(null);
      this.gridCutTicks.fill(-1);
      this.gridArpVal.fill(0);
      this.gridSlideDelta.fill(0);
      this.gridVibParam.fill(0);
      this.gridVibPhase.fill(0);
      this.gridVolSlide.fill(0);
      this.gridBaseFreq.fill(0);
      this.gridBaseMidi.fill(-1);
      this.gridPeriodDelta.fill(0);
      this.gridFinePitch.fill(0);
      this.gridPortaSpeed.fill(0);
      this.gridTargetFreq.fill(0);
      this.gridTargetMidi.fill(-1);
      this.gridNoteSlideTargetFreq.fill(0);
      this.gridNoteSlideTargetMidi.fill(-1);
      this.gridNoteSlideSpeed.fill(0);
      this.gridDpcmRate.fill(-1);
      this.gridPitchMacroAcc.fill(0);
      this.gridPitchMacroTick.fill(0);
      this.gridHiPitchMacroAcc.fill(0);
      this.gridHiPitchMacroTick.fill(0);
      this.gridTonalArpTick.fill(0);
      this.gridNoiseArpTick.fill(0);
      this.gridHarmonicMul.fill(1.0);
      this.gridTransposeSemis.fill(0);
      this.gridPendingTranspose.fill(null);
      this.gridSweepParam.fill(0);
      this.gridSweepTick.fill(0);
      this.gridSweepDelta.fill(0);
      this.gridChannelDuty.fill(-1);
      if (this.gridSong) {
        this.gridSong.speed = this.gridSong.baseSpeed;
        this.gridSong.tempo = this.gridSong.baseTempo;
      }
    }

    setTempoScale(scale) {
      const s = Number(scale);
      if (Number.isFinite(s) && s > 0.1 && s < 4.0) {
        this.gridTempoScale = s;
      }
    }

    seekToRatio(ratio) {
      const r = Math.max(0, Math.min(0.999, Number(ratio) || 0));
      if (this.gridSong) {
        exports.stop_all();
        this.gridSubTick = 0;
        this.gridSampleAccum = 0;
        this.gridNeedsInitialStep = true;
        this.gridPendingJump = -1;
        this.gridPendingBreak = -1;
        this.gridPendingHalt = false;
        this.gridDelayedNote.fill(null);
        this.gridCutTicks.fill(-1);
        this.gridArpVal.fill(0);
        this.gridSlideDelta.fill(0);
        this.gridVibParam.fill(0);
        this.gridVolSlide.fill(0);
        this.gridPeriodDelta.fill(0);
        this.gridFinePitch.fill(0);
        this.gridPortaSpeed.fill(0);
        this.gridTargetFreq.fill(0);
        this.gridTargetMidi.fill(-1);
        this.gridNoteSlideTargetFreq.fill(0);
        this.gridNoteSlideTargetMidi.fill(-1);
        this.gridNoteSlideSpeed.fill(0);
        this.gridDpcmRate.fill(-1);
        this.gridPitchMacroAcc.fill(0);
        this.gridPitchMacroTick.fill(0);
        this.gridHiPitchMacroAcc.fill(0);
        this.gridHiPitchMacroTick.fill(0);
        this.gridTonalArpTick.fill(0);
        this.gridNoiseArpTick.fill(0);
        this.gridHarmonicMul.fill(1.0);
        this.gridTransposeSemis.fill(0);
        this.gridPendingTranspose.fill(null);
        this.gridSweepParam.fill(0);
        this.gridSweepTick.fill(0);
        this.gridSweepDelta.fill(0);
        this.gridChannelDuty.fill(-1);
        let targetRow = Math.floor(r * this.gridSong.totalRows);
        let ord = 0;
        while (ord < this.gridSong.orders.length - 1 && targetRow >= this.gridSong.orders[ord].length) {
          targetRow -= this.gridSong.orders[ord].length;
          ord++;
        }
        this.gridOrder = ord;
        this.gridRow = Math.max(0, Math.min(this.gridSong.orders[ord].length - 1, targetRow));
        const tickHz = (this.gridSong.baseTickHz * (this.gridSong.tempo / 150)) * this.gridTempoScale;
        this.gridElapsedSec = (r * this.gridSong.totalRows * this.gridSong.speed) / Math.max(10, tickHz);
      } else if (this.furSong) {
        exports.stop_all();
        const total = Math.max(1, this.furSong.ordersLen * this.furSong.patLen);
        const gRow = Math.floor(r * total);
        this.furOrder = Math.floor(gRow / this.furSong.patLen);
        this.furRow = gRow % this.furSong.patLen;
        this.furSubTick = 0;
        this.furSampleAccum = 0;
        this.furNeedsInitialStep = true;
        this.furAdvancePending = false;
        this.furPendingJump = -1;
        this.furPendingBreak = -1;
        this.gridCutTicks.fill(-1);
        this.gridArpVal.fill(0);
        this.gridSlideDelta.fill(0);
        this.gridVibParam.fill(0);
        this.gridPeriodDelta.fill(0);
        this.gridFinePitch.fill(0);
        this.gridPortaSpeed.fill(0);
        this.gridTargetFreq.fill(0);
      }
    }

    getPlaybackProgress() {
      if (this.gridSong) {
        let doneRows = 0;
        for (let i = 0; i < this.gridOrder; i++) {
          doneRows += this.gridSong.orders[i].length;
        }
        doneRows += this.gridRow;
        const total = Math.max(1, this.gridSong.totalRows);
        const tickHz = (this.gridSong.baseTickHz * (this.gridSong.tempo / 150)) * this.gridTempoScale;
        const totalSec = (total * this.gridSong.speed) / Math.max(10, tickHz);
        return {
          orderIdx: this.gridOrder,
          rowIdx: this.gridRow,
          elapsedSeconds: this.gridElapsedSec,
          totalSeconds: totalSec,
          ratio: Math.max(0, Math.min(1, doneRows / total)),
          isPlaying: this.playing,
        };
      }
      if (this.furSong) {
        const total = Math.max(1, this.furSong.ordersLen * this.furSong.patLen);
        const done = this.furOrder * this.furSong.patLen + this.furRow;
        const avgSpeed = Math.max(1, (this.furSong.speed1 + this.furSong.speed2) * 0.5);
        const tickHz = Math.max(10, this.furSong.ticksPerSec * this.gridTempoScale);
        const totalSec = (total * avgSpeed) / tickHz;
        return {
          orderIdx: this.furOrder,
          rowIdx: this.furRow,
          elapsedSeconds: (done * avgSpeed) / tickHz,
          totalSeconds: totalSec,
          ratio: Math.max(0, Math.min(1, done / total)),
          isPlaying: this.playing,
        };
      }
      return { orderIdx: 0, rowIdx: 0, elapsedSeconds: 0, totalSeconds: 0, ratio: 0, isPlaying: this.playing };
    }

    play() {
      this.playing = true;
      if (this.furSong) {
        this.furSubTick = 0;
        this.furSampleAccum = 0;
        this.furNeedsInitialStep = true;
        this.furAdvancePending = false;
      }
      if (this.gridSong) {
        this.gridSubTick = 0;
        this.gridSampleAccum = 0;
        this.gridNeedsInitialStep = true;
      }
    }

    stop() {
      this.playing = false;
      exports.stop_all();
    }

    noteOn(channel, midiNote, velocity = 100, instIndex = 0, options = {}) {
      syncViews();
      const ch = Math.max(0, Math.min(47, channel | 0));
      const spec =
        this.channelMap.length > 0
          ? this.channelMap[ch % this.channelMap.length]
          : { chipKind: 0, tuningHz: 440, freqMul: 1.0, volume: 1.0, pan: 0.0, defaultDuty: 2 };

      const chipKind = spec.chipKind;
      const instIdx = instIndex & 255;
      const note = Math.max(0, Math.min(127, midiNote | 0));
      const vel = chipKind === 5 ? 1.0 : Math.max(0, Math.min(1, (velocity || 100) / 127));
      const isPal = this.gridSong?.machine === 'PAL';
      const freqMul = spec.freqMul ?? 1.0;

      let freq = midiToHz(note, spec.tuningHz) * freqMul;
      if (chipKind === 4) {
        const noiseStep = note >= 12 ? (note - 12) & 0x0f : note & 0x0f;
        freq = noiseIndexToHz(noiseStep, isPal);
      }

      const vBase = VOICE_BASE + ch * VOICE_STRIDE;
      const vI32 = vBase >> 2;
      const vF32 = vBase >> 2;

      const initDuty =
        chipKind === 4
          ? (typeof options?.dutyOverride === 'number' && options.dutyOverride >= 0
              ? (options.dutyOverride & 1)
              : ((spec.defaultDuty ?? 0) & 1))
          : (typeof options?.dutyOverride === 'number' && options.dutyOverride >= 0
              ? options.dutyOverride
              : (this.defaultPsgDuty ?? spec.defaultDuty ?? 2));

      i32[vI32] = 1; // active
      i32[vI32 + 1] = chipKind;
      i32[vI32 + 2] = instIdx;
      i32[vI32 + 3] = note;
      f32[vF32 + 4] = freq; // baseFreq
      f32[vF32 + 5] = freq; // curFreq
      f32[vF32 + 6] = vel;
      f32[vF32 + 7] = spec.volume;
      f32[vF32 + 8] = spec.pan;
      i32[vI32 + 9] = initDuty;
      f32[vF32 + 10] = 0.0; // phase
      f32[vF32 + 11] = 1.0; // env
      f32[vF32 + 12] = 0.0;
      f32[vF32 + 13] = 0.0;
      f32[vF32 + 14] = 0.0;
      f32[vF32 + 15] = 0.0;
      f32[vF32 + 16] = 1.0; // opEnv0
      f32[vF32 + 17] = 1.0; // opEnv1
      f32[vF32 + 18] = 1.0; // opEnv2
      f32[vF32 + 19] = 1.0; // opEnv3
      i32[vI32 + 20] = 0x7fff; // balanced NES 15-bit LFSR seed (48:45 93-step short orbit)
      f32[vF32 + 21] = 0.0; // noiseOut
      i32[vI32 + 22] = 0; // macroStep
      i32[vI32 + 23] = 0;
      i32[vI32 + 24] = 0; // arpOffset
      f32[vF32 + 25] = 0.0; // pitchOffset
      f32[vF32 + 26] = 1.0; // macroVol
      i32[vI32 + 27] = this.instMeta.get(instIdx)?.waveId ?? 0; // waveId
      f32[vF32 + 37] = 1.0; // macroPitchMul (+148)
      i32[vI32 + 38] = (0x6d2b79f5 ^ ((ch + 1) * 0x9e3779b9)) | 1; // lfsr32 (+152)
      f32[vF32 + 39] = 0.0; // noiseLp (+156)
      f32[vF32 + 40] = freqMul * ((spec.tuningHz || 440) / 440.0); // freqMul (+160)
      i32[vI32 + 41] = options?.skipWasmArp ? 1 : 0; // skipWasmArp (+164)
      f32[vF32 + 42] = 1.0; // noiseBitVal (+168)

      // Apply step 0 of any active macros immediately on non-DPCM channels
      if (chipKind !== 5) {
        const mInstBase = (MACRO_BASE + instIdx * MACRO_INST_STRIDE) >> 2;
        const laneStrideI32 = MACRO_LANE_STRIDE >> 2;
        if (i32[mInstBase] > 0) {
          const v0 = i32[mInstBase + 5];
          f32[vF32 + 26] = Math.max(0, Math.min(1, v0 / 127));
        }
        const arpBase = mInstBase + laneStrideI32;
        if (!options?.skipWasmArp && i32[arpBase] > 0) {
          const arpVal = i32[arpBase + 5];
          const arpMode = i32[arpBase + 4];
          if (chipKind === 4) {
            const baseNoise = note >= 12 ? (note - 12) & 0x0f : note & 0x0f;
            const nextNoise = arpMode === 1 ? (arpVal & 0x0f) : Math.max(0, Math.min(15, baseNoise + arpVal));
            f32[vF32 + 5] = noiseIndexToHz(nextNoise, isPal);
          } else {
            f32[vF32 + 5] = arpMode === 1
              ? (spec.tuningHz || 440) * Math.pow(2, (arpVal - 69) / 12) * freqMul
              : freq * Math.pow(2, arpVal / 12);
          }
        }
        const dutyBase = mInstBase + laneStrideI32 * 2;
        if (i32[dutyBase] > 0) {
          i32[vI32 + 9] = i32[dutyBase + 5];
        }
        const pitchBase = mInstBase + laneStrideI32 * 3;
        if (!options?.skipWasmArp && i32[pitchBase] > 0 && i32[pitchBase + 4] !== 2) {
          f32[vF32 + 37] = Math.pow(2, Math.max(-256, Math.min(255, i32[pitchBase + 5])) / 192);
        }
      }

      // Sample / DPCM binding
      if (chipKind === 5) {
        let mapped = this.dpcmMaps.get(instIdx)?.get(note);
        if (!mapped && this.dpcmMaps.size > 0) {
          for (const candidateMap of this.dpcmMaps.values()) {
            const hit = candidateMap.get(note);
            if (hit) {
              mapped = hit;
              break;
            }
          }
        }
        let smpId = mapped ? mapped.sampleId : (instIdx % Math.max(1, this.sampleMeta.size));
        if (!this.sampleMeta.has(smpId) && this.sampleMeta.size > 0) {
          smpId = this.sampleMeta.keys().next().value;
        }
        const meta = this.sampleMeta.get(smpId);
        if (meta) {
          const rateTable = isPal ? NES_DPCM_RATES_PAL : NES_DPCM_RATES_NTSC;
          const rateOverride = typeof options?.dpcmRateIdx === 'number' && options.dpcmRateIdx >= 0
            ? rateTable[options.dpcmRateIdx & 0x0f]
            : null;
          const playRate = rateOverride ?? (mapped ? rateTable[mapped.rateIdx & 0x0f] : (meta.rate || rateTable[15]));
          const startSamples = typeof options?.dpcmByteOffset === 'number' && options.dpcmByteOffset > 0
            ? Math.min(Math.max(0, meta.len - 1), options.dpcmByteOffset * 8)
            : 0.0;
          i32[vI32 + 28] = smpId;
          f32[vF32 + 29] = startSamples; // samplePos
          f32[vF32 + 30] = Math.max(0.05, playRate / this.sampleRate); // sampleInc
          i32[vI32 + 31] = mapped?.loop || meta.loopEnable ? 1 : 0;
        } else {
          // Fallback to NES Triangle only when module literally contains zero DPCM samples
          i32[vI32 + 1] = 3;
          f32[vF32 + 4] = freq * 0.5;
          f32[vF32 + 5] = freq * 0.5;
        }
      }

      f32[vF32 + 32] = 0.0; // svfLow
      f32[vF32 + 33] = 0.0; // svfBand
      f32[vF32 + 34] = 0.0; // op0Out
      i32[vI32 + 36] = 0;   // released = 0
    }

    noteOff(channel) {
      const ch = Math.max(0, Math.min(47, channel | 0));
      exports.note_off(ch);
    }

    setEffect(channel, effectId, effectVal) {
      syncViews();
      const ch = Math.max(0, Math.min(47, channel | 0));
      const vBase = VOICE_BASE + ch * VOICE_STRIDE;
      const vI32 = vBase >> 2;
      const vF32 = vBase >> 2;
      if (effectId === 0x08) {
        // Panning (00..FF -> -1..+1)
        f32[vF32 + 8] = ((effectVal & 0xff) / 127.5) - 1.0;
      } else if (effectId === 0x12) {
        // Duty cycle
        i32[vI32 + 9] = effectVal & 0x0f;
      } else if (effectId === 0x10) {
        // Wave select
        i32[vI32 + 27] = effectVal & 0xff;
      } else if (effectId === 0x01) {
        if ((effectVal & 0xff) === 0) {
          f32[vF32 + 25] = 0.0;
        } else {
          const curHz = Math.max(20, f32[vF32 + 5] || 220);
          f32[vF32 + 25] = Math.min(curHz * 1.0, f32[vF32 + 25] + curHz * ((effectVal & 0xff) * 0.0008));
        }
      } else if (effectId === 0x02) {
        if ((effectVal & 0xff) === 0) {
          f32[vF32 + 25] = 0.0;
        } else {
          const curHz = Math.max(20, f32[vF32 + 5] || 220);
          f32[vF32 + 25] = Math.max(-curHz * 0.75, f32[vF32 + 25] - curHz * ((effectVal & 0xff) * 0.0008));
        }
      } else if (effectId === 0xec) {
        this.noteOff(ch);
      }
    }

    stepFurSongRow() {
      if (!this.playing || !this.furSong) return;
      const song = this.furSong;
      if (this.furAdvancePending) {
        if (this.furPendingJump >= 0) {
          this.furOrder = this.furPendingJump % song.ordersLen;
          this.furRow = 0;
          this.furPendingJump = -1;
          this.furPendingBreak = -1;
        } else if (this.furPendingBreak >= 0) {
          this.furOrder = (this.furOrder + 1) % song.ordersLen;
          this.furRow = Math.min(song.patLen - 1, this.furPendingBreak);
          this.furPendingBreak = -1;
        } else {
          this.furRow++;
          this.furRowParity ^= 1;
          if (this.furRow >= song.patLen) {
            this.furRow = 0;
            this.furOrder = (this.furOrder + 1) % song.ordersLen;
          }
        }
      }
      this.furAdvancePending = true;
      const maxCh = Math.min(48, song.totalChannels);
      for (let ch = 0; ch < maxCh; ch++) {
        const pat = song.patterns.get(`${ch}:${this.furOrder}`) || song.patterns.get(`${ch}:0`);
        if (!pat) continue;
        const cell = pat[this.furRow];
        if (!cell) continue;
        let hasPorta = false;
        let hasArp = false;
        let hasSlide = false;
        if (Array.isArray(cell.fx)) {
          for (let fi = 0; fi < cell.fx.length; fi++) {
            const { id, val } = cell.fx[fi];
            if (id === 0x0f) {
              if (val > 0) song.speed1 = val;
            } else if (id === 0x09) {
              if (val > 0) song.speed2 = val;
            } else if (id === 0x0b) {
              this.furPendingJump = val;
            } else if (id === 0x0d) {
              this.furPendingBreak = val;
            } else if (id === 0x00) {
              hasArp = true;
              this.gridArpVal[ch] = val;
            } else if (id === 0x01) {
              hasSlide = true;
              this.gridSlideDelta[ch] = val;
            } else if (id === 0x02) {
              hasSlide = true;
              this.gridSlideDelta[ch] = -val;
            } else if (id === 0x03) {
              hasPorta = true;
              if (val > 0) this.gridPortaSpeed[ch] = val;
              else if (cell.note < 0) this.gridPortaSpeed[ch] = 0;
            } else if (id === 0x04) {
              this.gridVibParam[ch] = val;
            } else if (id === 0xe5) {
              // Furnace E5xx: Set Pitch ($80 = center)
              this.gridFinePitch[ch] = -(val - 0x80);
            } else if (id === 0xec) {
              this.gridCutTicks[ch] = val & 0x1f;
            } else if (id === 0x08 || id === 0x10 || id === 0x12) {
              this.setEffect(ch, id, val);
            }
          }
        }
        if (!hasArp) this.gridArpVal[ch] = 0;
        if (cell.note === 100 || cell.note === 101 || cell.note === 102) {
          this.gridSlideDelta[ch] = 0;
          this.gridVibParam[ch] = 0;
          this.gridTargetFreq[ch] = 0;
          this.noteOff(ch);
        } else if (cell.note >= 0 && cell.note < 12) {
          const midi = Math.max(12, Math.min(119, (cell.oct + 1) * 12 + cell.note));
          const vel = cell.vol >= 0 ? Math.min(127, Math.round((cell.vol / 127) * 127)) : 110;
          const ins = cell.ins >= 0 ? cell.ins : this.gridLastInst[ch];
          if (cell.ins >= 0) this.gridLastInst[ch] = cell.ins;
          const spec = this.channelMap[ch % Math.max(1, this.channelMap.length)] || { chipKind: 0, tuningHz: 440, freqMul: 1.0 };
          const noteFreq = spec.chipKind === 4
            ? noiseIndexToHz(midi >= 12 ? (midi - 12) & 0x0f : midi & 0x0f, false)
            : midiToHz(midi, spec.tuningHz) * (spec.freqMul ?? 1.0);
          const vI32 = (VOICE_BASE + ch * VOICE_STRIDE) >> 2;
          if (hasPorta && this.gridPortaSpeed[ch] > 0 && i32[vI32] === 1 && spec.chipKind !== 4 && spec.chipKind !== 5) {
            this.gridTargetFreq[ch] = noteFreq;
            this.gridBaseMidi[ch] = midi;
          } else {
            if (!hasSlide) this.gridSlideDelta[ch] = 0;
            this.gridPeriodDelta[ch] = 0;
            this.gridTargetFreq[ch] = 0;
            this.noteOn(ch, midi, vel, ins);
            this.gridBaseFreq[ch] = noteFreq;
            this.gridBaseMidi[ch] = midi;
          }
        }
      }
    }

    stepFurTick() {
      if (!this.playing || !this.furSong) return;
      syncViews();
      const maxCh = Math.min(48, this.furSong.totalChannels);
      for (let ch = 0; ch < maxCh; ch++) {
        if (this.gridCutTicks[ch] === 0) {
          this.noteOff(ch);
          this.gridCutTicks[ch] = -1;
        } else if (this.gridCutTicks[ch] > 0) {
          this.gridCutTicks[ch]--;
        }
        const vBase = VOICE_BASE + ch * VOICE_STRIDE;
        const vI32 = vBase >> 2;
        const vF32 = vBase >> 2;
        if (i32[vI32] !== 1) continue;
        const chipKind = i32[vI32 + 1];
        if (chipKind === 4 || chipKind === 5) continue;

        const baseFreq = this.gridBaseFreq[ch] || f32[vF32 + 4] || 220;
        const arp = this.gridArpVal[ch];
        if (arp > 0) {
          const step = this.furSubTick % 3;
          const semi = step === 1 ? (arp >> 4) & 0x0f : step === 2 ? arp & 0x0f : 0;
          f32[vF32 + 5] = baseFreq * Math.pow(2, semi / 12);
        } else if (f32[vF32 + 4] > 0 && Math.abs(f32[vF32 + 5] - baseFreq) > 0.01 && !i32[vI32 + 41]) {
          // Preserve WASM arp macro if running; otherwise anchor curFreq cleanly
          const instIdx = i32[vI32 + 2] & 255;
          const mArpLen = i32[(MACRO_BASE + instIdx * MACRO_INST_STRIDE + MACRO_LANE_STRIDE) >> 2];
          if (mArpLen <= 0) f32[vF32 + 5] = baseFreq;
        }

        const baseP = Math.max(1, 1789773 / (16 * Math.max(20, baseFreq)) - 1);
        if (this.gridTargetFreq[ch] > 0 && this.gridPortaSpeed[ch] > 0) {
          const curP = baseP + this.gridPeriodDelta[ch];
          const tgtP = Math.max(1, 1789773 / (16 * Math.max(20, this.gridTargetFreq[ch])) - 1);
          const spd = this.gridPortaSpeed[ch];
          if (Math.abs(tgtP - curP) <= spd) {
            this.gridBaseFreq[ch] = this.gridTargetFreq[ch];
            f32[vF32 + 4] = this.gridTargetFreq[ch];
            f32[vF32 + 5] = this.gridTargetFreq[ch];
            this.gridPeriodDelta[ch] = 0;
            this.gridTargetFreq[ch] = 0;
          } else {
            this.gridPeriodDelta[ch] = (curP + (tgtP > curP ? spd : -spd)) - baseP;
          }
        }
        if (this.gridSlideDelta[ch] !== 0 && this.furSubTick > 0) {
          this.gridPeriodDelta[ch] = Math.max(-baseP + 4, Math.min(4096, this.gridPeriodDelta[ch] - this.gridSlideDelta[ch]));
        }
        const totalDelta = this.gridPeriodDelta[ch] + this.gridFinePitch[ch];
        const effP = Math.max(4, Math.min(16383, baseP + totalDelta));
        let ratio = (baseP + 1) / (effP + 1);
        const vib = this.gridVibParam[ch];
        if (vib > 0) {
          const vSpd = (vib >> 4) & 0x0f;
          const vDep = vib & 0x0f;
          this.gridVibPhase[ch] += (vSpd * Math.PI * 2) / 64;
          ratio *= Math.pow(2, Math.sin(this.gridVibPhase[ch]) * (vDep / 15) * 0.042);
        }
        if (Math.abs(totalDelta) > 0.001 || vib > 0) {
          f32[vF32 + 37] = Math.max(0.125, Math.min(8.0, ratio));
        } else {
          const instIdx = i32[vI32 + 2] & 255;
          const mPitchLen = i32[(MACRO_BASE + instIdx * MACRO_INST_STRIDE + MACRO_LANE_STRIDE * 3) >> 2];
          if (mPitchLen <= 0) f32[vF32 + 37] = 1.0;
        }
      }
    }

    stepGridTick() {
      if (!this.playing || !this.gridSong) return;
      const song = this.gridSong;

      // Advance to the next row only AFTER all `song.speed` ticks of the previous row have sounded
      if (this.gridSubTick >= song.speed) {
        this.gridSubTick = 0;
        if (this.gridPendingHalt) {
          this.playing = false;
          exports.stop_all();
          this.gridPendingHalt = false;
          return;
        }
        if (this.gridPendingJump >= 0) {
          this.gridOrder = this.gridPendingJump % song.orders.length;
          this.gridRow = 0;
          this.gridPendingJump = -1;
          this.gridPendingBreak = -1;
        } else if (this.gridPendingBreak >= 0) {
          this.gridOrder = (this.gridOrder + 1) % song.orders.length;
          const nextPat = song.orders[this.gridOrder];
          this.gridRow = Math.min(Math.max(0, (nextPat?.length || 1) - 1), this.gridPendingBreak);
          this.gridPendingBreak = -1;
        } else {
          const prevPat = song.orders[this.gridOrder];
          this.gridRow++;
          if (!prevPat || this.gridRow >= prevPat.length) {
            this.gridRow = 0;
            this.gridOrder = (this.gridOrder + 1) % song.orders.length;
            if (this.gridOrder === 0) {
              this.gridElapsedSec = 0;
            }
          }
        }
      }

      const pat = song.orders[this.gridOrder];
      if (!pat || pat.length === 0) return;

      const isPal = song.machine === 'PAL';
      const isDendy = song.machine === 'Dendy';
      const cpuHz = isPal ? 1662607 : isDendy ? 1773448 : 1789773;
      const vibStyle = song.vibratoStyle ?? 1;
      const detuneTable = song.detuneTable;

      if (this.gridSubTick === 0) {
        const rowCells = pat[this.gridRow] || [];
        let jumpOrder = -1;
        let breakRow = -1;
        let halted = false;

        for (let ch = 0; ch < song.channelCount && ch < rowCells.length; ch++) {
          const cell = rowCells[ch];
          if (!cell) continue;
          let delayTicks = 0;
          let hasArp = false;
          let hasSlide = false;
          let hasPorta = false;
          let dpcmByteOffset = 0;
          let noteSlideReq = null;

          const spec =
            this.channelMap.length > 0
              ? this.channelMap[ch % this.channelMap.length]
              : { chipKind: 2, tuningHz: 440, freqMul: 1.0, ftmChipIdx: 0, volume: 1.0, pan: 0.0, defaultDuty: 2 };

          if (cell.fx && cell.fx.length > 0) {
            for (let fi = 0; fi < cell.fx.length; fi++) {
              const fx = cell.fx[fi];
              const id = fx.id;
              const val = fx.val;
              if (id === 0x0f) {
                if (val > 0 && val < 0x20) song.speed = val;
                else if (val >= 0x20) song.tempo = val;
              } else if (id === 0x0b) {
                jumpOrder = val;
              } else if (id === 0x0d) {
                breakRow = Math.max(0, Math.min(song.rowsPerPattern - 1, ((val >> 4) * 10) + (val & 0x0f)));
              } else if (id === 0x0c) {
                halted = true;
              } else if (id === 0xed) {
                delayTicks = val & 0x1f;
              } else if (id === 0xec) {
                this.gridCutTicks[ch] = val & 0x1f;
              } else if (id === 0x00) {
                hasArp = true;
                this.gridArpVal[ch] = val;
              } else if (id === 0x01) {
                hasSlide = true;
                this.gridSlideDelta[ch] = val;
              } else if (id === 0x02) {
                hasSlide = true;
                this.gridSlideDelta[ch] = -val;
              } else if (id === 0x03) {
                hasPorta = true;
                if (val > 0) this.gridPortaSpeed[ch] = val;
                else if (cell.midi < 0) this.gridPortaSpeed[ch] = 0;
              } else if (id === 0x04) {
                this.gridVibParam[ch] = val;
              } else if (id === 0x0a) {
                this.gridVolSlide[ch] = val;
              } else if (id === 0x12) {
                // Vxx Duty / Noise mode (persist per channel)
                this.gridChannelDuty[ch] = val & 0x0f;
                this.setEffect(ch, 0x12, val);
              } else if (id === 0x148 || id === 0x149) {
                // Hxy (sweep up, bit7=0) / Ixy (sweep down, bit7=1) on 2A03 Pulse channels
                if (spec.chipKind === 2) {
                  const shift = val & 0x07;
                  if (shift === 0 || val === 0) {
                    this.gridSweepParam[ch] = 0;
                    this.gridSweepDelta[ch] = 0;
                  } else {
                    const dirFlag = id === 0x149 ? 0x80 : 0x00;
                    this.gridSweepParam[ch] = dirFlag | (val & 0x7f);
                    this.gridSweepTick[ch] = 0;
                  }
                }
              } else if (id === 0x14b) {
                // Dn-FT Kxx Harmonic frequency multiplier (00 or 01 resets to 1x)
                this.gridHarmonicMul[ch] = val <= 1 ? 1.0 : val;
              } else if (id === 0x150) {
                // FTM Pxx Fine Pitch ($80 = center; >80 sharper -> lower period; <80 flatter -> higher period)
                this.gridFinePitch[ch] = -(val - 0x80);
              } else if (id === 0x151 || id === 0x152) {
                // FTM Qxy (up) / Rxy (down): slide y semitones at speed x
                const spd = ((val >> 4) & 0x0f) * 2 + 1;
                const semi = val & 0x0f;
                if (semi > 0) {
                  noteSlideReq = { dir: id === 0x151 ? 1 : -1, speed: spd, semi };
                }
              } else if (id === 0x154) {
                // 0CC/Dn-FT Txy Delayed Transpose: x[3]=dir (0=+,1=-), x[2:0]=delay ticks, y=semis
                const xNib = (val >> 4) & 0x0f;
                const yNib = val & 0x0f;
                if (val === 0) {
                  this.gridTransposeSemis[ch] = 0;
                  this.gridPendingTranspose[ch] = null;
                } else {
                  const delay = xNib & 0x07;
                  const signedSemi = (xNib & 0x08) ? -yNib : yNib;
                  if (delay === 0) {
                    this.gridTransposeSemis[ch] = signedSemi;
                    this.gridPendingTranspose[ch] = null;
                  } else {
                    this.gridPendingTranspose[ch] = { ticksLeft: delay, semis: signedSemi };
                  }
                }
              } else if (id === 0x157) {
                // FTM Wxx DPCM Pitch override
                this.gridDpcmRate[ch] = val & 0x0f;
              } else if (id === 0x159) {
                // FTM Yxx DPCM sample byte offset (xx * 64)
                dpcmByteOffset = (val & 0xff) * 64;
              } else if (id === 0x15a) {
                // FTM Zxx (N163 Wave Buffer select)
                if (spec.chipKind === 8) {
                  this.setEffect(ch, 0x10, val);
                }
              } else if (id === 0x13d) {
                // Dn-FT =xx Phase Reset
                const vF32 = (VOICE_BASE + ch * VOICE_STRIDE) >> 2;
                f32[vF32 + 10] = 0.0;
              } else if (id === 0x08 || id === 0x10) {
                this.setEffect(ch, id, val);
              }
            }
          }

          if (!hasArp && this.gridArpVal[ch] !== 0) {
            this.gridArpVal[ch] = 0;
          }

          if (cell.inst >= 0) this.gridLastInst[ch] = cell.inst;
          if (cell.vol >= 0) this.gridLastVol[ch] = cell.vol;

          if (cell.off) {
            this.gridSlideDelta[ch] = 0;
            this.gridArpVal[ch] = 0;
            this.gridVibParam[ch] = 0;
            this.gridVolSlide[ch] = 0;
            this.gridTargetFreq[ch] = 0;
            this.gridTargetMidi[ch] = -1;
            this.gridNoteSlideTargetFreq[ch] = 0;
            this.gridNoteSlideTargetMidi[ch] = -1;
            this.gridSweepParam[ch] = 0;
            this.gridSweepDelta[ch] = 0;
            if (delayTicks > 0) {
              this.gridCutTicks[ch] = delayTicks;
            } else {
              this.noteOff(ch);
            }
          } else if (cell.midi >= 0) {
            const vel = Math.max(8, Math.min(127, Math.round((this.gridLastVol[ch] / 100) * 127)));
            const inst = this.gridLastInst[ch];
            const vBase = VOICE_BASE + ch * VOICE_STRIDE;
            const vI32 = vBase >> 2;
            const noteFreq = spec.chipKind === 4
              ? noiseIndexToHz(cell.midi >= 12 ? (cell.midi - 12) & 0x0f : cell.midi & 0x0f, isPal)
              : midiToHz(cell.midi, spec.tuningHz) * (spec.freqMul ?? 1.0);

            if (
              hasPorta &&
              this.gridPortaSpeed[ch] > 0 &&
              delayTicks === 0 &&
              i32[vI32] === 1 &&
              spec.chipKind !== 4 &&
              spec.chipKind !== 5
            ) {
              // 3xx Tone Portamento: glide smoothly from current pitch toward new target without phase reset
              this.gridTargetFreq[ch] = noteFreq;
              this.gridTargetMidi[ch] = cell.midi;
              this.gridNoteSlideTargetFreq[ch] = 0;
              this.gridNoteSlideTargetMidi[ch] = -1;
            } else {
              if (!hasSlide) this.gridSlideDelta[ch] = 0;
              this.gridPeriodDelta[ch] = 0;
              this.gridTargetFreq[ch] = 0;
              this.gridTargetMidi[ch] = -1;
              this.gridNoteSlideTargetFreq[ch] = 0;
              this.gridNoteSlideTargetMidi[ch] = -1;
              this.gridPitchMacroAcc[ch] = 0;
              this.gridPitchMacroTick[ch] = 0;
              this.gridHiPitchMacroAcc[ch] = 0;
              this.gridHiPitchMacroTick[ch] = 0;
              this.gridTonalArpTick[ch] = 0;
              this.gridNoiseArpTick[ch] = 0;
              this.gridSweepDelta[ch] = 0;
              this.gridSweepTick[ch] = 0;
              const dpcmRateIdx = this.gridDpcmRate[ch];
              this.gridDpcmRate[ch] = -1;
              const dutyOverride = this.gridChannelDuty[ch] >= 0 ? this.gridChannelDuty[ch] : -1;
              if (delayTicks > 0) {
                this.gridDelayedNote[ch] = {
                  ticksLeft: delayTicks,
                  midi: cell.midi,
                  vel,
                  inst,
                  dpcmRateIdx,
                  dpcmByteOffset,
                  noteFreq,
                  dutyOverride,
                };
              } else {
                this.gridDelayedNote[ch] = null;
                this.noteOn(ch, cell.midi, vel, inst, {
                  dpcmRateIdx,
                  dpcmByteOffset,
                  skipWasmArp: true,
                  dutyOverride,
                });
                this.gridBaseFreq[ch] = noteFreq;
                this.gridBaseMidi[ch] = cell.midi;
              }
            }
          } else if (cell.vol >= 0 && spec.chipKind !== 5) {
            const vF32 = (VOICE_BASE + ch * VOICE_STRIDE) >> 2;
            f32[vF32 + 6] = Math.max(0.05, Math.min(1, this.gridLastVol[ch] / 100));
          }

          if (noteSlideReq && spec.chipKind !== 4 && spec.chipKind !== 5) {
            const anchorMidi = cell.midi >= 0 ? cell.midi : this.gridBaseMidi[ch];
            if (anchorMidi >= 0) {
              const targetMidi = Math.max(12, Math.min(119, anchorMidi + noteSlideReq.dir * noteSlideReq.semi));
              this.gridNoteSlideTargetFreq[ch] = midiToHz(targetMidi, spec.tuningHz) * (spec.freqMul ?? 1.0);
              this.gridNoteSlideTargetMidi[ch] = targetMidi;
              this.gridNoteSlideSpeed[ch] = noteSlideReq.speed;
            }
          }
        }

        this.gridPendingJump = jumpOrder;
        this.gridPendingBreak = breakRow;
        this.gridPendingHalt = halted;
      }

      // Per-tick effects, period-space slides, & macros across all channels
      syncViews();
      for (let ch = 0; ch < song.channelCount; ch++) {
        const pendTrans = this.gridPendingTranspose[ch];
        if (pendTrans) {
          if (pendTrans.ticksLeft <= 0) {
            this.gridTransposeSemis[ch] = pendTrans.semis;
            this.gridPendingTranspose[ch] = null;
          } else {
            pendTrans.ticksLeft--;
          }
        }

        const delayed = this.gridDelayedNote[ch];
        if (delayed) {
          if (delayed.ticksLeft <= 0) {
            this.gridPeriodDelta[ch] = 0;
            this.gridPitchMacroAcc[ch] = 0;
            this.gridPitchMacroTick[ch] = 0;
            this.gridHiPitchMacroAcc[ch] = 0;
            this.gridHiPitchMacroTick[ch] = 0;
            this.gridTonalArpTick[ch] = 0;
            this.gridNoiseArpTick[ch] = 0;
            this.gridSweepDelta[ch] = 0;
            this.gridSweepTick[ch] = 0;
            this.noteOn(ch, delayed.midi, delayed.vel, delayed.inst, {
              dpcmRateIdx: delayed.dpcmRateIdx,
              dpcmByteOffset: delayed.dpcmByteOffset,
              skipWasmArp: true,
              dutyOverride: delayed.dutyOverride,
            });
            this.gridBaseFreq[ch] = delayed.noteFreq;
            this.gridBaseMidi[ch] = delayed.midi;
            this.gridDelayedNote[ch] = null;
          } else {
            delayed.ticksLeft--;
          }
        }
        if (this.gridCutTicks[ch] === 0) {
          this.noteOff(ch);
          this.gridCutTicks[ch] = -1;
        } else if (this.gridCutTicks[ch] > 0) {
          this.gridCutTicks[ch]--;
        }

        const vBase = VOICE_BASE + ch * VOICE_STRIDE;
        const vI32 = vBase >> 2;
        const vF32 = vBase >> 2;
        if (i32[vI32] !== 1) continue;

        const chipKind = i32[vI32 + 1];
        const instIdx = i32[vI32 + 2] & 255;
        const spec =
          this.channelMap.length > 0
            ? this.channelMap[ch % this.channelMap.length]
            : { chipKind, tuningHz: 440, freqMul: 1.0, ftmChipIdx: 0 };
        const ftmMac = this.ftmMacros.get(instIdx);

        // Volume Slide (Axy) — never affects DPCM
        if (chipKind !== 5 && this.gridVolSlide[ch] > 0) {
          const vs = this.gridVolSlide[ch];
          const up = (vs >> 4) & 0x0f;
          const dn = vs & 0x0f;
          const delta = (up > 0 ? up : -dn) / 48;
          f32[vF32 + 6] = Math.max(0.0, Math.min(1.0, f32[vF32 + 6] + delta));
        }

        // NES 2A03 Noise Pitch / Arpeggio stepping
        if (chipKind === 4) {
          const baseIdx = this.gridBaseMidi[ch] >= 12 ? (this.gridBaseMidi[ch] - 12) & 0x0f : Math.max(0, this.gridBaseMidi[ch]) & 0x0f;
          let effIdx = baseIdx;
          if (ftmMac?.arp && ftmMac.arp.items.length > 0) {
            const mac = ftmMac.arp;
            let idxPos = this.gridNoiseArpTick[ch]++;
            if (idxPos >= mac.items.length) {
              idxPos = mac.loop >= 0 && mac.loop < mac.items.length
                ? mac.loop + ((idxPos - mac.loop) % (mac.items.length - mac.loop))
                : mac.items.length - 1;
            }
            const arpVal = mac.items[idxPos] ?? 0;
            effIdx = mac.mode === 1 ? (arpVal & 0x0f) : Math.max(0, Math.min(15, effIdx + arpVal));
          }
          const patArp = this.gridArpVal[ch];
          if (patArp > 0) {
            const step = this.gridSubTick % 3;
            const semi = step === 1 ? (patArp >> 4) & 0x0f : step === 2 ? patArp & 0x0f : 0;
            effIdx = Math.max(0, Math.min(15, effIdx + semi));
          }
          effIdx = Math.max(0, Math.min(15, effIdx + this.gridTransposeSemis[ch]));
          f32[vF32 + 5] = noiseIndexToHz(effIdx, isPal);
          f32[vF32 + 37] = 1.0;
          continue;
        }

        if (chipKind === 5) {
          f32[vF32 + 37] = 1.0;
          continue;
        }

        // Tonal Channels: exact hardware period-space pitch math, Tone Porta (3xx), Note Slide (Qxy/Rxy),
        // Sweep (Hxy/Ixy), Pxx, Kxx, Txy, DetuneTable, Vibrato (4xy), Arp + Pitch + Hi-Pitch Macros
        const freqMul = spec.freqMul ?? 1.0;
        const tuningHz = spec.tuningHz || 440;
        const rawBaseFreq = this.gridBaseFreq[ch] || f32[vF32 + 4] || 220;
        const freqToPeriod = (hz) => Math.max(1, cpuHz / (16 * Math.max(20, hz / freqMul)) - 1);
        let baseP = freqToPeriod(rawBaseFreq);

        // 3xx Tone Portamento
        if (this.gridTargetFreq[ch] > 0 && this.gridPortaSpeed[ch] > 0) {
          const curP = baseP + this.gridPeriodDelta[ch];
          const tgtP = freqToPeriod(this.gridTargetFreq[ch]);
          const spd = this.gridPortaSpeed[ch];
          if (Math.abs(tgtP - curP) <= spd) {
            this.gridBaseFreq[ch] = this.gridTargetFreq[ch];
            if (this.gridTargetMidi[ch] >= 0) this.gridBaseMidi[ch] = this.gridTargetMidi[ch];
            f32[vF32 + 4] = this.gridTargetFreq[ch];
            this.gridPeriodDelta[ch] = 0;
            this.gridTargetFreq[ch] = 0;
            this.gridTargetMidi[ch] = -1;
            baseP = tgtP;
          } else {
            const nextP = curP + (tgtP > curP ? spd : -spd);
            this.gridPeriodDelta[ch] = nextP - baseP;
          }
        }

        // Qxy / Rxy Note Slide
        if (this.gridNoteSlideTargetFreq[ch] > 0 && this.gridNoteSlideSpeed[ch] > 0) {
          const curP = baseP + this.gridPeriodDelta[ch];
          const tgtP = freqToPeriod(this.gridNoteSlideTargetFreq[ch]);
          const spd = this.gridNoteSlideSpeed[ch];
          if (Math.abs(tgtP - curP) <= spd) {
            this.gridBaseFreq[ch] = this.gridNoteSlideTargetFreq[ch];
            if (this.gridNoteSlideTargetMidi[ch] >= 0) this.gridBaseMidi[ch] = this.gridNoteSlideTargetMidi[ch];
            f32[vF32 + 4] = this.gridNoteSlideTargetFreq[ch];
            this.gridPeriodDelta[ch] = 0;
            this.gridNoteSlideTargetFreq[ch] = 0;
            this.gridNoteSlideTargetMidi[ch] = -1;
            baseP = tgtP;
          } else {
            const nextP = curP + (tgtP > curP ? spd : -spd);
            this.gridPeriodDelta[ch] = nextP - baseP;
          }
        }

        // 1xx / 2xx Continuous Pitch Slide (bounded cleanly so period never collapses into aliasing)
        const slide = this.gridSlideDelta[ch];
        if (slide !== 0 && this.gridSubTick > 0) {
          const maxDeltaUp = -(baseP - 4.0);
          const maxDeltaDn = 2048.0;
          this.gridPeriodDelta[ch] = Math.max(maxDeltaUp, Math.min(maxDeltaDn, this.gridPeriodDelta[ch] - slide));
        }

        // Hxy / Ixy 2A03 Hardware Sweep
        if (this.gridSweepParam[ch] > 0) {
          const sw = this.gridSweepParam[ch];
          const isDown = (sw & 0x80) !== 0;
          const periodDiv = ((sw >> 3) & 0x07) + 1;
          const shift = sw & 0x07;
          this.gridSweepTick[ch]++;
          if (shift > 0 && (this.gridSweepTick[ch] % periodDiv) === 0) {
            const curSwP = Math.max(8, Math.min(2047, baseP + this.gridPeriodDelta[ch] + this.gridSweepDelta[ch]));
            const stepAmt = Math.max(1, curSwP >> shift);
            this.gridSweepDelta[ch] += isDown ? stepAmt : -stepAmt;
          }
        }

        // Unified Arpeggio (FTM Instrument Arp Macro + 00xy Pattern Arp + Txy Transpose + Kxx Harmonic) -> curFreq (+20)
        let curBaseHz = this.gridBaseFreq[ch] || rawBaseFreq;
        let arpMidi = this.gridBaseMidi[ch];
        if (ftmMac?.arp && ftmMac.arp.items.length > 0) {
          const mac = ftmMac.arp;
          let idxPos = this.gridTonalArpTick[ch]++;
          if (idxPos >= mac.items.length) {
            idxPos = mac.loop >= 0 && mac.loop < mac.items.length
              ? mac.loop + ((idxPos - mac.loop) % (mac.items.length - mac.loop))
              : mac.items.length - 1;
          }
          const arpVal = mac.items[idxPos] ?? 0;
          if (mac.mode === 1) {
            arpMidi = Math.max(12, Math.min(119, arpVal));
            curBaseHz = midiToHz(arpMidi, tuningHz) * freqMul;
          } else {
            curBaseHz *= Math.pow(2, arpVal / 12);
            if (arpMidi >= 0) arpMidi = Math.max(12, Math.min(119, arpMidi + arpVal));
          }
        }
        const patArp = this.gridArpVal[ch];
        if (patArp > 0) {
          const step = this.gridSubTick % 3;
          const semi = step === 1 ? (patArp >> 4) & 0x0f : step === 2 ? patArp & 0x0f : 0;
          curBaseHz *= Math.pow(2, semi / 12);
          if (arpMidi >= 0) arpMidi = Math.max(12, Math.min(119, arpMidi + semi));
        }
        if (this.gridTransposeSemis[ch] !== 0) {
          curBaseHz *= Math.pow(2, this.gridTransposeSemis[ch] / 12);
          if (arpMidi >= 0) arpMidi = Math.max(12, Math.min(119, arpMidi + this.gridTransposeSemis[ch]));
        }
        if (this.gridHarmonicMul[ch] !== 1.0) {
          curBaseHz *= this.gridHarmonicMul[ch];
        }
        f32[vF32 + 5] = Math.max(20.0, curBaseHz);

        // FTM Pitch (seqType=2) and Hi-Pitch (seqType=3) Macros — both accumulate deltas cleanly
        let macroPitchOffset = 0;
        if (ftmMac?.pitch && ftmMac.pitch.items.length > 0) {
          const pm = ftmMac.pitch;
          const t = this.gridPitchMacroTick[ch];
          if (t < pm.items.length) {
            const val = pm.items[t] ?? 0;
            this.gridPitchMacroAcc[ch] = pm.mode === 1 ? val : (this.gridPitchMacroAcc[ch] + val);
            this.gridPitchMacroTick[ch] = t + 1;
            if (this.gridPitchMacroTick[ch] >= pm.items.length && pm.loop >= 0 && pm.loop < pm.items.length) {
              this.gridPitchMacroTick[ch] = pm.loop;
            }
          }
          macroPitchOffset += this.gridPitchMacroAcc[ch];
        }
        if (ftmMac?.hiPitch && ftmMac.hiPitch.items.length > 0) {
          const hm = ftmMac.hiPitch;
          const t = this.gridHiPitchMacroTick[ch];
          if (t < hm.items.length) {
            const val = (hm.items[t] ?? 0) * 16;
            this.gridHiPitchMacroAcc[ch] = hm.mode === 1 ? val : (this.gridHiPitchMacroAcc[ch] + val);
            this.gridHiPitchMacroTick[ch] = t + 1;
            if (this.gridHiPitchMacroTick[ch] >= hm.items.length && hm.loop >= 0 && hm.loop < hm.items.length) {
              this.gridHiPitchMacroTick[ch] = hm.loop;
            }
          }
          macroPitchOffset += this.gridHiPitchMacroAcc[ch];
        }

        // DETUNETABLES hardware offset per (ftmChipIdx, note)
        let detuneOffset = 0;
        if (detuneTable && arpMidi >= 12) {
          const ftmNoteIdx = Math.max(0, Math.min(95, arpMidi - 12));
          const ftmChip = Math.max(0, Math.min(5, spec.ftmChipIdx ?? 0));
          detuneOffset = detuneTable[ftmChip * 96 + ftmNoteIdx] || 0;
        }

        const totalPeriodDelta = this.gridPeriodDelta[ch] + this.gridSweepDelta[ch] + this.gridFinePitch[ch] + detuneOffset - macroPitchOffset;
        const minPeriod = chipKind <= 5 ? 4.0 : 1.0;
        const maxPeriod = chipKind <= 5 ? 2047 : 16383;
        const effP = Math.max(minPeriod, Math.min(maxPeriod, baseP + totalPeriodDelta));
        let pitchRatio = (baseP + 1.0) / (effP + 1.0);

        // 04xy Vibrato (respecting FamiTracker Old=0 downward-only vs New=1 symmetric style)
        const vib = this.gridVibParam[ch];
        if (vib > 0) {
          const vSpd = (vib >> 4) & 0x0f;
          const vDep = vib & 0x0f;
          this.gridVibPhase[ch] += (vSpd * Math.PI * 2) / 64;
          const sinVal = Math.sin(this.gridVibPhase[ch]);
          const vibOct = vibStyle === 0
            ? ((sinVal - 1.0) * 0.5) * (vDep / 15) * 0.042
            : sinVal * (vDep / 15) * 0.042;
          pitchRatio *= Math.pow(2, vibOct);
        }

        f32[vF32 + 25] = 0.0; // Clear linear Hz offset so multiplicative macroPitchMul governs cleanly
        f32[vF32 + 37] = Math.max(0.125, Math.min(8.0, pitchRatio));
      }

      this.gridSubTick++;
    }

    render(outLPtr, outRPtr, frames) {
      const total = frames | 0;
      if (this.playing && (this.gridSong || this.furSong)) {
        if (this.gridSong && this.gridNeedsInitialStep) {
          this.gridNeedsInitialStep = false;
          this.stepGridTick();
        } else if (this.furSong && this.furNeedsInitialStep) {
          this.furNeedsInitialStep = false;
          if (this.furSubTick === 0) {
            this.stepFurSongRow();
          }
          this.stepFurTick();
          const activeSpeed = this.furRowParity === 0 ? this.furSong.speed1 : this.furSong.speed2;
          this.furSubTick = (this.furSubTick + 1) % Math.max(1, activeSpeed);
        }

        let done = 0;
        while (done < total) {
          if (!this.playing) {
            exports.render((outLPtr + done * 4) | 0, (outRPtr + done * 4) | 0, (total - done) | 0);
            break;
          }
          const remaining = total - done;
          let tickHz = 60;
          if (this.gridSong) {
            tickHz = (this.gridSong.baseTickHz * (this.gridSong.tempo / 150)) * this.gridTempoScale;
          } else if (this.furSong) {
            tickHz = this.furSong.ticksPerSec * this.gridTempoScale;
          }
          const samplesPerTick = Math.max(64, this.sampleRate / Math.max(10, tickHz));
          const accum = this.gridSong ? this.gridSampleAccum : this.furSampleAccum;
          const samplesUntilTick = Math.max(1, Math.ceil(samplesPerTick - accum));
          const chunk = Math.min(remaining, samplesUntilTick);

          exports.render((outLPtr + done * 4) | 0, (outRPtr + done * 4) | 0, chunk | 0);
          done += chunk;

          if (this.gridSong) {
            this.gridElapsedSec += chunk / this.sampleRate;
            this.gridSampleAccum += chunk;
            while (this.gridSampleAccum >= samplesPerTick) {
              this.gridSampleAccum -= samplesPerTick;
              this.stepGridTick();
              if (!this.playing) break;
            }
          } else if (this.furSong) {
            this.furSampleAccum += chunk;
            while (this.furSampleAccum >= samplesPerTick) {
              this.furSampleAccum -= samplesPerTick;
              if (this.furSubTick === 0) {
                this.stepFurSongRow();
              }
              this.stepFurTick();
              const activeSpeed = this.furRowParity === 0 ? this.furSong.speed1 : this.furSong.speed2;
              this.furSubTick = (this.furSubTick + 1) % Math.max(1, activeSpeed);
            }
          }
        }
        return total;
      }
      return exports.render(outLPtr | 0, outRPtr | 0, total);
    }

    getChannelScope(ch, outPtr, frames) {
      return exports.get_channel_scope(ch | 0, outPtr | 0, frames | 0);
    }
  }

  runtimeModule.AriaFurnaceEngine = AriaFurnaceEngine;
  return runtimeModule;
}

export default createAriaFurnaceModule;
