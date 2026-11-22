import React, { useState, useEffect, useRef } from 'react';
import { Upload, Download, Plus, Waves } from 'lucide-react';
import { FurnaceBridge, FurnaceRuntimeState } from '../engines/FurnaceBridge';

export default function WavetableEditor() {
  const [state, setState] = useState<FurnaceRuntimeState>(() => FurnaceBridge.getState());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const isDrawingRef = useRef(false);

  useEffect(() => {
    return FurnaceBridge.subscribe(setState);
  }, []);

  const wave = state.wavetables[state.activeWavetableIndex] || state.wavetables[0];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !wave) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = 'rgba(63, 63, 70, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const stepW = w / Math.max(1, wave.width);
    const maxH = Math.max(1, wave.height);
    for (let i = 0; i < wave.width; i++) {
      const val = wave.data[i] ?? 0;
      const norm = val / maxH;
      const barH = Math.max(2, norm * (h - 8));
      const x = i * stepW;
      const y = h - 4 - barH;
      ctx.fillStyle = i % 2 === 0 ? '#06b6d4' : '#22d3ee';
      ctx.fillRect(x + 0.5, y, Math.max(1, stepW - 1), barH);
    }
  }, [wave]);

  const paintAtClientPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !wave) return;
    const rect = canvas.getBoundingClientRect();
    const xRatio = Math.max(0, Math.min(0.9999, (clientX - rect.left) / rect.width));
    const yRatio = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    const stepIdx = Math.min(wave.width - 1, Math.floor(xRatio * wave.width));
    const value = Math.max(0, Math.min(wave.height, Math.round(yRatio * wave.height)));
    const nextData = [...wave.data];
    nextData[stepIdx] = value;
    FurnaceBridge.updateWavetable(state.activeWavetableIndex, { data: nextData });
  };

  const applyPreset = (kind: 'sine' | 'saw' | 'square' | 'tri' | 'organ' | 'noise') => {
    if (!wave) return;
    const w = wave.width;
    const h = wave.height;
    const data = Array.from({ length: w }, (_, i) => {
      const t = i / w;
      if (kind === 'sine') return Math.round(((Math.sin(t * Math.PI * 2) + 1) * 0.5) * h);
      if (kind === 'saw') return Math.round(t * h);
      if (kind === 'square') return t < 0.5 ? h : 0;
      if (kind === 'tri') return Math.round((t < 0.5 ? t * 2 : 2 - t * 2) * h);
      if (kind === 'organ') {
        const s = 0.5 * Math.sin(t * Math.PI * 2) + 0.3 * Math.sin(t * Math.PI * 4) + 0.2 * Math.sin(t * Math.PI * 6);
        return Math.max(0, Math.min(h, Math.round(((s + 1) * 0.5) * h)));
      }
      return Math.round(Math.random() * h);
    });
    FurnaceBridge.updateWavetable(state.activeWavetableIndex, { data });
  };

  const transformWave = (op: 'invert' | 'smooth' | 'normalize') => {
    if (!wave) return;
    let next = [...wave.data];
    if (op === 'invert') {
      next = next.map((v) => wave.height - v);
    } else if (op === 'smooth') {
      next = next.map((v, i) => {
        const prev = next[(i - 1 + next.length) % next.length];
        const nxt = next[(i + 1) % next.length];
        return Math.round((prev + v * 2 + nxt) / 4);
      });
    } else if (op === 'normalize') {
      const minV = Math.min(...next);
      const maxV = Math.max(...next);
      const span = Math.max(1, maxV - minV);
      next = next.map((v) => Math.round(((v - minV) / span) * wave.height));
    }
    FurnaceBridge.updateWavetable(state.activeWavetableIndex, { data: next });
  };

  const handleImportFUW = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (ev.target?.result instanceof ArrayBuffer) {
        FurnaceBridge.importFUW(ev.target.result, file.name);
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const handleExportFUW = () => {
    if (!wave) return;
    const bytes = FurnaceBridge.exportFUW(wave);
    const blob = new Blob([bytes.slice().buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${wave.name || 'wave'}.fuw`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div id="furnace-wavetable-editor" className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex flex-col gap-3 text-xs">
      {/* Top Bar: Wave Tabs + .FUW Import/Export */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-zinc-800">
        <div className="flex flex-wrap items-center gap-1.5">
          <Waves size={15} className="text-cyan-400" />
          {state.wavetables.map((w, idx) => (
            <button
              key={w.id}
              type="button"
              onClick={() => FurnaceBridge.setActiveWavetable(idx)}
              className={`px-2.5 py-1 rounded font-mono text-[11px] font-semibold border cursor-pointer ${
                state.activeWavetableIndex === idx
                  ? 'bg-cyan-600 text-white border-cyan-400'
                  : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-white'
              }`}
            >
              #{idx} {w.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => FurnaceBridge.addWavetable()}
            className="flex items-center gap-1 px-2 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 cursor-pointer"
          >
            <Plus size={12} />
            <span>New</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <input ref={importRef} type="file" accept=".fuw" onChange={handleImportFUW} className="hidden" />
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-cyan-300 border border-zinc-700 font-semibold cursor-pointer"
          >
            <Upload size={12} />
            <span>Import .FUW</span>
          </button>
          <button
            type="button"
            onClick={handleExportFUW}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-emerald-300 border border-zinc-700 font-semibold cursor-pointer"
          >
            <Download size={12} />
            <span>Export .FUW</span>
          </button>
        </div>
      </div>

      {/* Dimensions & Harmonic Generators */}
      {wave && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-zinc-400">
                <span>Width:</span>
                <input
                  type="number"
                  min={1}
                  max={256}
                  value={wave.width}
                  onChange={(e) => FurnaceBridge.updateWavetable(state.activeWavetableIndex, { width: Number(e.target.value) })}
                  className="w-16 bg-black border border-zinc-800 rounded px-2 py-1 font-mono text-cyan-300 tabular-nums"
                />
              </label>
              <label className="flex items-center gap-1.5 text-zinc-400">
                <span>Height:</span>
                <input
                  type="number"
                  min={1}
                  max={255}
                  value={wave.height}
                  onChange={(e) => FurnaceBridge.updateWavetable(state.activeWavetableIndex, { height: Number(e.target.value) })}
                  className="w-16 bg-black border border-zinc-800 rounded px-2 py-1 font-mono text-cyan-300 tabular-nums"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              {(['sine', 'saw', 'square', 'tri', 'organ', 'noise'] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="px-2 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 capitalize cursor-pointer"
                >
                  {preset}
                </button>
              ))}
              <button
                type="button"
                onClick={() => transformWave('smooth')}
                className="px-2 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-amber-300 border border-zinc-800 cursor-pointer"
              >
                Smooth
              </button>
              <button
                type="button"
                onClick={() => transformWave('invert')}
                className="px-2 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-amber-300 border border-zinc-800 cursor-pointer"
              >
                Invert
              </button>
              <button
                type="button"
                onClick={() => transformWave('normalize')}
                className="px-2 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-emerald-300 border border-zinc-800 cursor-pointer"
              >
                Normalize
              </button>
            </div>
          </div>

          {/* Interactive Waveform Canvas */}
          <canvas
            ref={canvasRef}
            width={720}
            height={190}
            onPointerDown={(e) => {
              isDrawingRef.current = true;
              paintAtClientPoint(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (isDrawingRef.current) paintAtClientPoint(e.clientX, e.clientY);
            }}
            onPointerUp={() => {
              isDrawingRef.current = false;
            }}
            onPointerLeave={() => {
              isDrawingRef.current = false;
            }}
            className="w-full h-48 rounded border border-zinc-800 cursor-crosshair touch-none"
          />

          <div className="text-[11px] text-zinc-400 flex justify-between font-mono tabular-nums">
            <span>Click and drag to draw steps directly into WASM wavetable memory</span>
            <span>
              Range: 0..{wave.height} · Steps: {wave.width}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
