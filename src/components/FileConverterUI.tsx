import React, { useState, useRef, useEffect } from 'react';
import { Upload, HelpCircle, FileAudio, RotateCw, CheckCircle2, Download, Disc3, Music, Play, Volume2, Star, Trash2, Check, ChevronDown, ChevronUp, Cpu, FileText, Database } from 'lucide-react';
import { parseChiptuneFile } from '../utils/chiptuneParsers';
import {
  generateFastTrackerXmBuffer,
  generateMidiFileBuffer,
  generateProTrackerModBuffer,
  generateScreamTrackerS3mBuffer
} from '../utils/chiptuneExporters';
import { getSoundFontBankInfo, getAvailableSoundFontInstruments } from '../utils/soundFontEngine';
import {
  TinyRsidBridge,
  deleteSavedSoundFont,
  getAudioContext,
  getDefaultSoundFontId,
  isSoundFontFileName,
  loadSoundFontIntoCoreAndLib,
  onDefaultSoundFontChange,
  setDefaultSoundFontId,
  SOUNDFONT_ACCEPT_ATTR
} from './AudioEngine';
import {
  HvscCacheStats,
  HvscLookupResult,
  SidHeaderMetadata,
  clearHvscCache,
  formatHexAddr,
  formatTimeMsPrecise,
  getHvscCacheStats,
  loadAndCacheSonglengthsMd5,
  loadAndCacheStilTxt,
  lookupHvscForSid,
  onHvscCacheChange,
  parseSidHeader,
  restoreHvscCachesFromIndexedDB
} from '../utils/hvscManager';
import { SpessaSynth, SpessaSoundFont } from '../engines/spressasynthLib';
import { BasicMIDI } from 'spessasynth_core';
import { SoundFontBankInfo, SoundFontInstrument } from '../types';

interface FileConverterUIProps {
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
    rawMidiBuffer?: ArrayBuffer,
    fileName?: string,
    rawSidBuffer?: ArrayBuffer,
    sidMetadata?: SidHeaderMetadata
  ) => void;
}

