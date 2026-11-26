#!/usr/bin/env node
/**
 * scripts/build-furnace-wasm.mjs
 * Builds `/public/wasm/aria_furnace_all.wasm` directly as a verified WebAssembly MVP binary.
 *
 * Implements real-time multi-chip synthesis in WASM linear memory:
 *   - 4-Op & 2-Op FM synthesis (YM2612 / YM2151 / VRC7 / OPL3, Algorithms 0-7 + Feedback + ADSR)
 *   - NES RP2A03 APU (Pulse 12.5/25/50/75%, 32-step quantized Triangle, 15/7-bit LFSR Noise, Int16 PCM/DPCM)
 *   - Konami VRC6 (8-step Pulse + 6-bit Sawtooth)
 *   - Wavetable chips (FDS, N163, HuC6280, SCC, DMG Wave) reading live WAVETABLE linear memory
 *   - PSG chips (SN76489, AY-3-8910 / Sunsoft 5B, MMC5)
 *   - C64 SID (Tri/Saw/Pulse/Noise + 2-pole SVF LP/BP/HP filter)
 *   - Per-voice 60Hz Macro Sequencer (Volume, Relative/Fixed Arpeggio, Duty, Pitch)
 *   - Per-channel 1024-sample Oscilloscope Ring Buffer for WebScope
 */

import fs from 'node:fs';
import path from 'node:path';

const OP = {
  unreachable: 0x00,
  nop: 0x01,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  return: 0x0f,
  call: 0x10,
  drop: 0x1a,
  select: 0x1b,
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  i32_load: 0x28,
  f32_load: 0x2a,
  i32_load16_s: 0x2e,
  i32_store: 0x36,
  f32_store: 0x38,
  memory_size: 0x3f,
  memory_grow: 0x40,
  i32_const: 0x41,
  f32_const: 0x43,
  i32_eqz: 0x45,
  i32_eq: 0x46,
  i32_ne: 0x47,
  i32_lt_s: 0x48,
  i32_lt_u: 0x49,
  i32_gt_s: 0x4a,
  i32_le_s: 0x4c,
  i32_ge_s: 0x4e,
  f32_eq: 0x5b,
  f32_lt: 0x5d,
  f32_gt: 0x5e,
  f32_le: 0x5f,
  f32_ge: 0x60,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_div_s: 0x6d,
  i32_rem_s: 0x6f,
  i32_and: 0x71,
  i32_or: 0x72,
  i32_xor: 0x73,
  i32_shl: 0x74,
  i32_shr_u: 0x76,
  f32_abs: 0x8b,
  f32_neg: 0x8c,
  f32_floor: 0x8e,
  f32_sqrt: 0x91,
  f32_add: 0x92,
  f32_sub: 0x93,
  f32_mul: 0x94,
  f32_div: 0x95,
  f32_min: 0x96,
  f32_max: 0x97,
  i32_trunc_f32_s: 0xa8,
  f32_convert_i32_s: 0xb2,
};

const T_I32 = 0x7f;
const T_F32 = 0x7d;
const VOID = 0x40;

function uleb(v) {
  const out = [];
  let n = v >>> 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function sleb(v) {
  const out = [];
  let n = v | 0;
  let more = true;
  while (more) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
      more = false;
      out.push(b);
    } else {
      out.push(b | 0x80);
    }
  }
  return out;
}

function f32Bytes(v) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, v, true);
  return Array.from(new Uint8Array(buf));
}

function strBytes(s) {
  const b = Buffer.from(s, 'utf8');
  return [...uleb(b.length), ...b];
}

function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

// Emitter helper for clean WASM instructions
class FnBody {
  constructor(locals = []) {
    this.locals = locals; // array of [count, type]
    this.code = [];
  }
  op(o) {
    if (typeof o !== 'number') throw new Error(`Invalid WASM opcode: ${String(o)}`);
    this.code.push(o);
    return this;
  }
  i32(v) { this.code.push(OP.i32_const, ...sleb(v)); return this; }
  f32(v) { this.code.push(OP.f32_const, ...f32Bytes(v)); return this; }
  get(idx) { this.code.push(OP.local_get, ...uleb(idx)); return this; }
  set(idx) { this.code.push(OP.local_set, ...uleb(idx)); return this; }
  tee(idx) { this.code.push(OP.local_tee, ...uleb(idx)); return this; }
  call(fnIdx) { this.code.push(OP.call, ...uleb(fnIdx)); return this; }
  loadI32(off = 0) { this.code.push(OP.i32_load, 0x02, ...uleb(off)); return this; }
  loadF32(off = 0) { this.code.push(OP.f32_load, 0x02, ...uleb(off)); return this; }
  loadI16S(off = 0) { this.code.push(OP.i32_load16_s, 0x01, ...uleb(off)); return this; }
  storeI32(off = 0) { this.code.push(OP.i32_store, 0x02, ...uleb(off)); return this; }
  storeF32(off = 0) { this.code.push(OP.f32_store, 0x02, ...uleb(off)); return this; }
  block(type = VOID) { this.code.push(OP.block, type); return this; }
  loop(type = VOID) { this.code.push(OP.loop, type); return this; }
  if_(type = VOID) { this.code.push(OP.if, type); return this; }
  else_() { this.code.push(OP.else); return this; }
  end() { this.code.push(OP.end); return this; }
  br(d) { this.code.push(OP.br, ...uleb(d)); return this; }
  brIf(d) { this.code.push(OP.br_if, ...uleb(d)); return this; }
  encode() {
    const locBytes = [...uleb(this.locals.length)];
    for (const [cnt, t] of this.locals) {
      locBytes.push(...uleb(cnt), t);
    }
    const body = [...locBytes, ...this.code, OP.end];
    return [...uleb(body.length), ...body];
  }
}

// Memory layout constants (shared with aria_furnace_all.js)
const ADDR_SAMPLE_RATE = 0x0000;
const ADDR_PLAYING     = 0x0004;
const ADDR_TICK_ACCUM  = 0x0008;
const ADDR_HEAP_PTR    = 0x000c;

const ADDR_SINE_LUT        = 0x01000; // 4096 * 4 = 16384 bytes (0x01000..0x04FFF)
const ADDR_TRI_LUT         = 0x05000; // 32 * 4 = 128 bytes
const ADDR_PITCH_SCALE     = 0x05100; // 256 * 4 = 1024 bytes (semitone multiplier pow(2, (n-128)/12))
const ADDR_MACRO_PITCH_SCALE = 0x05500; // 512 * 4 = 2048 bytes (1/16-semitone multiplier pow(2, (n-256)/192))

const VOICE_BASE       = 0x10000; // 48 voices * 256 bytes = 12288 bytes (0x10000..0x12FFF)
const VOICE_STRIDE     = 256;

const INST_BASE        = 0x20000; // 256 insts * 512 bytes = 131072 bytes (0x20000..0x3FFFF)
const INST_STRIDE      = 512;

const SAMPLE_META_BASE = 0x40000; // 256 samples * 32 bytes = 8192 bytes (0x40000..0x41FFF)
const SAMPLE_META_STRIDE = 32;

const WAVE_BASE        = 0x44000; // 256 waves * 1040 bytes = 266240 bytes (0x44000..0x84FFF)
const WAVE_STRIDE      = 1040;    // +0: len(i32), +4: max(f32), +8..: data[256] (i32 or f32)

const SCOPE_BASE       = 0x90000; // 48 channels * 4096 bytes = 196608 bytes (0x90000..0xBFFFF)
const SCOPE_FRAMES     = 1024;

