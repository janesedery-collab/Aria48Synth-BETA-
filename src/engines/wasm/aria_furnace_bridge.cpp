/**
 * aria_furnace_bridge.cpp
 * Headless Furnace Tracker (DivEngine) Emscripten ES6 WebAssembly / Embind Bridge
 * for Aria 48 Tracker.
 *
 * Compile with Emscripten (em++):
 *   em++ aria_furnace_bridge.cpp -I<furnace>/src/engine -std=c++17 -O3 \
 *     -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createAriaFurnaceModule \
 *     -s ALLOW_MEMORY_GROWTH=1 -s EXPORTED_RUNTIME_METHODS="['HEAPU8','HEAPF32','HEAP16','HEAP32']" \
 *     --bind -o aria_furnace_all.js
 *
 * Wraps Furnace's cycle-accurate chip cores (Nuked-OPN2, ymfm, NSFPlay, SameBoy,
 * reSIDfp, reSID, snes_spc, HuC6280, AY-3-8910, POKEY, Konami SCC, OPL3, etc.)
 * directly with zero fallback software oscillators.
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "engine.h"
#include "instrument.h"
#include "sample.h"
#include "song.h"
#include "wavetable.h"

using namespace emscripten;

namespace aria {

enum class AriaSystemId : int {
  YM2612 = DIV_SYSTEM_YM2612,
  YM2612_EXT = DIV_SYSTEM_YM2612_EXT,
  SMS = DIV_SYSTEM_SMS,
  NES = DIV_SYSTEM_NES,
  VRC6 = DIV_SYSTEM_VRC6,
  FDS = DIV_SYSTEM_FDS,
  N163 = DIV_SYSTEM_N163,
  GB = DIV_SYSTEM_GB,
  SNES = DIV_SYSTEM_SNES,
  C64_6581 = DIV_SYSTEM_C64_6581,
  C64_8580 = DIV_SYSTEM_C64_8580,
  PCE = DIV_SYSTEM_PCE,
  YM2151 = DIV_SYSTEM_YM2151,
  OPL3 = DIV_SYSTEM_OPL3,
  AY8910 = DIV_SYSTEM_AY8910,
  POKEY = DIV_SYSTEM_POKEY,
  SCC = DIV_SYSTEM_SCC,
};

struct ChipSlotState {
  int sysId = DIV_SYSTEM_YM2612;
  int coreIndex = 0;
  double clockHz = 7670454.0;
  float tuningHz = 440.0f;
  float vol = 1.0f;
  float pan = 0.0f;
  bool mute = false;
  bool solo = false;
};

class AriaFurnaceEngine {
public:
  AriaFurnaceEngine() : engine_(std::make_unique<DivEngine>()) {}
  ~AriaFurnaceEngine() {
    if (initialized_) {
      engine_->quit(false);
    }
  }

  bool init(double sampleRate, int bufferFrames) {
    sampleRate_ = sampleRate > 8000.0 ? sampleRate : 44100.0;
    bufferFrames_ = std::max(64, std::min(8192, bufferFrames));
    engine_->preInit();
    engine_->setAudio(DIV_AUDIO_DUMMY);
    if (!engine_->init()) {
      return false;
    }
    engine_->createNew(STANDARD_SONG_FORMAT, "Aria48 Furnace Rack");
    applyAllSystems();
    renderL_.assign(static_cast<size_t>(bufferFrames_), 0.0f);
    renderR_.assign(static_cast<size_t>(bufferFrames_), 0.0f);
    initialized_ = true;
    return true;
  }

  void reset() {
    if (!initialized_) return;
    engine_->stop();
    engine_->synchronized([this]() {
      engine_->createNew(STANDARD_SONG_FORMAT, "Aria48 Reset");
      applyAllSystems();
    });
  }

  bool loadSong(uintptr_t dataPtr, int byteLength) {
    if (!initialized_ || dataPtr == 0 || byteLength <= 0) return false;
    const uint8_t* raw = reinterpret_cast<const uint8_t*>(dataPtr);
    unsigned char* copy = static_cast<unsigned char*>(std::malloc(static_cast<size_t>(byteLength)));
    if (!copy) return false;
    std::memcpy(copy, raw, static_cast<size_t>(byteLength));
    bool ok = engine_->load(copy, static_cast<size_t>(byteLength));
    if (ok) {
      engine_->play();
    }
    return ok;
  }

  void play() {
    if (initialized_) engine_->play();
  }

  void stop() {
    if (initialized_) engine_->stop();
  }

  void clearSystems() {
    slots_.clear();
  }

  int addSystem(int sysId, int coreIndex, double clockHz, float tuningHz) {
    ChipSlotState slot;
    slot.sysId = sysId;
    slot.coreIndex = coreIndex;
    slot.clockHz = clockHz;
    slot.tuningHz = tuningHz > 100.0f ? tuningHz : 440.0f;
    slots_.push_back(slot);
    if (initialized_) applyAllSystems();
    return static_cast<int>(slots_.size()) - 1;
  }

  bool removeSystem(int slotIndex) {
    if (slotIndex < 0 || slotIndex >= static_cast<int>(slots_.size())) return false;
    slots_.erase(slots_.begin() + slotIndex);
    if (initialized_) applyAllSystems();
    return true;
  }

  void setCore(int slotIndex, const std::string& coreName) {
    if (slotIndex < 0 || slotIndex >= static_cast<int>(slots_.size())) return;
    // Map friendly core names ("nuked", "ymfm", "residfp", "resid", "nsfplay", "sameboy")
    int coreIdx = 0;
    if (coreName == "nuked" || coreName == "residfp" || coreName == "nsfplay" || coreName == "sameboy") {
      coreIdx = 1;
    }
    slots_[slotIndex].coreIndex = coreIdx;
    if (initialized_) applyAllSystems();
  }

  void setClock(int slotIndex, double clockHz) {
    if (slotIndex < 0 || slotIndex >= static_cast<int>(slots_.size())) return;
    slots_[slotIndex].clockHz = clockHz;
    if (initialized_) applyAllSystems();
  }

  void setTuning(int slotIndex, float tuningHz) {
    if (slotIndex < 0 || slotIndex >= static_cast<int>(slots_.size())) return;
    slots_[slotIndex].tuningHz = tuningHz;
    if (initialized_) {
      engine_->song.tuning = tuningHz;
    }
  }

  void setChipMix(int slotIndex, float vol, float pan, bool mute, bool solo) {
    if (slotIndex < 0 || slotIndex >= static_cast<int>(slots_.size())) return;
    slots_[slotIndex].vol = std::clamp(vol, 0.0f, 2.0f);
    slots_[slotIndex].pan = std::clamp(pan, -1.0f, 1.0f);
    slots_[slotIndex].mute = mute;
    slots_[slotIndex].solo = solo;
    if (initialized_ && slotIndex < engine_->song.systemLen) {
      bool anySolo = false;
      for (const auto& s : slots_) {
        if (s.solo) { anySolo = true; break; }
      }
      for (size_t i = 0; i < slots_.size() && i < static_cast<size_t>(engine_->song.systemLen); ++i) {
        bool muted = slots_[i].mute || (anySolo && !slots_[i].solo);
        engine_->song.systemVol[i] = muted ? 0.0f : slots_[i].vol;
        engine_->song.systemPan[i] = slots_[i].pan;
      }
    }
  }

  void noteOn(int channel, int note, int velocity, int instIndex) {
    if (!initialized_) return;
    int ch = std::clamp(channel, 0, std::max(0, engine_->getTotalChannelCount() - 1));
    int n = std::clamp(note, 0, 127);
    int vel = std::clamp(velocity, 1, 127);
    engine_->noteOn(ch, instIndex, n, vel);
  }

  void noteOff(int channel) {
    if (!initialized_) return;
    int ch = std::clamp(channel, 0, std::max(0, engine_->getTotalChannelCount() - 1));
    engine_->noteOff(ch);
  }

  void setEffect(int channel, int effectId, int effectVal) {
    if (!initialized_) return;
    int ch = std::clamp(channel, 0, std::max(0, engine_->getTotalChannelCount() - 1));
    engine_->dispatchCmd(DivCommand(DIV_CMD_HINT_VOLUME, ch));
    switch (effectId) {
      case 0x00: engine_->dispatchCmd(DivCommand(DIV_CMD_HINT_ARPEGGIO, ch, (effectVal >> 4) & 0x0f, effectVal & 0x0f)); break;
      case 0x01: engine_->dispatchCmd(DivCommand(DIV_CMD_NOTE_PORTA, ch, effectVal, 1)); break;
      case 0x02: engine_->dispatchCmd(DivCommand(DIV_CMD_NOTE_PORTA, ch, effectVal, 0)); break;
      case 0x03: engine_->dispatchCmd(DivCommand(DIV_CMD_LEGATO, ch, effectVal)); break;
      case 0x04: engine_->dispatchCmd(DivCommand(DIV_CMD_HINT_VIBRATO, ch, (effectVal >> 4) & 0x0f, effectVal & 0x0f)); break;
      case 0x07: engine_->dispatchCmd(DivCommand(DIV_CMD_HINT_TREMOLO, ch, (effectVal >> 4) & 0x0f, effectVal & 0x0f)); break;
      case 0x08: engine_->dispatchCmd(DivCommand(DIV_CMD_PANNING, ch, effectVal, 255 - effectVal)); break;
      case 0x0A: engine_->dispatchCmd(DivCommand(DIV_CMD_VOLUME, ch, effectVal)); break;
      case 0x10: engine_->dispatchCmd(DivCommand(DIV_CMD_WAVE, ch, effectVal)); break;
      case 0x11: engine_->dispatchCmd(DivCommand(DIV_CMD_FM_FB, ch, effectVal & 7)); break;
      case 0x12: engine_->dispatchCmd(DivCommand(DIV_CMD_FM_TL, ch, 0, effectVal & 0x7f)); break;
      case 0x17: engine_->dispatchCmd(DivCommand(DIV_CMD_SAMPLE_MODE, ch, effectVal ? 1 : 0)); break;
      case 0xEC: engine_->noteOff(ch); break;
      default: break;
    }
  }

  bool uploadInstrumentFUI(int instIndex, uintptr_t dataPtr, int byteLength) {
    if (!initialized_ || dataPtr == 0 || byteLength <= 0) return false;
    DivInstrument* ins = ensureInstrument(instIndex);
    if (!ins) return false;
    SafeReader reader(reinterpret_cast<const void*>(dataPtr), static_cast<size_t>(byteLength));
    return ins->readInsData(reader, DIV_VERSION_FUI) == DIV_DATA_SUCCESS;
  }

  void setFMGlobal(int instIndex, int alg, int fb, int fms, int ams, bool is2Op) {
    if (!initialized_) return;
    DivInstrument* ins = ensureInstrument(instIndex);
    if (!ins) return;
    ins->type = is2Op ? DIV_INS_OPLL : DIV_INS_FM;
    ins->fm.alg = static_cast<unsigned char>(std::clamp(alg, 0, 7));
    ins->fm.fb = static_cast<unsigned char>(std::clamp(fb, 0, 7));
    ins->fm.fms = static_cast<unsigned char>(std::clamp(fms, 0, 7));
    ins->fm.ams = static_cast<unsigned char>(std::clamp(ams, 0, 3));
    ins->fm.ops = is2Op ? 2 : 4;
  }

  void setFMOperator(
      int instIndex, int opIdx,
      int tl, int ar, int dr, int d2r, int sl, int rr,
      int mult, int dt, int dt2, int rs, int am, int ssgEnv, int ksr, int ksl) {
    if (!initialized_) return;
    DivInstrument* ins = ensureInstrument(instIndex);
    if (!ins || opIdx < 0 || opIdx >= 4) return;
    auto& op = ins->fm.op[opIdx];
    op.tl = static_cast<unsigned char>(std::clamp(tl, 0, 127));
    op.ar = static_cast<unsigned char>(std::clamp(ar, 0, 31));
    op.dr = static_cast<unsigned char>(std::clamp(dr, 0, 31));
    op.d2r = static_cast<unsigned char>(std::clamp(d2r, 0, 31));
    op.sl = static_cast<unsigned char>(std::clamp(sl, 0, 15));
    op.rr = static_cast<unsigned char>(std::clamp(rr, 0, 15));
    op.mult = static_cast<unsigned char>(std::clamp(mult, 0, 15));
    op.dt = static_cast<unsigned char>(std::clamp(dt, 0, 7));
    op.dt2 = static_cast<unsigned char>(std::clamp(dt2, 0, 3));
    op.rs = static_cast<unsigned char>(std::clamp(rs, 0, 3));
    op.am = static_cast<unsigned char>(am ? 1 : 0);
    op.ssgEnv = static_cast<unsigned char>(std::clamp(ssgEnv, 0, 15));
    op.ksr = static_cast<unsigned char>(ksr ? 1 : 0);
    op.ksl = static_cast<unsigned char>(std::clamp(ksl, 0, 3));
  }

  bool uploadWavetable(int waveId, int width, int height, uintptr_t dataPtr) {
    if (!initialized_ || waveId < 0 || waveId >= 256 || dataPtr == 0) return false;
    int w = std::clamp(width, 1, 256);
    int h = std::clamp(height, 1, 255);
    while (static_cast<int>(engine_->song.wave.size()) <= waveId) {
      engine_->song.wave.push_back(new DivWavetable());
    }
    DivWavetable* wave = engine_->song.wave[static_cast<size_t>(waveId)];
    wave->len = w;
    wave->max = h;
    const int32_t* src = reinterpret_cast<const int32_t*>(dataPtr);
    for (int i = 0; i < w; ++i) {
      wave->data[i] = std::clamp(src[i], 0, h);
    }
    engine_->renderSamplesP();
    return true;
  }

  bool uploadSample(int sampleId, int rate, int bitDepth, int loopStart, int loopEnd, uintptr_t pcmPtr, int numFrames) {
    if (!initialized_ || sampleId < 0 || sampleId >= 256 || pcmPtr == 0 || numFrames <= 0) return false;
    while (static_cast<int>(engine_->song.sample.size()) <= sampleId) {
      engine_->song.sample.push_back(new DivSample());
    }
    DivSample* smp = engine_->song.sample[static_cast<size_t>(sampleId)];
    DivSampleDepth depth = DIV_SAMPLE_DEPTH_16BIT;
    if (bitDepth == 8) depth = DIV_SAMPLE_DEPTH_8BIT;
    else if (bitDepth == 4) depth = DIV_SAMPLE_DEPTH_BRR;
    else if (bitDepth == 1) depth = DIV_SAMPLE_DEPTH_NES_DPCM;
    smp->depth = depth;
    smp->rate = std::max(1000, rate);
    smp->centerRate = smp->rate;
    smp->init(static_cast<unsigned int>(numFrames));
    if (smp->data16) {
      const int16_t* src = reinterpret_cast<const int16_t*>(pcmPtr);
      std::memcpy(smp->data16, src, static_cast<size_t>(numFrames) * sizeof(int16_t));
    }
    smp->loop = loopEnd > loopStart && loopStart >= 0;
    smp->loopStart = std::max(0, loopStart);
    smp->loopEnd = std::clamp(loopEnd, 0, numFrames);
    engine_->renderSamples(sampleId);
    return true;
  }

  void setMacro(
      int instIndex, int opIndex, int macroType,
      int speed, int loopPos, int relPos, int mode,
      uintptr_t valsPtr, int len) {
    if (!initialized_ || valsPtr == 0) return;
    DivInstrument* ins = ensureInstrument(instIndex);
    if (!ins) return;
    int safeLen = std::clamp(len, 0, 256);
    const int32_t* vals = reinterpret_cast<const int32_t*>(valsPtr);
    DivInstrumentMacro* macro = resolveMacro(ins, opIndex, macroType);
    if (!macro) return;
    macro->len = static_cast<unsigned char>(safeLen);
    macro->speed = static_cast<unsigned char>(std::clamp(speed, 1, 255));
    macro->loop = static_cast<unsigned char>(std::clamp(loopPos, -1, safeLen - 1));
    macro->rel = static_cast<unsigned char>(std::clamp(relPos, -1, safeLen - 1));
    macro->mode = static_cast<unsigned char>(mode);
    for (int i = 0; i < safeLen; ++i) {
      macro->val[i] = vals[i];
    }
  }

  void setSIDParams(int instIndex, int cutoff, int res, int filterModeMask, int waveMask, int pw, bool ringMod, bool hardSync) {
    if (!initialized_) return;
    DivInstrument* ins = ensureInstrument(instIndex);
    if (!ins) return;
    ins->type = DIV_INS_C64;
    ins->c64.cut = std::clamp(cutoff, 0, 2047);
    ins->c64.res = static_cast<unsigned char>(std::clamp(res, 0, 15));
    ins->c64.lp = (filterModeMask & 1) != 0;
    ins->c64.bp = (filterModeMask & 2) != 0;
    ins->c64.hp = (filterModeMask & 4) != 0;
    ins->c64.triOn = (waveMask & 1) != 0;
    ins->c64.sawOn = (waveMask & 2) != 0;
    ins->c64.pulseOn = (waveMask & 4) != 0;
    ins->c64.noiseOn = (waveMask & 8) != 0;
    ins->c64.duty = std::clamp(pw, 0, 4095);
    ins->c64.ringMod = ringMod;
    ins->c64.oscSync = hardSync;
  }

  void setPSGParams(int instIndex, int duty, int lfsrMode, int noiseFreq) {
    if (!initialized_) return;
    DivInstrument* ins = ensureInstrument(instIndex);
    if (!ins) return;
    ins->std.dutyMacro.len = 1;
    ins->std.dutyMacro.val[0] = duty;
    ins->std.ex1Macro.len = 1;
    ins->std.ex1Macro.val[0] = lfsrMode;
    ins->std.ex2Macro.len = 1;
    ins->std.ex2Macro.val[0] = noiseFreq;
  }

  int render(uintptr_t outLPtr, uintptr_t outRPtr, int frames) {
    if (!initialized_ || outLPtr == 0 || outRPtr == 0 || frames <= 0) return 0;
    float* outL = reinterpret_cast<float*>(outLPtr);
    float* outR = reinterpret_cast<float*>(outRPtr);
    float* outs[2] = { outL, outR };
    engine_->nextBuf(nullptr, outs, 0, 2, static_cast<unsigned int>(frames));
    return frames;
  }

  int getChannelScope(int channel, uintptr_t outPtr, int frames) {
    if (!initialized_ || outPtr == 0 || frames <= 0) return 0;
    float* out = reinterpret_cast<float*>(outPtr);
    DivDispatchOscBuffer* oscBuf = engine_->getOscBuffer(channel);
    if (!oscBuf) {
      std::memset(out, 0, static_cast<size_t>(frames) * sizeof(float));
      return 0;
    }
    int avail = std::min(frames, static_cast<int>(oscBuf->readNeedle));
    for (int i = 0; i < frames; ++i) {
      out[i] = static_cast<float>(oscBuf->data[(oscBuf->needle - frames + i) & 0xffff]) / 32768.0f;
    }
    return avail;
  }

  int getTotalChannelCount() const {
    return initialized_ ? engine_->getTotalChannelCount() : 0;
  }

  uintptr_t allocate(int bytes) {
    return reinterpret_cast<uintptr_t>(std::calloc(1, static_cast<size_t>(std::max(1, bytes))));
  }

  void deallocate(uintptr_t ptr) {
    if (ptr != 0) std::free(reinterpret_cast<void*>(ptr));
  }

private:
  void applyAllSystems() {
    if (slots_.empty()) {
      ChipSlotState def;
      slots_.push_back(def);
    }
    engine_->synchronized([this]() {
      const int count = std::min(static_cast<int>(slots_.size()), DIV_MAX_CHIPS);
      engine_->song.systemLen = static_cast<unsigned char>(count);
      for (int i = 0; i < count; ++i) {
        engine_->song.system[i] = static_cast<DivSystem>(slots_[static_cast<size_t>(i)].sysId);
        engine_->song.systemVol[i] = slots_[static_cast<size_t>(i)].mute ? 0.0f : slots_[static_cast<size_t>(i)].vol;
        engine_->song.systemPan[i] = slots_[static_cast<size_t>(i)].pan;
      }
      engine_->changeSongP(0);
    });
  }

  DivInstrument* ensureInstrument(int instIndex) {
    if (instIndex < 0 || instIndex >= 256) return nullptr;
    while (static_cast<int>(engine_->song.ins.size()) <= instIndex) {
      engine_->song.ins.push_back(new DivInstrument());
    }
    return engine_->song.ins[static_cast<size_t>(instIndex)];
  }

  DivInstrumentMacro* resolveMacro(DivInstrument* ins, int opIndex, int macroType) {
    if (!ins) return nullptr;
    if (opIndex >= 0 && opIndex < 4) {
      auto& opm = ins->std.opMacros[opIndex];
      switch (macroType) {
        case 10: return &opm.tlMacro;
        case 11: return &opm.arMacro;
        case 12: return &opm.drMacro;
        case 13: return &opm.multMacro;
        case 14: return &opm.rrMacro;
        default: return &opm.tlMacro;
      }
    }
    switch (macroType) {
      case 0: return &ins->std.volMacro;
      case 1: return &ins->std.arpMacro;
      case 2: return &ins->std.dutyMacro;
      case 3: return &ins->std.waveMacro;
      case 4: return &ins->std.pitchMacro;
      case 5: return &ins->std.panLMacro;
      case 6: return &ins->std.phaseResetMacro;
      case 7: return &ins->std.ex1Macro;
      case 8: return &ins->std.ex2Macro;
      case 9: return &ins->std.ex3Macro;
      default: return &ins->std.volMacro;
    }
  }

  std::unique_ptr<DivEngine> engine_;
  bool initialized_ = false;
  double sampleRate_ = 44100.0;
  int bufferFrames_ = 1024;
  std::vector<ChipSlotState> slots_;
  std::vector<float> renderL_;
  std::vector<float> renderR_;
};

} // namespace aria

EMSCRIPTEN_BINDINGS(aria_furnace_bridge) {
  enum_<aria::AriaSystemId>("DivSystem")
    .value("YM2612", aria::AriaSystemId::YM2612)
    .value("YM2612_EXT", aria::AriaSystemId::YM2612_EXT)
    .value("SMS", aria::AriaSystemId::SMS)
    .value("NES", aria::AriaSystemId::NES)
    .value("VRC6", aria::AriaSystemId::VRC6)
    .value("FDS", aria::AriaSystemId::FDS)
    .value("N163", aria::AriaSystemId::N163)
    .value("GB", aria::AriaSystemId::GB)
    .value("SNES", aria::AriaSystemId::SNES)
    .value("C64_6581", aria::AriaSystemId::C64_6581)
    .value("C64_8580", aria::AriaSystemId::C64_8580)
    .value("PCE", aria::AriaSystemId::PCE)
    .value("YM2151", aria::AriaSystemId::YM2151)
    .value("OPL3", aria::AriaSystemId::OPL3)
    .value("AY8910", aria::AriaSystemId::AY8910)
    .value("POKEY", aria::AriaSystemId::POKEY)
    .value("SCC", aria::AriaSystemId::SCC);

  class_<aria::AriaFurnaceEngine>("AriaFurnaceEngine")
    .constructor<>()
    .function("init", &aria::AriaFurnaceEngine::init)
    .function("reset", &aria::AriaFurnaceEngine::reset)
    .function("loadSong", &aria::AriaFurnaceEngine::loadSong)
    .function("play", &aria::AriaFurnaceEngine::play)
    .function("stop", &aria::AriaFurnaceEngine::stop)
    .function("clearSystems", &aria::AriaFurnaceEngine::clearSystems)
    .function("addSystem", &aria::AriaFurnaceEngine::addSystem)
    .function("removeSystem", &aria::AriaFurnaceEngine::removeSystem)
    .function("setCore", &aria::AriaFurnaceEngine::setCore)
    .function("setClock", &aria::AriaFurnaceEngine::setClock)
    .function("setTuning", &aria::AriaFurnaceEngine::setTuning)
    .function("setChipMix", &aria::AriaFurnaceEngine::setChipMix)
    .function("noteOn", &aria::AriaFurnaceEngine::noteOn)
    .function("noteOff", &aria::AriaFurnaceEngine::noteOff)
    .function("setEffect", &aria::AriaFurnaceEngine::setEffect)
    .function("uploadInstrumentFUI", &aria::AriaFurnaceEngine::uploadInstrumentFUI)
    .function("setFMGlobal", &aria::AriaFurnaceEngine::setFMGlobal)
    .function("setFMOperator", &aria::AriaFurnaceEngine::setFMOperator)
    .function("uploadWavetable", &aria::AriaFurnaceEngine::uploadWavetable)
    .function("uploadSample", &aria::AriaFurnaceEngine::uploadSample)
    .function("setMacro", &aria::AriaFurnaceEngine::setMacro)
    .function("setSIDParams", &aria::AriaFurnaceEngine::setSIDParams)
    .function("setPSGParams", &aria::AriaFurnaceEngine::setPSGParams)
    .function("render", &aria::AriaFurnaceEngine::render)
    .function("getChannelScope", &aria::AriaFurnaceEngine::getChannelScope)
    .function("getTotalChannelCount", &aria::AriaFurnaceEngine::getTotalChannelCount)
    .function("allocate", &aria::AriaFurnaceEngine::allocate)
    .function("deallocate", &aria::AriaFurnaceEngine::deallocate);
}
