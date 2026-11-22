/**
 * SpessaSynthBridge.ts
 * Unified adapter wrapping `spessasynth_core` (`SpessaSynth`) and `spessasynth_lib` (`WorkletSynthBridge`)
 * for .sf2 / .sf3 / .sfe / .dls SoundBank playback, MIDI parsing, and routing into MasterAudioRouter.
 */

import { SpessaSynth, SPRESSASYNTH_ENGINE_ID } from './spressasynthLib';
import {
  SpessaSynthCore,
  SPRESSASYNTH_CORE_ENGINE_ID,
  SOUNDFONT_ACCEPT_ATTR,
  isSoundFontFileName,
} from './spressasynthCore';
import { WorkletSynthBridge } from './workletSynthBridge';

export {
  SpessaSynth,
  SPRESSASYNTH_ENGINE_ID,
  SpessaSynthCore,
  SPRESSASYNTH_CORE_ENGINE_ID,
  SOUNDFONT_ACCEPT_ATTR,
  isSoundFontFileName,
  WorkletSynthBridge,
};

class SpessaSynthBridgeAdapter {
  public readonly engineId = 'aria-spessasynth-bridge';
  private initialized = false;

  public async attachToMasterRouter(ctx: AudioContext, destinationBus: AudioNode): Promise<void> {
    if (!this.initialized) {
      SpessaSynth.init(ctx);
      await WorkletSynthBridge.init(ctx);
      this.initialized = true;
    }

    SpessaSynth.routeOutputTo(destinationBus);
    WorkletSynthBridge.routeOutputTo(destinationBus);
  }

  public isWorkletPrimary(): boolean {
    const activeSf = SpessaSynth.getActiveSoundFont();
    if (!activeSf?.isCustom) return false;
    return WorkletSynthBridge.isActiveBankSupportedByWorklet() && WorkletSynthBridge.hasCustomSoundBankActive();
  }

  public async addSoundBank(arrayBuffer: ArrayBuffer, fileName: string) {
    const copy = arrayBuffer.slice(0);
    const { soundFont, coreResult } = await SpessaSynth.loadSoundFontAsync(arrayBuffer, fileName);
    await WorkletSynthBridge.loadSoundBank(copy, soundFont.id, true);
    return { soundFont, coreResult };
  }

  public noteOn(channelIndex0: number, midiNote: number, velocity: number, durationSec = 0.25, program?: number) {
    if (this.isWorkletPrimary()) {
      const ch = Math.max(0, Math.min(47, channelIndex0));
      if (program !== undefined) WorkletSynthBridge.programChange(ch, program);
      WorkletSynthBridge.noteOn(ch, midiNote, velocity);
      setTimeout(() => WorkletSynthBridge.noteOff(ch, midiNote), Math.max(30, durationSec * 1000));
    } else {
      const ch = Math.max(0, Math.min(15, channelIndex0 % 16));
      if (program !== undefined) SpessaSynth.setChannelProgram(ch, program);
      SpessaSynth.noteOn(ch, midiNote, velocity, durationSec);
    }
  }

  public noteOff(channelIndex0: number, midiNote?: number) {
    const ch16 = Math.max(0, Math.min(15, channelIndex0 % 16));
    SpessaSynth.noteOff(ch16, midiNote);
    if (midiNote !== undefined) {
      WorkletSynthBridge.noteOff(Math.max(0, Math.min(47, channelIndex0)), midiNote);
    }
  }
}

export const SpessaSynthAdapter = new SpessaSynthBridgeAdapter();