const MACRO_BASE       = 0x100000; // 256 insts * 4 lanes * 1040 bytes = 1,064,960 bytes (0x100000..0x203FFF)
const MACRO_INST_STRIDE = 4160;    // 4 * 1040
const MACRO_LANE_STRIDE = 1040;    // +0: len, +4: speed, +8: loop, +12: rel, +16: mode, +20..: val[255]

const HEAP_START       = 0x300000; // 3MB onwards for allocate/deallocate

// Type signatures
const types = [
  /* 0: (f32) -> f32         sin_lut(phase) */        [[T_F32], [T_F32]],
  /* 1: (f32) -> void        init(sr) */              [[T_F32], []],
  /* 2: (i32) -> i32         allocate(bytes) */       [[T_I32], [T_I32]],
  /* 3: (i32) -> void        deallocate(ptr) */       [[T_I32], []],
  /* 4: (i32,i32,i32) -> i32 render/scope */          [[T_I32, T_I32, T_I32], [T_I32]],
  /* 5: (i32) -> void        note_off / stop */       [[T_I32], []],
  /* 6: () -> void           stop_all */              [[], []],
  /* 7: (i32,i32,f32) -> f32 tick_macro(inst,lane,idx) */ [[T_I32, T_I32, T_I32], [T_I32]],
  /* 8: (i32) -> f32         semitone_ratio(semi) */  [[T_I32], [T_F32]],
  /* 9: (i32,f32) -> f32     sample_step(voice,sr) */ [[T_I32, T_F32], [T_F32]],
];

const fnTypes = [
  0, // 0: sin_lut(phase: f32) -> f32
  8, // 1: pow2_semi(semiOffset: i32) -> f32
  9, // 2: render_voice_sample(vPtr: i32, sr: f32) -> f32
  1, // 3: init(sr: f32)
  2, // 4: allocate(bytes: i32) -> i32
  3, // 5: deallocate(ptr: i32)
  4, // 6: render(outLPtr: i32, outRPtr: i32, frames: i32) -> i32
  4, // 7: get_channel_scope(ch: i32, outPtr: i32, frames: i32) -> i32
  5, // 8: note_off(ch: i32)
  6, // 9: stop_all()
];

// Function 0: sin_lut(phase: f32) -> f32
const fnSinLut = (() => {
  const b = new FnBody([[1, T_I32]]);
  // wrap phase to [0, 1): p = phase - floor(phase)
  // idx = ((int)(p * 4096.0)) & 4095
  b.get(0)
    .get(0).op(OP.f32_floor)
    .op(OP.f32_sub)
    .f32(4096.0).op(OP.f32_mul)
    .op(OP.i32_trunc_f32_s)
    .i32(4095).op(OP.i32_and)
    .i32(2).op(OP.i32_shl)
    .loadF32(ADDR_SINE_LUT);
  return b;
})();

// Function 1: pow2_semi(semiOffset: i32) -> f32 (clamped [-128..127] -> index [0..255])
const fnPow2Semi = (() => {
  const b = new FnBody([[1, T_I32]]);
  // idx = clamp(semi + 128, 0, 255)
  b.get(0).i32(128).op(OP.i32_add).set(1);
  b.get(1).i32(0).op(OP.i32_lt_s).if_(VOID).i32(0).set(1).end();
  b.get(1).i32(255).op(OP.i32_gt_s).if_(VOID).i32(255).set(1).end();
  b.get(1).i32(2).op(OP.i32_shl).loadF32(ADDR_PITCH_SCALE);
  return b;
})();

