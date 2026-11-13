import React, { useEffect, useRef } from 'react';
import { Sliders, X } from 'lucide-react';
import SpessaMidiMixerPanel from './SpessaMidiMixerPanel';

interface MidiControllerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSoundFont?: (presetId: string) => void;
  onChannelMuteSync?: (channelIdx0: number, isMuted: boolean) => void;
}

export default function MidiControllerModal({
  isOpen,
  onClose,
  onSelectSoundFont,
  onChannelMuteSync
}: MidiControllerModalProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-4 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-6xl bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl flex flex-col max-h-[94vh] overflow-hidden text-zinc-300">
        {/* MODAL HEADER BAR */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-zinc-900/85 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Sliders size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-black text-white tracking-wider uppercase font-mono">
                  SpessaSynth WorkletSynthesizer MIDI Controller &amp; Instrument Mixer
                </h2>
                <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-cyan-950/70 border border-cyan-800/40 text-cyan-400">
                  spessasynth_lib AudioWorklet · CH 1–48
                </span>
              </div>
              <p className="text-[10.5px] text-zinc-400 font-sans mt-0.5">
                Per-channel Bank/Program selector, controller locks, GS/XG tone &amp; envelope shaping, pedals, pitch bend RPN, and SysEx resets
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition cursor-pointer"
            aria-label="Close MIDI Controller"
          >
            <X size={18} />
          </button>
        </div>

        {/* MODAL MAIN CONTENT */}
        <div className="p-4 flex-1 overflow-y-auto custom-scrollbar">
          <SpessaMidiMixerPanel
            compact={false}
            onSelectSoundFont={onSelectSoundFont}
            onChannelMuteSync={onChannelMuteSync}
          />
        </div>

        {/* MODAL FOOTER */}
        <div className="px-5 py-2 bg-zinc-900/85 border-t border-zinc-800 flex items-center justify-between text-[10px] font-mono shrink-0">
          <span className="text-zinc-400">
            Two-way live sync active with <strong className="text-cyan-300">WorkletSynthesizer</strong> &amp; WebScope Oscilloscopes
          </span>
          <button
            type="button"
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
