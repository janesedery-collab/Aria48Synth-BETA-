import React, { useState, useEffect } from 'react';
import { History, Play, Trash2, X, Music, Clock, Layers, Sparkles } from 'lucide-react';
import { RecentSong, getRecentSongs, clearRecentSongs } from '../utils/recentSongsManager';

interface RecentSongsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSong: (song: RecentSong) => void;
}

export default function RecentSongsModal({
  isOpen,
  onClose,
  onSelectSong
}: RecentSongsModalProps) {
  const [songs, setSongs] = useState<RecentSong[]>([]);

  useEffect(() => {
    if (isOpen) {
      setSongs(getRecentSongs());
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleClear = () => {
    clearRecentSongs();
    setSongs([]);
  };

  const formatTimeAgo = (timestamp: number) => {
    const elapsed = Math.floor((Date.now() - timestamp) / 1000);
    if (elapsed < 60) return "Just now";
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
    return `${Math.floor(elapsed / 86400)}d ago`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-2xl bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden text-zinc-300">
        
        {/* HEADER BAR */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/80">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <History size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-wider uppercase font-mono">
                Last Played Songs
              </h2>
              <p className="text-[10px] text-zinc-500 font-sans">
                Recently imported tracks, MIDI files, and chiptune sequences
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

        {/* LIST CONTAINER */}
        <div className="p-4 flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-2.5">
          {songs.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-center text-zinc-600">
              <Music size={36} className="text-zinc-700" />
              <p className="text-xs font-mono">No recently played songs yet.</p>
              <p className="text-[10.5px] text-zinc-600 max-w-xs font-sans">
                Import any Standard MIDI (.mid), ProTracker (.mod), or chiptune module to populate this list.
              </p>
            </div>
          ) : (
            songs.map((song) => (
              <div
                key={song.id}
                className="p-3 bg-zinc-900/40 hover:bg-zinc-900/80 border border-zinc-800/80 hover:border-cyan-500/40 rounded-xl transition flex items-center justify-between gap-3 group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2.5 rounded-lg bg-black border border-zinc-800 text-cyan-400 group-hover:text-cyan-300 group-hover:border-cyan-500/40 shrink-0">
                    <Music size={16} />
                  </div>

                  <div className="min-w-0 flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white truncate max-w-md" title={song.title}>
                        {song.title}
                      </span>
                      <span className="text-[8.5px] font-mono px-1.5 py-0.2 rounded bg-zinc-800 border border-zinc-700 text-cyan-400 shrink-0">
                        {song.chipType}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
                      <span className="flex items-center gap-1">
                        <Clock size={10} className="text-zinc-600" />
                        {song.duration}
                      </span>
                      <span>&bull;</span>
                      <span>{song.bpm} BPM</span>
                      <span>&bull;</span>
                      <span className="flex items-center gap-1">
                        <Layers size={10} className="text-zinc-600" />
                        {song.channelsCount} Channels
                      </span>
                      <span>&bull;</span>
                      <span className="text-zinc-600 font-sans">{formatTimeAgo(song.playedAt)}</span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => {
                    onSelectSong(song);
                    onClose();
                  }}
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition cursor-pointer flex items-center gap-1.5 shrink-0 shadow-sm"
                >
                  <Play size={12} fill="currentColor" />
                  <span>Play</span>
                </button>
              </div>
            ))
          )}
        </div>

        {/* FOOTER */}
        <div className="px-5 py-3 bg-zinc-900/80 border-t border-zinc-800 flex items-center justify-between text-xs font-mono">
          <span className="text-[10px] text-zinc-500">
            {songs.length} song{songs.length === 1 ? '' : 's'} in history
          </span>

          <div className="flex items-center gap-2">
            {songs.length > 0 && (
              <button
                onClick={handleClear}
                className="px-3 py-1.5 bg-red-950/30 hover:bg-red-900/50 text-red-400 hover:text-red-200 border border-red-800/40 rounded-lg text-[10.5px] font-bold uppercase tracking-wider transition cursor-pointer flex items-center gap-1.5"
              >
                <Trash2 size={12} />
                <span>Clear History</span>
              </button>
            )}

            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg font-bold text-[10.5px] uppercase tracking-wider transition cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
