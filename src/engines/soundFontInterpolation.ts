import { SoundFontInterpolationMode } from '../types';
import { getCookie, setCookie } from '../utils/cookieStorage';

export const COOKIE_INTERPOLATION_KEY = 'aria48_sf_interpolation';

export interface InterpolationModeInfo {
  id: SoundFontInterpolationMode;
  label: string;
  shortLabel: string;
  order: string;
  description: string;
}

export const INTERPOLATION_MODES: InterpolationModeInfo[] = [
  {
    id: 'none',
    label: 'None (Zero-Order Hold)',
    shortLabel: 'None (ZOH)',
    order: '0th',
    description: 'Raw stair-stepped sample hold with retro aliasing & crisp 8-bit/16-bit edge'
  },
  {
    id: 'linear',
    label: 'Linear',
    shortLabel: 'Linear',
    order: '1st',
    description: '2-point linear interpolation (classic SoundBlaster AWE32 / ProTracker warmth)'
  },
  {
    id: 'cubic',
    label: 'Cubic/Hermite',
    shortLabel: 'Cubic / Hermite',
    order: '3rd',
    description: '4-point Catmull-Rom Hermite spline (smooth hardware sampler clarity)'
  },
  {
    id: 'poly4',
    label: '4th-Order Polynomial',
    shortLabel: '4th-Order Poly',
    order: '4th',
    description: '5-point 4th-order Lagrange polynomial (flat passband & low distortion)'
  },
  {
    id: 'sinc',
    label: 'Windowed Sinc',
    shortLabel: 'Windowed Sinc',
    order: '16-Tap',
    description: '16-tap Blackman-windowed Sinc filter with band-limited anti-aliasing'
  }
];

let currentInterpolationMode: SoundFontInterpolationMode = (() => {
  try {
    const saved = getCookie(COOKIE_INTERPOLATION_KEY);
    if (
      saved === 'none' ||
      saved === 'linear' ||
      saved === 'cubic' ||
      saved === 'poly4' ||
      saved === 'sinc'
    ) {
      return saved;
    }
  } catch {}
  return 'cubic';
})();

const listeners: Array<(mode: SoundFontInterpolationMode) => void> = [];

export function getInterpolationMode(): SoundFontInterpolationMode {
  return currentInterpolationMode;
}

export function setInterpolationMode(mode: SoundFontInterpolationMode): void {
  if (currentInterpolationMode === mode) return;
  currentInterpolationMode = mode;
  try {
    setCookie(COOKIE_INTERPOLATION_KEY, mode, 365);
  } catch {}
  listeners.forEach(cb => {
    try { cb(mode); } catch {}
  });
}

export function onInterpolationModeChange(cb: (mode: SoundFontInterpolationMode) => void): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

// Track unique buffer IDs without retaining dead buffers
const bufferIdMap = new WeakMap<AudioBuffer, number>();
let nextBufferId = 1;
function getBufferId(buf: AudioBuffer): number {
  let id = bufferIdMap.get(buf);
  if (!id) {
    id = nextBufferId++;
    bufferIdMap.set(buf, id);
  }
  return id;
}

interface ResampledResult {
  buffer: AudioBuffer;
  loopStart?: number;
  loopEnd?: number;
}

const MAX_RESAMPLED_CACHE = 240;
const resampledCache = new Map<string, ResampledResult>();

export function clearInterpolationCache(): void {
  resampledCache.clear();
}

// Cache 256-phase x 16-tap Blackman-windowed Sinc LUTs keyed by quantized cutoff (1..64 -> cutoff = key/64)
const SINC_PHASES = 256;
const SINC_TAPS = 16;
const SINC_OFFSET_MIN = -7;
const sincLutByCutoff = new Map<number, Float32Array>();

function getSincLut(cutoffQuantized: number): Float32Array {
  const existing = sincLutByCutoff.get(cutoffQuantized);
  if (existing) return existing;

  const cutoff = Math.max(0.12, Math.min(1.0, cutoffQuantized / 64));
  const lut = new Float32Array(SINC_PHASES * SINC_TAPS);
  const halfWidth = SINC_TAPS / 2;

  for (let p = 0; p < SINC_PHASES; p++) {
    const frac = p / SINC_PHASES;
    let sum = 0;
    const rowBase = p * SINC_TAPS;
    for (let t = 0; t < SINC_TAPS; t++) {
      const m = SINC_OFFSET_MIN + t;
      const x = m - frac;
      const sx = x * cutoff;
      const sinc = Math.abs(sx) < 1e-7 ? 1.0 : Math.sin(Math.PI * sx) / (Math.PI * sx);
      const u = (x + halfWidth) / SINC_TAPS;
      const win =
        u >= 0 && u <= 1
          ? 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u)
          : 0;
      const w = sinc * win * cutoff;
      lut[rowBase + t] = w;
      sum += w;
    }
    if (sum > 1e-8) {
      const inv = 1 / sum;
      for (let t = 0; t < SINC_TAPS; t++) {
        lut[rowBase + t] *= inv;
      }
    }
  }

  sincLutByCutoff.set(cutoffQuantized, lut);
  return lut;
}

