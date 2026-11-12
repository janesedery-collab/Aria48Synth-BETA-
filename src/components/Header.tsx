import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, Radio, Car, ShieldAlert, Cable, Upload, Download, Sliders, History, Disc3, Share2, CheckCircle2, Minus, Plus, Cloud } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { parseChiptuneFile } from '../utils/chiptuneParsers';
import { Channel } from '../types';
import ExportStudioModal from './ExportStudioModal';
import MidiControllerModal from './MidiControllerModal';
import RecentSongsModal from './RecentSongsModal';
import ShareApkModal from './ShareApkModal';
import CloudSongsModal from './CloudSongsModal';
import { addRecentSong, RecentSong, saveSelectedSoundFont } from '../utils/recentSongsManager';
import { SpessaSynth } from '../engines/spressasynthLib';
import { parseSoundFontFile, getAvailableSoundFontInstruments } from '../utils/soundFontEngine';
import { getAudioContext } from './AudioEngine';
import { onAuthUserChanged, User } from '../utils/cloudSongsService';

interface HeaderProps {
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;
  bpm: number;
  setBpm: (bpm: number) => void;
  activeRow: number;
  driveMode: boolean;
  setDriveMode: (driveMode: boolean) => void;
  showDriveWarning: boolean;
  setShowDriveWarning: (show: boolean) => void;
  hardwareConnected: boolean;
  setHardwareConnected: (connected: boolean) => void;
  onImportSequence?: (
    patterns: any[], 
    bpm: number, 
    duration?: string, 
    title?: string, 
    chipType?: string, 
    octaveRange?: string, 
    channelsCount?: number,
    allPatterns?: any[][],
    audioBuffer?: AudioBuffer,
    channelSoundFonts?: { [channelId: number]: string },
    rawMidiBuffer?: ArrayBuffer
  ) => void;
  onLoadTrack?: (tracksJson: string, bpm: number) => void;
  trackTitle?: string | null;
  trackDuration?: string | null;
  trackChipType?: string | null;
  trackOctaveRange?: string | null;
  trackChannelsCount?: number | null;
  channels: Channel[];
  setChannels?: React.Dispatch<React.SetStateAction<Channel[]>>;
  patterns?: any[];
  songPatterns?: any[][];
  onSwitchChiptuneMode?: (mode: string) => void;
  currentChiptuneMode?: string;
}

