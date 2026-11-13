import React, { useRef, useState, useCallback, useEffect } from 'react';
import { 
  Play, Square, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, 
  Clock, Hash, Layers, Sliders, SkipBack, SkipForward, Repeat
} from 'lucide-react';

interface TimeBarProps {
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  bpm: number;
  activeRow: number;
  setActiveRow: (row: number) => void;
  currentPatternIndex: number;
  setCurrentPatternIndex: (idx: number) => void;
  songPatterns: any[][];
  setPatterns?: (pattern: any[]) => void;
  trackDuration?: string | null;
  trackTitle?: string | null;
  loadedAudioBuffer?: AudioBuffer | null;
  actualTotalSeconds?: number | null;
  actualElapsedSeconds?: number | null;
  onSeekAudio?: (seconds: number) => void;
  onSeekPosition?: (seconds: number, ratio: number) => void;
}

export default function TimeBar({
  isPlaying,
  setIsPlaying,
  bpm,
  activeRow,
  setActiveRow,
  currentPatternIndex,
  setCurrentPatternIndex,
  songPatterns,
  setPatterns,
  trackDuration,
  trackTitle,
  loadedAudioBuffer,
  actualTotalSeconds,
  actualElapsedSeconds,
  onSeekAudio,
  onSeekPosition
}: TimeBarProps) {
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; pattern: number; row: number; timeStr: string } | null>(null);

  const totalPatterns = Math.max(1, songPatterns.length);
  const rowsPerPattern = 64;
  const totalRows = totalPatterns * rowsPerPattern;
  const currentRowGlobal = Math.max(0, Math.min(totalRows - 1, currentPatternIndex * rowsPerPattern + Math.min(63, activeRow)));
  const progressRatio = totalRows > 1 ? currentRowGlobal / (totalRows - 1) : 0;

  // Calculate timestamps in seconds (favoring actual audio/MIDI duration scaled by live BPM)
  const secondsPerRow = 60 / Math.max(30, bpm) / 4;
  const totalSeconds =
    actualTotalSeconds && actualTotalSeconds > 0
      ? actualTotalSeconds
      : loadedAudioBuffer
        ? loadedAudioBuffer.duration
        : totalRows * secondsPerRow;
  const elapsedSeconds =
    actualElapsedSeconds !== undefined && actualElapsedSeconds !== null
      ? Math.max(0, Math.min(totalSeconds, actualElapsedSeconds))
      : progressRatio * totalSeconds;

  const formatTime = (secs: number) => {
    const safe = Math.max(0, Number.isFinite(secs) ? secs : 0);
    const m = Math.floor(safe / 60);
    const s = Math.floor(safe % 60);
    const ms = Math.floor((safe % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
  };

  const seekToGlobalRow = useCallback((globalRow: number) => {
    const clampedGlobal = Math.max(0, Math.min(totalRows - 1, Math.round(globalRow)));
    const targetPattern = Math.floor(clampedGlobal / rowsPerPattern);
    const targetRow = clampedGlobal % rowsPerPattern;
    const ratio = totalRows > 1 ? clampedGlobal / (totalRows - 1) : 0;

    setCurrentPatternIndex(targetPattern);
    setActiveRow(targetRow);

    if (setPatterns && songPatterns[targetPattern]) {
      setPatterns(songPatterns[targetPattern]);
    }

    const targetSeconds = ratio * totalSeconds;
    onSeekPosition?.(targetSeconds, ratio);
    onSeekAudio?.(targetSeconds);
  }, [totalRows, rowsPerPattern, setCurrentPatternIndex, setActiveRow, setPatterns, songPatterns, totalSeconds, onSeekAudio, onSeekPosition]);

  const handleScrubberMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsScrubbing(true);
    updateScrubPosition(e.clientX);
  };

  const updateScrubPosition = (clientX: number) => {
    if (!scrubberRef.current) return;
    const rect = scrubberRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetGlobalRow = ratio * (totalRows - 1);
    seekToGlobalRow(targetGlobalRow);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isScrubbing) {
        updateScrubPosition(e.clientX);
      }
    };
    const handleMouseUp = () => {
      if (isScrubbing) {
        setIsScrubbing(false);
      }
    };

    if (isScrubbing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isScrubbing]);

  const handleScrubberHover = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!scrubberRef.current) return;
    const rect = scrubberRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetGlobalRow = Math.round(ratio * (totalRows - 1));
    const pat = Math.floor(targetGlobalRow / rowsPerPattern);
    const row = targetGlobalRow % rowsPerPattern;
    const secs = ratio * totalSeconds;

    setHoverInfo({
      x: e.clientX - rect.left,
      pattern: pat,
      row: row,
      timeStr: formatTime(secs)
    });
  };

  // Jump helpers
  const jumpToStart = () => seekToGlobalRow(0);
  const jumpToEnd = () => seekToGlobalRow(totalRows - 1);
  const jumpPrevPattern = () => {
    const prevPat = Math.max(0, currentPatternIndex - 1);
    seekToGlobalRow(prevPat * rowsPerPattern);
  };
  const jumpNextPattern = () => {
    const nextPat = Math.min(totalPatterns - 1, currentPatternIndex + 1);
    seekToGlobalRow(nextPat * rowsPerPattern);
  };
  const jumpStepRows = (delta: number) => {
    seekToGlobalRow(currentRowGlobal + delta);
  };

  return (
    <div className="bg-zinc-950/95 border-b border-zinc-800 px-3 py-2 flex flex-col gap-2 font-mono select-none shadow-md z-20">
      
      {/* TIMELINE METRICS & NAVIGATION CONTROLS */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        
        {/* LEFT: TRANSPORT SHORTCUTS & TIMELINE JUMP CONTROLS */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            id="timebar-play-toggle-btn"
            onClick={() => setIsPlaying(!isPlaying)}
            className={`p-1.5 px-2.5 rounded-lg border font-bold text-[10px] uppercase tracking-wider transition cursor-pointer flex items-center gap-1.5 shadow-sm ${
              isPlaying 
                ? 'bg-cyan-600 border-cyan-400 text-white shadow-[0_0_12px_rgba(6,182,212,0.4)]' 
                : 'bg-zinc-900 border-zinc-800 hover:border-cyan-500/50 text-cyan-400 hover:bg-zinc-800'
            }`}
            title={isPlaying ? "Pause Playback (Spacebar)" : "Play Track (Spacebar)"}
          >
            {isPlaying ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
            <span>{isPlaying ? 'PAUSE' : 'PLAY'}</span>
          </button>

          {/* JUMP TO START */}
          <button
            id="timebar-jump-start-btn"
            onClick={jumpToStart}
            className="p-1 px-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800 rounded transition cursor-pointer"
            title="Jump to Start (Pattern 0, Row 0)"
          >
            <ChevronsLeft size={13} />
          </button>

          {/* JUMP PREV PATTERN */}
          <button
            id="timebar-prev-pat-btn"
            onClick={jumpPrevPattern}
            disabled={currentPatternIndex === 0}
            className="p-1 px-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800 rounded transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title="Previous Pattern Block"
          >
            <ChevronLeft size={13} />
          </button>

          {/* -16 ROWS */}
          <button
            id="timebar-back-16-btn"
            onClick={() => jumpStepRows(-16)}
            className="px-1.5 py-0.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-cyan-400 border border-zinc-800 rounded text-[9.5px] font-bold transition cursor-pointer"
            title="Seek back 16 rows"
          >
            -16
          </button>

          {/* +16 ROWS */}
          <button
            id="timebar-forward-16-btn"
            onClick={() => jumpStepRows(16)}
            className="px-1.5 py-0.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-cyan-400 border border-zinc-800 rounded text-[9.5px] font-bold transition cursor-pointer"
            title="Seek forward 16 rows"
          >
            +16
          </button>

          {/* JUMP NEXT PATTERN */}
          <button
            id="timebar-next-pat-btn"
            onClick={jumpNextPattern}
            disabled={currentPatternIndex >= totalPatterns - 1}
            className="p-1 px-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800 rounded transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title="Next Pattern Block"
          >
            <ChevronRight size={13} />
          </button>

          {/* JUMP TO END */}
          <button
            id="timebar-jump-end-btn"
            onClick={jumpToEnd}
            className="p-1 px-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800 rounded transition cursor-pointer"
            title="Jump to End"
          >
            <ChevronsRight size={13} />
          </button>
        </div>

        {/* CENTER: SYNCED TIME & POSITION INDICATORS */}
        <div className="flex items-center gap-2.5 bg-black/60 border border-zinc-800/80 px-3 py-1 rounded-lg">
          {/* TIME ELAPSED / TOTAL */}
          <div className="flex items-center gap-1.5 text-indigo-400 font-bold">
            <Clock size={12} className="text-indigo-400" />
            <span className="text-zinc-200">{formatTime(elapsedSeconds)}</span>
            <span className="text-zinc-600">/</span>
            <span className="text-zinc-400">{actualTotalSeconds ? formatTime(totalSeconds) : (trackDuration || formatTime(totalSeconds))}</span>
          </div>

          <div className="w-[1px] h-3 bg-zinc-800" />

          {/* PATTERN INDICATOR */}
          <div className="flex items-center gap-1 text-[10.5px]">
            <span className="text-zinc-500 font-bold uppercase text-[9px]">PAT:</span>
            <span className="text-cyan-400 font-black">
              {currentPatternIndex.toString().padStart(2, '0')}
            </span>
            <span className="text-zinc-600">/</span>
            <span className="text-zinc-400">{(totalPatterns - 1).toString().padStart(2, '0')}</span>
          </div>

          <div className="w-[1px] h-3 bg-zinc-800" />

          {/* ROW INDICATOR */}
          <div className="flex items-center gap-1 text-[10.5px]">
            <span className="text-zinc-500 font-bold uppercase text-[9px]">ROW:</span>
            <span className="text-emerald-400 font-black">
              {activeRow.toString().padStart(2, '0')}
            </span>
            <span className="text-zinc-600">/</span>
            <span className="text-zinc-500">63</span>
          </div>

          <div className="w-[1px] h-3 bg-zinc-800 hidden sm:block" />

          {/* TOTAL STEP COUNT */}
          <div className="hidden sm:flex items-center gap-1 text-[9.5px] text-zinc-500">
            <span>STEP:</span>
            <span className="text-amber-400 font-bold">{currentRowGlobal + 1}</span>
            <span>of {totalRows}</span>
          </div>
        </div>

        {/* RIGHT: TIMELINE PATTERN QUICK JUMP PILLS */}
        <div className="flex items-center gap-1 overflow-x-auto max-w-[280px] custom-scrollbar py-0.5">
          {songPatterns.map((_, pIdx) => (
            <button
              key={pIdx}
              onClick={() => seekToGlobalRow(pIdx * rowsPerPattern)}
              className={`px-1.5 py-0.5 rounded text-[8.5px] font-bold border transition cursor-pointer uppercase ${
                currentPatternIndex === pIdx
                  ? 'bg-cyan-950 border-cyan-500 text-cyan-300 shadow-sm'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
              }`}
              title={`Jump to Pattern ${pIdx}`}
            >
              P{pIdx.toString().padStart(2, '0')}
            </button>
          ))}
        </div>
      </div>

      {/* ADJUSTABLE INTERACTIVE TIME BAR SCRUBBER */}
      <div className="relative">
        <div
          ref={scrubberRef}
          onMouseDown={handleScrubberMouseDown}
          onMouseMove={handleScrubberHover}
          onMouseLeave={() => setHoverInfo(null)}
          className="relative h-4 bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 rounded-md cursor-pointer overflow-hidden flex items-center group transition"
          title="Click or drag to scrub timeline and seek between patterns and rows"
        >
          {/* Pattern Block Division Lines */}
          {Array.from({ length: totalPatterns }).map((_, pIdx) => {
            const leftPct = (pIdx / totalPatterns) * 100;
            return (
              <div
                key={pIdx}
                className="absolute top-0 bottom-0 border-l border-zinc-800/80 pointer-events-none flex items-center pl-1"
                style={{ left: `${leftPct}%` }}
              >
                <span className="text-[7.5px] text-zinc-650 font-bold opacity-75 select-none">
                  P{pIdx}
                </span>
              </div>
            );
          })}

          {/* Background Beat Graticule Ticks */}
          <div className="absolute inset-0 flex justify-between pointer-events-none opacity-25">
            {Array.from({ length: Math.min(64, totalPatterns * 4) }).map((_, i) => (
              <div key={i} className="h-full w-[1px] bg-zinc-600" />
            ))}
          </div>

          {/* Filled Progress Bar */}
          <div
            className="h-full bg-gradient-to-r from-cyan-600/70 via-indigo-600/70 to-cyan-500/80 transition-all duration-75 relative pointer-events-none"
            style={{ width: `${progressRatio * 100}%` }}
          >
            {/* Subtle Neon Wave shimmer */}
            <div className="absolute inset-0 bg-white/10" />
          </div>

          {/* Scrubber Playhead Handle */}
          <div
            className="absolute top-0 bottom-0 w-2.5 bg-cyan-300 border border-cyan-100 rounded-sm shadow-[0_0_10px_rgba(6,182,212,0.9)] transform -translate-x-1/2 pointer-events-none transition-all duration-75"
            style={{ left: `${progressRatio * 100}%` }}
          >
            <div className="w-[1px] h-full bg-cyan-900 mx-auto" />
          </div>
        </div>

        {/* Hover Tooltip showing exact time, pattern, and row under mouse */}
        {hoverInfo && (
          <div
            className="absolute -top-7 transform -translate-x-1/2 bg-zinc-900 border border-cyan-500/70 text-cyan-300 text-[8.5px] font-mono px-2 py-0.5 rounded shadow-lg pointer-events-none z-30 flex items-center gap-1.5"
            style={{ left: `${hoverInfo.x}px` }}
          >
            <span>{hoverInfo.timeStr}</span>
            <span className="text-zinc-600">|</span>
            <span>Pat {hoverInfo.pattern.toString().padStart(2, '0')}</span>
            <span className="text-zinc-600">|</span>
            <span>Row {hoverInfo.row.toString().padStart(2, '0')}</span>
          </div>
        )}
      </div>

    </div>
  );
}