// Function 2: render_voice_sample(vPtr: i32, sr: f32) -> f32
// Voice fields:
// +0 active, +4 chipKind, +8 instIdx, +12 midiNote, +16 baseFreq, +20 curFreq,
// +24 vel, +28 chipVol, +32 pan, +36 duty, +40 phase, +44 env,
// +48..60 opPhases, +64..76 opEnvs, +80 lfsr, +84 noiseState,
// +88 macroStep, +92 macroSub, +96 arpOffset, +100 pitchOffset, +104 macroVol,
// +108 waveId, +112 sampleId, +116 samplePos, +120 sampleInc, +124 sampleLoop,
// +128 svfLow, +132 svfBand, +136 op0Out, +140 scopeWriteIdx, +144 released,
// +148 macroPitchMul, +152 lfsr32, +156 noiseLp, +160 freqMul, +164 skipWasmArp, +168 noiseBitVal
const fnRenderVoice = (() => {
  const b = new FnBody([
    [12, T_F32], // 2: phase, 3: out, 4: freq, 5: inc, 6: env, 7: tmpf, 8: op0, 9: op1, 10: noiseAcc, 11: remain, 12: curLvl, 13: noiseLp
    [8, T_I32],  // 14: chipKind, 15: instPtr, 16: active, 17: lfsr, 18: idx, 19: smpPtr, 20: noiseCnt, 21: shortMode
  ]);

  const L_VPTR = 0;
  const L_SR = 1;
  const L_PHASE = 2;
  const L_OUT = 3;
  const L_FREQ = 4;
  const L_INC = 5;
  const L_ENV = 6;
  const L_TMPF = 7;
  const L_OP0 = 8;
  const L_OP1 = 9;
  const L_NACC = 10;
  const L_REMAIN = 11;
  const L_CURLVL = 12;
  const L_NOISELP = 13;
  const L_CHIP = 14;
  const L_INST = 15;
  const L_ACT = 16;
  const L_LFSR = 17;
  const L_IDX = 18;
  const L_SMP = 19;
  const L_NCNT = 20;
  const L_SHORT = 21;

  // if active == 0 return 0.0
  b.get(L_VPTR).loadI32(0).tee(L_ACT).op(OP.i32_eqz).if_(VOID)
    .f32(0.0).op(OP.return)
    .end();

  // instPtr = INST_BASE + (clamp(instIdx, 0, 255) * INST_STRIDE)
  b.get(L_VPTR).loadI32(8).i32(255).op(OP.i32_and).i32(INST_STRIDE).op(OP.i32_mul)
    .i32(INST_BASE).op(OP.i32_add).set(L_INST);

  b.get(L_VPTR).loadI32(4).set(L_CHIP);

  // Envelope update: DPCM (chipKind == 5) holds flat sustain until release; other voices gently decay
  b.get(L_VPTR).loadF32(44).set(L_ENV);
  b.get(L_VPTR).loadI32(144).if_(VOID)
    // released -> fast exponential release
    .get(L_ENV).f32(0.996).op(OP.f32_mul).tee(L_ENV)
    .f32(0.001).op(OP.f32_lt).if_(VOID)
      .get(L_VPTR).i32(0).storeI32(0) // deactivate voice
      .f32(0.0).op(OP.return)
    .end()
  .else_()
    .get(L_CHIP).i32(5).op(OP.i32_ne).if_(VOID)
      .get(L_ENV).f32(0.999985).op(OP.f32_mul).set(L_ENV)
    .else_()
      .f32(1.0).set(L_ENV)
    .end()
  .end();
  b.get(L_VPTR).get(L_ENV).storeF32(44);

  // Effective freq = max(20, curFreq * macroPitchMul (+148) + pitchOffset (+100))
  b.get(L_VPTR).loadF32(148).tee(L_TMPF).f32(0.05).op(OP.f32_le).if_(VOID)
    .f32(1.0).set(L_TMPF)
  .end();
  b.get(L_VPTR).loadF32(20).get(L_TMPF).op(OP.f32_mul)
    .get(L_VPTR).loadF32(100).op(OP.f32_add)
    .f32(20.0).op(OP.f32_max)
    .set(L_FREQ);
  // Allow NES Noise LFSR clock up to 450kHz for oversampled multi-clock white noise; clamp tonal voices at 0.45*sr
  b.get(L_CHIP).i32(4).op(OP.i32_eq).if_(VOID)
    .get(L_FREQ).f32(450000.0).op(OP.f32_min).set(L_FREQ)
  .else_()
    .get(L_FREQ).get(L_SR).f32(0.45).op(OP.f32_mul).op(OP.f32_min).set(L_FREQ)
  .end();

  b.get(L_FREQ).get(L_SR).op(OP.f32_div).set(L_INC);

  // Dedicated NES / RP2A03 / DMG / SN76489 Noise (chipKind == 4):
  // Continuous-time sub-sample boxcar integration + canonical 15-bit short-loop (93-step) / 32-bit Xorshift PRNG + 1-pole NES DAC lowpass
  b.get(L_CHIP).i32(4).op(OP.i32_eq).if_(VOID)
    .get(L_VPTR).loadF32(40).set(L_PHASE)
    .get(L_VPTR).loadF32(168).tee(L_CURLVL).op(OP.f32_abs).f32(0.5).op(OP.f32_lt).if_(VOID)
      .f32(1.0).set(L_CURLVL)
    .end()
    .f32(0.0).set(L_NACC)
    .get(L_INC).set(L_REMAIN)
    .get(L_VPTR).loadI32(36).i32(1).op(OP.i32_and).tee(L_SHORT)
    .if_(VOID)
      // Short/Loop metallic mode: canonical 15-bit hardware LFSR (balanced 93-step orbit 0x7fff)
      .get(L_VPTR).loadI32(80).i32(0x7fff).op(OP.i32_and).tee(L_LFSR)
      .op(OP.i32_eqz).if_(VOID).i32(0x7fff).set(L_LFSR).end()
    .else_()
      // Long/White mode: 32-bit Xorshift LFSR PRNG (maximal 2^32 - 1 period, zero 73ms buzz)
      .get(L_VPTR).loadI32(152).tee(L_LFSR)
      .op(OP.i32_eqz).if_(VOID).i32(0x6d2b79f5).set(L_LFSR).end()
    .end()
    .i32(0).set(L_NCNT)
    .loop(VOID)
      .get(L_PHASE).get(L_REMAIN).op(OP.f32_add).f32(1.0).op(OP.f32_ge)
      .get(L_NCNT).i32(64).op(OP.i32_lt_s)
      .op(OP.i32_and)
      .if_(VOID)
        .f32(1.0).get(L_PHASE).op(OP.f32_sub).set(L_TMPF)
        .get(L_NACC).get(L_CURLVL).get(L_TMPF).op(OP.f32_mul).op(OP.f32_add).set(L_NACC)
        .get(L_REMAIN).get(L_TMPF).op(OP.f32_sub).set(L_REMAIN)
        .f32(0.0).set(L_PHASE)
        .get(L_NCNT).i32(1).op(OP.i32_add).set(L_NCNT)
        .get(L_SHORT).if_(VOID)
          // Hardware RP2A03 bit0 ^ bit6 -> bit14
          .get(L_LFSR).i32(6).op(OP.i32_shr_u)
          .get(L_LFSR).op(OP.i32_xor).i32(1).op(OP.i32_and)
          .i32(14).op(OP.i32_shl)
          .get(L_LFSR).i32(1).op(OP.i32_shr_u).op(OP.i32_or)
          .set(L_LFSR)
        .else_()
          // 32-bit Xorshift PRNG
          .get(L_LFSR).get(L_LFSR).i32(13).op(OP.i32_shl).op(OP.i32_xor).set(L_LFSR)
          .get(L_LFSR).get(L_LFSR).i32(17).op(OP.i32_shr_u).op(OP.i32_xor).set(L_LFSR)
          .get(L_LFSR).get(L_LFSR).i32(5).op(OP.i32_shl).op(OP.i32_xor).set(L_LFSR)
        .end()
        .get(L_LFSR).i32(1).op(OP.i32_and).if_(T_F32).f32(-1.0).else_().f32(1.0).end().set(L_CURLVL)
        .br(1)
      .end()
    .end()
    .get(L_REMAIN).f32(1.0).op(OP.f32_ge).if_(VOID)
      .get(L_REMAIN).get(L_REMAIN).op(OP.f32_floor).op(OP.f32_sub).set(L_REMAIN)
    .end()
    .get(L_NACC).get(L_CURLVL).get(L_REMAIN).op(OP.f32_mul).op(OP.f32_add).set(L_NACC)
    .get(L_PHASE).get(L_REMAIN).op(OP.f32_add).set(L_PHASE)
    .get(L_PHASE).f32(1.0).op(OP.f32_ge).if_(VOID)
      .get(L_PHASE).get(L_PHASE).op(OP.f32_floor).op(OP.f32_sub).set(L_PHASE)
    .end()
    .get(L_VPTR).get(L_PHASE).storeF32(40)
    .get(L_VPTR).get(L_CURLVL).storeF32(168)
    .get(L_SHORT).if_(VOID)
      .get(L_VPTR).get(L_LFSR).storeI32(80)
    .else_()
      .get(L_VPTR).get(L_LFSR).storeI32(152)
    .end()
    // Exact boxcar sample average = acc / max(inc, 1e-5)
    .get(L_NACC).get(L_INC).f32(0.00001).op(OP.f32_max).op(OP.f32_div).set(L_TMPF)
    // Smooth frequency-compensated gain (constant for a given freq/inc -> zero per-sample noiseCnt jitter)
    .get(L_TMPF)
    .f32(1.0).get(L_INC).f32(0.30).op(OP.f32_sub).f32(0.0).op(OP.f32_max).f32(1.15).op(OP.f32_mul).op(OP.f32_add)
    .op(OP.f32_sqrt).f32(0.45).op(OP.f32_mul)
    .op(OP.f32_mul)
    .f32(-0.65).op(OP.f32_max).f32(0.65).op(OP.f32_min)
    .set(L_TMPF)
    // 1-pole NES DAC analog lowpass (~14 kHz) removes brittle edge aliasing while keeping crisp snare snap
    .f32(88000.0).get(L_SR).f32(88000.0).op(OP.f32_add).op(OP.f32_div).f32(0.88).op(OP.f32_min).set(L_REMAIN)
    .get(L_VPTR).loadF32(156).set(L_NOISELP)
    .get(L_NOISELP).get(L_TMPF).get(L_NOISELP).op(OP.f32_sub).get(L_REMAIN).op(OP.f32_mul).op(OP.f32_add)
    .f32(-0.62).op(OP.f32_max).f32(0.62).op(OP.f32_min)
    .set(L_NOISELP)
    .get(L_VPTR).get(L_NOISELP).storeF32(156)
    .get(L_VPTR).get(L_NOISELP).storeF32(84)
  .else_()
    // Tonal & PSG/SID chips: single-step phase wrap [0, 1)
    .get(L_VPTR).loadF32(40).get(L_INC).op(OP.f32_add).set(L_PHASE)
    .get(L_PHASE).f32(1.0).op(OP.f32_ge).if_(VOID)
      .get(L_PHASE).get(L_PHASE).op(OP.f32_floor).op(OP.f32_sub).set(L_PHASE)
      // Step 32-bit Xorshift PRNG only when PSG noise (chipKind==1 && duty>=8) or SID noise bit 3 is active
      .get(L_CHIP).i32(1).op(OP.i32_eq).get(L_VPTR).loadI32(36).i32(8).op(OP.i32_ge_s).op(OP.i32_and)
      .get(L_CHIP).i32(10).op(OP.i32_eq).get(L_INST).loadI32(124).i32(8).op(OP.i32_and).op(OP.i32_and)
      .op(OP.i32_or)
      .if_(VOID)
        .get(L_VPTR).loadI32(152).tee(L_LFSR).op(OP.i32_eqz).if_(VOID).i32(0x6d2b79f5).set(L_LFSR).end()
        .get(L_LFSR).get(L_LFSR).i32(13).op(OP.i32_shl).op(OP.i32_xor).set(L_LFSR)
        .get(L_LFSR).get(L_LFSR).i32(17).op(OP.i32_shr_u).op(OP.i32_xor).set(L_LFSR)
        .get(L_LFSR).get(L_LFSR).i32(5).op(OP.i32_shl).op(OP.i32_xor).set(L_LFSR)
        .get(L_VPTR).get(L_LFSR).storeI32(152)
        .get(L_VPTR)
        .get(L_LFSR).i32(1).op(OP.i32_and).if_(T_F32).f32(-0.45).else_().f32(0.45).end()
        .storeF32(84)
      .end()
    .end()
    .get(L_VPTR).get(L_PHASE).storeF32(40)
  .end();

  // Dispatch on chipKind
  b.f32(0.0).set(L_OUT);

  // --- CASE 5: NES DPCM / PCM SAMPLE (with linear interpolation for clean resampling) ---
  b.get(L_CHIP).i32(5).op(OP.i32_eq).if_(VOID)
    .get(L_VPTR).loadI32(112).i32(255).op(OP.i32_and)
    .i32(SAMPLE_META_STRIDE).op(OP.i32_mul).i32(SAMPLE_META_BASE).op(OP.i32_add).set(L_SMP)
    // smp+0: ptr, +4: len, +8: rate, +12: loopStart, +16: loopEnd
    .get(L_SMP).loadI32(0).i32(0).op(OP.i32_gt_s)
    .get(L_SMP).loadI32(4).tee(L_NCNT).i32(0).op(OP.i32_gt_s).op(OP.i32_and)
    .if_(VOID)
      .get(L_VPTR).loadF32(116).tee(L_TMPF).op(OP.i32_trunc_f32_s).set(L_IDX)
      .get(L_TMPF).get(L_IDX).op(OP.f32_convert_i32_s).op(OP.f32_sub).set(L_REMAIN)
      .get(L_IDX).get(L_NCNT).op(OP.i32_lt_s).if_(VOID)
        .get(L_SMP).loadI32(0).get(L_IDX).i32(1).op(OP.i32_shl).op(OP.i32_add)
        .loadI16S(0).op(OP.f32_convert_i32_s).f32(24000.0).op(OP.f32_div).set(L_OP0)
        .get(L_IDX).i32(1).op(OP.i32_add).get(L_NCNT).op(OP.i32_lt_s).if_(T_F32)
          .get(L_SMP).loadI32(0).get(L_IDX).i32(1).op(OP.i32_add).i32(1).op(OP.i32_shl).op(OP.i32_add)
          .loadI16S(0).op(OP.f32_convert_i32_s).f32(24000.0).op(OP.f32_div)
        .else_()
          .get(L_VPTR).loadI32(124).if_(T_F32)
            .get(L_SMP).loadI32(0).loadI16S(0).op(OP.f32_convert_i32_s).f32(24000.0).op(OP.f32_div)
          .else_()
            .get(L_OP0)
          .end()
        .end().set(L_OP1)
        .get(L_OP0).get(L_OP1).get(L_OP0).op(OP.f32_sub).get(L_REMAIN).op(OP.f32_mul).op(OP.f32_add).set(L_OUT)
      .else_()
        // Loop or stop
        .get(L_VPTR).loadI32(124).if_(VOID)
          .get(L_VPTR).f32(0.0).storeF32(116)
        .else_()
          .get(L_VPTR).i32(0).storeI32(0)
        .end()
      .end()
    .end()
    // Advance samplePos cleanly if active
    .get(L_VPTR).loadI32(0).if_(VOID)
      .get(L_VPTR).get(L_VPTR).loadF32(116).get(L_VPTR).loadF32(120).op(OP.f32_add).storeF32(116)
    .end()
  .else_()

  // --- CASE 2: NES RP2A03 PULSE (12.5%, 25%, 50%, 75%) ---
  b.get(L_CHIP).i32(2).op(OP.i32_eq).if_(VOID)
    .get(L_VPTR).loadI32(36).i32(3).op(OP.i32_and).set(L_IDX)
    .f32(0.5).set(L_TMPF)
    .get(L_IDX).i32(0).op(OP.i32_eq).if_(VOID).f32(0.125).set(L_TMPF).end()
    .get(L_IDX).i32(1).op(OP.i32_eq).if_(VOID).f32(0.25).set(L_TMPF).end()
    .get(L_IDX).i32(3).op(OP.i32_eq).if_(VOID).f32(0.75).set(L_TMPF).end()
    .get(L_PHASE).get(L_TMPF).op(OP.f32_lt).if_(T_F32).f32(0.55).else_().f32(-0.55).end().set(L_OUT)
  .else_()

  // --- CASE 3: NES RP2A03 32-STEP TRIANGLE ---
  b.get(L_CHIP).i32(3).op(OP.i32_eq).if_(VOID)
    .get(L_PHASE).f32(32.0).op(OP.f32_mul).op(OP.i32_trunc_f32_s).i32(31).op(OP.i32_and)
    .i32(2).op(OP.i32_shl).loadF32(ADDR_TRI_LUT).f32(0.75).op(OP.f32_mul).set(L_OUT)
  .else_()

  // --- CASE 4: NES RP2A03 LFSR NOISE ---
  b.get(L_CHIP).i32(4).op(OP.i32_eq).if_(VOID)
    .get(L_VPTR).loadF32(84).set(L_OUT)
  .else_()

  // --- CASE 6: VRC6 8-LEVEL PULSE ---
  b.get(L_CHIP).i32(6).op(OP.i32_eq).if_(VOID)
    .get(L_VPTR).loadI32(36).i32(7).op(OP.i32_and).i32(1).op(OP.i32_add).op(OP.f32_convert_i32_s)
    .f32(16.0).op(OP.f32_div).set(L_TMPF)
    .get(L_PHASE).get(L_TMPF).op(OP.f32_lt).if_(T_F32).f32(0.55).else_().f32(-0.55).end().set(L_OUT)
  .else_()

  // --- CASE 7: VRC6 SAWTOOTH (DC-centered 14-step saw) ---
  b.get(L_CHIP).i32(7).op(OP.i32_eq).if_(VOID)
    .get(L_PHASE).f32(14.0).op(OP.f32_mul).op(OP.f32_floor).f32(7.0).op(OP.f32_div).f32(0.9285714).op(OP.f32_sub)
    .f32(0.55).op(OP.f32_mul).set(L_OUT)
  .else_()

  // --- CASE 8: WAVETABLE (FDS / N163 / HuC6280 / SCC / DMG) ---
  b.get(L_CHIP).i32(8).op(OP.i32_eq).if_(VOID)
    .get(L_VPTR).loadI32(108).i32(255).op(OP.i32_and).i32(WAVE_STRIDE).op(OP.i32_mul).i32(WAVE_BASE).op(OP.i32_add).set(L_SMP)
    .get(L_SMP).loadI32(0).tee(L_IDX).i32(0).op(OP.i32_gt_s).if_(VOID)
      // idx = floor(phase * len) % len
      .get(L_PHASE).get(L_IDX).op(OP.f32_convert_i32_s).op(OP.f32_mul).op(OP.i32_trunc_f32_s)
      .get(L_IDX).op(OP.i32_rem_s)
      .i32(2).op(OP.i32_shl).get(L_SMP).op(OP.i32_add).loadF32(8)
      .f32(0.65).op(OP.f32_mul).set(L_OUT)
    .else_()
      // default sine if wavetable slot empty
      .get(L_PHASE).call(0).f32(0.6).op(OP.f32_mul).set(L_OUT)
    .end()
  .else_()

  // --- CASE 10: C64 SID (Tri/Saw/Pulse/Noise + 2-pole SVF LP/BP/HP) ---
  b.get(L_CHIP).i32(10).op(OP.i32_eq).if_(VOID)
    .f32(0.0).set(L_TMPF)
    .get(L_INST).loadI32(124).tee(L_IDX) // sidWaveMask
    // bit 0: Tri
    .i32(1).op(OP.i32_and).if_(VOID)
      .get(L_TMPF)
      .f32(1.0).get(L_PHASE).f32(0.5).op(OP.f32_sub).op(OP.f32_abs).f32(4.0).op(OP.f32_mul).op(OP.f32_sub)
      .op(OP.f32_add).set(L_TMPF)
    .end()
    // bit 1: Saw
    .get(L_IDX).i32(2).op(OP.i32_and).if_(VOID)
      .get(L_TMPF).get(L_PHASE).f32(2.0).op(OP.f32_mul).f32(1.0).op(OP.f32_sub).op(OP.f32_add).set(L_TMPF)
    .end()
    // bit 2: Pulse
    .get(L_IDX).i32(4).op(OP.i32_and).if_(VOID)
      .get(L_TMPF)
      .get(L_PHASE).get(L_INST).loadF32(128).op(OP.f32_lt).if_(T_F32).f32(0.8).else_().f32(-0.8).end()
      .op(OP.f32_add).set(L_TMPF)
    .end()
    // bit 3: Noise
    .get(L_IDX).i32(8).op(OP.i32_and).if_(VOID)
      .get(L_TMPF).get(L_VPTR).loadF32(84).op(OP.f32_add).set(L_TMPF)
    .end()
    // 2-pole State Variable Filter: f = clamp(sidCutoff, 0.04, 0.85), q = sidRes
    .get(L_TMPF).f32(0.55).op(OP.f32_mul).set(L_TMPF) // raw sig
    .get(L_VPTR).loadF32(128).set(L_OP0) // low
    .get(L_VPTR).loadF32(132).set(L_OP1) // band
    // high = tmpf - low - q * band
    .get(L_TMPF).get(L_OP0).op(OP.f32_sub)
    .get(L_INST).loadF32(116).get(L_OP1).op(OP.f32_mul).op(OP.f32_sub)
    .set(L_OUT) // L_OUT holds high temporarily
    // band += f * high
    .get(L_OP1).get(L_INST).loadF32(112).get(L_OUT).op(OP.f32_mul).op(OP.f32_add)
    .f32(-1.5).op(OP.f32_max).f32(1.5).op(OP.f32_min).set(L_OP1)
    // low += f * band
    .get(L_OP0).get(L_INST).loadF32(112).get(L_OP1).op(OP.f32_mul).op(OP.f32_add)
    .f32(-1.5).op(OP.f32_max).f32(1.5).op(OP.f32_min).set(L_OP0)
    .get(L_VPTR).get(L_OP0).storeF32(128)
    .get(L_VPTR).get(L_OP1).storeF32(132)
    // select filter output by sidFilterMask (+120)
    .get(L_INST).loadI32(120).i32(2).op(OP.i32_and).if_(VOID)
      .get(L_OP1).set(L_OUT)
    .else_()
      .get(L_INST).loadI32(120).i32(4).op(OP.i32_and).if_(VOID)
        // keep high (L_OUT)
      .else_()
        .get(L_OP0).set(L_OUT) // default LP
      .end()
    .end()
  .else_()

  // --- CASE 0 / 11: 4-OP & 2-OP FM SYNTHESIS (YM2612 / VRC7 / YM2151 / OPL3) ---
  b.get(L_CHIP).i32(0).op(OP.i32_eq).get(L_CHIP).i32(11).op(OP.i32_eq).op(OP.i32_or).if_(VOID)
    // Advance op0..op3 phases: opPhase[i] += inc * inst.op[i].mult
    // INST ops at +16 + op*24: +0=gain(f32), +4=mult(f32), +8=decayMul(f32)
    // Op0 (modulator 1 with self-feedback)
    .get(L_VPTR).loadF32(48).get(L_INC).get(L_INST).loadF32(16 + 4).op(OP.f32_mul).op(OP.f32_add).set(L_TMPF)
    .get(L_TMPF).get(L_TMPF).op(OP.f32_floor).op(OP.f32_sub).set(L_TMPF)
    .get(L_VPTR).get(L_TMPF).storeF32(48)
    // op0Env *= decayMul0
    .get(L_VPTR).loadF32(64).get(L_INST).loadF32(16 + 8).op(OP.f32_mul).set(L_OP1)
    .get(L_VPTR).get(L_OP1).storeF32(64)
    // op0Out = sin(op0Phase + fb * prevOp0Out) * gain0 * op0Env
    .get(L_TMPF).get(L_INST).loadF32(4).get(L_VPTR).loadF32(136).op(OP.f32_mul).op(OP.f32_add)
    .call(0).get(L_INST).loadF32(16).op(OP.f32_mul).get(L_OP1).op(OP.f32_mul).set(L_OP0)
    .get(L_VPTR).get(L_OP0).storeF32(136)

    // Op1 (modulated by op0Out in 2-Op/series alg)
    .get(L_VPTR).loadF32(52).get(L_INC).get(L_INST).loadF32(40 + 4).op(OP.f32_mul).op(OP.f32_add).set(L_TMPF)
    .get(L_TMPF).get(L_TMPF).op(OP.f32_floor).op(OP.f32_sub).set(L_TMPF)
    .get(L_VPTR).get(L_TMPF).storeF32(52)
    .get(L_VPTR).loadF32(68).get(L_INST).loadF32(40 + 8).op(OP.f32_mul).set(L_OP1)
    .get(L_VPTR).get(L_OP1).storeF32(68)
    // if alg == 7 -> additive, else modulated by op0 (in normalized 0..1 cycle units)
    .get(L_INST).loadI32(0).i32(7).op(OP.i32_eq).if_(T_F32)
      .get(L_TMPF).call(0)
    .else_()
      .get(L_TMPF).get(L_OP0).f32(0.35).op(OP.f32_mul).op(OP.f32_add).call(0)
    .end()
    .get(L_INST).loadF32(40).op(OP.f32_mul).get(L_OP1).op(OP.f32_mul).set(L_OP1)

    // If 2-Op (chipKind == 11 or inst.is2Op != 0), output = op1 (+ op0 if alg==7)
    .get(L_CHIP).i32(11).op(OP.i32_eq).get(L_INST).loadI32(8).op(OP.i32_or).if_(VOID)
      .get(L_INST).loadI32(0).i32(7).op(OP.i32_eq).if_(T_F32)
        .get(L_OP0).get(L_OP1).op(OP.f32_add).f32(0.5).op(OP.f32_mul)
      .else_()
        .get(L_OP1)
      .end()
      .set(L_OUT)
    .else_()
      // 4-Op: advance Op2 & Op3
      .get(L_VPTR).loadF32(56).get(L_INC).get(L_INST).loadF32(64 + 4).op(OP.f32_mul).op(OP.f32_add).set(L_TMPF)
      .get(L_TMPF).get(L_TMPF).op(OP.f32_floor).op(OP.f32_sub).set(L_TMPF)
      .get(L_VPTR).get(L_TMPF).storeF32(56)
      .get(L_VPTR).loadF32(72).get(L_INST).loadF32(64 + 8).op(OP.f32_mul).set(L_OP0)
      .get(L_VPTR).get(L_OP0).storeF32(72)
      // op2Out = sin(op2Phase + (alg<=3 ? op1 * 0.28 : 0)) * gain2 * op2Env -> store in L_OP0
      .get(L_TMPF)
      .get(L_INST).loadI32(0).i32(3).op(OP.i32_le_s).if_(T_F32).get(L_OP1).f32(0.28).op(OP.f32_mul).else_().f32(0.0).end()
      .op(OP.f32_add).call(0).get(L_INST).loadF32(64).op(OP.f32_mul).get(L_OP0).op(OP.f32_mul).set(L_OP0)

      // Op3 (main carrier)
      .get(L_VPTR).loadF32(60).get(L_INC).get(L_INST).loadF32(88 + 4).op(OP.f32_mul).op(OP.f32_add).set(L_TMPF)
      .get(L_TMPF).get(L_TMPF).op(OP.f32_floor).op(OP.f32_sub).set(L_TMPF)
      .get(L_VPTR).get(L_TMPF).storeF32(60)
      .get(L_VPTR).loadF32(76).get(L_INST).loadF32(88 + 8).op(OP.f32_mul).set(L_TMPF)
      .get(L_VPTR).get(L_TMPF).storeF32(76)
      // carrier phase = op3Phase + (alg == 7 ? 0 : op2 * 0.32)
      .get(L_VPTR).loadF32(60)
      .get(L_INST).loadI32(0).i32(7).op(OP.i32_eq).if_(T_F32)
        .f32(0.0)
      .else_()
        .get(L_OP0).f32(0.32).op(OP.f32_mul)
      .end()
      .op(OP.f32_add).call(0).get(L_INST).loadF32(88).op(OP.f32_mul).get(L_TMPF).op(OP.f32_mul).set(L_OUT)
      // Mix parallel carriers for ALG >= 4
      .get(L_INST).loadI32(0).i32(4).op(OP.i32_ge_s).if_(VOID)
        .get(L_OUT).get(L_OP1).f32(0.6).op(OP.f32_mul).op(OP.f32_add).f32(0.65).op(OP.f32_mul).set(L_OUT)
      .end()
    .end()
  .else_()

  // --- DEFAULT / CASE 1 / 9: PSG SQUARE / AY-3-8910 / SUNSOFT 5B / DMG / MMC5 ---
  b.get(L_VPTR).loadI32(36).i32(8).op(OP.i32_ge_s).if_(T_F32)
    .get(L_VPTR).loadF32(84)
  .else_()
    .get(L_PHASE).f32(0.5).op(OP.f32_lt).if_(T_F32).f32(0.52).else_().f32(-0.52).end()
  .end().set(L_OUT)

  .end().end().end().end().end().end().end().end().end(); // close 9 nested if/else blocks

  // Scale by vel * chipVol * macroVol * env
  b.get(L_OUT)
    .get(L_VPTR).loadF32(24).op(OP.f32_mul)  // vel
    .get(L_VPTR).loadF32(28).op(OP.f32_mul)  // chipVol
    .get(L_VPTR).loadF32(104).op(OP.f32_mul) // macroVol
    .get(L_ENV).op(OP.f32_mul)
    .set(L_OUT);

  // Record into per-channel oscilloscope ring buffer
  // ch = (vPtr - VOICE_BASE) / VOICE_STRIDE
  b.get(L_VPTR).loadI32(140).set(L_IDX);
  b.get(L_VPTR).i32(VOICE_BASE).op(OP.i32_sub).i32(VOICE_STRIDE).op(OP.i32_div_s)
    .i32(4096).op(OP.i32_mul).i32(SCOPE_BASE).op(OP.i32_add)
    .get(L_IDX).i32(2).op(OP.i32_shl).op(OP.i32_add)
    .get(L_OUT).storeF32(0);
  b.get(L_VPTR).get(L_IDX).i32(1).op(OP.i32_add).i32(1023).op(OP.i32_and).storeI32(140);

  b.get(L_OUT);
  return b;
})();

