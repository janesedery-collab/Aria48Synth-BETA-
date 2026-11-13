import React, { useState, useEffect, useRef } from 'react';
import { 
  Settings, Volume2, VolumeX, ShieldAlert, Zap, Layers, Server, Sliders, 
  ShieldCheck, HeartPulse, Disc3, Upload, Play, Radio, Cpu, Activity, Star, Trash2, Check, ChevronDown, ChevronUp
} from 'lucide-react';
import { Channel, OscilloscopeConfig } from '../types';
import { SpessaSynth, SPRESSASYNTH_ENGINE_ID, MidiChannelState } from '../engines/spressasynthLib';
import { Chiptune3, CHIPTUNE3_ENGINE_ID } from '../engines/chiptune3';
import { WebScope, WEBSCOPE_ENGINE_ID, WEBSCOPE_PRESETS, WebScopePreset } from '../engines/webscopeOscilloscope';
import MidiControllerModal from './MidiControllerModal';
import { saveSelectedSoundFont } from '../utils/recentSongsManager';
import { getAvailableSoundFontInstruments } from '../utils/soundFontEngine';
import {
  deleteSavedSoundFont,
  getDefaultSoundFontId,
  loadSoundFontIntoCoreAndLib,
  onDefaultSoundFontChange,
  setDefaultSoundFontId,
  setMidiChannelMuted
} from './AudioEngine';
import { getSavedSoundFontsFromCookies, saveAmplifier, SavedSoundFontCookieEntry } from '../utils/cookieStorage';

interface MixerEQProps {
  channels: Channel[];
  setChannels?: React.Dispatch<React.SetStateAction<Channel[]>>;
  isPlaying: boolean;
  driveMode?: boolean;
  channelPitches?: { [key: number]: string };
  bpm?: number;
  oscConfig?: OscilloscopeConfig;
  setOscConfig?: React.Dispatch<React.SetStateAction<OscilloscopeConfig>>;
}

// 16 Standard MIDI & Chiptune Channel Definitions
const SIXTEEN_CHANNEL_ROLES = [
  { id: 1, name: "Piano", full: "Acoustic Grand Piano", category: "Keys", defaultFreq: "C-4" },
  { id: 2, name: "E-Piano", full: "Bright Electric Piano", category: "Keys", defaultFreq: "E-4" },
  { id: 3, name: "Slap Bass", full: "Acoustic / Slap Bass", category: "Bass", defaultFreq: "E-2" },
  { id: 4, name: "Strings", full: "Orchestral String Ensemble", category: "Strings", defaultFreq: "G-4" },
  { id: 5, name: "Brass", full: "Brass Section & Horns", category: "Brass", defaultFreq: "C-4" },
  { id: 6, name: "Lead Synth", full: "Sawtooth / Square Lead", category: "Lead", defaultFreq: "A-4" },
  { id: 7, name: "Organ", full: "Drawbar Rock Organ", category: "Keys", defaultFreq: "D-4" },
  { id: 8, name: "Pad/Choir", full: "Warm Pad & Voice Aahs", category: "Pad", defaultFreq: "F-4" },
  { id: 9, name: "Guitar", full: "Overdriven / Clean Guitar", category: "Guitar", defaultFreq: "A-3" },
  { id: 10, name: "GM Drums", full: "Standard Percussion Kit", category: "Drums", defaultFreq: "Perc" },
  { id: 11, name: "Synth Bass", full: "Analog Sub Bass", category: "Bass", defaultFreq: "C-2" },
  { id: 12, name: "Woodwind", full: "Flute / Piccolo", category: "Wind", defaultFreq: "D-5" },
  { id: 13, name: "Orch Harp", full: "Orchestral Harp & Timpani", category: "Orch", defaultFreq: "G-3" },
  { id: 14, name: "Atmosphere", full: "FX Crystal & Rain", category: "FX", defaultFreq: "B-4" },
  { id: 15, name: "Ambient", full: "Bowed Glass Sweep", category: "FX", defaultFreq: "E-5" },
  { id: 16, name: "Master Aux", full: "Sideband Modulator", category: "Aux", defaultFreq: "C-5" }
];

