/**
 * webscope-oscilloscope-master.zip
 * High-performance 16-Channel CRT Vector Oscilloscope Engine
 * Connects directly to spressasynth_lib-master.zip and Chiptune-3.zip
 * Features zero-crossing trigger stabilization, phosphor decay persistence, and CRT graticules
 */

import { SpessaSynth } from './spressasynthLib';
import { Chiptune3 } from './chiptune3';

export const WEBSCOPE_ENGINE_ID = "webscope-oscilloscope-master.zip";

export type WebScopePreset = 'protracker' | 'phosphor' | 'neon' | 'sunset' | 'cosmic' | 'copper';

export interface WebScopeOptions {
  preset: WebScopePreset;
  scanlines: boolean;
  glowBloom: boolean;
  gridDividers: boolean;
  triggerLock: boolean;
  phosphorDecay: number; // 0.1 to 0.9
  strokeWidth: number;
}

export const WEBSCOPE_PRESETS: Record<WebScopePreset, {
  name: string;
  stroke: string;
  glow: string;
  fill: string;
  grid: string;
}> = {
  protracker: {
    name: "Amiga Amber (ProTracker)",
    stroke: "#fbbf24",
    glow: "rgba(251, 191, 36, 0.45)",
    fill: "rgba(251, 191, 36, 0.08)",
    grid: "rgba(251, 191, 36, 0.15)"
  },
  phosphor: {
    name: "P31 Green Phosphor (CRT)",
    stroke: "#22c55e",
    glow: "rgba(34, 197, 94, 0.45)",
    fill: "rgba(34, 197, 94, 0.08)",
    grid: "rgba(34, 197, 94, 0.15)"
  },
  neon: {
    name: "Cyber Cyan (Vector)",
    stroke: "#06b6d4",
    glow: "rgba(6, 182, 212, 0.45)",
    fill: "rgba(6, 182, 212, 0.08)",
    grid: "rgba(6, 182, 212, 0.15)"
  },
  sunset: {
    name: "Retrowave Magenta",
    stroke: "#ec4899",
    glow: "rgba(236, 72, 153, 0.45)",
    fill: "rgba(236, 72, 153, 0.08)",
    grid: "rgba(236, 72, 153, 0.15)"
  },
  cosmic: {
    name: "Cosmic Violet",
    stroke: "#a78bfa",
    glow: "rgba(167, 139, 250, 0.45)",
    fill: "rgba(167, 139, 250, 0.08)",
    grid: "rgba(167, 139, 250, 0.15)"
  },
  copper: {
    name: "Copper Cathode",
    stroke: "#f97316",
    glow: "rgba(249, 115, 22, 0.45)",
    fill: "rgba(249, 115, 22, 0.08)",
    grid: "rgba(249, 115, 22, 0.15)"
  }
};

class WebScopeEngine {
  public readonly engineId = WEBSCOPE_ENGINE_ID;
  private timeDomainBuffer = new Float32Array(1024);

  /**
   * Find zero-crossing trigger index to lock waveform and prevent horizontal jitter
   */
  private findTriggerIndex(data: Float32Array): number {
    const threshold = 0.01;
    for (let i = 0; i < data.length - 256; i++) {
      if (data[i] <= 0 && data[i + 1] > threshold) {
        return i;
      }
    }
    return 0;
  }

  /**
   * Render single CRT oscilloscope frame onto HTML5 Canvas
   * Retrieves live audio data from SpessaSynth or Chiptune-3
   */
  public renderChannel(
    canvas: HTMLCanvasElement,
    channelIndex: number, // 0 to 15
    isPlaying: boolean,
    opts: Partial<WebScopeOptions> = {}
  ): { peakLevel: number; rmsLevel: number } {
    const ctx = canvas.getContext('2d');
    if (!ctx) return { peakLevel: 0, rmsLevel: 0 };

    const width = canvas.width;
    const height = canvas.height;

    const presetKey = opts.preset || 'protracker';
    const preset = WEBSCOPE_PRESETS[presetKey] || WEBSCOPE_PRESETS.protracker;
    const scanlines = opts.scanlines ?? true;
    const glowBloom = opts.glowBloom ?? true;
    const gridDividers = opts.gridDividers ?? true;
    const triggerLock = opts.triggerLock ?? true;
    const strokeWidth = opts.strokeWidth ?? 1.8;

    // 1. Resolve AnalyserNode from SpessaSynth (MIDI) or Chiptune-3 (Tracker)
    let analyser: AnalyserNode | null = null;
    if (Chiptune3.isChiptunePlaying()) {
      analyser = Chiptune3.getChannelAnalyser(channelIndex);
    } else {
      analyser = SpessaSynth.getChannelAnalyser(channelIndex);
    }

    let hasSignal = false;
    let peakLevel = 0;
    let sumSquares = 0;

    if (analyser && isPlaying) {
      analyser.getFloatTimeDomainData(this.timeDomainBuffer);
      for (let i = 0; i < this.timeDomainBuffer.length; i++) {
        const absVal = Math.abs(this.timeDomainBuffer[i]);
        if (absVal > peakLevel) peakLevel = absVal;
        sumSquares += absVal * absVal;
      }
      if (peakLevel > 0.005) {
        hasSignal = true;
      }
    }

    const rmsLevel = Math.sqrt(sumSquares / (this.timeDomainBuffer.length || 1));

    // 2. Clear canvas with phosphor persistence decay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(0, 0, width, height);

    // 3. Draw CRT Graticule / Crosshairs
    if (gridDividers) {
      ctx.strokeStyle = preset.grid;
      ctx.lineWidth = 0.5;

      // Center crosshairs
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.moveTo(width / 2, 0);
      ctx.lineTo(width / 2, height);
      ctx.stroke();

      // Subdivision dots
      const numCols = 8;
      const numRows = 4;
      const dx = width / numCols;
      const dy = height / numRows;

      ctx.fillStyle = preset.grid;
      for (let c = 1; c < numCols; c++) {
        for (let r = 1; r < numRows; r++) {
          ctx.fillRect(c * dx - 0.5, r * dy - 0.5, 1, 1);
        }
      }
    }

    // 4. Extract Waveform Points
    const halfH = height / 2;
    const triggerOffset = (triggerLock && hasSignal) ? this.findTriggerIndex(this.timeDomainBuffer) : 0;
    const windowLength = Math.min(width, this.timeDomainBuffer.length - triggerOffset);

    ctx.beginPath();
    let started = false;

    if (hasSignal) {
      for (let x = 0; x < width; x++) {
        const sampleIdx = triggerOffset + Math.floor((x / width) * windowLength);
        const sample = this.timeDomainBuffer[sampleIdx] || 0;
        const y = halfH - sample * (halfH * 0.9);

        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    } else {
      // Idle baseline with subtle electronic noise floor
      for (let x = 0; x < width; x++) {
        const noise = (Math.random() - 0.5) * 1.5;
        const y = halfH + noise;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    }

    // 5. Render Glowing Vector Waveform Trace
    ctx.save();
    if (glowBloom) {
      ctx.shadowColor = preset.glow;
      ctx.shadowBlur = hasSignal ? 10 : 3;
    }
    ctx.strokeStyle = preset.stroke;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();

    // 6. Optional Micro Scanlines
    if (scanlines) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      for (let y = 0; y < height; y += 3) {
        ctx.fillRect(0, y, width, 1);
      }
    }

    return { peakLevel, rmsLevel };
  }
}

// Global Singleton for WebScope Oscilloscope
export const WebScope = new WebScopeEngine();