// Function 3: init(sr: f32)
const fnInit = (() => {
  const b = new FnBody();
  b.get(0).f32(8000.0).op(OP.f32_lt).if_(VOID).f32(44100.0).set(0).end();
  b.i32(ADDR_SAMPLE_RATE).get(0).storeF32(0);
  b.i32(ADDR_HEAP_PTR).i32(HEAP_START).storeI32(0);
  return b;
})();

// Function 4: allocate(bytes: i32) -> i32
const fnAllocate = (() => {
  const b = new FnBody([[3, T_I32]]); // 1: aligned, 2: cur, 3: next
  // align up to 16 bytes
  b.get(0).i32(15).op(OP.i32_add).i32(-16).op(OP.i32_and).set(1);
  b.get(1).i32(16).op(OP.i32_lt_s).if_(VOID).i32(16).set(1).end();
  b.i32(ADDR_HEAP_PTR).loadI32(0).tee(2).get(1).op(OP.i32_add).set(3);
  // Check memory size in pages (65536 bytes) and grow if needed
  b.get(3).i32(65535).op(OP.i32_add).i32(16).op(OP.i32_shr_u)
    .op(OP.memory_size).i32(0) // memory_size has 0x00 reserved byte! Wait: handled explicitly below
  ;
  // Reset code cleanly with explicit memory_size/memory_grow bytes
  b.code = [];
  b.get(0).i32(15).op(OP.i32_add).i32(-16).op(OP.i32_and).set(1);
  b.get(1).i32(16).op(OP.i32_lt_s).if_(VOID).i32(16).set(1).end();
  b.i32(ADDR_HEAP_PTR).loadI32(0).tee(2).get(1).op(OP.i32_add).set(3);
  b.get(3).i32(65535).op(OP.i32_add).i32(16).op(OP.i32_shr_u);
  b.code.push(OP.memory_size, 0x00);
  b.op(OP.i32_gt_s).if_(VOID);
    b.get(3).i32(65535).op(OP.i32_add).i32(16).op(OP.i32_shr_u);
    b.code.push(OP.memory_size, 0x00);
    b.op(OP.i32_sub).i32(16).op(OP.i32_add);
    b.code.push(OP.memory_grow, 0x00, OP.drop);
  b.end();
  b.i32(ADDR_HEAP_PTR).get(3).storeI32(0);
  b.get(2);
  return b;
})();

