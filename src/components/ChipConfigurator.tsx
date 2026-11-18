import React from 'react';
import { Cpu, Cable, Columns, Power, Sliders } from 'lucide-react';
import { Channel, CHIPS } from '../types';
import { syncChannelMuteSolo } from './AudioEngine';

interface ChipConfiguratorProps {
  channels: Channel[];
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
  hardwareConnected: boolean;
}

export default function ChipConfigurator({ channels, setChannels, hardwareConnected }: ChipConfiguratorProps) {
  const applyChannelUpdate = (updater: (chs: Channel[]) => Channel[]) => {
    setChannels(prev => {
      const next = updater(prev);
      syncChannelMuteSolo(next);
      return next;
    });
  };

  const toggleChannel = (id: number) => {
    applyChannelUpdate(chs => chs.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c));
  };

  const toggleMute = (id: number) => {
    applyChannelUpdate(chs => chs.map(c => c.id === id ? { ...c, mute: !c.mute } : c));
  };

  const toggleSolo = (id: number) => {
    applyChannelUpdate(chs => chs.map(c => c.id === id ? { ...c, solo: !c.solo } : c));
  };

  const changeChip = (id: number, newChip: string) => {
    applyChannelUpdate(chs => chs.map(c => c.id === id ? { ...c, chip: newChip } : c));
  };

  const updateParam = (id: number, key: 'volume' | 'pan', val: number) => {
    applyChannelUpdate(chs => chs.map(c => c.id === id ? { ...c, [key]: val } : c));
  };

  const activeCount = channels.filter(c => c.enabled).length;
  const anySolo = channels.some(c => c.enabled && c.solo);

  return (
    <div className="h-full flex flex-col font-mono select-none">
       {/* HEADER BANNER */}
       <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
         <div className="flex items-center gap-2">
           <Cpu className="text-purple-500 w-5 h-5"/>
           <h2 className="text-sm font-bold uppercase tracking-wider text-white">Chiptune Silicon &amp; Engine Routing</h2>
         </div>
         <div className="flex items-center gap-2">
           {anySolo && (
             <button
               type="button"
               onClick={() => applyChannelUpdate(chs => chs.map(c => ({ ...c, solo: false })))}
               className="text-[10px] bg-amber-950/70 hover:bg-amber-900/70 text-amber-300 border border-amber-500/60 px-2.5 py-1 rounded font-bold cursor-pointer transition"
               title="Clear all active channel solos"
             >
               Clear Solo
             </button>
           )}
           <div className="text-[10px] bg-zinc-800 text-zinc-400 border border-zinc-700 px-3 py-1 rounded">
             Silicon Allocation: <span className="text-purple-400 font-bold">{activeCount} / 48 Channels</span>
           </div>
         </div>
       </div>

       {/* ACTIVE CHANNEL MATRIX PREVIEW (CHIP BOARD) */}
       <div className="bg-zinc-950 border border-zinc-850 p-4 rounded-xl mb-4">
         <h4 className="text-[10px] text-zinc-400 uppercase font-bold tracking-widest mb-3 flex items-center gap-1.5">
           <Columns size={12} className="text-purple-400" /> Array Overview
         </h4>
         <div className="grid grid-cols-12 sm:grid-cols-24 gap-1.5">
           {channels.map(ch => {
             const effectiveMuted = ch.mute || (anySolo && !ch.solo);
             return (
               <div 
                 key={ch.id}
                 onClick={() => toggleChannel(ch.id)}
                 title={`CH${ch.id}: ${ch.chip}${ch.label ? ` (${ch.label})` : ''}${ch.enabled ? (ch.solo ? ' [SOLO]' : effectiveMuted ? ' [MUTED]' : ' (Active)') : ' (Disabled)'}`}
                 className={`h-4 rounded-sm flex items-center justify-center text-[8px] font-bold cursor-pointer transition-all ${
                   !ch.enabled
                     ? 'bg-zinc-900 text-zinc-650 border border-zinc-950 hover:border-zinc-800'
                     : ch.solo
                       ? 'bg-amber-500/25 text-amber-300 border border-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.3)]'
                       : effectiveMuted
                         ? 'bg-red-950/40 text-red-400 border border-red-700/60'
                         : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 shadow-[0_0_8px_rgba(34,211,238,0.2)]'
                 }`}
               >
                 {ch.id}
               </div>
             );
           })}
         </div>
       </div>

       {/* ROUTING CONTROLS LIST */}
       <div className="bg-transparent rounded-lg flex-1 overflow-y-auto pr-1 pb-12 custom-scrollbar">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {channels.map(ch => {
              const isSid = ch.chip.includes('SID') || ch.chip.includes('MOS6581') || ch.chip.includes('MOS8580');
              const isMutedEffective = ch.mute || (anySolo && !ch.solo);
              return (
                <div 
                  key={ch.id} 
                  className={`border rounded-xl p-3 flex flex-col gap-3 transition-all relative overflow-hidden ${
                    !ch.enabled
                      ? 'border-zinc-900/60 bg-zinc-950/40 opacity-40'
                      : ch.solo
                        ? 'border-amber-500/70 bg-zinc-900/75 shadow-[0_4px_14px_rgba(245,158,11,0.18)]'
                        : isMutedEffective
                          ? 'border-red-900/60 bg-zinc-900/50 opacity-75'
                          : isSid
                            ? 'border-emerald-700/50 bg-zinc-900/65 shadow-[0_4px_12px_rgba(16,185,129,0.14)]'
                            : 'border-zinc-800 bg-zinc-900/60 shadow-[0_4px_12px_rgba(0,0,0,0.35)]'
                  }`}
                >
                  {/* Silicon glow side accent */}
                  {ch.enabled && (
                    <span className={`absolute left-0 top-0 bottom-0 w-1 ${
                      ch.solo ? 'bg-amber-400' : isMutedEffective ? 'bg-red-500' : isSid ? 'bg-emerald-400' : 'bg-cyan-500'
                    }`}></span>
                  )}

                  <div className="flex items-center justify-between gap-1.5">
                    {/* Power status, channel name, M/S toggles */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <button 
                        onClick={() => toggleChannel(ch.id)}
                        className={`p-1.5 rounded transition-all cursor-pointer shrink-0 ${
                          ch.enabled 
                            ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30' 
                            : 'bg-zinc-900 text-zinc-600 border border-zinc-800'
                        }`}
                        title="Toggle channel power"
                      >
                        <Power size={11} />
                      </button>

                      {/* Mute button [M] */}
                      <button
                        id={`chip-mute-${ch.id}`}
                        type="button"
                        onClick={() => toggleMute(ch.id)}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-black border transition cursor-pointer shrink-0 ${
                          ch.mute
                            ? 'bg-red-600 text-white border-red-400 shadow-[0_0_8px_rgba(239,68,68,0.4)]'
                            : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-red-300 hover:border-red-700/60'
                        }`}
                        title={`Mute CH ${ch.id.toString().padStart(2, '0')}`}
                      >
                        M
                      </button>

                      {/* Compact Solo button [S] */}
                      <button
                        id={`chip-solo-${ch.id}`}
                        type="button"
                        onClick={() => toggleSolo(ch.id)}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-black border transition cursor-pointer shrink-0 ${
                          ch.solo
                            ? 'bg-amber-500 text-black border-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.5)]'
                            : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-amber-300 hover:border-amber-600/60'
                        }`}
                        title={`Solo CH ${ch.id.toString().padStart(2, '0')}`}
                      >
                        S
                      </button>

                      <span className={`font-bold text-[11px] shrink-0 ${ch.enabled ? 'text-white' : 'text-zinc-650'}`}>
                        CH {ch.id.toString().padStart(2, '0')}
                      </span>

                      {ch.label && (
                        <span
                          className="text-[8.5px] px-1.5 py-0.5 rounded bg-emerald-950/70 border border-emerald-700/50 text-emerald-300 font-bold truncate max-w-[92px]"
                          title={ch.label}
                        >
                          {ch.label}
                        </span>
                      )}
                    </div>

                    {/* Icon depending on USB routing or virtual emulation */}
                    {ch.chip.includes('Physical') ? (
                      <Cable size={12} className="text-orange-500 animate-pulse shrink-0" title="Routed across hardware Web Serial Link" />
                    ) : (
                      <Cpu size={12} className={`${isSid ? 'text-emerald-400' : 'text-cyan-500/70'} shrink-0`} />
                    )}
                  </div>

                  {/* Dropdown Selection */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] text-zinc-500 uppercase tracking-widest">Co-Processor:</label>
                    <select 
                      disabled={!ch.enabled}
                      value={ch.chip}
                      onChange={(e) => changeChip(ch.id, e.target.value)}
                      className="w-full bg-black border border-zinc-800 rounded p-1.5 text-[11px] text-zinc-300 font-mono focus:border-cyan-600 focus:ring-1 focus:ring-cyan-600 disabled:opacity-40 cursor-pointer"
                    >
                      {CHIPS.map(c => {
                        const isUsb = c === 'Physical Chip (USB)';
                        const locked = isUsb && !hardwareConnected;
                        return (
                          <option 
                            key={c} 
                            value={c} 
                            disabled={locked}
                            className={locked ? 'text-zinc-650 font-sans italic bg-zinc-950/80' : ''}
                          >
                            {c} {locked ? '🔒 (USB Not Connected)' : ''}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {/* Core Parameters dials */}
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <div className="flex flex-col gap-1">
                      <span className="text-[8.5px] text-zinc-500 uppercase tracking-wider flex items-center gap-1">
                        <Sliders size={10} /> Vol: <span className="text-zinc-300 font-bold ml-auto">{ch.volume}%</span>
                      </span>
                      <input 
                        type="range"
                        min="0"
                        max="100"
                        value={ch.volume}
                        disabled={!ch.enabled}
                        onChange={(e) => updateParam(ch.id, 'volume', Number(e.target.value))}
                        className="w-full accent-cyan-500 h-1 cursor-pointer"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[8.5px] text-zinc-500 uppercase tracking-wider flex items-center gap-1">
                        Pan: <span className="text-zinc-300 font-bold ml-auto">
                          {ch.pan === 50 ? 'C' : ch.pan < 50 ? `L${50 - ch.pan}` : `R${ch.pan - 50}`}
                        </span>
                      </span>
                      <input 
                        type="range"
                        min="0"
                        max="100"
                        value={ch.pan}
                        disabled={!ch.enabled}
                        onChange={(e) => updateParam(ch.id, 'pan', Number(e.target.value))}
                        className="w-full accent-cyan-500 h-1 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
       </div>
    </div>
  );
}
