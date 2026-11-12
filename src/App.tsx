import React, { useState, useEffect } from 'react';
import { 
  Play, Square, Settings, Cpu, AlertTriangle, 
  Download, Upload, Music, Radio, Monitor, Cable, Activity,
  Save, FileAudio, Car, Share2
} from 'lucide-react';

import { Channel, MAX_CHANNELS, OscilloscopeConfig } from './types';
import { INITIAL_PATTERNS } from './initialPatterns';
import Header from './components/Header';
import TimeBar from './components/TimeBar';
import TrackerEditor from './components/TrackerEditor';
import ChipConfigurator from './components/ChipConfigurator';
import MixerEQ from './components/MixerEQ';
import FileConverterUI from './components/FileConverterUI';
import HardwareConnectionScript from './components/HardwareConnectionScript';
import ShareApkModal from './components/ShareApkModal';
import { 
  playNote, 
  stopChannelSound,
  playDirectAudio, 
  stopDirectAudio, 
  playMidiBuffer, 
  stopMidiPlayback,
  stopAllChannelsSound,
  getAudioContext,
  setAudioPlaybackRate,
  getTinySynth
} from './components/AudioEngine';
import { getSavedSelectedSoundFont } from './utils/recentSongsManager';
import { getSavedAmplifier, saveAmplifier, getSavedOscConfig, saveOscConfig } from './utils/cookieStorage';