// Function 5: deallocate(ptr: i32)
const fnDeallocate = (() => new FnBody())();

// Function 6: render(outLPtr: i32, outRPtr: i32, frames: i32) -> i32
const fnRender = (() => {
  const b = new FnBody([
    [5, T_I32], // 3: f, 4: ch, 5: vPtr, 6: instIdx, 7: macroPtr
    [6, T_F32], // 8: sr, 9: mixL, 10: mixR, 11: s, 12: pan, 13: tickAcc
    [3, T_I32], // 14: stepIdx, 15: len, 16: loop
  ]);
  const L_OUTL = 0, L_OUTR = 1, L_FRAMES = 2;
  const L_F = 3, L_CH = 4, L_VPTR = 5, L_INST = 6, L_MPTR = 7;
  const L_SR = 8, L_MIXL = 9, L_MIXR = 10, L_S = 11, L_PAN = 12, L_TICK = 13;
  const L_STEP = 14, L_LEN = 15, L_LOOP = 16;

  // Helper to compute stepIdx in L_STEP given L_MPTR and macroStep
  const emitStepIdx = () => {
    b.get(L_MPTR).loadI32(0).set(L_LEN);
    b.get(L_MPTR).loadI32(8).set(L_LOOP);
    b.get(L_MPTR).loadI32(4).tee(L_STEP).i32(1).op(OP.i32_lt_s).if_(VOID)
      .i32(1).set(L_STEP)
    .end();
    b.get(L_VPTR).loadI32(88).get(L_STEP).op(OP.i32_div_s).set(L_STEP);
    b.get(L_STEP).get(L_LEN).op(OP.i32_ge_s).if_(VOID);
      b.get(L_LOOP).i32(0).op(OP.i32_ge_s).get(L_LOOP).get(L_LEN).op(OP.i32_lt_s).op(OP.i32_and).if_(VOID);
        b.get(L_LOOP)
          .get(L_STEP).get(L_LOOP).op(OP.i32_sub)
          .get(L_LEN).get(L_LOOP).op(OP.i32_sub)
          .op(OP.i32_rem_s)
          .op(OP.i32_add).set(L_STEP);
      b.else_();
        b.get(L_LEN).i32(1).op(OP.i32_sub).set(L_STEP);
      b.end();
    b.end();
  };

  b.i32(ADDR_SAMPLE_RATE).loadF32(0).tee(L_SR).f32(8000.0).op(OP.f32_lt).if_(VOID)
    .f32(44100.0).set(L_SR)
  .end();

  b.i32(0).set(L_F);
  b.loop(VOID); // frame loop
    b.get(L_F).get(L_FRAMES).op(OP.i32_lt_s).if_(VOID);
      // 60Hz macro tick check
      b.i32(ADDR_TICK_ACCUM).loadF32(0).f32(1.0).op(OP.f32_add).tee(L_TICK);
      b.get(L_SR).f32(60.0).op(OP.f32_div).op(OP.f32_ge).if_(VOID);
        b.f32(0.0).set(L_TICK);
        // Step macros for all 48 active voices
        b.i32(0).set(L_CH);
        b.loop(VOID);
          b.get(L_CH).i32(48).op(OP.i32_lt_s).if_(VOID);
            b.i32(VOICE_BASE).get(L_CH).i32(VOICE_STRIDE).op(OP.i32_mul).op(OP.i32_add).set(L_VPTR);
            b.get(L_VPTR).loadI32(0).get(L_VPTR).loadI32(4).i32(5).op(OP.i32_ne).op(OP.i32_and).if_(VOID);
              b.get(L_VPTR).loadI32(8).i32(255).op(OP.i32_and).set(L_INST);
              // Increment macroStep
              b.get(L_VPTR).loadI32(88).i32(1).op(OP.i32_add).set(L_MPTR);
              b.get(L_VPTR).get(L_MPTR).storeI32(88);

              // Lane 0: Volume Macro -> macroVol = val / 127.0 (skipped on DPCM chipKind == 5 above)
              b.i32(MACRO_BASE).get(L_INST).i32(MACRO_INST_STRIDE).op(OP.i32_mul).op(OP.i32_add).set(L_MPTR);
              b.get(L_MPTR).loadI32(0).i32(0).op(OP.i32_gt_s).if_(VOID);
                emitStepIdx();
                b.get(L_STEP).i32(2).op(OP.i32_shl).get(L_MPTR).op(OP.i32_add).loadI32(20)
                  .op(OP.f32_convert_i32_s).f32(127.0).op(OP.f32_div)
                  .f32(0.0).op(OP.f32_max).f32(1.0).op(OP.f32_min)
                  .set(L_S);
                b.get(L_VPTR).get(L_S).storeF32(104);
              b.end();

              // Lane 1: Arpeggio Macro (mode 0 = Relative, mode 1 = Fixed MIDI) — tonal channels only & skipped when skipWasmArp (+164) != 0
              b.i32(MACRO_BASE + MACRO_LANE_STRIDE).get(L_INST).i32(MACRO_INST_STRIDE).op(OP.i32_mul).op(OP.i32_add).set(L_MPTR);
              b.get(L_MPTR).loadI32(0).i32(0).op(OP.i32_gt_s)
                .get(L_VPTR).loadI32(4).i32(4).op(OP.i32_ne).op(OP.i32_and)
                .get(L_VPTR).loadI32(164).op(OP.i32_eqz).op(OP.i32_and)
                .if_(VOID);
                emitStepIdx();
                b.get(L_STEP).i32(2).op(OP.i32_shl).get(L_MPTR).op(OP.i32_add).loadI32(20).set(L_LEN); // val
                b.get(L_MPTR).loadI32(16).i32(1).op(OP.i32_eq).if_(T_F32);
                  b.get(L_VPTR).loadF32(160).tee(L_S).f32(0.01).op(OP.f32_le).if_(VOID).f32(1.0).set(L_S).end();
                  b.get(L_LEN).i32(69).op(OP.i32_sub).call(1).f32(440.0).op(OP.f32_mul).get(L_S).op(OP.f32_mul);
                b.else_();
                  b.get(L_LEN).call(1).get(L_VPTR).loadF32(16).op(OP.f32_mul);
                b.end();
                b.set(L_S);
                b.get(L_VPTR).get(L_S).storeF32(20);
              b.end();

              // Lane 2: Duty / Noise Mode Macro
              b.i32(MACRO_BASE + MACRO_LANE_STRIDE * 2).get(L_INST).i32(MACRO_INST_STRIDE).op(OP.i32_mul).op(OP.i32_add).set(L_MPTR);
              b.get(L_MPTR).loadI32(0).i32(0).op(OP.i32_gt_s).if_(VOID);
                emitStepIdx();
                b.get(L_VPTR)
                  .get(L_STEP).i32(2).op(OP.i32_shl).get(L_MPTR).op(OP.i32_add).loadI32(20)
                  .storeI32(36);
              b.end();

              // Lane 3: Exponential Pitch Macro via ADDR_MACRO_PITCH_SCALE (never clobbering +100; skipped when mode == 2 or skipWasmArp != 0)
              b.i32(MACRO_BASE + MACRO_LANE_STRIDE * 3).get(L_INST).i32(MACRO_INST_STRIDE).op(OP.i32_mul).op(OP.i32_add).set(L_MPTR);
              b.get(L_MPTR).loadI32(0).i32(0).op(OP.i32_gt_s)
                .get(L_MPTR).loadI32(16).i32(2).op(OP.i32_ne).op(OP.i32_and)
                .get(L_VPTR).loadI32(164).op(OP.i32_eqz).op(OP.i32_and)
                .if_(VOID);
                emitStepIdx();
                b.get(L_STEP).i32(2).op(OP.i32_shl).get(L_MPTR).op(OP.i32_add).loadI32(20)
                  .i32(256).op(OP.i32_add).set(L_LEN);
                b.get(L_LEN).i32(0).op(OP.i32_lt_s).if_(VOID).i32(0).set(L_LEN).end();
                b.get(L_LEN).i32(511).op(OP.i32_gt_s).if_(VOID).i32(511).set(L_LEN).end();
                b.get(L_LEN).i32(2).op(OP.i32_shl).loadF32(ADDR_MACRO_PITCH_SCALE).set(L_S);
                b.get(L_VPTR).get(L_S).storeF32(148);
              b.end();
            b.end();
            b.get(L_CH).i32(1).op(OP.i32_add).set(L_CH);
            b.br(1);
          b.end();
        b.end();
      b.end();
      b.i32(ADDR_TICK_ACCUM).get(L_TICK).storeF32(0);

      b.f32(0.0).set(L_MIXL);
      b.f32(0.0).set(L_MIXR);
      b.i32(0).set(L_CH);
      b.loop(VOID);
        b.get(L_CH).i32(48).op(OP.i32_lt_s).if_(VOID);
          b.i32(VOICE_BASE).get(L_CH).i32(VOICE_STRIDE).op(OP.i32_mul).op(OP.i32_add).set(L_VPTR);
          b.get(L_VPTR).get(L_SR).call(2).set(L_S); // render_voice_sample
          b.get(L_VPTR).loadF32(32).set(L_PAN); // -1..1
          b.get(L_MIXL).get(L_S).f32(1.0).get(L_PAN).op(OP.f32_sub).f32(0.5).op(OP.f32_mul).op(OP.f32_mul).op(OP.f32_add).set(L_MIXL);
          b.get(L_MIXR).get(L_S).f32(1.0).get(L_PAN).op(OP.f32_add).f32(0.5).op(OP.f32_mul).op(OP.f32_mul).op(OP.f32_add).set(L_MIXR);
          b.get(L_CH).i32(1).op(OP.i32_add).set(L_CH);
          b.br(1);
        b.end();
      b.end();

      // Scale master mix & soft-clamp [-0.98..0.98]
      b.get(L_OUTL).get(L_F).i32(2).op(OP.i32_shl).op(OP.i32_add)
        .get(L_MIXL).f32(0.52).op(OP.f32_mul).f32(-0.98).op(OP.f32_max).f32(0.98).op(OP.f32_min)
        .storeF32(0);
      b.get(L_OUTR).get(L_F).i32(2).op(OP.i32_shl).op(OP.i32_add)
        .get(L_MIXR).f32(0.52).op(OP.f32_mul).f32(-0.98).op(OP.f32_max).f32(0.98).op(OP.f32_min)
        .storeF32(0);

      b.get(L_F).i32(1).op(OP.i32_add).set(L_F);
      b.br(1);
    b.end();
  b.end();
  b.get(L_FRAMES);
  return b;
})();

