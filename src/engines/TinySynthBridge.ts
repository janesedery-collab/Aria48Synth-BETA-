/**
 * TinySynthBridge.ts
 * Dedicated adapter preserving `webaudio-tinysynth`'s native Web Audio oscillators
 * for lightweight General MIDI playback, routed into MasterAudioRouter alongside WASM engines.
 */

// @ts-ignore
import WebAudioTinySynth from 'webaudio-tinysynth';

export const TINYSYNTH_ENGINE_ID = 'webaudio-tinysynth-gm';

class TinySynthBridgeEngine {
  public readonly engineId = TINYSYNTH_ENGINE_ID;
  private instance: any = null;
  private outputGain: GainNode | null = null;
  private enabled = true;
  private ctx: AudioContext | null = null;

  public init(ctx: AudioContext, destinationBus?: AudioNode): any {
    this.ctx = ctx;
    if (!this.outputGain) {
      this.outputGain = ctx.createGain();
      this.outputGain.gain.setValueAtTime(this.enabled ? 0.55 : 0, ctx.currentTime);
    }
    if (destinationBus) {
      try { this.outputGain.disconnect(); } catch {}
      this.outputGain.connect(destinationBus);
    } else {
      try { this.outputGain.disconnect(); } catch {}
      this.outputGain.connect(ctx.destination);
    }

    if (!this.instance && typeof WebAudioTinySynth !== 'undefined') {
      const w = window as any;
      const OrigAC = w.AudioContext;
      const OrigWAC = w.webkitAudioContext;
      const SharedAC = function () { return ctx; } as any;
      w.AudioContext = SharedAC;
      w.webkitAudioContext = SharedAC;
      try {
        this.instance = new WebAudioTinySynth({ quality: 1, useReverb: 0, internalcontext: 0 });
      } finally {
        w.AudioContext = OrigAC;
        w.webkitAudioContext = OrigWAC;
      }
    }

    if (this.instance && this.outputGain) {
      this.instance.setAudioContext?.(ctx, this.outputGain);
      this.instance.setVoices?.(96);
      this.instance.setMasterVol?.(0.55);
    }
    return this.instance;
  }

  public bindExisting(instance: any, outputGain: GainNode | null, ctx: AudioContext, destinationBus?: AudioNode) {
    this.ctx = ctx;
    if (instance) this.instance = instance;
    if (outputGain) {
      this.outputGain = outputGain;
      if (destinationBus) {
        try { this.outputGain.disconnect(); } catch {}
        this.outputGain.connect(destinationBus);
      }
    }
  }

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (this.outputGain && this.ctx) {
      this.outputGain.gain.setValueAtTime(enabled ? 0.55 : 0, this.ctx.currentTime);
    }
    if (!enabled && this.instance) {
      for (let ch = 0; ch < 16; ch++) {
        try { this.instance.allSoundOff?.(ch); } catch {}
      }
    }
  }

  public noteOn(channel16: number, midiNote: number, velocity: number, program?: number) {
    if (!this.enabled || !this.instance) return;
    const ch = Math.max(0, Math.min(15, channel16));
    if (program !== undefined) {
      this.instance.send([0xc0 | ch, program & 0x7f]);
    }
    this.instance.send([0x90 | ch, midiNote & 0x7f, velocity & 0x7f]);
  }

  public noteOff(channel16: number, midiNote: number) {
    if (!this.instance) return;
    const ch = Math.max(0, Math.min(15, channel16));
    this.instance.send([0x80 | ch, midiNote & 0x7f, 0]);
  }

  public getInstance(): any {
    return this.instance;
  }

  public getOutputGain(): GainNode | null {
    return this.outputGain;
  }
}

export const TinySynthBridge = new TinySynthBridgeEngine();
