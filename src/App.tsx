import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Square, Settings, Cpu, AlertTriangle, 
  Download, Upload, Music, Radio, Monitor, Cable, Activity,
  Save, FileAudio, Car, Share2, Users, Sliders
} from 'lucide-react';

import { Channel, MAX_CHANNELS, OscilloscopeConfig } from './types';
import { INITIAL_PATTERNS } from './initialPatterns';
import Header from './components/Header';
import TimeBar from './components/TimeBar';
import TrackerEditor from './components/TrackerEditor';
import ChipConfigurator from './components/ChipConfigurator';
import FurnaceControlDeck from './components/FurnaceControlDeck';
import MixerEQ from './components/MixerEQ';
import FileConverterUI from './components/FileConverterUI';
import HardwareConnectionScript from './components/HardwareConnectionScript';
import ChiptuneRevolutionsHub from './components/ChiptuneRevolutionsHub';
import ShareApkModal from './components/ShareApkModal';
import { 
  playNote, 
  stopChannelSound,
  playDirectAudio, 
  stopDirectAudio,
  getDirectAudioProgress,
  playMidiBuffer, 
  stopMidiPlayback,
  seekMidiPlayback,
  getMidiPlaybackProgress,
  playSidBuffer,
  pauseSidPlayback,
  seekSidPlayback,
  getSidPlaybackProgress,
  playSunVoxBuffer,
  pauseSunVoxPlayback,
  seekSunVoxPlayback,
  getSunVoxPlaybackProgress,
  pauseFurnacePlayback,
  SunVoxBridge,
  TinyRsidBridge,
  FurnaceBridge,
  MasterAudioRouter,
  setSoundEnginesConfig,
  syncChannelMuteSolo,
  stopAllChannelsSound,
  getAudioContext,
  unlockAudioContextSync,
  setAudioPlaybackRate,
  setMidiTempoBpm,
  syncInitialMidiInstruments,
  restoreSavedSoundFontsFromCookies,
  SoundFontLoadingState,
  onSoundFontLoadingChange,
  loadSoundFontIntoCoreAndLib,
  isSoundFontFileName
} from './components/AudioEngine';
import { getSavedSelectedSoundFont } from './utils/recentSongsManager';
import { getSavedAmplifier, saveAmplifier, getSavedOscConfig, saveOscConfig } from './utils/cookieStorage';
import { VideoRecorder } from './utils/videoRecorder';
import { WorkletSynthBridge } from './engines/workletSynthBridge';
import { formatDuration, parseChiptuneFileAsync } from './utils/chiptuneParsers';
import { SidHeaderMetadata } from './utils/hvscManager';
import { isFamiTrackerFileName, parseFamiTrackerBinary } from './lib/chips/nes/famitrackerParser';
import type { FamiTrackerModule } from './lib/chips/nes/types';

