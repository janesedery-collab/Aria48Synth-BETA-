import React, { useState, useEffect } from 'react';
import { ListMusic, RotateCcw } from 'lucide-react';
import {
  FurnaceBridge,
  FurnaceRuntimeState,
  MacroLaneType,
} from '../engines/FurnaceBridge';

const MACRO_GROUPS: { group: string; lanes: MacroLaneType[] }[] = [
  {
    group: 'Standard Instrument Macros',
    lanes: ['volume', 'arpRel', 'arpFixed', 'duty', 'wave', 'pitch', 'pan', 'phaseReset', 'ex1', 'ex2', 'ex3'],
  },
  {
    group: 'Per-Operator FM Macros',
    lanes: ['op1_tl', 'op1_ar', 'op1_dr', 'op1_mult', 'op2_tl', 'op3_tl', 'op4_tl'],
  },
];

export default function MacroSequencer() {
  const [state, setState] = useState<FurnaceRuntimeState>(() => FurnaceBridge.getState());
  const [selectedLane, setSelectedLane] = useState<MacroLaneType>('volume');
  const [markerMode, setMarkerMode] = useState<'value' | 'loop' | 'release'>('value');

  useEffect(() => {
    return FurnaceBridge.subscribe(setState);
  }, []);

  const macro = state.macros[selectedLane];
  const span = Math.max(1, macro.max - macro.min);

  const handleLengthChange = (newLen: number) => {
    const len = Math.max(1, Math.min(32, newLen));
    const vals = [...macro.values];
    while (vals.length < len) vals.push(vals[vals.length - 1] ?? macro.min);
    FurnaceBridge.updateMacro(selectedLane, { values: vals.slice(0, len) });
  };

  const handleStepInteract = (stepIdx: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (markerMode === 'loop') {
      FurnaceBridge.updateMacro(selectedLane, {
        loop: macro.loop === stepIdx ? -1 : stepIdx,
      });
      return;
    }
    if (markerMode === 'release') {
      FurnaceBridge.updateMacro(selectedLane, {
        release: macro.release === stepIdx ? -1 : stepIdx,
      });
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const yRatio = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    const nextVal = Math.round(macro.min + yRatio * span);
    const vals = [...macro.values];
    vals[stepIdx] = nextVal;
    FurnaceBridge.updateMacro(selectedLane, { values: vals });
  };

  return (
    <div id="furnace-macro-sequencer" className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex flex-col gap-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <ListMusic size={15} className="text-emerald-400" />
          <span className="font-bold text-zinc-100">Furnace Macro Sequencer Rack</span>
          <span className="text-zinc-500">·</span>
          <span className="text-zinc-400">{macro.label}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-zinc-400">
            <span>Steps:</span>
            <input
              type="number"
              min={1}
              max={32}
              value={macro.values.length}
              onChange={(e) => handleLengthChange(Number(e.target.value) || 4)}
              className="w-14 bg-black border border-zinc-800 rounded px-2 py-1 font-mono text-cyan-300 tabular-nums"
            />
          </label>
          <label className="flex items-center gap-1.5 text-zinc-400">
            <span>Tick Divider:</span>
            <input
              type="number"
              min={1}
              max={16}
              value={macro.speed}
              onChange={(e) => FurnaceBridge.updateMacro(selectedLane, { speed: Number(e.target.value) || 1 })}
              className="w-14 bg-black border border-zinc-800 rounded px-2 py-1 font-mono text-amber-300 tabular-nums"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              FurnaceBridge.updateMacro(selectedLane, {
                loop: -1,
                release: -1,
                values: macro.values.map(() => (macro.min < 0 ? 0 : Math.round((macro.min + macro.max) / 2))),
              })
            }
            className="flex items-center gap-1 px-2 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 cursor-pointer"
          >
            <RotateCcw size={12} />
            <span>Reset Lane</span>
          </button>
        </div>
      </div>

      {/* Lane Selector Matrix */}
      <div className="flex flex-col gap-2">
        {MACRO_GROUPS.map((grp) => (
          <div key={grp.group} className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mr-1">
              {grp.group}:
            </span>
            {grp.lanes.map((lane) => (
              <button
                key={lane}
                type="button"
                onClick={() => setSelectedLane(lane)}
                className={`px-2 py-1 rounded text-[11px] font-mono border cursor-pointer transition-colors ${
                  selectedLane === lane
                    ? 'bg-emerald-600 text-white border-emerald-400'
                    : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-white'
                }`}
              >
                {state.macros[lane].label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Mode Switcher: Draw Values | Place Loop (L) | Place Release (R) */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-1 p-1 bg-zinc-950 border border-zinc-800 rounded">
          <button
            type="button"
            onClick={() => setMarkerMode('value')}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer ${
              markerMode === 'value' ? 'bg-cyan-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Edit Step Bars
          </button>
          <button
            type="button"
            onClick={() => setMarkerMode('loop')}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer ${
              markerMode === 'loop' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Toggle Loop (L: {macro.loop >= 0 ? macro.loop : 'Off'})
          </button>
          <button
            type="button"
            onClick={() => setMarkerMode('release')}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer ${
              markerMode === 'release' ? 'bg-amber-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Toggle Release (R: {macro.release >= 0 ? macro.release : 'Off'})
          </button>
        </div>

        <span className="text-[11px] text-zinc-400 font-mono tabular-nums">
          Range: {macro.min}..{macro.max} · Speed: {macro.speed}x
        </span>
      </div>

      {/* Step Bar Graph + L / R Markers */}
      <div className="p-3 bg-black/80 border border-zinc-800 rounded overflow-x-auto">
        <div className="flex items-end gap-1.5 min-w-max">
          {macro.values.map((val, idx) => {
            const pct = Math.max(4, Math.round(((val - macro.min) / span) * 100));
            const isLoop = macro.loop === idx;
            const isRel = macro.release === idx;
            return (
              <div key={idx} className="flex flex-col items-center gap-1 w-7">
                <span className="text-[10px] font-mono text-zinc-300 tabular-nums">{val}</span>
                <div
                  onClick={(e) => handleStepInteract(idx, e)}
                  className={`w-6 h-36 bg-zinc-900 border rounded relative flex items-end cursor-pointer transition-colors ${
                    isLoop
                      ? 'border-emerald-500'
                      : isRel
                        ? 'border-amber-500'
                        : 'border-zinc-800 hover:border-cyan-500/70'
                  }`}
                  title={`Step ${idx}: ${val}`}
                >
                  <div
                    className={`w-full rounded-b transition-all ${
                      isLoop ? 'bg-emerald-500/80' : isRel ? 'bg-amber-500/80' : 'bg-cyan-500/80'
                    }`}
                    style={{ height: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center gap-0.5 text-[9px] font-mono font-bold h-4">
                  {isLoop && <span className="text-emerald-400">L</span>}
                  {isRel && <span className="text-amber-400">R</span>}
                  {!isLoop && !isRel && <span className="text-zinc-600 tabular-nums">{idx}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
