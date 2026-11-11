import React, { useState, useEffect } from 'react';
import { 
  Sliders, Music, Volume2, RotateCcw, AlertOctagon, 
  Check, X, Activity, Play, Radio, Sparkles, Layers, Piano,
  Lock, Unlock, Waves, ArrowUpDown
} from 'lucide-react';
import { SpessaSynth, DEFAULT_GM_PROGRAMS, MidiChannelState } from '../engines/spressasynthLib';
import { getAvailableSoundFontInstruments } from '../utils/soundFontEngine';
import { SoundFontInstrument } from '../types';
import { saveSelectedSoundFont, getSavedSelectedSoundFont } from '../utils/recentSongsManager';

interface MidiControllerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSoundFont?: (presetId: string) => void;
}

// 2-octave keyboard note definitions (C3 to B4: MIDI 48 to 71)
const KEYBOARD_NOTES = [
  { midi: 48, name: "C3", isBlack: false },
  { midi: 49, name: "C#3", isBlack: true },
  { midi: 50, name: "D3", isBlack: false },
  { midi: 51, name: "D#3", isBlack: true },
  { midi: 52, name: "E3", isBlack: false },
  { midi: 53, name: "F3", isBlack: false },
  { midi: 54, name: "F#3", isBlack: true },
  { midi: 55, name: "G3", isBlack: false },
  { midi: 56, name: "G#3", isBlack: true },
  { midi: 57, name: "A3", isBlack: false },
  { midi: 58, name: "A#3", isBlack: true },
  { midi: 59, name: "B3", isBlack: false },
  { midi: 60, name: "C4", isBlack: false },
  { midi: 61, name: "C#4", isBlack: true },
  { midi: 62, name: "D4", isBlack: false },
  { midi: 63, name: "D#4", isBlack: true },
  { midi: 64, name: "E4", isBlack: false },
  { midi: 65, name: "F4", isBlack: false },
  { midi: 66, name: "F#4", isBlack: true },
  { midi: 67, name: "G4", isBlack: false },
  { midi: 68, name: "G#4", isBlack: true },
  { midi: 69, name: "A4", isBlack: false },
  { midi: 70, name: "A#4", isBlack: true },
  { midi: 71, name: "B4", isBlack: false }
];

