import React, { useState, useEffect } from 'react';
import { Cpu, Plus, Trash2, Volume2, VolumeX } from 'lucide-react';
import {
  FurnaceBridge,
  FURNACE_CHIP_CATALOG,
  FurnaceChipSlot,
  FurnaceRuntimeState,
} from '../engines/FurnaceBridge';

export default function ChipRack() {
  const [state, setState] = useState<FurnaceRuntimeState>(() => FurnaceBridge.getState());
  const [selectedChipId, setSelectedChipId] = useState<number>(FURNACE_CHIP_CATALOG[0].id);

  useEffect(() => {
    return FurnaceBridge.subscribe(setState);
  }, []);

  const anySolo = state.systems.some((s) => s.solo);

  return (
    <div id="furnace-chip-rack" className="flex flex-col gap-4 text-xs">
      {/* Add Chip Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-zinc-900/70 border border-zinc-800 rounded-lg">
        <div className="flex items-center gap-2">
          <Cpu size={15} className="text-amber-400" />
          <span className="font-bold text-zinc-100">Furnace Multi-Chip System Rack</span>
          <span className="text-zinc-500">·</span>
          <span className="text-zinc-400 tabular-nums">
            {state.systems.length} Chip{state.systems.length === 1 ? '' : 's'} ({state.totalChannels} Hardware Channels)
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            id="furnace-add-chip-select"
            value={selectedChipId}
            onChange={(e) => setSelectedChipId(Number(e.target.value))}
            className="bg-black border border-zinc-700 rounded px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-cyan-500 cursor-pointer"
          >
            {FURNACE_CHIP_CATALOG.map((chip) => (
              <option key={chip.id} value={chip.id}>
                [{chip.category}] {chip.name} ({chip.channels}ch)
              </option>
            ))}
          </select>
          <button
            id="furnace-add-chip-btn"
            type="button"
            onClick={() => FurnaceBridge.addSystem(selectedChipId)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-semibold transition-colors cursor-pointer whitespace-nowrap"
          >
            <Plus size={13} />
            <span>Add Chip</span>
          </button>
        </div>
      </div>

      {/* Stacked Chip Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {state.systems.map((slot: FurnaceChipSlot, idx: number) => {
          const catalogItem = FURNACE_CHIP_CATALOG.find((c) => c.id === slot.sysId);
          const isMutedEff = slot.mute || (anySolo && !slot.solo);

          return (
            <div
              key={slot.slotId}
              className={`p-3.5 rounded-lg border transition-colors ${
                slot.solo
                  ? 'bg-amber-950/20 border-amber-500/50'
                  : isMutedEff
                    ? 'bg-zinc-950/60 border-zinc-800/70 opacity-75'
                    : 'bg-zinc-900/60 border-zinc-800'
              }`}
            >
              <div className="flex items-center justify-between gap-2 pb-2.5 mb-3 border-b border-zinc-800/80">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-zinc-100 font-bold truncate">
                    <span className="font-mono text-amber-400 tabular-nums">#{idx + 1}</span>
                    <span className="truncate">{slot.name}</span>
                  </div>
                  <div className="text-[11px] text-zinc-400 mt-0.5 tabular-nums">
                    {slot.code} · {slot.channels} Channels · SysID 0x{slot.sysId.toString(16).toUpperCase().padStart(2, '0')}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => FurnaceBridge.updateSystemSlot(idx, { mute: !slot.mute })}
                    className={`px-2 py-1 rounded text-[11px] font-bold border transition-colors cursor-pointer ${
                      slot.mute
                        ? 'bg-red-600 text-white border-red-400'
                        : 'bg-zinc-950 text-zinc-400 border-zinc-700 hover:text-zinc-100'
                    }`}
                    title="Mute chip"
                  >
                    {slot.mute ? <VolumeX size={12} /> : <Volume2 size={12} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => FurnaceBridge.updateSystemSlot(idx, { solo: !slot.solo })}
                    className={`px-2 py-1 rounded text-[11px] font-bold border transition-colors cursor-pointer ${
                      slot.solo
                        ? 'bg-amber-500 text-black border-amber-300'
                        : 'bg-zinc-950 text-zinc-400 border-zinc-700 hover:text-zinc-100'
                    }`}
                    title="Solo chip"
                  >
                    S
                  </button>
                  <button
                    type="button"
                    disabled={state.systems.length <= 1}
                    onClick={() => FurnaceBridge.removeSystem(idx)}
                    className="p-1.5 rounded bg-zinc-950 text-zinc-400 hover:text-red-400 border border-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    title="Remove chip from rack"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Emulation Core Switcher */}
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Emulation Core</label>
                  <select
                    value={slot.core}
                    onChange={(e) => FurnaceBridge.updateSystemSlot(idx, { core: e.target.value })}
                    className="w-full bg-black border border-zinc-800 rounded px-2 py-1.5 text-cyan-300 font-mono text-xs focus:outline-none focus:border-cyan-500 cursor-pointer"
                  >
                    {slot.availableCores.map((coreName) => (
                      <option key={coreName} value={coreName}>
                        {coreName}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Clock Rate Preset + Custom Hz */}
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Clock Rate (Hz)</label>
                  <div className="flex items-center gap-1.5">
                    {catalogItem && (
                      <select
                        value={
                          catalogItem.clockPresets.some((p) => p.hz === slot.clockHz)
                            ? String(slot.clockHz)
                            : 'custom'
                        }
                        onChange={(e) => {
                          if (e.target.value !== 'custom') {
                            FurnaceBridge.updateSystemSlot(idx, { clockHz: Number(e.target.value) });
                          }
                        }}
                        className="flex-1 bg-black border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none cursor-pointer"
                      >
                        {catalogItem.clockPresets.map((p) => (
                          <option key={p.label} value={p.hz}>
                            {p.label}
                          </option>
                        ))}
                        <option value="custom">Custom Clock</option>
                      </select>
                    )}
                    <input
                      type="number"
                      min={100000}
                      max={32000000}
                      step={1000}
                      value={slot.clockHz}
                      onChange={(e) =>
                        FurnaceBridge.updateSystemSlot(idx, {
                          clockHz: Math.max(100000, Number(e.target.value) || 1000000),
                        })
                      }
                      className="w-24 bg-black border border-zinc-800 rounded px-2 py-1.5 text-amber-300 font-mono text-xs tabular-nums focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>

                {/* Mix Volume */}
                <div>
                  <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1">
                    <span>Chip Mix Gain</span>
                    <span className="font-mono text-zinc-200 tabular-nums">{Math.round(slot.volume * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    value={Math.round(slot.volume * 100)}
                    onChange={(e) => FurnaceBridge.updateSystemSlot(idx, { volume: Number(e.target.value) / 100 })}
                    className="w-full accent-cyan-500 cursor-pointer"
                  />
                </div>

                {/* Pan + A-4 Tuning */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1">
                      <span>Pan</span>
                      <span className="font-mono text-zinc-200 tabular-nums">
                        {slot.pan === 0 ? 'C' : slot.pan < 0 ? `L${Math.round(Math.abs(slot.pan) * 100)}` : `R${Math.round(slot.pan * 100)}`}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-100}
                      max={100}
                      value={Math.round(slot.pan * 100)}
                      onChange={(e) => FurnaceBridge.updateSystemSlot(idx, { pan: Number(e.target.value) / 100 })}
                      className="w-full accent-emerald-500 cursor-pointer"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">A-4 Tuning (Hz)</label>
                    <input
                      type="number"
                      min={380}
                      max={500}
                      step={0.5}
                      value={slot.tuningHz}
                      onChange={(e) =>
                        FurnaceBridge.updateSystemSlot(idx, {
                          tuningHz: Math.max(380, Math.min(500, Number(e.target.value) || 440)),
                        })
                      }
                      className="w-full bg-black border border-zinc-800 rounded px-2 py-1 text-emerald-300 font-mono text-xs tabular-nums focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