// Function 7: get_channel_scope(ch: i32, outPtr: i32, frames: i32) -> i32
const fnGetScope = (() => {
  const b = new FnBody([[3, T_I32]]); // 3: i, 4: base, 5: rIdx
  b.get(0).i32(0).op(OP.i32_lt_s).get(0).i32(47).op(OP.i32_gt_s).op(OP.i32_or).if_(VOID)
    .i32(0).op(OP.return)
  .end();
  b.i32(SCOPE_BASE).get(0).i32(4096).op(OP.i32_mul).op(OP.i32_add).set(4);
  b.i32(VOICE_BASE).get(0).i32(VOICE_STRIDE).op(OP.i32_mul).op(OP.i32_add).loadI32(140)
    .get(2).op(OP.i32_sub).set(5);
  b.i32(0).set(3);
  b.loop(VOID);
    b.get(3).get(2).op(OP.i32_lt_s).if_(VOID);
      b.get(1).get(3).i32(2).op(OP.i32_shl).op(OP.i32_add);
      b.get(4).get(5).get(3).op(OP.i32_add).i32(1023).op(OP.i32_and).i32(2).op(OP.i32_shl).op(OP.i32_add).loadF32(0);
      b.storeF32(0);
      b.get(3).i32(1).op(OP.i32_add).set(3);
      b.br(1);
    b.end();
  b.end();
  b.get(2);
  return b;
})();

