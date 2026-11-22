import React, { useState, useEffect, useRef } from 'react';
import { Cpu, Sliders, Waves, AudioLines, ListMusic, Upload, Settings2, Play } from 'lucide-react';
import { FurnaceBridge, FurnaceRuntimeState } from '../engines/FurnaceBridge';
import { unlockAudioContextSync } from './AudioEngine';
import ChipRack from './ChipRack';
import FMEditor from './FMEditor';
import WavetableEditor from './WavetableEditor';
import SampleEditor from './SampleEditor';
import MacroSequencer from './MacroSequencer';
import WasmEngineManagerModal from './WasmEngineManagerModal';

type DeckTab = 'rack' | 'fm' | 'wave' | 'sample' | 'macro';

const TEST_NOTES = [
  { label: 'C-3', midi: 48 },
  { label: 'E-3', midi: 52 },
  { label: 'G-3', midi: 55 },
  { label: 'C-4', midi: 60 },
  { label: 'E-4', midi: 64 },
  { label: 'G-4', midi: 67 },
  { label: 'C-5', midi: 72 },
];

export default function FurnaceControlDeck() {
  const [activeTab, setActiveTab] = useState<DeckTab>('rack');
  const [state, setState] = useState<FurnaceRuntimeState>(() => FurnaceBridge.getState());
  const [isWasmModalOpen, setIsWasmModalOpen] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const quickLoadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return FurnaceBridge.subscribe(setState);
  }, []);

  const handleAuditionNote = (midi: number, label: string) => {
    unlockAudioContextSync();
    const sent = FurnaceBridge.noteOn(0, midi, 110);
    if (!sent) {
      setStatusNote(`Furnace WASM core (${label}) requires aria_furnace_all.js loaded via WASM Engine Manager — zero oscillator fallback used.`);
      setTimeout(() => setStatusNote(null), 4000);
      return;
    }
    setTimeout(() => FurnaceBridge.noteOff(0), 260);
  };

  const handleQuickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const buf = ev.target?.result;
      if (!(buf instanceof ArrayBuffer)) return;
      if (ext === '.fur') {
        const res = await FurnaceBridge.loadFurBuffer(buf, file.name);
        setStatusNote(`Loaded .FUR module "${res.title}" (${res.bpm} BPM, ${res.channelsCount} ch)`);
      } else if (ext === '.fui') {
        FurnaceBridge.importFUI(buf, file.name);
        setActiveTab('fm');
        setStatusNote(`Loaded .FUI instrument from ${file.name}`);
      } else if (ext === '.fuw') {
        FurnaceBridge.importFUW(buf, file.name);
        setActiveTab('wave');
        setStatusNote(`Loaded .FUW wavetable from ${file.name}`);
      } else if (ext === '.dmp') {
        FurnaceBridge.importDMP(buf, file.name);
        setActiveTab('fm');
        setStatusNote(`Loaded .DMP FM preset from ${file.name}`);
      } else if (ext === '.opm') {
        FurnaceBridge.importOPM(new TextDecoder().decode(new Uint8Array(buf)), file.name);
        setActiveTab('fm');
        setStatusNote(`Loaded .OPM bank preset from ${file.name}`);
      } else if (ext === '.wav' || ext === '.dmc' || ext === '.brr') {
        FurnaceBridge.importSampleFile(buf, file.name);
        setActiveTab('sample');
        setStatusNote(`Decoded ${file.name} into Sample Editor`);
      }
      setTimeout(() => setStatusNote(null), 4000);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  return (
    <div id="furnace-control-deck" className="flex flex-col gap-3 text-xs">
      {/* Header Bar */}
      <div className="p-3 bg-zinc-900/80 border border-zinc-800 rounded-xl flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white uppercase tracking-wider">Furnace Control Deck</span>
            <span className="text-zinc-500">·</span>
            <span className={`text-[11px] font-mono font-semibold ${state.wasmStatus === 'ready' ? 'text-emerald-400' : 'text-amber-400'}`}>
              {state.wasmStatus === 'ready' ? 'WASM DivEngine Active' : 'WASM Core Unloaded (Load Bundle)'}
            </span>
          </div>
          <div className="text-[11px] text-zinc-400 mt-0.5">
            Cycle-accurate hardware synthesis · {state.systems.length} stacked chips · {state.totalChannels} channels
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Quick Audition Keys */}
          <div className="flex items-center gap-1 p-1 bg-black border border-zinc-800 rounded-lg">
            <Play size={11} className="text-emerald-400 ml-1 mr-0.5" />
            {TEST_NOTES.map((n) => (
              <button
                key={n.label}
                type="button"
                onClick={() => handleAuditionNote(n.midi, n.label)}
                className="px-2 py-1 rounded bg-zinc-900 hover:bg-cyan-600 text-zinc-300 hover:text-white font-mono text-[10px] font-bold cursor-pointer transition-colors"
                title={`Trigger ${n.label} via Furnace C++/WASM`}
              >
                {n.label}
              </button>
            ))}
          </div>

          <input
            ref={quickLoadRef}
            type="file"
            accept=".fur,.fui,.fuw,.dmp,.opm,.wav,.dmc,.brr"
            onChange={handleQuickFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => quickLoadRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-cyan-300 border border-zinc-700 font-semibold cursor-pointer whitespace-nowrap"
          >
            <Upload size={13} />
            <span>Load .FUR / .FUI / .FUW</span>
          </button>

          <button
            id="open-wasm-engine-manager-btn"
            type="button"
            onClick={() => setIsWasmModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold cursor-pointer whitespace-nowrap"
          >
            <Settings2 size={13} />
            <span>WASM Engine Manager</span>
          </button>
        </div>
      </div>

      {/* Honest Runtime Notice */}
      {statusNote && (
        <div className="px-3 py-2 rounded-lg bg-zinc-900 border border-amber-500/40 text-amber-200 font-mono text-[11px]">
          {statusNote}
        </div>
      )}

      {/* Segmented Control Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-zinc-900/90 border border-zinc-800 rounded-lg self-start">
        {([
          { id: 'rack', label: 'Chip Rack', icon: <Cpu size={13} /> },
          { id: 'fm', label: 'FM / SID / PSG', icon: <Sliders size={13} /> },
          { id: 'wave', label: 'Wavetable (.fuw)', icon: <Waves size={13} /> },
          { id: 'sample', label: 'Sample / BRR', icon: <AudioLines size={13} /> },
          { id: 'macro', label: 'Macro Sequencer', icon: <ListMusic size={13} /> },
        ] as { id: DeckTab; label: string; icon: React.ReactNode }[]).map((tab) => (
          <button
            key={tab.id}
            id={`furnace-tab-${tab.id}`}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-100 border border-transparent'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === 'rack' && <ChipRack />}
        {activeTab === 'fm' && <FMEditor />}
        {activeTab === 'wave' && <WavetableEditor />}
        {activeTab === 'sample' && <SampleEditor />}
        {activeTab === 'macro' && <MacroSequencer />}
      </div>

      <WasmEngineManagerModal isOpen={isWasmModalOpen} onClose={() => setIsWasmModalOpen(false)} />
    </div>
  );
}