function parseDurationStringSec(dur?: string | null): number | null {
  if (!dur) return null;
  const parts = dur.trim().split(':');
  if (parts.length !== 2) return null;
  const mins = parseInt(parts[0], 10);
  const secs = parseFloat(parts[1]);
  if (isNaN(mins) || isNaN(secs)) return null;
  return Math.max(1, mins * 60 + secs);
}

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
  const [loadedMidiFileName, setLoadedMidiFileName] = useState<string>('sequence.mid');
  const [loadedSidBuffer, setLoadedSidBuffer] = useState<ArrayBuffer | null>(null);
  const [loadedSidFileName, setLoadedSidFileName] = useState<string>('tune.sid');
  const [sidRuntime, setSidRuntime] = useState(() => TinyRsidBridge.getState());
  const [loadedSunVoxBuffer, setLoadedSunVoxBuffer] = useState<ArrayBuffer | null>(null);
  const [loadedSunVoxFileName, setLoadedSunVoxFileName] = useState<string>('project.sunvox');
  const [sunvoxRuntime, setSunvoxRuntime] = useState(() => SunVoxBridge.getState());
  const [loadedFurBuffer, setLoadedFurBuffer] = useState<ArrayBuffer | null>(null);
  const [loadedFtmDiverted, setLoadedFtmDiverted] = useState<boolean>(false);
  const [furnaceLiveTotalSec, setFurnaceLiveTotalSec] = useState<number | null>(null);
  const furWasActiveRef = useRef<boolean>(false);
  const lastSequencerStepRef = useRef<string>('');

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

  // Restore saved soundfont preset preference & pre-warm Furnace WASM DSP bundle
  useEffect(() => {
    void FurnaceBridge.ensureWasmLoaded();
    void restoreSavedSoundFontsFromCookies();
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

  const pendingSeekRatioRef = useRef<number>(0);
  const [midiLiveTotalSec, setMidiLiveTotalSec] = useState<number | null>(null);
  const [liveElapsedSec, setLiveElapsedSec] = useState<number | null>(null);

  const [soundFontLoading, setSoundFontLoading] = useState<SoundFontLoadingState>({
    isLoading: false,
    soundFontName: '',
    progress: 0,
    elapsedMs: 0,
    durationMs: 3000
  });
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const wasPlayingBeforeSfSwapRef = useRef(false);
  const prevSfLoadingRef = useRef(false);

  // Pause active playback during 3-second SoundFont swap loading screen and auto-resume cleanly afterwards
  useEffect(() => {
    const unsub = onSoundFontLoadingChange((next) => {
      setSoundFontLoading(next);
      if (next.isLoading && !prevSfLoadingRef.current) {
        prevSfLoadingRef.current = true;
        wasPlayingBeforeSfSwapRef.current = isPlayingRef.current;
        if (isPlayingRef.current) {
          setIsPlaying(false);
        }
      } else if (!next.isLoading && prevSfLoadingRef.current) {
        prevSfLoadingRef.current = false;
        if (wasPlayingBeforeSfSwapRef.current) {
          wasPlayingBeforeSfSwapRef.current = false;
          setIsPlaying(true);
        }
      }
    });
    return () => unsub();
  }, []);

  // Keep TinyRSid runtime & HVSC duration synchronized cleanly
  useEffect(() => {
    const unsubSid = TinyRsidBridge.subscribe((nextSid) => {
      setSidRuntime(nextSid);
      if (nextSid.hasSidLoaded && nextSid.durationSeconds > 0) {
        setTrackDuration(formatDuration(nextSid.durationSeconds));
      }
    });
    return () => unsubSid();
  }, []);

  const sunvoxChannelsSigRef = useRef<string>('');
  const sunvoxBpmLoadedRef = useRef<string>('');

  // Keep SunVox WASM runtime metadata (real song name, initial BPM, duration, active module channels) synchronized cleanly
  useEffect(() => {
    const unsubSv = SunVoxBridge.subscribe((nextSv) => {
      setSunvoxRuntime(nextSv);
      if (nextSv.hasSunVoxLoaded && nextSv.isReady) {
        if (nextSv.songName) setTrackTitle(nextSv.songName);
        if (nextSv.durationSeconds > 0) setTrackDuration(formatDuration(nextSv.durationSeconds));
        if (nextSv.bpm >= 30 && nextSv.bpm <= 320 && sunvoxBpmLoadedRef.current !== nextSv.fileName) {
          sunvoxBpmLoadedRef.current = nextSv.fileName;
          setBpm(nextSv.bpm);
          setBaseSongBpm(nextSv.bpm);
        }

        const mappedMods = SunVoxBridge.getChannelMappedModules();
        const sig = `${nextSv.fileName}:${mappedMods.map((m) => m.id).join(',')}`;
        if (mappedMods.length > 0 && sig !== sunvoxChannelsSigRef.current) {
          sunvoxChannelsSigRef.current = sig;
          const targetChCount = Math.min(MAX_CHANNELS, Math.max(8, mappedMods.length));
          setTrackChannelsCount(targetChCount);
          setChannels((prev) =>
            prev.map((ch, idx) => {
              const svMod = idx < mappedMods.length ? mappedMods[idx] : null;
              return {
                ...ch,
                enabled: idx < targetChCount,
                chip: 'Virtual DAC (SunVox 2.1.4 WASM)',
                soundFontPreset: undefined,
                label: svMod ? `#${svMod.id.toString().padStart(2, '0')} ${svMod.name}` : undefined,
              };
            })
          );
        }
      } else if (!nextSv.hasSunVoxLoaded) {
        sunvoxChannelsSigRef.current = '';
        sunvoxBpmLoadedRef.current = '';
      }
    });
    return () => unsubSv();
  }, []);

  // Sync channel mute/solo/enable state post-render (avoids cross-component setState during render)
  useEffect(() => {
    syncChannelMuteSolo(channels);
  }, [channels]);

  // Sync real tracker state + offline snapshot buffers into internal VideoRecorder
  useEffect(() => {
    VideoRecorder.setLiveTrackerState({
      songPatterns,
      currentPatternIndex,
      activeRow,
      channels,
      bpm,
      baseSongBpm,
      trackTitle,
      isPlaying,
      loadedAudioBuffer,
      loadedMidiBuffer,
      oscPreset: oscConfig.preset,
      oscAmplifier: oscConfig.amplifier
    });
  }, [songPatterns, currentPatternIndex, activeRow, channels, bpm, baseSongBpm, trackTitle, isPlaying, loadedAudioBuffer, loadedMidiBuffer, oscConfig.preset, oscConfig.amplifier]);

  // Synchronous Audio Playback Lifecycle (only triggers on play/pause or buffer swap)
  useEffect(() => {
    if (isPlaying) {
      if (loadedSidBuffer) {
        const sidStateSnap = TinyRsidBridge.getState();
        const seekSec = pendingSeekRatioRef.current * (sidStateSnap.durationSeconds || 135);
        void playSidBuffer(loadedSidBuffer, loadedSidFileName, {
          subtune1Based: sidStateSnap.currentSubtune,
          seekSeconds: seekSec,
          channels,
          onSongEnded: () => {
            pendingSeekRatioRef.current = 0;
            setLiveElapsedSec(0);
            setCurrentPatternIndex(0);
            setActiveRow(0);
            setIsPlaying(false);
          }
        });
      } else if (loadedSunVoxBuffer) {
        void playSunVoxBuffer(loadedSunVoxBuffer, loadedSunVoxFileName, {
          seekRatio: pendingSeekRatioRef.current,
          onSongEnded: () => {
            pendingSeekRatioRef.current = 0;
            setLiveElapsedSec(0);
            setCurrentPatternIndex(0);
            setActiveRow(0);
            setIsPlaying(false);
          }
        });
      } else if (loadedFurBuffer || loadedFtmDiverted) {
        furWasActiveRef.current = false;
        const ctx = unlockAudioContextSync();
        const startFurnace = async () => {
          if (ctx) {
            const furBus = MasterAudioRouter.getEngineInput('FURNACE') || ctx.destination;
            await FurnaceBridge.attachToMasterRouter(ctx, furBus);
          }
          await FurnaceBridge.ensureWasmLoaded();
          FurnaceBridge.setTempoScale(bpm / (baseSongBpm || 150));
          FurnaceBridge.seekToRatio(pendingSeekRatioRef.current);
          FurnaceBridge.play();
        };
        void startFurnace();
      } else if (loadedMidiBuffer) {
        playMidiBuffer(
          loadedMidiBuffer,
          () => {
            pendingSeekRatioRef.current = 0;
            setLiveElapsedSec(0);
            setCurrentPatternIndex(0);
            setActiveRow(0);
            setIsPlaying(false);
          },
          bpm,
          baseSongBpm,
          pendingSeekRatioRef.current,
          loadedMidiFileName
        );
        const prog = getMidiPlaybackProgress(bpm, baseSongBpm);
        setMidiLiveTotalSec(prog.totalSeconds);
      } else if (loadedAudioBuffer) {
        const startOffset = Math.max(
          0,
          Math.min(loadedAudioBuffer.duration - 0.05, pendingSeekRatioRef.current * loadedAudioBuffer.duration)
        );
        playDirectAudio(loadedAudioBuffer, startOffset, () => {
          pendingSeekRatioRef.current = 0;
          setLiveElapsedSec(0);
          setCurrentPatternIndex(0);
          setActiveRow(0);
          setIsPlaying(false);
        });
        const rate = bpm / (baseSongBpm || 125);
        setAudioPlaybackRate(rate);
      }
    } else {
      furWasActiveRef.current = false;
      pauseSidPlayback();
      pauseSunVoxPlayback();
      pauseFurnacePlayback();
      stopDirectAudio();
      stopMidiPlayback();
      stopAllChannelsSound();
    }
  }, [isPlaying, loadedAudioBuffer, loadedMidiBuffer, loadedSidBuffer, loadedSunVoxBuffer, loadedFurBuffer, loadedFtmDiverted]);

  // Dynamic Audio Playback Rate / Tempo Scaling on BPM changes (does NOT restart the song!)
  useEffect(() => {
    if (loadedAudioBuffer) {
      const rate = bpm / (baseSongBpm || 125);
      setAudioPlaybackRate(rate);
    }
    if (loadedMidiBuffer) {
      setMidiTempoBpm(bpm, baseSongBpm);
      const prog = getMidiPlaybackProgress(bpm, baseSongBpm);
      setMidiLiveTotalSec(prog.totalSeconds);
    }
    if (loadedFurBuffer || loadedFtmDiverted) {
      const rate = bpm / (baseSongBpm || 150);
      FurnaceBridge.setTempoScale(rate);
    }
  }, [bpm, baseSongBpm, isPlaying, loadedAudioBuffer, loadedMidiBuffer, loadedFurBuffer, loadedFtmDiverted]);

  // Clock-Locked Tracker Row & Pattern Synchronization (SID / SunVox / MIDI / AudioBuffer / Pattern Sequencer)
  useEffect(() => {
    if (!isPlaying) return;

    if (loadedSidBuffer || loadedSunVoxBuffer || loadedFurBuffer || loadedFtmDiverted || loadedMidiBuffer || loadedAudioBuffer) {
      const syncTimer = setInterval(() => {
        const pats = songPatterns;
        const rowsPerPat = Math.max(1, pats[0]?.length || 64);
        const totalRows = Math.max(1, pats.length * rowsPerPat);

        let ratio = 0;
        let elapsed = 0;
        if (loadedSidBuffer) {
          const prog = getSidPlaybackProgress();
          ratio = prog.ratio;
          elapsed = prog.elapsedSeconds;
        } else if (loadedSunVoxBuffer) {
          const prog = getSunVoxPlaybackProgress();
          ratio = prog.ratio;
          elapsed = prog.elapsedSeconds;
        } else if (loadedFurBuffer || loadedFtmDiverted) {
          const prog = FurnaceBridge.getPlaybackProgress();
          if (prog.isPlaying) {
            furWasActiveRef.current = true;
          }
          if (prog.totalSeconds > 0) {
            setFurnaceLiveTotalSec(prog.totalSeconds);
          }
          pendingSeekRatioRef.current = prog.ratio;
          setLiveElapsedSec(prog.elapsedSeconds);
          const targetOrd = Math.max(0, Math.min(pats.length - 1, prog.orderIdx));
          const patRows = pats[targetOrd];
          const targetRow = Math.max(0, Math.min((patRows?.length || rowsPerPat) - 1, prog.rowIdx));
          setCurrentPatternIndex((prevPat) => (prevPat !== targetOrd ? targetOrd : prevPat));
          if (patRows) {
            setPatterns((prevRows) => (prevRows === patRows ? prevRows : patRows));
          }
          setActiveRow(targetRow);
          if (furWasActiveRef.current && !prog.isPlaying) {
            pendingSeekRatioRef.current = 0;
            setLiveElapsedSec(0);
            setIsPlaying(false);
          }
          return;
        } else if (loadedMidiBuffer) {
          const prog = getMidiPlaybackProgress(bpm, baseSongBpm);
          ratio = prog.ratio;
          elapsed = prog.elapsedSeconds;
          setMidiLiveTotalSec(prog.totalSeconds);
        } else if (loadedAudioBuffer) {
          const prog = getDirectAudioProgress();
          ratio = prog.ratio;
          const rate = Math.max(0.25, Math.min(4.0, bpm / (baseSongBpm || 125)));
          elapsed = prog.currentTime / rate;
        }

        pendingSeekRatioRef.current = ratio;
        setLiveElapsedSec(elapsed);

        const globalRow = Math.max(0, Math.min(totalRows - 1, Math.floor(ratio * totalRows)));
        const patIdx = Math.floor(globalRow / rowsPerPat);
        const rowIdx = globalRow % rowsPerPat;

        setCurrentPatternIndex((prevPat) => (prevPat !== patIdx ? patIdx : prevPat));
        if (pats[patIdx]) {
          setPatterns((prevRows) => (prevRows === pats[patIdx] ? prevRows : pats[patIdx]));
        }
        setActiveRow(rowIdx);
      }, 50);

      return () => clearInterval(syncTimer);
    }

    // Pattern Sequencer mode (manual pattern editing without loaded audio/MIDI/SID/SunVox/Furnace/FTM)
    const maxRowIndex = Math.max(0, (patterns?.length || 64) - 1);
    const msPerRow = Math.max(15, (60 / Math.max(30, bpm) / 4) * 1000);
    const timer = setInterval(() => {
      setActiveRow((prevRow) => {
        if (prevRow >= maxRowIndex) {
          if (playMode === 'song') {
            setCurrentPatternIndex((prevIdx) => {
              const nextIdx = (prevIdx + 1) % Math.max(1, songPatterns.length);
              if (songPatterns[nextIdx]) {
                setPatterns(songPatterns[nextIdx]);
              }
              return nextIdx;
            });
          }
          return 0;
        }
        return prevRow + 1;
      });
    }, msPerRow);

    return () => {
      clearInterval(timer);
    };
  }, [isPlaying, bpm, baseSongBpm, playMode, songPatterns, loadedMidiBuffer, loadedAudioBuffer, loadedSidBuffer, loadedSunVoxBuffer, loadedFurBuffer, loadedFtmDiverted]);

  // Real-time Note Triggering for manual pattern sequencer only
  useEffect(() => {
    if (!isPlaying) {
      lastSequencerStepRef.current = '';
      return;
    }
    if (!loadedAudioBuffer && !loadedMidiBuffer && !loadedSidBuffer && !loadedSunVoxBuffer && !loadedFurBuffer && !loadedFtmDiverted) {
      const stepKey = `${currentPatternIndex}:${activeRow}`;
      if (lastSequencerStepRef.current === stepKey) return;
      lastSequencerStepRef.current = stepKey;

      const activePat = (songPatterns && songPatterns[currentPatternIndex]) || patterns;
      const rowData = activePat?.[activeRow];
      if (rowData) {
        const stepSec = Math.max(0.05, 60 / Math.max(30, bpm) / 4);
        const anySolo = channels.some(c => c.enabled && c.solo);
        for (let chId = 1; chId <= MAX_CHANNELS; chId++) {
          const cell = rowData[chId];
          const ch = channels.find(c => c.id === chId);
          if (ch && ch.enabled && !ch.mute && (!anySolo || ch.solo) && cell) {
            if (Array.isArray(cell.fx)) {
              for (const fxTok of cell.fx) {
                if (fxTok && fxTok !== '....') {
                  MasterAudioRouter.routeEffect(chId, fxTok, 'FURNACE');
                }
              }
            }
            if (cell.note && cell.note !== '---') {
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
                const vol =
                  cell.vol && cell.vol !== '..'
                    ? Math.min(100, /^[0-9]+$/.test(cell.vol) ? parseInt(cell.vol, 10) : parseInt(cell.vol, 16))
                    : ch.volume;
                const parsedInst = cell.inst && cell.inst !== '..' ? parseInt(cell.inst, 16) : undefined;
                playNote(
                  chId,
                  ch.chip,
                  cell.note,
                  noteDuration,
                  vol,
                  ch.pan,
                  ch.soundFontPreset,
                  parsedInst !== undefined && !Number.isNaN(parsedInst) ? parsedInst : undefined
                );
              }
            }
          }
        }
      }
    }
  }, [activeRow, isPlaying, loadedAudioBuffer, loadedMidiBuffer, loadedSidBuffer, loadedSunVoxBuffer, loadedFurBuffer, loadedFtmDiverted, currentPatternIndex, songPatterns, patterns, channels, bpm]);

  const handleLoadTrack = (tracksJson: string, trackBpm: number) => {
    try {
      setLoadedFtmDiverted(false);
      setLoadedFurBuffer(null);
      setFurnaceLiveTotalSec(null);
      FurnaceBridge.clearLoadedSong();
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
    rawMidiBuffer?: ArrayBuffer,
    fileName?: string,
    rawSidBuffer?: ArrayBuffer,
    sidMetadata?: SidHeaderMetadata,
    rawSunVoxBuffer?: ArrayBuffer,
    rawFurnaceBuffer?: ArrayBuffer
  ) => {
    const finalAllPatterns = (allPatterns && allPatterns.length > 0) ? allPatterns : [importedPatterns];
    const resolvedName =
      fileName ||
      (title
        ? `${title}.${rawSidBuffer ? 'sid' : rawSunVoxBuffer ? 'sunvox' : rawFurnaceBuffer ? 'fur' : 'mid'}`
        : 'sequence.mid');
    const isFamiTrackerDiverted = Boolean(rawFurnaceBuffer && isFamiTrackerFileName(resolvedName));
    const isFurNative = Boolean(rawFurnaceBuffer && !isFamiTrackerDiverted);
    pendingSeekRatioRef.current = 0;
    setMidiLiveTotalSec(null);
    setFurnaceLiveTotalSec(null);
    setLiveElapsedSec(0);
    setActiveRow(0);
    setSongPatterns(finalAllPatterns);
    setPatterns(importedPatterns || finalAllPatterns[0]);
    setCurrentPatternIndex(0);
    setLoadedAudioBuffer((rawSidBuffer || rawSunVoxBuffer || rawFurnaceBuffer) ? null : (audioBuffer || null));
    setLoadedMidiBuffer((rawSidBuffer || rawSunVoxBuffer || rawFurnaceBuffer) ? null : (rawMidiBuffer || null));
    setLoadedSidBuffer(rawSidBuffer || null);
    setLoadedSunVoxBuffer(rawSunVoxBuffer || null);
    setLoadedFurBuffer(isFurNative ? rawFurnaceBuffer! : null);
    setLoadedFtmDiverted(isFamiTrackerDiverted);

    let loadedFtMod: FamiTrackerModule | null = null;
    if (rawFurnaceBuffer) {
      const ctx = unlockAudioContextSync();
      if (ctx) {
        const furBus = MasterAudioRouter.getEngineInput('FURNACE') || ctx.destination;
        void FurnaceBridge.attachToMasterRouter(ctx, furBus);
      }
      SunVoxBridge.clearLoadedSunVox();
      TinyRsidBridge.clearLoadedSid();
      WorkletSynthBridge.clearCurrentSequence();
      setSoundEnginesConfig({ furnace: true });
      if (isFamiTrackerDiverted) {
        try {
          loadedFtMod = parseFamiTrackerBinary(rawFurnaceBuffer, resolvedName);
          FurnaceBridge.loadFamiTrackerBuffer(rawFurnaceBuffer, resolvedName, loadedFtMod);
        } catch (err) {
          console.warn('FurnaceBridge FamiTracker diversion failed:', err);
        }
      } else {
        void FurnaceBridge.loadFurBuffer(rawFurnaceBuffer, resolvedName);
      }
    } else if (rawSunVoxBuffer) {
      const ctx = unlockAudioContextSync();
      if (ctx) SunVoxBridge.setHostAudioContext(ctx);
      sunvoxBpmLoadedRef.current = '';
      sunvoxChannelsSigRef.current = '';
      setLoadedSunVoxFileName(resolvedName);
      FurnaceBridge.clearLoadedSong();
      TinyRsidBridge.clearLoadedSid();
      WorkletSynthBridge.clearCurrentSequence();
      setSoundEnginesConfig({ sunvox: true });
      const registeredSv = SunVoxBridge.registerSunVoxFile(rawSunVoxBuffer, resolvedName);
      setSunvoxRuntime(registeredSv);
    } else if (rawSidBuffer) {
      SunVoxBridge.clearLoadedSunVox();
      FurnaceBridge.clearLoadedSong();
      setLoadedSidFileName(resolvedName);
      WorkletSynthBridge.clearCurrentSequence();
      const registered = TinyRsidBridge.registerSidFile(rawSidBuffer, resolvedName, sidMetadata?.startSong);
      setSidRuntime(registered);
    } else {
      SunVoxBridge.clearLoadedSunVox();
      TinyRsidBridge.clearLoadedSid();
      FurnaceBridge.clearLoadedSong();
      if (rawMidiBuffer) {
        setLoadedMidiFileName(resolvedName);
        WorkletSynthBridge.registerLoadedSequence(
          rawMidiBuffer,
          resolvedName,
          finalAllPatterns.length,
          finalAllPatterns.length * 64
        );
        syncInitialMidiInstruments(rawMidiBuffer, resolvedName);
      } else {
        WorkletSynthBridge.clearCurrentSequence();
      }
    }

    if (importedBpm) {
      setBpm(importedBpm);
      setBaseSongBpm(importedBpm);
    }
    if (duration) setTrackDuration(duration);
    if (title) setTrackTitle(title);
    if (chipType) setTrackChipType(chipType);
    if (octaveRange) setTrackOctaveRange(octaveRange);

    const targetChCount = rawSidBuffer
      ? ((sidMetadata?.chipCount || 1) * 3)
      : loadedFtMod
        ? Math.min(MAX_CHANNELS, loadedFtMod.channels.length)
        : (channelsCount || 8);
    setTrackChannelsCount(targetChCount);

    setChannels(prev => {
      const next = prev.map((ch, idx) => {
        const isEnabled = idx < targetChCount;
        let assignedChip = ch.chip;
        let assignedPreset = ch.soundFontPreset;
        let assignedPan = ch.pan;
        let assignedLabel: string | undefined = undefined;

        if (loadedFtMod) {
          const ftCh = idx < loadedFtMod.channels.length ? loadedFtMod.channels[idx] : null;
          assignedPreset = undefined;
          if (ftCh) {
            assignedLabel = ftCh.name;
            if (ftCh.chip === 'VRC6') assignedChip = 'VRC6 (Furnace)';
            else if (ftCh.chip === 'VRC7') assignedChip = 'VRC7 (OPLL FM)';
            else if (ftCh.chip === 'FDS') assignedChip = 'FDS (Famicom Disk)';
            else if (ftCh.chip === 'N163') assignedChip = 'Namco 163';
            else if (ftCh.chip === 'Sunsoft 5B') assignedChip = 'Sunsoft 5B (Furnace)';
            else assignedChip = 'RP2A03 (NES APU)';
          } else {
            assignedChip = 'RP2A03 (NES APU)';
          }
        } else if (rawSidBuffer) {
          const chipCount = sidMetadata?.chipCount || 1;
          const sidChipIdx = Math.floor(idx / 3);
          const voiceNum = (idx % 3) + 1;
          const sidModelForChip =
            sidChipIdx === 0
              ? sidMetadata?.chipModel
              : sidChipIdx === 1
                ? sidMetadata?.sid2Model
                : sidMetadata?.sid3Model;
          const is8580 = sidModelForChip === 'MOS 8580' || (!sidModelForChip && !sidMetadata?.defaultIs6581);
          assignedChip = is8580 ? 'MOS8580 (C64 SID)' : 'MOS6581 (C64 SID)';
          assignedPreset = undefined;

          if (isEnabled) {
            let panTag = 'C';
            if (chipCount === 1) {
              assignedPan = [50, 35, 65][idx % 3];
              panTag = assignedPan < 45 ? 'L' : assignedPan > 55 ? 'R' : 'C';
            } else if (chipCount === 2) {
              assignedPan = sidChipIdx === 0 ? 25 : 75;
              panTag = sidChipIdx === 0 ? 'L' : 'R';
            } else {
              assignedPan = sidChipIdx === 0 ? 18 : sidChipIdx === 1 ? 50 : 82;
              panTag = sidChipIdx === 0 ? 'L' : sidChipIdx === 1 ? 'C' : 'R';
            }
            assignedLabel = `SID${sidChipIdx + 1} V${voiceNum} · ${panTag}`;
          }
        } else if (rawSunVoxBuffer || chipType?.includes('SunVox')) {
          assignedChip = 'Virtual DAC (SunVox 2.1.4 WASM)';
          assignedPreset = undefined;
        } else if (channelSoundFonts && channelSoundFonts[ch.id]) {
          assignedPreset = channelSoundFonts[ch.id];
          assignedChip = 'General MIDI (SoundFont)';
        } else if (chipType) {
          if (chipType.includes('MOS8580')) {
            assignedChip = 'MOS8580 (C64 SID)';
            assignedPreset = undefined;
          } else if (chipType.includes('SID') || chipType.includes('MOS6581')) {
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
          pan: assignedPan,
          soundFontPreset: assignedPreset,
          label: assignedLabel,
          mute: false,
          solo: false
        };
      });
      return next;
    });

    setActiveTab('tracker');
    unlockAudioContextSync();
    setIsPlaying(true);
  };

  const handleGlobalDrop = (e: React.DragEvent<HTMLDivElement>) => {
    // Let dedicated inner dropzones (like Convert tab) handle drops inside themselves unless fallback
    if (activeTab === 'convert') return;
    const dropped = e.dataTransfer?.files?.[0];
    if (!dropped) return;
    e.preventDefault();
    unlockAudioContextSync();
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const buf = ev.target?.result;
      if (!(buf instanceof ArrayBuffer)) return;
      const lowerName = dropped.name.toLowerCase();
      if (isSoundFontFileName(dropped.name)) {
        try {
          await loadSoundFontIntoCoreAndLib(buf, dropped.name);
        } catch (err) {
          console.warn('Global SoundFont drop error:', err);
        }
        return;
      }
      if (
        lowerName.endsWith('.fui') ||
        lowerName.endsWith('.fuw') ||
        lowerName.endsWith('.dmp') ||
        lowerName.endsWith('.opm') ||
        lowerName.endsWith('.dmc') ||
        lowerName.endsWith('.brr')
      ) {
        try {
          const { FurnaceBridge } = await import('./engines/FurnaceBridge');
          if (lowerName.endsWith('.fui')) {
            FurnaceBridge.importFUI(buf, dropped.name);
          } else if (lowerName.endsWith('.dmp')) {
            FurnaceBridge.importDMP(buf, dropped.name);
          } else if (lowerName.endsWith('.opm')) {
            FurnaceBridge.importOPM(new TextDecoder().decode(buf), dropped.name);
          } else if (lowerName.endsWith('.fuw')) {
            FurnaceBridge.importFUW(buf, dropped.name);
          } else if (lowerName.endsWith('.dmc') || lowerName.endsWith('.brr')) {
            FurnaceBridge.importSampleFile(buf, dropped.name);
          }
          setActiveTab('furnace');
        } catch (err) {
          console.warn('Global Furnace resource drop error:', err);
        }
        return;
      }
      try {
        const res = await parseChiptuneFileAsync(dropped.name, buf);
        handleImportMasterSequence(
          res.patterns,
          res.bpm,
          res.duration,
          res.title,
          res.chipType,
          res.octaveRange,
          res.channelsCount,
          res.allPatterns,
          res.audioBuffer,
          res.channelSoundFonts,
          res.rawMidiBuffer,
          res.fileName || dropped.name,
          res.rawSidBuffer,
          res.sidMetadata,
          res.rawSunVoxBuffer,
          res.rawFurnaceBuffer
        );
      } catch (err) {
        console.warn('Global song drop parse error:', err);
      }
    };
    reader.readAsArrayBuffer(dropped);
  };

  return (
    <div
      onDragOver={(e) => {
        if (activeTab !== 'convert') e.preventDefault();
      }}
      onDrop={handleGlobalDrop}
      className="min-h-screen flex flex-col font-sans text-xs bg-zinc-950 text-zinc-350 selection:bg-cyan-500/30 selection:text-cyan-200"
    >
      
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
        actualTotalSeconds={(() => {
          if (loadedSidBuffer) {
            return Math.max(1, sidRuntime.durationSeconds || 135);
          }
          if (loadedSunVoxBuffer) {
            return Math.max(1, sunvoxRuntime.durationSeconds || 180);
          }
          if (loadedFurBuffer || loadedFtmDiverted) {
            if (furnaceLiveTotalSec && furnaceLiveTotalSec > 0) return furnaceLiveTotalSec;
          }
          const rate = Math.max(0.25, Math.min(4.0, bpm / (baseSongBpm || 125)));
          if (loadedAudioBuffer) {
            return loadedAudioBuffer.duration / rate;
          }
          if (loadedMidiBuffer) {
            if (midiLiveTotalSec && midiLiveTotalSec > 0) return midiLiveTotalSec;
            const parsedDur = parseDurationStringSec(trackDuration);
            if (parsedDur) return parsedDur / rate;
          }
          return null;
        })()}
        actualElapsedSeconds={loadedAudioBuffer || loadedMidiBuffer || loadedSidBuffer || loadedSunVoxBuffer || loadedFurBuffer || loadedFtmDiverted ? liveElapsedSec : null}
        onSeekPosition={(targetSeconds, ratio) => {
          pendingSeekRatioRef.current = ratio;
          setLiveElapsedSec(targetSeconds);
          if (loadedSidBuffer) {
            void seekSidPlayback(targetSeconds);
          } else if (loadedSunVoxBuffer) {
            seekSunVoxPlayback(targetSeconds);
          } else if (loadedFurBuffer || loadedFtmDiverted) {
            FurnaceBridge.seekToRatio(ratio);
          } else if (loadedMidiBuffer) {
            if (isPlaying) {
              seekMidiPlayback(ratio, bpm, baseSongBpm);
            } else {
              stopAllChannelsSound();
            }
          } else if (loadedAudioBuffer) {
            if (isPlaying) {
              const audioOffset = Math.max(
                0,
                Math.min(loadedAudioBuffer.duration - 0.05, ratio * loadedAudioBuffer.duration)
              );
              playDirectAudio(loadedAudioBuffer, audioOffset, () => {
                pendingSeekRatioRef.current = 0;
                setLiveElapsedSec(0);
                setCurrentPatternIndex(0);
                setActiveRow(0);
                setIsPlaying(false);
              });
              const rate = bpm / (baseSongBpm || 125);
              setAudioPlaybackRate(rate);
            } else {
              stopAllChannelsSound();
            }
          } else {
            // Pattern Sequencer mode: hard-silence any sustaining notes from the previous timestamp before the new row triggers
            stopAllChannelsSound();
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
              icon={<Sliders />} 
              tab="furnace" 
              active={activeTab} 
              setTab={setActiveTab} 
              label="Furnace" 
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
              glow={hardwareConnected}
            />
            <NavBtn 
              icon={<Users />} 
              tab="community" 
              active={activeTab} 
              setTab={setActiveTab} 
              label="CR Hub" 
              disabled={driveMode}
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
                  onSelectSidSubtune={async (sub) => {
                    pendingSeekRatioRef.current = 0;
                    setLiveElapsedSec(0);
                    setActiveRow(0);
                    setCurrentPatternIndex(0);
                    const ctx = getAudioContext();
                    await TinyRsidBridge.setSubtune(sub, ctx || undefined);
                    const updated = TinyRsidBridge.getState();
                    setSidRuntime(updated);
                    setTrackDuration(formatDuration(updated.durationSeconds));
                  }}
                  onImportTrack={(duration, title, chipType, importedBpm, octaveRange, channelsCount, allPatterns, audioBuffer, channelSoundFonts, rawMidiBuffer, fileName, rawSidBuffer, sidMetadata, rawSunVoxBuffer, rawFurnaceBuffer) => {
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
                      rawMidiBuffer,
                      fileName,
                      rawSidBuffer,
                      sidMetadata,
                      rawSunVoxBuffer,
                      rawFurnaceBuffer
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
              {activeTab === 'furnace' && (
                <FurnaceControlDeck />
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
              {activeTab === 'community' && (
                <ChiptuneRevolutionsHub />
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

      {/* 3-SECOND SOUNDFONT SWAP LOADING SCREEN */}
      {soundFontLoading.isLoading && (
        <div
          id="soundfont-loading-overlay"
          className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4"
        >
          <div className="w-full max-w-md bg-zinc-950 border border-cyan-500/45 rounded-2xl shadow-[0_0_50px_rgba(34,211,238,0.22)] p-6 flex flex-col items-center gap-4">
            <div className="text-[16px] font-black font-mono uppercase tracking-[0.22em] text-cyan-300 text-center">
              LOADING SOUNDFONT
            </div>
            <div className="text-[11px] font-mono text-zinc-400 truncate max-w-full text-center">
              {soundFontLoading.soundFontName || 'SoundFont Bank'}
            </div>

            <div className="w-full h-4 bg-zinc-900 border border-zinc-700/80 rounded-full overflow-hidden p-0.5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-sky-400 to-emerald-400 transition-[width] duration-75"
                style={{ width: `${Math.max(0, Math.min(100, soundFontLoading.progress))}%` }}
              />
            </div>

            <div className="w-full flex items-center justify-between text-[12px] font-mono font-bold tabular-nums text-zinc-200 px-1">
              <span className="text-cyan-400">{soundFontLoading.progress}%</span>
              <span className="text-zinc-400">
                {(soundFontLoading.elapsedMs / 1000).toFixed(1)}s / {(soundFontLoading.durationMs / 1000).toFixed(1)}s
              </span>
              <span className="text-amber-300">
                {Math.max(0, (soundFontLoading.durationMs - soundFontLoading.elapsedMs) / 1000).toFixed(1)}s
              </span>
            </div>
          </div>
        </div>
      )}
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