// Pre-warm unity-cutoff LUT
getSincLut(64);

function readSampleBounded(
  data: Float32Array,
  idx: number,
  hasLoop: boolean,
  loopStartIdx: number,
  loopEndIdx: number,
  loopLenIdx: number
): number {
  if (hasLoop && idx >= loopEndIdx && loopLenIdx > 0) {
    const wrapped = loopStartIdx + (((idx - loopStartIdx) % loopLenIdx) + loopLenIdx) % loopLenIdx;
    return data[wrapped] ?? 0;
  }
  if (idx >= 0 && idx < data.length) return data[idx];
  if (idx < 0) return data[0] ?? 0;
  return 0;
}

/**
 * Resample a SoundFont sample AudioBuffer to `ctx.sampleRate` using the active
 * DSP interpolation mode so `AudioBufferSourceNode` outputs exact interpolated PCM
 * at native 1:1 hardware playback rate.
 */
export function interpolateSampleBuffer(
  ctx: BaseAudioContext,
  sourceBuffer: AudioBuffer,
  pitchPlaybackRate: number,
  mode: SoundFontInterpolationMode = currentInterpolationMode,
  loopStartSec?: number,
  loopEndSec?: number
): ResampledResult {
  const targetSr = ctx.sampleRate || 44100;
  const safePitchRate = Math.max(0.0625, Math.min(16.0, pitchPlaybackRate || 1.0));
  const effStep = (sourceBuffer.sampleRate / targetSr) * safePitchRate;

  const hasValidLoop =
    loopStartSec !== undefined &&
    loopEndSec !== undefined &&
    loopEndSec > loopStartSec + 0.002 &&
    loopStartSec < sourceBuffer.duration;

  const bufId = getBufferId(sourceBuffer);
  const rateKey = Math.round(effStep * 10000);
  const loopKey = hasValidLoop
    ? `${Math.round((loopStartSec || 0) * 1000)}_${Math.round((loopEndSec || 0) * 1000)}`
    : 'nl';
  const cacheKey = `${bufId}:${mode}:${targetSr}:${rateKey}:${loopKey}`;

  const cached = resampledCache.get(cacheKey);
  if (cached) {
    // Refresh LRU order
    resampledCache.delete(cacheKey);
    resampledCache.set(cacheKey, cached);
    return cached;
  }

  const inLoopStart = hasValidLoop
    ? Math.max(0, Math.min(sourceBuffer.length - 1, Math.round((loopStartSec || 0) * sourceBuffer.sampleRate)))
    : 0;
  const inLoopEnd = hasValidLoop
    ? Math.max(inLoopStart + 2, Math.min(sourceBuffer.length, Math.round((loopEndSec || 0) * sourceBuffer.sampleRate)))
    : sourceBuffer.length;
  const inLoopLen = Math.max(1, inLoopEnd - inLoopStart);

  // Stop rendering once loop end is reached (Web Audio loops output cleanly back to outLoopStart)
  const effectiveInEnd = hasValidLoop ? inLoopEnd : sourceBuffer.length;
  const maxOutFrames = targetSr * (hasValidLoop ? 16 : 10);
  const desiredOutFrames = Math.max(64, Math.min(maxOutFrames, Math.ceil(effectiveInEnd / effStep)));

  const numChannels = Math.min(2, Math.max(1, sourceBuffer.numberOfChannels));
  const outBuf = ctx.createBuffer(numChannels, desiredOutFrames, targetSr);

  const sincCutoff = effStep > 1.0 ? Math.max(0.125, 1.0 / effStep) : 1.0;
  const sincCutoffQuantized = sincCutoff >= 0.99 ? 64 : Math.max(8, Math.min(63, Math.round(sincCutoff * 64)));
  const sincLut = mode === 'sinc' ? getSincLut(sincCutoffQuantized) : null;

  for (let ch = 0; ch < numChannels; ch++) {
    const inData = sourceBuffer.getChannelData(ch);
    const outData = outBuf.getChannelData(ch);

    if (mode === 'none') {
      // Zero-Order Hold: hold discrete input sample with no smoothing
      for (let i = 0; i < desiredOutFrames; i++) {
        const pos = i * effStep;
        const intPos = pos | 0;
        outData[i] = readSampleBounded(inData, intPos, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
      }
    } else if (mode === 'linear') {
      for (let i = 0; i < desiredOutFrames; i++) {
        const pos = i * effStep;
        const intPos = pos | 0;
        const frac = pos - intPos;
        const y0 = readSampleBounded(inData, intPos, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
        const y1 = readSampleBounded(inData, intPos + 1, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
        outData[i] = y0 + frac * (y1 - y0);
      }
    } else if (mode === 'cubic') {
      // 4-point 3rd-order Catmull-Rom Hermite spline
      for (let i = 0; i < desiredOutFrames; i++) {
        const pos = i * effStep;
        const intPos = pos | 0;
        const d = pos - intPos;
        const ym1 = readSampleBounded(inData, intPos - 1, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
        const y0 = readSampleBounded(inData, intPos, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
        const y1 = readSampleBounded(inData, intPos + 1, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
        const y2 = readSampleBounded(inData, intPos + 2, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);

        const c0 = y0;
        const c1 = 0.5 * (y1 - ym1);
        const c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
        const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
        const val = ((c3 * d + c2) * d + c1) * d + c0;
        outData[i] = val > 1.2 ? 1.2 : val < -1.2 ? -1.2 : val;
      }
    } else if (mode === 'poly4') {
      // 5-point 4th-order Lagrange polynomial interpolation
      for (let i = 0; i < desiredOutFrames; i++) {
        const pos = i * effStep;
        const intPos = pos | 0;
        const d = pos - intPos;

        const ym2 = readSampleBounded(inData, intPos - 2, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
        const ym1 = readSampleBounded(inData, intPos - 1, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
        const y0 = readSampleBounded(inData, intPos, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
        const y1 = readSampleBounded(inData, intPos + 1, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);
        const y2 = readSampleBounded(inData, intPos + 2, hasValidLoop, inLoopStart, inLoopEnd, inLoopLen);

        const dm1 = d - 1;
        const dp1 = d + 1;
        const dm2 = d - 2;
        const dp2 = d + 2;

        const wm2 = (d * dm1 * dp1 * dm2) * 0.041666666666666664; // / 24
        const wm1 = -(d * dm1 * dp2 * dm2) * 0.16666666666666666; // / 6
        const w0 = (dp2 * dp1 * dm1 * dm2) * 0.25; // / 4
        const wp1 = -(d * dp2 * dp1 * dm2) * 0.16666666666666666; // / 6
        const wp2 = (d * dp2 * dp1 * dm1) * 0.041666666666666664; // / 24

        const val = ym2 * wm2 + ym1 * wm1 + y0 * w0 + y1 * wp1 + y2 * wp2;
        outData[i] = val > 1.2 ? 1.2 : val < -1.2 ? -1.2 : val;
      }
    } else if (sincLut) {
      // Windowed Sinc (16-tap Blackman-windowed Sinc LUT with anti-aliasing cutoff scaling)
      for (let i = 0; i < desiredOutFrames; i++) {
        const pos = i * effStep;
        const intPos = pos | 0;
        const frac = pos - intPos;
        const phaseIdx = Math.min(SINC_PHASES - 1, (frac * SINC_PHASES) | 0);
        const lutBase = phaseIdx * SINC_TAPS;

        let acc = 0;
        for (let t = 0; t < SINC_TAPS; t++) {
          const s = readSampleBounded(
            inData,
            intPos + SINC_OFFSET_MIN + t,
            hasValidLoop,
            inLoopStart,
            inLoopEnd,
            inLoopLen
          );
          acc += s * sincLut[lutBase + t];
        }
        outData[i] = acc > 1.2 ? 1.2 : acc < -1.2 ? -1.2 : acc;
      }
    }
  }

  let outLoopStart: number | undefined = undefined;
  let outLoopEnd: number | undefined = undefined;
  if (hasValidLoop) {
    const startSec = inLoopStart / effStep / targetSr;
    const endSec = Math.min(outBuf.duration, inLoopEnd / effStep / targetSr);
    if (endSec > startSec + 0.002) {
      outLoopStart = startSec;
      outLoopEnd = endSec;
    }
  }

  const res: ResampledResult = {
    buffer: outBuf,
    loopStart: outLoopStart,
    loopEnd: outLoopEnd
  };

  if (resampledCache.size >= MAX_RESAMPLED_CACHE) {
    const oldestKey = resampledCache.keys().next().value;
    if (oldestKey !== undefined) resampledCache.delete(oldestKey);
  }
  resampledCache.set(cacheKey, res);

  return res;
}