// Single CRT Vector Oscilloscope Canvas powered by webscope-oscilloscope-master.zip
function WebScopeCRT({
  channelIndex,
  role,
  isPlaying,
  oscConfig,
  pitch,
  isMuted = false,
  midiProgramName,
  onToggleMute
}: {
  key?: React.Key;
  channelIndex: number;
  role: typeof SIXTEEN_CHANNEL_ROLES[0];
  isPlaying: boolean;
  oscConfig: OscilloscopeConfig;
  pitch?: string;
  isMuted?: boolean;
  midiProgramName?: string;
  onToggleMute?: (channelIndex: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [meter, setMeter] = useState({ peak: 0, rms: 0 });
  const lastMeterRef = useRef({ peak: 0, rms: 0, updatedAt: 0 });

  const size = oscConfig?.size || 'medium';
  const amplifier = oscConfig?.amplifier ?? 1.0;

  // Distinct physical box height & canvas resolution for each size preset
  const canvasHeight = size === 'very-small' ? 50 : size === 'small' ? 82 : size === 'medium' ? 125 : size === 'large' ? 195 : 285;
  const boxHeightClass = size === 'very-small' ? 'h-[52px] min-h-[52px]' : size === 'small' ? 'h-[86px] min-h-[86px]' : size === 'medium' ? 'h-[130px] min-h-[130px]' : size === 'large' ? 'h-[200px] min-h-[200px]' : 'h-[290px] min-h-[290px]';
  const cardPadding = size === 'very-small' ? 'p-1.5' : size === 'small' ? 'p-2' : size === 'medium' ? 'p-2.5' : size === 'large' ? 'p-3' : 'p-3.5';

  useEffect(() => {
    let animId: number;

    const renderLoop = () => {
      if (canvasRef.current) {
        const stats = WebScope.renderChannel(
          canvasRef.current,
          channelIndex,
          isPlaying && !isMuted,
          {
            preset: (oscConfig?.preset as WebScopePreset) || 'protracker',
            scanlines: oscConfig?.scanlines ?? true,
            glowBloom: oscConfig?.glowBloom ?? true,
            gridDividers: oscConfig?.gridDividers ?? true,
            phaseSync: oscConfig?.phaseSync ?? true,
            triggerLock: oscConfig?.phaseSync ?? true,
            strokeWidth: size === 'very-large' ? 2.4 : size === 'large' ? 2.0 : 1.8,
            amplifier: amplifier
          }
        );
        const nextPeak = isMuted ? 0 : stats.peakLevel;
        const nextRms = isMuted ? 0 : stats.rmsLevel;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const prev = lastMeterRef.current;
        const changedSignificantly =
          (nextPeak === 0 && prev.peak !== 0) ||
          Math.abs(nextPeak - prev.peak) >= 0.015 ||
          Math.abs(nextRms - prev.rms) >= 0.015;
        if (changedSignificantly && (nextPeak === 0 || now - prev.updatedAt >= 48)) {
          lastMeterRef.current = { peak: nextPeak, rms: nextRms, updatedAt: now };
          setMeter({ peak: nextPeak, rms: nextRms });
        }
      }
      animId = requestAnimationFrame(renderLoop);
    };

    animId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(animId);
  }, [channelIndex, isPlaying, isMuted, oscConfig, amplifier, size]);

  const presetStyle = WEBSCOPE_PRESETS[(oscConfig?.preset as WebScopePreset) || 'protracker'];
  const peakPct = isMuted ? 0 : Math.min(100, Math.round(meter.peak * 125));

  return (
    <div
      id={`oscilloscope-channel-${role.id}`}
      role="button"
      tabIndex={0}
      aria-pressed={isMuted}
      onClick={() => onToggleMute?.(channelIndex)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleMute?.(channelIndex);
        }
      }}
      title={
        isMuted
          ? `MIDI Channel ${role.id} is MUTED (${midiProgramName || role.full}) — Click to unmute`
          : `Click to MUTE MIDI Channel ${role.id} (${midiProgramName || role.full})`
      }
      className={`rounded-lg flex flex-col relative overflow-hidden shadow-inner group transition-all cursor-pointer select-none focus:outline-none focus:ring-1 ${
        isMuted
          ? 'bg-red-950/20 border border-red-500/60 hover:border-red-400 focus:ring-red-400'
          : 'bg-black/95 border border-zinc-850 hover:border-zinc-600 focus:ring-amber-400'
      } ${cardPadding}`}
    >
      {/* Scope Header */}
      <div className="flex items-center justify-between text-[8px] font-mono tracking-wider mb-1 z-10 gap-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span 
            className="font-black px-1 py-0.5 rounded text-[8px] uppercase tracking-wider shrink-0"
            style={
              isMuted
                ? {
                    backgroundColor: 'rgba(239, 68, 68, 0.2)',
                    color: '#fca5a5',
                    border: '1px solid rgba(239, 68, 68, 0.5)'
                  }
                : { 
                    backgroundColor: `${presetStyle.stroke}20`, 
                    color: presetStyle.stroke,
                    border: `1px solid ${presetStyle.stroke}40`
                  }
            }
          >
            CH {role.id.toString().padStart(2, '0')}
          </span>
          <span
            className={`font-bold truncate max-w-[80px] ${isMuted ? 'text-zinc-500 line-through' : 'text-zinc-300'}`}
            title={midiProgramName || role.full}
          >
            {role.name}
          </span>
        </div>

        <div className="flex items-center gap-1 text-[7.5px] text-zinc-500 shrink-0">
          {isMuted ? (
            <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-red-950/90 border border-red-500/60 text-red-300 font-black uppercase text-[7px] tracking-wider">
              <VolumeX size={9} className="text-red-400" />
              MUTED
            </span>
          ) : (
            <>
              <span className="text-zinc-600 hidden sm:inline">{role.category}</span>
              <span className="font-mono text-cyan-400 font-bold">{pitch || role.defaultFreq}</span>
              <Volume2 size={9} className="text-zinc-600 group-hover:text-amber-400 transition-colors" />
            </>
          )}
        </div>
      </div>

      {/* HTML5 CRT Vector Canvas (Box size physically scaled by size preset, while drawing height is amplified by amplifier) */}
      <div className={`relative flex-1 ${boxHeightClass} bg-black rounded border ${isMuted ? 'border-red-900/60' : 'border-zinc-900/90'} overflow-hidden flex items-center justify-center`}>
        <canvas 
          ref={canvasRef} 
          width={size === 'very-large' ? 360 : size === 'large' ? 280 : 220} 
          height={canvasHeight} 
          className={`w-full h-full block transition-opacity ${isMuted ? 'opacity-30' : 'opacity-100'}`}
        />

        {isMuted && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-black/35">
            <span className="px-2 py-0.5 rounded bg-red-950/90 border border-red-500/60 text-red-200 font-mono font-black text-[8.5px] uppercase tracking-widest flex items-center gap-1 shadow">
              <VolumeX size={10} className="text-red-400" />
              CH {role.id.toString().padStart(2, '0')} MUTED
            </span>
          </div>
        )}

        {/* Ambient CRT Vignette */}
        <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_12px_rgba(0,0,0,0.8)]"></div>
      </div>

      {/* Live Peak / Signal Level Bar */}
      <div className="mt-1 flex items-center gap-1.5 text-[7px] font-mono text-zinc-500">
        <span className={isMuted ? 'text-red-400 font-bold' : 'text-zinc-600'}>
          {isMuted ? 'MUTE' : 'PEAK'}
        </span>
        <div className="flex-1 h-1.5 bg-zinc-950 rounded border border-zinc-900 overflow-hidden flex gap-0.5 p-0.5">
          <div 
            className="h-full rounded-sm transition-all duration-75"
            style={{ 
              width: `${peakPct}%`,
              backgroundColor: peakPct > 80 ? '#ef4444' : peakPct > 50 ? '#eab308' : presetStyle.stroke,
              boxShadow: peakPct > 10 ? `0 0 6px ${presetStyle.glow}` : 'none'
            }}
          />
        </div>
        <span className={`font-bold min-w-[24px] text-right ${isMuted ? 'text-red-400' : 'text-zinc-400'}`}>
          {isMuted ? 'OFF' : meter.peak > 0.01 ? `${Math.round(meter.peak * 100)}%` : 'IDLE'}
        </span>
      </div>
    </div>
  );
}

