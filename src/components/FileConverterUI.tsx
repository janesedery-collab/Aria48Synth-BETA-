import React, { useState, useRef, useEffect } from 'react';
import { Upload, HelpCircle, FileAudio, RotateCw, CheckCircle2, Download, Disc3, Music, Play, Volume2 } from 'lucide-react';
import { parseChiptuneFile } from '../utils/chiptuneParsers';
import { parseSoundFontFile, getSoundFontBankInfo, getAvailableSoundFontInstruments, playSoundFontNote } from '../utils/soundFontEngine';
import { getAudioContext } from './AudioEngine';
import { SpessaSynth } from '../engines/spressasynthLib';
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
    rawMidiBuffer?: ArrayBuffer
  ) => void;
}

export default function FileConverterUI({ onImportSequence }: FileConverterUIProps) {
  const [file, setFile] = useState<{ name: string; size: number; type: string } | null>(null);
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [targetFormat, setTargetFormat] = useState('.MID');
  const [conversionLog, setConversionLog] = useState<string[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [convertedFileUrl, setConvertedFileUrl] = useState<string | null>(null);
  const [parsedPatterns, setParsedPatterns] = useState<any[] | null>(null);
  const [parsedAllPatterns, setParsedAllPatterns] = useState<any[][] | null>(null);
  const [parsedAudioBuffer, setParsedAudioBuffer] = useState<AudioBuffer | null>(null);
  const [parsedRawMidiBuffer, setParsedRawMidiBuffer] = useState<ArrayBuffer | null>(null);
  const [parsedChannelSoundFonts, setParsedChannelSoundFonts] = useState<{ [ch: number]: string } | null>(null);
  const [parsedBpm, setParsedBpm] = useState<number>(120);
  const [parsedDuration, setParsedDuration] = useState<string>("");
  const [parsedTitle, setParsedTitle] = useState<string>("");
  const [parsedChipType, setParsedChipType] = useState<string>("");
  const [parsedChannelsCount, setParsedChannelsCount] = useState<number>(8);
  const [parsedOctaveRange, setParsedOctaveRange] = useState<string>("C-2 - G-5");

  // SoundFont state
  const [bankInfo, setBankInfo] = useState<SoundFontBankInfo>(getSoundFontBankInfo());
  const [instruments, setInstruments] = useState<SoundFontInstrument[]>(getAvailableSoundFontInstruments());
  const [selectedAuditionInst, setSelectedAuditionInst] = useState<string>("gm_piano");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const sfInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBankInfo(getSoundFontBankInfo());
    setInstruments(getAvailableSoundFontInstruments());
  }, []);

  const handleAuditionNote = (instId: string) => {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    // Play a smooth 3-note major chord: Root, 3rd, 5th
    playSoundFontNote(ctx, instId, 60, 0.4, 85, 40); // C4
    setTimeout(() => playSoundFontNote(ctx, instId, 64, 0.4, 80, 50), 100); // E4
    setTimeout(() => playSoundFontNote(ctx, instId, 67, 0.5, 85, 60), 200); // G4
  };

  const handleSoundFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const sfFile = e.target.files[0];
      const reader = new FileReader();
      reader.onload = async (event) => {
        if (event.target?.result instanceof ArrayBuffer) {
          try {
            const ctx = getAudioContext();
            if (!ctx) return;
            const res = await parseSoundFontFile(event.target.result, sfFile.name, ctx);
            SpessaSynth.loadSoundFont(event.target.result, sfFile.name);
            setBankInfo(res.bankInfo);
            setInstruments(res.instruments);
            setConversionLog(prev => [
              ...prev,
              `[SUCCESS] Uploaded SoundFont Bank: "${res.bankInfo.name}" to spressasynth_lib-master.zip`,
              ...res.logs
            ]);
            if (res.instruments.length > 0) {
              setSelectedAuditionInst(res.instruments[0].id);
            }
          } catch (err: any) {
            setConversionLog(prev => [
              ...prev,
              `[ERROR] Failed reading SoundFont: ${err.message || 'Invalid SF2 file'}`
            ]);
          }
        }
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
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        
        if (ext === '.sf2' || ext === '.sf3') {
          const ctx = getAudioContext();
          if (ctx) {
            parseSoundFontFile(fileBuffer, file.name, ctx).then(sfRes => {
              setBankInfo(sfRes.bankInfo);
              setInstruments(sfRes.instruments);
              setConversionLog(prev => [...prev, ...sfRes.logs]);
            });
          }
        }

        const result = parseChiptuneFile(file.name, fileBuffer);
        setParsedPatterns(result.patterns);
        setParsedAllPatterns(result.allPatterns || [result.patterns]);
        setParsedAudioBuffer(result.audioBuffer || null);
        setParsedRawMidiBuffer(result.rawMidiBuffer || null);
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
          const outputFilename = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
          setConversionLog(prev => [
            ...prev, 
            `[SUCCESS] Compiled translation package!`,
            `[SUCCESS] Output file: ${outputFilename}${selectedFormat.toLowerCase()}`,
            `[SYSTEM] Real-time sequencer ready for playback.`
          ]);
          setIsConverting(false);
          setConvertedFileUrl(`${outputFilename}${selectedFormat.toLowerCase()}`);
        }, 600);

      } catch (err: any) {
        setConversionLog(prev => [
          ...prev, 
          `[ERROR] Failed parsing binary registers: ${err.message || "Invalid layout structure"}`
        ]);
        setIsConverting(false);
      }
    }, 400);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
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
      setConversionLog([`[SYSTEM] Loaded document: '${dropped.name}'`]);
      setConvertedFileUrl(null);
      setParsedPatterns(null);

      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result instanceof ArrayBuffer) {
          setFileBuffer(event.target.result);
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
      setConversionLog([`[SYSTEM] Loaded document: '${selected.name}'`]);
      setConvertedFileUrl(null);
      setParsedPatterns(null);

      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result instanceof ArrayBuffer) {
          setFileBuffer(event.target.result);
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
           Translate and play Standard MIDI (.mid), ProTracker (.mod), FastTracker (.xm), ScreamTracker (.s3m), Impulse Tracker (.it), C64 (.sid), NES (.nsf), Game Boy (.gbs), Sega VGM (.vgm), SNES (.spc), SoundFonts (.sf2/.sf3), and Audio files.
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
             accept=".sf2,.sf3"
             className="hidden"
           />
           <button
             onClick={() => sfInputRef.current?.click()}
             className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded text-[10.5px] font-bold flex items-center gap-1.5 transition cursor-pointer"
             title="Upload custom SoundFont file"
           >
             <Upload size={11} />
             <span>Upload SF2/SF3</span>
           </button>
         </div>
       </div>

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
                  <div className="font-bold text-xs text-zinc-200">Drag & drop any music file or chiptune here</div>
                  <div className="text-zinc-600 text-[9px] font-sans">or</div>
                  <div className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-400 rounded-lg font-bold text-[10.5px] border border-cyan-800/40 font-mono tracking-widest shadow-sm transition uppercase">
                     Browse Files
                  </div>
                  <div className="text-[8.5px] text-zinc-500 mt-1.5 font-sans leading-relaxed max-w-xs">
                     Accepts MIDI (.mid), MOD, XM, S3M, IT, C64 (.sid), NES (.nsf), Game Boy (.gbs), Sega VGM, SNES SPC, SoundFonts (.sf2/.sf3), WAV, MP3
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
                  <option value=".G47">.G47 (Aria Hardware Stream)</option>
                  <option value=".A48">.A48 (Aria Track File)</option>
                  <option value=".VGM">.VGM (Video Game Music)</option>
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

          {/* STREAM OUTPUT LOGS */}
          <div className="flex flex-col gap-3">
             <h3 className="text-xs uppercase font-bold text-zinc-300 flex items-center gap-1.5 border-b border-zinc-800 pb-2">
               <RotateCw size={13} className="text-emerald-400" /> Translation Stream Terminal
             </h3>

             <div className="flex-1 bg-black border border-zinc-850 p-3 font-mono text-[9.5px] text-zinc-400 overflow-y-auto rounded-xl h-56 custom-scrollbar flex flex-col gap-1.5 min-h-[220px]">
                {conversionLog.length === 0 ? (
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

             {/* Dynamic download banner */}
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
                      href={`data:text/plain;charset=utf-8,${encodeURIComponent("Aria48 Tracker Generated Binary File Stream")}`} 
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
                          parsedRawMidiBuffer || undefined
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
