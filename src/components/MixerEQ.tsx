import React, { useState, useEffect, useRef } from 'react';
import { 
  Settings, Volume2, ShieldAlert, Zap, Layers, Server, Sliders, 
  ShieldCheck, HeartPulse, Disc3, Upload, Play, Radio, Cpu, Activity
} from 'lucide-react';
import { Channel, OscilloscopeConfig } from '../types';
import { SpessaSynth, SPRESSASYNTH_ENGINE_ID } from '../engines/spressasynthLib';
import { Chiptune3, CHIPTUNE3_ENGINE_ID } from '../engines/chiptune3';
import { WebScope, WEBSCOPE_ENGINE_ID, WEBSCOPE_PRESETS, WebScopePreset } from '../engines/webscopeOscilloscope';
import MidiControllerModal from './MidiControllerModal';
import { saveSelectedSoundFont } from '../utils/recentSongsManager';

interface MixerEQProps {
  channels: Channel[];
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
  pitch
}: {
  key?: React.Key;
  channelIndex: number;
  role: typeof SIXTEEN_CHANNEL_ROLES[0];
  isPlaying: boolean;
  oscConfig: OscilloscopeConfig;
  pitch?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [meter, setMeter] = useState({ peak: 0, rms: 0 });

  useEffect(() => {
    let animId: number;

    const renderLoop = () => {
      if (canvasRef.current) {
        const stats = WebScope.renderChannel(
          canvasRef.current,
          channelIndex,
          isPlaying,
          {
            preset: (oscConfig?.preset as WebScopePreset) || 'protracker',
            scanlines: oscConfig?.scanlines ?? true,
            glowBloom: oscConfig?.glowBloom ?? true,
            gridDividers: oscConfig?.gridDividers ?? true,
            triggerLock: true,
            strokeWidth: 1.8
          }
        );
        setMeter({ peak: stats.peakLevel, rms: stats.rmsLevel });
      }
      animId = requestAnimationFrame(renderLoop);
    };

    animId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(animId);
  }, [channelIndex, isPlaying, oscConfig]);

  const presetStyle = WEBSCOPE_PRESETS[(oscConfig?.preset as WebScopePreset) || 'protracker'];
  const peakPct = Math.min(100, Math.round(meter.peak * 125));

  return (
    <div className="bg-black/95 border border-zinc-850 hover:border-zinc-700 rounded-lg p-2 flex flex-col relative overflow-hidden shadow-inner group transition-colors">
      {/* Scope Header */}
      <div className="flex items-center justify-between text-[8px] font-mono tracking-wider mb-1.5 z-10">
        <div className="flex items-center gap-1.5">
          <span 
            className="font-black px-1 py-0.5 rounded text-[8px] uppercase tracking-wider"
            style={{ 
              backgroundColor: `${presetStyle.stroke}20`, 
              color: presetStyle.stroke,
              border: `1px solid ${presetStyle.stroke}40`
            }}
          >
            CH {role.id.toString().padStart(2, '0')}
          </span>
          <span className="font-bold text-zinc-300 truncate max-w-[80px]" title={role.full}>
            {role.name}
          </span>
        </div>

        <div className="flex items-center gap-1 text-[7.5px] text-zinc-500">
          <span className="text-zinc-600">{role.category}</span>
          <span className="font-mono text-cyan-400 font-bold">{pitch || role.defaultFreq}</span>
        </div>
      </div>

      {/* HTML5 CRT Vector Canvas */}
      <div className="relative flex-1 min-h-[64px] bg-black rounded border border-zinc-900/90 overflow-hidden flex items-center justify-center">
        <canvas 
          ref={canvasRef} 
          width={220} 
          height={72} 
          className="w-full h-full block"
        />

        {/* Ambient CRT Vignette */}
        <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_12px_rgba(0,0,0,0.8)]"></div>
      </div>

      {/* Live Peak / Signal Level Bar */}
      <div className="mt-1.5 flex items-center gap-1.5 text-[7px] font-mono text-zinc-500">
        <span className="text-zinc-600">PEAK</span>
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
        <span className="text-zinc-400 font-bold min-w-[24px] text-right">
          {meter.peak > 0.01 ? `${Math.round(meter.peak * 100)}%` : 'IDLE'}
        </span>
      </div>
    </div>
  );
}

export default function MixerEQ({
  channels,
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
    noiseFloor: 2
  },
  setOscConfig
}: MixerEQProps) {
  const [masterVol, setMasterVol] = useState(85);
  const [reverbSize, setReverbSize] = useState(40);
  const [soundFonts, setSoundFonts] = useState(SpessaSynth.getLoadedSoundFonts());
  const [activeSoundFont, setActiveSoundFont] = useState(SpessaSynth.getActiveSoundFont());
  const [sfFeedback, setSfFeedback] = useState<string | null>(null);
  const [isMidiModalOpen, setIsMidiModalOpen] = useState(false);

  const sfUploadInputRef = useRef<HTMLInputElement>(null);

  const handleSoundFontUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (evt.target?.result instanceof ArrayBuffer) {
          try {
            const newSf = SpessaSynth.loadSoundFont(evt.target.result, file.name);
            setSoundFonts(SpessaSynth.getLoadedSoundFonts());
            setActiveSoundFont(newSf);
            setSfFeedback(`Loaded SoundFont Bank "${newSf.name}" (${newSf.instrumentCount} Presets) into spressasynth_lib-master.zip`);
            setTimeout(() => setSfFeedback(null), 4000);
          } catch (err: any) {
            setSfFeedback(`Error loading SoundFont: ${err.message}`);
          }
        }
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
            accept=".sf2,.sf3,.dls" 
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
                  {sf.name} ({sf.instrumentCount} presets)
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => sfUploadInputRef.current?.click()}
            className="px-2.5 py-1 bg-zinc-850 hover:bg-zinc-750 text-zinc-200 border border-zinc-700 rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer"
            title="Load external SoundFont2 (.sf2 / .sf3) into spressasynth_lib-master.zip"
          >
            <Upload size={11} />
            <span>Load SF2</span>
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

      {sfFeedback && (
        <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-lg px-3 py-1.5 text-[10px] text-emerald-300 flex items-center gap-2">
          <ShieldCheck size={14} className="text-emerald-400" />
          <span>{sfFeedback}</span>
        </div>
      )}

      {/* 16-OSCILLOSCOPE WALL MODULE */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-3 flex flex-col gap-3">
        
        {/* WALL TOOLBAR */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 pb-2.5">
          <div className="flex items-center gap-2">
            <Server size={14} className="text-amber-400" />
            <h3 className="font-bold text-xs uppercase tracking-wider text-white">
              16-Channel Vector Oscilloscope Matrix
            </h3>
            <span className="text-[9px] px-2 py-0.5 bg-amber-950/60 border border-amber-600/40 text-amber-300 rounded font-bold">
              16 CHANNELS LOCKED
            </span>
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

          {/* DISPLAY TOGGLE SWITCHES */}
          <div className="flex items-center gap-3 text-[9px] text-zinc-400">
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

        {/* 16 OSCILLOSCOPES GRID (Preserved 16 at all times for MIDI and Chiptune) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 max-h-[460px] overflow-y-auto custom-scrollbar p-1">
          {SIXTEEN_CHANNEL_ROLES.map((role, idx) => (
            <WebScopeCRT
              key={role.id}
              channelIndex={idx}
              role={role}
              isPlaying={isPlaying}
              oscConfig={oscConfig}
              pitch={channelPitches[role.id]}
            />
          ))}
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
      />

    </div>
  );
}
