import React, { useState, useEffect } from 'react';
import { 
  Download, Video, Disc3, FileAudio, CheckCircle2, 
  X, Radio, Sparkles, Film, Play, Square, AlertCircle, Layers, Cloud, Clock, RefreshCw, Check
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
  onOpenCloudModal?: () => void;
  isPlaying?: boolean;
  onTriggerPlay?: () => void;
}

export const CHIPTUNE_MODES = [
  { id: 'mod', label: 'Amiga ProTracker (.MOD)', channels: 4, chip: 'PAULA (Amiga PCM)', ext: '.mod' },
  { id: 'xm', label: 'FastTracker II (.XM)', channels: 8, chip: 'FastTracker PCM', ext: '.xm' },
  { id: 's3m', label: 'ScreamTracker 3 (.S3M)', channels: 16, chip: 'S3M Digital / AdLib', ext: '.s3m' },
  { id: 'mid', label: 'General MIDI (.MID)', channels: 16, chip: 'General MIDI (SoundFont)', ext: '.mid' },
  { id: 'json', label: 'Aria48 Matrix (.JSON)', channels: 8, chip: 'Universal Synthesizer', ext: '.json' }
];

const DURATION_PRESETS = [
  { sec: 10, label: '10s (Short)', desc: 'Quick clip' },
  { sec: 15, label: '15s (Reel)', desc: 'Standard Reel/Shorts' },
  { sec: 30, label: '30s (Social)', desc: 'Medium showcase' },
  { sec: 60, label: '60s (Loop)', desc: 'Full loop' },
  { sec: 0, label: 'Manual', desc: 'Continuous record' }
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
  currentMode = 'mod',
  onOpenCloudModal,
  isPlaying = false,
  onTriggerPlay
}: ExportStudioModalProps) {
  const [selectedChiptuneMode, setSelectedChiptuneMode] = useState(currentMode);
  const [selectedVideoMode, setSelectedVideoMode] = useState<VideoRecordMode>('both');
  const [selectedDuration, setSelectedDuration] = useState<number>(15); // Default 15s auto-process
  const [autoStartAudio, setAutoStartAudio] = useState(true);
  const [selectedSoundFontFormat, setSelectedSoundFontFormat] = useState<'sf2' | 'sf3' | 'dls'>('sf2');
  const [soundFontBankName, setSoundFontBankName] = useState(trackTitle || "Aria48_SoundFont_Bank");
  
  const [videoStatus, setVideoStatus] = useState<VideoRecorderStatus>(VideoRecorder.getStatus());
  const [downloadSuccess, setDownloadSuccess] = useState<string | null>(null);

  useEffect(() => {
    const unsub = VideoRecorder.onStatusChange((status) => {
      setVideoStatus(status);
      if (status.downloadedFilename) {
        setDownloadSuccess(`Auto-processed & downloaded: ${status.downloadedFilename}`);
      }
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

  const handleStartAutoVideoExport = () => {
    if (videoStatus.isRecording) {
      VideoRecorder.stopRecording();
      return;
    }

    // Auto-start audio if paused so wave signals and synth are active
    if (autoStartAudio && !isPlaying) {
      onTriggerPlay?.();
    }

    const started = VideoRecorder.startRecording(selectedVideoMode, {
      targetDurationSeconds: selectedDuration,
      activePreset,
      onComplete: (_blob, filename) => {
        setDownloadSuccess(`Video export finished! Auto-saved: ${filename}`);
      }
    });

    if (!started) {
      setDownloadSuccess('Could not start video recorder — activate audio playback first.');
    }
  };

  const formatSecs = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms}`;
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
          <div className="bg-emerald-950/40 border border-emerald-500/50 rounded-xl p-3 flex items-center justify-between gap-2 text-emerald-300 text-xs">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
              <span className="font-semibold">{downloadSuccess}</span>
            </div>
            <button 
              onClick={() => setDownloadSuccess(null)}
              className="text-emerald-400 hover:text-white text-xs underline cursor-pointer"
            >
              Dismiss
            </button>
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

        {/* 2. MINI INTERNAL VIDEO RECORDER (NON-OVERLAPPING DUAL SPLIT / LIVE MATRIX) */}
        <div className="bg-zinc-900/60 border border-amber-900/40 rounded-xl p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-400">
              <Film size={13} />
              <span>2. MINI VIDEO RECORDER</span>
              <span className="text-[8.5px] px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-800/40 text-amber-300 uppercase">
                Live Tracker Sync
              </span>
            </div>
            {videoStatus.isRecording ? (
              <span className="flex items-center gap-1.5 text-red-400 text-[10px] font-bold animate-pulse">
                <span className="h-2 w-2 rounded-full bg-red-500"></span>
                <span>REC {formatSecs(videoStatus.durationSeconds)}{videoStatus.targetDurationSeconds > 0 ? `/${videoStatus.targetDurationSeconds}s` : ''}</span>
              </span>
            ) : videoStatus.isProcessing ? (
              <span className="flex items-center gap-1 text-amber-300 text-[10px] font-bold animate-pulse">
                <RefreshCw size={11} className="animate-spin text-amber-400" />
                <span>ENCODING...</span>
              </span>
            ) : (
              <label className="flex items-center gap-1 text-[9.5px] text-zinc-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoStartAudio}
                  onChange={(e) => setAutoStartAudio(e.target.checked)}
                  disabled={videoStatus.isRecording || videoStatus.isProcessing}
                  className="rounded border-zinc-700 text-amber-500 focus:ring-0 cursor-pointer"
                />
                <span>Auto-play</span>
              </label>
            )}
          </div>

          {/* COMPACT MINI VIEW MODE & LAYOUT ROW */}
          <div className="grid grid-cols-3 gap-1.5">
            {[
              { id: 'oscilloscope', title: '16-CH Scopes', desc: 'CRT Matrix Only' },
              { id: 'tracker', title: 'Live Tracker', desc: 'Real Pattern Notes' },
              { id: 'both', title: 'Mini Split Both', desc: 'Tracker | Scopes' }
            ].map(vm => (
              <button
                key={vm.id}
                onClick={() => !videoStatus.isRecording && !videoStatus.isProcessing && setSelectedVideoMode(vm.id as VideoRecordMode)}
                disabled={videoStatus.isRecording || videoStatus.isProcessing}
                className={`px-2 py-1.5 rounded-lg border text-left transition cursor-pointer flex flex-col ${
                  selectedVideoMode === vm.id
                    ? 'bg-amber-950/60 border-amber-500/70 text-white'
                    : 'bg-zinc-950 border-zinc-850 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                } ${videoStatus.isRecording || videoStatus.isProcessing ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className="font-bold text-[10px] text-zinc-200 truncate">{vm.title}</div>
                <div className="text-[8px] text-zinc-500 font-sans truncate">{vm.desc}</div>
              </button>
            ))}
          </div>

          {/* MINI DURATION PILLS + RECORD TRIGGER */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 flex-1 min-w-[210px]">
              {DURATION_PRESETS.map(dp => (
                <button
                  key={dp.sec}
                  onClick={() => !videoStatus.isRecording && !videoStatus.isProcessing && setSelectedDuration(dp.sec)}
                  disabled={videoStatus.isRecording || videoStatus.isProcessing}
                  className={`flex-1 py-1 px-1 rounded text-center border transition cursor-pointer ${
                    selectedDuration === dp.sec
                      ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                      : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  } ${videoStatus.isRecording || videoStatus.isProcessing ? 'opacity-40 cursor-not-allowed' : ''}`}
                  title={dp.desc}
                >
                  <div className="text-[9.5px] font-bold">{dp.sec > 0 ? `${dp.sec}s` : 'Manual'}</div>
                </button>
              ))}
            </div>

            <button
              onClick={handleStartAutoVideoExport}
              disabled={videoStatus.isProcessing}
              className={`px-3 py-1.5 rounded-lg font-bold text-[10px] uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-1.5 shrink-0 ${
                videoStatus.isProcessing
                  ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                  : videoStatus.isRecording
                    ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
                    : 'bg-amber-600 hover:bg-amber-500 text-white'
              }`}
            >
              {videoStatus.isRecording ? (
                <>
                  <Square size={11} fill="currentColor" />
                  <span>Stop ({formatSecs(videoStatus.durationSeconds)})</span>
                </>
              ) : videoStatus.isProcessing ? (
                <>
                  <RefreshCw size={11} className="animate-spin" />
                  <span>Encoding...</span>
                </>
              ) : (
                <>
                  <Video size={11} />
                  <span>Record ({selectedDuration > 0 ? `${selectedDuration}s` : 'Manual'})</span>
                </>
              )}
            </button>
          </div>

          {videoStatus.isRecording && videoStatus.targetDurationSeconds > 0 && (
            <div className="w-full bg-zinc-950 rounded-full h-1.5 overflow-hidden border border-zinc-800">
              <div
                className="bg-amber-500 h-full rounded-full transition-all duration-200"
                style={{ width: `${videoStatus.progressPercent}%` }}
              />
            </div>
          )}
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

        {/* 4. GOOGLE CLOUD STORAGE & SYNC */}
        <div className="bg-zinc-900/60 border border-indigo-900/50 rounded-xl p-3.5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-bold text-indigo-400">
              <Cloud size={15} />
              <span>4. GOOGLE CLOUD SONG STORAGE & IMPORT</span>
            </div>
            <span className="text-[9px] text-zinc-500 uppercase">Google Sign-In Sync</span>
          </div>

          <p className="text-[10px] text-zinc-400 font-sans leading-relaxed">
            Directly export your song sequence, patterns, tempo, and SoundFont configuration to your Google Cloud library or browse and import any previously saved song.
          </p>

          <button
            id="export-modal-google-cloud-btn"
            onClick={onOpenCloudModal}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-xs uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(99,102,241,0.3)]"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
            </svg>
            <span>Open Google Cloud Library (Export / Import)</span>
          </button>
        </div>

      </div>
    </div>
  );
}
