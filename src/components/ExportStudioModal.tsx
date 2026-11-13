import React, { useState, useEffect, useRef } from 'react';
import {
  Download, Video, Disc3, FileAudio, CheckCircle2,
  X, Film, Square, RefreshCw, Cloud, Music2, AlertTriangle
} from 'lucide-react';
import { Channel } from '../types';
import { exportChiptuneFile } from '../utils/chiptuneExporters';
import { exportSoundFont } from '../utils/soundFontExporter';
import {
  AudioExportFormat,
  exportSnapshotToAudioFile
} from '../utils/audioExport';
import {
  VideoRecorder,
  VideoRecordMode,
  VideoRecorderStatus,
  VideoContainerFormat,
  VideoQualityPreset,
  VIDEO_QUALITY_PRESETS
} from '../utils/videoRecorder';
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

const AUDIO_FORMATS: { id: AudioExportFormat; label: string; desc: string }[] = [
  { id: 'mp3', label: '.MP3', desc: '192 kbps Stereo' },
  { id: 'mp2', label: '.MP2', desc: 'MPEG-1 Layer II' },
  { id: 'wav', label: '.WAV', desc: '16-bit PCM Lossless' }
];

const DURATION_PRESETS = [
  { sec: 10, label: '10s', desc: 'Quick clip' },
  { sec: 15, label: '15s', desc: 'Standard Reel/Shorts' },
  { sec: 30, label: '30s', desc: 'Medium showcase' },
  { sec: 60, label: '60s', desc: 'Extended clip' },
  { sec: 0, label: 'Full Song', desc: 'Export entire song / manual stop' }
];

