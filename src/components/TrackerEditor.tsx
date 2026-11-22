import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Monitor, Music2, Edit3, HelpCircle, Volume2, Upload, Download, CheckCircle2, AlertCircle, Layers, Disc3, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Repeat, PlayCircle, Cpu, Activity, Star, Trash2, Check, Sliders, Zap } from 'lucide-react';
import { Channel, SoundFontInstrument, SoundEnginesConfig, SoundFontInterpolationMode } from '../types';
import {
  playNote,
  getSoundEnginesConfig,
  setSoundEnginesConfig,
  onSoundEnginesChange,
  loadSoundFontIntoCoreAndLib,
  isSoundFontFileName,
  SOUNDFONT_ACCEPT_ATTR,
  getDefaultSoundFontId,
  setDefaultSoundFontId,
  onDefaultSoundFontChange,
  deleteSavedSoundFont,
  SunVoxBridge,
  TinyRsidBridge,
  FurnaceBridge,
  NesWorkletEngine,
  MasterAudioRouter,
  getAudioContext,
  unlockAudioContextSync
} from './AudioEngine';
import { SidChipOverride, SidClockOverride } from '../engines/tinyRsidBridge';
import { NesMachineStandard } from '../lib/chips/nes/types';
import { describeDnFamiTrackerEffect } from '../lib/chips/nes/dnEffects';
import { SidHeaderMetadata, formatTimeMsPrecise } from '../utils/hvscManager';
import { SpessaSynth, SpessaSoundFont } from '../engines/spressasynthLib';
import {
  INTERPOLATION_MODES,
  getInterpolationMode,
  setInterpolationMode,
  onInterpolationModeChange
} from '../engines/soundFontInterpolation';
import { saveSelectedSoundFont } from '../utils/recentSongsManager';
import { parseChiptuneFileAsync } from '../utils/chiptuneParsers';
import { getAvailableSoundFontInstruments } from '../utils/soundFontEngine';
import {
  FURNACE_EFFECT_SPECS,
  describeFurnaceEffect,
  normalizeEffectToken
} from '../engines/FurnaceEffectTable';
import ExportStudioModal from './ExportStudioModal';
import SpessaMidiMixerPanel from './SpessaMidiMixerPanel';
import WasmEngineManagerModal from './WasmEngineManagerModal';
import { SequenceMetadataStrip } from './WebMidiDeckPanel';
import { addRecentSong } from '../utils/recentSongsManager';

interface TrackerEditorProps {
  channels: Channel[];
  setChannels?: React.Dispatch<React.SetStateAction<Channel[]>>;
  theme: string;
  activeRow: number;
  setActiveRow: (row: number) => void;
  isPlaying: boolean;
  patterns: any[];
  setPatterns: React.Dispatch<React.SetStateAction<any[]>>;
  songPatterns?: any[][];
  setSongPatterns?: React.Dispatch<React.SetStateAction<any[][]>>;
  currentPatternIndex?: number;
  setCurrentPatternIndex?: (idx: number) => void;
  playMode?: 'song' | 'pattern';
  setPlayMode?: (mode: 'song' | 'pattern') => void;
  bpm?: number;
  setBpm?: (bpm: number) => void;
  setIsPlaying?: (isPlaying: boolean) => void;
  trackTitle?: string | null;
  onSwitchChiptuneMode?: (mode: string) => void;
  currentChiptuneMode?: string;
  onSelectSidSubtune?: (subtune1Based: number) => void;
  onImportTrack?: (
    duration?: string, 
    title?: string, 
    chipType?: string, 
    bpm?: number, 
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
    rawFamiTrackerBuffer?: ArrayBuffer
  ) => void;
}

type ChannelBank = '1-8' | '9-16' | '17-24' | '25-32' | '33-48' | 'all';