export default function FileConverterUI({ onImportSequence }: FileConverterUIProps) {
  const [file, setFile] = useState<{ name: string; size: number; type: string } | null>(null);
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [targetFormat, setTargetFormat] = useState('.MID');
  const [conversionLog, setConversionLog] = useState<string[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [convertedFileUrl, setConvertedFileUrl] = useState<string | null>(null);
  const [convertedDownloadBlobUrl, setConvertedDownloadBlobUrl] = useState<string | null>(null);
  const [parsedPatterns, setParsedPatterns] = useState<any[] | null>(null);
  const [parsedAllPatterns, setParsedAllPatterns] = useState<any[][] | null>(null);
  const [parsedAudioBuffer, setParsedAudioBuffer] = useState<AudioBuffer | null>(null);
  const [parsedRawMidiBuffer, setParsedRawMidiBuffer] = useState<ArrayBuffer | null>(null);
  const [parsedRawSidBuffer, setParsedRawSidBuffer] = useState<ArrayBuffer | null>(null);
  const [parsedSidMetadata, setParsedSidMetadata] = useState<SidHeaderMetadata | null>(null);
  const [parsedHvscLookup, setParsedHvscLookup] = useState<HvscLookupResult | null>(null);
  const [parsedChannelSoundFonts, setParsedChannelSoundFonts] = useState<{ [ch: number]: string } | null>(null);
  const [parsedBpm, setParsedBpm] = useState<number>(120);
  const [parsedDuration, setParsedDuration] = useState<string>("");
  const [parsedTitle, setParsedTitle] = useState<string>("");
  const [parsedChipType, setParsedChipType] = useState<string>("");
  const [parsedChannelsCount, setParsedChannelsCount] = useState<number>(8);
  const [parsedOctaveRange, setParsedOctaveRange] = useState<string>("C-2 - G-5");

  // HVSC Songlengths.md5 & STIL.txt database state
  const [hvscStats, setHvscStats] = useState<HvscCacheStats>(() => getHvscCacheStats());
  const [hvscBusy, setHvscBusy] = useState<boolean>(false);

  // SoundFont state
  const [bankInfo, setBankInfo] = useState<SoundFontBankInfo>(getSoundFontBankInfo());
  const [instruments, setInstruments] = useState<SoundFontInstrument[]>(getAvailableSoundFontInstruments());
  const [selectedAuditionInst, setSelectedAuditionInst] = useState<string>("gm_piano");
  const [savedSoundFonts, setSavedSoundFonts] = useState<SpessaSoundFont[]>(() => SpessaSynth.getLoadedSoundFonts());
  const [activeSfId, setActiveSfId] = useState<string>(() => SpessaSynth.getActiveSoundFont()?.id || 'spessa-default-gm');
  const [defaultSfId, setDefaultSfId] = useState<string>(() => getDefaultSoundFontId());
  const [showSavedSoundFonts, setShowSavedSoundFonts] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const sfInputRef = useRef<HTMLInputElement>(null);
  const songlengthsInputRef = useRef<HTMLInputElement>(null);
  const stilInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBankInfo(getSoundFontBankInfo());
    setInstruments(getAvailableSoundFontInstruments());
    void restoreHvscCachesFromIndexedDB();
    const unsubSf = SpessaSynth.onSoundFontChange((fonts, activeId) => {
      setSavedSoundFonts(fonts);
      setActiveSfId(activeId);
      setBankInfo(getSoundFontBankInfo());
      setInstruments(getAvailableSoundFontInstruments());
    });
    const unsubDef = onDefaultSoundFontChange((id) => {
      setDefaultSfId(id);
    });
    const unsubHvsc = onHvscCacheChange((stats) => {
      setHvscStats(stats);
    });
    return () => {
      unsubSf();
      unsubDef();
      unsubHvsc();
    };
  }, []);

  useEffect(() => {
    if (parsedSidMetadata) {
      setParsedHvscLookup(lookupHvscForSid(parsedSidMetadata, parsedSidMetadata.startSong));
    }
  }, [hvscStats, parsedSidMetadata]);

  const handleAuditionNote = (instId: string) => {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    // Route audition chord exclusively through SpessaSynth engine (Root, 3rd, 5th)
    SpessaSynth.noteOn(0, 60, 90, 0.45); // C4
    setTimeout(() => SpessaSynth.noteOn(0, 64, 85, 0.45), 90); // E4
    setTimeout(() => SpessaSynth.noteOn(0, 67, 95, 0.55), 180); // G4
  };

  const handleSoundFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.target;
    if (inputEl.files && inputEl.files[0]) {
      const sfFile = inputEl.files[0];
      const reader = new FileReader();
      reader.onload = async (event) => {
        if (event.target?.result instanceof ArrayBuffer) {
          try {
            const res = await loadSoundFontIntoCoreAndLib(event.target.result, sfFile.name);
            const allInst = getAvailableSoundFontInstruments();
            setBankInfo(res.bankInfo);
            setInstruments(allInst);
            setConversionLog(prev => [
              ...prev,
              `[SUCCESS] Decoded SoundFont Bank "${res.bankInfo.name}" (${res.soundFont.format || 'SoundBank'}) via spressasynth_core-master.zip & linked into spressasynth_lib-master.zip`,
              ...res.logs
            ]);
            if (res.instruments.length > 0) {
              setSelectedAuditionInst(res.instruments[0].id);
            } else if (allInst.length > 0) {
              setSelectedAuditionInst(allInst[0].id);
            }
          } catch (err: any) {
            setConversionLog(prev => [
              ...prev,
              `[ERROR] Failed reading SoundFont: ${err.message || 'Invalid SoundFont file'}`
            ]);
          }
        }
        inputEl.value = '';
      };
      reader.readAsArrayBuffer(sfFile);
    }
  };

  const executeConversion = (selectedFormat: string) => {
    if (!file || !fileBuffer) return;

    setIsConverting(true);
    setConvertedFileUrl(null);
    setConversionLog([
      `[SYSTEM] Initializing Universal Audio & Chiptune translation engine...`,
      `[INFO] Target output format: ${selectedFormat}`,
      `[INFO] Ingesting document: '${file.name}' (${(file.size / 1024).toFixed(2)} KB)...`
    ]);
    
    setTimeout(() => {
      try {
        if (isSoundFontFileName(file.name)) {
          loadSoundFontIntoCoreAndLib(fileBuffer, file.name).then(sfRes => {
            setBankInfo(sfRes.bankInfo);
            setInstruments(getAvailableSoundFontInstruments());
            setConversionLog(prev => [...prev, ...sfRes.logs]);
          });
        }

        const result = parseChiptuneFile(file.name, fileBuffer);
        setParsedPatterns(result.patterns);
        setParsedAllPatterns(result.allPatterns || [result.patterns]);
        setParsedAudioBuffer(result.audioBuffer || null);
        setParsedRawMidiBuffer(result.rawMidiBuffer || null);
        setParsedRawSidBuffer(result.rawSidBuffer || null);
        setParsedSidMetadata(result.sidMetadata || null);
        if (result.sidMetadata) {
          setParsedHvscLookup(lookupHvscForSid(result.sidMetadata, result.sidMetadata.startSong));
          TinyRsidBridge.registerSidFile(fileBuffer, file.name, result.sidMetadata.startSong);
        } else {
          setParsedHvscLookup(null);
        }
        setParsedChannelSoundFonts(result.channelSoundFonts || null);
        setParsedBpm(result.bpm);
        setParsedDuration(result.duration || "1:20");
        setParsedTitle(result.title || file.name);
        setParsedChipType(result.chipType || "Universal Synthesizer");
        setParsedChannelsCount(result.channelsCount || 8);
        setParsedOctaveRange(result.octaveRange || "C-2 - G-5");
        
        setConversionLog(prev => [
          ...prev, 
          `[INFO] Extracting multi-channel matrix and registers metadata...`,
          ...result.log,
          `[SUCCESS] Mapped Sound Architecture: ${result.chipType}`
        ]);

        setTimeout(() => {
          const outputBaseName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
          const outExt = selectedFormat.toLowerCase();
          const outFileName =
            selectedFormat === '.MID'
              ? `${outputBaseName}_converted.mid`
              : `${outputBaseName}${outExt}`;

          let nextBlobUrl: string | null = null;
          const allPats = result.allPatterns && result.allPatterns.length > 0 ? result.allPatterns : [result.patterns];
          const songTitle = result.title || outputBaseName;
          const songBpm = result.bpm || 125;

          if (selectedFormat === '.MID') {
            try {
              const sourceBuf = result.rawMidiBuffer || fileBuffer;
              const midiObj = BasicMIDI.fromArrayBuffer(sourceBuf.slice(0), file.name);
              const midiBytes = midiObj.writeMIDI();
              nextBlobUrl = URL.createObjectURL(new Blob([midiBytes], { type: 'audio/midi' }));
            } catch {
              const fallbackMid = generateMidiFileBuffer(allPats, songBpm, songTitle);
              nextBlobUrl = URL.createObjectURL(new Blob([fallbackMid], { type: 'audio/midi' }));
            }
          } else if (selectedFormat === '.MOD') {
            const modBuf = generateProTrackerModBuffer(allPats, songTitle, songBpm);
            nextBlobUrl = URL.createObjectURL(new Blob([modBuf], { type: 'audio/x-mod' }));
          } else if (selectedFormat === '.XM') {
            const xmBuf = generateFastTrackerXmBuffer(allPats, songTitle, songBpm);
            nextBlobUrl = URL.createObjectURL(new Blob([xmBuf], { type: 'audio/x-xm' }));
          } else if (selectedFormat === '.S3M') {
            const s3mBuf = generateScreamTrackerS3mBuffer(allPats, songTitle, songBpm);
            nextBlobUrl = URL.createObjectURL(new Blob([s3mBuf], { type: 'audio/x-s3m' }));
          } else if (selectedFormat === '.JSON') {
            const jsonStr = JSON.stringify({
              title: songTitle,
              bpm: songBpm,
              channelsCount: result.channelsCount || 8,
              patternsCount: allPats.length,
              patterns: allPats
            }, null, 2);
            nextBlobUrl = URL.createObjectURL(new Blob([jsonStr], { type: 'application/json' }));
          }

          setConvertedDownloadBlobUrl((prevUrl) => {
            if (prevUrl) URL.revokeObjectURL(prevUrl);
            return nextBlobUrl;
          });

          setConversionLog(prev => [
            ...prev, 
            `[SUCCESS] Compiled translation package!`,
            `[SUCCESS] Output file: ${outFileName}`,
            `[SYSTEM] Real-time sequencer ready for playback.`
          ]);
          setIsConverting(false);
          setConvertedFileUrl(outFileName);
        }, 300);

      } catch (err: any) {
        setConversionLog(prev => [
          ...prev, 
          `[ERROR] Failed parsing binary registers: ${err.message || "Invalid layout structure"}`
        ]);
        setIsConverting(false);
      }
    }, 200);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleSonglengthsFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.target;
    const selected = inputEl.files?.[0];
    if (!selected) return;
    setHvscBusy(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = typeof evt.target?.result === 'string' ? evt.target.result : '';
        const { count } = await loadAndCacheSonglengthsMd5(text);
        setConversionLog(prev => [
          ...prev,
          `[SUCCESS] Indexed & cached ${count.toLocaleString()} HVSC Songlengths.md5 entries in IndexedDB.`
        ]);
      } catch (err: any) {
        setConversionLog(prev => [
          ...prev,
          `[ERROR] Failed parsing Songlengths.md5: ${err.message || 'Invalid format'}`
        ]);
      } finally {
        setHvscBusy(false);
        inputEl.value = '';
      }
    };
    reader.readAsText(selected);
  };

  const handleStilFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.target;
    const selected = inputEl.files?.[0];
    if (!selected) return;
    setHvscBusy(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = typeof evt.target?.result === 'string' ? evt.target.result : '';
        const { count } = await loadAndCacheStilTxt(text);
        setConversionLog(prev => [
          ...prev,
          `[SUCCESS] Indexed & cached ${count.toLocaleString()} HVSC STIL.txt composer notes & trivia blocks in IndexedDB.`
        ]);
      } catch (err: any) {
        setConversionLog(prev => [
          ...prev,
          `[ERROR] Failed parsing STIL.txt: ${err.message || 'Invalid format'}`
        ]);
      } finally {
        setHvscBusy(false);
        inputEl.value = '';
      }
    };
    reader.readAsText(selected);
  };

  const inspectIncomingIntakeFile = (incomingName: string, buf: ArrayBuffer) => {
    const lower = incomingName.toLowerCase();
    if (lower.endsWith('.sid') || lower.endsWith('.mus') || lower.endsWith('.str')) {
      const sidMeta = parseSidHeader(buf, incomingName);
      const hvsc = lookupHvscForSid(sidMeta, sidMeta.startSong);
      setParsedRawSidBuffer(buf.slice(0));
      setParsedSidMetadata(sidMeta);
      setParsedHvscLookup(hvsc);
      TinyRsidBridge.registerSidFile(buf, incomingName, sidMeta.startSong);

      const res = parseChiptuneFile(incomingName, buf);
      setParsedPatterns(res.patterns);
      setParsedAllPatterns(res.allPatterns || [res.patterns]);
      setParsedAudioBuffer(null);
      setParsedRawMidiBuffer(null);
      setParsedChannelSoundFonts(null);
      setParsedBpm(res.bpm);
      setParsedDuration(res.duration || '2:15');
      setParsedTitle(res.title || sidMeta.title);
      setParsedChipType(res.chipType);
      setParsedChannelsCount(res.channelsCount || 3);
      setParsedOctaveRange(res.octaveRange || 'C-1 - G-5');
      setConversionLog([
        `[SYSTEM] Loaded C64 SID binary: '${incomingName}'`,
        ...res.log
      ]);
    } else {
      setParsedRawSidBuffer(null);
      setParsedSidMetadata(null);
      setParsedHvscLookup(null);
      setConversionLog([`[SYSTEM] Loaded document: '${incomingName}'`]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const dropped = e.dataTransfer.files[0];
      setFile({
        name: dropped.name,
        size: dropped.size,
        type: dropped.name.slice(dropped.name.lastIndexOf('.'))
      });
      setConvertedFileUrl(null);
      setParsedPatterns(null);

      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result instanceof ArrayBuffer) {
          setFileBuffer(event.target.result);
          inspectIncomingIntakeFile(dropped.name, event.target.result);
        }
      };
      reader.readAsArrayBuffer(dropped);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      setFile({
        name: selected.name,
        size: selected.size,
        type: selected.name.slice(selected.name.lastIndexOf('.'))
      });
      setConvertedFileUrl(null);
      setParsedPatterns(null);

      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result instanceof ArrayBuffer) {
          setFileBuffer(event.target.result);
          inspectIncomingIntakeFile(selected.name, event.target.result);
        }
      };
      reader.readAsArrayBuffer(selected);
    }
  };

  return (
    <div className="h-full max-w-5xl mx-auto flex flex-col gap-5 p-1 font-mono select-none">
       <div className="text-center py-1">
         <h2 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-emerald-400 to-teal-300 uppercase tracking-widest">
           Universal Music & SoundFont Station
         </h2>
         <p className="text-zinc-400 text-[11px] mt-1 font-sans">
           Translate and play Standard MIDI (.mid, .midi, .rmi, .kar, .xmf), Amiga ProTracker (.mod), FastTracker (.xm), ScreamTracker (.s3m), Impulse Tracker (.it), C64 (.sid), NES (.nsf), Game Boy (.gbs), Sega VGM (.vgm), SNES (.spc), SoundFonts (.sf2/.sf3), and Audio files.
         </p>
       </div>

       {/* SOUNDFONT BANK STATUS & AUDITION STRIP */}
       <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
         <div className="flex items-center gap-2.5">
           <Disc3 size={18} className="text-cyan-400 animate-spin-slow" />
           <div>
             <div className="font-bold text-white text-[11px] flex items-center gap-2">
               <span>SoundFont Bank: {bankInfo.name}</span>
               <span className="text-[9px] px-2 py-0.5 bg-emerald-950/60 border border-emerald-700/50 text-emerald-400 rounded-full font-sans">
                 {bankInfo.instrumentCount} Presets
               </span>
             </div>
             <div className="text-[9.5px] text-zinc-500 font-sans mt-0.5">
               Engine: SF2/SF3 PCM Sampler · Version {bankInfo.version} · Author: {bankInfo.author || "General MIDI"}
             </div>
           </div>
         </div>

         <div className="flex items-center gap-2">
           <select
             value={selectedAuditionInst}
             onChange={(e) => setSelectedAuditionInst(e.target.value)}
             className="bg-black border border-zinc-800 rounded px-2.5 py-1 text-[10.5px] text-cyan-300 font-mono focus:outline-none cursor-pointer"
           >
             {instruments.map(inst => (
               <option key={inst.id} value={inst.id}>
                 {inst.name} {inst.isCustom ? '(Custom SF2)' : ''}
               </option>
             ))}
           </select>

           <button
             onClick={() => handleAuditionNote(selectedAuditionInst)}
             className="px-3 py-1 bg-cyan-950/60 hover:bg-cyan-900/70 text-cyan-300 border border-cyan-800/40 rounded text-[10.5px] font-bold flex items-center gap-1.5 transition cursor-pointer"
             title="Audition sound preview chord"
           >
             <Play size={10} fill="currentColor" />
             <span>Audition</span>
           </button>

           <input 
             type="file"
             ref={sfInputRef}
             onChange={handleSoundFontUpload}
             className="hidden"
           />
           <button
             onClick={() => sfInputRef.current?.click()}
             className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded text-[10.5px] font-bold flex items-center gap-1.5 transition cursor-pointer"
             title="Feed any SoundFont (.sf2, .sf3, .dls, .sfz, .sbk, .gig, .pat, or any format) into spressasynth_core-master.zip -> spressasynth_lib-master.zip"
           >
             <Upload size={11} />
             <span>Load SoundFont</span>
           </button>

           <button
             id="converter-saved-soundfonts-toggle-btn"
             type="button"
             onClick={() => setShowSavedSoundFonts(prev => !prev)}
             aria-expanded={showSavedSoundFonts}
             className={`px-3 py-1 rounded text-[10.5px] font-bold flex items-center gap-1.5 transition cursor-pointer border ${
               showSavedSoundFonts
                 ? 'bg-cyan-950/70 text-cyan-200 border-cyan-500/70'
                 : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border-zinc-700'
             }`}
             title="Show or hide Saved SoundFonts and Set Default controls"
           >
             <Disc3 size={11} className="text-cyan-400" />
             <span>Saved SoundFonts ({savedSoundFonts.length})</span>
             {showSavedSoundFonts ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
           </button>
         </div>
       </div>

       {/* SAVED SOUNDFONTS STRIP (SET DEFAULT & ACTIVATE - COLLAPSIBLE) */}
       {showSavedSoundFonts && (
         <div className="bg-zinc-950/80 border border-zinc-800 rounded-xl px-3 py-2 flex flex-col gap-2 text-xs">
           <div className="flex flex-wrap items-center justify-between gap-2">
             <div className="flex items-center gap-2">
               <Disc3 size={13} className="text-cyan-400" />
               <span className="font-bold text-[10.5px] uppercase tracking-wider text-zinc-200">
                 Saved SoundFonts
               </span>
               <span className="text-[9px] text-zinc-500 font-sans">
                 ({savedSoundFonts.filter(sf => sf.isCustom).length} saved in cookies · {savedSoundFonts.length} total)
               </span>
             </div>
             <span className="text-[9px] text-zinc-500 font-sans">
               Default loads automatically on startup
             </span>
           </div>

           <div className="flex flex-wrap gap-1.5">
             {savedSoundFonts.map((sf) => {
               const isActive = activeSfId === sf.id;
               const isDefault = defaultSfId === sf.id;
               return (
                 <div
                   key={sf.id}
                   className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] transition ${
                     isActive
                       ? 'bg-cyan-950/50 border-cyan-500/60 text-cyan-200'
                       : 'bg-zinc-900/80 border-zinc-800 text-zinc-300'
                   }`}
                 >
                   <button
                     type="button"
                     onClick={() => SpessaSynth.setActiveSoundFont(sf.id)}
                     className="flex items-center gap-1.5 text-left cursor-pointer hover:text-white"
                     title={`Activate "${sf.name}" (${sf.instrumentCount} presets)`}
                   >
                     {isActive && <Check size={10} className="text-cyan-400 shrink-0" />}
                     <span className="font-bold max-w-[160px] truncate">{sf.name}</span>
                     <span className="text-[8.5px] text-zinc-400 font-sans">
                       {sf.format || (sf.isCustom ? 'Saved' : 'Built-in')}
                     </span>
                   </button>

                   <button
                     id={`converter-sf-default-btn-${sf.id}`}
                     type="button"
                     onClick={() => {
                       setDefaultSoundFontId(sf.id);
                       setConversionLog(prev => [
                         ...prev,
                         `[SYSTEM] Set "${sf.name}" as default startup SoundFont (saved in browser cookies).`
                       ]);
                     }}
                     disabled={isDefault}
                     className={`px-1.5 py-0.5 rounded text-[8.5px] font-bold border transition flex items-center gap-1 shrink-0 ${
                       isDefault
                         ? 'bg-amber-950/75 border-amber-500/70 text-amber-300 cursor-default'
                         : 'bg-zinc-950 hover:bg-amber-950/60 border-zinc-700 hover:border-amber-500/60 text-zinc-300 hover:text-amber-200 cursor-pointer'
                     }`}
                     title={isDefault ? 'Default startup SoundFont' : `Set "${sf.name}" to default SoundFont`}
                   >
                     <Star size={9} fill={isDefault ? 'currentColor' : 'none'} />
                     <span>{isDefault ? 'Default' : 'Set Default'}</span>
                   </button>

                   {sf.isCustom && (
                     <button
                       type="button"
                       onClick={async () => {
                         await deleteSavedSoundFont(sf.id);
                         setConversionLog(prev => [
                           ...prev,
                           `[SYSTEM] Removed "${sf.name}" from saved SoundFonts.`
                         ]);
                       }}
                       className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-950/40 transition cursor-pointer shrink-0"
                       title={`Remove "${sf.name}" from saved SoundFonts`}
                     >
                       <Trash2 size={10} />
                     </button>
                   )}
                 </div>
               );
             })}
           </div>
         </div>
       )}

       <div className="grid grid-cols-1 md:grid-cols-2 gap-5 min-h-0">
          
          {/* FILE UPLOAD DROPZONE */}
          <div className="flex flex-col gap-3">
            <h3 className="text-xs uppercase font-bold text-zinc-300 flex items-center gap-1.5 border-b border-zinc-800 pb-2">
              <Upload size={13} className="text-cyan-400" /> Intake Terminal
            </h3>

            <div 
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-zinc-800 bg-zinc-950/60 rounded-xl p-6 flex flex-col items-center justify-center gap-2.5 text-zinc-400 hover:border-cyan-500/50 hover:bg-zinc-900/20 cursor-pointer transition-all h-48 text-center"
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                accept={`.mid,.midi,.rmi,.kar,.xmf,.mod,.xm,.s3m,.it,.sid,.nsf,.nsfe,.gbs,.vgm,.vgz,.spc,.ftm,.sunvox,${SOUNDFONT_ACCEPT_ATTR},.wav,.mp3,.ogg,.flac,.json`}
                onChange={handleFileSelect} 
                className="hidden" 
              />
              <FileAudio size={36} className={`${file ? 'text-cyan-400' : 'text-zinc-600'}`} />
              
              {file ? (
                <div>
                  <div className="font-bold text-xs text-white truncate max-w-[240px]">{file.name}</div>
                  <div className="text-[10px] text-zinc-500 mt-1 font-sans">Size: {(file.size / 1024).toFixed(1)} KB</div>
                  <div className="mt-2.5 inline-flex items-center gap-1 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-bold text-[9px] border border-zinc-700 font-mono tracking-wider transition uppercase">
                     Change File
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1.5">
                  <div className="font-bold text-xs text-zinc-200">Drag &amp; drop any music file or chiptune here</div>
                  <div className="text-zinc-600 text-[9px] font-sans">or</div>
                  <div className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-400 rounded-lg font-bold text-[10.5px] border border-cyan-800/40 font-mono tracking-widest shadow-sm transition uppercase">
                     Browse Files
                  </div>
                  <div className="text-[8.5px] text-zinc-500 mt-1.5 font-sans leading-relaxed max-w-xs">
                     Accepts MIDI (.mid, .rmi, .kar, .xmf), MOD, XM, S3M, IT, C64 (.sid), NES (.nsf), Game Boy (.gbs), Sega VGM, SNES SPC, SoundFonts (.sf2/.sf3), WAV, MP3
                  </div>
                </div>
              )}
            </div>

            {file && (
              <div className="bg-zinc-900/60 border border-zinc-800 p-3 rounded-lg flex items-center justify-between text-[10.5px]">
                <span className="text-zinc-400">Target Export Format:</span>
                <select 
                  value={targetFormat} 
                  onChange={(e) => setTargetFormat(e.target.value)}
                  className="bg-black border border-zinc-800 rounded px-2.5 py-1 text-cyan-300 font-bold focus:outline-none cursor-pointer"
                >
                  <option value=".MID">.MID (Standard MIDI File)</option>
                  <option value=".MOD">.MOD (Amiga ProTracker Module)</option>
                  <option value=".XM">.XM (FastTracker II Extended Module)</option>
                  <option value=".S3M">.S3M (ScreamTracker 3 Module)</option>
                  <option value=".JSON">.JSON (Aria48 Tracker Pattern Matrix)</option>
                </select>
              </div>
            )}
            
            <button
              onClick={() => executeConversion(targetFormat)}
              disabled={!file || isConverting}
              className={`w-full py-3 rounded-lg font-bold text-xs tracking-wider uppercase flex items-center justify-center gap-2 transition-all cursor-pointer ${
                !file 
                  ? 'bg-zinc-900 text-zinc-600 border border-zinc-950 cursor-not-allowed opacity-50' 
                  : isConverting
                    ? 'bg-zinc-800 text-zinc-400 border border-zinc-700 animate-pulse'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.2)]'
              }`}
            >
              <RotateCw size={13} className={isConverting ? 'animate-spin' : ''} />
              <span>{isConverting ? 'Decompressing & translating...' : 'Execute Conversion & Translation'}</span>
            </button>
          </div>

          {/* STREAM OUTPUT LOGS & SID / HVSC TERMINAL */}
          <div className="flex flex-col gap-3">
             <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
               <h3 className="text-xs uppercase font-bold text-zinc-300 flex items-center gap-1.5">
                 <RotateCw size={13} className="text-emerald-400" /> Translation Stream Terminal
               </h3>

               {/* HVSC DATABASE CACHE CONTROLS (Songlengths.md5 & STIL.txt) */}
               <div className="flex flex-wrap items-center gap-1.5">
                 <input
                   type="file"
                   ref={songlengthsInputRef}
                   accept=".md5,.txt"
                   onChange={handleSonglengthsFileUpload}
                   className="hidden"
                 />
                 <input
                   type="file"
                   ref={stilInputRef}
                   accept=".txt"
                   onChange={handleStilFileUpload}
                   className="hidden"
                 />
                 <button
                   id="hvsc-load-songlengths-btn"
                   type="button"
                   disabled={hvscBusy}
                   onClick={() => songlengthsInputRef.current?.click()}
                   className={`px-2 py-0.5 rounded text-[9px] font-bold border transition cursor-pointer flex items-center gap-1 ${
                     hvscStats.songlengthsCount > 0
                       ? 'bg-sky-950/70 border-sky-500/60 text-sky-300'
                       : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-700 text-zinc-300'
                   }`}
                   title="Load & cache HVSC Songlengths.md5 for exact subtune durations"
                 >
                   <Database size={10} />
                   <span>
                     {hvscStats.songlengthsCount > 0
                       ? `Songlengths (${hvscStats.songlengthsCount.toLocaleString()})`
                       : 'Load Songlengths.md5'}
                   </span>
                 </button>

                 <button
                   id="hvsc-load-stil-btn"
                   type="button"
                   disabled={hvscBusy}
                   onClick={() => stilInputRef.current?.click()}
                   className={`px-2 py-0.5 rounded text-[9px] font-bold border transition cursor-pointer flex items-center gap-1 ${
                     hvscStats.stilCount > 0
                       ? 'bg-emerald-950/70 border-emerald-500/60 text-emerald-300'
                       : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-700 text-zinc-300'
                   }`}
                   title="Load & cache HVSC STIL.txt for composer liner notes & cover trivia"
                 >
                   <FileText size={10} />
                   <span>
                     {hvscStats.stilCount > 0
                       ? `STIL.txt (${hvscStats.stilCount.toLocaleString()})`
                       : 'Load STIL.txt'}
                   </span>
                 </button>

                 {(hvscStats.songlengthsCount > 0 || hvscStats.stilCount > 0) && (
                   <button
                     id="hvsc-clear-cache-btn"
                     type="button"
                     onClick={() => void clearHvscCache('all')}
                     className="p-0.5 px-1.5 rounded text-[9px] bg-zinc-900 hover:bg-red-950/50 border border-zinc-800 hover:border-red-600/50 text-zinc-500 hover:text-red-300 cursor-pointer"
                     title="Clear cached HVSC Songlengths & STIL databases"
                   >
                     <Trash2 size={10} />
                   </button>
                 )}
               </div>
             </div>

             <div className="flex-1 bg-black border border-zinc-850 p-3 font-mono text-[9.5px] text-zinc-400 overflow-y-auto rounded-xl max-h-[340px] custom-scrollbar flex flex-col gap-2 min-h-[220px]">
                {/* SID METADATA, HEX MEMORY READOUT & HVSC STIL NOTES */}
                {parsedSidMetadata && (
                  <div
                    id="sid-metadata-readout-panel"
                    className="bg-zinc-950/90 border border-sky-800/50 rounded-lg p-2.5 flex flex-col gap-2 text-[9.5px]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-1.5">
                      <div className="flex items-center gap-1.5 text-sky-300 font-bold uppercase tracking-wider">
                        <Cpu size={12} className="text-sky-400" />
                        <span>C64 SID Metadata &amp; Memory Readout</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="px-1.5 py-0.5 rounded bg-sky-950/80 border border-sky-600/50 text-sky-300 font-bold">
                          {parsedSidMetadata.magic} v{parsedSidMetadata.version}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-600/50 text-emerald-300 font-bold">
                          {parsedSidMetadata.chipCountLabel}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-600/50 text-amber-300 font-bold">
                          {parsedSidMetadata.chipModel}
                        </span>
                      </div>
                    </div>

                    {/* Primary Tag Grid */}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9.5px]">
                      <div>
                        <span className="text-zinc-500">TITLE: </span>
                        <span className="text-white font-bold">{parsedSidMetadata.title}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">AUTHOR: </span>
                        <span className="text-cyan-300 font-bold">{parsedSidMetadata.author}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">RELEASED: </span>
                        <span className="text-zinc-300">{parsedSidMetadata.released}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">CLOCK / SUBTUNES: </span>
                        <span className="text-emerald-300 font-bold">
                          {parsedSidMetadata.clock} · {parsedSidMetadata.startSong}/{parsedSidMetadata.songs}
                        </span>
                      </div>
                    </div>

                    {/* Hex Memory Map */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-zinc-900">
                      <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                        LOAD <strong className="text-cyan-400">{formatHexAddr(parsedSidMetadata.loadAddress)}</strong>
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                        INIT <strong className="text-emerald-400">{formatHexAddr(parsedSidMetadata.initAddress)}</strong>
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                        PLAY <strong className="text-amber-400">{formatHexAddr(parsedSidMetadata.playAddress)}</strong>
                      </span>
                      {parsedSidMetadata.secondSIDAddress && (
                        <span className="px-1.5 py-0.5 rounded bg-sky-950/60 border border-sky-700/50 text-sky-300">
                          2ND SID <strong>{formatHexAddr(parsedSidMetadata.secondSIDAddress)}</strong>
                        </span>
                      )}
                      {parsedSidMetadata.thirdSIDAddress && (
                        <span className="px-1.5 py-0.5 rounded bg-purple-950/60 border border-purple-700/50 text-purple-300">
                          3RD SID <strong>{formatHexAddr(parsedSidMetadata.thirdSIDAddress)}</strong>
                        </span>
                      )}
                    </div>

                    {/* HVSC MD5 + Subtune Durations */}
                    <div className="flex flex-col gap-1 pt-1 border-t border-zinc-900">
                      <div className="flex flex-wrap items-center justify-between gap-1 text-[8.5px]">
                        <span className="text-zinc-500 truncate">
                          MD5: <span className="text-zinc-300 select-all">{parsedSidMetadata.md5}</span>
                        </span>
                        <span className={`px-1.5 py-0.2 rounded font-bold ${
                          parsedHvscLookup?.songlength
                            ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-700/50'
                            : 'bg-zinc-900 text-zinc-500 border border-zinc-800'
                        }`}>
                          {parsedHvscLookup?.songlength
                            ? `HVSC ${parsedHvscLookup.matchedBy.toUpperCase()} MATCH`
                            : 'Load Songlengths.md5 for exact times'}
                        </span>
                      </div>

                      {parsedHvscLookup?.subtuneDurationsSec && parsedHvscLookup.subtuneDurationsSec.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {parsedHvscLookup.subtuneDurationsSec.map((sec, idx) => (
                            <span
                              key={idx}
                              className={`px-1.5 py-0.2 rounded text-[8.5px] border ${
                                idx + 1 === parsedSidMetadata.startSong
                                  ? 'bg-sky-950/80 border-sky-500/70 text-sky-200 font-bold'
                                  : 'bg-zinc-900 border-zinc-800 text-zinc-400'
                              }`}
                            >
                              #{idx + 1} {formatTimeMsPrecise(sec)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* HVSC STIL.txt Scrollable Liner Notes & Trivia */}
                    <div className="border-t border-zinc-900 pt-1.5">
                      <div className="text-[8.5px] uppercase font-bold text-amber-300 mb-1 flex items-center justify-between">
                        <span>HVSC STIL.txt Composer Notes &amp; Trivia</span>
                        {parsedHvscLookup?.stil?.hvscPath && (
                          <span className="text-zinc-500 font-normal normal-case truncate max-w-[200px]">
                            {parsedHvscLookup.stil.hvscPath}
                          </span>
                        )}
                      </div>
                      <div
                        id="sid-stil-notes-scrollbox"
                        className="max-h-28 overflow-y-auto custom-scrollbar bg-black/70 border border-zinc-900 rounded p-2 text-[9px] text-zinc-300 whitespace-pre-wrap leading-relaxed"
                      >
                        {parsedHvscLookup?.stil ? (
                          <>
                            {parsedHvscLookup.stil.comment && (
                              <div className="mb-1.5">{parsedHvscLookup.stil.comment}</div>
                            )}
                            {parsedHvscLookup.stil.subtuneNotes.map((sn) => (
                              <div key={sn.subtune} className="mt-1 pt-1 border-t border-zinc-900">
                                <span className="text-sky-400 font-bold">(#{sn.subtune}) </span>
                                <span>{sn.text}</span>
                              </div>
                            ))}
                          </>
                        ) : (
                          <span className="text-zinc-500 font-sans italic">
                            {hvscStats.stilCount > 0
                              ? 'No matching STIL.txt commentary found for this SID tune.'
                              : 'Click "Load STIL.txt" above to cache HVSC composer notes and cover trivia.'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {conversionLog.length === 0 && !parsedSidMetadata ? (
                  <div className="text-zinc-600 flex flex-col items-center justify-center h-full gap-2 text-center py-12 font-sans text-[10.5px]">
                     <HelpCircle size={28} className="text-zinc-700" />
                     Intake valid music files, chiptunes, or SoundFonts above to parse wave registers, channels, and envelopes.
                  </div>
                ) : (
                  conversionLog.map((log, i) => (
                    <div 
                      key={i} 
                      className={`${
                        log.startsWith('[SUCCESS]') 
                          ? 'text-emerald-400 font-bold' 
                          : log.startsWith('[SYSTEM]') 
                            ? 'text-cyan-400' 
                            : log.startsWith('[ERROR]')
                              ? 'text-red-400 font-bold'
                              : 'text-zinc-400'
                      }`}
                    >
                      {log}
                    </div>
                  ))
                )}
             </div>

             {/* Direct Load Button for SID or Dynamic Download Banner */}
             {parsedSidMetadata && parsedPatterns && onImportSequence && !convertedFileUrl && (
               <button
                 id="sid-load-workstation-btn"
                 onClick={() => {
                   onImportSequence(
                     parsedPatterns,
                     parsedBpm,
                     parsedDuration,
                     parsedTitle,
                     parsedChipType,
                     parsedOctaveRange,
                     parsedChannelsCount,
                     parsedAllPatterns || undefined,
                     parsedAudioBuffer || undefined,
                     parsedChannelSoundFonts || undefined,
                     parsedRawMidiBuffer || undefined,
                     file?.name,
                     parsedRawSidBuffer || undefined,
                     parsedSidMetadata || undefined
                   );
                 }}
                 className="w-full py-2.5 bg-sky-950/70 hover:bg-sky-900/80 text-sky-300 border border-sky-600/50 hover:text-white rounded-xl font-bold text-xs uppercase tracking-widest transition cursor-pointer flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(56,189,248,0.18)] font-mono"
               >
                 <span>▶ PLAY IN TINYRSSID / TRACKER WORKSTATION</span>
               </button>
             )}

             {convertedFileUrl && (
                <div className="flex flex-col gap-2.5">
                  <div className="bg-emerald-950/20 border-2 border-emerald-500/30 rounded-xl p-3 flex items-center justify-between animate-bounce">
                    <div className="flex items-center gap-2 text-[10.5px]">
                       <CheckCircle2 size={16} className="text-emerald-400" />
                       <div>
                         <div className="font-bold text-white uppercase text-[9px] tracking-wider">COMPILATION SUCCESSFUL</div>
                         <div className="text-zinc-400 text-[10px] mt-0.5 truncate max-w-[200px]" title={convertedFileUrl}>{convertedFileUrl}</div>
                       </div>
                    </div>
                    <a 
                      href={convertedDownloadBlobUrl || `data:text/plain;charset=utf-8,${encodeURIComponent("Aria48 Tracker Generated Binary File Stream")}`} 
                      download={convertedFileUrl}
                      className="p-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-bold hover:shadow transition-all flex items-center gap-1.5 cursor-pointer text-[10px]"
                    >
                      <Download size={12} />
                      <span>DOWNLOAD</span>
                    </a>
                  </div>

                  {parsedPatterns && onImportSequence && (
                    <button
                      onClick={() => {
                        onImportSequence(
                          parsedPatterns, 
                          parsedBpm, 
                          parsedDuration, 
                          parsedTitle, 
                          parsedChipType,
                          parsedOctaveRange,
                          parsedChannelsCount,
                          parsedAllPatterns || undefined,
                          parsedAudioBuffer || undefined,
                          parsedChannelSoundFonts || undefined,
                          parsedRawMidiBuffer || undefined,
                          file?.name,
                          parsedRawSidBuffer || undefined,
                          parsedSidMetadata || undefined
                        );
                      }}
                      className="w-full py-3 bg-cyan-950/60 hover:bg-cyan-900/70 text-cyan-400 border border-cyan-800/40 hover:text-white rounded-xl font-bold text-xs uppercase tracking-widest transition cursor-pointer flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(34,211,238,0.1)] font-mono duration-300"
                    >
                      <span>⚡ LOAD IN ACTIVE MATRIX PLAYER ⚡</span>
                    </button>
                  )}
                </div>
             )}
          </div>
       </div>
    </div>
  );
}