const FPS_QUICK_PRESETS = [24, 30, 60, 120, 240, 365];
const QUALITY_KEYS: VideoQualityPreset[] = ['480p', '720p', '1080p', '1440p', '4k', '8k'];

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
  const [selectedAudioFormat, setSelectedAudioFormat] = useState<AudioExportFormat>('mp3');
  const [audioExporting, setAudioExporting] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioStage, setAudioStage] = useState('');
  const audioAbortRef = useRef<AbortController | null>(null);

  const [selectedVideoMode, setSelectedVideoMode] = useState<VideoRecordMode>('both');
  const [selectedVideoFormat, setSelectedVideoFormat] = useState<VideoContainerFormat>('mp4');
  const [selectedQuality, setSelectedQuality] = useState<VideoQualityPreset>('1080p');
  const [selectedFps, setSelectedFps] = useState<number>(60);
  const [selectedDuration, setSelectedDuration] = useState<number>(15);
  const [backgroundSeparateMode, setBackgroundSeparateMode] = useState<boolean>(true);
  const [autoStartAudio, setAutoStartAudio] = useState(true);

  const [selectedSoundFontFormat, setSelectedSoundFontFormat] = useState<'sf2' | 'sf3' | 'dls'>('sf2');
  const [soundFontBankName, setSoundFontBankName] = useState(trackTitle || 'Aria48_SoundFont_Bank');

  const [videoStatus, setVideoStatus] = useState<VideoRecorderStatus>(VideoRecorder.getStatus());
  const [downloadSuccess, setDownloadSuccess] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = VideoRecorder.onStatusChange((status) => {
      setVideoStatus(status);
      if (status.downloadedFilename) {
        setDownloadSuccess(`Export complete & downloaded: ${status.downloadedFilename}`);
        setExportError(null);
      } else if (status.errorMessage) {
        setExportError(status.errorMessage);
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
      trackTitle || 'Aria48_Chiptune_Track',
      bpm,
      channels
    );
    setExportError(null);
    setDownloadSuccess(`Exported ${selectedChiptuneMode.toUpperCase()} chiptune file.`);
    setTimeout(() => setDownloadSuccess(null), 3000);
  };

  const handleExportAudioFile = async () => {
    if (audioExporting) {
      audioAbortRef.current?.abort();
      return;
    }

    const ac = new AbortController();
    audioAbortRef.current = ac;
    setAudioExporting(true);
    setAudioProgress(1);
    setAudioStage(`Preparing ${selectedAudioFormat.toUpperCase()} render...`);
    setExportError(null);
    setDownloadSuccess(null);

    try {
      const snapshot = VideoRecorder.getCurrentSongSnapshot();
      const { filename } = await exportSnapshotToAudioFile(
        snapshot,
        selectedAudioFormat,
        (pct, stage) => {
          setAudioProgress(pct);
          setAudioStage(stage);
        },
        ac.signal
      );
      setDownloadSuccess(`Audio exported & downloaded: ${filename}`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setExportError(err?.message || `Failed to export ${selectedAudioFormat.toUpperCase()} audio.`);
      }
    } finally {
      audioAbortRef.current = null;
      setAudioExporting(false);
    }
  };

  const handleExportSoundFont = () => {
    exportSoundFont(selectedSoundFontFormat, soundFontBankName);
    setExportError(null);
    setDownloadSuccess(`Exported .${selectedSoundFontFormat.toUpperCase()} SoundFont binary.`);
    setTimeout(() => setDownloadSuccess(null), 3000);
  };

  const handleStartVideoExport = () => {
    setExportError(null);

    if (videoStatus.isBackgroundJob) {
      VideoRecorder.cancelBackgroundExport();
      return;
    }
    if (videoStatus.isRecording) {
      VideoRecorder.stopRecording();
      return;
    }

    const clampedFps = Math.max(1, Math.min(365, Math.round(selectedFps || 60)));

    if (backgroundSeparateMode) {
      void VideoRecorder.startBackgroundExport(selectedVideoMode, {
        targetDurationSeconds: selectedDuration,
        activePreset,
        format: selectedVideoFormat,
        fps: clampedFps,
        quality: selectedQuality,
        onComplete: (_blob, filename) => {
          setDownloadSuccess(`Background ${selectedVideoFormat.toUpperCase()} exported: ${filename}`);
        }
      });
      return;
    }

    // Live real-time capture mode
    if (autoStartAudio && !isPlaying) {
      onTriggerPlay?.();
    }

    const started = VideoRecorder.startRecording(selectedVideoMode, {
      targetDurationSeconds: selectedDuration,
      activePreset,
      format: selectedVideoFormat,
      fps: clampedFps,
      quality: selectedQuality,
      onComplete: (_blob, filename) => {
        setDownloadSuccess(`Video export finished! Auto-saved: ${filename}`);
      }
    });

    if (!started) {
      setExportError('Could not start live video capture.');
    }
  };

  const formatSecs = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms}`;
  };

  const isBusyVideo = videoStatus.isRecording || videoStatus.isProcessing || videoStatus.isBackgroundJob;
  const qSpec = VIDEO_QUALITY_PRESETS[selectedQuality];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm select-none font-mono">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-2xl w-full p-5 flex flex-col gap-4 shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar">

        {/* HEADER */}
        <div className="flex items-center justify-between border-b border-zinc-850 pb-3">
          <div className="flex items-center gap-2">
            <Download size={18} className="text-cyan-400" />
            <div>
              <h2 className="text-sm font-black uppercase tracking-wider text-white">
                Studio Export Center
              </h2>
              <p className="text-[10px] text-zinc-500 font-sans">
                Export MP3/MP2/WAV Audio, Background MP4/WebM Video (Up to 8K · 365 FPS) &amp; SoundFonts
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
          <div className="bg-emerald-950/40 border border-emerald-500/50 rounded-xl p-2.5 flex items-center justify-between gap-2 text-emerald-300 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
              <span className="font-semibold truncate">{downloadSuccess}</span>
            </div>
            <button
              onClick={() => setDownloadSuccess(null)}
              className="text-emerald-400 hover:text-white text-[10px] underline cursor-pointer shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {exportError && (
          <div className="bg-red-950/40 border border-red-500/50 rounded-xl p-2.5 flex items-center justify-between gap-2 text-red-300 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle size={15} className="text-red-400 shrink-0" />
              <span className="font-semibold break-words">{exportError}</span>
            </div>
            <button
              onClick={() => setExportError(null)}
              className="text-red-400 hover:text-white text-[10px] underline cursor-pointer shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* 1. AUDIO FILE EXPORT (.MP3 / .MP2 / .WAV) & CHIPTUNE MODULES */}
        <div className="bg-zinc-900/60 border border-zinc-850 rounded-xl p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-bold text-cyan-400">
              <Music2 size={14} />
              <span>1. AUDIO EXPORT (.MP3 / .MP2 / .WAV)</span>
            </div>
            <span className="text-[9px] text-zinc-500 uppercase">Offline Stereo Render</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {AUDIO_FORMATS.map(af => (
              <button
                key={af.id}
                disabled={audioExporting}
                onClick={() => setSelectedAudioFormat(af.id)}
                className={`p-2 rounded-lg border text-left transition cursor-pointer flex flex-col ${
                  selectedAudioFormat === af.id
                    ? 'bg-cyan-950/60 border-cyan-500/70 text-white'
                    : 'bg-zinc-950 border-zinc-850 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                } ${audioExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className="font-black text-xs text-cyan-300">{af.label}</div>
                <div className="text-[8.5px] text-zinc-500 font-sans">{af.desc}</div>
              </button>
            ))}
          </div>

          {audioExporting && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[9.5px] text-cyan-300">
                <span className="truncate">{audioStage}</span>
                <span className="font-bold">{audioProgress}%</span>
              </div>
              <div className="w-full bg-zinc-950 rounded-full h-1.5 overflow-hidden border border-zinc-800">
                <div
                  className="bg-cyan-500 h-full rounded-full transition-all duration-150"
                  style={{ width: `${audioProgress}%` }}
                />
              </div>
            </div>
          )}

          <button
            onClick={handleExportAudioFile}
            className={`w-full py-2 rounded-lg font-bold text-xs uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-2 ${
              audioExporting
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-sm'
            }`}
          >
            {audioExporting ? (
              <>
                <Square size={12} fill="currentColor" />
                <span>Cancel Audio Export ({audioProgress}%)</span>
              </>
            ) : (
              <>
                <Download size={13} />
                <span>Export Song Audio ({selectedAudioFormat.toUpperCase()})</span>
              </>
            )}
          </button>

          {/* Compact Chiptune Module Exporters */}
          <div className="border-t border-zinc-850 pt-2.5 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10.5px] font-bold text-zinc-300">
                <FileAudio size={13} className="text-cyan-400" />
                <span>Chiptune Sequencer Modules</span>
              </div>
              <button
                onClick={handleExportChiptune}
                className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-cyan-300 text-[10px] font-bold uppercase cursor-pointer flex items-center gap-1"
              >
                <Download size={11} />
                <span>Export .{selectedChiptuneMode.toUpperCase()}</span>
              </button>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {CHIPTUNE_MODES.map(m => (
                <button
                  key={m.id}
                  onClick={() => handleChiptuneModeSelect(m.id)}
                  className={`px-1.5 py-1 rounded border text-center transition cursor-pointer ${
                    selectedChiptuneMode === m.id
                      ? 'bg-cyan-950/60 border-cyan-500/60 text-white'
                      : 'bg-zinc-950 border-zinc-850 text-zinc-400 hover:border-zinc-700'
                  }`}
                  title={m.label}
                >
                  <div className="font-bold text-[10px] uppercase">{m.ext}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 2. MINI VIDEO RECORDER (BACKGROUND MP4/WEBM · UP TO 8K & 365 FPS · NON-OVERLAPPING) */}
        <div className="bg-zinc-900/60 border border-amber-900/40 rounded-xl p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-400">
              <Film size={13} />
              <span>2. MINI VIDEO EXPORTER</span>
              <span className="text-[8px] px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-800/40 text-amber-300 uppercase">
                {backgroundSeparateMode ? 'Background Offline' : 'Live Capture'}
              </span>
            </div>

            {videoStatus.isBackgroundJob ? (
              <span className="flex items-center gap-1.5 text-amber-300 text-[10px] font-bold animate-pulse">
                <RefreshCw size={11} className="animate-spin text-amber-400" />
                <span>{videoStatus.progressPercent}% ({videoStatus.format.toUpperCase()} {videoStatus.resolutionLabel})</span>
              </span>
            ) : videoStatus.isRecording ? (
              <span className="flex items-center gap-1.5 text-red-400 text-[10px] font-bold animate-pulse">
                <span className="h-2 w-2 rounded-full bg-red-500"></span>
                <span>REC {formatSecs(videoStatus.durationSeconds)}</span>
              </span>
            ) : (
              <label
                className="flex items-center gap-1.5 text-[9.5px] text-amber-200/90 cursor-pointer"
                title="Renders video completely in the background from an independent snapshot so you can play or switch songs separately"
              >
                <input
                  type="checkbox"
                  checked={backgroundSeparateMode}
                  onChange={(e) => setBackgroundSeparateMode(e.target.checked)}
                  disabled={isBusyVideo}
                  className="rounded border-zinc-700 accent-amber-500 cursor-pointer"
                />
                <span>Background (separate from playing song)</span>
              </label>
            )}
          </div>

          {/* VIEW MODE: SCOPES / TRACKER / MINI SPLIT BOTH */}
          <div className="grid grid-cols-3 gap-1.5">
            {[
              { id: 'oscilloscope', title: '16-CH Scopes', desc: 'CRT Matrix Only' },
              { id: 'tracker', title: 'Live Tracker', desc: 'Real Pattern Notes' },
              { id: 'both', title: 'Mini Split Both', desc: 'Tracker | Scopes' }
            ].map(vm => (
              <button
                key={vm.id}
                onClick={() => !isBusyVideo && setSelectedVideoMode(vm.id as VideoRecordMode)}
                disabled={isBusyVideo}
                className={`px-2 py-1.5 rounded-lg border text-left transition cursor-pointer flex flex-col ${
                  selectedVideoMode === vm.id
                    ? 'bg-amber-950/60 border-amber-500/70 text-white'
                    : 'bg-zinc-950 border-zinc-850 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                } ${isBusyVideo ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className="font-bold text-[10px] text-zinc-200 truncate">{vm.title}</div>
                <div className="text-[8px] text-zinc-500 font-sans truncate">{vm.desc}</div>
              </button>
            ))}
          </div>

          {/* FORMAT (.MP4 / .WEBM) & QUALITY (UP TO 8K) */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center bg-zinc-950/80 border border-zinc-850 rounded-lg p-2">
            {/* MP4 vs WebM */}
            <div className="sm:col-span-4 flex items-center gap-1">
              <span className="text-[9px] text-zinc-400 font-bold uppercase mr-1">Fmt:</span>
              {(['mp4', 'webm'] as VideoContainerFormat[]).map(fmt => (
                <button
                  key={fmt}
                  disabled={isBusyVideo}
                  onClick={() => setSelectedVideoFormat(fmt)}
                  className={`flex-1 py-1 rounded text-[10px] font-black uppercase border transition cursor-pointer ${
                    selectedVideoFormat === fmt
                      ? 'bg-amber-600 text-white border-amber-400'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  } ${isBusyVideo ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  .{fmt}
                </button>
              ))}
            </div>

            {/* Quality Presets up to 8K */}
            <div className="sm:col-span-8 flex items-center gap-1 flex-wrap">
              <span className="text-[9px] text-zinc-400 font-bold uppercase mr-1">Quality:</span>
              {QUALITY_KEYS.map(qk => (
                <button
                  key={qk}
                  disabled={isBusyVideo}
                  onClick={() => setSelectedQuality(qk)}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold border transition cursor-pointer ${
                    selectedQuality === qk
                      ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  } ${isBusyVideo ? 'opacity-40 cursor-not-allowed' : ''}`}
                  title={VIDEO_QUALITY_PRESETS[qk].label}
                >
                  {VIDEO_QUALITY_PRESETS[qk].shortLabel}
                </button>
              ))}
              <span className="text-[8.5px] text-zinc-500 ml-auto font-sans">
                {qSpec.width}×{qSpec.height}
              </span>
            </div>
          </div>

          {/* CUSTOM FPS SELECTOR (1 - 365 FPS) */}
          <div className="flex flex-wrap items-center gap-2 bg-zinc-950/80 border border-zinc-850 rounded-lg p-2">
            <span className="text-[9px] text-zinc-400 font-bold uppercase">FPS (Max 365):</span>
            <input
              type="range"
              min={1}
              max={365}
              value={selectedFps}
              disabled={isBusyVideo}
              onChange={(e) => setSelectedFps(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
              className="flex-1 min-w-[90px] h-1.5 accent-amber-500 cursor-pointer"
            />
            <input
              type="number"
              min={1}
              max={365}
              value={selectedFps}
              disabled={isBusyVideo}
              onChange={(e) => setSelectedFps(Math.max(1, Math.min(365, Math.round(Number(e.target.value) || 1))))}
              className="w-14 bg-black border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-amber-300 font-bold text-center focus:outline-none focus:border-amber-400"
            />
            <div className="flex items-center gap-1">
              {FPS_QUICK_PRESETS.map(fpsVal => (
                <button
                  key={fpsVal}
                  disabled={isBusyVideo}
                  onClick={() => setSelectedFps(fpsVal)}
                  className={`px-1.5 py-0.5 rounded text-[8.5px] font-bold border transition cursor-pointer ${
                    selectedFps === fpsVal
                      ? 'bg-amber-600 text-white border-amber-400'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  } ${isBusyVideo ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  {fpsVal}
                </button>
              ))}
            </div>
          </div>

          {/* MINI DURATION PILLS + START/CANCEL TRIGGER */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 flex-1 min-w-[200px]">
              {DURATION_PRESETS.map(dp => (
                <button
                  key={dp.sec}
                  onClick={() => !isBusyVideo && setSelectedDuration(dp.sec)}
                  disabled={isBusyVideo}
                  className={`flex-1 py-1 px-1 rounded text-center border transition cursor-pointer ${
                    selectedDuration === dp.sec
                      ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                      : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  } ${isBusyVideo ? 'opacity-40 cursor-not-allowed' : ''}`}
                  title={dp.desc}
                >
                  <div className="text-[9px] font-bold">{dp.label}</div>
                </button>
              ))}
            </div>

            {!backgroundSeparateMode && !isBusyVideo && (
              <label className="flex items-center gap-1 text-[9px] text-zinc-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoStartAudio}
                  onChange={(e) => setAutoStartAudio(e.target.checked)}
                  className="rounded border-zinc-700 accent-amber-500 cursor-pointer"
                />
                <span>Auto-play</span>
              </label>
            )}

            <button
              onClick={handleStartVideoExport}
              disabled={videoStatus.isProcessing && !videoStatus.isBackgroundJob && !videoStatus.isRecording}
              className={`px-3 py-1.5 rounded-lg font-bold text-[10px] uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-1.5 shrink-0 ${
                videoStatus.isBackgroundJob || videoStatus.isRecording
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-amber-600 hover:bg-amber-500 text-white'
              }`}
            >
              {videoStatus.isBackgroundJob ? (
                <>
                  <Square size={11} fill="currentColor" />
                  <span>Cancel ({videoStatus.progressPercent}%)</span>
                </>
              ) : videoStatus.isRecording ? (
                <>
                  <Square size={11} fill="currentColor" />
                  <span>Stop ({formatSecs(videoStatus.durationSeconds)})</span>
                </>
              ) : (
                <>
                  <Video size={11} />
                  <span>
                    {backgroundSeparateMode ? 'Export' : 'Capture'} {selectedVideoFormat.toUpperCase()} ({qSpec.shortLabel}@{selectedFps}fps)
                  </span>
                </>
              )}
            </button>
          </div>

          {(videoStatus.isBackgroundJob || (videoStatus.isRecording && videoStatus.targetDurationSeconds > 0)) && (
            <div className="flex flex-col gap-1 pt-0.5">
              {videoStatus.stageLabel && (
                <div className="flex items-center justify-between text-[9px] text-amber-300">
                  <span className="truncate">{videoStatus.stageLabel}</span>
                  <span className="font-bold">{videoStatus.progressPercent}%</span>
                </div>
              )}
              <div className="w-full bg-zinc-950 rounded-full h-1.5 overflow-hidden border border-zinc-800">
                <div
                  className="bg-amber-500 h-full rounded-full transition-all duration-200"
                  style={{ width: `${videoStatus.progressPercent}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* 3. SOUNDFONT EXPORT (.SF2 / .SF3 / .DLS) */}
        <div className="bg-zinc-900/60 border border-zinc-850 rounded-xl p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
              <Disc3 size={14} />
              <span>3. SOUNDFONT BINARY EXPORT</span>
            </div>
            <span className="text-[9px] text-zinc-500 uppercase">SpessaSynth Compatible</span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-1.5 flex-1 min-w-[180px]">
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
                  className={`px-2.5 py-0.5 rounded font-bold transition cursor-pointer uppercase ${
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
            className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold text-xs uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-2 shadow-sm"
          >
            <Download size={13} />
            <span>Export SoundFont (.{selectedSoundFontFormat.toUpperCase()})</span>
          </button>
        </div>

        {/* 4. GOOGLE CLOUD STORAGE & SYNC */}
        {onOpenCloudModal && (
          <div className="bg-zinc-900/60 border border-indigo-900/50 rounded-xl p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-bold text-indigo-400">
              <Cloud size={15} />
              <span>4. GOOGLE CLOUD LIBRARY</span>
            </div>
            <button
              id="export-modal-google-cloud-btn"
              onClick={onOpenCloudModal}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-[10.5px] uppercase tracking-wider transition cursor-pointer flex items-center gap-1.5"
            >
              <span>Open Cloud Library</span>
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