export default function TrackerEditor({ 
  channels, 
  setChannels,
  theme, 
  activeRow, 
  setActiveRow, 
  isPlaying, 
  setIsPlaying,
  patterns, 
  setPatterns, 
  songPatterns,
  setSongPatterns,
  currentPatternIndex = 0,
  setCurrentPatternIndex,
  playMode = 'song',
  setPlayMode,
  bpm = 125,
  setBpm,
  trackTitle,
  onSwitchChiptuneMode,
  currentChiptuneMode = 'mod',
  onSelectSidSubtune,
  onImportTrack 
}: TrackerEditorProps) {
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number; field: 'note' | 'inst' | 'vol' | 'fx'; fxIndex?: number } | null>(null);
  const [selectedOctave, setSelectedOctave] = useState<number | 'all'>(4);
  const [selectedBank, setSelectedBank] = useState<ChannelBank>('1-8');
  const [showActiveOnly, setShowActiveOnly] = useState<boolean>(false);
  const [fxColumnsCount, setFxColumnsCount] = useState<number>(2);
  const [hoveredFxToken, setHoveredFxToken] = useState<string | null>(null);
  const [isWasmManagerOpen, setIsWasmManagerOpen] = useState<boolean>(false);
  const [soundFontInstruments, setSoundFontInstruments] = useState<SoundFontInstrument[]>([]);
  
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [pastedJson, setPastedJson] = useState('');
  const [importFeedback, setImportFeedback] = useState<{ success: boolean; msg: string } | null>(null);
  const fileInputRef2 = useRef<HTMLInputElement>(null);

  const [enginesConfig, setEnginesConfig] = useState<SoundEnginesConfig>(getSoundEnginesConfig());
  const [sidState, setSidState] = useState(() => TinyRsidBridge.getState());
  const [interpolationMode, setInterpolationModeState] = useState<SoundFontInterpolationMode>(getInterpolationMode());
  const [loadedSoundFonts, setLoadedSoundFonts] = useState<SpessaSoundFont[]>(() => SpessaSynth.getLoadedSoundFonts());
  const [activeSoundFontId, setActiveSoundFontId] = useState<string>(() => SpessaSynth.getActiveSoundFont()?.id || 'spessa-default-gm');
  const [defaultSoundFontId, setDefaultSoundFontState] = useState<string>(() => getDefaultSoundFontId());
  const [showSavedSoundFonts, setShowSavedSoundFonts] = useState<boolean>(false);
  const [showMidiMixer, setShowMidiMixer] = useState<boolean>(false);
  const [trackerBpmText, setTrackerBpmText] = useState((bpm || 125).toString());

  const [sunvoxState, setSunvoxState] = useState(() => SunVoxBridge.getState());
  const [furnaceState, setFurnaceState] = useState(() => FurnaceBridge.getState());
  const [famiTrackerState, setFamiTrackerState] = useState(() => NesWorkletEngine.getState());

  useEffect(() => {
    setTrackerBpmText((bpm || 125).toString());
  }, [bpm]);

  useEffect(() => {
    setSoundFontInstruments(getAvailableSoundFontInstruments());
    setLoadedSoundFonts(SpessaSynth.getLoadedSoundFonts());
    setActiveSoundFontId(SpessaSynth.getActiveSoundFont()?.id || 'spessa-default-gm');
    const unsubSf = SpessaSynth.onSoundFontChange((fonts, activeId) => {
      setLoadedSoundFonts(fonts);
      setActiveSoundFontId(activeId);
      setSoundFontInstruments(getAvailableSoundFontInstruments());
    });
    const unsubEngines = onSoundEnginesChange((newCfg) => {
      setEnginesConfig(newCfg);
    });
    const unsubInterp = onInterpolationModeChange((mode) => {
      setInterpolationModeState(mode);
    });
    const unsubDefSf = onDefaultSoundFontChange((id) => {
      setDefaultSoundFontState(id);
    });
    const unsubSid = TinyRsidBridge.subscribe((nextSid) => {
      setSidState(nextSid);
    });
    const unsubSunVox = SunVoxBridge.subscribe((nextSv) => {
      setSunvoxState(nextSv);
    });
    const unsubFurnace = FurnaceBridge.subscribe((nextFur) => {
      setFurnaceState(nextFur);
    });
    const unsubNes = NesWorkletEngine.subscribe((nextNes) => {
      setFamiTrackerState(nextNes);
    });
    return () => {
      unsubSf();
      unsubEngines();
      unsubInterp();
      unsubDefSf();
      unsubSid();
      unsubSunVox();
      unsubFurnace();
      unsubNes();
    };
  }, []);

  const handleToggleEngine = (engineKey: keyof SoundEnginesConfig) => {
    setSoundEnginesConfig({
      [engineKey]: !enginesConfig[engineKey]
    });
  };

  const handleEnableAllEngines = () => {
    setSoundEnginesConfig({
      spessaSynth: true,
      tinySynth: true,
      syntheticOsc: true,
      spessaSynthCore: true,
      tinyRSid: true,
      sunvox: true,
      furnace: true,
      famitracker: true
    });
  };

  const activeEnginesCount = [
    enginesConfig.spessaSynth,
    enginesConfig.tinySynth,
    enginesConfig.syntheticOsc,
    enginesConfig.spessaSynthCore,
    enginesConfig.tinyRSid,
    enginesConfig.sunvox,
    enginesConfig.furnace,
    enginesConfig.famitracker
  ].filter(Boolean).length;

  const handleTogglePatternChannelMute = (chId: number) => {
    if (!setChannels) return;
    setChannels(prev => prev.map(c => (c.id === chId ? { ...c, mute: !c.mute } : c)));
  };

  const handleTogglePatternChannelSolo = (chId: number) => {
    if (!setChannels) return;
    setChannels(prev => prev.map(c => (c.id === chId ? { ...c, solo: !c.solo } : c)));
  };

  const totalPatterns = songPatterns?.length || 1;
  const currentPatternRows = (songPatterns && songPatterns[currentPatternIndex]) ? songPatterns[currentPatternIndex] : patterns;

  // Filter channels based on selected bank and active filter
  const visibleChannels = channels.filter(ch => {
    if (showActiveOnly && !ch.enabled) return false;
    if (selectedBank === 'all') return true;
    if (selectedBank === '1-8') return ch.id >= 1 && ch.id <= 8;
    if (selectedBank === '9-16') return ch.id >= 9 && ch.id <= 16;
    if (selectedBank === '17-24') return ch.id >= 17 && ch.id <= 24;
    if (selectedBank === '25-32') return ch.id >= 25 && ch.id <= 32;
    if (selectedBank === '33-48') return ch.id >= 33 && ch.id <= 48;
    return true;
  });

  const handleImportJson = (jsonString: string) => {
    try {
      const parsed = JSON.parse(jsonString);
      if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
        // Multi-pattern array
        if (setSongPatterns) setSongPatterns(parsed);
        setPatterns(parsed[0]);
        if (setCurrentPatternIndex) setCurrentPatternIndex(0);
      } else if (Array.isArray(parsed) && parsed.length === 64) {
        setPatterns(parsed);
        if (setSongPatterns) setSongPatterns([parsed]);
      } else {
        throw new Error("Invalid structure: Expecting 64 rows pattern array or multi-pattern sequence");
      }
      
      setImportFeedback({ success: true, msg: "Sequence imported successfully! 64 synthesizers matrix coordinates loaded." });
      setTimeout(() => {
        setIsImportModalOpen(false);
        setImportFeedback(null);
        setPastedJson('');
      }, 1500);
    } catch (err: any) {
      setImportFeedback({ success: false, msg: `Fail: ${err.message || "Invalid syntax configuration"}` });
    }
  };

  const importSelectedFile = (selected: File) => {
    unlockAudioContextSync();
    const extension = selected.name.includes('.')
      ? selected.name.substring(selected.name.lastIndexOf('.')).toLowerCase()
      : '';

    if (isSoundFontFileName(selected.name)) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        if (event.target?.result instanceof ArrayBuffer) {
          try {
            const { soundFont: spessaSf } = await loadSoundFontIntoCoreAndLib(event.target.result, selected.name);
            saveSelectedSoundFont(spessaSf.id);
            setSoundFontInstruments(getAvailableSoundFontInstruments());
            setImportFeedback({
              success: true,
              msg: `Loaded SoundFont "${spessaSf.name}" (${spessaSf.format || 'SoundBank'}, ${spessaSf.instrumentCount} presets) via spressasynth_core -> spressasynth_lib!`
            });
            setTimeout(() => {
              setIsImportModalOpen(false);
              setImportFeedback(null);
            }, 2500);
          } catch (err: any) {
            setImportFeedback({
              success: false,
              msg: `SoundFont parsing error: ${err.message || "Invalid SoundFont file"}`
            });
          }
        }
      };
      reader.readAsArrayBuffer(selected);
      return;
    }

    if (extension === '.json') {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result && typeof event.target.result === 'string') {
          handleImportJson(event.target.result);
        }
      };
      reader.readAsText(selected);
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      if (event.target?.result instanceof ArrayBuffer) {
        try {
          const result = await parseChiptuneFileAsync(selected.name, event.target.result);

          if (result.allPatterns && setSongPatterns) {
            setSongPatterns(result.allPatterns);
          }
          setPatterns(result.patterns);
          if (setCurrentPatternIndex) setCurrentPatternIndex(0);

          if (onImportTrack) {
            onImportTrack(
              result.duration,
              result.title,
              result.chipType,
              result.bpm,
              result.octaveRange,
              result.channelsCount,
              result.allPatterns,
              result.audioBuffer,
              result.channelSoundFonts,
              result.rawMidiBuffer,
              result.fileName || selected.name,
              result.rawSidBuffer,
              result.sidMetadata,
              result.rawSunVoxBuffer,
              result.rawFamiTrackerBuffer
            );
          }
          addRecentSong({
            title: result.title || selected.name,
            chipType: result.chipType,
            duration: result.duration,
            bpm: result.bpm,
            channelsCount: result.channelsCount,
            octaveRange: result.octaveRange,
            patterns: result.patterns,
            allPatterns: result.allPatterns,
            channelSoundFonts: result.channelSoundFonts
          });
          const durationInfo = result.duration ? ` (Length: ${result.duration})` : "";
          const patsCount = result.allPatterns?.length || 1;
          setImportFeedback({
            success: true,
            msg: `Imported "${result.title || selected.name}"${durationInfo} [${result.chipType}] with ${patsCount} sequential patterns & ${result.channelsCount || 8} channels!`
          });
          if (result.channelsCount && result.channelsCount > 8) {
            setSelectedBank('all');
          }
          setTimeout(() => {
            setIsImportModalOpen(false);
            setImportFeedback(null);
            setPastedJson('');
          }, 2500);
        } catch (err: any) {
          setImportFeedback({
            success: false,
            msg: `Failed translating sequence: ${err.message || 'Incorrect format layout.'}`
          });
        }
      }
    };
    reader.readAsArrayBuffer(selected);
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    unlockAudioContextSync();
    const inputEl = e.target;
    if (inputEl.files && inputEl.files[0]) {
      importSelectedFile(inputEl.files[0]);
      inputEl.value = '';
    }
  };

  const handleExportJson = () => {
    const dataToExport = songPatterns && songPatterns.length > 1 ? songPatterns : patterns;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(dataToExport, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "aria48_sequencer_patterns.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);
  const sfDirectInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return SpessaSynth.onSoundFontChange((fonts, activeId) => {
      setSoundFontInstruments(getAvailableSoundFontInstruments());
      setLoadedSoundFonts(fonts);
      setActiveSoundFontId(activeId);
    });
  }, []);

  const handleDirectSoundFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    unlockAudioContextSync();
    const inputEl = e.target;
    if (inputEl.files && inputEl.files[0]) {
      const file = inputEl.files[0];
      const reader = new FileReader();
      reader.onload = async (evt) => {
        if (evt.target?.result instanceof ArrayBuffer) {
          try {
            const { soundFont: spessaSf } = await loadSoundFontIntoCoreAndLib(evt.target.result, file.name);
            saveSelectedSoundFont(spessaSf.id);
            const updatedInstruments = getAvailableSoundFontInstruments();
            setSoundFontInstruments(updatedInstruments);

            const customInsts = updatedInstruments.filter(i => i.id.startsWith('core_sf_'));
            if (setChannels && channels && customInsts.length > 0) {
              setChannels(prev => prev.map((ch, idx) => {
                const isDrum = idx === 9 || ch.soundFontPreset === 'gm_drums' || ch.soundFontPreset === 'gm_electronic_drums';
                const currentInst = updatedInstruments.find(i => i.id === ch.soundFontPreset);
                const targetProg = currentInst?.program ?? (idx % 16);
                const matched =
                  (isDrum ? customInsts.find(i => i.bank === 128 && i.program === 0) || customInsts.find(i => i.bank === 128) : undefined) ||
                  customInsts.find(i => i.bank !== 128 && i.program === targetProg) ||
                  customInsts.find(i => i.bank !== 128) ||
                  customInsts[idx % customInsts.length];
                return {
                  ...ch,
                  chip: 'General MIDI (SoundFont)',
                  soundFontPreset: matched ? matched.id : ch.soundFontPreset
                };
              }));
            }
            setImportFeedback({
              success: true,
              msg: `SoundFont "${spessaSf.name}" (${spessaSf.format || 'SoundBank'}, ${spessaSf.instrumentCount} Presets) decoded by spressasynth_core-master.zip and linked to spressasynth_lib!`
            });
            setTimeout(() => setImportFeedback(null), 3500);
          } catch (err: any) {
            setImportFeedback({
              success: false,
              msg: `Failed to load SoundFont: ${err.message}`
            });
            setTimeout(() => setImportFeedback(null), 3500);
          }
        }
        inputEl.value = '';
      };
      reader.readAsArrayBuffer(file);
    }
  };

  // Auto-scroll ONLY the tracker grid container (never leaking to page/other scrollbars)
  useEffect(() => {
    if (!isPlaying) return;
    const parent = containerRef.current;
    const child = activeRowRef.current;
    if (!parent || !child) return;

    const parentRect = parent.getBoundingClientRect();
    const childRect = child.getBoundingClientRect();
    const currentTopInParent = childRect.top - parentRect.top;
    const visibleTop = 72;
    const visibleBottom = parent.clientHeight - 48;

    if (currentTopInParent < visibleTop || currentTopInParent > visibleBottom) {
      const delta = currentTopInParent - (parent.clientHeight / 2 - childRect.height / 2);
      const maxScroll = Math.max(0, parent.scrollHeight - parent.clientHeight);
      parent.scrollTop = Math.max(0, Math.min(maxScroll, parent.scrollTop + delta));
    }
  }, [activeRow, isPlaying]);

  const selectNoteList = useMemo(() => {
    const chrom = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
    const notes: string[] = [];
    const startOct = selectedOctave === 'all' ? 0 : selectedOctave;
    const endOct = selectedOctave === 'all' ? 7 : selectedOctave;
    for (let oct = startOct; oct <= endOct; oct++) {
      for (const n of chrom) {
        notes.push(`${n}${oct}`);
      }
    }
    notes.push('===', 'OFF', '---');
    return notes;
  }, [selectedOctave]);

  const handleCellClick = (rowIndex: number, chId: number, field: 'note' | 'inst' | 'vol' | 'fx', fxIndex?: number) => {
    setSelectedCell({ row: rowIndex, col: chId, field, fxIndex });
    
    // Play pitch instantly on click to preview
    const cellValue = currentPatternRows[rowIndex]?.[chId];
    if (cellValue && cellValue.note !== "---" && cellValue.note !== "===" && cellValue.note !== "OFF" && field === 'note') {
      const ch = channels.find(c => c.id === chId);
      if (ch) {
        const parsedInst = cellValue.inst && cellValue.inst !== '..' ? parseInt(cellValue.inst, 16) : -1;
        playNote(chId, ch.chip, cellValue.note, 0.25, ch.volume, ch.pan, ch.soundFontPreset, Number.isNaN(parsedInst) ? -1 : parsedInst);
      }
    }
  };

  const updateCellEffect = (rowIndex: number, chId: number, fxIndex: number, rawToken: string) => {
    const token = normalizeEffectToken(rawToken);
    const updatePat = (prevPat: any[]) => {
      const updated = [...prevPat];
      const prevCell = updated[rowIndex]?.[chId] || { note: '---', inst: '..', vol: '..', delay: '000' };
      const fxArr = Array.isArray(prevCell.fx) ? [...prevCell.fx] : ['....', '....', '....', '....'];
      while (fxArr.length < 4) fxArr.push('....');
      fxArr[fxIndex] = token;
      updated[rowIndex] = {
        ...updated[rowIndex],
        [chId]: {
          ...prevCell,
          fx: fxArr,
        }
      };
      return updated;
    };

    if (songPatterns && setSongPatterns) {
      setSongPatterns(prev => {
        const copy = [...prev];
        copy[currentPatternIndex] = updatePat(copy[currentPatternIndex]);
        return copy;
      });
    } else {
      setPatterns(prev => updatePat(prev));
    }

    if (token !== '....') {
      MasterAudioRouter.routeEffect(chId, token, 'FURNACE');
    }
  };

  const updateCellNote = (rowIndex: number, chId: number, newNote: string) => {
    const updatePat = (prevPat: any[]) => {
      const updated = [...prevPat];
      updated[rowIndex] = {
        ...updated[rowIndex],
        [chId]: {
          ...updated[rowIndex][chId],
          note: newNote,
          inst: updated[rowIndex][chId]?.inst === '..' ? '01' : updated[rowIndex][chId]?.inst
        }
      };
      return updated;
    };

    if (songPatterns && setSongPatterns) {
      setSongPatterns(prev => {
        const copy = [...prev];
        copy[currentPatternIndex] = updatePat(copy[currentPatternIndex]);
        return copy;
      });
    } else {
      setPatterns(prev => updatePat(prev));
    }

    if (newNote !== '---' && newNote !== '===' && newNote !== 'OFF') {
      const ch = channels.find(c => c.id === chId);
      if (ch) {
        const cellInst = currentPatternRows[rowIndex]?.[chId]?.inst;
        const parsedInst = cellInst && cellInst !== '..' ? parseInt(cellInst, 16) : -1;
        playNote(chId, ch.chip, newNote, 0.25, ch.volume, ch.pan, ch.soundFontPreset, Number.isNaN(parsedInst) ? -1 : parsedInst);
      }
    }
  };

  const updateChannelInstrument = (chId: number, presetId: string) => {
    if (setChannels) {
      setChannels(prev => prev.map(ch => {
        if (ch.id === chId) {
          return {
            ...ch,
            soundFontPreset: presetId,
            chip: presetId ? 'General MIDI (SoundFont)' : ch.chip
          };
        }
        return ch;
      }));
    }
  };

  const groupedInstruments = useMemo(() => {
    const groups: { category: string; instruments: SoundFontInstrument[] }[] = [];
    const map = new Map<string, SoundFontInstrument[]>();
    for (const inst of soundFontInstruments) {
      const cat = inst.category || (inst.isCustom ? 'Custom SF2 Presets' : 'General MIDI');
      let list = map.get(cat);
      if (!list) {
        list = [];
        map.set(cat, list);
        groups.push({ category: cat, instruments: list });
      }
      list.push(inst);
    }
    return groups;
  }, [soundFontInstruments]);

  // Keyboard navigation inside tracker matrix
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedCell) return;
      const { row, col, field } = selectedCell;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCell({ row: Math.max(0, row - 1), col, field });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCell({ row: Math.min(63, row + 1), col, field });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const currentIdx = visibleChannels.findIndex(c => c.id === col);
        if (currentIdx > 0) {
          setSelectedCell({ row, col: visibleChannels[currentIdx - 1].id, field });
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const currentIdx = visibleChannels.findIndex(c => c.id === col);
        if (currentIdx >= 0 && currentIdx < visibleChannels.length - 1) {
          setSelectedCell({ row, col: visibleChannels[currentIdx + 1].id, field });
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        updateCellNote(row, col, '---');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedCell, visibleChannels]);

  return (
    <div className="h-full flex flex-col font-mono select-none">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Monitor className="text-cyan-400 w-5 h-5" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-white">Chiptune & Universal Pattern Sequencer</h2>
        </div>
        
        {/* Actions bar with Import and Export */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* MULTI-PATTERN NAVIGATOR */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-900 border border-zinc-800 rounded-lg text-xs">
            <button
              onClick={() => setCurrentPatternIndex && setCurrentPatternIndex(Math.max(0, currentPatternIndex - 1))}
              disabled={currentPatternIndex <= 0}
              className="p-1 hover:text-white text-zinc-400 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              title="Previous Pattern"
            >
              <ChevronLeft size={13} />
            </button>
            <span className="text-[10.5px] font-bold text-white tracking-wider">
              PAT <span className="text-cyan-400">{(currentPatternIndex + 1).toString().padStart(2, '0')}</span> / {totalPatterns.toString().padStart(2, '0')}
            </span>
            <button
              onClick={() => setCurrentPatternIndex && setCurrentPatternIndex(Math.min(totalPatterns - 1, currentPatternIndex + 1))}
              disabled={currentPatternIndex >= totalPatterns - 1}
              className="p-1 hover:text-white text-zinc-400 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              title="Next Pattern"
            >
              <ChevronRight size={13} />
            </button>
            
            {/* Play Mode Toggle */}
            <button
              onClick={() => setPlayMode && setPlayMode(playMode === 'song' ? 'pattern' : 'song')}
              className={`ml-2 px-2 py-0.5 rounded text-[9.5px] font-bold flex items-center gap-1 transition uppercase cursor-pointer ${
                playMode === 'song' 
                  ? 'bg-emerald-950/70 border border-emerald-700/60 text-emerald-400' 
                  : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
              }`}
              title={playMode === 'song' ? 'Song Mode: Automatically advances through all patterns in chronological order' : 'Pattern Loop Mode: Loops only current 64 rows'}
            >
              {playMode === 'song' ? <PlayCircle size={10} /> : <Repeat size={10} />}
              <span>{playMode === 'song' ? 'Full Song' : 'Loop Pat'}</span>
            </button>
          </div>

          {/* TRACKER BPM CONTROLLER */}
          <div className="flex items-center gap-1 px-2 py-1 bg-zinc-900 border border-zinc-800 rounded-lg text-xs">
            <span className="text-zinc-500 text-[9.5px] uppercase font-bold tracking-wider mr-0.5">BPM</span>
            <button
              id="tracker-bpm-decrement-btn"
              type="button"
              onClick={(e) => {
                const step = e.shiftKey ? -5 : -1;
                const next = Math.max(30, Math.min(320, (bpm || 125) + step));
                setBpm?.(next);
                setTrackerBpmText(next.toString());
              }}
              className="w-5 h-5 flex items-center justify-center bg-zinc-950 hover:bg-zinc-800 text-zinc-300 hover:text-cyan-400 rounded border border-zinc-800 cursor-pointer text-xs active:scale-95 transition"
              title="Decrease BPM (-1, Shift+Click: -5)"
            >
              -
            </button>
            <input
              id="tracker-bpm-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={trackerBpmText}
              onChange={(e) => {
                const text = e.target.value.replace(/[^0-9]/g, '');
                setTrackerBpmText(text);
                if (text.length >= 2) {
                  const n = parseInt(text, 10);
                  if (n >= 30 && n <= 320) {
                    setBpm?.(n);
                  }
                }
              }}
              onBlur={() => {
                const parsed = parseInt(trackerBpmText, 10);
                if (!isNaN(parsed) && parsed > 0) {
                  const clamped = Math.max(30, Math.min(320, parsed));
                  setBpm?.(clamped);
                  setTrackerBpmText(clamped.toString());
                } else {
                  setTrackerBpmText((bpm || 125).toString());
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const parsed = parseInt(trackerBpmText, 10);
                  if (!isNaN(parsed) && parsed > 0) {
                    const clamped = Math.max(30, Math.min(320, parsed));
                    setBpm?.(clamped);
                    setTrackerBpmText(clamped.toString());
                  }
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  const next = Math.max(30, Math.min(320, (bpm || 125) + (e.shiftKey ? 5 : 1)));
                  setBpm?.(next);
                  setTrackerBpmText(next.toString());
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  const next = Math.max(30, Math.min(320, (bpm || 125) + (e.shiftKey ? -5 : -1)));
                  setBpm?.(next);
                  setTrackerBpmText(next.toString());
                }
              }}
              onWheel={(e) => {
                e.preventDefault();
                const next = Math.max(30, Math.min(320, (bpm || 125) + (e.deltaY < 0 ? 1 : -1)));
                setBpm?.(next);
                setTrackerBpmText(next.toString());
              }}
              className="w-11 bg-black border border-zinc-800 focus:border-cyan-500 rounded px-1 py-0.5 text-center font-mono font-bold text-cyan-300 text-[11px] focus:outline-none select-all"
              title="Click & type, use arrow keys, or scroll wheel to adjust BPM"
            />
            <button
              id="tracker-bpm-increment-btn"
              type="button"
              onClick={(e) => {
                const step = e.shiftKey ? 5 : 1;
                const next = Math.max(30, Math.min(320, (bpm || 125) + step));
                setBpm?.(next);
                setTrackerBpmText(next.toString());
              }}
              className="w-5 h-5 flex items-center justify-center bg-zinc-950 hover:bg-zinc-800 text-zinc-300 hover:text-cyan-400 rounded border border-zinc-800 cursor-pointer text-xs active:scale-95 transition"
              title="Increase BPM (+1, Shift+Click: +5)"
            >
              +
            </button>
          </div>

          <button 
            onClick={() => {
              unlockAudioContextSync();
              setIsImportModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-950/50 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/60 rounded-lg text-[10.5px] font-bold uppercase transition tracking-wider cursor-pointer shadow-sm"
            title="Import MIDI (.mid/.rmi/.kar/.xmf), MOD, XM, S3M, IT, SID, NSF, SF2 into tracking matrix"
          >
            <Upload size={12} />
            <span>Universal Import</span>
          </button>
          
          <button 
            id="tracker-export-studio-btn"
            onClick={() => setIsExportModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-950/45 text-cyan-300 border border-cyan-800/50 hover:bg-cyan-900/60 rounded-lg text-[10.5px] font-bold uppercase transition tracking-wider cursor-pointer shadow-sm"
            title="Export Studio: Chiptunes (.mod, .xm, .mid), Video Recordings, and SoundFonts (.sf2, .sf3)"
          >
            <Download size={12} className="text-cyan-400" />
            <span>Export Studio</span>
          </button>

          {/* DEDICATED BUTTON TO ADD SOUNDFONTS INTO SPRESSASYNTH_CORE -> SPRESSASYNTH_LIB */}
          <button
            id="tracker-add-soundfont-btn"
            onClick={() => sfDirectInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-950/50 text-emerald-300 border border-emerald-600/50 hover:bg-emerald-900/60 rounded-lg text-[10.5px] font-bold uppercase transition tracking-wider cursor-pointer shadow-sm"
            title="Load any SoundBank (.sf2, .sf3, .dls, .sfe, .sfz, .sbk, .gig, .pat, .sfpack) into spressasynth_core -> spressasynth_lib"
          >
            <Disc3 size={12} className="text-emerald-400 animate-pulse" />
            <span>+ SoundFont</span>
          </button>
          <button
            id="tracker-saved-soundfonts-toggle-btn"
            type="button"
            onClick={() => setShowSavedSoundFonts(prev => !prev)}
            aria-expanded={showSavedSoundFonts}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10.5px] font-bold uppercase transition tracking-wider cursor-pointer shadow-sm border ${
              showSavedSoundFonts
                ? 'bg-emerald-900/60 text-emerald-200 border-emerald-500/70'
                : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:bg-zinc-800 hover:text-emerald-300'
            }`}
            title="Show or hide Saved SoundFonts and Set Default controls"
          >
            <Disc3 size={12} className="text-emerald-400" />
            <span>Saved SoundFonts ({loadedSoundFonts.length})</span>
            {showSavedSoundFonts ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          <button
            id="tracker-midi-mixer-toggle-btn"
            type="button"
            onClick={() => setShowMidiMixer(prev => !prev)}
            aria-expanded={showMidiMixer}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10.5px] font-bold uppercase transition tracking-wider cursor-pointer shadow-sm border ${
              showMidiMixer
                ? 'bg-indigo-900/70 text-indigo-100 border-indigo-400/80 shadow-[0_0_12px_rgba(99,102,241,0.3)]'
                : 'bg-indigo-950/45 text-indigo-300 border-indigo-700/60 hover:bg-indigo-900/60 hover:text-white'
            }`}
            title="Show or hide the per-channel SpessaSynth WorkletSynthesizer MIDI Controller & Instrument Mixer"
          >
            <Sliders size={12} className="text-indigo-400" />
            <span>MIDI Mixer (CH 1-48)</span>
            {showMidiMixer ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          <input
            type="file"
            ref={sfDirectInputRef}
            accept={SOUNDFONT_ACCEPT_ATTR}
            className="hidden"
            onChange={handleDirectSoundFontUpload}
          />

          <span className="flex items-center gap-1 text-[10px] text-zinc-500 pl-2 border-l border-zinc-800">
            <Volume2 size={12} className="text-cyan-400"/> Click cell to edit
          </span>
        </div>
      </div>

      {/* SOUND ENGINES RACK (ENABLE / DISABLE SPECIFIC ENGINES) */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-zinc-950/85 border border-zinc-850 rounded-lg text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-amber-400 font-bold text-[10px] uppercase tracking-wider pr-1">
            <Cpu size={13} className="text-amber-400" />
            <span>Sound Engines:</span>
          </div>

          {/* SpessaSynth Engine */}
          <button
            id="engine-toggle-spessasynth"
            onClick={() => handleToggleEngine('spessaSynth')}
            className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
              enginesConfig.spessaSynth
                ? 'bg-emerald-950/70 border-emerald-500/60 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.25)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-60'
            }`}
            title={enginesConfig.spessaSynth ? 'SpessaSynth (SF2 SoundFont & 16-CH MIDI): ACTIVE. Click to disable.' : 'SpessaSynth: MUTED. Click to enable.'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${enginesConfig.spessaSynth ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]' : 'bg-zinc-600'}`} />
            <span>SpessaSynth (SF2)</span>
          </button>

          {/* WebAudio TinySynth Engine */}
          <button
            id="engine-toggle-tinysynth"
            onClick={() => handleToggleEngine('tinySynth')}
            className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
              enginesConfig.tinySynth
                ? 'bg-amber-950/70 border-amber-500/60 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.25)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-60'
            }`}
            title={enginesConfig.tinySynth ? 'WebAudio TinySynth (GM FM Synth): ACTIVE. Click to disable.' : 'TinySynth: MUTED. Click to enable.'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${enginesConfig.tinySynth ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]' : 'bg-zinc-600'}`} />
            <span>TinySynth (GM)</span>
          </button>

          {/* Synthetic Oscillators Engine */}
          <button
            id="engine-toggle-syntheticosc"
            onClick={() => handleToggleEngine('syntheticOsc')}
            className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
              enginesConfig.syntheticOsc
                ? 'bg-cyan-950/70 border-cyan-500/60 text-cyan-300 shadow-[0_0_8px_rgba(6,182,212,0.25)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-60'
            }`}
            title={enginesConfig.syntheticOsc ? 'Synthetic Oscillators (YM2612, SID, Paula, DMG, AY-3): ACTIVE. Click to disable.' : 'Synthetic Oscillators: MUTED. Click to enable.'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${enginesConfig.syntheticOsc ? 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]' : 'bg-zinc-600'}`} />
            <span>Chip Osc (Synth)</span>
          </button>

          {/* spressasynth_core SoundFont Core & Tracker Core Engine */}
          <button
            id="engine-toggle-spressasynth-core"
            onClick={() => handleToggleEngine('spessaSynthCore')}
            className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
              enginesConfig.spessaSynthCore
                ? 'bg-fuchsia-950/70 border-fuchsia-500/60 text-fuchsia-300 shadow-[0_0_8px_rgba(217,70,239,0.25)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-60'
            }`}
            title={enginesConfig.spessaSynthCore ? 'spressasynth_core (SoundFont Core, PCM Voice Resolver & MOD/XM/S3M Core): ACTIVE. Click to disable.' : 'spressasynth_core: MUTED. Click to enable.'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${enginesConfig.spessaSynthCore ? 'bg-fuchsia-400 shadow-[0_0_6px_rgba(232,121,249,0.8)]' : 'bg-zinc-600'}`} />
            <span>spressasynth_core</span>
          </button>

          {/* TinyRSid (WebSID Commodore 64 Multi-SID Emulator) */}
          <button
            id="engine-toggle-tinyrsid"
            onClick={() => handleToggleEngine('tinyRSid')}
            className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
              enginesConfig.tinyRSid
                ? 'bg-sky-950/75 border-sky-500/70 text-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.28)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-60'
            }`}
            title={enginesConfig.tinyRSid ? 'TinyRSid (WebSID WASM Commodore 64 1SID/2SID/3SID Emulator): ACTIVE. Click to mute.' : 'TinyRSid (SID): MUTED. Click to enable.'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${enginesConfig.tinyRSid ? 'bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.9)]' : 'bg-zinc-600'}`} />
            <span>TinyRSid (SID)</span>
          </button>

          {/* SunVox Modular WASM Engine */}
          <button
            id="engine-toggle-sunvox"
            onClick={() => handleToggleEngine('sunvox')}
            className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
              enginesConfig.sunvox
                ? 'bg-violet-950/75 border-violet-500/70 text-violet-300 shadow-[0_0_8px_rgba(139,92,246,0.28)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-60'
            }`}
            title={enginesConfig.sunvox ? `SunVox v${sunvoxState.engineVersion || '2.1.4'} WASM Modular Engine (.sunvox / .sunsynth): ACTIVE. Click to mute.` : 'SunVox WASM: MUTED. Click to enable.'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${enginesConfig.sunvox ? 'bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.9)]' : 'bg-zinc-600'}`} />
            <span>SunVox {sunvoxState.engineVersion || '2.1.4'}</span>
          </button>

          {/* Furnace Headless WASM Engine */}
          <button
            id="engine-toggle-furnace"
            onClick={() => handleToggleEngine('furnace')}
            className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
              enginesConfig.furnace
                ? 'bg-teal-950/75 border-teal-500/70 text-teal-300 shadow-[0_0_8px_rgba(20,184,166,0.28)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-60'
            }`}
            title={
              furnaceState.wasmStatus === 'ready'
                ? 'Furnace WASM DivEngine: READY. Click to mute.'
                : 'Furnace WASM DivEngine: Enable/open WASM Manager to attach aria_furnace_all.js'
            }
          >
            <span className={`w-1.5 h-1.5 rounded-full ${enginesConfig.furnace ? (furnaceState.wasmStatus === 'ready' ? 'bg-teal-400' : 'bg-amber-400') : 'bg-zinc-600'}`} />
            <span>Furnace WASM</span>
          </button>

          {/* FamiTracker / Dn-FamiTracker + bitphase nes_apu.wasm Engine */}
          <button
            id="engine-toggle-famitracker"
            onClick={() => handleToggleEngine('famitracker')}
            className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
              enginesConfig.famitracker
                ? 'bg-rose-950/75 border-rose-500/70 text-rose-200 shadow-[0_0_8px_rgba(244,63,94,0.28)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-60'
            }`}
            title={
              famiTrackerState.wasmLoaded
                ? 'FamiTracker / Dn-FamiTracker (nes_apu.wasm): READY. Click to mute.'
                : 'FamiTracker / Dn-FamiTracker (2A03 + VRC6/VRC7/FDS/MMC5/N163/5B Worklet DSP): ACTIVE. Click to mute.'
            }
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                enginesConfig.famitracker
                  ? famiTrackerState.wasmLoaded
                    ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]'
                    : 'bg-rose-400 shadow-[0_0_6px_rgba(251,113,133,0.9)]'
                  : 'bg-zinc-600'
              }`}
            />
            <span>FamiTracker (NES)</span>
          </button>

          <button
            id="tracker-wasm-manager-btn"
            type="button"
            onClick={() => setIsWasmManagerOpen(true)}
            className="px-2 py-1 rounded text-[10px] font-semibold bg-zinc-900 hover:bg-zinc-800 text-cyan-300 border border-zinc-700 cursor-pointer"
            title="Inspect and hot-swap WASM engine bundles (nes_apu.wasm, aria_furnace_all.js, tinyrsid.js, sunvox.js)"
          >
            WASM Manager
          </button>

          {(sunvoxState.hasSunVoxLoaded || sunvoxState.isLoading || sunvoxState.error) && (
            <div
              id="sunvox-status-badge"
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-mono border ${
                sunvoxState.error
                  ? 'bg-red-950/70 border-red-600/60 text-red-200'
                  : 'bg-violet-950/60 border-violet-600/50 text-violet-200'
              }`}
              title={sunvoxState.error || `SunVox v${sunvoxState.engineVersion} Project: ${sunvoxState.songName} (${sunvoxState.moduleCount} modules, ${sunvoxState.patternCount} patterns, ${sunvoxState.totalLines} lines)`}
            >
              {sunvoxState.error ? (
                <span className="truncate max-w-[240px]">SunVox Err: {sunvoxState.error}</span>
              ) : sunvoxState.isLoading ? (
                <span>Initializing SunVox {sunvoxState.engineVersion} WASM...</span>
              ) : (
                <>
                  <span className="font-bold text-violet-300 truncate max-w-[140px]">{sunvoxState.songName}</span>
                  <span className="text-zinc-500">·</span>
                  <span>{sunvoxState.bpm} BPM</span>
                  <span className="text-zinc-500">·</span>
                  <span>Line {sunvoxState.currentLine}/{sunvoxState.totalLines}</span>
                  <span className="text-zinc-500">·</span>
                  <span>{sunvoxState.moduleCount} Mods</span>
                </>
              )}
            </div>
          )}

          {/* INLINE TINYRSSID CONTROLS WHENEVER A .SID FILE IS LOADED OR TINYRSSID IS ACTIVE */}
          {(sidState.hasSidLoaded || enginesConfig.tinyRSid) && (
            <div className="flex flex-wrap items-center gap-1.5 pl-1 border-l border-zinc-800">
              {/* Dual Chip Emulation Toggle (AUTO | MOS 6581 | MOS 8580) */}
              <div
                id="sid-chip-model-pills"
                className="flex items-center bg-zinc-900 border border-zinc-800 rounded p-0.5 text-[9px] font-bold"
                title={sidState.metadata ? `Header SID Model: ${sidState.metadata.chipModel}` : 'Live SID chip filter emulation'}
              >
                {([
                  { id: 'auto', label: 'AUTO' },
                  { id: '6581', label: 'MOS 6581' },
                  { id: '8580', label: 'MOS 8580' }
                ] as { id: SidChipOverride; label: string }[]).map((opt) => {
                  const active = sidState.chipModelOverride === opt.id;
                  return (
                    <button
                      key={opt.id}
                      id={`sid-chip-pill-${opt.id}`}
                      type="button"
                      onClick={() => TinyRsidBridge.setChipModelOverride(opt.id)}
                      className={`px-1.5 py-0.5 rounded transition cursor-pointer ${
                        active
                          ? 'bg-sky-600 text-white shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {opt.id === 'auto' && sidState.hasSidLoaded
                        ? `AUTO (${sidState.activeChipModel.replace('MOS ', '')})`
                        : opt.label}
                    </button>
                  );
                })}
              </div>

              {/* Clock Speed & Region Toggle (AUTO | PAL 50Hz | NTSC 60Hz) */}
              <div
                id="sid-clock-pills"
                className="flex items-center bg-zinc-900 border border-zinc-800 rounded p-0.5 text-[9px] font-bold"
                title={sidState.metadata ? `Header Clock: ${sidState.metadata.clock}` : 'PAL 50Hz / NTSC 60Hz speed override'}
              >
                {([
                  { id: 'auto', label: 'AUTO' },
                  { id: 'pal', label: 'PAL 50Hz' },
                  { id: 'ntsc', label: 'NTSC 60Hz' }
                ] as { id: SidClockOverride; label: string }[]).map((opt) => {
                  const active = sidState.clockOverride === opt.id;
                  return (
                    <button
                      key={opt.id}
                      id={`sid-clock-pill-${opt.id}`}
                      type="button"
                      onClick={() => {
                        TinyRsidBridge.setClockOverride(opt.id);
                        if (sidState.hasSidLoaded && setBpm) {
                          const nextState = TinyRsidBridge.getState();
                          setBpm(nextState.activeClock === 'NTSC 60Hz' ? 144 : 125);
                        }
                      }}
                      className={`px-1.5 py-0.5 rounded transition cursor-pointer ${
                        active
                          ? 'bg-emerald-600 text-white shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {opt.id === 'auto' && sidState.hasSidLoaded
                        ? `AUTO (${sidState.activeClock === 'NTSC 60Hz' ? 'NTSC' : 'PAL'})`
                        : opt.label}
                    </button>
                  );
                })}
              </div>

              {/* Subtune Selector Dropdown (Subtune 1 / N) */}
              {sidState.hasSidLoaded && (
                <select
                  id="sid-subtune-select"
                  value={sidState.currentSubtune}
                  onChange={(e) => {
                    unlockAudioContextSync();
                    const sub = parseInt(e.target.value, 10) || 1;
                    if (onSelectSidSubtune) {
                      onSelectSidSubtune(sub);
                    } else {
                      const ctx = getAudioContext();
                      void TinyRsidBridge.setSubtune(sub, ctx || undefined);
                    }
                  }}
                  className="bg-black border border-sky-700/60 rounded px-2 py-0.5 text-[9.5px] font-bold text-sky-300 focus:outline-none cursor-pointer"
                  title="Select subtune in multi-song .SID file"
                >
                  {Array.from({ length: Math.max(1, sidState.totalSubtunes) }, (_, idx) => {
                    const subNum = idx + 1;
                    const sec = sidState.hvsc?.subtuneDurationsSec?.[idx];
                    const lenLabel = sec ? ` · ${formatTimeMsPrecise(sec)}` : '';
                    return (
                      <option key={subNum} value={subNum} className="bg-zinc-950 text-zinc-200">
                        Subtune {subNum} / {sidState.totalSubtunes}{lenLabel}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-[9.5px]">
          <button
            onClick={handleEnableAllEngines}
            className="px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 cursor-pointer font-sans"
            title="Enable all sound engines simultaneously"
          >
            All On
          </button>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500 font-sans">
            <strong className="text-zinc-300">{activeEnginesCount}</strong>/8 Active
          </span>
        </div>
      </div>

      {/* LIVE FAMITRACKER / DN-FAMITRACKER + BITPHASE NES_APU TELEMETRY PANEL */}
      {famiTrackerState.hasModuleLoaded && (
        <div
          id="famitracker-live-telemetry-panel"
          className="mb-2 px-3 py-2 bg-zinc-950/90 border border-rose-500/35 rounded-lg text-xs flex flex-col gap-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-1.5 py-0.5 rounded bg-rose-950/80 border border-rose-500/60 text-rose-200 font-bold text-[9.5px] uppercase tracking-wider">
                {famiTrackerState.moduleFormat?.toUpperCase() || 'FTM'} · Dn-FamiTracker
              </span>
              <span className="font-bold text-white text-[11px] truncate max-w-[200px]">
                {famiTrackerState.moduleTitle}
              </span>
              <span className="text-[9.5px] text-zinc-400 font-sans">
                by {famiTrackerState.moduleAuthor || 'Unknown'}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${
                  famiTrackerState.wasmLoaded
                    ? 'bg-emerald-950/70 border-emerald-500/60 text-emerald-300'
                    : 'bg-zinc-900 border-zinc-700 text-amber-300'
                }`}
                title={famiTrackerState.wasmSource}
              >
                {famiTrackerState.wasmLoaded ? 'bitphase nes_apu.wasm' : '2A03 + Dn-FT Worklet DSP'}
              </span>
              <div className="flex items-center gap-1">
                {famiTrackerState.expansions.map((exp) => (
                  <span
                    key={exp}
                    className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-cyan-300 text-[9px] font-bold"
                  >
                    {exp}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Subsong Selector */}
              {famiTrackerState.subsongsCount > 1 && (
                <select
                  id="famitracker-subsong-select"
                  value={famiTrackerState.activeSongIndex}
                  onChange={(e) => {
                    unlockAudioContextSync();
                    NesWorkletEngine.setSubsong(parseInt(e.target.value, 10) || 0);
                  }}
                  className="bg-black border border-rose-700/60 rounded px-2 py-0.5 text-[9.5px] font-bold text-rose-200 cursor-pointer"
                >
                  {famiTrackerState.subsongNames.map((sName, idx) => (
                    <option key={idx} value={idx} className="bg-zinc-950 text-zinc-200">
                      Track {idx + 1}: {sName}
                    </option>
                  ))}
                </select>
              )}

              {/* Machine Timing Selector (NTSC / PAL / Dendy) */}
              <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded p-0.5 text-[9px] font-bold">
                {(['NTSC', 'PAL', 'Dendy'] as NesMachineStandard[]).map((std) => (
                  <button
                    key={std}
                    type="button"
                    onClick={() => NesWorkletEngine.setMachine(std)}
                    className={`px-1.5 py-0.5 rounded transition cursor-pointer ${
                      famiTrackerState.machine === std
                        ? 'bg-rose-600 text-white'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {std}
                  </button>
                ))}
              </div>

              <span className="px-2 py-0.5 rounded bg-black border border-zinc-800 text-[9.5px] font-mono text-amber-300 tabular-nums">
                Ord {(famiTrackerState.currentOrder + 1).toString().padStart(2, '0')}/{famiTrackerState.totalOrders.toString().padStart(2, '0')} · Row {famiTrackerState.currentRow.toString(16).toUpperCase().padStart(2, '0')}
              </span>
            </div>
          </div>

          {/* Live Per-Channel Activity Meters (Pulse 1, Pulse 2, Triangle, Noise, DPCM, Expansion Chips) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
            {famiTrackerState.channels.map((ch) => {
              const pct = Math.min(100, Math.round(ch.level * 100));
              const isMuted = ch.muted;
              return (
                <button
                  key={ch.index}
                  type="button"
                  onClick={() => handleTogglePatternChannelMute(ch.index + 1)}
                  title={`${ch.name} (${ch.chip}) · Click to ${isMuted ? 'unmute' : 'mute'}`}
                  className={`px-2 py-1 rounded border text-left transition cursor-pointer ${
                    isMuted
                      ? 'bg-red-950/25 border-red-800/50 opacity-60'
                      : 'bg-zinc-900/90 border-zinc-800 hover:border-rose-500/50'
                  }`}
                >
                  <div className="flex items-center justify-between text-[9px] font-mono">
                    <span className="font-bold text-zinc-200 truncate">{ch.shortName}</span>
                    <span className={ch.activeNote !== '---' ? 'text-emerald-400 font-bold' : 'text-zinc-600'}>
                      {ch.activeNote}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-black rounded-full overflow-hidden mt-1">
                    <div
                      className="h-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 transition-[width] duration-75"
                      style={{ width: `${isMuted ? 0 : pct}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* LIVE SUNVOX EFFECTS USAGE & DYNAMIC BRIGHTNESS MATRIX */}
      {sunvoxState.hasSunVoxLoaded && sunvoxState.effectsActivity.length > 0 && (
        <div
          id="sunvox-effects-brightness-rack"
          className="mb-2 px-3 py-2 bg-zinc-950/90 border border-violet-500/30 rounded-lg text-xs"
        >
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-violet-300">
              <Zap size={12} className="text-violet-400" />
              <span>Active SunVox DSP &amp; Pattern Effects ({sunvoxState.effectsActivity.length})</span>
            </div>
            <span className="text-[9px] font-mono text-zinc-500">
              Brightness intensifies with usage &amp; live signal load
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sunvoxState.effectsActivity.slice(0, 24).map((fx) => {
              const b = Math.max(0.18, Math.min(1, fx.brightness));
              const isPattern = fx.category === 'pattern';
              const hueRgb = isPattern ? '56, 189, 248' : '167, 139, 250';
              const pct = Math.round(b * 100);
              return (
                <div
                  key={fx.id}
                  data-fx-id={fx.id}
                  title={`${fx.name} (${fx.type}) · Usage: ${fx.hitCount || fx.staticUses} · Brightness: ${pct}%`}
                  className="px-2 py-1 rounded border text-[9.5px] font-mono transition-all duration-150 flex items-center gap-1.5"
                  style={{
                    backgroundColor: `rgba(${hueRgb}, ${(0.06 + b * 0.28).toFixed(3)})`,
                    borderColor: `rgba(${hueRgb}, ${(0.22 + b * 0.72).toFixed(3)})`,
                    boxShadow: b > 0.32 ? `0 0 ${Math.round(b * 14)}px rgba(${hueRgb}, ${(b * 0.45).toFixed(3)})` : 'none',
                    color: `rgba(255, 255, 255, ${(0.52 + b * 0.48).toFixed(3)})`,
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: `rgba(${hueRgb}, ${Math.min(1, 0.35 + b * 0.65).toFixed(3)})`,
                      boxShadow: `0 0 ${Math.round(3 + b * 7)}px rgba(${hueRgb}, ${b.toFixed(3)})`,
                    }}
                  />
                  <span className="font-bold truncate max-w-[115px]">{fx.name}</span>
                  <span className="text-[8px] opacity-75">{fx.type}</span>
                  {(fx.hitCount > 0 || fx.staticUses > 1) && (
                    <span className="text-[8px] px-1 rounded bg-black/40 text-zinc-200 tabular-nums">
                      {fx.hitCount > 0 ? `${fx.hitCount}x` : `${fx.staticUses}x`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SOUNDFONT INTERPOLATION MODES CONFIGURATOR */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-zinc-950/85 border border-zinc-850 rounded-lg text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1.5 text-cyan-400 font-bold text-[10px] uppercase tracking-wider pr-1">
            <Activity size={13} className="text-cyan-400" />
            <span>SF Interpolation:</span>
          </div>

          {INTERPOLATION_MODES.map((m) => {
            const isActive = interpolationMode === m.id;
            return (
              <button
                key={m.id}
                id={`sf-interp-btn-${m.id}`}
                type="button"
                onClick={() => {
                  setInterpolationMode(m.id);
                  setInterpolationModeState(m.id);
                }}
                className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
                  isActive
                    ? 'bg-cyan-950/75 border-cyan-500/70 text-cyan-200 shadow-[0_0_8px_rgba(34,211,238,0.25)]'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                }`}
                title={`${m.label} (${m.order}): ${m.description}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.85)]' : 'bg-zinc-600'}`} />
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>

        <div className="text-[9.5px] text-zinc-400 font-sans hidden xl:flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-cyan-300 font-mono text-[8.5px] font-bold">
            {INTERPOLATION_MODES.find(m => m.id === interpolationMode)?.order}
          </span>
          <span className="text-zinc-400">
            {INTERPOLATION_MODES.find(m => m.id === interpolationMode)?.description}
          </span>
        </div>
      </div>

      {/* SAVED SOUNDFONTS BAR WITH SET DEFAULT BUTTON (TOGGLED) */}
      {showSavedSoundFonts && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-zinc-950/85 border border-zinc-850 rounded-lg text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1.5 text-emerald-400 font-bold text-[10px] uppercase tracking-wider pr-1">
              <Disc3 size={13} className="text-emerald-400" />
              <span>Saved SoundFonts:</span>
            </div>

            {loadedSoundFonts.map((sf) => {
              const isActive = activeSoundFontId === sf.id;
              const isDefault = defaultSoundFontId === sf.id;
              return (
                <div
                  key={sf.id}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] transition ${
                    isActive
                      ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-200'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-300'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => SpessaSynth.setActiveSoundFont(sf.id)}
                    className="flex items-center gap-1 cursor-pointer hover:text-white font-bold"
                    title={`Activate "${sf.name}" (${sf.instrumentCount} presets)`}
                  >
                    {isActive && <Check size={9} className="text-emerald-400 shrink-0" />}
                    <span className="max-w-[150px] truncate">{sf.name}</span>
                  </button>

                  <button
                    id={`tracker-sf-default-btn-${sf.id}`}
                    type="button"
                    onClick={() => {
                      setDefaultSoundFontId(sf.id);
                      setDefaultSoundFontState(sf.id);
                      setImportFeedback({
                        success: true,
                        msg: `Set "${sf.name}" as your default SoundFont (saved in browser cookies).`
                      });
                      setTimeout(() => setImportFeedback(null), 3000);
                    }}
                    disabled={isDefault}
                    className={`px-1.5 py-0.5 rounded text-[8.5px] font-bold border transition flex items-center gap-1 ${
                      isDefault
                        ? 'bg-amber-950/75 border-amber-500/70 text-amber-300 cursor-default'
                        : 'bg-zinc-950 hover:bg-amber-950/60 border-zinc-700 hover:border-amber-500/60 text-zinc-300 hover:text-amber-200 cursor-pointer'
                    }`}
                    title={isDefault ? 'Default startup SoundFont' : `Set "${sf.name}" as default SoundFont`}
                  >
                    <Star size={8.5} fill={isDefault ? 'currentColor' : 'none'} />
                    <span>{isDefault ? 'Default' : 'Set Default'}</span>
                  </button>

                  {sf.isCustom && (
                    <button
                      type="button"
                      id={`tracker-sf-delete-btn-${sf.id}`}
                      onClick={async () => {
                        await deleteSavedSoundFont(sf.id);
                        setLoadedSoundFonts(SpessaSynth.getLoadedSoundFonts());
                        setActiveSoundFontId(SpessaSynth.getActiveSoundFont()?.id || 'spessa-default-gm');
                        setDefaultSoundFontState(getDefaultSoundFontId());
                        setImportFeedback({
                          success: true,
                          msg: `Removed "${sf.name}" from saved SoundFonts.`
                        });
                        setTimeout(() => setImportFeedback(null), 3000);
                      }}
                      className="p-0.5 rounded text-zinc-400 hover:text-red-400 hover:bg-red-950/40 transition cursor-pointer"
                      title={`Delete "${sf.name}" from saved SoundFonts`}
                    >
                      <Trash2 size={9.5} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* INLINE SPRESSASYNTH WORKLETSYNTHESIZER MIDI CONTROLLER & INSTRUMENT MIXER */}
      {showMidiMixer && (
        <div
          id="tracker-inline-midi-mixer-panel"
          className="mb-2.5 p-3 bg-zinc-950/95 border border-indigo-800/60 rounded-xl shadow-[0_0_24px_rgba(99,102,241,0.12)] max-h-[540px] overflow-y-auto custom-scrollbar"
        >
          <div className="flex items-center justify-between gap-2 pb-2 mb-2.5 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Sliders size={13} className="text-indigo-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-white">
                SpessaSynth WorkletSynthesizer MIDI Controller &amp; Instrument Mixer
              </span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-950/70 border border-indigo-700/50 text-indigo-300">
                Direct Engine Wire · Two-Way Sync
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowMidiMixer(false)}
              className="text-[9.5px] px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700 cursor-pointer uppercase font-bold"
            >
              Collapse
            </button>
          </div>

          <SpessaMidiMixerPanel
            compact={true}
            onChannelMuteSync={(chIdx0, isMuted) => {
              setChannels?.(prev =>
                prev.map(c => (c.id === chIdx0 + 1 ? { ...c, mute: isMuted } : c))
              );
            }}
          />
        </div>
      )}

      {/* CONVERTED TRACKER / BASICMIDI SEQUENCE METADATA STRIP */}
      <SequenceMetadataStrip />

      {/* CHANNEL BANK SELECTOR BAR */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 p-2 bg-zinc-900/70 border border-zinc-800 rounded-lg text-xs">
        <div className="flex items-center gap-1.5">
          <Layers size={13} className="text-cyan-400" />
          <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Channel Bank:</span>
          {(['1-8', '9-16', '17-24', '25-32', '33-48', 'all'] as ChannelBank[]).map(bank => (
            <button
              key={bank}
              onClick={() => setSelectedBank(bank)}
              className={`px-2 py-1 rounded text-[10px] font-bold transition uppercase cursor-pointer ${
                selectedBank === bank
                  ? 'bg-cyan-600 text-white shadow-sm'
                  : 'bg-zinc-950 text-zinc-400 hover:text-white border border-zinc-800'
              }`}
            >
              {bank === 'all' ? 'All (1-48)' : bank}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded p-0.5 text-[10px]">
            <span className="text-zinc-500 px-1.5 font-semibold">FX Cols:</span>
            {[1, 2, 3, 4].map((cnt) => (
              <button
                key={cnt}
                type="button"
                onClick={() => setFxColumnsCount(cnt)}
                className={`px-1.5 py-0.5 rounded font-mono font-bold cursor-pointer ${
                  fxColumnsCount === cnt ? 'bg-cyan-600 text-white' : 'text-zinc-400 hover:text-white'
                }`}
                title={`Display ${cnt} Furnace effect column${cnt > 1 ? 's' : ''} (FX1${cnt > 1 ? `-FX${cnt}` : ''})`}
              >
                {cnt}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-1.5 text-[10px] text-zinc-400 cursor-pointer">
            <input 
              type="checkbox"
              checked={showActiveOnly}
              onChange={(e) => setShowActiveOnly(e.target.checked)}
              className="accent-cyan-500 rounded cursor-pointer"
            />
            <span>Active Channels Only</span>
          </label>

          <div className="text-[10px] text-zinc-500 font-sans">
            Showing <strong className="text-white">{visibleChannels.length}</strong> of 48 channels
          </div>
        </div>
      </div>

      {/* LIVE FURNACE & DN-FAMITRACKER EFFECT STATUS-BAR TOOLTIP */}
      {(() => {
        const selectedFxVal =
          selectedCell?.field === 'fx'
            ? currentPatternRows[selectedCell.row]?.[selectedCell.col]?.fx?.[selectedCell.fxIndex ?? 0]
            : undefined;
        const activeToken = hoveredFxToken ?? selectedFxVal ?? null;
        const tokTrim = (activeToken || '').trim().toUpperCase();
        const useDnDoc =
          famiTrackerState.hasModuleLoaded ||
          (tokTrim.length > 0 && tokTrim !== '....' && /^[=NKJGHILMOPQRSTVWXYZ]/.test(tokTrim));
        const info = useDnDoc
          ? describeDnFamiTrackerEffect(activeToken)
          : describeFurnaceEffect(activeToken);
        return (
          <div
            id="tracker-effect-status-bar"
            className="mb-2 px-3 py-1 bg-zinc-950 border border-zinc-800 rounded flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-mono"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-cyan-400 font-bold shrink-0">{info.title}</span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400 truncate font-sans">{info.detail}</span>
            </div>
            <span className="text-[10px] text-zinc-500 tabular-nums shrink-0">
              {useDnDoc ? `Dn-FamiTracker FX1–FX${fxColumnsCount}` : `FX1–FX${fxColumnsCount} Furnace Engine`}
            </span>
          </div>
        );
      })()}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 flex-1 min-h-0">
        
        {/* INTERACTIVE TRACKER CANVAS */}
        <div 
          ref={containerRef}
          className={`md:col-span-3 overflow-auto border rounded-xl custom-scrollbar relative h-[520px] ${
            theme === 'furnace' 
              ? 'border-zinc-800 bg-zinc-950 text-zinc-300' 
              : 'border-zinc-800 bg-black text-zinc-300'
          }`}
        >
          {/* STICKY TRACK HEADER */}
          <div className="flex border-b border-zinc-800 sticky top-0 z-20 bg-zinc-900 shadow">
            <div className="w-12 flex-shrink-0 bg-zinc-950 border-r border-zinc-800 flex items-center justify-center font-bold text-[9px] text-zinc-500">
              ROW
            </div>
            {visibleChannels.map(ch => {
              const anySolo = channels.some(c => c.enabled && c.solo);
              const isMutedEff = ch.mute || (anySolo && !ch.solo);
              const colWidthClass =
                fxColumnsCount === 1
                  ? 'w-52'
                  : fxColumnsCount === 2
                    ? 'w-60'
                    : fxColumnsCount === 3
                      ? 'w-72'
                      : 'w-80';
              return (
                <div 
                  key={ch.id} 
                  className={`${colWidthClass} flex-shrink-0 border-r border-zinc-800 p-1.5 text-center transition-colors ${
                    ch.solo
                      ? 'bg-amber-950/35'
                      : isMutedEff
                        ? 'bg-red-950/20 opacity-65'
                        : 'bg-zinc-900/95'
                  }`}
                >
                  <div className="text-[10px] text-zinc-200 font-bold flex items-center justify-between gap-1 px-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <Music2 size={10} className="text-cyan-400 shrink-0" />
                      <span>CH {ch.id.toString().padStart(2, '0')}</span>
                      {ch.soundFontPreset && (
                        <span className="text-[8px] px-1 py-0.2 bg-emerald-950/60 border border-emerald-800/40 text-emerald-400 rounded">
                          SF
                        </span>
                      )}
                    </div>

                    {/* Compact [M] Mute and [S] Solo buttons wired to WebSID & Synth engines */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        id={`tracker-header-mute-${ch.id}`}
                        type="button"
                        onClick={() => handleTogglePatternChannelMute(ch.id)}
                        className={`px-1 py-0.2 rounded text-[8.5px] font-black border transition cursor-pointer leading-tight ${
                          ch.mute
                            ? 'bg-red-600 text-white border-red-400'
                            : 'bg-zinc-950 text-zinc-500 border-zinc-800 hover:text-red-300 hover:border-red-700/60'
                        }`}
                        title={`Mute CH ${ch.id.toString().padStart(2, '0')}`}
                      >
                        M
                      </button>
                      <button
                        id={`tracker-header-solo-${ch.id}`}
                        type="button"
                        onClick={() => handleTogglePatternChannelSolo(ch.id)}
                        className={`px-1 py-0.2 rounded text-[8.5px] font-black border transition cursor-pointer leading-tight ${
                          ch.solo
                            ? 'bg-amber-500 text-black border-amber-300'
                            : 'bg-zinc-950 text-zinc-500 border-zinc-800 hover:text-amber-300 hover:border-amber-600/60'
                        }`}
                        title={`Solo CH ${ch.id.toString().padStart(2, '0')}`}
                      >
                        S
                      </button>
                    </div>
                  </div>
                  <div className="text-[8.5px] text-cyan-400 truncate uppercase mt-0.5 tracking-wider font-semibold px-1" title={ch.label || ch.chip}>
                    {ch.label
                      ? ch.label
                      : ch.soundFontPreset
                        ? (soundFontInstruments.find(i => i.id === ch.soundFontPreset)?.name.replace(/^\d+:\s*/, '') || ch.chip)
                        : ch.chip}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ROWS MATRIX */}
          {Array.from({ length: 64 }, (_, rowIndex) => (
            <div 
              key={rowIndex} 
              ref={rowIndex === activeRow ? activeRowRef : null}
              className={`flex border-b border-zinc-900/50 transition-colors ${
                rowIndex === activeRow 
                  ? 'bg-cyan-950/40 text-cyan-200 border-y border-cyan-700/40' 
                  : 'hover:bg-zinc-900/30'
              }`}
            >
              {/* Row number label */}
              <div 
                onClick={() => setActiveRow(rowIndex)}
                className={`w-12 flex-shrink-0 border-r border-zinc-800 text-center py-1.5 text-[10px] font-bold cursor-pointer transition-colors ${
                  rowIndex === activeRow 
                    ? 'bg-cyan-500/20 text-cyan-400 font-black' 
                    : rowIndex % 4 === 0 
                      ? 'bg-zinc-900/80 text-zinc-400' 
                      : 'bg-zinc-950/60 text-zinc-600'
                }`}
              >
                {rowIndex.toString(16).toUpperCase().padStart(2, '0')}
              </div>

              {/* Data Cells per row */}
              {visibleChannels.map(ch => {
                const cell = currentPatternRows[rowIndex]?.[ch.id] || { note: '---', inst: '..', vol: '..' };
                const isSelected = selectedCell?.row === rowIndex && selectedCell?.col === ch.id;
                const fxArr: string[] = Array.isArray(cell.fx) ? cell.fx : [];
                const colWidthClass =
                  fxColumnsCount === 1
                    ? 'w-52'
                    : fxColumnsCount === 2
                      ? 'w-60'
                      : fxColumnsCount === 3
                        ? 'w-72'
                        : 'w-80';

                return (
                  <div 
                    key={ch.id} 
                    className={`${colWidthClass} flex-shrink-0 border-r border-zinc-900/60 flex items-center justify-between gap-1 text-[10.5px] px-2 py-1.5 font-semibold group cursor-pointer ${
                      isSelected 
                        ? 'bg-cyan-900/40 ring-1 ring-cyan-500/50' 
                        : 'hover:bg-zinc-850/40'
                    }`}
                  >
                    <span 
                      onClick={() => handleCellClick(rowIndex, ch.id, 'note')}
                      className={`tracking-widest rounded px-1 transition-all ${
                        cell.note === '---' 
                          ? 'text-zinc-650 font-thin' 
                          : cell.note === '==='
                            ? 'text-red-400 font-mono'
                            : 'text-emerald-400 group-hover:text-emerald-300'
                      }`}
                    >
                      {cell.note}
                    </span>
                    
                    <span 
                      onClick={() => handleCellClick(rowIndex, ch.id, 'inst')}
                      className={`text-[9.5px] ${cell.inst === '..' ? 'text-zinc-700' : 'text-purple-400 font-mono'}`}
                      title={`Instrument: ${cell.inst}`}
                    >
                      {cell.inst}
                    </span>

                    <span 
                      onClick={() => handleCellClick(rowIndex, ch.id, 'vol')}
                      className={`text-[9.5px] font-mono ${cell.vol === '..' ? 'text-zinc-750' : 'text-cyan-400 font-bold'}`}
                      title={`Volume: ${cell.vol}`}
                    >
                      {cell.vol}
                    </span>

                    <div className="flex items-center gap-1 ml-1">
                      {Array.from({ length: fxColumnsCount }, (_, fxIdx) => {
                        const tok = fxArr[fxIdx] || '....';
                        const isFxSelected =
                          isSelected && selectedCell?.field === 'fx' && selectedCell?.fxIndex === fxIdx;
                        return (
                          <span
                            key={fxIdx}
                            onMouseEnter={() => setHoveredFxToken(tok)}
                            onMouseLeave={() => setHoveredFxToken(null)}
                            onClick={() => handleCellClick(rowIndex, ch.id, 'fx', fxIdx)}
                            className={`text-[9.5px] font-mono px-1 rounded transition-colors ${
                              isFxSelected
                                ? 'bg-amber-500/30 text-amber-200 ring-1 ring-amber-400'
                                : tok !== '....'
                                  ? 'text-amber-300'
                                  : 'text-zinc-700 hover:text-zinc-400'
                            }`}
                            title={describeFurnaceEffect(tok).title}
                          >
                            {tok}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* SIDE BAR NOTE & INSTRUMENT PROGRAMMER */}
        <div className="bg-zinc-900/65 border border-zinc-800 rounded-xl p-4 flex flex-col gap-4">
          <div className="flex items-center gap-1.5 border-b border-zinc-800 pb-2">
            <Edit3 className="w-4 h-4 text-cyan-400" />
            <h3 className="font-bold text-xs uppercase tracking-wider text-zinc-300">Tone & Instrument Editor</h3>
          </div>

          {selectedCell ? (
            <div className="flex flex-col gap-3 py-1">
              <div className="bg-black/50 p-2.5 rounded border border-zinc-800 text-[11px]">
                <div className="text-zinc-500">Target Cell:</div>
                <div className="text-white mt-1 font-bold">
                  Pat <span className="text-cyan-400">{currentPatternIndex + 1}</span>, Row <span className="text-cyan-400">{selectedCell.row.toString(16).toUpperCase().padStart(2, '0')}</span>, Channel <span className="text-cyan-400">{selectedCell.col}</span>
                </div>
              </div>

              {/* SoundFont Instrument Assign for this Channel */}
              <div>
                <label className="text-[10px] text-zinc-400 block mb-1">
                  Assign Channel Instrument ({soundFontInstruments.length} Available):
                </label>
                <select
                  value={channels.find(c => c.id === selectedCell.col)?.soundFontPreset || ''}
                  onChange={(e) => updateChannelInstrument(selectedCell.col, e.target.value)}
                  className="w-full bg-black border border-zinc-800 rounded p-1.5 text-[10.5px] text-cyan-300 font-mono focus:outline-none cursor-pointer"
                >
                  <option value="">Default Chip ({channels.find(c => c.id === selectedCell.col)?.chip})</option>
                  {groupedInstruments.map(group => (
                    <optgroup key={group.category} label={group.category} className="bg-zinc-900 text-zinc-300 font-bold">
                      {group.instruments.map(inst => (
                        <option key={inst.id} value={inst.id} className="bg-black text-cyan-300 font-normal">
                          {inst.name} {inst.isCustom ? '(SF2)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label className="text-[10px] text-zinc-400">Map Tone Pitch (Oct 0–7):</label>
                  <div className="flex items-center gap-0.5">
                    {([0, 1, 2, 3, 4, 5, 6, 7, 'all'] as const).map((oct) => (
                      <button
                        key={String(oct)}
                        type="button"
                        onClick={() => setSelectedOctave(oct)}
                        className={`px-1 py-0.5 rounded text-[9px] font-bold border transition cursor-pointer ${
                          selectedOctave === oct
                            ? 'bg-cyan-500/25 border-cyan-500 text-cyan-300'
                            : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-white'
                        }`}
                        title={oct === 'all' ? 'Show all octaves 0–7' : `Octave ${oct}`}
                      >
                        {oct === 'all' ? 'All' : oct}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-1 max-h-[200px] overflow-y-auto pr-1 text-[10.5px] custom-scrollbar">
                  {selectNoteList.map(not => (
                    <button 
                      key={not}
                      onClick={() => updateCellNote(selectedCell.row, selectedCell.col, not)}
                      className={`p-1 rounded border text-center transition-all cursor-pointer ${
                        currentPatternRows[selectedCell.row]?.[selectedCell.col]?.note === not
                          ? 'bg-cyan-500/25 border-cyan-500 text-cyan-300 font-bold'
                          : 'bg-zinc-950 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900 text-zinc-400 hover:text-white'
                      }`}
                    >
                      {not}
                    </button>
                  ))}
                </div>
              </div>

              {/* Furnace Effect Slot Programmer (FX1-FX4) */}
              <div className="bg-black/40 border border-zinc-800 rounded p-2 flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-[10px] text-zinc-400">
                  <span>Furnace Effect (FX{(selectedCell.fxIndex ?? 0) + 1}):</span>
                  <span className="font-mono text-amber-300">
                    {currentPatternRows[selectedCell.row]?.[selectedCell.col]?.fx?.[selectedCell.fxIndex ?? 0] || '....'}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    maxLength={4}
                    placeholder="e.g. 0448"
                    value={currentPatternRows[selectedCell.row]?.[selectedCell.col]?.fx?.[selectedCell.fxIndex ?? 0] || ''}
                    onChange={(e) =>
                      updateCellEffect(selectedCell.row, selectedCell.col, selectedCell.fxIndex ?? 0, e.target.value)
                    }
                    className="w-20 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] font-mono text-amber-300 uppercase focus:outline-none focus:border-amber-500"
                  />
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        updateCellEffect(selectedCell.row, selectedCell.col, selectedCell.fxIndex ?? 0, e.target.value);
                      }
                    }}
                    className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-300 cursor-pointer"
                  >
                    <option value="">Insert Command...</option>
                    {FURNACE_EFFECT_SPECS.map((spec) => (
                      <option key={spec.code} value={`${spec.code}00`}>
                        {spec.syntax} · {spec.name}
                      </option>
                    ))}
                    <option value="....">Clear FX</option>
                  </select>
                </div>
              </div>

              <button 
                onClick={() => setSelectedCell(null)}
                className="w-full py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded border border-zinc-700 transition mt-1 font-bold uppercase tracking-wider cursor-pointer"
              >
                Close Inspector
              </button>
            </div>
          ) : (
            <div className="text-zinc-500 flex flex-col items-center justify-center py-12 text-center gap-2">
              <HelpCircle size={28} className="text-zinc-700" />
              <p className="text-[11px] leading-relaxed font-sans font-medium px-2">
                Click any coordinate cell in the grid to audition notes, assign SoundFont instruments, and adjust volume gates!
              </p>
            </div>
          )}

          <div className="mt-auto bg-black/40 border border-zinc-800 p-2.5 rounded-lg text-[9px] text-zinc-500 font-sans leading-relaxed">
            <span className="font-bold text-[9.5px] text-zinc-400 block mb-1">Tracker Keybindings:</span>
            - Arrow keys <kbd className="bg-zinc-800 px-1 py-0.5 rounded text-zinc-300">↑ ↓ ← →</kbd> navigate cells.<br/>
            - <kbd className="bg-zinc-800 px-1 py-0.5 rounded text-zinc-300">Del</kbd> / <kbd className="bg-zinc-800 px-1 py-0.5 rounded text-zinc-300">Backspace</kbd> clears active note.
          </div>
        </div>

      </div>

      {/* UNIVERSAL IMPORT MODAL DIALOG */}
      {isImportModalOpen && (
        <div className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4 backdrop-blur-md">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 max-w-lg w-full flex flex-col gap-4 shadow-[0_0_50px_rgba(34,211,238,0.15)]">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2 text-cyan-400">
                <Upload size={16} />
                <h3 className="font-bold text-sm uppercase tracking-wider text-white">Universal Music & SoundFont Import</h3>
              </div>
              <button 
                onClick={() => {
                  setIsImportModalOpen(false);
                  setImportFeedback(null);
                }}
                className="text-zinc-500 hover:text-white text-xs font-semibold cursor-pointer"
              >
                ✕ CLOSE
              </button>
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-[10.5px] text-zinc-400 font-sans">
                Drag & drop any music file or SoundFont. All formats are decoded directly in browser without squashing:
              </label>

              <div 
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const dropped = e.dataTransfer?.files?.[0];
                  if (dropped) {
                    importSelectedFile(dropped);
                  }
                }}
                onClick={() => fileInputRef2.current?.click()}
                className="border-2 border-dashed border-zinc-800 bg-zinc-950/40 rounded-lg p-6 flex flex-col items-center justify-center gap-2.5 cursor-pointer hover:border-cyan-500/40 hover:bg-zinc-900/10 transition-all text-center"
              >
                <input 
                  type="file"
                  ref={fileInputRef2}
                  onChange={handleFileImport}
                  accept={`.fur,.fui,.fuw,.dmp,.opm,.dmc,.brr,.ftm,.0cc,.dnm,.mid,.midi,.rmi,.kar,.xmf,.mod,.xm,.s3m,.it,.sid,.nsf,.nsfe,.gbs,.vgm,.vgz,.spc,.sunvox,.sunsynth,${SOUNDFONT_ACCEPT_ATTR},.wav,.mp3,.ogg,.flac,.json`}
                  className="hidden"
                />
                <Disc3 size={28} className="text-cyan-400 animate-spin-slow" />
                <span className="font-bold text-[11px] text-white uppercase bg-cyan-950/50 hover:bg-cyan-900 px-4 py-2 rounded-lg border border-cyan-800/40 shadow-sm">
                  Choose Music or SoundFont File
                </span>
                <span className="text-[9px] text-zinc-500 font-sans max-w-sm leading-normal">
                  FamiTracker / Dn-FT (.ftm, .0cc, .dnm), Furnace (.fur, .fui, .fuw, .dmp, .opm), MIDI (.mid, .midi, .rmi, .kar, .xmf), Amiga/PC Tracker Modules (.mod, .xm, .s3m, .it), SunVox (.sunvox), C64 (.sid), NES (.nsf/.dmc), Game Boy (.gbs), Sega VGM (.vgm), SNES (.spc/.brr), SoundFonts (.sf2, .sf3, .dls, .sfe), WAV, MP3, and JSON.
                </span>
              </div>

              <div className="text-center text-zinc-600 text-[9px] font-sans my-0.5">--- OR PASTE RAW JSON OBJECTS ---</div>

              <textarea 
                value={pastedJson}
                onChange={(e) => setPastedJson(e.target.value)}
                placeholder='[ { "1": { "note": "C-4", "inst": "01", "vol": "80", "delay": "000" }, ... }, ... ]'
                className="w-full h-24 bg-black border border-zinc-800 rounded-lg p-3 text-[9px] text-zinc-400 font-mono focus:outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700 custom-scrollbar resize-none"
              />

              <button 
                onClick={() => handleImportJson(pastedJson)}
                disabled={!pastedJson.trim()}
                className={`w-full py-2.5 rounded-lg font-bold text-xs tracking-wider uppercase flex items-center justify-center gap-2 transition cursor-pointer ${
                  !pastedJson.trim()
                    ? 'bg-zinc-800 text-zinc-600 border border-zinc-750 cursor-not-allowed opacity-50'
                    : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-sm'
                }`}
              >
                Compile & Load Patterns
              </button>

              {importFeedback && (
                <div className={`p-3 rounded-lg flex items-start gap-2 border text-[10px] ${
                  importFeedback.success 
                    ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-400' 
                    : 'bg-red-950/20 border-red-500/30 text-red-400'
                }`}>
                  {importFeedback.success ? <CheckCircle2 size={14} className="shrink-0 mt-0.5" /> : <AlertCircle size={14} className="shrink-0 mt-0.5" />}
                  <span>{importFeedback.msg}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* EXPORT STUDIO MODAL */}
      <ExportStudioModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        songPatterns={songPatterns || [patterns]}
        channels={channels}
        bpm={bpm || 125}
        trackTitle={trackTitle}
        onSwitchChiptuneMode={onSwitchChiptuneMode}
        currentMode={currentChiptuneMode || 'mod'}
        isPlaying={isPlaying}
        onTriggerPlay={() => setIsPlaying?.(true)}
      />

      {/* WASM ENGINE MANAGER MODAL */}
      <WasmEngineManagerModal
        isOpen={isWasmManagerOpen}
        onClose={() => setIsWasmManagerOpen(false)}
      />
    </div>
  );
}
