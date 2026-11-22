/**
 * public/audio/nes-worklet.js
 * Aria48 Tracker — Bitphase NES APU (nes_apu.wasm) & Dn-FamiTracker AudioWorkletProcessor
 *
 * Runs on the Web Audio rendering thread:
 * - Instantiates paator/bitphase `public/nes/nes_apu.wasm` when provided.
 * - Executes frame-accurate 60Hz/50Hz FamiTracker / 0CC / Dn-FamiTracker sequencer ticks
 *   with hardware 2A03 registers ($4000-$4017), DPCM keymaps, and expansion synthesis
 *   (VRC6, VRC7 OPLL FM, FDS wavetable+LFO, MMC5, N163 wavetable RAM, Sunsoft 5B tone+noise).
 * - Executes all 5 FamiTracker macro sequences (Volume, Arpeggio [abs/fixed/rel/scheme],
 *   Pitch, Hi-Pitch, Duty/Noise) with loopPoint & releasePoint at true tick-0 precision.
 * - Supports interactive `previewNote` auditioning across all octaves (C-0..B-7) and chips.
 */

const BASE_A4 = 440.0;
const CPU_NTSC = 1789773;
const CPU_PAL = 1662607;
const DUTY_THRESHOLDS = [0.125, 0.25, 0.5, 0.75];
const TRIANGLE_TABLE = [
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];
const NOISE_PERIODS_NTSC = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const NOISE_PERIODS_PAL = [4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778];
const DMC_PERIODS_NTSC = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
const DMC_PERIODS_PAL = [398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50];

// VRC7 (YM2413 / OPLL subset) 15 built-in ROM patch approximations [modMult, carMult, modIndex, fb, modDecay, carSus]
const VRC7_ROM_PATCHES = [
  [1, 1, 1.4, 0.15, 0.04, 0.85], // 0: Custom fallback
  [1, 3, 2.2, 0.35, 0.09, 0.45], // 1: Buzzy Bell
  [2, 1, 1.8, 0.25, 0.06, 0.65], // 2: Guitar
  [1, 1, 1.6, 0.10, 0.05, 0.72], // 3: Piano / E-Piano
  [1, 1, 0.55, 0.0, 0.02, 0.95], // 4: Flute
  [1, 2, 1.2, 0.15, 0.03, 0.92], // 5: Clarinet
  [1, 3, 1.4, 0.20, 0.04, 0.90], // 6: Oboe
  [1, 1, 2.4, 0.45, 0.03, 0.92], // 7: Trumpet / Brass
  [2, 1, 1.1, 0.10, 0.01, 0.96], // 8: Organ
  [1, 1, 1.5, 0.30, 0.03, 0.92], // 9: Horn
  [2, 1, 2.5, 0.55, 0.04, 0.88], // 10: Synth
  [1, 4, 2.1, 0.30, 0.08, 0.45], // 11: Harpsichord
  [1, 2, 1.0, 0.05, 0.08, 0.50], // 12: Vibraphone
  [1, 0.5, 2.2, 0.40, 0.07, 0.80], // 13: Synth Bass
  [1, 0.5, 1.6, 0.25, 0.12, 0.42], // 14: Wood Bass
  [2, 0.5, 2.0, 0.35, 0.06, 0.68], // 15: Electric Bass
];

const OPLL_MULT_TABLE = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];

function ftNoteToFreq(noteId, semiOffset = 0, pitchFine = 0, freqMult = 1.0) {
  if (!noteId || noteId <= 0 || noteId >= 97) return 0;
  // noteId 1 = C-0 (MIDI 12), noteId 49 = C-4 (MIDI 60), noteId 58 = A-4 (MIDI 69)
  const midi = noteId + 11;
  const fineSemi = pitchFine / 16.0;
  return (
    BASE_A4 *
    Math.pow(2, (midi + semiOffset + fineSemi - 69) / 12) *
    Math.max(0.125, Math.min(8.0, freqMult))
  );
}

function createChannelState(index, desc, prevMuted = false, prevSolo = false, scopeLen = 256) {
  return {
    index,
    chip: desc.chip,
    subChannel: desc.subChannel,
    name: desc.name,
    muted: prevMuted,
    solo: prevSolo,
    activeNoteId: 0,
    noteName: '---',
    instIdx: -1,
    baseFreq: 0,
    curFreq: 0,
    periodOffset: 0, // hardware period units (+/- from baseFreq)
    phase: 0,
    modPhase: 0,
    fdsModPhase: 0,
    duty: desc.chip === 'VRC6' ? 3 : 2,
    noiseShort: false,
    s5bToneEn: true,
    s5bNoiseEn: false,
    s5bNoisePeriod: 15,
    vol: 15,
    envVol: 15,
    arpX: 0,
    arpY: 0,
    arpTick: 0,
    macroArpSemis: 0,
    macroFixedNote: -1,
    arpRelAccum: 0,
    macroPitchAccum: 0,
    slideSpeed: 0, // period units per tick (- = pitch up, + = pitch down)
    vibSpeed: 0,
    vibDepth: 0,
    vibPhase: 0,
    tremSpeed: 0,
    tremDepth: 0,
    tremPhase: 0,
    volSlide: 0,
    targetVol: -1,
    targetVolSpeed: 0,
    freqMult: 1.0,
    pitchFine: 0,
    seqTick: 0,
    seqPos: [0, 0, 0, 0, 0],
    seqEnded: [false, false, false, false, false],
    released: false,
    gate: false,
    cutTicks: -1,
    releaseDelayTicks: -1,
    noteDelayTicks: -1,
    delayedCell: null,
    portaSpeed: 0,
    portaTargetNoteId: 0,
    portaTargetFreq: 0,
    noteSlideDir: 0,
    noteSlideSpeed: 0,
    noteSlideSemis: 0,
    noteSlideAccum: 0,
    vrc7PatchOverride: -1,
    fmEnvLevel: 1.0,
    fmModLevel: 1.0,
    n163WaveIdx: 0,
    dpcmSampleIdx: -1,
    dpcmPos: 0,
    dpcmAcc: 64,
    dpcmHpPrev: 0,
    dpcmHpOut: 0,
    dpcmRate: 15,
    dpcmLoop: false,
    level: 0,
    scope: new Float32Array(scopeLen),
    scopeWrite: 0,
  };
}

class AriaNesWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasmInstance = null;
    this.wasmExports = null;
    this.wasmOutL = 0;
    this.wasmOutR = 0;

    this.module = null;
    this.activeSongIndex = 0;
    this.isPlaying = false;
    this.isPaused = false;
    this.currentOrder = 0;
    this.currentRow = 0;
    this.tickCounter = 0;
    this.tickSamplesAccum = 0;
    this.elapsedSamples = 0;
    this.telemetryAccum = 0;
    this.previewTickAccum = 0;

    this.pendingJumpOrder = -1;
    this.pendingSkipRow = -1;
    this.pendingHalt = false;

    this.speed = 6;
    this.tempo = 150;
    this.bpmScale = 1.0;
    this.machine = 'NTSC';
    this.chState = [];
    this.previewVoices = [];
    this.lfsr = 1;
    this.noisePhase = 0;
    this.s5bLfsr = 1;
    this.s5bNoisePhase = 0;
    this.scopeSnapshotLen = 256;

    this.port.onmessage = (ev) => this.handleMessage(ev.data);
  }

  getCpuHz() {
    return this.machine === 'PAL' ? CPU_PAL : CPU_NTSC;
  }

  normalizeChipTag(rawChip, channelIdx) {
    const c = (rawChip || '').toLowerCase();
    if (c.includes('vrc6')) return { chip: 'VRC6', subChannel: channelIdx % 3 };
    if (c.includes('vrc7')) return { chip: 'VRC7', subChannel: channelIdx % 6 };
    if (c.includes('fds')) return { chip: 'FDS', subChannel: 0 };
    if (c.includes('mmc5')) return { chip: 'MMC5', subChannel: channelIdx % 2 };
    if (c.includes('n163') || c.includes('namco')) return { chip: 'N163', subChannel: channelIdx % 8 };
    if (c.includes('sunsoft') || c.includes('5b')) return { chip: 'Sunsoft 5B', subChannel: channelIdx % 3 };
    return { chip: '2A03', subChannel: channelIdx % 5 };
  }

  handleMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'loadWasm' && msg.buffer) {
      this.initWasm(msg.buffer);
    } else if (msg.type === 'loadModule' && msg.module) {
      this.module = msg.module;
      this.activeSongIndex = Math.max(0, Math.min((this.module.songs?.length || 1) - 1, msg.songIndex || 0));
      this.machine = this.module.machine || 'NTSC';
      this.bpmScale = 1.0;
      this.resetPlaybackState(false);
    } else if (msg.type === 'play') {
      if (this.module) {
        this.isPlaying = true;
        this.isPaused = false;
        if (this.currentOrder === 0 && this.currentRow === 0 && this.tickCounter === 0) {
          this.triggerCurrentRow();
        }
      }
    } else if (msg.type === 'pause') {
      this.isPlaying = false;
      this.isPaused = true;
    } else if (msg.type === 'stop') {
      this.isPlaying = false;
      this.isPaused = false;
      this.previewVoices = [];
      this.resetPlaybackState(false);
    } else if (msg.type === 'seek') {
      this.seekTo(msg.order || 0, msg.row || 0);
    } else if (msg.type === 'setSubsong') {
      if (this.module && this.module.songs && this.module.songs[msg.index]) {
        this.activeSongIndex = msg.index;
        this.bpmScale = 1.0;
        this.resetPlaybackState(this.isPlaying);
      }
    } else if (msg.type === 'setMachine') {
      this.machine = msg.machine || 'NTSC';
    } else if (msg.type === 'setBpmScale') {
      const nextScale = Number(msg.scale);
      if (Number.isFinite(nextScale) && nextScale > 0) {
        this.bpmScale = Math.max(0.2, Math.min(4.0, nextScale));
      }
    } else if (msg.type === 'setMuteSolo') {
      const mutes = msg.mutes || [];
      const solos = msg.solos || [];
      for (let i = 0; i < this.chState.length; i++) {
        this.chState[i].muted = Boolean(mutes[i]);
        this.chState[i].solo = Boolean(solos[i]);
      }
    } else if (msg.type === 'previewNote') {
      this.triggerPreviewVoice(msg);
    } else if (msg.type === 'stopPreviewChannel') {
      const idx = msg.channelIndex | 0;
      this.previewVoices = this.previewVoices.filter((v) => v.channelIndex !== idx);
    }
  }

  triggerPreviewVoice(msg) {
    const midiNote = Math.max(12, Math.min(107, (msg.midiNote | 0) || 60));
    const noteId = Math.max(1, Math.min(96, midiNote - 11));
    const chIdx = Math.max(0, (msg.channelIndex | 0) || 0);
    const vel = Math.max(1, Math.min(127, msg.velocity ?? 100));
    const vol = Math.max(1, Math.min(15, Math.round((vel / 127) * 15)));
    const durationSamples = Math.max(1200, Math.round(((msg.durationSec || 0.25) * sampleRate)));

    const existingCh = this.chState[chIdx];
    const normalized = existingCh
      ? { chip: existingCh.chip, subChannel: existingCh.subChannel, name: existingCh.name }
      : { ...this.normalizeChipTag(msg.chip, chIdx), name: `CH ${chIdx + 1}` };

    const voice = createChannelState(chIdx, normalized, false, false, this.scopeSnapshotLen);
    voice.isPreview = true;
    voice.channelIndex = chIdx;
    voice.remainingSamples = durationSamples;
    voice.vol = vol;
    voice.gate = true;
    voice.activeNoteId = noteId;
    voice.baseFreq = ftNoteToFreq(noteId, 0, 0, 1.0);
    voice.curFreq = voice.baseFreq;

    if (msg.instrument >= 0) {
      voice.instIdx = msg.instrument;
    } else if (existingCh && existingCh.instIdx >= 0) {
      voice.instIdx = existingCh.instIdx;
    } else if (this.module && Array.isArray(this.module.instruments)) {
      const chipMatch = this.module.instruments.find((ins) => ins.chip === normalized.chip);
      if (chipMatch) voice.instIdx = chipMatch.index;
    }

    if (voice.chip === '2A03' && voice.subChannel === 4) {
      this.triggerDpcmOnState(voice, noteId);
    }

    this.evaluateMacrosForChannel(voice, false);
    // Replace prior preview on same channel so repeated clicks don't clip
    this.previewVoices = this.previewVoices.filter((v) => v.channelIndex !== chIdx);
    this.previewVoices.push(voice);
    if (this.previewVoices.length > 16) this.previewVoices.shift();
  }

  async initWasm(arrayBuffer) {
    try {
      const imports = {
        env: {
          memory: new WebAssembly.Memory({ initial: 256, maximum: 512 }),
          emscripten_notify_memory_growth: () => {},
          abort: () => {},
        },
        wasi_snapshot_preview1: {
          proc_exit: () => {},
          fd_write: () => 0,
        },
      };
      const result = await WebAssembly.instantiate(arrayBuffer, imports);
      const ex = result.instance.exports;
      this.wasmInstance = result.instance;
      this.wasmExports = ex;
      if (typeof ex._nes_init === 'function') {
        const mode = this.machine === 'PAL' ? 1 : this.machine === 'Dendy' ? 2 : 0;
        const mask = this.module ? (this.module.expansionMask || 0) : 0;
        ex._nes_init(sampleRate, mode, mask);
      }
      if (typeof ex._malloc === 'function') {
        this.wasmOutL = ex._malloc(128 * 4);
        this.wasmOutR = ex._malloc(128 * 4);
      }
      this.port.postMessage({ type: 'wasmStatus', loaded: true, source: 'public/nes/nes_apu.wasm' });
    } catch (err) {
      this.wasmInstance = null;
      this.wasmExports = null;
      this.port.postMessage({
        type: 'wasmStatus',
        loaded: false,
        error: err && err.message ? err.message : 'WASM instantiation error',
      });
    }
  }

  resetPlaybackState(triggerRow0) {
    const song = this.getActiveSong();
    this.speed = song ? Math.max(1, song.speed || 6) : 6;
    this.tempo = song ? Math.max(30, song.tempo || 150) : 150;
    this.currentOrder = 0;
    this.currentRow = 0;
    this.tickCounter = 0;
    this.tickSamplesAccum = 0;
    this.elapsedSamples = 0;
    this.pendingJumpOrder = -1;
    this.pendingSkipRow = -1;
    this.pendingHalt = false;

    const descList = (this.module && this.module.channels) || [];
    const prevMutes = this.chState.map((c) => c.muted);
    const prevSolos = this.chState.map((c) => c.solo);

    this.chState = descList.map((d, idx) =>
      createChannelState(idx, d, Boolean(prevMutes[idx]), Boolean(prevSolos[idx]), this.scopeSnapshotLen)
    );

    if (this.wasmExports && typeof this.wasmExports._nes_reset === 'function') {
      try {
        this.wasmExports._nes_reset();
      } catch {}
    }

    if (triggerRow0 && this.isPlaying) {
      this.triggerCurrentRow();
    }
    this.emitTelemetry(true);
  }

  getActiveSong() {
    if (!this.module || !this.module.songs || this.module.songs.length === 0) return null;
    return this.module.songs[this.activeSongIndex] || this.module.songs[0];
  }

  seekTo(orderIdx, rowIdx) {
    const song = this.getActiveSong();
    if (!song) return;
    const maxOrders = Math.max(1, song.frameList.length);
    const maxRows = Math.max(1, song.rowsPerPattern || 64);
    this.currentOrder = Math.max(0, Math.min(maxOrders - 1, orderIdx | 0));
    this.currentRow = Math.max(0, Math.min(maxRows - 1, rowIdx | 0));
    this.tickCounter = 0;
    this.tickSamplesAccum = 0;
    this.pendingJumpOrder = -1;
    this.pendingSkipRow = -1;
    this.pendingHalt = false;
    const rowsPerSec = ((this.machine === 'PAL' ? 50 : 60) * (this.tempo / 150)) / Math.max(1, this.speed);
    this.elapsedSamples = Math.round(((this.currentOrder * maxRows + this.currentRow) / rowsPerSec) * sampleRate);
    for (let i = 0; i < this.chState.length; i++) {
      this.chState[i].gate = false;
      this.chState[i].delayedCell = null;
      this.chState[i].noteDelayTicks = -1;
    }
    if (this.isPlaying) this.triggerCurrentRow();
    this.emitTelemetry(true);
  }

  getInstrumentForChannel(st) {
    if (!this.module || !this.module.instruments || st.instIdx < 0) return null;
    return (
      this.module.instruments.find((ins) => ins.index === st.instIdx && ins.chip === st.chip) ||
      this.module.instruments.find((ins) => ins.index === st.instIdx) ||
      null
    );
  }

  triggerDpcmOnState(st, noteId) {
    const samples = (this.module && this.module.dpcmSamples) || [];
    if (samples.length === 0) {
      st.dpcmSampleIdx = -1;
      return;
    }
    const keyIdx = Math.max(0, Math.min(95, noteId - 1));
    let inst = this.getInstrumentForChannel(st);

    // If channel has no explicit instrument yet, locate any 2A03 instrument mapping this DPCM key
    if ((!inst || !Array.isArray(inst.dpcmMap) || !inst.dpcmMap[keyIdx] || inst.dpcmMap[keyIdx].sampleIndex < 0) && this.module?.instruments) {
      const fallbackDpcmInst = this.module.instruments.find(
        (ins) => Array.isArray(ins.dpcmMap) && ins.dpcmMap[keyIdx] && ins.dpcmMap[keyIdx].sampleIndex >= 0
      );
      if (fallbackDpcmInst) {
        inst = fallbackDpcmInst;
        if (st.instIdx < 0) st.instIdx = fallbackDpcmInst.index;
      }
    }

    if (inst && Array.isArray(inst.dpcmMap) && inst.dpcmMap.length > keyIdx) {
      const mapping = inst.dpcmMap[keyIdx];
      if (mapping && mapping.sampleIndex >= 0) {
        const byId = samples.findIndex((s) => s.index === mapping.sampleIndex);
        st.dpcmSampleIdx = byId >= 0 ? byId : (mapping.sampleIndex < samples.length ? mapping.sampleIndex : 0);
        st.dpcmRate = mapping.pitch & 0x0f;
        st.dpcmLoop = Boolean(mapping.loop);
        st.dpcmPos = 0;
        st.dpcmAcc = mapping.deltaCounter >= 0 ? mapping.deltaCounter & 0x7f : 64;
        st.dpcmHpPrev = (st.dpcmAcc - 64) / 64;
        st.dpcmHpOut = 0;
        st.gate = true;
        st.envVol = 15;
        return;
      }
      // If instrument explicitly has a DPCM keymap and this key isn't mapped, fall back safely only during manual preview
      const anyMapped = inst.dpcmMap.some((m) => m && m.sampleIndex >= 0);
      if (anyMapped && !st.isPreview) {
        st.dpcmSampleIdx = -1;
        return;
      }
    }
    st.dpcmSampleIdx = keyIdx % samples.length;
    st.dpcmRate = 15;
    st.dpcmLoop = false;
    st.dpcmPos = 0;
    st.dpcmAcc = 64;
    st.dpcmHpPrev = 0;
    st.dpcmHpOut = 0;
    st.gate = true;
    st.envVol = 15;
  }

  stepSequencerTick() {
    const song = this.getActiveSong();
    if (!song) return;

    this.tickCounter++;
    if (this.tickCounter >= this.speed) {
      this.tickCounter = 0;
      const maxRows = Math.max(1, song.rowsPerPattern || 64);

      if (this.pendingHalt) {
        this.pendingHalt = false;
        this.isPlaying = false;
        this.isPaused = false;
        for (let i = 0; i < this.chState.length; i++) this.chState[i].gate = false;
        this.pushRegistersToWasm();
        this.emitTelemetry(true);
        return;
      } else if (this.pendingJumpOrder >= 0) {
        this.currentOrder = Math.max(0, Math.min((song.frameList.length || 1) - 1, this.pendingJumpOrder));
        this.currentRow = 0;
        this.pendingJumpOrder = -1;
      } else if (this.pendingSkipRow >= 0) {
        this.currentOrder = (this.currentOrder + 1) % Math.max(1, song.frameList.length);
        this.currentRow = Math.min(maxRows - 1, this.pendingSkipRow);
        this.pendingSkipRow = -1;
      } else {
        this.currentRow++;
        if (this.currentRow >= maxRows) {
          this.currentRow = 0;
          this.currentOrder = (this.currentOrder + 1) % Math.max(1, song.frameList.length);
        }
      }

      // Tick 0 executes triggerCurrentRow ONLY (do NOT skip seq.items[0] by calling applyTickModulation here)
      this.triggerCurrentRow();
    } else {
      // Ticks 1..speed-1 advance macros, envelopes, slides, vibrato, and delayed Gxx notes
      this.applyTickModulation();
    }
  }

  applyCellTrigger(st, cell) {
    if (cell.volume >= 0) {
      st.vol = Math.max(0, Math.min(15, cell.volume));
    }
    if (cell.instrument >= 0) {
      st.instIdx = cell.instrument;
      st.vrc7PatchOverride = -1;
    }

    if (cell.note === 97) {
      // === Note Cut: immediate silence & clear pitch slides
      st.gate = false;
      st.activeNoteId = 0;
      st.noteName = cell.noteName;
      st.periodOffset = 0;
      st.macroPitchAccum = 0;
      st.macroFixedNote = -1;
      st.macroArpSemis = 0;
      st.slideSpeed = 0;
      st.portaSpeed = 0;
      st.noteSlideDir = 0;
    } else if (cell.note === 98) {
      // OFF / Release: jump sequences to releasePoint (if available)
      st.released = true;
      st.noteName = cell.noteName;
      this.jumpSequencesToRelease(st);
    } else if (cell.note > 0 && cell.note < 97) {
      const nextFreq = ftNoteToFreq(cell.note, 0, st.pitchFine, st.freqMult);
      const hasPorta3 =
        (cell.effects && cell.effects.some((e) => e.code === '3' && e.param > 0)) ||
        st.portaSpeed > 0;

      st.activeNoteId = cell.note;
      st.noteName = cell.noteName;
      if (hasPorta3 && st.baseFreq > 0 && st.gate) {
        st.portaTargetNoteId = cell.note;
        st.portaTargetFreq = nextFreq;
      } else {
        st.baseFreq = nextFreq;
        st.curFreq = nextFreq;
        st.portaTargetNoteId = 0;
        st.portaTargetFreq = 0;
        st.periodOffset = 0;
      }
      st.gate = true;
      st.released = false;
      st.seqTick = 0;
      st.seqPos = [0, 0, 0, 0, 0];
      st.seqEnded = [false, false, false, false, false];
      st.arpRelAccum = 0;
      st.macroPitchAccum = 0;
      st.macroArpSemis = 0;
      st.macroFixedNote = -1;
      st.cutTicks = -1;
      st.releaseDelayTicks = -1;
      st.fmEnvLevel = 1.0;
      st.fmModLevel = 1.0;
      st.noteSlideDir = 0;
      st.noteSlideAccum = 0;

      if (st.chip === '2A03' && st.subChannel === 4) {
        this.triggerDpcmOnState(st, cell.note);
      }
    }

    // Parse all pattern effects on this cell
    if (cell.effects && cell.effects.length > 0) {
      for (const fx of cell.effects) {
        const cmd = fx.code;
        const val = fx.param & 0xff;
        const x = (val >> 4) & 0x0f;
        const y = val & 0x0f;
        if (cmd === 'F') {
          if (val > 0 && val < 32) this.speed = val;
          else if (val >= 32) this.tempo = val;
        } else if (cmd === 'B') {
          this.pendingJumpOrder = val;
        } else if (cmd === 'C') {
          this.pendingHalt = true;
        } else if (cmd === 'D') {
          this.pendingSkipRow = val;
        } else if (cmd === '0') {
          st.arpX = x;
          st.arpY = y;
          st.arpTick = 0;
        } else if (cmd === '1') {
          // Hardware pitch slide up (decrease period) - mutually exclusive with 3xx/Qxy/Rxy
          st.slideSpeed = val === 0 ? 0 : -val;
          st.portaSpeed = 0;
          st.noteSlideDir = 0;
        } else if (cmd === '2') {
          // Hardware pitch slide down (increase period) - mutually exclusive with 3xx/Qxy/Rxy
          st.slideSpeed = val === 0 ? 0 : val;
          st.portaSpeed = 0;
          st.noteSlideDir = 0;
        } else if (cmd === '3') {
          st.portaSpeed = val;
          st.slideSpeed = 0;
          st.noteSlideDir = 0;
          if (cell.note > 0 && cell.note < 97 && st.baseFreq > 0) {
            st.portaTargetFreq = ftNoteToFreq(cell.note, 0, st.pitchFine, st.freqMult);
          }
        } else if (cmd === '4') {
          st.vibSpeed = x;
          st.vibDepth = y;
        } else if (cmd === '7') {
          st.tremSpeed = x;
          st.tremDepth = y;
        } else if (cmd === 'A') {
          st.volSlide = (x - y) * 0.18;
        } else if (cmd === 'E') {
          st.vol = Math.max(0, Math.min(15, Math.round((val / 255) * 15)));
        } else if (cmd === 'S') {
          st.cutTicks = val;
          if (val === 0) st.gate = false;
        } else if (cmd === 'L') {
          st.releaseDelayTicks = val;
          if (val === 0) {
            st.released = true;
            this.jumpSequencesToRelease(st);
          }
        } else if (cmd === 'V') {
          st.duty = val & 7;
          st.noiseShort = (val & 1) === 1;
          if (st.chip === 'VRC7') st.vrc7PatchOverride = val & 0x0f;
        } else if (cmd === 'P') {
          st.pitchFine = val - 0x80;
          if (st.activeNoteId > 0) {
            st.baseFreq = ftNoteToFreq(st.activeNoteId, 0, st.pitchFine, st.freqMult);
          }
        } else if (cmd === 'Q' || cmd === 'R') {
          st.noteSlideDir = cmd === 'Q' ? 1 : -1;
          st.noteSlideSpeed = Math.max(1, x);
          st.noteSlideSemis = y;
          st.noteSlideAccum = 0;
          st.slideSpeed = 0;
          st.portaSpeed = 0;
        } else if (cmd === 'W') {
          st.dpcmRate = val & 0x0f;
          st.s5bNoisePeriod = val & 0x1f;
        } else if (cmd === 'Y') {
          if (st.chip === '2A03' && st.subChannel === 4) {
            st.dpcmPos = val * 64 * 8;
          }
        } else if (cmd === 'Z') {
          if (st.chip === '2A03' && st.subChannel === 4) {
            st.dpcmAcc = val & 0x7f;
          } else if (st.chip === 'N163') {
            st.n163WaveIdx = val;
          }
        } else if (cmd === '=') {
          st.phase = 0;
          st.modPhase = 0;
        } else if (cmd === 'N') {
          st.targetVol = y;
          st.targetVolSpeed = Math.max(1, x);
        } else if (cmd === 'K') {
          st.freqMult = val === 0 ? 1.0 : Math.max(0.25, Math.min(4.0, val / 16.0));
          if (st.activeNoteId > 0) {
            st.baseFreq = ftNoteToFreq(st.activeNoteId, 0, st.pitchFine, st.freqMult);
          }
        }
      }
    }

    // Evaluate tick 0 macro values immediately (without advancing seqPos past 0)
    if (st.gate) {
      this.evaluateMacrosForChannel(st, false);
      this.updateChannelFinalFrequency(st);
    }
  }

  triggerCurrentRow() {
    const song = this.getActiveSong();
    if (!song) return;
    const orderRow = song.frameList[this.currentOrder] || [];

    for (let chIdx = 0; chIdx < this.chState.length; chIdx++) {
      const st = this.chState[chIdx];
      const patId = orderRow[chIdx] ?? 0;
      const rows = song.patterns[`${chIdx}:${patId}`];
      const cell = rows ? rows.find((r) => r.row === this.currentRow) : null;

      // Flush any previous unfinished delayed note before processing new row
      if (st.delayedCell) {
        this.applyCellTrigger(st, st.delayedCell);
        st.delayedCell = null;
        st.noteDelayTicks = -1;
      }

      if (!cell) continue;

      // Check for Gxx (Note Delay) > 0
      const gFx = cell.effects ? cell.effects.find((e) => e.code === 'G' && (e.param & 0xff) > 0) : null;
      if (gFx) {
        const delayTicks = Math.min(this.speed - 1, gFx.param & 0xff);
        if (delayTicks > 0) {
          st.noteDelayTicks = delayTicks;
          st.delayedCell = cell;
          continue;
        }
      }

      this.applyCellTrigger(st, cell);
    }

    this.pushRegistersToWasm();
  }

  jumpSequencesToRelease(st) {
    const inst = this.getInstrumentForChannel(st);
    if (!inst || !this.module || !this.module.sequences) return;
    for (let sType = 0; sType < 5; sType++) {
      const seqIdx = inst.seqIndices[sType];
      if (seqIdx < 0) continue;
      const seq = this.module.sequences.find((s) => s.type === sType && s.index === seqIdx && s.chip === inst.chip);
      if (seq && seq.releasePoint >= 0 && seq.releasePoint < seq.items.length) {
        st.seqPos[sType] = seq.releasePoint;
        st.seqEnded[sType] = false;
      }
    }
  }

  stepSequenceIndex(seq, pos, released, wasEnded) {
    const len = seq.items.length;
    if (len <= 0) return { pos: 0, ended: true };
    if (wasEnded) return { pos: Math.max(0, Math.min(len - 1, pos)), ended: true };

    let next = pos + 1;
    let ended = false;

    if (!released) {
      if (seq.releasePoint >= 0 && seq.releasePoint <= len) {
        if (next >= seq.releasePoint) {
          if (seq.loopPoint >= 0 && seq.loopPoint < seq.releasePoint) {
            next = seq.loopPoint;
          } else {
            next = Math.max(0, seq.releasePoint - 1);
            ended = true;
          }
        }
      } else if (next >= len) {
        if (seq.loopPoint >= 0 && seq.loopPoint < len) {
          next = seq.loopPoint;
        } else {
          next = len - 1;
          ended = true;
        }
      }
    } else {
      if (seq.releasePoint >= 0 && pos < seq.releasePoint && seq.releasePoint < len) {
        next = seq.releasePoint;
      } else if (next >= len) {
        next = len - 1;
        ended = true;
      }
    }
    return { pos: Math.max(0, Math.min(len - 1, next)), ended };
  }

  evaluateMacrosForChannel(st, advanceFirst) {
    const inst = this.getInstrumentForChannel(st);
    let seqVol = st.vol;
    if (!Array.isArray(st.seqEnded)) st.seqEnded = [false, false, false, false, false];

    if (inst && this.module && Array.isArray(this.module.sequences)) {
      // 0: Volume envelope
      const volSeqIdx = inst.seqIndices[0];
      if (volSeqIdx >= 0) {
        const seq = this.module.sequences.find((s) => s.type === 0 && s.index === volSeqIdx && s.chip === inst.chip);
        if (seq && seq.items.length > 0) {
          if (advanceFirst) {
            const step = this.stepSequenceIndex(seq, st.seqPos[0], st.released, st.seqEnded[0]);
            st.seqPos[0] = step.pos;
            st.seqEnded[0] = step.ended;
          }
          const rawItem = Math.max(0, seq.items[st.seqPos[0]]);
          const scale = seq.chip === 'FDS' || rawItem > 15 ? 31 : 15;
          if (rawItem === 0 || st.vol === 0) {
            seqVol = 0;
          } else {
            // Preserve quiet audible levels per hardware FamiTracker: never round non-zero to 0!
            seqVol = Math.max(0.45, Math.min(15, (rawItem / scale) * st.vol));
          }
        }
      }

      // 1: Arpeggio envelope (0=Abs, 1=Fixed, 2=Rel, 3=Scheme)
      const arpSeqIdx = inst.seqIndices[1];
      if (arpSeqIdx >= 0) {
        const seq = this.module.sequences.find((s) => s.type === 1 && s.index === arpSeqIdx && s.chip === inst.chip);
        if (seq && seq.items.length > 0) {
          let skipRelAccum = st.seqEnded[1];
          if (advanceFirst) {
            const step = this.stepSequenceIndex(seq, st.seqPos[1], st.released, st.seqEnded[1]);
            st.seqPos[1] = step.pos;
            skipRelAccum = step.ended;
            st.seqEnded[1] = step.ended;
          }
          const raw = seq.items[st.seqPos[1]];
          const setting = seq.setting & 0x03;
          if (setting === 1) {
            // Fixed note mode (raw is unsigned 0..95 note offset; C-0 = 0 -> noteId 1)
            const unsignedVal = raw < 0 ? raw + 256 : raw;
            st.macroFixedNote = Math.max(1, Math.min(96, unsignedVal + 1));
            st.macroArpSemis = 0;
          } else if (setting === 2) {
            // Relative cumulative semitones — NEVER accumulate once non-looping macro has finished
            st.macroFixedNote = -1;
            if (!skipRelAccum) {
              st.arpRelAccum = Math.max(-48, Math.min(48, st.arpRelAccum + raw));
            }
            st.macroArpSemis = st.arpRelAccum;
          } else if (setting === 3) {
            // Scheme (signed 6-bit offset)
            st.macroFixedNote = -1;
            const signed6 = (raw << 26) >> 26;
            st.macroArpSemis = signed6;
          } else {
            // Absolute semitone offset from active note
            st.macroFixedNote = -1;
            st.macroArpSemis = raw;
          }
        }
      }

      // 2: Pitch envelope (accumulates signed hardware pitch units per active macro step only)
      const pitchSeqIdx = inst.seqIndices[2];
      if (pitchSeqIdx >= 0) {
        const seq = this.module.sequences.find((s) => s.type === 2 && s.index === pitchSeqIdx && s.chip === inst.chip);
        if (seq && seq.items.length > 0) {
          let skipPitchAccum = st.seqEnded[2];
          if (advanceFirst) {
            const step = this.stepSequenceIndex(seq, st.seqPos[2], st.released, st.seqEnded[2]);
            st.seqPos[2] = step.pos;
            skipPitchAccum = step.ended;
            st.seqEnded[2] = step.ended;
          }
          if (!skipPitchAccum) {
            st.macroPitchAccum = Math.max(-1600, Math.min(1600, st.macroPitchAccum + seq.items[st.seqPos[2]]));
          }
        }
      }

      // 3: Hi-Pitch envelope (16x pitch units per active macro step only)
      const hiPitchSeqIdx = inst.seqIndices[3];
      if (hiPitchSeqIdx >= 0) {
        const seq = this.module.sequences.find((s) => s.type === 3 && s.index === hiPitchSeqIdx && s.chip === inst.chip);
        if (seq && seq.items.length > 0) {
          let skipHiPitchAccum = st.seqEnded[3];
          if (advanceFirst) {
            const step = this.stepSequenceIndex(seq, st.seqPos[3], st.released, st.seqEnded[3]);
            st.seqPos[3] = step.pos;
            skipHiPitchAccum = step.ended;
            st.seqEnded[3] = step.ended;
          }
          if (!skipHiPitchAccum) {
            st.macroPitchAccum = Math.max(-1600, Math.min(1600, st.macroPitchAccum + seq.items[st.seqPos[3]] * 16));
          }
        }
      }

      // 4: Duty / Noise / Wave / S5B Mode sequence
      const dutySeqIdx = inst.seqIndices[4];
      if (dutySeqIdx >= 0) {
        const seq = this.module.sequences.find((s) => s.type === 4 && s.index === dutySeqIdx && s.chip === inst.chip);
        if (seq && seq.items.length > 0) {
          if (advanceFirst) {
            const step = this.stepSequenceIndex(seq, st.seqPos[4], st.released, st.seqEnded[4]);
            st.seqPos[4] = step.pos;
            st.seqEnded[4] = step.ended;
          }
          const dVal = seq.items[st.seqPos[4]];
          const dUnsigned = dVal < 0 ? dVal + 256 : dVal;
          st.duty = dUnsigned & 7;
          if (st.chip === '2A03' && st.subChannel === 3) {
            st.noiseShort = (dUnsigned & 1) !== 0;
          } else if (st.chip === 'Sunsoft 5B') {
            st.s5bToneEn = (dUnsigned & 1) !== 0 || (dUnsigned & 3) === 0;
            st.s5bNoiseEn = (dUnsigned & 2) !== 0;
          } else if (st.chip === 'N163') {
            st.n163WaveIdx = dUnsigned;
          }
        }
      }
    }

    // Apply 7xy Tremolo modulation
    if (st.tremDepth > 0 && st.tremSpeed > 0) {
      st.tremPhase += st.tremSpeed * 0.14;
      const drop = ((Math.sin(st.tremPhase) + 1) * 0.5) * (st.tremDepth * 0.5);
      seqVol = Math.max(0, seqVol - drop);
    }

    st.envVol = Math.max(0, Math.min(15, seqVol));
  }

  updateChannelFinalFrequency(st) {
    // 1. Hardware period slide & Macro Pitch delta (in NES period space)
    const noteToUse = st.macroFixedNote > 0 ? st.macroFixedNote : st.activeNoteId;
    if (!noteToUse || noteToUse <= 0) return;

    let semiOffset = st.macroArpSemis + st.noteSlideAccum;
    if (st.arpX !== 0 || st.arpY !== 0) {
      const phase = st.arpTick % 3;
      semiOffset += phase === 1 ? st.arpX : phase === 2 ? st.arpY : 0;
    }
    if (st.vibDepth > 0 && st.vibSpeed > 0) {
      semiOffset += Math.sin(st.vibPhase) * (st.vibDepth / 15) * 0.7;
    }

    // Base frequency after note + arp + vibrato (full Oct 0..7 C-0..B-7)
    const freqAfterArp = ftNoteToFreq(noteToUse, semiOffset, st.pitchFine, st.freqMult);
    if (freqAfterArp <= 0) return;

    // Combine with bounded period-domain slide & macroPitchAccum (accurate across all octaves 0..7)
    const totalPeriodDelta = st.periodOffset - st.macroPitchAccum;
    if (totalPeriodDelta === 0) {
      st.curFreq = freqAfterArp;
    } else {
      const cpu = this.getCpuHz();
      const basePeriod = cpu / (16.0 * freqAfterArp);
      // Period >= 18.0 prevents ultrasonic runaway above ~6.2kHz while allowing B-7 (period ~28) cleanly
      const effPeriod = Math.max(18.0, Math.min(8191.0, basePeriod + totalPeriodDelta));
      st.curFreq = cpu / (16.0 * effPeriod);
    }
  }

  stepChannelEffectsAndMacros(st) {
    if (st.noteDelayTicks > 0) {
      st.noteDelayTicks--;
      if (st.noteDelayTicks === 0 && st.delayedCell) {
        const cell = st.delayedCell;
        st.delayedCell = null;
        st.noteDelayTicks = -1;
        this.applyCellTrigger(st, cell);
        return;
      }
    }

    if (!st.gate) return;

    st.seqTick++;

    if (st.releaseDelayTicks > 0) {
      st.releaseDelayTicks--;
      if (st.releaseDelayTicks === 0) {
        st.released = true;
        this.jumpSequencesToRelease(st);
      }
    }

    if (st.cutTicks >= 0 && st.seqTick >= st.cutTicks) {
      st.gate = false;
      st.cutTicks = -1;
      return;
    }

    // Advance slide & portamento in hardware period domain
    if (st.slideSpeed !== 0) {
      st.periodOffset = Math.max(-2047, Math.min(2047, st.periodOffset + st.slideSpeed));
    }

    if (st.portaSpeed > 0 && st.portaTargetFreq > 0 && st.curFreq > 0) {
      const cpu = this.getCpuHz();
      const curPer = cpu / (16.0 * st.curFreq);
      const targetPer = cpu / (16.0 * st.portaTargetFreq);
      const diff = targetPer - curPer;
      if (Math.abs(diff) <= st.portaSpeed) {
        st.baseFreq = st.portaTargetFreq;
        st.periodOffset = 0;
        st.curFreq = st.portaTargetFreq;
      } else {
        st.periodOffset += Math.sign(diff) * st.portaSpeed;
      }
    }

    if (st.noteSlideDir !== 0 && Math.abs(st.noteSlideAccum) < st.noteSlideSemis) {
      const stepSemis = st.noteSlideSpeed * 0.25;
      const next = st.noteSlideAccum + st.noteSlideDir * stepSemis;
      if (Math.abs(next) >= st.noteSlideSemis) {
        st.noteSlideAccum = st.noteSlideDir * st.noteSlideSemis;
        st.noteSlideDir = 0;
      } else {
        st.noteSlideAccum = next;
      }
    }

    if (st.arpX !== 0 || st.arpY !== 0) {
      st.arpTick++;
    }
    if (st.vibDepth > 0 && st.vibSpeed > 0) {
      st.vibPhase += st.vibSpeed * 0.14;
    }

    if (st.volSlide !== 0) {
      st.vol = Math.max(0, Math.min(15, st.vol + st.volSlide));
    }
    if (st.targetVol >= 0) {
      const step = (st.targetVol - st.vol) / Math.max(1, st.targetVolSpeed);
      st.vol = Math.max(0, Math.min(15, st.vol + step));
      if (Math.abs(st.targetVol - st.vol) < 0.2) {
        st.vol = st.targetVol;
        st.targetVol = -1;
      }
    }

    // Smooth VRC7 FM decay envelope
    if (st.chip === 'VRC7') {
      const inst = this.getInstrumentForChannel(st);
      const patchIdx = st.vrc7PatchOverride >= 0 ? st.vrc7PatchOverride : (inst?.vrc7Patch ?? 3);
      const p = VRC7_ROM_PATCHES[patchIdx & 15];
      if (p) {
        const dec = st.released ? 0.16 : p[4];
        const target = st.released ? 0.0 : p[5];
        st.fmEnvLevel = Math.max(target, st.fmEnvLevel - dec);
        st.fmModLevel = Math.max(0.25, st.fmModLevel - dec * 1.15);
      }
    }

    this.evaluateMacrosForChannel(st, true);
    this.updateChannelFinalFrequency(st);
  }

  applyTickModulation() {
    for (let i = 0; i < this.chState.length; i++) {
      this.stepChannelEffectsAndMacros(this.chState[i]);
    }
    this.pushRegistersToWasm();
  }

  pushRegistersToWasm() {
    if (!this.wasmExports || typeof this.wasmExports._nes_write_reg !== 'function') return;
    const write = this.wasmExports._nes_write_reg;
    const cpu = this.getCpuHz();
    const anySolo = this.chState.some((c) => c.solo);
    for (let ch = 0; ch < Math.min(4, this.chState.length); ch++) {
      const st = this.chState[ch];
      const silent = !this.isPlaying || !st.gate || st.muted || (anySolo && !st.solo) || st.envVol <= 0.01;
      const v = silent ? 0 : Math.max(1, Math.min(15, Math.round(st.envVol))) & 0x0f;
      if (ch < 2) {
        const baseReg = 0x4000 + ch * 4;
        const timer = st.curFreq > 20 ? Math.max(8, Math.min(2047, Math.round(cpu / (16 * st.curFreq) - 1))) : 0;
        write(baseReg, ((st.duty & 3) << 6) | 0x30 | v);
        write(baseReg + 1, 0x08);
        write(baseReg + 2, timer & 0xff);
        write(baseReg + 3, 0xf8 | ((timer >> 8) & 0x07));
      } else if (ch === 2) {
        const timer = st.curFreq > 20 ? Math.max(2, Math.min(2047, Math.round(cpu / (32 * st.curFreq) - 1))) : 0;
        write(0x4008, silent ? 0x00 : 0xff);
        write(0x400a, timer & 0xff);
        write(0x400b, 0xf8 | ((timer >> 8) & 0x07));
      } else if (ch === 3) {
        const noteForNoise = st.macroFixedNote > 0 ? st.macroFixedNote : st.activeNoteId;
        const periodIdx = 15 - ((Math.max(1, noteForNoise || 1) - 1) & 15);
        write(0x400c, 0x30 | v);
        write(0x400e, (st.noiseShort ? 0x80 : 0) | (periodIdx & 0x0f));
        write(0x400f, 0xf8);
      }
    }
  }

  renderChannelSample(st, forceActive = false) {
    if ((!this.isPlaying && !forceActive) || !st.gate) {
      st.level *= 0.92;
      return 0;
    }

    const amp = Math.max(0, Math.min(1, st.envVol / 15));
    const cpu = this.getCpuHz();
    let raw = 0;

    if (st.chip === '2A03') {
      if (st.subChannel === 0 || st.subChannel === 1) {
        if (st.curFreq > 10 && amp > 0) {
          st.phase = (st.phase + st.curFreq / sampleRate) % 1;
          const thresh = DUTY_THRESHOLDS[st.duty & 3];
          raw = (st.phase < thresh ? 0.85 : -0.85) * amp * 0.28;
        }
      } else if (st.subChannel === 2) {
        if (st.curFreq > 10 && amp > 0) {
          st.phase = (st.phase + st.curFreq / sampleRate) % 1;
          const step = Math.floor(st.phase * 32) & 31;
          raw = (TRIANGLE_TABLE[step] / 7.5 - 1.0) * 0.36;
        }
      } else if (st.subChannel === 3) {
        if (amp > 0) {
          const noteForNoise = st.macroFixedNote > 0 ? st.macroFixedNote : st.activeNoteId;
          const pIdx = 15 - ((Math.max(1, noteForNoise || 1) - 1) & 15);
          const nTable = this.machine === 'PAL' ? NOISE_PERIODS_PAL : NOISE_PERIODS_NTSC;
          const periodSamples = Math.max(1, (nTable[pIdx] * sampleRate) / cpu);
          this.noisePhase += 1;
          while (this.noisePhase >= periodSamples) {
            this.noisePhase -= periodSamples;
            const tap = st.noiseShort ? (this.lfsr >> 6) & 1 : (this.lfsr >> 1) & 1;
            const fb = (this.lfsr & 1) ^ tap;
            this.lfsr = (this.lfsr >> 1) | (fb << 14);
          }
          raw = ((this.lfsr & 1) ? 0.65 : -0.65) * amp * 0.24;
        }
      } else if (st.subChannel === 4) {
        const samples = (this.module && this.module.dpcmSamples) || [];
        const smp = samples[st.dpcmSampleIdx];
        if (smp && smp.data && smp.data.length > 0) {
          const totalBits = smp.data.length * 8;
          if (st.dpcmPos >= totalBits) {
            if (st.dpcmLoop) st.dpcmPos %= totalBits;
            else st.gate = false;
          }
          if (st.gate && st.dpcmPos < totalBits) {
            const dTable = this.machine === 'PAL' ? DMC_PERIODS_PAL : DMC_PERIODS_NTSC;
            const dmcPeriod = dTable[st.dpcmRate & 0x0f] || 54;
            const bitAdvance = cpu / (dmcPeriod * sampleRate);
            const prevBit = Math.floor(st.dpcmPos);
            st.dpcmPos += bitAdvance;
            const nextBit = Math.floor(st.dpcmPos);
            if (nextBit > prevBit) {
              const steps = Math.min(4, nextBit - prevBit);
              for (let b = 0; b < steps; b++) {
                const posBit = (prevBit + b) % totalBits;
                const byteIdx = posBit >> 3;
                const bitIdx = posBit & 7;
                const bit = (smp.data[byteIdx] >> bitIdx) & 1;
                if (bit && st.dpcmAcc <= 125) st.dpcmAcc += 2;
                else if (!bit && st.dpcmAcc >= 2) st.dpcmAcc -= 2;
              }
            }
            const x = (st.dpcmAcc - 64) / 64;
            const y = x - (st.dpcmHpPrev || 0) + 0.996 * (st.dpcmHpOut || 0);
            st.dpcmHpPrev = x;
            st.dpcmHpOut = y;
            raw = Math.max(-0.85, Math.min(0.85, y * 0.72));
          }
        }
      }
    } else if (st.chip === 'Sunsoft 5B') {
      if (amp > 0) {
        let toneVal = 0;
        let noiseVal = 0;
        if (st.s5bToneEn && st.curFreq > 10) {
          st.phase = (st.phase + st.curFreq / sampleRate) % 1;
          toneVal = st.phase < 0.5 ? 0.8 : -0.8;
        }
        if (st.s5bNoiseEn) {
          const nPer = Math.max(1, ((st.s5bNoisePeriod + 1) * 16 * sampleRate) / cpu);
          this.s5bNoisePhase += 1;
          if (this.s5bNoisePhase >= nPer) {
            this.s5bNoisePhase -= nPer;
            const fb = ((this.s5bLfsr & 1) ^ ((this.s5bLfsr >> 3) & 1)) & 1;
            this.s5bLfsr = (this.s5bLfsr >> 1) | (fb << 16);
          }
          noiseVal = (this.s5bLfsr & 1) ? 0.65 : -0.65;
        }
        const mix = st.s5bToneEn && st.s5bNoiseEn ? (toneVal + noiseVal) * 0.55 : st.s5bNoiseEn ? noiseVal : toneVal;
        raw = mix * amp * 0.25;
      }
    } else if (st.chip === 'VRC6') {
      if (st.curFreq > 10 && amp > 0) {
        st.phase = (st.phase + st.curFreq / sampleRate) % 1;
        if (st.subChannel === 2) {
          // 14-step VRC6 Sawtooth
          const acc = Math.floor(st.phase * 14) / 14;
          raw = ((acc * 2 - 1) * 0.85) * amp * 0.28;
        } else {
          const thresh = Math.min(0.5, ((st.duty & 7) + 1) / 16);
          raw = (st.phase < thresh ? 0.8 : -0.8) * amp * 0.24;
        }
      }
    } else if (st.chip === 'VRC7') {
      if (st.curFreq > 10 && amp > 0) {
        const inst = this.getInstrumentForChannel(st);
        const patchIdx = st.vrc7PatchOverride >= 0 ? st.vrc7PatchOverride : (inst?.vrc7Patch ?? 3);
        let modMult = 1;
        let carMult = 1;
        let modIdx = 1.6;
        let fbAmt = 0.15;

        if (patchIdx === 0 && inst?.vrc7CustomRegs && inst.vrc7CustomRegs.length >= 8) {
          const r0 = inst.vrc7CustomRegs[0];
          const r1 = inst.vrc7CustomRegs[1];
          const r2 = inst.vrc7CustomRegs[2];
          const r3 = inst.vrc7CustomRegs[3];
          modMult = OPLL_MULT_TABLE[r0 & 0x0f] || 1;
          carMult = OPLL_MULT_TABLE[r1 & 0x0f] || 1;
          const modTl = r2 & 0x3f;
          modIdx = Math.max(0.15, (63 - modTl) / 16.0);
          fbAmt = (r3 & 0x07) * 0.12;
        } else {
          const p = VRC7_ROM_PATCHES[patchIdx & 15];
          modMult = p[0];
          carMult = p[1];
          modIdx = p[2];
          fbAmt = p[3];
        }

        const baseStep = st.curFreq / sampleRate;
        st.phase = (st.phase + baseStep * carMult) % 1;
        st.modPhase = (st.modPhase + baseStep * modMult) % 1;
        const modSig = Math.sin(st.modPhase * Math.PI * 2 + fbAmt * Math.sin(st.modPhase * Math.PI * 2));
        const mod = modSig * modIdx * st.fmModLevel;
        raw = Math.sin(st.phase * Math.PI * 2 + mod) * amp * st.fmEnvLevel * 0.30;
      }
    } else if (st.chip === 'FDS') {
      if (st.curFreq > 10 && amp > 0) {
        const inst = this.getInstrumentForChannel(st);
        let effFreq = st.curFreq;
        if (inst && inst.fdsModTable && inst.fdsModDepth > 0 && inst.fdsModSpeed > 0) {
          const lfoHz = Math.max(0.2, Math.min(80, (inst.fdsModSpeed * cpu) / 262144));
          st.fdsModPhase = (st.fdsModPhase + lfoHz / sampleRate) % 1;
          const mIdx = Math.floor(st.fdsModPhase * 32) & 31;
          const mStep = inst.fdsModTable[mIdx] || 0;
          const modSemi = (mStep * (inst.fdsModDepth / 32)) * 0.08;
          effFreq = effFreq * Math.pow(2, modSemi / 12);
        }
        st.phase = (st.phase + effFreq / sampleRate) % 1;
        if (inst && inst.fdsWave && inst.fdsWave.length >= 64) {
          const wIdx = Math.floor(st.phase * 64) & 63;
          raw = (((inst.fdsWave[wIdx] & 63) - 31.5) / 31.5) * amp * 0.30;
        } else {
          const q = Math.floor(st.phase * 64) / 64;
          raw = Math.sin(q * Math.PI * 2) * amp * 0.28;
        }
      }
    } else if (st.chip === 'N163') {
      if (st.curFreq > 10 && amp > 0) {
        const inst = this.getInstrumentForChannel(st);
        st.phase = (st.phase + st.curFreq / sampleRate) % 1;
        if (inst && Array.isArray(inst.n163Waves) && inst.n163Waves.length > 0) {
          const wave = inst.n163Waves[st.n163WaveIdx % inst.n163Waves.length];
          if (wave && wave.length > 0) {
            const wIdx = Math.floor(st.phase * wave.length) % wave.length;
            raw = (((wave[wIdx] & 0x0f) - 7.5) / 7.5) * amp * 0.28;
          }
        } else {
          const q = Math.floor(st.phase * 32) / 32;
          raw = Math.sin(q * Math.PI * 2) * amp * 0.26;
        }
      }
    } else {
      // MMC5 pulse
      if (st.curFreq > 10 && amp > 0) {
        st.phase = (st.phase + st.curFreq / sampleRate) % 1;
        raw = (st.phase < DUTY_THRESHOLDS[st.duty & 3] ? 0.8 : -0.8) * amp * 0.24;
      }
    }

    const absRaw = Math.abs(raw);
    st.level = Math.max(absRaw * 2.2, st.level * 0.96);
    st.scope[st.scopeWrite] = raw * 2.4;
    st.scopeWrite = (st.scopeWrite + 1) % this.scopeSnapshotLen;
    return raw;
  }

  mixPreviewVoicesIntoSample(anySolo) {
    if (this.previewVoices.length === 0) return [0, 0];
    let pL = 0;
    let pR = 0;
    for (let i = this.previewVoices.length - 1; i >= 0; i--) {
      const pv = this.previewVoices[i];
      pv.remainingSamples--;
      if (pv.remainingSamples <= 0) {
        this.previewVoices.splice(i, 1);
        continue;
      }
      const smp = this.renderChannelSample(pv, true);
      const chMatch = this.chState[pv.channelIndex];
      const muted = chMatch ? (chMatch.muted || (anySolo && !chMatch.solo)) : false;
      if (!muted) {
        const panBias = ((pv.channelIndex % 5) - 2) * 0.08;
        pL += smp * (1 - panBias);
        pR += smp * (1 + panBias);
        if (chMatch && !this.isPlaying) {
          chMatch.level = Math.max(chMatch.level, pv.level);
          chMatch.scope[chMatch.scopeWrite] = smp * 2.4;
          chMatch.scopeWrite = (chMatch.scopeWrite + 1) % this.scopeSnapshotLen;
        }
      }
    }
    return [pL, pR];
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0];
    const outR = out[1] || outL;
    const frames = outL.length;

    const tickHz = this.machine === 'PAL' ? 50 : 60;
    const samplesPerTick =
      ((sampleRate / tickHz) * (150 / Math.max(30, this.tempo))) /
      Math.max(0.2, this.bpmScale || 1.0);
    const anySolo = this.chState.some((c) => c.solo);

    const wasmReady =
      this.isPlaying &&
      this.wasmExports &&
      typeof this.wasmExports._nes_render === 'function' &&
      this.wasmOutL &&
      this.wasmOutR;

    if (wasmReady) {
      // WASM renders 2A03 channels 0..3; mix DPCM (c === 4) & Expansion chips (c >= 5) on top
      for (let s = 0; s < frames; s++) {
        this.tickSamplesAccum++;
        this.elapsedSamples++;
        if (this.tickSamplesAccum >= samplesPerTick) {
          this.tickSamplesAccum -= samplesPerTick;
          this.stepSequencerTick();
        }
        if (this.previewVoices.length > 0) {
          this.previewTickAccum++;
          if (this.previewTickAccum >= samplesPerTick) {
            this.previewTickAccum -= samplesPerTick;
            for (let p = 0; p < this.previewVoices.length; p++) {
              this.stepChannelEffectsAndMacros(this.previewVoices[p]);
            }
          }
        }
      }
      const rendered = this.wasmExports._nes_render(this.wasmOutL, this.wasmOutR, frames);
      if (rendered > 0 && this.wasmExports.memory) {
        const heap = new Float32Array(this.wasmExports.memory.buffer);
        const offL = this.wasmOutL >> 2;
        const offR = this.wasmOutR >> 2;
        for (let i = 0; i < frames; i++) {
          let mixL = heap[offL + i] || 0;
          let mixR = heap[offR + i] || mixL;

          for (let c = 4; c < this.chState.length; c++) {
            const st = this.chState[c];
            const sample = this.renderChannelSample(st);
            const muted = st.muted || (anySolo && !st.solo);
            if (!muted) {
              const panBias = ((c % 5) - 2) * 0.08;
              mixL += sample * (1 - panBias);
              mixR += sample * (1 + panBias);
            }
          }

          if (this.previewVoices.length > 0) {
            const [pL, pR] = this.mixPreviewVoicesIntoSample(anySolo);
            mixL += pL;
            mixR += pR;
          }

          outL[i] = Math.max(-0.95, Math.min(0.95, mixL));
          outR[i] = Math.max(-0.95, Math.min(0.95, mixR));
        }

        for (let c = 0; c < Math.min(4, this.chState.length); c++) {
          const st = this.chState[c];
          const muted = st.muted || (anySolo && !st.solo);
          if (muted || !st.gate) {
            st.level *= 0.88;
          } else {
            const targetLvl =
              typeof this.wasmExports._nes_get_channel_level === 'function'
                ? this.wasmExports._nes_get_channel_level(c)
                : Math.max(0.08, Math.min(1, st.envVol / 15));
            st.level = Math.max(targetLvl, st.level * 0.94);
            for (let k = 0; k < Math.min(16, frames); k++) {
              void this.renderChannelSample(st);
            }
          }
        }
      }
    } else {
      for (let i = 0; i < frames; i++) {
        if (this.isPlaying) {
          this.tickSamplesAccum++;
          this.elapsedSamples++;
          if (this.tickSamplesAccum >= samplesPerTick) {
            this.tickSamplesAccum -= samplesPerTick;
            this.stepSequencerTick();
          }
        } else if (this.previewVoices.length > 0) {
          this.previewTickAccum++;
          if (this.previewTickAccum >= samplesPerTick) {
            this.previewTickAccum -= samplesPerTick;
            for (let p = 0; p < this.previewVoices.length; p++) {
              this.stepChannelEffectsAndMacros(this.previewVoices[p]);
            }
          }
        }

        let mixL = 0;
        let mixR = 0;
        if (this.isPlaying) {
          for (let c = 0; c < this.chState.length; c++) {
            const st = this.chState[c];
            const sample = this.renderChannelSample(st);
            const muted = st.muted || (anySolo && !st.solo);
            if (!muted) {
              const panBias = ((c % 5) - 2) * 0.08;
              mixL += sample * (1 - panBias);
              mixR += sample * (1 + panBias);
            }
          }
        }
        if (this.previewVoices.length > 0) {
          const [pL, pR] = this.mixPreviewVoicesIntoSample(anySolo);
          mixL += pL;
          mixR += pR;
        }
        outL[i] = Math.max(-0.95, Math.min(0.95, mixL));
        outR[i] = Math.max(-0.95, Math.min(0.95, mixR));
      }
    }

    this.telemetryAccum += frames;
    if (this.telemetryAccum >= 1470) {
      this.telemetryAccum = 0;
      this.emitTelemetry(false);
    }

    return true;
  }

  emitTelemetry(force) {
    if (!force && !this.isPlaying && this.previewVoices.length === 0 && this.chState.every((c) => c.level < 0.01)) {
      return;
    }
    const scopes = [];
    for (let i = 0; i < Math.min(16, this.chState.length); i++) {
      scopes.push(Array.from(this.chState[i].scope));
    }
    this.port.postMessage({
      type: 'state',
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
      activeSongIndex: this.activeSongIndex,
      currentOrder: this.currentOrder,
      currentRow: this.currentRow,
      speed: this.speed,
      tempo: this.tempo,
      elapsedSeconds: this.elapsedSamples / sampleRate,
      channelLevels: this.chState.map((c) => c.level),
      channelNotes: this.chState.map((c) => c.noteName),
      channelVolumes: this.chState.map((c) => Math.round(c.envVol)),
      channelInsts: this.chState.map((c) => c.instIdx),
      scopes,
    });
  }
}

registerProcessor('aria-nes-worklet-processor', AriaNesWorkletProcessor);
