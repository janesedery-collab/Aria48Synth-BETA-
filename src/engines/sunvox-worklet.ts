/**
 * sunvox-worklet.ts
 * Dedicated AudioWorkletNode & Blob-URL AudioWorkletProcessor for SunVox WASM
 * `sv_audio_callback()` interleaved stereo PCM streaming into MasterAudioRouter.
 */

export const SUNVOX_PROCESSOR_NAME = 'aria-sunvox-processor';

const SUNVOX_WORKLET_CODE = `
class SunVoxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringSize = 32768;
    this.ringL = new Float32Array(this.ringSize);
    this.ringR = new Float32Array(this.ringSize);
    this.readPtr = 0;
    this.writePtr = 0;
    this.active = false;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === 'interleaved' && msg.pcm) {
        const pcm = msg.pcm;
        const frames = (pcm.length / 2) | 0;
        for (let i = 0; i < frames; i++) {
          this.ringL[this.writePtr] = pcm[i * 2];
          this.ringR[this.writePtr] = pcm[i * 2 + 1];
          this.writePtr = (this.writePtr + 1) & (this.ringSize - 1);
          if (this.writePtr === this.readPtr) {
            this.readPtr = (this.readPtr + 1) & (this.ringSize - 1);
          }
        }
        this.active = true;
      } else if (msg.type === 'clear') {
        this.readPtr = 0;
        this.writePtr = 0;
        this.ringL.fill(0);
        this.ringR.fill(0);
      } else if (msg.type === 'active') {
        this.active = !!msg.value;
      }
    };
  }

  availableSamples() {
    return (this.writePtr - this.readPtr) & (this.ringSize - 1);
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : outL;
    const frames = outL.length;
    const avail = this.availableSamples();

    for (let i = 0; i < frames; i++) {
      if (this.active && i < avail) {
        outL[i] = this.ringL[this.readPtr];
        outR[i] = this.ringR[this.readPtr];
        this.readPtr = (this.readPtr + 1) & (this.ringSize - 1);
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }
    if (this.active && this.availableSamples() < 2048) {
      this.port.postMessage({ type: 'need_frames', frames: 1024 });
    }
    return true;
  }
}

registerProcessor('${SUNVOX_PROCESSOR_NAME}', SunVoxProcessor);
`;

const registeredContexts = new WeakSet<AudioContext>();
let cachedBlobUrl: string | null = null;

export async function registerSunVoxWorklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return false;
  if (registeredContexts.has(ctx)) return true;
  try {
    if (!cachedBlobUrl) {
      cachedBlobUrl = URL.createObjectURL(new Blob([SUNVOX_WORKLET_CODE], { type: 'application/javascript' }));
    }
    await ctx.audioWorklet.addModule(cachedBlobUrl);
    registeredContexts.add(ctx);
    return true;
  } catch (err) {
    console.warn('SunVox AudioWorklet registration note:', err);
    return false;
  }
}

export interface SunVoxNodeHandle {
  node: AudioWorkletNode | null;
  pushInterleaved: (interleaved: Float32Array) => void;
  clear: () => void;
  setActive: (active: boolean) => void;
  dispose: () => void;
}

export async function createSunVoxNode(
  ctx: AudioContext,
  onNeedFrames?: (frames: number) => void
): Promise<SunVoxNodeHandle> {
  const ok = await registerSunVoxWorklet(ctx);
  if (!ok || typeof AudioWorkletNode === 'undefined') {
    return {
      node: null,
      pushInterleaved: () => {},
      clear: () => {},
      setActive: () => {},
      dispose: () => {},
    };
  }
  const node = new AudioWorkletNode(ctx, SUNVOX_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  node.port.onmessage = (ev) => {
    if (ev.data?.type === 'need_frames' && onNeedFrames) {
      onNeedFrames(ev.data.frames || 1024);
    }
  };
  return {
    node,
    pushInterleaved: (interleaved) => {
      const copy = new Float32Array(interleaved);
      node.port.postMessage({ type: 'interleaved', pcm: copy }, [copy.buffer]);
    },
    clear: () => node.port.postMessage({ type: 'clear' }),
    setActive: (value) => node.port.postMessage({ type: 'active', value }),
    dispose: () => {
      try {
        node.port.onmessage = null;
        node.disconnect();
      } catch {}
    },
  };
}