// Function 8: note_off(ch: i32)
const fnNoteOff = (() => {
  const b = new FnBody();
  b.get(0).i32(0).op(OP.i32_ge_s).get(0).i32(48).op(OP.i32_lt_s).op(OP.i32_and).if_(VOID);
    b.i32(VOICE_BASE).get(0).i32(VOICE_STRIDE).op(OP.i32_mul).op(OP.i32_add)
      .i32(1).storeI32(144); // released = 1
  b.end();
  return b;
})();

// Function 9: stop_all()
const fnStopAll = (() => {
  const b = new FnBody([[1, T_I32]]);
  b.i32(0).set(0);
  b.loop(VOID);
    b.get(0).i32(48).op(OP.i32_lt_s).if_(VOID);
      b.i32(VOICE_BASE).get(0).i32(VOICE_STRIDE).op(OP.i32_mul).op(OP.i32_add)
        .i32(0).storeI32(0);
      b.get(0).i32(1).op(OP.i32_add).set(0);
      b.br(1);
    b.end();
  b.end();
  return b;
})();

// Build Data Segments (SINE_LUT, NES_TRI_LUT, PITCH_SCALE_LUT, initial heapPtr)
const sineData = new Uint8Array(4096 * 4);
const sineView = new DataView(sineData.buffer);
for (let i = 0; i < 4096; i++) {
  sineView.setFloat32(i * 4, Math.sin((i / 4096) * Math.PI * 2), true);
}

