import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  ArrowUpDown,
  Disc3,
  Drum,
  Layers,
  Lock,
  Music2,
  Piano,
  Play,
  Radio,
  RotateCcw,
  Sliders,
  Sparkles,
  Unlock,
  Volume2,
  VolumeX,
  Waves
} from 'lucide-react';
import { MIDIPatchFull } from 'spessasynth_core';
import {
  VelocityCurveType,
  WORKLET_CC,
  WorkletChannelMixerState,
  WorkletSynthBridge
} from '../engines/workletSynthBridge';
import { DEFAULT_GM_PROGRAMS, SpessaSoundFont, SpessaSynth } from '../engines/spressasynthLib';
import { getAudioContext, setMidiChannelMuted } from './AudioEngine';
import { getAvailableSoundFontInstruments } from '../utils/soundFontEngine';
import { getSavedSelectedSoundFont, saveSelectedSoundFont } from '../utils/recentSongsManager';

interface SpessaMidiMixerPanelProps {
  compact?: boolean;
  onSelectSoundFont?: (presetId: string) => void;
  onChannelMuteSync?: (channelIdx0: number, isMuted: boolean) => void;
}

const KEYBOARD_NOTES = [
  { midi: 48, name: 'C3', isBlack: false },
  { midi: 49, name: 'C#3', isBlack: true },
  { midi: 50, name: 'D3', isBlack: false },
  { midi: 51, name: 'D#3', isBlack: true },
  { midi: 52, name: 'E3', isBlack: false },
  { midi: 53, name: 'F3', isBlack: false },
  { midi: 54, name: 'F#3', isBlack: true },
  { midi: 55, name: 'G3', isBlack: false },
  { midi: 56, name: 'G#3', isBlack: true },
  { midi: 57, name: 'A3', isBlack: false },
  { midi: 58, name: 'A#3', isBlack: true },
  { midi: 59, name: 'B3', isBlack: false },
  { midi: 60, name: 'C4', isBlack: false },
  { midi: 61, name: 'C#4', isBlack: true },
  { midi: 62, name: 'D4', isBlack: false },
  { midi: 63, name: 'D#4', isBlack: true },
  { midi: 64, name: 'E4', isBlack: false },
  { midi: 65, name: 'F4', isBlack: false },
  { midi: 66, name: 'F#4', isBlack: true },
  { midi: 67, name: 'G4', isBlack: false },
  { midi: 68, name: 'G#4', isBlack: true },
  { midi: 69, name: 'A4', isBlack: false },
  { midi: 70, name: 'A#4', isBlack: true },
  { midi: 71, name: 'B4', isBlack: false }
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function formatMidiNote(n: number): string {
  const oct = Math.floor(n / 12) - 1;
  return `${NOTE_NAMES[n % 12]}${oct} (${n})`;
}

interface CCSliderProps {
  label: string;
  ccNumber: number;
  value: number;
  isLocked: boolean;
  onChange: (val: number) => void;
  onToggleLock: () => void;
  formatValue?: (val: number) => string;
  accentClass?: string;
  quickCenter?: number;
}

function LockedCCSlider({
  label,
  ccNumber,
  value,
  isLocked,
  onChange,
  onToggleLock,
  formatValue,
  accentClass = 'accent-cyan-400',
  quickCenter
}: CCSliderProps) {
  return (
    <div
      className={`p-2 rounded-lg border transition ${
        isLocked
          ? 'bg-amber-950/20 border-amber-600/50'
          : 'bg-zinc-950/75 border-zinc-800/90 hover:border-zinc-700'
      }`}
    >
      <div className="flex items-center justify-between gap-1.5 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[10px] font-bold text-zinc-200 truncate">{label}</span>
          <span className="text-[8.5px] font-mono text-zinc-500 shrink-0">CC {ccNumber}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {quickCenter !== undefined && value !== quickCenter && (
            <button
              type="button"
              onClick={() => onChange(quickCenter)}
              className="text-[8px] font-mono px-1 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-cyan-300 cursor-pointer"
              title={`Reset ${label} to ${quickCenter}`}
            >
              {quickCenter}
            </button>
          )}
          <span className="text-[10px] font-mono font-bold text-cyan-300 tabular-nums min-w-[36px] text-right">
            {formatValue ? formatValue(value) : value}
          </span>
          <button
            type="button"
            onClick={onToggleLock}
            aria-pressed={isLocked}
            title={
              isLocked
                ? `Unlock CC ${ccNumber} (Allow incoming MIDI events to change ${label})`
                : `Lock CC ${ccNumber} (Prevent MIDI files from overwriting ${label})`
            }
            className={`p-1 rounded border transition cursor-pointer ${
              isLocked
                ? 'bg-amber-500/20 border-amber-500 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.3)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:border-zinc-700'
            }`}
          >
            {isLocked ? <Lock size={10} /> : <Unlock size={10} />}
          </button>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={127}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className={`w-full h-1.5 bg-zinc-900 rounded cursor-pointer ${accentClass}`}
      />
    </div>
  );
}

interface CCToggleProps {
  label: string;
  ccNumber: number;
  value: number;
  isLocked: boolean;
  onToggleValue: () => void;
  onToggleLock: () => void;
  activeColor?: 'emerald' | 'cyan' | 'amber' | 'fuchsia';
}

function LockedCCToggle({
  label,
  ccNumber,
  value,
  isLocked,
  onToggleValue,
  onToggleLock,
  activeColor = 'emerald'
}: CCToggleProps) {
  const isOn = value >= 64;
  const activeStyle =
    activeColor === 'cyan'
      ? 'bg-cyan-950/80 border-cyan-500 text-cyan-200'
      : activeColor === 'amber'
        ? 'bg-amber-950/80 border-amber-500 text-amber-200'
        : activeColor === 'fuchsia'
          ? 'bg-fuchsia-950/80 border-fuchsia-500 text-fuchsia-200'
          : 'bg-emerald-950/80 border-emerald-500 text-emerald-200';

  return (
    <div
      className={`p-2 rounded-lg border flex items-center justify-between gap-2 transition ${
        isLocked
          ? 'bg-amber-950/20 border-amber-600/50'
          : 'bg-zinc-950/75 border-zinc-800/90'
      }`}
    >
      <button
        type="button"
        onClick={onToggleValue}
        aria-pressed={isOn}
        className={`flex-1 px-2.5 py-1.5 rounded border text-left transition cursor-pointer flex items-center justify-between gap-2 ${
          isOn
            ? activeStyle
            : 'bg-zinc-900/80 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
        }`}
      >
        <div className="min-w-0">
          <div className="text-[10px] font-bold truncate">{label}</div>
          <div className="text-[8px] font-mono opacity-75">CC {ccNumber}</div>
        </div>
        <span
          className={`text-[9px] font-mono font-black px-1.5 py-0.5 rounded ${
            isOn ? 'bg-white/15 text-white' : 'bg-zinc-950 text-zinc-500'
          }`}
        >
          {isOn ? 'ON (127)' : 'OFF (0)'}
        </span>
      </button>

      <button
        type="button"
        onClick={onToggleLock}
        aria-pressed={isLocked}
        title={isLocked ? `Unlock CC ${ccNumber}` : `Lock CC ${ccNumber}`}
        className={`p-1.5 rounded border transition cursor-pointer shrink-0 ${
          isLocked
            ? 'bg-amber-500/20 border-amber-500 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.3)]'
            : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:border-zinc-700'
        }`}
      >
        {isLocked ? <Lock size={11} /> : <Unlock size={11} />}
      </button>
    </div>
  );
}

export default function SpessaMidiMixerPanel({
  compact = false,
  onSelectSoundFont,
  onChannelMuteSync
}: SpessaMidiMixerPanelProps) {
  const [selectedChannel, setSelectedChannel] = useState<number>(0);
  const [channelBankTab, setChannelBankTab] = useState<'1-16' | '17-32' | '33-48'>('1-16');
  const [channelStates, setChannelStates] = useState<WorkletChannelMixerState[]>(() =>
    WorkletSynthBridge.getChannelStates(48)
  );
  const [presetList, setPresetList] = useState<MIDIPatchFull[]>(() => WorkletSynthBridge.getPresetList());
  const [isSynthReady, setIsSynthReady] = useState<boolean>(() => WorkletSynthBridge.isReadySync());
  const [loadedSoundFonts, setLoadedSoundFonts] = useState<SpessaSoundFont[]>(() =>
    SpessaSynth.getLoadedSoundFonts()
  );
  const [activeSoundFontId, setActiveSoundFontId] = useState<string>(
    () => SpessaSynth.getActiveSoundFont()?.id || 'spessa-default-gm'
  );
  const [selectedPresetFilter, setSelectedPresetFilter] = useState<'auto' | 'all' | 'melodic' | 'drums'>('auto');
  const [holdPitchWheel, setHoldPitchWheel] = useState<boolean>(false);
  const [systemLog, setSystemLog] = useState<string>(
    WorkletSynthBridge.isReadySync()
      ? `WorkletSynthesizer Ready (${WorkletSynthBridge.getPresetList().length} presets loaded)`
      : 'Initializing WorkletSynthesizer (spessasynth_lib AudioWorklet)...'
  );
  const [activeSection, setActiveSection] = useState<'all' | 'mix' | 'tone'>('all');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const ctx = getAudioContext();
    void WorkletSynthBridge.init(ctx || undefined).then((synth) => {
      if (!mountedRef.current) return;
      setIsSynthReady(Boolean(synth && WorkletSynthBridge.isReadySync()));
      setPresetList(WorkletSynthBridge.getPresetList());
      setChannelStates(WorkletSynthBridge.getChannelStates(48));
    });

    const unsubBridge = WorkletSynthBridge.subscribe(() => {
      if (!mountedRef.current) return;
      setIsSynthReady(WorkletSynthBridge.isReadySync());
      setPresetList(WorkletSynthBridge.getPresetList());
      setChannelStates(WorkletSynthBridge.getChannelStates(48));
    });

    const unsubLog = WorkletSynthBridge.onLog((msg) => {
      if (!mountedRef.current) return;
      setSystemLog(msg);
    });

    const unsubSf = SpessaSynth.onSoundFontChange((fonts, activeId) => {
      if (!mountedRef.current) return;
      setLoadedSoundFonts(fonts);
      setActiveSoundFontId(activeId);
    });

    // Ensure initial built-in list hydration
    void getAvailableSoundFontInstruments();

    return () => {
      mountedRef.current = false;
      unsubBridge();
      unsubLog();
      unsubSf();
    };
  }, []);

  const bankOffset = channelBankTab === '1-16' ? 0 : channelBankTab === '17-32' ? 16 : 32;
  const currentCh = channelStates[selectedChannel] || WorkletSynthBridge.getChannelState(selectedChannel);

  const visiblePresets = useMemo(() => {
    const mode =
      selectedPresetFilter === 'auto'
        ? currentCh.isDrum
          ? 'drums'
          : 'melodic'
        : selectedPresetFilter;
    if (mode === 'all') return presetList;
    if (mode === 'drums') return presetList.filter((p) => p.isDrum);
    return presetList.filter((p) => !p.isDrum);
  }, [presetList, selectedPresetFilter, currentCh.isDrum]);

  const currentPresetKey = useMemo(() => {
    const match =
      visiblePresets.find(
        (p) =>
          p.bankMSB === currentCh.bankMSB &&
          p.bankLSB === currentCh.bankLSB &&
          p.program === currentCh.program &&
          Boolean(p.isDrum) === Boolean(currentCh.isDrum)
      ) ||
      visiblePresets.find((p) => p.program === currentCh.program && Boolean(p.isDrum) === Boolean(currentCh.isDrum));
    if (match) {
      return `${match.bankMSB}:${match.bankLSB}:${match.program}:${match.isDrum ? 1 : 0}`;
    }
    return '';
  }, [visiblePresets, currentCh]);

  const isAllChannelLocked = useMemo(() => {
    const lockedCount = Object.values(currentCh.lockedCCs).filter(Boolean).length;
    return currentCh.presetLocked && lockedCount >= 18;
  }, [currentCh]);

  const anyGlobalLocked = useMemo(() => {
    return channelStates
      .slice(0, 16)
      .some((st) => st.presetLocked || Object.values(st.lockedCCs).some(Boolean));
  }, [channelStates]);

  const handleMuteToggle = (chIdx: number) => {
    const nextMuted = !channelStates[chIdx]?.isMuted;
    if (chIdx < 16) {
      setMidiChannelMuted(chIdx, nextMuted);
    } else {
      WorkletSynthBridge.muteChannel(chIdx, nextMuted);
    }
    onChannelMuteSync?.(chIdx, nextMuted);
    setSystemLog(`CH ${chIdx + 1}: ${nextMuted ? 'MUTED' : 'UNMUTED'}`);
  };

  const handleSoloToggle = (chIdx: number) => {
    WorkletSynthBridge.toggleSoloChannel(chIdx);
    const updated = WorkletSynthBridge.getChannelStates(16);
    updated.forEach((st, i) => onChannelMuteSync?.(i, st.isMuted));
  };

  const handlePlayKey = (midiNote: number) => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume();
    }
    WorkletSynthBridge.noteOn(selectedChannel, midiNote, 108);
    setTimeout(() => {
      WorkletSynthBridge.noteOff(selectedChannel, midiNote);
    }, 420);
  };

  const handleAuditionChannel = () => {
    const notes = currentCh.isDrum ? [36, 38, 42, 46, 49] : [60, 64, 67, 72];
    notes.forEach((n, idx) => {
      setTimeout(() => handlePlayKey(n), idx * 130);
    });
  };

  const handlePitchWheelRelease = () => {
    if (!holdPitchWheel) {
      WorkletSynthBridge.setPitchWheelSigned(selectedChannel, 0, true);
    }
  };

  const handleSoundFontSwitch = (sfId: string) => {
    setActiveSoundFontId(sfId);
    SpessaSynth.setActiveSoundFont(sfId);
    WorkletSynthBridge.setActiveSoundBank(sfId);
    saveSelectedSoundFont(sfId || getSavedSelectedSoundFont());
    onSelectSoundFont?.(sfId);
    setSystemLog(`Active SoundFont switched to "${sfId}"`);
  };

  const activeNotesSet = useMemo(() => new Set(currentCh.activeNotes), [currentCh.activeNotes]);

  return (
    <div className="flex flex-col gap-3.5 text-zinc-200">
      {/* GLOBAL SYNTHESIS & SYSEX RESET CONTROL BAR */}
      <div className="p-2.5 bg-zinc-900/70 border border-zinc-800 rounded-xl flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1.5 pr-1">
            <span
              className={`w-2 h-2 rounded-full ${
                isSynthReady
                  ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]'
                  : 'bg-amber-400 animate-pulse'
              }`}
            />
            <span className="text-[9.5px] font-mono font-bold uppercase tracking-wider text-zinc-400">
              {isSynthReady ? 'WorkletSynthesizer Live' : 'Booting Worklet...'}
            </span>
          </div>

          <button
            type="button"
            id="midi-global-gm-reset"
            onClick={() => WorkletSynthBridge.sendGMSystemOn()}
            className="px-2 py-1 rounded bg-emerald-950/50 border border-emerald-600/45 hover:bg-emerald-900/60 text-emerald-300 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1"
            title="Send GM System On SysEx (F0 7E 7F 09 01 F7)"
          >
            <RotateCcw size={10} />
            <span>GM On</span>
          </button>

          <button
            type="button"
            id="midi-global-gs-reset"
            onClick={() => WorkletSynthBridge.sendGSReset()}
            className="px-2 py-1 rounded bg-amber-950/50 border border-amber-600/45 hover:bg-amber-900/60 text-amber-300 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1"
            title="Send Roland GS Reset SysEx (F0 41 10 42 12 40 00 7F 00 41 F7)"
          >
            <Sparkles size={10} />
            <span>GS Reset</span>
          </button>

          <button
            type="button"
            id="midi-global-xg-reset"
            onClick={() => WorkletSynthBridge.sendXGSystemOn()}
            className="px-2 py-1 rounded bg-blue-950/50 border border-blue-600/45 hover:bg-blue-900/60 text-blue-300 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1"
            title="Send Yamaha XG System On SysEx (F0 43 10 4C 00 00 7E 00 F7)"
          >
            <Radio size={10} />
            <span>XG On</span>
          </button>

          <button
            type="button"
            id="midi-global-cc120-off"
            onClick={() => WorkletSynthBridge.sendAllSoundOff()}
            className="px-2 py-1 rounded bg-red-950/60 border border-red-600/50 hover:bg-red-900 text-red-200 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1"
            title="Send CC 120 (All Sound Off) + Stop All across all channels"
          >
            <AlertOctagon size={10} />
            <span>All Sound Off (CC 120)</span>
          </button>

          <button
            type="button"
            id="midi-global-cc121-reset"
            onClick={() => WorkletSynthBridge.sendResetAllControllers()}
            className="px-2 py-1 rounded bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 text-zinc-200 font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1"
            title="Send CC 121 (Reset All Controllers) across all channels"
          >
            <RotateCcw size={10} />
            <span>Reset CCs (CC 121)</span>
          </button>

          <button
            type="button"
            id="midi-global-lock-all"
            onClick={() => WorkletSynthBridge.lockAllControllers(!anyGlobalLocked)}
            className={`px-2.5 py-1 rounded border font-mono font-bold text-[10px] uppercase transition cursor-pointer flex items-center gap-1 ${
              anyGlobalLocked
                ? 'bg-amber-600/25 border-amber-400 text-amber-200 shadow-[0_0_10px_rgba(245,158,11,0.25)]'
                : 'bg-zinc-900 border-zinc-700 hover:border-amber-500/60 text-zinc-300 hover:text-amber-200'
            }`}
            title={
              anyGlobalLocked
                ? 'Unlock All Controllers & Presets across Channels 1–16'
                : 'Lock All Controllers & Presets across Channels 1–16'
            }
          >
            {anyGlobalLocked ? <Unlock size={10} /> : <Lock size={10} />}
            <span>{anyGlobalLocked ? 'Unlock All (16 CH)' : 'Lock All (16 CH)'}</span>
          </button>
        </div>

        {/* SOUNDFONT BANK SELECTOR */}
        <div className="flex items-center gap-2">
          <Disc3 size={13} className="text-emerald-400 shrink-0" />
          <span className="text-[9.5px] font-mono font-bold text-zinc-400 uppercase">Bank:</span>
          <select
            value={activeSoundFontId}
            onChange={(e) => handleSoundFontSwitch(e.target.value)}
            className="bg-zinc-950 border border-zinc-700 text-emerald-300 font-mono text-[10.5px] rounded px-2 py-1 focus:outline-none focus:border-cyan-500 cursor-pointer max-w-[200px]"
          >
            {loadedSoundFonts.map((sf) => (
              <option key={sf.id} value={sf.id} className="bg-zinc-950 text-zinc-200">
                {sf.name} {sf.isCustom ? '(SF2/SF3)' : '(Built-in)'}
              </option>
            ))}
          </select>
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-950/60 border border-cyan-800/50 text-cyan-300">
            {presetList.length} Patches
          </span>
        </div>
      </div>

      {/* CHANNEL MATRIX SELECTOR (PRIMARY CH 1-16 + ARIA48 CH 17-48 ROUTING) */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <Layers size={13} className="text-cyan-400" />
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-300">
              Channel Mixer Matrix
            </span>
            <div className="flex items-center gap-1 ml-1">
              {(['1-16', '17-32', '33-48'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setChannelBankTab(tab);
                    const nextStart = tab === '1-16' ? 0 : tab === '17-32' ? 16 : 32;
                    setSelectedChannel(nextStart);
                  }}
                  className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold border transition cursor-pointer ${
                    channelBankTab === tab
                      ? 'bg-cyan-600 text-white border-cyan-400'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  CH {tab}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-[9.5px] font-mono text-zinc-500">
            <span>Selected: <strong className="text-cyan-300">CH {(selectedChannel + 1).toString().padStart(2, '0')}</strong></span>
            <span>|</span>
            <span>Vol {currentCh.cc[WORKLET_CC.VOLUME] ?? 100}</span>
            <span>|</span>
            <span>Pan {currentCh.cc[WORKLET_CC.PAN] ?? 64}</span>
          </div>
        </div>

        <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
          {Array.from({ length: 16 }, (_, idx) => {
            const chIdx = bankOffset + idx;
            const st = channelStates[chIdx] || WorkletSynthBridge.getChannelState(chIdx);
            const isSelected = selectedChannel === chIdx;
            const hasActivity = st.activeNotes.length > 0;
            const chVol = st.cc[WORKLET_CC.VOLUME] ?? 100;

            return (
              <div
                key={chIdx}
                onClick={() => setSelectedChannel(chIdx)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedChannel(chIdx);
                  }
                }}
                className={`p-1.5 rounded-lg border text-left transition flex flex-col justify-between cursor-pointer select-none ${
                  isSelected
                    ? 'bg-cyan-950/60 border-cyan-500 text-white shadow-[0_0_12px_rgba(6,182,212,0.25)]'
                    : st.isMuted
                      ? 'bg-red-950/15 border-red-900/50 text-zinc-500 hover:border-red-700/60'
                      : st.isDrum
                        ? 'bg-amber-950/20 border-amber-800/45 text-amber-200 hover:border-amber-600/60'
                        : 'bg-zinc-900/75 border-zinc-800 hover:border-zinc-700 text-zinc-300'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1 min-w-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        hasActivity
                          ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]'
                          : isSelected
                            ? 'bg-cyan-400'
                            : 'bg-zinc-700'
                      }`}
                    />
                    <span className="text-[10px] font-black font-mono">
                      {(chIdx + 1).toString().padStart(2, '0')}
                    </span>
                    {st.presetLocked && <Lock size={8} className="text-amber-400 shrink-0" />}
                    {st.isDrum && (
                      <span className="text-[7px] px-1 rounded bg-amber-900/70 text-amber-300 font-mono font-bold">
                        DRM
                      </span>
                    )}
                  </div>

                  {/* Quick inline Mute / Solo toggles per channel */}
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMuteToggle(chIdx);
                      }}
                      className={`px-1 rounded text-[7.5px] font-mono font-black border cursor-pointer ${
                        st.isMuted
                          ? 'bg-red-600 text-white border-red-400'
                          : 'bg-zinc-950 text-zinc-500 border-zinc-800 hover:text-zinc-200'
                      }`}
                      title={`Mute CH ${chIdx + 1}`}
                    >
                      M
                    </button>
                    {chIdx < 16 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSoloToggle(chIdx);
                        }}
                        className={`px-1 rounded text-[7.5px] font-mono font-black border cursor-pointer ${
                          st.isSolo
                            ? 'bg-amber-500 text-black border-amber-300'
                            : 'bg-zinc-950 text-zinc-500 border-zinc-800 hover:text-zinc-200'
                        }`}
                        title={`Solo CH ${chIdx + 1}`}
                      >
                        S
                      </button>
                    )}
                  </div>
                </div>

                <div className="text-[8.5px] truncate font-sans mt-0.5 text-zinc-300" title={st.patchName}>
                  {st.patchName}
                </div>

                <div className="w-full bg-zinc-950 rounded-full h-1 overflow-hidden mt-1">
                  <div
                    className={`h-full transition-all ${
                      st.isMuted
                        ? 'bg-red-600/60'
                        : isSelected
                          ? 'bg-cyan-400'
                          : st.isDrum
                            ? 'bg-amber-400'
                            : 'bg-emerald-500'
                    }`}
                    style={{ width: `${(chVol / 127) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* SECTION FILTER TABS FOR COMPACT / FULL VIEW */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-zinc-900/60 border border-zinc-800 rounded-lg">
        <div className="flex items-center gap-2">
          <Sliders size={13} className="text-cyan-400" />
          <span className="text-[10.5px] font-mono font-bold text-white uppercase">
            CH {(selectedChannel + 1).toString().padStart(2, '0')} Inspector
          </span>
          <span className="text-[9px] font-mono text-zinc-400">
            Bank {currentCh.bankMSB.toString().padStart(3, '0')}:{currentCh.bankLSB.toString().padStart(3, '0')} · Prog{' '}
            {currentCh.program.toString().padStart(3, '0')}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {compact && (
            <div className="flex items-center gap-1 mr-2">
              {(['all', 'mix', 'tone'] as const).map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setActiveSection(sec)}
                  className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase border cursor-pointer ${
                    activeSection === sec
                      ? 'bg-cyan-950 border-cyan-500 text-cyan-200'
                      : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {sec === 'all' ? 'All Sections' : sec === 'mix' ? 'Patch & Mix' : 'Tone & FX'}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => WorkletSynthBridge.lockAllControllers(!isAllChannelLocked, selectedChannel)}
            className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase border transition cursor-pointer flex items-center gap-1 ${
              isAllChannelLocked
                ? 'bg-amber-950/70 border-amber-500 text-amber-300'
                : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-amber-300 hover:border-amber-500/50'
            }`}
            title={`Lock/Unlock every controller on CH ${selectedChannel + 1}`}
          >
            {isAllChannelLocked ? <Unlock size={9} /> : <Lock size={9} />}
            <span>{isAllChannelLocked ? `Unlock CH ${selectedChannel + 1}` : `Lock CH ${selectedChannel + 1}`}</span>
          </button>
        </div>
      </div>

      {/* PANEL 1: INSTRUMENT & CHANNEL MANAGEMENT CONTROLS */}
      {(activeSection === 'all' || activeSection === 'mix') && (
        <div className="p-3 bg-zinc-900/45 border border-zinc-800 rounded-xl grid grid-cols-1 lg:grid-cols-12 gap-3">
          {/* BANK + PROGRAM PRESET SELECTOR & PRESET LOCK (5 cols) */}
          <div className="lg:col-span-5 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
                <Music2 size={12} className="text-cyan-400" />
                <span>Bank + Program Preset (synth.presetList)</span>
              </label>

              <div className="flex items-center gap-1">
                {(['auto', 'melodic', 'drums', 'all'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setSelectedPresetFilter(f)}
                    className={`px-1.5 py-0.5 rounded text-[8px] font-mono font-bold uppercase border cursor-pointer ${
                      selectedPresetFilter === f
                        ? 'bg-cyan-950 border-cyan-500 text-cyan-300'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {visiblePresets.length > 0 ? (
              <select
                id="midi-preset-selector"
                value={currentPresetKey}
                onChange={(e) => {
                  const [msbStr, lsbStr, progStr, drumStr] = e.target.value.split(':');
                  WorkletSynthBridge.selectPreset(
                    selectedChannel,
                    parseInt(msbStr, 10) || 0,
                    parseInt(lsbStr, 10) || 0,
                    parseInt(progStr, 10) || 0,
                    drumStr === '1'
                  );
                }}
                className="w-full bg-black border border-zinc-750 text-cyan-200 rounded-lg p-2 text-[10.5px] font-mono focus:outline-none focus:border-cyan-500 cursor-pointer"
                size={6}
              >
                {visiblePresets.map((p) => {
                  const key = `${p.bankMSB}:${p.bankLSB}:${p.program}:${p.isDrum ? 1 : 0}`;
                  const msbLabel = p.bankMSB.toString().padStart(3, '0');
                  const lsbLabel = p.bankLSB.toString().padStart(3, '0');
                  const progLabel = p.program.toString().padStart(3, '0');
                  return (
                    <option key={key} value={key} className="py-0.5 bg-zinc-950 text-zinc-200">
                      [{msbLabel}:{lsbLabel} P{progLabel}] {p.isDrum ? '🥁 ' : ''}{p.name}
                    </option>
                  );
                })}
              </select>
            ) : (
              <select
                value={currentCh.program}
                onChange={(e) =>
                  WorkletSynthBridge.selectPreset(
                    selectedChannel,
                    currentCh.bankMSB,
                    currentCh.bankLSB,
                    parseInt(e.target.value, 10) || 0,
                    currentCh.isDrum
                  )
                }
                className="w-full bg-black border border-zinc-750 text-zinc-200 rounded-lg p-2 text-[10.5px] font-mono focus:outline-none focus:border-cyan-500 cursor-pointer"
                size={6}
              >
                {DEFAULT_GM_PROGRAMS.map((name, pIdx) => (
                  <option key={pIdx} value={pIdx} className="py-0.5 bg-zinc-950 text-zinc-200">
                    [000:000 P{pIdx.toString().padStart(3, '0')}] {name}
                  </option>
                ))}
              </select>
            )}

            {/* PRESET LOCK + DRUMS + MUTE + SOLO + AUDITION */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
              <button
                type="button"
                id="midi-preset-lock-btn"
                onClick={() =>
                  WorkletSynthBridge.lockController(
                    selectedChannel,
                    WORKLET_CC.PRESET_LOCK_VIRTUAL,
                    !currentCh.presetLocked
                  )
                }
                aria-pressed={currentCh.presetLocked}
                className={`py-1.5 px-2 rounded-lg border text-[9.5px] font-mono font-bold uppercase flex items-center justify-center gap-1 transition cursor-pointer ${
                  currentCh.presetLocked
                    ? 'bg-amber-950/75 border-amber-500 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.3)]'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                }`}
                title="Lock Program / Bank (CC 0, 32, 128) against incoming MIDI file events"
              >
                {currentCh.presetLocked ? <Lock size={10} /> : <Unlock size={10} />}
                <span>Prog Lock</span>
              </button>

              <button
                type="button"
                id="midi-drum-toggle-btn"
                onClick={() => WorkletSynthBridge.setDrums(selectedChannel, !currentCh.isDrum)}
                aria-pressed={currentCh.isDrum}
                className={`py-1.5 px-2 rounded-lg border text-[9.5px] font-mono font-bold uppercase flex items-center justify-center gap-1 transition cursor-pointer ${
                  currentCh.isDrum
                    ? 'bg-amber-600/25 border-amber-400 text-amber-200'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                }`}
                title="Switch channel between Melodic Presets and Drum Kit (synth.setDrums)"
              >
                <Drum size={10} />
                <span>{currentCh.isDrum ? 'Drums ON' : 'Drums'}</span>
              </button>

              <button
                type="button"
                id="midi-mute-btn"
                onClick={() => handleMuteToggle(selectedChannel)}
                aria-pressed={currentCh.isMuted}
                className={`py-1.5 px-2 rounded-lg border text-[9.5px] font-mono font-bold uppercase flex items-center justify-center gap-1 transition cursor-pointer ${
                  currentCh.isMuted
                    ? 'bg-red-950/70 border-red-500 text-red-200'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                }`}
                title="Mute / Unmute Channel"
              >
                {currentCh.isMuted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                <span>{currentCh.isMuted ? 'Muted' : 'Mute'}</span>
              </button>

              <button
                type="button"
                id="midi-solo-btn"
                onClick={() => handleSoloToggle(selectedChannel)}
                disabled={selectedChannel >= 16}
                aria-pressed={currentCh.isSolo}
                className={`py-1.5 px-2 rounded-lg border text-[9.5px] font-mono font-bold uppercase flex items-center justify-center gap-1 transition ${
                  selectedChannel >= 16
                    ? 'opacity-40 cursor-not-allowed bg-zinc-950 border-zinc-800 text-zinc-600'
                    : currentCh.isSolo
                      ? 'bg-amber-500 text-black border-amber-300 cursor-pointer'
                      : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700 cursor-pointer'
                }`}
                title="Solo Channel (mutes non-soloed channels 1–16)"
              >
                <span>Solo</span>
              </button>

              <button
                type="button"
                onClick={handleAuditionChannel}
                className="py-1.5 px-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[9.5px] font-mono font-bold uppercase flex items-center justify-center gap-1 transition cursor-pointer"
                title="Play audition notes on selected channel"
              >
                <Play size={10} fill="currentColor" />
                <span>Test</span>
              </button>
            </div>

            {/* VELOCITY CURVE / SENSITIVITY */}
            <div className="p-2 bg-zinc-950/75 border border-zinc-800/90 rounded-lg flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9.5px] font-mono font-bold uppercase text-zinc-300 flex items-center gap-1">
                  <Activity size={11} className="text-emerald-400" />
                  Velocity Curve & Sensitivity
                </span>
                <div className="flex items-center gap-1">
                  {(['linear', 'soft', 'hard', 'fixed'] as VelocityCurveType[]).map((curve) => (
                    <button
                      key={curve}
                      type="button"
                      onClick={() =>
                        WorkletSynthBridge.setVelocitySensitivity(
                          selectedChannel,
                          curve,
                          currentCh.velocityDepth,
                          currentCh.velocityOffset
                        )
                      }
                      className={`px-1.5 py-0.5 rounded text-[8px] font-mono font-bold uppercase border cursor-pointer ${
                        currentCh.velocityCurve === curve
                          ? 'bg-emerald-950/80 border-emerald-500 text-emerald-300'
                          : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-200'
                      }`}
                    >
                      {curve}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="flex justify-between text-[8.5px] font-mono text-zinc-400">
                    <span>Sense Depth</span>
                    <span className="text-emerald-300 font-bold">{currentCh.velocityDepth}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={127}
                    value={currentCh.velocityDepth}
                    onChange={(e) =>
                      WorkletSynthBridge.setVelocitySensitivity(
                        selectedChannel,
                        currentCh.velocityCurve,
                        parseInt(e.target.value, 10),
                        currentCh.velocityOffset
                      )
                    }
                    className="w-full h-1.5 bg-zinc-900 rounded accent-emerald-400 cursor-pointer"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[8.5px] font-mono text-zinc-400">
                    <span>Offset Level</span>
                    <span className="text-emerald-300 font-bold">{currentCh.velocityOffset}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={127}
                    value={currentCh.velocityOffset}
                    onChange={(e) =>
                      WorkletSynthBridge.setVelocitySensitivity(
                        selectedChannel,
                        currentCh.velocityCurve,
                        currentCh.velocityDepth,
                        parseInt(e.target.value, 10)
                      )
                    }
                    className="w-full h-1.5 bg-zinc-900 rounded accent-emerald-400 cursor-pointer"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* MIX, SPATIAL & MODULATION SLIDERS + LOCKS (4 cols) */}
          <div className="lg:col-span-4 flex flex-col gap-1.5">
            <div className="text-[9.5px] font-mono font-bold uppercase tracking-wider text-zinc-400 mb-0.5">
              Mix, Spatial & Portamento (Individual Locks)
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-1.5">
              <LockedCCSlider
                label="Volume"
                ccNumber={WORKLET_CC.VOLUME}
                value={currentCh.cc[WORKLET_CC.VOLUME] ?? 100}
                isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.VOLUME])}
                quickCenter={100}
                onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.VOLUME, v)}
                onToggleLock={() =>
                  WorkletSynthBridge.lockController(
                    selectedChannel,
                    WORKLET_CC.VOLUME,
                    !currentCh.lockedCCs[WORKLET_CC.VOLUME]
                  )
                }
              />

              <LockedCCSlider
                label="Expression"
                ccNumber={WORKLET_CC.EXPRESSION}
                value={currentCh.cc[WORKLET_CC.EXPRESSION] ?? 127}
                isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.EXPRESSION])}
                quickCenter={127}
                onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.EXPRESSION, v)}
                onToggleLock={() =>
                  WorkletSynthBridge.lockController(
                    selectedChannel,
                    WORKLET_CC.EXPRESSION,
                    !currentCh.lockedCCs[WORKLET_CC.EXPRESSION]
                  )
                }
              />

              <LockedCCSlider
                label="Stereo Pan"
                ccNumber={WORKLET_CC.PAN}
                value={currentCh.cc[WORKLET_CC.PAN] ?? 64}
                isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.PAN])}
                quickCenter={64}
                formatValue={(v) => (v === 64 ? 'C (64)' : v < 64 ? `L${64 - v}` : `R${v - 64}`)}
                onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.PAN, v)}
                onToggleLock={() =>
                  WorkletSynthBridge.lockController(
                    selectedChannel,
                    WORKLET_CC.PAN,
                    !currentCh.lockedCCs[WORKLET_CC.PAN]
                  )
                }
              />

              <LockedCCSlider
                label="Modulation Wheel"
                ccNumber={WORKLET_CC.MOD_WHEEL}
                value={currentCh.cc[WORKLET_CC.MOD_WHEEL] ?? 0}
                isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.MOD_WHEEL])}
                quickCenter={0}
                accentClass="accent-indigo-400"
                onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.MOD_WHEEL, v)}
                onToggleLock={() =>
                  WorkletSynthBridge.lockController(
                    selectedChannel,
                    WORKLET_CC.MOD_WHEEL,
                    !currentCh.lockedCCs[WORKLET_CC.MOD_WHEEL]
                  )
                }
              />

              <LockedCCSlider
                label="Portamento Time"
                ccNumber={WORKLET_CC.PORTAMENTO_TIME}
                value={currentCh.cc[WORKLET_CC.PORTAMENTO_TIME] ?? 0}
                isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.PORTAMENTO_TIME])}
                quickCenter={0}
                accentClass="accent-emerald-400"
                onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.PORTAMENTO_TIME, v)}
                onToggleLock={() =>
                  WorkletSynthBridge.lockController(
                    selectedChannel,
                    WORKLET_CC.PORTAMENTO_TIME,
                    !currentCh.lockedCCs[WORKLET_CC.PORTAMENTO_TIME]
                  )
                }
              />

              <LockedCCToggle
                label="Portamento On/Off"
                ccNumber={WORKLET_CC.PORTAMENTO_ON}
                value={currentCh.cc[WORKLET_CC.PORTAMENTO_ON] ?? 0}
                isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.PORTAMENTO_ON])}
                activeColor="emerald"
                onToggleValue={() =>
                  WorkletSynthBridge.controllerChange(
                    selectedChannel,
                    WORKLET_CC.PORTAMENTO_ON,
                    (currentCh.cc[WORKLET_CC.PORTAMENTO_ON] ?? 0) >= 64 ? 0 : 127
                  )
                }
                onToggleLock={() =>
                  WorkletSynthBridge.lockController(
                    selectedChannel,
                    WORKLET_CC.PORTAMENTO_ON,
                    !currentCh.lockedCCs[WORKLET_CC.PORTAMENTO_ON]
                  )
                }
              />

              <LockedCCSlider
                label="Portamento Control"
                ccNumber={WORKLET_CC.PORTAMENTO_CTRL}
                value={currentCh.cc[WORKLET_CC.PORTAMENTO_CTRL] ?? 60}
                isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.PORTAMENTO_CTRL])}
                accentClass="accent-emerald-400"
                formatValue={(v) => formatMidiNote(v)}
                onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.PORTAMENTO_CTRL, v)}
                onToggleLock={() =>
                  WorkletSynthBridge.lockController(
                    selectedChannel,
                    WORKLET_CC.PORTAMENTO_CTRL,
                    !currentCh.lockedCCs[WORKLET_CC.PORTAMENTO_CTRL]
                  )
                }
              />
            </div>
          </div>

          {/* PITCH BEND WHEEL (-8192..8191) + RPN 0 RANGE (0-24) + PEDALS (3 cols) */}
          <div className="lg:col-span-3 flex flex-col gap-2">
            {/* PITCH WHEEL UNIT */}
            <div className="p-2.5 bg-zinc-950/80 border border-zinc-800 rounded-lg flex flex-col gap-2">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[10px] font-mono font-bold uppercase text-zinc-200 flex items-center gap-1">
                  <ArrowUpDown size={11} className="text-indigo-400" />
                  Pitch Wheel
                </span>
                <div className="flex items-center gap-1">
                  <span className="text-[9.5px] font-mono font-black text-indigo-300 tabular-nums">
                    {currentCh.pitchWheel > 0 ? `+${currentCh.pitchWheel}` : currentCh.pitchWheel} (
                    {((currentCh.pitchWheel / 8192) * currentCh.pitchWheelRange).toFixed(1)} ST)
                  </span>
                  <button
                    type="button"
                    onClick={() => setHoldPitchWheel((prev) => !prev)}
                    className={`px-1 py-0.5 rounded text-[8px] font-mono border cursor-pointer ${
                      holdPitchWheel
                        ? 'bg-indigo-950 border-indigo-500 text-indigo-200'
                        : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-200'
                    }`}
                    title={holdPitchWheel ? 'Hold active (stays on release)' : 'Spring return to 0 on release'}
                  >
                    {holdPitchWheel ? 'HOLD' : 'SPRG'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      WorkletSynthBridge.lockPitchWheel(selectedChannel, !currentCh.pitchWheelLocked)
                    }
                    className={`p-1 rounded border cursor-pointer ${
                      currentCh.pitchWheelLocked
                        ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                        : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-200'
                    }`}
                    title={currentCh.pitchWheelLocked ? 'Unlock Pitch Wheel' : 'Lock Pitch Wheel'}
                  >
                    {currentCh.pitchWheelLocked ? <Lock size={9} /> : <Unlock size={9} />}
                  </button>
                </div>
              </div>

              <input
                type="range"
                min={-8192}
                max={8191}
                value={currentCh.pitchWheel}
                onChange={(e) => WorkletSynthBridge.setPitchWheelSigned(selectedChannel, parseInt(e.target.value, 10))}
                onMouseUp={handlePitchWheelRelease}
                onTouchEnd={handlePitchWheelRelease}
                className="w-full h-1.5 bg-zinc-900 rounded accent-indigo-400 cursor-pointer"
              />

              <div className="flex items-center justify-between gap-1 text-[8.5px] font-mono">
                <button
                  type="button"
                  onClick={() => WorkletSynthBridge.setPitchWheelSigned(selectedChannel, -8192)}
                  className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 hover:text-white cursor-pointer"
                >
                  -8192
                </button>
                <button
                  type="button"
                  onClick={() => WorkletSynthBridge.setPitchWheelSigned(selectedChannel, 0)}
                  className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-cyan-400 font-bold cursor-pointer"
                >
                  Center (0)
                </button>
                <button
                  type="button"
                  onClick={() => WorkletSynthBridge.setPitchWheelSigned(selectedChannel, 8191)}
                  className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 hover:text-white cursor-pointer"
                >
                  +8191
                </button>
              </div>

              {/* PITCH BEND RANGE (RPN 0: 0–24 SEMITONES) */}
              <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-zinc-850">
                <span className="text-[9px] font-mono font-bold uppercase text-zinc-400">
                  Bend Range (RPN 0)
                </span>
                <select
                  id="midi-pitch-range-select"
                  value={currentCh.pitchWheelRange}
                  onChange={(e) => WorkletSynthBridge.pitchWheelRange(selectedChannel, parseInt(e.target.value, 10))}
                  className="bg-zinc-900 border border-zinc-700 text-indigo-300 font-mono text-[10px] rounded px-2 py-0.5 focus:outline-none focus:border-indigo-400 cursor-pointer"
                >
                  {Array.from({ length: 25 }, (_, st) => (
                    <option key={st} value={st} className="bg-zinc-950 text-zinc-200">
                      +/-{st} Semitones
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* PEDAL TOGGLES + LOCK BUTTONS */}
            <div className="text-[9.5px] font-mono font-bold uppercase tracking-wider text-zinc-400 mt-0.5">
              Pedals (CC 64 / 66 / 67)
            </div>

            <LockedCCToggle
              label="Sustain / Damper Pedal"
              ccNumber={WORKLET_CC.SUSTAIN}
              value={currentCh.cc[WORKLET_CC.SUSTAIN] ?? 0}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.SUSTAIN])}
              activeColor="cyan"
              onToggleValue={() =>
                WorkletSynthBridge.controllerChange(
                  selectedChannel,
                  WORKLET_CC.SUSTAIN,
                  (currentCh.cc[WORKLET_CC.SUSTAIN] ?? 0) >= 64 ? 0 : 127
                )
              }
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.SUSTAIN,
                  !currentCh.lockedCCs[WORKLET_CC.SUSTAIN]
                )
              }
            />

            <LockedCCToggle
              label="Sostenuto Pedal"
              ccNumber={WORKLET_CC.SOSTENUTO}
              value={currentCh.cc[WORKLET_CC.SOSTENUTO] ?? 0}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.SOSTENUTO])}
              activeColor="amber"
              onToggleValue={() =>
                WorkletSynthBridge.controllerChange(
                  selectedChannel,
                  WORKLET_CC.SOSTENUTO,
                  (currentCh.cc[WORKLET_CC.SOSTENUTO] ?? 0) >= 64 ? 0 : 127
                )
              }
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.SOSTENUTO,
                  !currentCh.lockedCCs[WORKLET_CC.SOSTENUTO]
                )
              }
            />

            <LockedCCToggle
              label="Soft Pedal"
              ccNumber={WORKLET_CC.SOFT_PEDAL}
              value={currentCh.cc[WORKLET_CC.SOFT_PEDAL] ?? 0}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.SOFT_PEDAL])}
              activeColor="fuchsia"
              onToggleValue={() =>
                WorkletSynthBridge.controllerChange(
                  selectedChannel,
                  WORKLET_CC.SOFT_PEDAL,
                  (currentCh.cc[WORKLET_CC.SOFT_PEDAL] ?? 0) >= 64 ? 0 : 127
                )
              }
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.SOFT_PEDAL,
                  !currentCh.lockedCCs[WORKLET_CC.SOFT_PEDAL]
                )
              }
            />
          </div>
        </div>
      )}

      {/* PANEL 2: TONE SHAPING, ENVELOPES, VIBRATO & EFFECTS (GS/XG CCs + LOCKS) */}
      {(activeSection === 'all' || activeSection === 'tone') && (
        <div className="p-3 bg-zinc-900/45 border border-zinc-800 rounded-xl flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
              <Waves size={12} className="text-fuchsia-400" />
              GS / XG Tone Shaping, Envelopes, Vibrato & Effects (CH {selectedChannel + 1})
            </span>
            <span className="text-[9px] font-mono text-zinc-500">
              All 11 Sound Controller CCs wired with two-way MIDI sync & individual Locks
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {/* FILTER CUTOFF (CC 74) */}
            <LockedCCSlider
              label="Filter Cutoff / Bright"
              ccNumber={WORKLET_CC.CUTOFF}
              value={currentCh.cc[WORKLET_CC.CUTOFF] ?? 64}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.CUTOFF])}
              quickCenter={64}
              accentClass="accent-fuchsia-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.CUTOFF, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.CUTOFF,
                  !currentCh.lockedCCs[WORKLET_CC.CUTOFF]
                )
              }
            />

            {/* FILTER RESONANCE (CC 71) */}
            <LockedCCSlider
              label="Filter Resonance / Timbre"
              ccNumber={WORKLET_CC.RESONANCE}
              value={currentCh.cc[WORKLET_CC.RESONANCE] ?? 64}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.RESONANCE])}
              quickCenter={64}
              accentClass="accent-fuchsia-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.RESONANCE, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.RESONANCE,
                  !currentCh.lockedCCs[WORKLET_CC.RESONANCE]
                )
              }
            />

            {/* ATTACK TIME (CC 73) */}
            <LockedCCSlider
              label="Env Attack Time"
              ccNumber={WORKLET_CC.ATTACK_TIME}
              value={currentCh.cc[WORKLET_CC.ATTACK_TIME] ?? 64}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.ATTACK_TIME])}
              quickCenter={64}
              accentClass="accent-emerald-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.ATTACK_TIME, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.ATTACK_TIME,
                  !currentCh.lockedCCs[WORKLET_CC.ATTACK_TIME]
                )
              }
            />

            {/* DECAY TIME (CC 75) */}
            <LockedCCSlider
              label="Env Decay Time"
              ccNumber={WORKLET_CC.DECAY_TIME}
              value={currentCh.cc[WORKLET_CC.DECAY_TIME] ?? 64}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.DECAY_TIME])}
              quickCenter={64}
              accentClass="accent-emerald-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.DECAY_TIME, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.DECAY_TIME,
                  !currentCh.lockedCCs[WORKLET_CC.DECAY_TIME]
                )
              }
            />

            {/* RELEASE TIME (CC 72) */}
            <LockedCCSlider
              label="Env Release Time"
              ccNumber={WORKLET_CC.RELEASE_TIME}
              value={currentCh.cc[WORKLET_CC.RELEASE_TIME] ?? 64}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.RELEASE_TIME])}
              quickCenter={64}
              accentClass="accent-emerald-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.RELEASE_TIME, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.RELEASE_TIME,
                  !currentCh.lockedCCs[WORKLET_CC.RELEASE_TIME]
                )
              }
            />

            {/* VIBRATO RATE (CC 76) */}
            <LockedCCSlider
              label="Vibrato Rate"
              ccNumber={WORKLET_CC.VIBRATO_RATE}
              value={currentCh.cc[WORKLET_CC.VIBRATO_RATE] ?? 64}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.VIBRATO_RATE])}
              quickCenter={64}
              accentClass="accent-amber-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.VIBRATO_RATE, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.VIBRATO_RATE,
                  !currentCh.lockedCCs[WORKLET_CC.VIBRATO_RATE]
                )
              }
            />

            {/* VIBRATO DEPTH (CC 77) */}
            <LockedCCSlider
              label="Vibrato Depth"
              ccNumber={WORKLET_CC.VIBRATO_DEPTH}
              value={currentCh.cc[WORKLET_CC.VIBRATO_DEPTH] ?? 64}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.VIBRATO_DEPTH])}
              quickCenter={64}
              accentClass="accent-amber-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.VIBRATO_DEPTH, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.VIBRATO_DEPTH,
                  !currentCh.lockedCCs[WORKLET_CC.VIBRATO_DEPTH]
                )
              }
            />

            {/* VIBRATO DELAY (CC 78) */}
            <LockedCCSlider
              label="Vibrato Delay"
              ccNumber={WORKLET_CC.VIBRATO_DELAY}
              value={currentCh.cc[WORKLET_CC.VIBRATO_DELAY] ?? 64}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.VIBRATO_DELAY])}
              quickCenter={64}
              accentClass="accent-amber-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.VIBRATO_DELAY, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.VIBRATO_DELAY,
                  !currentCh.lockedCCs[WORKLET_CC.VIBRATO_DELAY]
                )
              }
            />

            {/* REVERB SEND (CC 91) */}
            <LockedCCSlider
              label="Reverb Send"
              ccNumber={WORKLET_CC.REVERB}
              value={currentCh.cc[WORKLET_CC.REVERB] ?? 40}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.REVERB])}
              quickCenter={40}
              accentClass="accent-cyan-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.REVERB, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.REVERB,
                  !currentCh.lockedCCs[WORKLET_CC.REVERB]
                )
              }
            />

            {/* CHORUS SEND (CC 93) */}
            <LockedCCSlider
              label="Chorus Send"
              ccNumber={WORKLET_CC.CHORUS}
              value={currentCh.cc[WORKLET_CC.CHORUS] ?? 0}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.CHORUS])}
              quickCenter={0}
              accentClass="accent-cyan-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.CHORUS, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.CHORUS,
                  !currentCh.lockedCCs[WORKLET_CC.CHORUS]
                )
              }
            />

            {/* DELAY / VARIATION SEND (CC 94) */}
            <LockedCCSlider
              label="Delay / Variation Send"
              ccNumber={WORKLET_CC.DELAY_VARIATION}
              value={currentCh.cc[WORKLET_CC.DELAY_VARIATION] ?? 0}
              isLocked={Boolean(currentCh.lockedCCs[WORKLET_CC.DELAY_VARIATION])}
              quickCenter={0}
              accentClass="accent-cyan-400"
              onChange={(v) => WorkletSynthBridge.controllerChange(selectedChannel, WORKLET_CC.DELAY_VARIATION, v)}
              onToggleLock={() =>
                WorkletSynthBridge.lockController(
                  selectedChannel,
                  WORKLET_CC.DELAY_VARIATION,
                  !currentCh.lockedCCs[WORKLET_CC.DELAY_VARIATION]
                )
              }
            />
          </div>
        </div>
      )}

      {/* LIVE AUDITION VIRTUAL KEYBOARD (SHOWS REAL-TIME MIDI PLAYBACK NOTES!) */}
      {!compact && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-1.5">
              <Piano size={12} className="text-cyan-400" />
              Live Audition & Playback Keyboard (CH {selectedChannel + 1})
            </span>
            <span className="text-[9px] text-zinc-500 font-mono">
              Highlights notes pressed live in WorkletSynthesizer during MIDI playback or clicks
            </span>
          </div>

          <div className="relative h-24 bg-zinc-950 border border-zinc-800 rounded-xl p-1.5 flex overflow-x-auto custom-scrollbar select-none">
            {KEYBOARD_NOTES.filter((k) => !k.isBlack).map((whiteKey) => {
              const isPlayingThis = activeNotesSet.has(whiteKey.midi);
              const blackKey = KEYBOARD_NOTES.find((k) => k.isBlack && k.midi === whiteKey.midi + 1);

              return (
                <div key={whiteKey.midi} className="relative flex-1 min-w-[34px] max-w-[48px] h-full flex flex-col">
                  <button
                    type="button"
                    onClick={() => handlePlayKey(whiteKey.midi)}
                    className={`w-full h-full rounded-b-md border transition-all cursor-pointer flex flex-col justify-end items-center pb-1 text-[8px] font-mono font-bold ${
                      isPlayingThis
                        ? 'bg-cyan-300 text-black border-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.8)]'
                        : 'bg-zinc-200 hover:bg-white text-zinc-700 border-zinc-400'
                    }`}
                  >
                    {whiteKey.name}
                  </button>

                  {blackKey && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePlayKey(blackKey.midi);
                      }}
                      className={`absolute -right-3 top-0 w-5.5 h-13 rounded-b z-10 transition-all cursor-pointer flex flex-col justify-end items-center pb-1 text-[7px] font-mono font-bold ${
                        activeNotesSet.has(blackKey.midi)
                          ? 'bg-cyan-400 text-black shadow-[0_0_12px_rgba(6,182,212,0.9)]'
                          : 'bg-zinc-900 hover:bg-black text-zinc-300 border border-zinc-700'
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
      )}

      {/* LIVE ENGINE STATUS STRIP */}
      <div className="px-3 py-1.5 bg-black/60 border border-zinc-850 rounded-lg flex items-center justify-between gap-2 text-[9.5px] font-mono">
        <div className="flex items-center gap-2 truncate">
          <span className="text-cyan-400 font-bold uppercase shrink-0">SYNTH LOG:</span>
          <span className="text-zinc-300 truncate">{systemLog}</span>
        </div>
        <span className="text-zinc-500 shrink-0">spessasynth_lib WorkletSynthesizer</span>
      </div>
    </div>
  );
}
