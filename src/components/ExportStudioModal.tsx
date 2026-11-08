import React, { useState, useEffect } from 'react';
import { 
  Download, Video, Disc3, FileAudio, CheckCircle2, 
  X, Radio, Sparkles, Film, Play, Square, AlertCircle, Layers
} from 'lucide-react';
import { Channel } from '../types';
import { exportChiptuneFile } from '../utils/chiptuneExporters';
import { exportSoundFont } from '../utils/soundFontExporter';
import { VideoRecorder, VideoRecordMode, VideoRecorderStatus } from '../utils/videoRecorder';
import { WebScopePreset } from '../engines/webscopeOscilloscope';

interface ExportStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  songPatterns: any[][];
  channels: Channel[];
  bpm: number;
  trackTitle?: string | null;
  activePreset?: WebScopePreset;
  onSwitchChiptuneMode?: (mode: string) => void;
  currentMode?: string;
}

export const CHIPTUNE_MODES = [
  { id: 'mod', label: 'Amiga ProTracker (.MOD)', channels: 4, chip: 'PAULA (Amiga PCM)', ext: '.mod' },
  { id: 'xm', label: 'FastTracker II (.XM)', channels: 8, chip: 'FastTracker PCM', ext: '.xm' },
  { id: 's3m', label: 'ScreamTracker 3 (.S3M)', channels: 16, chip: 'S3M Digital / AdLib', ext: '.s3m' },
  { id: 'mid', label: 'General MIDI (.MID)', channels: 16, chip: 'General MIDI (SoundFont)', ext: '.mid' },
  { id: 'json', label: 'Aria48 Matrix (.JSON)', channels: 8, chip: 'Universal Synthesizer', ext: '.json' }
];