export default function MixerEQ({
  channels,
  setChannels,
  isPlaying,
  driveMode = false,
  channelPitches = {},
  bpm = 120,
  oscConfig = {
    preset: 'protracker',
    drawType: 'solid',
    scanlines: true,
    glowBloom: true,
    gridDividers: true,
    noiseFloor: 2,
    amplifier: 1.0,
    size: 'medium',
    phaseSync: true
  },
  setOscConfig
}: MixerEQProps) {
  const [masterVol, setMasterVol] = useState(85);
  const [reverbSize, setReverbSize] = useState(40);
  const [soundFonts, setSoundFonts] = useState(SpessaSynth.getLoadedSoundFonts());
  const [activeSoundFont, setActiveSoundFont] = useState(SpessaSynth.getActiveSoundFont());
  const [defaultSoundFontId, setDefaultSoundFontState] = useState<string>(() => getDefaultSoundFontId());
  const [savedCookieFonts, setSavedCookieFonts] = useState<SavedSoundFontCookieEntry[]>(() => getSavedSoundFontsFromCookies());
  const [showSavedSoundFonts, setShowSavedSoundFonts] = useState<boolean>(false);
  const [sfFeedback, setSfFeedback] = useState<string | null>(null);
  const [isMidiModalOpen, setIsMidiModalOpen] = useState(false);
  const [midiChannelStates, setMidiChannelStates] = useState<MidiChannelState[]>(() => [
    ...SpessaSynth.getChannelStates()
  ]);

  const sfUploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubSf = SpessaSynth.onSoundFontChange((fonts) => {
      setSoundFonts(fonts);
      setActiveSoundFont(SpessaSynth.getActiveSoundFont());
      setSavedCookieFonts(getSavedSoundFontsFromCookies());
    });
    const unsubDefault = onDefaultSoundFontChange((id) => {
      setDefaultSoundFontState(id);
    });
    const unsubCh = SpessaSynth.onChannelStateChange((states) => {
      setMidiChannelStates(states);
    });
    return () => {
      unsubSf();
      unsubDefault();
      unsubCh();
    };
  }, []);

  const handleSetDefaultSoundFont = (id: string, name?: string) => {
    setDefaultSoundFontId(id);
    setDefaultSoundFontState(id);
    setActiveSoundFont(SpessaSynth.getActiveSoundFont());
    setSfFeedback(`Set "${name || id}" as the default SoundFont (saved in browser cookies).`);
    setTimeout(() => setSfFeedback(null), 3500);
  };

  const handleDeleteSavedSoundFont = async (id: string, name?: string) => {
    await deleteSavedSoundFont(id);
    setSoundFonts(SpessaSynth.getLoadedSoundFonts());
    setActiveSoundFont(SpessaSynth.getActiveSoundFont());
    setSavedCookieFonts(getSavedSoundFontsFromCookies());
    setDefaultSoundFontState(getDefaultSoundFontId());
    setSfFeedback(`Removed "${name || id}" from saved SoundFonts.`);
    setTimeout(() => setSfFeedback(null), 3000);
  };

  const handleToggleOscilloscopeChannelMute = (channelIndex: number) => {
    const currentlyMuted = Boolean(
      midiChannelStates[channelIndex]?.isMuted ||
      channels.find(c => c.id === channelIndex + 1)?.mute
    );
    const nextMuted = !currentlyMuted;
    setMidiChannelMuted(channelIndex, nextMuted);
    if (setChannels) {
      setChannels(prev =>
        prev.map(c => (c.id === channelIndex + 1 ? { ...c, mute: nextMuted } : c))
      );
    }
    setMidiChannelStates([...SpessaSynth.getChannelStates()]);
  };

  const handleUnmuteAllMidiChannels = () => {
    for (let i = 0; i < 16; i++) {
      setMidiChannelMuted(i, false);
    }
    if (setChannels) {
      setChannels(prev =>
        prev.map(c => (c.id >= 1 && c.id <= 16 ? { ...c, mute: false } : c))
      );
    }
    setMidiChannelStates([...SpessaSynth.getChannelStates()]);
  };

  const mutedChannelsCount = SIXTEEN_CHANNEL_ROLES.reduce((count, role, idx) => {
    const isMuted = Boolean(
      midiChannelStates[idx]?.isMuted ||
      channels.find(c => c.id === role.id)?.mute
    );
    return count + (isMuted ? 1 : 0);
  }, 0);

  const handleSoundFontUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.target;
    if (inputEl.files && inputEl.files[0]) {
      const file = inputEl.files[0];
      const reader = new FileReader();
      reader.onload = async (evt) => {
        if (evt.target?.result instanceof ArrayBuffer) {
          try {
            const { soundFont: newSf } = await loadSoundFontIntoCoreAndLib(evt.target.result, file.name);
            saveSelectedSoundFont(newSf.id);
            setSoundFonts(SpessaSynth.getLoadedSoundFonts());
            setActiveSoundFont(newSf);

            const sfInstruments = getAvailableSoundFontInstruments();
            if (setChannels && channels && sfInstruments.length > 0) {
              setChannels(prev => prev.map((ch, idx) => {
                const inst = sfInstruments[idx % sfInstruments.length];
                return {
                  ...ch,
                  chip: 'General MIDI (SoundFont)',
                  soundFontPreset: inst ? inst.id : ch.soundFontPreset
                };
              }));
            }
            setSfFeedback(`Loaded SoundFont "${newSf.name}" (${newSf.format || 'SoundBank'}, ${newSf.instrumentCount} Presets) decoded by spressasynth_core-master.zip into spressasynth_lib!`);
            setTimeout(() => setSfFeedback(null), 4500);
          } catch (err: any) {
            setSfFeedback(`Error loading SoundFont: ${err.message}`);
          }
        }
        inputEl.value = '';
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const handleAuditionSoundFont = () => {
    // Play test chord on Channel 1 (Piano) and Channel 10 (Drums)
    SpessaSynth.noteOn(0, 60, 95, 0.45); // C4
    setTimeout(() => SpessaSynth.noteOn(0, 64, 90, 0.45), 90); // E4
    setTimeout(() => SpessaSynth.noteOn(0, 67, 95, 0.5), 180); // G4
    setTimeout(() => SpessaSynth.noteOn(9, 36, 110, 0.3), 0); // Bass drum
    setTimeout(() => SpessaSynth.noteOn(9, 38, 100, 0.25), 180); // Snare drum
  };

  return (
    <div className="h-full flex flex-col gap-4 font-mono select-none">
      
      {/* TOP ENGINE INTEGRATION DOCK */}
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          {/* SpessaSynth Engine Pill */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-950/40 border border-emerald-600/40 text-emerald-300 rounded-lg text-[10px] font-bold">
            <Radio size={12} className="text-emerald-400 animate-pulse" />
            <span>MIDI: {SPRESSASYNTH_ENGINE_ID}</span>
            <span className="text-[8.5px] px-1 py-0.2 bg-emerald-900/60 text-emerald-200 rounded font-sans">
              16 CH SF2
            </span>
          </div>

          {/* Chiptune-3 Engine Pill */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-cyan-950/40 border border-cyan-600/40 text-cyan-300 rounded-lg text-[10px] font-bold">
            <Cpu size={12} className="text-cyan-400" />
            <span>CHIPTUNE: {CHIPTUNE3_ENGINE_ID}</span>
            <span className="text-[8.5px] px-1 py-0.2 bg-cyan-900/60 text-cyan-200 rounded font-sans">
              16 CH MATRIX
            </span>
          </div>

          {/* WebScope Oscilloscope Engine Pill */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-950/40 border border-amber-600/40 text-amber-300 rounded-lg text-[10px] font-bold">
            <Activity size={12} className="text-amber-400 animate-pulse" />
            <span>SCOPE: {WEBSCOPE_ENGINE_ID}</span>
            <span className="text-[8.5px] px-1 py-0.2 bg-amber-900/60 text-amber-200 rounded font-sans font-black">
              16 CRT VECTOR
            </span>
          </div>
        </div>

        {/* SOUNDFONT MANAGER FOR SPRESSASYNTH */}
        <div className="flex items-center gap-2 flex-wrap">
          <input 
            type="file" 
            ref={sfUploadInputRef} 
            onChange={handleSoundFontUpload} 
            className="hidden" 
          />

          <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-[10px]">
            <Disc3 size={13} className="text-emerald-400" />
            <select
              value={activeSoundFont?.id}
              onChange={(e) => {
                SpessaSynth.setActiveSoundFont(e.target.value);
                setActiveSoundFont(SpessaSynth.getActiveSoundFont());
                saveSelectedSoundFont(e.target.value);
              }}
              className="bg-transparent text-emerald-300 text-[9.5px] font-mono focus:outline-none cursor-pointer max-w-[140px] truncate"
            >
              {soundFonts.map(sf => (
                <option key={sf.id} value={sf.id} className="bg-zinc-950 text-zinc-300">
                  {sf.name} ({sf.instrumentCount} presets){defaultSoundFontId === sf.id ? ' ★ Default' : ''}
                </option>
              ))}
            </select>
            {activeSoundFont && (
              <button
                id="mixer-set-default-active-sf-btn"
                type="button"
                onClick={() => handleSetDefaultSoundFont(activeSoundFont.id, activeSoundFont.name)}
                className={`px-1.5 py-0.5 rounded text-[8.5px] font-mono font-bold border transition cursor-pointer flex items-center gap-1 shrink-0 ${
                  defaultSoundFontId === activeSoundFont.id
                    ? 'bg-amber-950/70 border-amber-500/60 text-amber-300'
                    : 'bg-zinc-950 hover:bg-amber-950/50 border-zinc-700 hover:border-amber-500/50 text-zinc-300 hover:text-amber-200'
                }`}
                title={
                  defaultSoundFontId === activeSoundFont.id
                    ? 'This SoundFont is currently set as your startup default'
                    : 'Set the selected SoundFont as the startup default (saved in browser cookies)'
                }
              >
                <Star size={9} fill={defaultSoundFontId === activeSoundFont.id ? 'currentColor' : 'none'} />
                <span>{defaultSoundFontId === activeSoundFont.id ? 'Default' : 'Set Default'}</span>
              </button>
            )}
          </div>

          <button
            onClick={() => sfUploadInputRef.current?.click()}
            className="px-2.5 py-1 bg-zinc-850 hover:bg-zinc-750 text-zinc-200 border border-zinc-700 rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer"
            title="Feed any SoundFont (.sf2, .sf3, .dls, .sfz, .sbk, .gig, .pat, etc.) into spressasynth_core-master.zip -> spressasynth_lib-master.zip"
          >
            <Upload size={11} />
            <span>Load SoundFont</span>
          </button>

          <button
            id="mixer-saved-soundfonts-toggle-btn"
            type="button"
            onClick={() => setShowSavedSoundFonts(prev => !prev)}
            aria-expanded={showSavedSoundFonts}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer border ${
              showSavedSoundFonts
                ? 'bg-emerald-950/70 border-emerald-500/60 text-emerald-200'
                : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border-zinc-700'
            }`}
            title="Show or hide Saved SoundFonts list and Set Default controls"
          >
            <Disc3 size={11} className="text-emerald-400" />
            <span>Saved SoundFonts ({soundFonts.length})</span>
            {showSavedSoundFonts ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>

          <button
            onClick={handleAuditionSoundFont}
            className="px-2.5 py-1 bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/50 rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer"
            title="Audition SpessaSynth soundfonts on channels 1 & 10"
          >
            <Play size={10} fill="currentColor" />
            <span>Audition</span>
          </button>

          <button
            onClick={() => setIsMidiModalOpen(true)}
            className="px-2.5 py-1 bg-indigo-950/60 hover:bg-indigo-900 text-indigo-300 border border-indigo-700/50 rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer shadow-sm"
            title="Open SpessaSynth 16-Channel MIDI Controller with GM/GS/XG Resets"
          >
            <Sliders size={11} className="text-indigo-400" />
            <span>MIDI Controller</span>
          </button>
        </div>
      </div>

      {/* SAVED SOUNDFONTS MANAGER (SET DEFAULT & ACTIVATE - COLLAPSIBLE) */}
      {showSavedSoundFonts && (
        <div className="bg-zinc-950/90 border border-zinc-800 rounded-xl px-3 py-2 flex flex-col gap-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Disc3 size={13} className="text-emerald-400" />
              <span className="font-bold text-[10.5px] uppercase tracking-wider text-zinc-200">
                Saved SoundFonts
              </span>
              <span className="text-[9px] text-zinc-500 font-sans">
                ({savedCookieFonts.length} saved in cookies · {soundFonts.length} total banks)
              </span>
            </div>
            <span className="text-[9px] text-zinc-500 font-sans">
              Default loads automatically on startup
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {soundFonts.map((sf) => {
              const cookieEntry = savedCookieFonts.find(c => c.id === sf.id);
              const isActive = activeSoundFont?.id === sf.id;
              const isDefault = defaultSoundFontId === sf.id;
              const sizeLabel = cookieEntry
                ? cookieEntry.size >= 1024 * 1024
                  ? `${(cookieEntry.size / (1024 * 1024)).toFixed(1)} MB`
                  : `${Math.max(1, Math.round(cookieEntry.size / 1024))} KB`
                : null;

              return (
                <div
                  key={sf.id}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] transition ${
                    isActive
                      ? 'bg-emerald-950/50 border-emerald-500/60 text-emerald-200'
                      : 'bg-zinc-900/80 border-zinc-800 text-zinc-300'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      SpessaSynth.setActiveSoundFont(sf.id);
                      setActiveSoundFont(SpessaSynth.getActiveSoundFont());
                    }}
                    className="flex items-center gap-1.5 text-left cursor-pointer hover:text-white"
                    title={`Activate "${sf.name}" (${sf.instrumentCount} presets)`}
                  >
                    {isActive && <Check size={10} className="text-emerald-400 shrink-0" />}
                    <span className="font-bold max-w-[170px] truncate">{sf.name}</span>
                    <span className="text-[8.5px] text-zinc-400 font-sans">
                      {sf.format || (sf.isCustom ? 'Saved' : 'Built-in')}
                      {sizeLabel ? ` · ${sizeLabel}` : ''}
                    </span>
                  </button>

                  <button
                    id={`saved-sf-default-btn-${sf.id}`}
                    type="button"
                    onClick={() => handleSetDefaultSoundFont(sf.id, sf.name)}
                    disabled={isDefault}
                    className={`px-1.5 py-0.5 rounded text-[8.5px] font-bold border transition flex items-center gap-1 shrink-0 ${
                      isDefault
                        ? 'bg-amber-950/75 border-amber-500/70 text-amber-300 cursor-default'
                        : 'bg-zinc-950 hover:bg-amber-950/60 border-zinc-700 hover:border-amber-500/60 text-zinc-300 hover:text-amber-200 cursor-pointer'
                    }`}
                    title={isDefault ? 'Default startup SoundFont' : `Set "${sf.name}" to default SoundFont`}
                  >
                    <Star size={9} fill={isDefault ? 'currentColor' : 'none'} />
                    <span>{isDefault ? 'Default' : 'Set Default'}</span>
                  </button>

                  {sf.isCustom && (
                    <button
                      type="button"
                      onClick={() => handleDeleteSavedSoundFont(sf.id, sf.name)}
                      className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-950/40 transition cursor-pointer shrink-0"
                      title={`Remove "${sf.name}" from saved SoundFonts`}
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sfFeedback && (
        <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-lg px-3 py-1.5 text-[10px] text-emerald-300 flex items-center gap-2">
          <ShieldCheck size={14} className="text-emerald-400" />
          <span>{sfFeedback}</span>
        </div>
      )}

      {/* 16-OSCILLOSCOPE WALL MODULE */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-3 flex flex-col gap-3">
        
        {/* WALL TOOLBAR */}
        <div className="flex flex-col gap-2.5 border-b border-zinc-800/80 pb-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Server size={14} className="text-amber-400" />
              <h3 className="font-bold text-xs uppercase tracking-wider text-white">
                16-Channel Vector Oscilloscope Matrix
              </h3>
              <span className="text-[9px] px-2 py-0.5 bg-amber-950/60 border border-amber-600/40 text-amber-300 rounded font-bold">
                16 CHANNELS LOCKED
              </span>
              <span className="text-[9px] px-2 py-0.5 bg-zinc-950/80 border border-zinc-800 text-zinc-400 rounded font-sans">
                Click any oscilloscope to mute/unmute MIDI channel
              </span>
              {mutedChannelsCount > 0 && (
                <button
                  id="osc-unmute-all-btn"
                  onClick={handleUnmuteAllMidiChannels}
                  className="text-[9px] px-2 py-0.5 bg-red-950/70 hover:bg-red-900 border border-red-500/60 text-red-200 rounded font-bold flex items-center gap-1 transition cursor-pointer"
                  title="Unmute all muted MIDI channels"
                >
                  <VolumeX size={10} className="text-red-400" />
                  <span>Unmute All ({mutedChannelsCount})</span>
                </button>
              )}
            </div>

            {/* SEPARATE BUTTON TO CONFIGURE OSCILLOSCOPE SIZE FOR ALL OSCILLOSCOPES */}
            <div className="flex items-center gap-1.5 bg-zinc-950/90 border border-zinc-800 px-2 py-1 rounded-lg">
              <span className="text-[9px] text-zinc-400 uppercase font-bold mr-1">Scope Size:</span>
              {(['very-small', 'small', 'medium', 'large', 'very-large'] as const).map(sz => (
                <button
                  key={sz}
                  id={`osc-size-btn-${sz}`}
                  onClick={() => setOscConfig?.({ ...oscConfig, size: sz })}
                  className={`px-2 py-0.5 rounded text-[8.5px] font-bold border transition cursor-pointer uppercase ${
                    (oscConfig.size || 'medium') === sz
                      ? 'bg-amber-600 text-white border-amber-400 shadow-sm'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                  title={`Configure all 16 oscilloscopes to ${sz.replace('-', ' ')}`}
                >
                  {sz === 'very-small' ? 'Very Small' : sz === 'small' ? 'Small' : sz === 'medium' ? 'Medium' : sz === 'large' ? 'Large' : 'Very Large'}
                </button>
              ))}
            </div>

            {/* PALETTE PRESET BUTTONS */}
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-zinc-500 uppercase font-bold mr-1 hidden sm:inline">CRT Color:</span>
              {(['protracker', 'phosphor', 'neon', 'sunset', 'cosmic', 'copper'] as WebScopePreset[]).map(p => (
                <button
                  key={p}
                  onClick={() => setOscConfig?.({ ...oscConfig, preset: p as any })}
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border transition cursor-pointer uppercase ${
                    oscConfig.preset === p
                      ? 'bg-zinc-800 text-white border-zinc-500 shadow-sm'
                      : 'bg-zinc-950/80 text-zinc-500 border-zinc-850 hover:text-zinc-300'
                  }`}
                  title={WEBSCOPE_PRESETS[p].name}
                >
                  {p === 'protracker' ? 'Amber' : p === 'phosphor' ? 'Green' : p === 'neon' ? 'Cyan' : p === 'sunset' ? 'Magenta' : p === 'cosmic' ? 'Violet' : 'Copper'}
                </button>
              ))}
            </div>
          </div>

          {/* ROW 2: AMPLIFIER (WAVEFORM HEIGHT MULTIPLIER) & DISPLAY SWITCHES */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-zinc-950/60 p-2 rounded-lg border border-zinc-850">
            {/* AMPLIFIER CONTROL (Makes HTML5 drawing taller to your liking without making box bigger) */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-[9.5px] font-bold text-cyan-300 font-mono">
                <Activity size={12} className="text-cyan-400 animate-pulse" />
                <span>WAVEFORM AMPLIFIER:</span>
              </div>
              <span className="text-[9px] text-zinc-400 font-sans hidden md:inline">
                (makes HTML5 drawing taller without expanding box)
              </span>

              {/* Quick Multiplier Buttons */}
              <div className="flex items-center gap-1">
                {[0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0].map((mult) => (
                  <button
                    key={mult}
                    id={`osc-amp-btn-${mult}`}
                    onClick={() => {
                      saveAmplifier(mult);
                      setOscConfig?.({ ...oscConfig, amplifier: mult });
                    }}
                    className={`px-2 py-0.5 rounded text-[8.5px] font-mono font-bold border transition cursor-pointer ${
                      (oscConfig.amplifier ?? 1.0) === mult
                        ? 'bg-cyan-600 text-white border-cyan-400 shadow-sm'
                        : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                    }`}
                    title={`Set waveform amplifier to ${mult}x drawing height (saved in browser cookies)`}
                  >
                    {mult === 1.0 ? '1.0x (Norm)' : `${mult}x`}
                  </button>
                ))}
              </div>

              {/* Continuous Slider */}
              <div className="flex items-center gap-1.5 ml-2">
                <input
                  type="range"
                  min="0.2"
                  max="8.0"
                  step="0.1"
                  value={oscConfig.amplifier ?? 1.0}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    saveAmplifier(val);
                    setOscConfig?.({ ...oscConfig, amplifier: val });
                  }}
                  className="w-24 accent-cyan-400 cursor-pointer h-1.5 bg-zinc-900 rounded"
                  title="Smooth waveform amplifier height slider (0.2x - 8.0x) - Saved in cookies"
                />
                <span className="text-[9.5px] font-mono font-black text-cyan-400 min-w-[32px]">
                  {(oscConfig.amplifier ?? 1.0).toFixed(1)}x
                </span>
                <span 
                  className="hidden sm:inline-flex items-center gap-0.5 text-[8px] font-mono text-emerald-400/90 bg-emerald-950/60 border border-emerald-800/40 px-1 py-0.2 rounded"
                  title="Amplifier setting is automatically saved in browser cookies (aria48_osc_amplifier)"
                >
                  🍪 Cookie Saved
                </span>
              </div>
            </div>

            {/* DISPLAY TOGGLE SWITCHES & PHASE SYNC */}
            <div className="flex flex-wrap items-center gap-3 text-[9px] text-zinc-400">
              {/* PHASE SYNC (WAVEFORM STABILIZER / DRIFT CONTROL) */}
              <button
                id="osc-phase-sync-btn"
                onClick={() => setOscConfig?.({ ...oscConfig, phaseSync: !(oscConfig.phaseSync ?? true) })}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[9px] font-mono font-bold border transition cursor-pointer ${
                  (oscConfig.phaseSync ?? true)
                    ? 'bg-emerald-950/70 text-emerald-300 border-emerald-500/60 shadow-[0_0_8px_rgba(16,185,129,0.25)]'
                    : 'bg-zinc-900 text-amber-400 border-amber-600/50 hover:bg-zinc-850'
                }`}
                title={(oscConfig.phaseSync ?? true) 
                  ? "Phase Sync ON: Waveforms are locked at zero-crossing (stationary/stabilized in normal position)" 
                  : "Phase Sync OFF: Waveforms move left/right depending on the sound frequency"}
              >
                <div className={`w-2 h-2 rounded-full ${(oscConfig.phaseSync ?? true) ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                <span>PHASE SYNC: {(oscConfig.phaseSync ?? true) ? 'STABILIZED (ON)' : 'FREE DRIFT (OFF)'}</span>
              </button>

              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={oscConfig.scanlines}
                  onChange={(e) => setOscConfig?.({ ...oscConfig, scanlines: e.target.checked })}
                  className="rounded bg-zinc-950 border-zinc-800 text-amber-500 focus:ring-0 accent-amber-500 h-3 w-3"
                />
                <span>Scanlines</span>
              </label>

              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={oscConfig.glowBloom}
                  onChange={(e) => setOscConfig?.({ ...oscConfig, glowBloom: e.target.checked })}
                  className="rounded bg-zinc-950 border-zinc-800 text-amber-500 focus:ring-0 accent-amber-500 h-3 w-3"
                />
                <span>Phosphor Glow</span>
              </label>

              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={oscConfig.gridDividers}
                  onChange={(e) => setOscConfig?.({ ...oscConfig, gridDividers: e.target.checked })}
                  className="rounded bg-zinc-950 border-zinc-800 text-amber-500 focus:ring-0 accent-amber-500 h-3 w-3"
                />
                <span>Graticule Grid</span>
              </label>
            </div>
          </div>
        </div>

        {/* 16 OSCILLOSCOPES GRID (Preserved 16 at all times with dynamic physical box dimensions) */}
        <div className={`grid ${
          oscConfig.size === 'very-small' ? 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-8' :
          oscConfig.size === 'small' ? 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-4' :
          oscConfig.size === 'large' ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-2' :
          oscConfig.size === 'very-large' ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-2' :
          'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
        } gap-2 max-h-[640px] overflow-y-auto custom-scrollbar p-1`}>
          {SIXTEEN_CHANNEL_ROLES.map((role, idx) => {
            const midiState = midiChannelStates[idx];
            const trackerCh = channels.find(c => c.id === role.id);
            const isMuted = Boolean(midiState?.isMuted || trackerCh?.mute);
            return (
              <WebScopeCRT
                key={role.id}
                channelIndex={idx}
                role={role}
                isPlaying={isPlaying}
                oscConfig={oscConfig}
                pitch={channelPitches[role.id]}
                isMuted={isMuted}
                midiProgramName={midiState?.programName}
                onToggleMute={handleToggleOscilloscopeChannelMute}
              />
            );
          })}
        </div>
      </div>

      {/* MASTER VOLUME & REVERB STRIP */}
      <div className="bg-zinc-950 border border-zinc-850 rounded-xl p-3 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex items-center gap-4 flex-1 max-w-md">
          <div className="flex items-center gap-1.5 min-w-[120px]">
            <Volume2 size={14} className="text-cyan-400" />
            <span className="font-bold text-[10.5px] uppercase text-zinc-300">Master Level</span>
            <span className="text-cyan-400 font-bold ml-auto">{masterVol}%</span>
          </div>
          <input 
            type="range" 
            min="0" 
            max="100" 
            value={masterVol}
            onChange={(e) => setMasterVol(Number(e.target.value))}
            className="w-full h-1.5 bg-zinc-900 rounded accent-cyan-500 cursor-pointer"
          />
        </div>

        <div className="flex items-center gap-4 flex-1 max-w-md">
          <div className="flex items-center gap-1.5 min-w-[120px]">
            <Layers size={14} className="text-emerald-400" />
            <span className="font-bold text-[10.5px] uppercase text-zinc-300">Reverb / Ambience</span>
            <span className="text-emerald-400 font-bold ml-auto">{reverbSize}%</span>
          </div>
          <input 
            type="range" 
            min="0" 
            max="100" 
            value={reverbSize}
            onChange={(e) => setReverbSize(Number(e.target.value))}
            className="w-full h-1.5 bg-zinc-900 rounded accent-emerald-500 cursor-pointer"
          />
        </div>
      </div>

      {/* SPESSASYNTH MIDI CONTROLLER MODAL */}
      <MidiControllerModal
        isOpen={isMidiModalOpen}
        onClose={() => setIsMidiModalOpen(false)}
        onChannelMuteSync={(chIdx0, isMuted) => {
          setChannels?.(prev =>
            prev.map(c => (c.id === chIdx0 + 1 ? { ...c, mute: isMuted } : c))
          );
          setMidiChannelStates([...SpessaSynth.getChannelStates()]);
        }}
      />

    </div>
  );
}
