/**
 * tinyrsid-worklet.ts
 * Dedicated AudioWorkletNode & Blob-URL AudioWorkletProcessor for TinyRSid / WebSID WASM
 * Commodore 64 SID (6581 / 8580) stereo stream routing into MasterAudioRouter.
 */

export const TINYRSID_PROCESSOR_NAME = 'aria-tinyrsid-processor';

const TINYRSID_WORKLET_CODE = `
class TinyRsidProcessor extends AudioWorkletProcessor {
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
      if (msg.type === 'pcm' && msg.left && msg.right) {
        const l = msg.left;
        const r = msg.right;
        const len = Math.min(l.length, r.length);
        for (let i = 0; i < len; i++) {
          this.ringL[this.writePtr] = l[i];
          this.ringR[this.writePtr] = r[i];
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
    return true;
  }
}

registerProcessor('${TINYRSID_PROCESSOR_NAME}', TinyRsidProcessor);
`;

const registeredContexts = new WeakSet<AudioContext>();
let cachedBlobUrl: string | null = null;

export async function registerTinyRsidWorklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return false;
  if (registeredContexts.has(ctx)) return true;
  try {
    if (!cachedBlobUrl) {
      cachedBlobUrl = URL.createObjectURL(new Blob([TINYRSID_WORKLET_CODE], { type: 'application/javascript' }));
    }
    await ctx.audioWorklet.addModule(cachedBlobUrl);
    registeredContexts.add(ctx);
    return true;
  } catch (err) {
    console.warn('TinyRSID AudioWorklet registration note:', err);
    return false;
  }
}

export interface TinyRSIDNodeHandle {
  node: AudioWorkletNode | null;
  pushFrames: (left: Float32Array, right: Float32Array) => void;
  clear: () => void;
  setActive: (active: boolean) => void;
  dispose: () => void;
}

export async function createTinyRSIDNode(ctx: AudioContext): Promise<TinyRSIDNodeHandle> {
  const ok = await registerTinyRsidWorklet(ctx);
  if (!ok || typeof AudioWorkletNode === 'undefined') {
    return {
      node: null,
      pushFrames: () => {},
      clear: () => {},
      setActive: () => {},
      dispose: () => {},
    };
  }
  const node = new AudioWorkletNode(ctx, TINYRSID_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  return {
    node,
    pushFrames: (left, right) => {
      const l = new Float32Array(left);
      const r = new Float32Array(right);
      node.port.postMessage({ type: 'pcm', left: l, right: r }, [l.buffer, r.buffer]);
    },
    clear: () => node.port.postMessage({ type: 'clear' }),
    setActive: (value) => node.port.postMessage({ type: 'active', value }),
    dispose: () => {
      try { node.disconnect(); } catch {}
    },
  };
}