export default function ExportStudioModal({
  isOpen,
  onClose,
  songPatterns,
  channels,
  bpm,
  trackTitle,
  activePreset = 'protracker',
  onSwitchChiptuneMode,
  currentMode = 'mod'
}: ExportStudioModalProps) {
  const [selectedChiptuneMode, setSelectedChiptuneMode] = useState(currentMode);
  const [selectedVideoMode, setSelectedVideoMode] = useState<VideoRecordMode>('both');
  const [selectedSoundFontFormat, setSelectedSoundFontFormat] = useState<'sf2' | 'sf3' | 'dls'>('sf2');
  const [soundFontBankName, setSoundFontBankName] = useState(trackTitle || "Aria48_SoundFont_Bank");
  
  const [videoStatus, setVideoStatus] = useState<VideoRecorderStatus>({
    isRecording: VideoRecorder.isRecording(),
    mode: VideoRecorder.getMode(),
    durationSeconds: 0
  });

  const [downloadSuccess, setDownloadSuccess] = useState<string | null>(null);

  useEffect(() => {
    const unsub = VideoRecorder.onStatusChange((status) => {
      setVideoStatus(status);
    });
    return () => unsub();
  }, []);

  if (!isOpen) return null;

  const handleChiptuneModeSelect = (modeId: string) => {
    setSelectedChiptuneMode(modeId);
    onSwitchChiptuneMode?.(modeId);
  };

  const handleExportChiptune = () => {
    exportChiptuneFile(
      selectedChiptuneMode as any,
      songPatterns,
      trackTitle || "Aria48_Chiptune_Track",
      bpm,
      channels
    );
    setDownloadSuccess(`Exported ${selectedChiptuneMode.toUpperCase()} chiptune package!`);
    setTimeout(() => setDownloadSuccess(null), 3000);
  };

  const handleExportSoundFont = () => {
    exportSoundFont(selectedSoundFontFormat, soundFontBankName);
    setDownloadSuccess(`Exported .${selectedSoundFontFormat.toUpperCase()} SoundFont binary!`);
    setTimeout(() => setDownloadSuccess(null), 3000);
  };

  const handleToggleVideoRecording = () => {
    if (videoStatus.isRecording) {
      VideoRecorder.stopRecording();
    } else {
      const started = VideoRecorder.startRecording(selectedVideoMode, undefined, activePreset);
      if (!started) {
        alert("Could not start video recording. Please ensure audio context is active.");
      }
    }
  };

  const formatSecs = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm select-none font-mono">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-2xl w-full p-5 flex flex-col gap-5 shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar">
        
        {/* HEADER */}
        <div className="flex items-center justify-between border-b border-zinc-850 pb-3">
          <div className="flex items-center gap-2">
            <Download size={18} className="text-cyan-400" />
            <div>
              <h2 className="text-sm font-black uppercase tracking-wider text-white">
                Studio Export Center
              </h2>
              <p className="text-[10px] text-zinc-500 font-sans">
                Export Chiptune Modules, High-Definition Videos & Binary SoundFonts
              </p>
            </div>
          </div>

          <button 
            onClick={onClose}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {downloadSuccess && (
          <div className="bg-emerald-950/40 border border-emerald-500/50 rounded-xl p-2.5 flex items-center gap-2 text-emerald-300 text-xs animate-bounce">
            <CheckCircle2 size={16} className="text-emerald-400" />
            <span>{downloadSuccess}</span>
          </div>
        )}

        {/* 1. CHIPTUNE FILE EXPORT & MODE SWITCHER */}
        <div className="bg-zinc-900/60 border border-zinc-850 rounded-xl p-3.5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-bold text-cyan-400">
              <FileAudio size={15} />
              <span>1. CHIPTUNE FORMAT & MODULE EXPORT</span>
            </div>
            <span className="text-[9px] text-zinc-500 uppercase">Binary Sequencer Output</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {CHIPTUNE_MODES.map(m => (
              <button
                key={m.id}
                onClick={() => handleChiptuneModeSelect(m.id)}
                className={`p-2 rounded-lg border text-left transition cursor-pointer flex flex-col gap-0.5 ${
                  selectedChiptuneMode === m.id
                    ? 'bg-cyan-950/60 border-cyan-500/60 text-white shadow-sm'
                    : 'bg-zinc-950 border-zinc-850 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                }`}
              >
                <div className="font-bold text-[10.5px] truncate">{m.label}</div>
                <div className="text-[8.5px] text-zinc-500 font-sans">{m.channels} CH · {m.chip}</div>
              </button>
            ))}
          </div>

          <button
            onClick={handleExportChiptune}
            className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg font-bold text-xs uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-2 shadow-sm"
          >
            <Download size={13} />
            <span>Export Chiptune File ({selectedChiptuneMode.toUpperCase()})</span>
          </button>
        </div>

        {/* 2. VIDEO EXPORTER (OSCILLOSCOPE / TRACKER / BOTH) */}
        <div className="bg-zinc-900/60 border border-zinc-850 rounded-xl p-3.5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-bold text-amber-400">
              <Film size={15} />
              <span>2. VIDEO RECORDING & EXPORT</span>
            </div>
            {videoStatus.isRecording && (
              <span className="flex items-center gap-1.5 text-red-400 text-[10px] font-bold animate-pulse">
                <span className="h-2 w-2 rounded-full bg-red-500"></span>
                <span>REC [{formatSecs(videoStatus.durationSeconds)}]</span>
              </span>
            )}
          </div>

          <p className="text-[10px] text-zinc-400 font-sans leading-relaxed">
            Record high-definition video of the 16-channel vector CRT oscilloscope, the tracker pattern sequencer with samples inspector, or both views synchronized with the Web Audio stream.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {[
              { id: 'oscilloscope', title: 'Only Oscilloscope', desc: '16-Channel CRT Vector Wall', icon: '🎛️' },
              { id: 'tracker', title: 'Only Tracker', desc: 'Matrix & Sample Inspector', icon: '🎹' },
              { id: 'both', title: 'Both (Dual Screen)', desc: 'Split-Screen Tracker + Scopes', icon: '🔲' }
            ].map(vm => (
              <button
                key={vm.id}
                onClick={() => !videoStatus.isRecording && setSelectedVideoMode(vm.id as VideoRecordMode)}
                disabled={videoStatus.isRecording}
                className={`p-2.5 rounded-lg border text-left transition cursor-pointer flex flex-col gap-1 ${
                  selectedVideoMode === vm.id
                    ? 'bg-amber-950/60 border-amber-500/60 text-white shadow-sm'
                    : 'bg-zinc-950 border-zinc-850 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                } ${videoStatus.isRecording && selectedVideoMode !== vm.id ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className="text-base">{vm.icon}</div>
                <div className="font-bold text-[10.5px] text-zinc-200">{vm.title}</div>
                <div className="text-[8.5px] text-zinc-500 font-sans">{vm.desc}</div>
              </button>
            ))}
          </div>

          <button
            onClick={handleToggleVideoRecording}
            className={`w-full py-2.5 rounded-lg font-bold text-xs uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-2 shadow-sm ${
              videoStatus.isRecording
                ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
                : 'bg-amber-600 hover:bg-amber-500 text-white'
            }`}
          >
            {videoStatus.isRecording ? (
              <>
                <Square size={13} fill="currentColor" />
                <span>Stop & Download Video ({formatSecs(videoStatus.durationSeconds)})</span>
              </>
            ) : (
              <>
                <Video size={13} />
                <span>Start Video Recording ({selectedVideoMode.toUpperCase()})</span>
              </>
            )}
          </button>
        </div>

        {/* 3. SOUNDFONT EXPORT (.SF2 / .SF3 / .DLS) */}
        <div className="bg-zinc-900/60 border border-zinc-850 rounded-xl p-3.5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
              <Disc3 size={15} />
              <span>3. SOUNDFONT BINARY EXPORT</span>
            </div>
            <span className="text-[9px] text-zinc-500 uppercase">SpessaSynth Compatible</span>
          </div>

          <p className="text-[10px] text-zinc-400 font-sans leading-relaxed">
            Generate SoundFont files (.sf2, .sf3, .dls) containing the tracker PCM instruments, 16-bit sample wavetables, and preset generator records.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
              <span className="text-[10px] text-zinc-400 font-bold">Bank Name:</span>
              <input
                type="text"
                value={soundFontBankName}
                onChange={(e) => setSoundFontBankName(e.target.value)}
                className="bg-black border border-zinc-800 rounded px-2.5 py-1 text-xs text-emerald-300 font-mono flex-1 focus:outline-none focus:border-emerald-600"
              />
            </div>

            <div className="flex items-center gap-1 bg-zinc-950 p-1 border border-zinc-850 rounded-lg text-[10px]">
              {(['sf2', 'sf3', 'dls'] as const).map(fmt => (
                <button
                  key={fmt}
                  onClick={() => setSelectedSoundFontFormat(fmt)}
                  className={`px-3 py-1 rounded font-bold transition cursor-pointer uppercase ${
                    selectedSoundFontFormat === fmt
                      ? 'bg-emerald-600 text-white'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  .{fmt}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleExportSoundFont}
            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold text-xs uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-2 shadow-sm"
          >
            <Download size={13} />
            <span>Export SoundFont (.{selectedSoundFontFormat.toUpperCase()})</span>
          </button>
        </div>

      </div>
    </div>
  );
}
