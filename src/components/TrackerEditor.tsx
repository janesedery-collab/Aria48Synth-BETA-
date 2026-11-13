import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Monitor, Music2, Edit3, HelpCircle, Volume2, Upload, Download, CheckCircle2, AlertCircle, Layers, Disc3, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Repeat, PlayCircle, Cpu, Activity, Star, Trash2, Check, Sliders } from 'lucide-react';
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
  deleteSavedSoundFont
} from './AudioEngine';
import { SpessaSynth, SpessaSoundFont } from '../engines/spressasynthLib';
import {
  INTERPOLATION_MODES,
  getInterpolationMode,
  setInterpolationMode,
  onInterpolationModeChange
} from '../engines/soundFontInterpolation';
import { saveSelectedSoundFont } from '../utils/recentSongsManager';
import { parseChiptuneFile } from '../utils/chiptuneParsers';
import { getAvailableSoundFontInstruments } from '../utils/soundFontEngine';
import ExportStudioModal from './ExportStudioModal';
import SpessaMidiMixerPanel from './SpessaMidiMixerPanel';
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
    rawMidiBuffer?: ArrayBuffer
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
  onImportTrack 
}: TrackerEditorProps) {
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number; field: 'note' | 'inst' | 'vol' } | null>(null);
  const [selectedBank, setSelectedBank] = useState<ChannelBank>('1-8');
  const [showActiveOnly, setShowActiveOnly] = useState<boolean>(false);
  const [soundFontInstruments, setSoundFontInstruments] = useState<SoundFontInstrument[]>([]);
  
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [pastedJson, setPastedJson] = useState('');
  const [importFeedback, setImportFeedback] = useState<{ success: boolean; msg: string } | null>(null);
  const fileInputRef2 = useRef<HTMLInputElement>(null);

  const [enginesConfig, setEnginesConfig] = useState<SoundEnginesConfig>(getSoundEnginesConfig());
  const [interpolationMode, setInterpolationModeState] = useState<SoundFontInterpolationMode>(getInterpolationMode());
  const [loadedSoundFonts, setLoadedSoundFonts] = useState<SpessaSoundFont[]>(() => SpessaSynth.getLoadedSoundFonts());
  const [activeSoundFontId, setActiveSoundFontId] = useState<string>(() => SpessaSynth.getActiveSoundFont()?.id || 'spessa-default-gm');
  const [defaultSoundFontId, setDefaultSoundFontState] = useState<string>(() => getDefaultSoundFontId());
  const [showSavedSoundFonts, setShowSavedSoundFonts] = useState<boolean>(false);
  const [showMidiMixer, setShowMidiMixer] = useState<boolean>(false);
  const [trackerBpmText, setTrackerBpmText] = useState((bpm || 125).toString());

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
    return () => {
      unsubSf();
      unsubEngines();
      unsubInterp();
      unsubDefSf();
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
      chiptune3: true
    });
  };

  const activeEnginesCount = Object.values(enginesConfig).filter(Boolean).length;

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

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      const extension = selected.name.substring(selected.name.lastIndexOf('.')).toLowerCase();

      if (isSoundFontFileName(selected.name)) {
        const reader = new FileReader();
        reader.onload = async (event) => {
          if (event.target?.result instanceof ArrayBuffer) {
            try {
              // Feed directly into spressasynth_core-master.zip -> spressasynth_lib-master.zip
              const { soundFont: spessaSf } = await loadSoundFontIntoCoreAndLib(event.target.result, selected.name);
              saveSelectedSoundFont(spessaSf.id);
              setSoundFontInstruments(getAvailableSoundFontInstruments());
              setImportFeedback({
                success: true,
                msg: `Loaded SoundFont "${spessaSf.name}" (${spessaSf.format || 'SoundBank'}, ${spessaSf.instrumentCount} presets) via spressasynth_core-master.zip -> spressasynth_lib!`
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
      } else {
        const reader = new FileReader();
        reader.onload = (event) => {
          if (event.target?.result instanceof ArrayBuffer) {
            try {
              const result = parseChiptuneFile(selected.name, event.target.result);
              
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
                  result.rawMidiBuffer
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
      }
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

            if (setChannels && channels && updatedInstruments.length > 0) {
              setChannels(prev => prev.map((ch, idx) => {
                const inst = updatedInstruments[idx % updatedInstruments.length];
                return {
                  ...ch,
                  chip: 'General MIDI (SoundFont)',
                  soundFontPreset: inst ? inst.id : ch.soundFontPreset
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

  // Keep active row centered in the scroll view
  useEffect(() => {
    if (isPlaying && activeRowRef.current && containerRef.current) {
      const parent = containerRef.current;
      const child = activeRowRef.current;
      const parentRect = parent.getBoundingClientRect();
      const childRect = child.getBoundingClientRect();
      const relativeTop = childRect.top - parentRect.top;
      
      if (relativeTop < 80 || relativeTop > parentRect.height - 120) {
        child.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [activeRow, isPlaying]);

  const selectNoteList = [
    "C-2", "D-2", "E-2", "F-2", "G-2", "A-2", "B-2",
    "C-3", "D-3", "E-3", "F-3", "G-3", "A-3", "B-3",
    "C-4", "D-4", "E-4", "F-4", "G-4", "A-4", "B-4",
    "C-5", "D-5", "E-5", "F-5", "G-5", "A-5", "B-5",
    "===", "---"
  ];

  const handleCellClick = (rowIndex: number, chId: number, field: 'note' | 'inst' | 'vol') => {
    setSelectedCell({ row: rowIndex, col: chId, field });
    
    // Play pitch instantly on click to preview
    const cellValue = currentPatternRows[rowIndex]?.[chId];
    if (cellValue && cellValue.note !== "---" && cellValue.note !== "===" && field === 'note') {
      const ch = channels.find(c => c.id === chId);
      if (ch) {
        playNote(chId, ch.chip, cellValue.note, 0.25, ch.volume, ch.pan, ch.soundFontPreset);
      }
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

    if (newNote !== '---' && newNote !== '===') {
      const ch = channels.find(c => c.id === chId);
      if (ch) {
        playNote(chId, ch.chip, newNote, 0.25, ch.volume, ch.pan, ch.soundFontPreset);
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
            onClick={() => setIsImportModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-950/50 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/60 rounded-lg text-[10.5px] font-bold uppercase transition tracking-wider cursor-pointer shadow-sm"
            title="Import MIDI, MOD, XM, S3M, IT, SID, NSF, SF2 into tracking matrix"
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
            title="Feed any SoundFont (.sf2, .sf3, .dls, .sfz, .sbk, .gig, .pat, .sfpack, or any format) into spressasynth_core-master.zip -> spressasynth_lib-master.zip"
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

          {/* Chiptune-3 Tracker Engine */}
          <button
            id="engine-toggle-chiptune3"
            onClick={() => handleToggleEngine('chiptune3')}
            className={`px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
              enginesConfig.chiptune3
                ? 'bg-fuchsia-950/70 border-fuchsia-500/60 text-fuchsia-300 shadow-[0_0_8px_rgba(217,70,239,0.25)]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-60'
            }`}
            title={enginesConfig.chiptune3 ? 'Chiptune-3 Tracker Engine (MOD, XM, S3M, IT PCM): ACTIVE. Click to disable.' : 'Chiptune-3: MUTED. Click to enable.'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${enginesConfig.chiptune3 ? 'bg-fuchsia-400 shadow-[0_0_6px_rgba(232,121,249,0.8)]' : 'bg-zinc-600'}`} />
            <span>Chiptune-3 (MOD)</span>
          </button>
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
            <strong className="text-zinc-300">{activeEnginesCount}</strong>/4 Active
          </span>
        </div>
      </div>

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
                      onClick={() => void deleteSavedSoundFont(sf.id)}
                      className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-950/40 transition cursor-pointer"
                      title={`Remove "${sf.name}" from saved SoundFonts`}
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

        <div className="flex items-center gap-3">
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
            {visibleChannels.map(ch => (
              <div 
                key={ch.id} 
                className="w-44 flex-shrink-0 border-r border-zinc-800 p-2 text-center bg-zinc-900/95"
              >
                <div className="text-[10px] text-zinc-200 font-bold flex items-center justify-center gap-1">
                  <Music2 size={10} className="text-cyan-400" />
                  <span>CH {ch.id.toString().padStart(2, '0')}</span>
                  {ch.soundFontPreset && (
                    <span className="text-[8px] px-1 py-0.2 bg-emerald-950/60 border border-emerald-800/40 text-emerald-400 rounded">
                      SF
                    </span>
                  )}
                </div>
                <div className="text-[8.5px] text-cyan-400 truncate uppercase mt-0.5 tracking-wider font-semibold" title={ch.chip}>
                  {ch.soundFontPreset
                    ? (soundFontInstruments.find(i => i.id === ch.soundFontPreset)?.name.replace(/^\d+:\s*/, '') || ch.chip)
                    : ch.chip}
                </div>
              </div>
            ))}
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

                return (
                  <div 
                    key={ch.id} 
                    className={`w-44 flex-shrink-0 border-r border-zinc-900/60 flex items-center justify-between text-[11px] px-2.5 py-1.5 font-semibold group cursor-pointer ${
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
                <label className="text-[10px] text-zinc-400 block mb-1.5">Map Tone Pitch:</label>
                <div className="grid grid-cols-4 gap-1 max-h-[190px] overflow-y-auto pr-1 text-[10.5px] custom-scrollbar">
                  {selectNoteList.map(not => (
                    <button 
                      key={not}
                      onClick={() => updateCellNote(selectedCell.row, selectedCell.col, not)}
                      className={`p-1 rounded border text-center transition-all ${
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
                onClick={() => fileInputRef2.current?.click()}
                className="border-2 border-dashed border-zinc-800 bg-zinc-950/40 rounded-lg p-6 flex flex-col items-center justify-center gap-2.5 cursor-pointer hover:border-cyan-500/40 hover:bg-zinc-900/10 transition-all text-center"
              >
                <input 
                  type="file"
                  ref={fileInputRef2}
                  onChange={handleFileImport}
                  accept={`.mid,.midi,.mod,.xm,.s3m,.it,.sid,.nsf,.nsfe,.gbs,.vgm,.vgz,.spc,.ftm,.sunvox,${SOUNDFONT_ACCEPT_ATTR},.wav,.mp3,.ogg,.flac,.json`}
                  className="hidden"
                />
                <Disc3 size={28} className="text-cyan-400 animate-spin-slow" />
                <span className="font-bold text-[11px] text-white uppercase bg-cyan-950/50 hover:bg-cyan-900 px-4 py-2 rounded-lg border border-cyan-800/40 shadow-sm">
                  Choose Music or SoundFont File
                </span>
                <span className="text-[9px] text-zinc-500 font-sans max-w-sm leading-normal">
                  Standard MIDI (.mid), ProTracker (.mod), FastTracker (.xm), ScreamTracker (.s3m), Impulse Tracker (.it), C64 (.sid), NES (.nsf), Game Boy (.gbs), Sega VGM (.vgm), SNES (.spc), SoundFonts (.sf2, .sf3, .dls, .sfz, .sbk, .gig, .pat), WAV, MP3, and JSON.
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
    </div>
  );
}