// --- MAIN APPLICATION ---
export default function App() {
  const [activeTab, setActiveTab] = useState('tracker');
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(125);
  const [baseSongBpm, setBaseSongBpm] = useState<number>(125);
  const [activeRow, setActiveRow] = useState(0);
  const [isShareApkOpen, setIsShareApkOpen] = useState(false);

  // WebUSB / Physical Chip connection state
  const [hardwareConnected, setHardwareConnected] = useState(false);
  
  // Real-time pitch tracking per channel
  const [channelPitches, setChannelPitches] = useState<{ [key: number]: string }>({});

  // Customizable Oscilloscope preferences (persisted in browser cookies)
  const [oscConfig, setOscConfig] = useState<OscilloscopeConfig>(() => {
    const savedAmp = getSavedAmplifier();
    const savedConfig = getSavedOscConfig();
    return {
      preset: 'protracker',
      drawType: 'solid',
      scanlines: true,
      glowBloom: true,
      gridDividers: true,
      noiseFloor: 2,
      size: 'medium',
      phaseSync: true,
      ...savedConfig,
      amplifier: savedAmp
    };
  });

  const handleSetOscConfig = (updater: React.SetStateAction<OscilloscopeConfig>) => {
    setOscConfig(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (next.amplifier !== undefined) {
        saveAmplifier(next.amplifier);
      }
      saveOscConfig(next);
      return next;
    });
  };

  // Channels State (1-48)
  const [channels, setChannels] = useState<Channel[]>(
    Array.from({ length: MAX_CHANNELS }, (_, i) => ({
      id: i + 1,
      enabled: i < 8, // Enable first 8 by default
      chip: i === 5 ? 'Virtual DAC' : i === 2 ? 'MOS6581 (C64 SID)' : i % 2 === 0 ? 'YMF262 (OPL3 FM)' : 'YM2612 (Sega FM)',
      volume: 80,
      pan: 50,
      freqLow: 0,
      freqMid: 0,
      freqHigh: 0,
      mute: false,
      solo: false,
      soundFontPreset: i === 0 ? 'gm_piano' : i === 1 ? 'gm_epiano' : i === 2 ? 'gm_strings' : undefined
    }))
  );

  const [patterns, setPatterns] = useState<any[]>(INITIAL_PATTERNS);
  const [songPatterns, setSongPatterns] = useState<any[][]>([INITIAL_PATTERNS]);
  const [currentPatternIndex, setCurrentPatternIndex] = useState<number>(0);
  const [playMode, setPlayMode] = useState<'song' | 'pattern'>('song');
  const [loadedAudioBuffer, setLoadedAudioBuffer] = useState<AudioBuffer | null>(null);
  const [loadedMidiBuffer, setLoadedMidiBuffer] = useState<ArrayBuffer | null>(null);

  // Loaded Track Metadata for exact duration and song length tracking
  const [trackTitle, setTrackTitle] = useState<string | null>(null);
  const [trackDuration, setTrackDuration] = useState<string | null>(null);
  const [trackChipType, setTrackChipType] = useState<string | null>(null);
  const [trackOctaveRange, setTrackOctaveRange] = useState<string | null>(null);
  const [trackChannelsCount, setTrackChannelsCount] = useState<number | null>(null);
  const [chiptuneMode, setChiptuneMode] = useState<string>('mod');

  // Switch chiptune mode and format profiles
  const handleSwitchChiptuneMode = (mode: string) => {
    setChiptuneMode(mode);
    if (mode === 'mod') {
      setChannels(prev => prev.map((ch, idx) => ({
        ...ch,
        enabled: idx < 4,
        chip: 'PAULA (Amiga PCM)',
        soundFontPreset: 'mod_inst_01'
      })));
    } else if (mode === 'xm') {
      setChannels(prev => prev.map((ch, idx) => ({
        ...ch,
        enabled: idx < 8,
        chip: 'YM2612 (Sega FM)',
        soundFontPreset: undefined
      })));
    } else if (mode === 's3m') {
      setChannels(prev => prev.map((ch, idx) => ({
        ...ch,
        enabled: idx < 16,
        chip: idx < 8 ? 'PAULA (Amiga PCM)' : 'YMF262 (OPL3 FM)',
        soundFontPreset: undefined
      })));
    } else if (mode === 'mid') {
      setChannels(prev => prev.map((ch, idx) => ({
        ...ch,
        enabled: idx < 16,
        chip: 'General MIDI (SoundFont)',
        soundFontPreset: idx === 9 ? 'gm_drums' : idx === 0 ? 'gm_piano' : idx === 1 ? 'gm_epiano' : 'gm_strings'
      })));
    }
  };

  // WebUSB Auto-Detection
  useEffect(() => {
    try {
      const nav = navigator as any;
      if (typeof navigator !== 'undefined' && 'usb' in navigator && nav.usb) {
        nav.usb.getDevices().then((devices: any[]) => {
          if (devices.length > 0) {
            setHardwareConnected(true);
          }
        }).catch((err: any) => {
          if (err?.name !== 'SecurityError') {
            console.log('WebUSB pairing query bypassed:', err);
          }
        });

        const onConnect = () => setHardwareConnected(true);
        const onDisconnect = () => {
          nav.usb.getDevices().then((devices: any[]) => {
            if (devices.length === 0) setHardwareConnected(false);
          }).catch(() => setHardwareConnected(false));
        };

        nav.usb.addEventListener('connect', onConnect);
        nav.usb.addEventListener('disconnect', onDisconnect);
        return () => {
          try {
            nav.usb.removeEventListener('connect', onConnect);
            nav.usb.removeEventListener('disconnect', onDisconnect);
          } catch(e) {}
        };
      }
    } catch (e: any) {
      console.log("WebUSB policy blocked, skipping detection");
    }
  }, []);

  // Restore saved soundfont preference on initial load
  useEffect(() => {
    const savedSf = getSavedSelectedSoundFont();
    if (savedSf && savedSf !== 'gm_piano') {
      setChannels(prev => prev.map((ch, idx) => {
        if (ch.chip.includes('SoundFont') || ch.chip.includes('MIDI')) {
          return {
            ...ch,
            soundFontPreset: idx === 9 ? 'gm_drums' : savedSf
          };
        }
        return ch;
      }));
    }
  }, []);

  // Auto-routing when hardware status updates to active
  useEffect(() => {
    if (hardwareConnected) {
      setChannels(prev => prev.map(ch => {
        if (ch.id === 7 || ch.id === 8) {
          return { ...ch, enabled: true, chip: 'Physical Chip (USB)' };
        }
        return ch;
      }));
    } else {
      setChannels(prev => prev.map(ch => {
        if (ch.chip === 'Physical Chip (USB)') {
          return { ...ch, chip: ch.id === 7 ? 'YM2612 (Sega)' : 'Virtual DAC' };
        }
        return ch;
      }));
    }
  }, [hardwareConnected]);

  // Safety State (Android Auto / CarPlay Standard)
  const [driveMode, setDriveMode] = useState(false);
  const [showDriveWarning, setShowDriveWarning] = useState(true);

  // Synchronous Tracker Sequence & Audio Playback Loop
  // Replaces the chaotic synthetic oscillator beeps with authentic playback:
  // - WebAudioTinySynth for General MIDI
  // - Amiga ProTracker PCM AudioBuffer for MOD chiptunes
  // - Direct decoded AudioBuffer for WAV / MP3
  // Audio Playback Lifecycle (only triggers on play/pause or buffer swap)
  useEffect(() => {
    if (isPlaying) {
      if (loadedMidiBuffer) {
        playMidiBuffer(loadedMidiBuffer, () => {
          setIsPlaying(false);
        });
      } else if (loadedAudioBuffer) {
        playDirectAudio(loadedAudioBuffer, 0, () => {
          setIsPlaying(false);
        });
        const rate = bpm / (baseSongBpm || 125);
        setAudioPlaybackRate(rate);
      }
    } else {
      stopDirectAudio();
      stopMidiPlayback();
      stopAllChannelsSound();
      setActiveRow(0);
    }
  }, [isPlaying, loadedAudioBuffer, loadedMidiBuffer]);

  // Dynamic Audio Playback Rate / Tempo Scaling on BPM changes (does NOT restart the song!)
  useEffect(() => {
    if (isPlaying && loadedAudioBuffer) {
      const rate = bpm / (baseSongBpm || 125);
      setAudioPlaybackRate(rate);
    }
    const synth = getTinySynth();
    if (synth && synth.setBpm) {
      synth.setBpm(bpm);
    }
  }, [bpm, baseSongBpm, isPlaying, loadedAudioBuffer]);

  // Synchronous Visual Tracker Row Advance synchronized to BPM
  useEffect(() => {
    if (!isPlaying) return;

    const msPerRow = Math.max(15, (60 / Math.max(30, bpm) / 4) * 1000);
    const timer = setInterval(() => {
      setActiveRow((prevRow) => {
        if (prevRow >= 63) {
          if (playMode === 'song') {
            setCurrentPatternIndex((prevIdx) => (prevIdx + 1) % Math.max(1, songPatterns.length));
          }
          return 0;
        }
        return prevRow + 1;
      });
    }, msPerRow);

    return () => {
      clearInterval(timer);
    };
  }, [isPlaying, bpm, playMode, songPatterns.length]);

  // Real-time Note Triggering for pattern sequencer when no pre-rendered audio buffer is used
  useEffect(() => {
    if (isPlaying && !loadedAudioBuffer && !loadedMidiBuffer) {
      const activePat = (songPatterns && songPatterns[currentPatternIndex]) || patterns;
      const rowData = activePat?.[activeRow];
      if (rowData) {
        const stepSec = Math.max(0.05, 60 / Math.max(30, bpm) / 4);
        for (let chId = 1; chId <= MAX_CHANNELS; chId++) {
          const cell = rowData[chId];
          const ch = channels.find(c => c.id === chId);
          if (ch && ch.enabled && !ch.mute && cell && cell.note && cell.note !== '---') {
            if (cell.note === '===' || cell.note === 'OFF') {
              stopChannelSound(chId);
            } else {
              let sustainRows = 1;
              for (let r = activeRow + 1; r < 64 && sustainRows < 16; r++) {
                const nextNote = activePat[r]?.[chId]?.note;
                if (nextNote && nextNote !== '---') break;
                sustainRows++;
              }
              const noteDuration = Math.max(0.24, Math.min(3.5, stepSec * sustainRows));
              const vol = cell.vol && cell.vol !== '..' ? parseInt(cell.vol, 16) : ch.volume;
              playNote(chId, ch.chip, cell.note, noteDuration, vol, ch.pan, ch.soundFontPreset);
            }
          }
        }
      }
    }
  }, [activeRow, isPlaying, loadedAudioBuffer, loadedMidiBuffer, currentPatternIndex, songPatterns, patterns, channels, bpm]);

  const handleLoadTrack = (tracksJson: string, trackBpm: number) => {
    try {
      if (!tracksJson || tracksJson === '{}') {
        setChannels(prev => prev.map((ch, idx) => ({
          ...ch,
          enabled: idx < 6,
          chip: idx === 0 ? 'YM2612 (Sega)' : idx === 4 ? 'Virtual DAC' : 'MOS6581 (SID)',
          volume: 85
        })));
        setBpm(trackBpm);
        setActiveTab('tracker');
        return;
      }

      const parsedChannels = JSON.parse(tracksJson);
      if (Array.isArray(parsedChannels)) {
        setChannels(prev => prev.map(ch => {
          const match = parsedChannels.find(p => p.id === ch.id);
          return match ? { ...ch, ...match } : ch;
        }));
        setBpm(trackBpm);
        setActiveTab('tracker');
      }
    } catch (e) {
      console.log("Error loading track parameters:", e);
    }
  };

  const handleImportMasterSequence = (
    importedPatterns: any[], 
    importedBpm?: number, 
    duration?: string, 
    title?: string, 
    chipType?: string, 
    octaveRange?: string, 
    channelsCount?: number,
    allPatterns?: any[][],
    audioBuffer?: AudioBuffer,
    channelSoundFonts?: { [channelId: number]: string },
    rawMidiBuffer?: ArrayBuffer
  ) => {
    const finalAllPatterns = (allPatterns && allPatterns.length > 0) ? allPatterns : [importedPatterns];
    setSongPatterns(finalAllPatterns);
    setPatterns(importedPatterns || finalAllPatterns[0]);
    setCurrentPatternIndex(0);
    setLoadedAudioBuffer(audioBuffer || null);
    setLoadedMidiBuffer(rawMidiBuffer || null);

    if (importedBpm) {
      setBpm(importedBpm);
      setBaseSongBpm(importedBpm);
    }
    if (duration) setTrackDuration(duration);
    if (title) setTrackTitle(title);
    if (chipType) setTrackChipType(chipType);
    if (octaveRange) setTrackOctaveRange(octaveRange);

    const targetChCount = channelsCount || 8;
    setTrackChannelsCount(targetChCount);

    setChannels(prev => prev.map((ch, idx) => {
      const isEnabled = idx < targetChCount;
      let assignedChip = ch.chip;
      let assignedPreset = ch.soundFontPreset;

      if (channelSoundFonts && channelSoundFonts[ch.id]) {
        assignedPreset = channelSoundFonts[ch.id];
        assignedChip = 'General MIDI (SoundFont)';
      } else if (chipType) {
        if (chipType.includes('SID') || chipType.includes('MOS6581')) {
          assignedChip = 'MOS6581 (C64 SID)';
          assignedPreset = undefined;
        } else if (chipType.includes('Amiga') || chipType.includes('PAULA')) {
          assignedChip = 'PAULA (Amiga PCM)';
          assignedPreset = `mod_inst_01`;
        } else if (chipType.includes('NES') || chipType.includes('RP2A03')) {
          assignedChip = 'RP2A03 (NES APU)';
          assignedPreset = undefined;
        } else if (chipType.includes('Game Boy') || chipType.includes('DMG')) {
          assignedChip = 'DMG-01 (Game Boy)';
          assignedPreset = undefined;
        } else if (chipType.includes('SPC') || chipType.includes('SNES')) {
          assignedChip = 'SPC700 (SNES DSP)';
          assignedPreset = undefined;
        } else if (chipType.includes('MIDI') || chipType.includes('SoundFont')) {
          assignedChip = 'General MIDI (SoundFont)';
          assignedPreset = idx === 9 ? 'gm_drums' : idx === 0 ? 'gm_piano' : idx === 1 ? 'gm_epiano' : 'gm_strings';
        } else if (chipType.includes('OPL3') || chipType.includes('YMF262')) {
          assignedChip = 'YMF262 (OPL3 FM)';
          assignedPreset = undefined;
        } else {
          assignedChip = 'YM2612 (Sega FM)';
          assignedPreset = undefined;
        }
      }

      return {
        ...ch,
        enabled: isEnabled,
        chip: assignedChip,
        soundFontPreset: assignedPreset
      };
    }));

    setActiveTab('tracker');
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume();
      }
    } catch (e) {}
    setIsPlaying(true);
  };

  return (
    <div className="min-h-screen flex flex-col font-sans text-xs bg-zinc-950 text-zinc-350 selection:bg-cyan-500/30 selection:text-cyan-200">
      
      {/* HEADER / TOOLBAR */}
      <Header 
        isPlaying={isPlaying} 
        setIsPlaying={setIsPlaying} 
        bpm={bpm} 
        setBpm={setBpm}
        activeRow={activeRow}
        driveMode={driveMode}
        setDriveMode={setDriveMode}
        showDriveWarning={showDriveWarning}
        setShowDriveWarning={setShowDriveWarning}
        hardwareConnected={hardwareConnected}
        setHardwareConnected={setHardwareConnected}
        onImportSequence={handleImportMasterSequence}
        onLoadTrack={handleLoadTrack}
        trackTitle={trackTitle}
        trackDuration={trackDuration}
        trackChipType={trackChipType}
        trackOctaveRange={trackOctaveRange}
        trackChannelsCount={trackChannelsCount}
        channels={channels}
        setChannels={setChannels}
        patterns={patterns}
        songPatterns={songPatterns}
        onSwitchChiptuneMode={handleSwitchChiptuneMode}
        currentChiptuneMode={chiptuneMode}
      />

      {/* GLOBAL SYNCHRONIZED TIME BAR & SCRUBBER */}
      <TimeBar
        isPlaying={isPlaying}
        setIsPlaying={setIsPlaying}
        bpm={bpm}
        activeRow={activeRow}
        setActiveRow={setActiveRow}
        currentPatternIndex={currentPatternIndex}
        setCurrentPatternIndex={setCurrentPatternIndex}
        songPatterns={songPatterns}
        setPatterns={setPatterns}
        trackDuration={trackDuration}
        trackTitle={trackTitle}
        loadedAudioBuffer={loadedAudioBuffer}
        onSeekAudio={(targetSeconds) => {
          if (loadedAudioBuffer && isPlaying) {
            playDirectAudio(loadedAudioBuffer, targetSeconds, () => setIsPlaying(false));
          }
        }}
      />

      {/* MAIN CONTAINER LAYOUT */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* SIDE BAR NAVIGATION MODULE */}
        <nav className="w-16 bg-zinc-950 border-r border-zinc-900 flex flex-col items-center py-4 justify-between flex-shrink-0">
          <div className="flex flex-col items-center gap-3 w-full">
            <NavBtn 
              icon={<Monitor />} 
              tab="tracker" 
              active={activeTab} 
              setTab={setActiveTab} 
              label="Tracker" 
              disabled={driveMode} 
            />
            <NavBtn 
              icon={<Cpu />} 
              tab="chips" 
              active={activeTab} 
              setTab={setActiveTab} 
              label="Chips" 
              disabled={driveMode} 
            />
            <NavBtn 
              icon={<Settings />} 
              tab="mixer" 
              active={activeTab} 
              setTab={setActiveTab} 
              label="EQ & FX" 
            />
            <NavBtn 
              icon={<FileAudio />} 
              tab="convert" 
              active={activeTab} 
              setTab={setActiveTab} 
              label="Convert" 
              disabled={driveMode} 
            />
            <NavBtn 
              icon={<Cable />} 
              tab="hardware" 
              active={activeTab} 
              setTab={setActiveTab} 
              label="Hardware" 
              disabled={!hardwareConnected} 
              glow={hardwareConnected}
            />
          </div>

          {/* DEDICATED BOTTOM LEFT CORNER SHARE / ANDROID APK SECTION */}
          <div className="flex flex-col items-center gap-1.5 w-full pt-3 border-t border-zinc-900">
            <button
              id="bottom-left-share-apk-btn"
              onClick={() => setIsShareApkOpen(true)}
              className="p-2 rounded-xl w-14 h-14 flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer relative bg-emerald-950/40 text-emerald-400 hover:text-white hover:bg-emerald-600/30 border border-emerald-500/40 hover:border-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.25)] group"
              title="Share Workstation & Download Android APK (.apk)"
            >
              <Share2 size={16} className="text-emerald-400 group-hover:scale-110 transition-transform" />
              <span className="text-[7.5px] uppercase tracking-wider font-black text-center leading-tight">Share/APK</span>
              <span className="absolute -top-1 -right-1 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
            </button>
          </div>
        </nav>

        {/* ACTIVE MAIN VIEWPORT CONTAINER */}
        <main className="flex-1 overflow-y-auto p-4 relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-900/10 via-zinc-950/40 to-black">
          {driveMode && activeTab !== 'mixer' ? (
            <div className="flex items-center justify-center h-full text-zinc-500 flex-col gap-4 text-center">
               <AlertTriangle size={48} className="text-red-500/70 animate-pulse" />
               <div>
                  <p className="text-sm font-bold text-white uppercase tracking-wider">Features Locked While Driving</p>
                  <p className="text-[10.5px] text-zinc-550 max-w-sm mt-1 font-sans leading-relaxed">
                     Manual sequenced operations and converters are restricted for physical road safety. Use the tactile Mixer panel below to play, tweak sound envelopes, or rotate filters.
                  </p>
               </div>
               <button 
                  onClick={() => setActiveTab('mixer')} 
                  className="px-4 py-2 bg-red-950/20 text-red-400 hover:text-white hover:bg-red-600/30 rounded border border-red-500/35 transition cursor-pointer font-bold text-[10.5px] tracking-wider uppercase"
               >
                  Go to Simplified Mixer
               </button>
            </div>
          ) : (
            <>
              {activeTab === 'tracker' && (
                <TrackerEditor 
                  channels={channels} 
                  setChannels={setChannels} 
                  theme="furnace" 
                  activeRow={activeRow} 
                  setActiveRow={setActiveRow}
                  isPlaying={isPlaying}
                  patterns={patterns}
                  setPatterns={setPatterns}
                  songPatterns={songPatterns}
                  setSongPatterns={setSongPatterns}
                  currentPatternIndex={currentPatternIndex}
                  setCurrentPatternIndex={setCurrentPatternIndex}
                  playMode={playMode}
                  setPlayMode={setPlayMode}
                  bpm={bpm}
                  setBpm={setBpm}
                  setIsPlaying={setIsPlaying}
                  trackTitle={trackTitle}
                  onSwitchChiptuneMode={handleSwitchChiptuneMode}
                  currentChiptuneMode={chiptuneMode}
                  onImportTrack={(duration, title, chipType, importedBpm, octaveRange, channelsCount, allPatterns, audioBuffer, channelSoundFonts, rawMidiBuffer) => {
                    handleImportMasterSequence(
                      allPatterns?.[0] || patterns,
                      importedBpm,
                      duration,
                      title,
                      chipType,
                      octaveRange,
                      channelsCount,
                      allPatterns,
                      audioBuffer,
                      channelSoundFonts,
                      rawMidiBuffer
                    );
                  }}
                />
              )}
              {activeTab === 'chips' && (
                <ChipConfigurator 
                  channels={channels} 
                  setChannels={setChannels} 
                  hardwareConnected={hardwareConnected} 
                />
              )}
              {activeTab === 'mixer' && (
                <MixerEQ 
                  channels={channels} 
                  setChannels={setChannels}
                  isPlaying={isPlaying} 
                  driveMode={driveMode} 
                  channelPitches={channelPitches}
                  bpm={bpm}
                  oscConfig={oscConfig}
                  setOscConfig={handleSetOscConfig}
                />
              )}
              {activeTab === 'convert' && (
                <FileConverterUI 
                  onImportSequence={handleImportMasterSequence} 
                />
              )}
              {activeTab === 'hardware' && (
                <HardwareConnectionScript 
                  hardwareConnected={hardwareConnected} 
                  setHardwareConnected={setHardwareConnected} 
                />
              )}
            </>
          )}
        </main>
      </div>

      {/* ANDROID APK & SHARE MODAL */}
      <ShareApkModal
        isOpen={isShareApkOpen}
        onClose={() => setIsShareApkOpen(false)}
        trackTitle={trackTitle}
      />
    </div>
  );
}