export default function Header({
  isPlaying,
  setIsPlaying,
  bpm,
  setBpm,
  activeRow,
  driveMode,
  setDriveMode,
  showDriveWarning,
  setShowDriveWarning,
  hardwareConnected,
  setHardwareConnected,
  onImportSequence,
  trackTitle,
  trackDuration,
  trackChipType,
  trackOctaveRange,
  trackChannelsCount,
  channels,
  setChannels,
  patterns,
  songPatterns,
  onSwitchChiptuneMode,
  currentChiptuneMode
}: HeaderProps) {
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isMidiModalOpen, setIsMidiModalOpen] = useState(false);
  const [isRecentSongsOpen, setIsRecentSongsOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isCloudModalOpen, setIsCloudModalOpen] = useState(false);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [sfBannerMessage, setSfBannerMessage] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthUserChanged(setAuthUser);
    return () => unsub();
  }, []);

  // Responsive & Non-blocking BPM state
  const [bpmInputVal, setBpmInputVal] = useState(bpm.toString());
  const tapTimesRef = useRef<number[]>([]);

  useEffect(() => {
    setBpmInputVal(bpm.toString());
  }, [bpm]);

  const commitBpm = (val: string | number) => {
    const num = typeof val === 'number' ? val : parseInt(val, 10);
    if (!isNaN(num) && num > 0) {
      const clamped = Math.max(30, Math.min(320, num));
      setBpm(clamped);
      setBpmInputVal(clamped.toString());
    } else {
      setBpmInputVal(bpm.toString());
    }
  };

  const handleBpmStep = (delta: number) => {
    const next = Math.max(30, Math.min(320, bpm + delta));
    setBpm(next);
    setBpmInputVal(next.toString());
  };

  const handleTapTempo = () => {
    const now = Date.now();
    const recentTaps = tapTimesRef.current.filter(t => now - t < 3000);
    recentTaps.push(now);
    tapTimesRef.current = recentTaps;

    if (recentTaps.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < recentTaps.length; i++) {
        intervals.push(recentTaps[i] - recentTaps[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (avgInterval > 150 && avgInterval < 2000) {
        const computedBpm = Math.round(60000 / avgInterval);
        commitBpm(computedBpm);
      }
    }
  };

  const handleHeaderSoundFontUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const buffer = event.target?.result as ArrayBuffer;
        if (buffer) {
          try {
            // Load into spressasynth_lib
            const spessaSf = SpessaSynth.loadSoundFont(buffer, file.name);
            saveSelectedSoundFont(spessaSf.id);
            
            // Also parse into WebAudio Sampler for custom instruments
            const ctx = getAudioContext();
            if (ctx) {
              await parseSoundFontFile(buffer, file.name, ctx);
            }
            
            // Put the SoundFont's instruments into the song channels
            if (setChannels && channels) {
              const sfInstruments = getAvailableSoundFontInstruments();
              if (sfInstruments.length > 0) {
                setChannels(prev => prev.map((ch, idx) => {
                  const inst = sfInstruments[idx % sfInstruments.length];
                  return {
                    ...ch,
                    chip: 'General MIDI (SoundFont)',
                    soundFontPreset: inst ? inst.id : ch.soundFontPreset
                  };
                }));
              }
            }

            setSfBannerMessage(`SoundFont "${spessaSf.name}" (${spessaSf.instrumentCount} Presets) decoded by spressasynth_core-master.zip into spressasynth_lib and assigned to song channels!`);
            setTimeout(() => setSfBannerMessage(null), 4500);
          } catch (err: any) {
            setSfBannerMessage(`SoundFont error: ${err.message}`);
            setTimeout(() => setSfBannerMessage(null), 4500);
          }
        }
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const activeChipsCount = React.useMemo(() => {
    if (!channels) return 1;
    const assignedChips = channels.filter(c => c.enabled).map(c => c.chip);
    const uniqueChips = new Set(assignedChips);
    return uniqueChips.size || 1;
  }, [channels]);

  const formatTime = (row: number, bpmVal: number) => {
    const secondsPerRow = 60 / bpmVal / 4;
    const elapsedSecs = row * secondsPerRow;
    const mins = Math.floor(elapsedSecs / 60);
    const secs = Math.floor(elapsedSecs % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSelectRecentSong = (song: RecentSong) => {
    onImportSequence?.(
      song.patterns,
      song.bpm,
      song.duration,
      song.title,
      song.chipType,
      song.octaveRange,
      song.channelsCount,
      song.allPatterns,
      undefined,
      song.channelSoundFonts
    );
    setIsPlaying(true);
  };

  return (
    <>
      {/* DRIVE MODE SAFETY WARNING MODAL */}
      <AnimatePresence>
        {driveMode && showDriveWarning && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4 backdrop-blur-md"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-red-950 border-2 border-red-500 rounded-xl p-6 max-w-md text-center shadow-[0_0_50px_rgba(239,68,68,0.3)] font-mono"
            >
              <ShieldAlert className="w-16 h-16 text-red-500 mx-auto mb-4 animate-bounce" />
              <h2 className="text-xl font-bold text-white mb-2 tracking-wider">CRITICAL ROAD SAFETY</h2>
              <p className="text-red-200 mb-6 text-xs leading-relaxed text-left">
                You have activated Drive Mode (Android Auto/CarPlay Standard). 
                While driving, manual editing tools (Pattern Editor, Routing, and Converters) are restricted. 
                Use the Simplified Mixer for tactile controls.
              </p>
              <button 
                onClick={() => setShowDriveWarning(false)}
                className="w-full bg-red-600 hover:bg-red-500 active:bg-red-700 text-white py-2 px-6 rounded font-bold transition-all text-xs tracking-widest border border-red-400"
              >
                DISMISS & CONCENTRATE ON THE ROAD
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <header className="border-b border-zinc-800 bg-black/45 p-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Radio className="text-cyan-400 w-6 h-6 animate-pulse" />
            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
            </span>
          </div>
          <div>
            <h1 className="text-sm font-black uppercase tracking-widest bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-400">
              Aria48 Tracker
            </h1>
            <p className="text-[9px] text-zinc-500 font-sans tracking-wide">Universal Chiptune, MIDI & SoundFont Workstation</p>
          </div>
          
          <div className="hidden sm:flex gap-1.5 ml-3">
            <span className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-[8.5px] font-mono text-cyan-400 rounded">
              spressasynth_lib (MIDI)
            </span>
            <span className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-[8.5px] font-mono text-emerald-400 rounded">
              Chiptune-3 (MOD/XM)
            </span>
            <span className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-[8.5px] font-mono text-amber-400 rounded">
              webscope (16 Scopes)
            </span>
          </div>
        </div>

        {/* TRANSPORT CONTROLS */}
        <div className="flex items-center gap-4 bg-zinc-950 p-1 rounded-lg border border-zinc-800 shadow-inner">
          <button 
            id="play-stop-btn"
            onClick={() => setIsPlaying(!isPlaying)} 
            className={`p-2 rounded transition-all cursor-pointer ${isPlaying ? 'bg-cyan-600 text-white shadow-[0_0_10px_rgba(8,145,178,0.4)]' : 'hover:bg-zinc-800 text-cyan-400'}`}
          >
            {isPlaying ? <Square size={14} /> : <Play size={14} fill="currentColor" />}
          </button>
          
          {/* TACTILE & RESPONSIVE BPM CONTROLS */}
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-black/60 border border-zinc-800 rounded-lg">
            <span className="text-zinc-500 text-[9.5px] uppercase font-bold tracking-wider mr-0.5">BPM</span>

            {/* Decrement Button */}
            <button
              id="bpm-decrement-btn"
              type="button"
              onClick={(e) => handleBpmStep(e.shiftKey ? -5 : -1)}
              className="w-5 h-5 flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-cyan-400 rounded border border-zinc-800 active:scale-95 transition cursor-pointer"
              title="Decrease BPM (-1, Shift+Click: -5)"
            >
              <Minus size={11} />
            </button>

            {/* Direct Number Input */}
            <input 
              id="bpm-input"
              type="text" 
              inputMode="numeric"
              pattern="[0-9]*"
              value={bpmInputVal} 
              onChange={(e) => {
                const text = e.target.value.replace(/[^0-9]/g, '');
                setBpmInputVal(text);
                if (text.length >= 2) {
                  const n = parseInt(text, 10);
                  if (n >= 30 && n <= 320) {
                    setBpm(n);
                  }
                }
              }}
              onBlur={() => commitBpm(bpmInputVal)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitBpm(bpmInputVal);
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  handleBpmStep(e.shiftKey ? 5 : 1);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  handleBpmStep(e.shiftKey ? -5 : -1);
                }
              }}
              onWheel={(e) => {
                e.preventDefault();
                handleBpmStep(e.deltaY < 0 ? 1 : -1);
              }}
              className="w-12 bg-black border border-zinc-800 focus:border-cyan-500 rounded px-1 py-0.5 text-center text-cyan-300 font-mono text-[11px] font-bold focus:outline-none select-all"
              title="Click & type, use arrow keys, or scroll mouse wheel to adjust BPM"
            />

            {/* Increment Button */}
            <button
              id="bpm-increment-btn"
              type="button"
              onClick={(e) => handleBpmStep(e.shiftKey ? 5 : 1)}
              className="w-5 h-5 flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-cyan-400 rounded border border-zinc-800 active:scale-95 transition cursor-pointer"
              title="Increase BPM (+1, Shift+Click: +5)"
            >
              <Plus size={11} />
            </button>

            {/* Tap Tempo Button */}
            <button
              id="bpm-tap-btn"
              type="button"
              onClick={handleTapTempo}
              className="px-1.5 py-0.5 bg-zinc-900 hover:bg-cyan-950/40 text-zinc-400 hover:text-cyan-300 border border-zinc-800 rounded text-[8.5px] uppercase font-bold tracking-wider transition cursor-pointer active:scale-95 ml-0.5"
              title="Tap tempo rhythmically to set BPM"
            >
              TAP
            </button>
          </div>

          {/* DYNAMIC PLAYER IMPORT TRIGGER */}
          <div className="px-3 border-l border-zinc-800 flex items-center">
             <button
               id="player-import-btn"
               onClick={() => {
                 const fileInput = document.getElementById('player-tracker-file-file-btn');
                 if (fileInput) fileInput.click();
               }}
               className="p-1 px-2.5 bg-zinc-900 border border-zinc-800 hover:border-cyan-500/50 text-cyan-400 hover:text-white hover:bg-cyan-950/30 rounded font-bold text-[9.5px] uppercase tracking-wider transition cursor-pointer flex items-center gap-1.5"
               title="Import tracking sequence directly to player matrix (.mid, .mod, .xm, .sid, .nsf, .sf2)"
             >
               <Upload size={11} className="text-cyan-400" />
               <span>Import Song</span>
             </button>

             {/* SEPARATE BUTTON TO ADD SOUNDFONTS INTO SPRESSASYNTH */}
             <button
               id="header-soundfont-btn"
               onClick={() => {
                 const sfInput = document.getElementById('header-soundfont-file-input');
                 if (sfInput) sfInput.click();
               }}
               className="p-1 px-2.5 bg-emerald-950/40 border border-emerald-600/50 hover:border-emerald-400 text-emerald-300 hover:text-white hover:bg-emerald-900/50 rounded font-bold text-[9.5px] uppercase tracking-wider transition cursor-pointer flex items-center gap-1.5 ml-2"
               title="Add SoundFont (.sf2, .sf3, .dls) directly into spressasynth_lib-master.zip"
             >
               <Disc3 size={11} className="text-emerald-400 animate-pulse" />
               <span>+ SoundFont</span>
             </button>
             <input
               id="header-soundfont-file-input"
               type="file"
               className="hidden"
               accept=".sf2,.sf3,.dls"
               onChange={handleHeaderSoundFontUpload}
             />

             <input 
               id="player-tracker-file-file-btn"
               type="file" 
               className="hidden"
               accept=".mid,.midi,.mod,.xm,.s3m,.it,.sid,.nsf,.gbs,.vgm,.spc,.ftm,.sf2,.sf3,.wav,.mp3,.json"
               onChange={(e) => {
                 const file = e.target.files?.[0];
                 if (file) {
                   const reader = new FileReader();
                   reader.onload = (event) => {
                     const buffer = event.target?.result as ArrayBuffer;
                     if (buffer) {
                       try {
                         const result = parseChiptuneFile(file.name, buffer);
                         onImportSequence?.(
                           result.patterns, 
                           result.bpm, 
                           result.duration, 
                           result.title, 
                           result.chipType, 
                           result.octaveRange, 
                           result.channelsCount,
                           result.allPatterns,
                           result.audioBuffer,
                           result.channelSoundFonts,
                           result.rawMidiBuffer
                         );
                         setIsPlaying(true);
                         addRecentSong({
                           title: result.title,
                           chipType: result.chipType,
                           duration: result.duration,
                           bpm: result.bpm,
                           channelsCount: result.channelsCount,
                           octaveRange: result.octaveRange,
                           patterns: result.patterns,
                           allPatterns: result.allPatterns,
                           channelSoundFonts: result.channelSoundFonts
                         });
                         console.log(`[SUCCESS] Imported tracker track: '${result.title}' (${result.chipType})`);
                       } catch (err: any) {
                         console.log("Failed parsing tracker sequence: " + err.message);
                       }
                     }
                   };
                   reader.readAsArrayBuffer(file);
                 }
               }}
             />
          </div>

          {/* RETRO LCD DASHBOARD MODULE */}
          <div className="px-3 py-1 bg-black/60 border border-zinc-900 rounded-lg flex items-center gap-3 font-mono text-[10px] shadow-inner text-cyan-400">
            <div className="flex items-center gap-1.5 shrink-0">
              <Radio size={11} className={isPlaying ? 'animate-spin text-green-400' : 'text-zinc-650'} />
              <span className="text-zinc-650 mr-1 uppercase font-bold text-[8.5px]">STATUS:</span>
              <span className={`px-1 rounded text-[8.5px] font-bold select-none ${isPlaying ? 'bg-green-950/40 text-green-400' : 'bg-zinc-950 text-zinc-500'}`}>
                {isPlaying ? 'PLAY' : 'IDLE'}
              </span>
            </div>
            
            <div className="h-3 w-[1px] bg-zinc-850 hidden md:block"></div>

            <div className="hidden md:flex flex-col text-left min-w-[110px] max-w-[140px]">
              <span className="text-zinc-600 text-[8px] uppercase font-bold leading-none mb-0.5">TRACK</span>
              <span className="text-zinc-200 font-medium truncate" title={trackTitle || "Default Session"}>
                {trackTitle || "Default Session"}
              </span>
            </div>

            <div className="h-3 w-[1px] bg-zinc-850 hidden sm:block"></div>

            <div className="hidden sm:flex flex-col text-left min-w-[80px]">
               <span className="text-zinc-600 text-[8px] uppercase font-bold leading-none mb-0.5">ENGINE</span>
               <span className="text-cyan-400 font-medium truncate">
                 {trackChipType || "Stereo Mix"}
               </span>
            </div>

            <div className="h-3 w-[1px] bg-zinc-850"></div>

            <div className="flex flex-col text-left">
              <span className="text-zinc-600 text-[8px] uppercase font-bold leading-none mb-0.5">LENGTH</span>
              <span className="text-indigo-400 font-black tracking-wider">
                {trackDuration || "0:07"}
              </span>
            </div>

            <div className="h-3 w-[1px] bg-zinc-850 hidden md:block"></div>

            <div className="hidden md:flex flex-col text-left">
              <span className="text-zinc-600 text-[8px] uppercase font-bold leading-none mb-0.5">OCTAVES</span>
              <span className="text-pink-400 font-bold tracking-wider">
                {trackOctaveRange || "C2 - G6"}
              </span>
            </div>

            <div className="h-3 w-[1px] bg-zinc-850 hidden sm:block"></div>

            <div className="hidden sm:flex flex-col text-left">
              <span className="text-zinc-600 text-[8px] uppercase font-bold leading-none mb-0.5">CHANNELS</span>
              <span className="text-emerald-400 font-bold tracking-wider">
                {trackChannelsCount ? `${trackChannelsCount} CH` : "8 CH"}
              </span>
            </div>

            <div className="h-3 w-[1px] bg-zinc-850 hidden lg:block"></div>

            <div className="hidden lg:flex flex-col text-left">
              <span className="text-zinc-600 text-[8px] uppercase font-bold leading-none mb-0.5">SILICON CHIPS</span>
              <span className="text-amber-500 font-bold tracking-wider font-mono">
                {activeChipsCount} ACTIVE
              </span>
            </div>

            <div className="h-3 w-[1px] bg-zinc-850"></div>

            <div className="flex flex-col text-left">
              <span className="text-zinc-600 text-[8px] uppercase font-bold leading-none mb-0.5">TEMPO</span>
              <span className="text-teal-400 font-black tracking-wider flex items-baseline gap-0.5">
                {bpm} <span className="text-[7px] text-zinc-600">BPM</span>
              </span>
            </div>

            <div className="h-3 w-[1px] bg-zinc-850"></div>

            <div className="flex flex-col text-left">
              <span className="text-zinc-600 text-[8px] uppercase font-bold leading-none mb-0.5">TIME / ROW</span>
              <span className="text-amber-400 font-black tracking-wider">
                {formatTime(activeRow, bpm)} <span className="text-zinc-700">/</span> ROW {activeRow.toString().padStart(2, '0')}
              </span>
            </div>
          </div>
        </div>

        {/* CONTROLS */}
        <div className="flex items-center gap-2">
          {/* GOOGLE SIGN IN & CLOUD LIBRARY */}
          <button
            id="cloud-songs-header-btn"
            onClick={() => setIsCloudModalOpen(true)}
            className="p-1.5 px-2.5 rounded-lg border border-indigo-700/60 bg-indigo-950/50 hover:bg-indigo-900/60 text-indigo-200 font-bold transition-all text-[10px] uppercase cursor-pointer flex items-center gap-1.5 shadow-[0_0_12px_rgba(99,102,241,0.25)]"
            title="Google Sign-In: Export and Import Songs from Google Cloud"
          >
            {authUser ? (
              <>
                {authUser.photoURL ? (
                  <img src={authUser.photoURL} alt="" className="w-3.5 h-3.5 rounded-full object-cover border border-indigo-400" />
                ) : (
                  <Cloud size={12} className="text-indigo-400" />
                )}
                <span className="truncate max-w-[90px]">{authUser.displayName?.split(' ')[0] || 'Cloud Library'}</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                <span>Cloud Songs</span>
              </>
            )}
          </button>

          {/* RECENT / LAST PLAYED SONGS */}
          <button
            id="recent-songs-header-btn"
            onClick={() => setIsRecentSongsOpen(true)}
            className="p-1.5 px-2.5 rounded-lg border border-zinc-800 bg-zinc-900/80 hover:bg-zinc-800 hover:border-cyan-500/50 text-zinc-300 hover:text-white font-bold transition-all text-[10px] uppercase cursor-pointer flex items-center gap-1.5 shadow-sm"
            title="View last played songs and load previous tracks"
          >
            <History size={12} className="text-cyan-400" />
            <span>Recent Songs</span>
          </button>

          {/* SPESSASYNTH MIDI CONTROLLER */}
          <button
            id="midi-controller-header-btn"
            onClick={() => setIsMidiModalOpen(true)}
            className="p-1.5 px-2.5 rounded-lg border border-indigo-800/60 bg-indigo-950/45 hover:bg-indigo-900/60 text-indigo-300 font-bold transition-all text-[10px] uppercase cursor-pointer flex items-center gap-1.5 shadow-[0_0_12px_rgba(99,102,241,0.2)]"
            title="SpessaSynth MIDI Controller: 16 Channels, GM/GS/XG Resets, and SoundFont Audition"
          >
            <Sliders size={12} className="text-indigo-400" />
            <span>MIDI Controller</span>
          </button>

          {/* EXPORT STUDIO (CHIPTUNES, VIDEOS, SOUNDFONTS) */}
          <button 
            id="export-studio-header-btn"
            onClick={() => setIsExportModalOpen(true)}
            className="p-1.5 px-3 rounded-lg border border-cyan-800/60 bg-cyan-950/45 hover:bg-cyan-900/60 text-cyan-300 font-bold transition-all text-[10px] uppercase cursor-pointer flex items-center gap-1.5 shadow-[0_0_12px_rgba(34,211,238,0.15)]"
            title="Export Studio: Chiptunes (.mod, .xm, .mid), Video Recordings, and SoundFonts (.sf2, .sf3)"
          >
            <Download size={13} className="text-cyan-400" />
            <span>Export Studio</span>
          </button>

          {/* SHARE & ANDROID APK BUTTON */}
          <button 
            id="share-apk-header-btn"
            onClick={() => setIsShareModalOpen(true)}
            className="p-1.5 px-2.5 rounded-lg border border-emerald-800/60 bg-emerald-950/45 hover:bg-emerald-900/60 text-emerald-300 font-bold transition-all text-[10px] uppercase cursor-pointer flex items-center gap-1.5 shadow-[0_0_12px_rgba(16,185,129,0.2)]"
            title="Download Android APK (.apk) or Share Workstation"
          >
            <Share2 size={12} className="text-emerald-400" />
            <span>APK / Share</span>
          </button>

          <button 
            id="drive-mode-btn"
            onClick={() => {
              setDriveMode(!driveMode);
              setShowDriveWarning(true);
            }}
            className={`p-2 py-1 px-3 rounded flex items-center gap-1.5 border transition-all text-[10px] uppercase cursor-pointer ${
              driveMode 
                ? 'bg-red-950 border-red-500 text-red-200 animate-pulse font-bold' 
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800'
            }`}
            title="Toggle Driving Mode"
          >
            <Car size={13} className={driveMode ? 'text-red-400 animate-bounce' : ''} />
            <span>{driveMode ? 'Drive Connected' : 'Drive Safe'}</span>
          </button>

          {/* WebUSB ARIA48 CORE STATUS BUTTON */}
          <button
            id="usb-hardware-pill"
            onClick={() => setHardwareConnected(!hardwareConnected)}
            className={`p-1.5 px-3 rounded-lg border transition-all text-[10px] uppercase font-bold flex items-center gap-2 cursor-pointer shadow-sm ${
              hardwareConnected 
                ? 'bg-amber-950/45 border-amber-500/80 text-amber-300 shadow-[0_0_15px_rgba(245,158,11,0.25)]' 
                : 'bg-zinc-900/90 border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
            }`}
            title={hardwareConnected ? 'Aria48 Core Linked (Click to Simulator Disconnect)' : 'WebUSB Offline (Click to Simulate Connection)'}
          >
            <Cable size={13} className={hardwareConnected ? 'text-amber-400 animate-bounce' : 'text-zinc-600'} />
            <span className="tracking-wide">
              {hardwareConnected ? 'ARIA48 CORE: LINKED' : 'A48 HARDWARE: SEARCHING'}
            </span>
            <span className="flex h-2 w-2 relative">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${hardwareConnected ? 'bg-amber-400' : 'bg-red-400/50'}`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${hardwareConnected ? 'bg-amber-500' : 'bg-red-500'}`}></span>
            </span>
          </button>
        </div>
      </header>

      {/* SOUNDFONT UPLOAD CONFIRMATION BANNER */}
      <AnimatePresence>
        {sfBannerMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-14 left-1/2 transform -translate-x-1/2 z-50 bg-emerald-950 border border-emerald-500 text-emerald-200 px-4 py-2 rounded-xl text-xs font-mono shadow-[0_0_25px_rgba(16,185,129,0.4)] flex items-center gap-2 pointer-events-none"
          >
            <CheckCircle2 size={16} className="text-emerald-400 animate-bounce" />
            <span>{sfBannerMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* RECENT SONGS MODAL */}
      <RecentSongsModal
        isOpen={isRecentSongsOpen}
        onClose={() => setIsRecentSongsOpen(false)}
        onSelectSong={handleSelectRecentSong}
      />

      {/* SPESSASYNTH MIDI CONTROLLER MODAL */}
      <MidiControllerModal
        isOpen={isMidiModalOpen}
        onClose={() => setIsMidiModalOpen(false)}
      />

      {/* EXPORT STUDIO MODAL */}
      <ExportStudioModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        songPatterns={songPatterns || []}
        channels={channels}
        bpm={bpm}
        trackTitle={trackTitle}
        onSwitchChiptuneMode={onSwitchChiptuneMode}
        currentMode={currentChiptuneMode || 'mod'}
        isPlaying={isPlaying}
        onTriggerPlay={() => setIsPlaying(true)}
        onOpenCloudModal={() => {
          setIsExportModalOpen(false);
          setIsCloudModalOpen(true);
        }}
      />

      {/* ANDROID APK & SHARE MODAL */}
      <ShareApkModal
        isOpen={isShareModalOpen}
        onClose={() => setIsShareModalOpen(false)}
        trackTitle={trackTitle}
      />

      {/* GOOGLE CLOUD SONGS MODAL */}
      <CloudSongsModal
        isOpen={isCloudModalOpen}
        onClose={() => setIsCloudModalOpen(false)}
        patterns={patterns || []}
        allPatterns={songPatterns}
        channels={channels}
        bpm={bpm}
        trackTitle={trackTitle}
        trackDuration={trackDuration}
        trackChipType={trackChipType}
        onImportSong={(p, b, d, t, c, o, cc, ap, ab, cs) => {
          onImportSequence?.(p, b, d, t, c, o, cc, ap, ab, cs);
          setIsPlaying(true);
        }}
      />
    </>
  );
}
