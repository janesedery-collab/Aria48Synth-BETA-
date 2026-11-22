/**
 * furnace-worklet.ts
 * Real AudioWorkletNode + Blob-URL AudioWorkletProcessor for the Furnace WASM Engine (DivEngine).
 * Receives cycle-accurate stereo PCM rendered by C++/Emscripten WASM (`aria_furnace_all.js`)
 * inside a lock-free ring buffer. Never synthesizes fallback Web Audio oscillators.
 */

export const FURNACE_PROCESSOR_NAME = 'aria-furnace-processor';

const FURNACE_WORKLET_CODE = `
class AriaFurnaceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringSize = 32768;
    this.ringL = new Float32Array(this.ringSize);
    this.ringR = new Float32Array(this.ringSize);
    this.readPtr = 0;
    this.writePtr = 0;
    this.active = false;
    this.underruns = 0;

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
    if (!this.active || avail < frames) {
      for (let i = 0; i < frames; i++) {
        if (i < avail && this.active) {
          outL[i] = this.ringL[this.readPtr];
          outR[i] = this.ringR[this.readPtr];
          this.readPtr = (this.readPtr + 1) & (this.ringSize - 1);
        } else {
          outL[i] = 0;
          outR[i] = 0;
        }
      }
      if (this.active && avail < frames * 4) {
        this.port.postMessage({ type: 'need_frames', missing: 1024 });
      }
      return true;
    }

    for (let i = 0; i < frames; i++) {
      outL[i] = this.ringL[this.readPtr];
      outR[i] = this.ringR[this.readPtr];
      this.readPtr = (this.readPtr + 1) & (this.ringSize - 1);
    }

    if (this.availableSamples() < 2048) {
      this.port.postMessage({ type: 'need_frames', missing: 1024 });
    }
    return true;
  }
}

registerProcessor('${FURNACE_PROCESSOR_NAME}', AriaFurnaceProcessor);
`;

const registeredContexts = new WeakSet<AudioContext>();
const registrationPromises = new WeakMap<AudioContext, Promise<void>>();
let cachedBlobUrl: string | null = null;

function getFurnaceWorkletBlobUrl(): string {
  if (!cachedBlobUrl) {
    const blob = new Blob([FURNACE_WORKLET_CODE], { type: 'application/javascript' });
    cachedBlobUrl = URL.createObjectURL(blob);
  }
  return cachedBlobUrl;
}

export async function registerFurnaceWorklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return false;
  if (registeredContexts.has(ctx)) return true;

  let existing = registrationPromises.get(ctx);
  if (!existing) {
    const url = getFurnaceWorkletBlobUrl();
    existing = ctx.audioWorklet
      .addModule(url)
      .then(() => {
        registeredContexts.add(ctx);
      })
      .finally(() => {
        registrationPromises.delete(ctx);
      });
    registrationPromises.set(ctx, existing);
  }

  try {
    await existing;
    return true;
  } catch (err) {
    console.warn('Furnace AudioWorklet module load warning:', err);
    return false;
  }
}

export interface AriaFurnaceNodeHandle {
  node: AudioWorkletNode | null;
  pushFrames: (left: Float32Array, right: Float32Array) => void;
  clear: () => void;
  setActive: (active: boolean) => void;
  dispose: () => void;
}

export async function createAriaFurnaceNode(
  ctx: AudioContext,
  onNeedFrames?: (missing: number) => void
): Promise<AriaFurnaceNodeHandle> {
  const registered = await registerFurnaceWorklet(ctx);
  if (!registered || typeof AudioWorkletNode === 'undefined') {
    return {
      node: null,
      pushFrames: () => {},
      clear: () => {},
      setActive: () => {},
      dispose: () => {},
    };
  }

  const node = new AudioWorkletNode(ctx, FURNACE_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  node.port.onmessage = (ev) => {
    if (ev.data?.type === 'need_frames' && onNeedFrames) {
      onNeedFrames(ev.data.missing || 1024);
    }
  };

  return {
    node,
    pushFrames: (left: Float32Array, right: Float32Array) => {
      const lCopy = new Float32Array(left);
      const rCopy = new Float32Array(right);
      node.port.postMessage({ type: 'pcm', left: lCopy, right: rCopy }, [lCopy.buffer, rCopy.buffer]);
    },
    clear: () => {
      node.port.postMessage({ type: 'clear' });
    },
    setActive: (value: boolean) => {
      node.port.postMessage({ type: 'active', value });
    },
    dispose: () => {
      try {
        node.port.onmessage = null;
        node.disconnect();
      } catch {}
    },
  };
}