// Side Nav button helper for visual precision
interface NavBtnProps {
  icon: React.ReactNode;
  tab: string;
  active: string;
  setTab: (tab: string) => void;
  label: string;
  disabled?: boolean;
  glow?: boolean;
}

function NavBtn({ icon, tab, active, setTab, label, disabled = false, glow = false }: NavBtnProps) {
  return (
    <button 
      id={`nav-btn-${tab}`}
      onClick={() => !disabled && setTab(tab)}
      disabled={disabled}
      className={`p-2.5 rounded-xl w-14 h-14 flex flex-col items-center justify-center gap-1 transition-all cursor-pointer relative ${
        disabled 
          ? 'opacity-15 cursor-not-allowed border border-transparent' 
          : active === tab 
            ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 shadow-[0_0_12px_rgba(34,211,238,0.2)] font-black animate-none' 
            : glow
              ? 'bg-amber-500/10 text-amber-300 border border-amber-500/35 animate-pulse font-bold shadow-[0_0_15px_rgba(245,158,11,0.2)]'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40 border border-transparent'
      }`}
      title={label}
    >
      {React.cloneElement(icon as React.ReactElement, { size: 16 })}
      <span className="text-[8px] uppercase tracking-wider font-semibold truncate max-w-[50px]">{label}</span>
      {glow && (
        <span className="absolute -top-0.5 -right-0.5 flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500"></span>
        </span>
      )}
    </button>
  );
}