const triData = new Uint8Array(32 * 4);
const triView = new DataView(triData.buffer);
for (let i = 0; i < 32; i++) {
  const step = i < 16 ? 15 - i : i - 16; // 15..0..0..15
  triView.setFloat32(i * 4, (step / 7.5) - 1.0, true);
}

const pitchData = new Uint8Array(256 * 4);
const pitchView = new DataView(pitchData.buffer);
for (let i = 0; i < 256; i++) {
  const semi = i - 128;
  pitchView.setFloat32(i * 4, Math.pow(2, semi / 12), true);
}

const macroPitchData = new Uint8Array(512 * 4);
const macroPitchView = new DataView(macroPitchData.buffer);
for (let i = 0; i < 512; i++) {
  const offset = i - 256;
  macroPitchView.setFloat32(i * 4, Math.pow(2, offset / 192), true);
}

const heapInitData = new Uint8Array(16);
const heapInitView = new DataView(heapInitData.buffer);
heapInitView.setFloat32(0, 44100.0, true);
heapInitView.setInt32(12, HEAP_START, true);

function dataSegment(offset, bytes) {
  return [0x00, OP.i32_const, ...sleb(offset), OP.end, ...uleb(bytes.length), ...bytes];
}

// Assemble Sections
const typePayload = [...uleb(types.length)];
for (const [params, res] of types) {
  typePayload.push(0x60, ...uleb(params.length), ...params, ...uleb(res.length), ...res);
}

const fnPayload = [...uleb(fnTypes.length), ...fnTypes.map((t) => uleb(t)).flat()];

// Memory: initial 256 pages (16MB), max 2048 pages (128MB)
const memPayload = [0x01, 0x01, ...uleb(256), ...uleb(2048)];

const exportsList = [
  ['memory', 0x02, 0],
  ['init', 0x00, 3],
  ['allocate', 0x00, 4],
  ['deallocate', 0x00, 5],
  ['render', 0x00, 6],
  ['get_channel_scope', 0x00, 7],
  ['note_off', 0x00, 8],
  ['stop_all', 0x00, 9],
];
const exportPayload = [...uleb(exportsList.length)];
for (const [name, kind, idx] of exportsList) {
  exportPayload.push(...strBytes(name), kind, ...uleb(idx));
}

const bodies = [fnSinLut, fnPow2Semi, fnRenderVoice, fnInit, fnAllocate, fnDeallocate, fnRender, fnGetScope, fnNoteOff, fnStopAll];
const codePayload = [...uleb(bodies.length), ...bodies.flatMap((b) => b.encode())];

const segs = [
  dataSegment(0x0000, heapInitData),
  dataSegment(ADDR_SINE_LUT, sineData),
  dataSegment(ADDR_TRI_LUT, triData),
  dataSegment(ADDR_PITCH_SCALE, pitchData),
  dataSegment(ADDR_MACRO_PITCH_SCALE, macroPitchData),
];
const dataPayload = [...uleb(segs.length), ...segs.flat()];

const wasmBytes = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, // \0asm
  0x01, 0x00, 0x00, 0x00, // v1
  ...section(1, typePayload),
  ...section(3, fnPayload),
  ...section(5, memPayload),
  ...section(7, exportPayload),
  ...section(10, codePayload),
  ...section(11, dataPayload),
]);

try {
  await WebAssembly.compile(wasmBytes);
} catch (err) {
  console.error('WASM validation failed:', err);
  throw err;
}

const outDir = path.resolve(process.cwd(), 'public/wasm');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'aria_furnace_all.wasm');
fs.writeFileSync(outPath, wasmBytes);
console.log(`Built verified WASM binary: ${outPath} (${wasmBytes.length} bytes)`);