export default function MidiControllerModal({
  isOpen,
  onClose,
  onSelectSoundFont
}: MidiControllerModalProps) {
  const [selectedChannel, setSelectedChannel] = useState<number>(0);
  const [channelStates, setChannelStates] = useState<MidiChannelState[]>([]);
  const [activeMidiNotes, setActiveMidiNotes] = useState<Set<number>>(new Set());
  const [availableSoundFonts, setAvailableSoundFonts] = useState<SoundFontInstrument[]>([]);
  const [selectedSoundFontId, setSelectedSoundFontId] = useState<string>("gm_piano");
  const [systemLog, setSystemLog] = useState<string>("SpessaSynth Ready (16-Channel Engine Initialized)");

  useEffect(() => {
    if (isOpen) {
      setChannelStates([...SpessaSynth.getChannelStates()]);
      const insts = getAvailableSoundFontInstruments();
      setAvailableSoundFonts(insts);
      const savedSf = getSavedSelectedSoundFont();
      setSelectedSoundFontId(savedSf);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const currentCh = channelStates[selectedChannel] || {
    index: selectedChannel,
    program: selectedChannel === 9 ? 0 : selectedChannel % 8,
    programName: selectedChannel === 9 ? "GM Standard Drum Kit" : "Acoustic Grand Piano",
    volume: 100,
    pan: 64,
    pitchBend: 0,
    isMuted: false,
    activeNoteCount: 0,
    pitchBendRange: 2,
    portamentoEnabled: false,
    portamentoTime: 64,
    portamentoControl: null,
    lastNote: null
  };

  const [holdPitchWheel, setHoldPitchWheel] = useState(false);
  const [pitchRange, setPitchRange] = useState(currentCh.pitchBendRange || 2);
  const [isSlidingActive, setIsSlidingActive] = useState(false);

  const handleVolumeChange = (vol: number) => {
    SpessaSynth.setChannelVolume(selectedChannel, vol);
    setChannelStates([...SpessaSynth.getChannelStates()]);
  };

  const handlePanChange = (pan: number) => {
    SpessaSynth.setChannelPan(selectedChannel, pan);
    setChannelStates([...SpessaSynth.getChannelStates()]);
  };

  const handleProgramChange = (prog: number) => {
    SpessaSynth.setChannelProgram(selectedChannel, prog);
    setChannelStates([...SpessaSynth.getChannelStates()]);
    setSystemLog(`Ch ${selectedChannel + 1}: Program Changed to [${prog}] ${DEFAULT_GM_PROGRAMS[prog] || `Program ${prog}`}`);
  };

  const handleMuteToggle = () => {
    const nextMute = !currentCh.isMuted;
    SpessaSynth.setChannelMute(selectedChannel, nextMute);
    setChannelStates([...SpessaSynth.getChannelStates()]);
  };

  const handlePitchBendChange = (bend: number) => {
    SpessaSynth.setChannelPitchBend(selectedChannel, bend);
    setChannelStates([...SpessaSynth.getChannelStates()]);
  };

  const handlePitchWheelRelease = () => {
    if (!holdPitchWheel) {
      SpessaSynth.setChannelPitchBend(selectedChannel, 0);
      setChannelStates([...SpessaSynth.getChannelStates()]);
    }
  };

  const handlePitchRangeSelect = (semitones: number) => {
    setPitchRange(semitones);
    SpessaSynth.setChannelPitchBendRange(selectedChannel, semitones);
    setChannelStates([...SpessaSynth.getChannelStates()]);
    setSystemLog(`Ch ${selectedChannel + 1}: Pitch Wheel Range set to +/-${semitones} Semitones`);
  };

  const handlePortamentoToggle = () => {
    const nextVal = !currentCh.portamentoEnabled;
    SpessaSynth.setChannelPortamento(selectedChannel, nextVal);
    setChannelStates([...SpessaSynth.getChannelStates()]);
    setSystemLog(`Ch ${selectedChannel + 1}: Portamento Glide ${nextVal ? 'ENABLED (CC 65: ON)' : 'DISABLED (CC 65: OFF)'}`);
  };

  const handlePortamentoTimeChange = (time: number) => {
    SpessaSynth.setChannelPortamentoTime(selectedChannel, time);
    setChannelStates([...SpessaSynth.getChannelStates()]);
  };

  const handlePortamentoCtrlChange = (note: number | null) => {
    SpessaSynth.setChannelPortamentoControl(selectedChannel, note);
    setChannelStates([...SpessaSynth.getChannelStates()]);
    setSystemLog(`Ch ${selectedChannel + 1}: Portamento Source Control Key (CC 84) set to ${note !== null ? `Note ${note}` : 'Auto'}`);
  };

  const handleTriggerSlidingTest = (startNote: number, endNote: number) => {
    setIsSlidingActive(true);
    setSystemLog(`Ch ${selectedChannel + 1}: Sliding Notes Demo (Glide ${startNote} -> ${endNote} with CC 5 & CC 65)`);
    SpessaSynth.triggerPortamentoGlideTest(selectedChannel, startNote, endNote);
    setActiveMidiNotes(new Set([startNote]));
    setTimeout(() => {
      setActiveMidiNotes(new Set([endNote]));
    }, 130);
    setTimeout(() => {
      setActiveMidiNotes(new Set());
      setIsSlidingActive(false);
    }, 850);
  };

  const handlePlayKey = (midiNote: number) => {
    SpessaSynth.noteOn(selectedChannel, midiNote, 100, 0.45);
    setActiveMidiNotes(prev => new Set(prev).add(midiNote));
    setTimeout(() => {
      setActiveMidiNotes(prev => {
        const next = new Set(prev);
        next.delete(midiNote);
        return next;
      });
    }, 450);
  };

  const handleAuditionChannel = () => {
    const notes = selectedChannel === 9 ? [36, 38, 42, 46] : [60, 64, 67, 72];
    notes.forEach((n, idx) => {
      setTimeout(() => {
        handlePlayKey(n);
      }, idx * 140);
    });
  };

  const handleSoundFontSelect = (presetId: string) => {
    setSelectedSoundFontId(presetId);
    saveSelectedSoundFont(presetId);
    onSelectSoundFont?.(presetId);
    setSystemLog(`Saved Selected SoundFont: "${presetId}" (Persisted across sessions)`);
  };

  // MIDI System Resets
  const triggerGMReset = () => {
    const res = SpessaSynth.sendGMReset();
    setChannelStates([...SpessaSynth.getChannelStates()]);
    setSystemLog(res.message);
  };

  const triggerGSReset = () => {
    const res = SpessaSynth.sendGSReset();
    setChannelStates([...SpessaSynth.getChannelStates()]);
    setSystemLog(res.message);
  };

  const triggerXGReset = () => {
    const res = SpessaSynth.sendXGReset();
    setChannelStates([...SpessaSynth.getChannelStates()]);
    setSystemLog(res.message);
  };

  const triggerGM2Reset = () => {
    const res = SpessaSynth.sendGM2Reset();
    setChannelStates([...SpessaSynth.getChannelStates()]);
    setSystemLog(res.message);
  };

  const triggerPanic = () => {
    SpessaSynth.allNotesOff();
    SpessaSynth.allSoundOff();
    setActiveMidiNotes(new Set());
    setChannelStates([...SpessaSynth.getChannelStates()]);
    setSystemLog("PANIC: All Sound Off & Notes Released on all 16 Channels (CC 120 / 123)");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-4xl bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden text-zinc-300">
        
        {/* HEADER BAR */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/80">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Sliders size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-black text-white tracking-wider uppercase font-mono">
                  SpessaSynth MIDI Controller
                </h2>
                <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-cyan-950/70 border border-cyan-800/40 text-cyan-400">
                  spressasynth_lib-master.zip
                </span>
              </div>
              <p className="text-[10.5px] text-zinc-400 font-sans mt-0.5">
                16-Channel Hardware/Software MIDI Matrix, SoundFont Router, and System Reset Unit
              </p>
            </div>
          </div>

          <button 
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* SYSTEM COMMANDS & SOUNDFONT STRIP */}
        <div className="px-5 py-2.5 bg-zinc-900/40 border-b border-zinc-850 flex flex-wrap items-center justify-between gap-3 text-xs">
          
          {/* RESET BUTTONS STRIP */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9.5px] font-bold text-zinc-400 uppercase tracking-wider font-mono mr-1">
              SysEx Resets:
            </span>

            {/* GM RESET */}
            <button
              onClick={triggerGMReset}
              className="px-2.5 py-1 rounded bg-emerald-950/40 border border-emerald-600/40 hover:bg-emerald-900/60 text-emerald-300 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1 shadow-sm"
              title="General MIDI Reset: Resets all 16 channels, CC 121 (Reset Controllers), and CC 123 (All Notes Off)"
            >
              <RotateCcw size={10} />
              <span>GM Reset</span>
            </button>

            {/* GS RESET */}
            <button
              onClick={triggerGSReset}
              className="px-2.5 py-1 rounded bg-amber-950/40 border border-amber-600/40 hover:bg-amber-900/60 text-amber-300 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1 shadow-sm"
              title="Roland GS Reset: SysEx F0 41 10 42 12 40 00 7F 00 41 F7"
            >
              <Sparkles size={10} />
              <span>GS Reset</span>
            </button>

            {/* XG RESET */}
            <button
              onClick={triggerXGReset}
              className="px-2.5 py-1 rounded bg-blue-950/40 border border-blue-600/40 hover:bg-blue-900/60 text-blue-300 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1 shadow-sm"
              title="Yamaha XG Reset: SysEx F0 43 10 4C 00 00 7E 00 F7"
            >
              <Radio size={10} />
              <span>XG Reset</span>
            </button>

            {/* GM2 RESET */}
            <button
              onClick={triggerGM2Reset}
              className="px-2.5 py-1 rounded bg-purple-950/40 border border-purple-600/40 hover:bg-purple-900/60 text-purple-300 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1 shadow-sm"
              title="General MIDI 2 Reset: SysEx F0 7E 7F 09 03 F7"
            >
              <span>GM2 Reset</span>
            </button>

            {/* PANIC */}
            <button
              onClick={triggerPanic}
              className="px-2.5 py-1 rounded bg-red-950/50 border border-red-600/50 hover:bg-red-900 text-red-200 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1 shadow-sm"
              title="Panic: All Notes Off & All Sound Off across all channels"
            >
              <AlertOctagon size={11} />
              <span>Panic (Cut All)</span>
            </button>
          </div>

          {/* SOUNDFONT PRESET SELECTION WITH AUTO-SAVE */}
          <div className="flex items-center gap-2">
            <span className="text-[9.5px] font-bold text-zinc-400 uppercase tracking-wider font-mono">
              SoundFont Bank:
            </span>
            <select
              value={selectedSoundFontId}
              onChange={(e) => handleSoundFontSelect(e.target.value)}
              className="bg-zinc-900 border border-zinc-750 text-emerald-400 font-mono text-[10.5px] rounded px-2 py-1 focus:outline-none focus:border-cyan-500 cursor-pointer"
            >
              {availableSoundFonts.map(sf => (
                <option key={sf.id} value={sf.id} className="bg-zinc-950 text-zinc-300">
                  {sf.name} {sf.isCustom ? "(Uploaded)" : "(Built-in)"}
                </option>
              ))}
            </select>
            <span className="text-[8.5px] text-emerald-400/80 font-mono bg-emerald-950/30 px-1.5 py-0.5 rounded border border-emerald-800/40">
              Saved
            </span>
          </div>
        </div>

        {/* MODAL MAIN CONTENT */}
        <div className="p-5 flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-5">
          
          {/* 16-CHANNEL SELECTOR MATRIX */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-1.5">
                <Layers size={12} className="text-cyan-400" />
                Select MIDI Channel (1 - 16)
              </span>
              <span className="text-[9.5px] text-zinc-500 font-mono">
                Channel 10 is dedicated General MIDI Percussion
              </span>
            </div>

            <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
              {Array.from({ length: 16 }, (_, idx) => {
                const ch = channelStates[idx] || {
                  index: idx,
                  program: idx === 9 ? 0 : idx % 8,
                  programName: idx === 9 ? "GM Standard Drum Kit" : (DEFAULT_GM_PROGRAMS[idx % 8] || `Program ${idx}`),
                  volume: 100,
                  pan: 64,
                  pitchBend: 0,
                  isMuted: false,
                  activeNoteCount: 0
                };
                const isSelected = selectedChannel === idx;
                const isDrums = idx === 9;

                return (
                  <button
                    key={idx}
                    onClick={() => setSelectedChannel(idx)}
                    className={`p-2 rounded-lg border text-left transition flex flex-col justify-between h-18 cursor-pointer relative ${
                      isSelected
                        ? 'bg-cyan-950/60 border-cyan-500 text-white shadow-[0_0_12px_rgba(6,182,212,0.25)]'
                        : isDrums
                          ? 'bg-amber-950/20 border-amber-800/40 text-amber-300 hover:bg-amber-900/30'
                          : 'bg-zinc-900/70 border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`text-[10.5px] font-black font-mono ${isSelected ? 'text-cyan-300' : isDrums ? 'text-amber-400' : 'text-zinc-300'}`}>
                        CH {(idx + 1).toString().padStart(2, '0')}
                      </span>
                      {isDrums && (
                        <span className="text-[7.5px] px-1 py-0.2 rounded bg-amber-900/60 text-amber-300 font-mono font-bold">
                          DRUMS
                        </span>
                      )}
                      {ch.isMuted && (
                        <span className="text-[7.5px] px-1 py-0.2 rounded bg-red-950 border border-red-800 text-red-400 font-mono">
                          MUTE
                        </span>
                      )}
                    </div>

                    <div className="text-[8.5px] truncate font-sans text-zinc-350" title={ch.programName}>
                      {ch.programName}
                    </div>

                    {/* Mini volume indicator */}
                    <div className="w-full bg-zinc-950 rounded-full h-1 overflow-hidden mt-1">
                      <div 
                        className={`h-full ${isSelected ? 'bg-cyan-400' : isDrums ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${(ch.volume / 127) * 100}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ACTIVE CHANNEL DETAIL CONTROLS */}
          <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            
            {/* COLUMN 1: PATCH / PROGRAM SELECTOR */}
            <div className="flex flex-col gap-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center justify-between">
                <span>Ch {selectedChannel + 1} Patch</span>
                <span className="text-cyan-400">CC 0 / Prog</span>
              </label>

              {selectedChannel === 9 ? (
                <div className="p-3 bg-amber-950/30 border border-amber-800/40 rounded-lg text-amber-300 text-xs font-mono">
                  <div className="font-bold flex items-center gap-1.5">
                    <span>🥁 Standard GM Drum Kit</span>
                  </div>
                  <p className="text-[10px] text-amber-400/80 mt-1 font-sans">
                    Channel 10 maps MIDI notes 35-81 to genuine percussion: Bass Drum, Snare, Hi-Hats, Toms, Crash, and Ride.
                  </p>
                </div>
              ) : (
                <select
                  value={currentCh.program}
                  onChange={(e) => handleProgramChange(parseInt(e.target.value, 10))}
                  className="bg-black border border-zinc-750 text-zinc-200 rounded-lg p-2 text-xs font-mono focus:outline-none focus:border-cyan-500 cursor-pointer"
                  size={6}
                >
                  {DEFAULT_GM_PROGRAMS.map((name, pIdx) => (
                    <option key={pIdx} value={pIdx} className="py-0.5">
                      {pIdx.toString().padStart(3, '0')}: {name}
                    </option>
                  ))}
                </select>
              )}

              <div className="flex items-center gap-2 mt-1">
                <button
                  onClick={handleAuditionChannel}
                  className="flex-1 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-[10.5px] font-bold uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <Play size={11} fill="currentColor" />
                  <span>Audition</span>
                </button>

                <button
                  onClick={handleMuteToggle}
                  className={`px-3 py-1.5 rounded-lg text-[10.5px] font-bold uppercase tracking-wider transition cursor-pointer border ${
                    currentCh.isMuted
                      ? 'bg-red-950/50 border-red-600 text-red-300'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700'
                  }`}
                >
                  {currentCh.isMuted ? 'Unmute' : 'Mute'}
                </button>
              </div>
            </div>

            {/* COLUMN 2: VOLUME (CC 7) & PAN (CC 10) */}
            <div className="flex flex-col gap-4">
              {/* VOLUME CC 7 */}
              <div>
                <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                  <span className="font-bold text-zinc-400 uppercase">Volume (CC 7)</span>
                  <span className="text-cyan-400 font-bold">{currentCh.volume} / 127</span>
                </div>
                <input 
                  type="range" 
                  min={0}
                  max={127}
                  value={currentCh.volume}
                  onChange={(e) => handleVolumeChange(parseInt(e.target.value, 10))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
                <div className="flex justify-between text-[8px] text-zinc-550 font-mono mt-0.5">
                  <span>0 (Silent)</span>
                  <span>100 (Default)</span>
                  <span>127 (Max)</span>
                </div>
              </div>

              {/* PAN CC 10 */}
              <div>
                <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                  <span className="font-bold text-zinc-400 uppercase">Pan (CC 10)</span>
                  <span className="text-cyan-400 font-bold">
                    {currentCh.pan === 64 ? "Center (64)" : currentCh.pan < 64 ? `L${64 - currentCh.pan}` : `R${currentCh.pan - 64}`}
                  </span>
                </div>
                <input 
                  type="range"
                  min={0}
                  max={127}
                  value={currentCh.pan}
                  onChange={(e) => handlePanChange(parseInt(e.target.value, 10))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
                <div className="flex justify-between text-[8px] text-zinc-550 font-mono mt-0.5">
                  <span>L0 (Left)</span>
                  <button 
                    onClick={() => handlePanChange(64)}
                    className="hover:text-cyan-400 underline cursor-pointer"
                  >
                    Center
                  </button>
                  <span>R127 (Right)</span>
                </div>
              </div>

              {/* LIVE OSCILLOSCOPE HARMONICS SUMMARY */}
              <div className="p-2.5 bg-black/60 border border-zinc-800 rounded-lg text-[9px] font-mono flex flex-col gap-0.5">
                <span className="text-zinc-500 uppercase font-bold text-[8px]">Oscilloscope Route:</span>
                <span className="text-emerald-400 font-semibold truncate">
                  Ch {selectedChannel + 1} &rarr; WebScope Analyser [{selectedChannel}]
                </span>
              </div>
            </div>

            {/* COLUMN 3: TACTILE MIDI PITCH BEND WHEEL */}
            <div className="flex flex-col gap-2.5 p-3 bg-zinc-950/70 border border-zinc-800 rounded-xl">
              <div className="flex items-center justify-between text-[10px] font-mono">
                <span className="font-bold text-zinc-300 uppercase flex items-center gap-1">
                  <ArrowUpDown size={12} className="text-indigo-400" />
                  Pitch Wheel
                </span>
                <div className="flex items-center gap-1.5">
                  <span className={`font-mono font-black text-[10px] px-1.5 py-0.2 rounded border ${
                    currentCh.pitchBend !== 0 
                      ? 'bg-indigo-950 text-indigo-300 border-indigo-600' 
                      : 'bg-zinc-900 text-zinc-500 border-zinc-800'
                  }`}>
                    {((currentCh.pitchBend / 8192) * (currentCh.pitchBendRange || 2)) > 0 ? '+' : ''}
                    {((currentCh.pitchBend / 8192) * (currentCh.pitchBendRange || 2)).toFixed(2)} ST
                  </span>
                  
                  {/* Hold Center Lock Toggle */}
                  <button
                    onClick={() => setHoldPitchWheel(!holdPitchWheel)}
                    className={`p-1 rounded transition cursor-pointer ${
                      holdPitchWheel 
                        ? 'bg-amber-950/70 text-amber-300 border border-amber-600' 
                        : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300 border border-zinc-800'
                    }`}
                    title={holdPitchWheel ? "Spring Return Locked (Pitch stays where released)" : "Spring Return Active (Snaps to 0 on release)"}
                  >
                    {holdPitchWheel ? <Lock size={10} /> : <Unlock size={10} />}
                  </button>
                </div>
              </div>

              {/* TACTILE WHEEL VISUALIZER & DRAGGER */}
              <div className="flex items-center gap-3">
                {/* Vertical Spring Wheel */}
                <div className="relative w-12 h-24 bg-gradient-to-b from-zinc-900 via-zinc-800 to-zinc-900 border-2 border-zinc-700 rounded-lg overflow-hidden shadow-inner flex flex-col justify-center items-center select-none group">
                  {/* Ribbed lines to look like a physical synthesizer pitch wheel */}
                  <div className="absolute inset-0 flex flex-col justify-between py-1 pointer-events-none opacity-40">
                    {Array.from({ length: 9 }).map((_, i) => (
                      <div key={i} className="h-0.5 w-full bg-zinc-400" />
                    ))}
                  </div>

                  {/* Center Zero Marker Indicator */}
                  <div className="absolute top-1/2 left-0 right-0 h-1 bg-cyan-400 -translate-y-1/2 shadow-[0_0_8px_rgba(6,182,212,0.8)] z-10" />

                  {/* Wheel Handle */}
                  <div 
                    className="absolute w-full h-5 bg-gradient-to-r from-zinc-600 via-zinc-300 to-zinc-600 rounded border border-zinc-400 transition-all shadow-md pointer-events-none"
                    style={{
                      top: `${50 - (currentCh.pitchBend / 8192) * 40}%`,
                      transform: 'translateY(-50%)'
                    }}
                  />

                  {/* Hidden Vertical Input Overlay */}
                  <input
                    type="range"
                    min={-8192}
                    max={8191}
                    value={currentCh.pitchBend}
                    onChange={(e) => handlePitchBendChange(parseInt(e.target.value, 10))}
                    onMouseUp={handlePitchWheelRelease}
                    onTouchEnd={handlePitchWheelRelease}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-ns-resize"
                    title="Drag up to bend pitch up, drag down to bend pitch down. Spring returns to center on release."
                  />
                </div>

                {/* Pitch Wheel Presets & Range */}
                <div className="flex-1 flex flex-col gap-1.5 text-[9px] font-mono">
                  <div className="text-zinc-500 uppercase font-bold text-[8px]">Quick Nudge:</div>
                  <div className="grid grid-cols-3 gap-1">
                    <button
                      onClick={() => {
                        handlePitchBendChange(-8192);
                        if (!holdPitchWheel) setTimeout(handlePitchWheelRelease, 350);
                      }}
                      className="px-1 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 active:scale-95 transition text-center"
                    >
                      -1 Oct
                    </button>
                    <button
                      onClick={() => handlePitchBendChange(0)}
                      className="px-1 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-cyan-400 font-bold border border-zinc-800 active:scale-95 transition text-center"
                    >
                      Zero (0)
                    </button>
                    <button
                      onClick={() => {
                        handlePitchBendChange(8191);
                        if (!holdPitchWheel) setTimeout(handlePitchWheelRelease, 350);
                      }}
                      className="px-1 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 active:scale-95 transition text-center"
                    >
                      +1 Oct
                    </button>
                  </div>

                  <div className="text-zinc-500 uppercase font-bold text-[8px] mt-0.5">Bend Range:</div>
                  <div className="grid grid-cols-4 gap-1">
                    {[2, 7, 12, 24].map((semi) => (
                      <button
                        key={semi}
                        onClick={() => handlePitchRangeSelect(semi)}
                        className={`py-0.5 rounded text-[8.5px] font-bold border transition ${
                          (currentCh.pitchBendRange || 2) === semi
                            ? 'bg-indigo-600 text-white border-indigo-400'
                            : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                        }`}
                        title={`+/-${semi} Semitones`}
                      >
                        ±{semi}ST
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* COLUMN 4: PORTAMENTO GLIDE & PORTAMENTO CTRL (CC 65, CC 5, CC 84) */}
            <div className="flex flex-col gap-2.5 p-3 bg-zinc-950/70 border border-zinc-800 rounded-xl">
              <div className="flex items-center justify-between text-[10px] font-mono">
                <span className="font-bold text-zinc-300 uppercase flex items-center gap-1">
                  <Waves size={12} className="text-emerald-400 animate-pulse" />
                  Portamento (Glide)
                </span>
                <span className="text-[8.5px] text-zinc-500">CC 65 / 5 / 84</span>
              </div>

              {/* CC 65 PORTAMENTO ON/OFF SWITCH */}
              <button
                id="midi-portamento-toggle-btn"
                onClick={handlePortamentoToggle}
                className={`w-full py-1.5 px-3 rounded-lg border font-mono font-bold text-xs uppercase tracking-wider transition cursor-pointer flex items-center justify-between shadow-sm ${
                  currentCh.portamentoEnabled
                    ? 'bg-emerald-950/80 border-emerald-500 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${currentCh.portamentoEnabled ? 'bg-emerald-400 animate-ping' : 'bg-zinc-600'}`} />
                  <span>Portamento Glide</span>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${currentCh.portamentoEnabled ? 'bg-emerald-500 text-black font-black' : 'bg-zinc-800 text-zinc-500'}`}>
                  {currentCh.portamentoEnabled ? 'ON' : 'OFF'}
                </span>
              </button>

              {/* CC 5 PORTAMENTO TIME (GLIDE RATE) */}
              <div>
                <div className="flex items-center justify-between text-[9.5px] font-mono mb-1">
                  <span className="text-zinc-400 font-bold uppercase">Glide Time (CC 5)</span>
                  <span className="text-emerald-400 font-bold">
                    {Math.round(20 + ((currentCh.portamentoTime ?? 64) / 127) * 1580)} ms
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={127}
                  value={currentCh.portamentoTime ?? 64}
                  onChange={(e) => handlePortamentoTimeChange(parseInt(e.target.value, 10))}
                  className="w-full accent-emerald-400 cursor-pointer h-1.5 bg-zinc-900 rounded"
                />
                <div className="flex justify-between text-[7.5px] text-zinc-550 font-mono mt-0.5">
                  <span>Fast (20ms)</span>
                  <span>Normal (800ms)</span>
                  <span>Long (1.6s)</span>
                </div>
              </div>

              {/* CC 84 PORTAMENTO CONTROL (SOURCE NOTE) */}
              <div>
                <div className="flex items-center justify-between text-[9.5px] font-mono mb-1">
                  <span className="text-zinc-400 font-bold uppercase">Porta Ctrl (CC 84)</span>
                  <span className="text-amber-400 font-bold">
                    {currentCh.portamentoControl !== null ? `Key ${currentCh.portamentoControl}` : 'Auto (Last Key)'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={currentCh.portamentoControl ?? -1}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      handlePortamentoCtrlChange(val === -1 ? null : val);
                    }}
                    className="flex-1 bg-black border border-zinc-800 text-zinc-200 rounded px-2 py-1 text-[9px] font-mono focus:outline-none focus:border-amber-500 cursor-pointer"
                  >
                    <option value={-1}>Auto (Glides from Last Played Note)</option>
                    <option value={48}>C3 (48)</option>
                    <option value={52}>E3 (52)</option>
                    <option value={55}>G3 (55)</option>
                    <option value={60}>C4 (60 - Middle C)</option>
                    <option value={64}>E4 (64)</option>
                    <option value={67}>G4 (67)</option>
                    <option value={72}>C5 (72)</option>
                  </select>
                </div>
              </div>

              {/* SLIDING NOTES DEMO TRIGGER BUTTONS */}
              <div className="pt-1 border-t border-zinc-850">
                <span className="text-[8px] text-zinc-500 uppercase font-bold block mb-1">Audition Sliding Notes:</span>
                <div className="grid grid-cols-3 gap-1">
                  <button
                    onClick={() => handleTriggerSlidingTest(48, 67)}
                    className="py-1 px-1 rounded bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/50 text-[8px] font-bold uppercase tracking-wider transition cursor-pointer text-center truncate"
                    title="Slide C3 to G3"
                  >
                    Slide C3&rarr;G3
                  </button>
                  <button
                    onClick={() => handleTriggerSlidingTest(52, 71)}
                    className="py-1 px-1 rounded bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/50 text-[8px] font-bold uppercase tracking-wider transition cursor-pointer text-center truncate"
                    title="Slide E3 to B4"
                  >
                    Slide E3&rarr;B4
                  </button>
                  <button
                    onClick={() => handleTriggerSlidingTest(48, 72)}
                    className="py-1 px-1 rounded bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/50 text-[8px] font-bold uppercase tracking-wider transition cursor-pointer text-center truncate"
                    title="Slide C3 to C5 (Full 2-Octave Portamento)"
                  >
                    Slide C3&rarr;C5
                  </button>
                </div>
              </div>

            </div>

          </div>

          {/* INTERACTIVE 2-OCTAVE VIRTUAL KEYBOARD */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-1.5">
                <Piano size={12} className="text-cyan-400" />
                Audition Virtual Keyboard (Channel {selectedChannel + 1})
              </span>
              <span className="text-[9px] text-zinc-500 font-mono">
                Click or tap keys to audition instrument soundfonts
              </span>
            </div>

            <div className="relative h-28 bg-zinc-950 border border-zinc-800 rounded-xl p-2 flex overflow-x-auto custom-scrollbar select-none">
              {KEYBOARD_NOTES.filter(k => !k.isBlack).map(whiteKey => {
                const isPlayingThis = activeMidiNotes.has(whiteKey.midi);
                // Look for black key right above
                const blackKey = KEYBOARD_NOTES.find(k => k.isBlack && k.midi === whiteKey.midi + 1);

                return (
                  <div key={whiteKey.midi} className="relative flex-1 min-w-[36px] max-w-[50px] h-full flex flex-col">
                    {/* White Key */}
                    <button
                      onClick={() => handlePlayKey(whiteKey.midi)}
                      className={`w-full h-full rounded-b-md border transition-all cursor-pointer flex flex-col justify-end items-center pb-1 text-[8.5px] font-mono font-bold ${
                        isPlayingThis
                          ? 'bg-cyan-300 text-black border-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.8)] scale-y-98'
                          : 'bg-zinc-200 hover:bg-white text-zinc-700 border-zinc-400 shadow-sm'
                      }`}
                    >
                      {whiteKey.name}
                    </button>

                    {/* Black Key */}
                    {blackKey && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePlayKey(blackKey.midi);
                        }}
                        className={`absolute -right-3.5 top-0 w-6 h-15 rounded-b z-10 transition-all cursor-pointer flex flex-col justify-end items-center pb-1 text-[7.5px] font-mono font-bold ${
                          activeMidiNotes.has(blackKey.midi)
                            ? 'bg-cyan-400 text-black shadow-[0_0_12px_rgba(6,182,212,0.9)]'
                            : 'bg-zinc-900 hover:bg-black text-zinc-300 border border-zinc-700 shadow-md'
                        }`}
                      >
                        {blackKey.name}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* STATUS FOOTER */}
        <div className="px-5 py-2.5 bg-zinc-900/80 border-t border-zinc-800 flex items-center justify-between text-[10px] font-mono">
          <div className="flex items-center gap-2 truncate">
            <span className="text-cyan-400 font-bold uppercase shrink-0">STATUS:</span>
            <span className="text-zinc-350 truncate">{systemLog}</span>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg font-bold text-[10.5px] uppercase tracking-wider transition cursor-pointer"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
}
