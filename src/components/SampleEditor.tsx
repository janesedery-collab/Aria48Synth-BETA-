import React, { useState, useEffect, useRef } from 'react';
import { Upload, AudioLines } from 'lucide-react';
import { FurnaceBridge, FurnaceRuntimeState, SampleBitDepth } from '../engines/FurnaceBridge';

export default function SampleEditor() {
  const [state, setState] = useState<FurnaceRuntimeState>(() => FurnaceBridge.getState());
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    return FurnaceBridge.subscribe(setState);
  }, []);

  const sample = state.samples[state.activeSampleIndex] || null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(63,63,70,0.45)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!sample || sample.pcm16.length === 0) return;

    const len = sample.pcm16.length;
    if (sample.loopEnable && sample.loopEnd > sample.loopStart) {
      const lx = (sample.loopStart / len) * w;
      const rx = (sample.loopEnd / len) * w;
      ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
      ctx.fillRect(lx, 0, Math.max(2, rx - lx), h);
    }

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(len / w));
    for (let x = 0; x < w; x++) {
      const idx = Math.min(len - 1, x * step);
      const val = sample.pcm16[idx] / 32768;
      const y = h / 2 - val * (h * 0.44);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [sample]);

  const handleLoadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (ev.target?.result instanceof ArrayBuffer) {
        FurnaceBridge.importSampleFile(ev.target.result, file.name);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  return (
    <div id="furnace-sample-editor" className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex flex-col gap-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <AudioLines size={15} className="text-sky-400" />
          <span className="font-bold text-zinc-100">Sample / PCM / BRR / DPCM Bank</span>
          <span className="text-zinc-500">·</span>
          <span className="text-zinc-400 tabular-nums">{state.samples.length} Loaded</span>
        </div>

        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".wav,.dmc,.brr"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleLoadFile(f);
              e.target.value = '';
            }}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-semibold cursor-pointer"
          >
            <Upload size={13} />
            <span>Load .WAV / .DMC / .BRR</span>
          </button>
        </div>
      </div>

      {/* Bank Selector Pills */}
      {state.samples.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {state.samples.map((s, idx) => (
            <button
              key={s.id}
              type="button"
              onClick={() => FurnaceBridge.setActiveSample(idx)}
              className={`px-2.5 py-1 rounded font-mono text-[11px] border cursor-pointer ${
                state.activeSampleIndex === idx
                  ? 'bg-sky-600 text-white border-sky-400'
                  : 'bg-zinc-950 text-zinc-300 border-zinc-800 hover:text-white'
              }`}
            >
              #{idx} {s.name} ({s.bitDepth}-bit)
            </button>
          ))}
        </div>
      )}

      {/* Waveform Preview */}
      <canvas
        ref={canvasRef}
        width={720}
        height={160}
        className="w-full h-40 rounded border border-zinc-800 bg-black"
      />

      {sample ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
            <span>Sample Rate (Hz)</span>
            <input
              type="number"
              min={2000}
              max={96000}
              value={sample.rate}
              onChange={(e) =>
                FurnaceBridge.updateSample(state.activeSampleIndex, {
                  rate: Math.max(2000, Number(e.target.value) || 16000),
                })
              }
              className="bg-black border border-zinc-800 rounded px-2 py-1.5 font-mono text-sky-300 tabular-nums"
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
            <span>Bit Depth / Format</span>
            <select
              value={sample.bitDepth}
              onChange={(e) =>
                FurnaceBridge.updateSample(state.activeSampleIndex, {
                  bitDepth: Number(e.target.value) as SampleBitDepth,
                })
              }
              className="bg-black border border-zinc-800 rounded px-2 py-1.5 font-mono text-zinc-200 cursor-pointer"
            >
              <option value={16}>16-bit PCM</option>
              <option value={8}>8-bit PCM</option>
              <option value={4}>4-bit SNES BRR</option>
              <option value={1}>1-bit NES DPCM</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
            <span>Loop Start ({sample.loopStart})</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, sample.pcm16.length - 1)}
              value={sample.loopStart}
              onChange={(e) =>
                FurnaceBridge.updateSample(state.activeSampleIndex, {
                  loopEnable: true,
                  loopStart: Number(e.target.value),
                })
              }
              className="accent-emerald-500 cursor-pointer"
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
            <span>Loop End ({sample.loopEnd})</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, sample.pcm16.length - 1)}
              value={sample.loopEnd}
              onChange={(e) =>
                FurnaceBridge.updateSample(state.activeSampleIndex, {
                  loopEnable: true,
                  loopEnd: Number(e.target.value),
                })
              }
              className="accent-emerald-500 cursor-pointer"
            />
          </label>
        </div>
      ) : (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer?.files?.[0];
            if (f) handleLoadFile(f);
          }}
          className="p-6 border border-dashed border-zinc-700 rounded text-center text-zinc-400"
        >
          No hardware sample loaded yet. Load a <span className="font-mono text-zinc-200">.wav</span>,{' '}
          <span className="font-mono text-zinc-200">.dmc</span>, or{' '}
          <span className="font-mono text-zinc-200">.brr</span> file to decode and upload to Furnace WASM memory.
        </div>
      )}
    </div>
  );
}
