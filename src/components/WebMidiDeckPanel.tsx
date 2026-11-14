import React, { useEffect, useState } from 'react';
import {
  Cable,
  ExternalLink,
  Keyboard,
  Layers,
  Music2,
  Piano,
  Radio,
  RefreshCw,
  ShieldAlert,
  VolumeX
} from 'lucide-react';
import {
  LoadedSequenceMetadata,
  SequenceSamplePresetInfo,
  WebMidiState,
  WorkletSynthBridge
} from '../engines/workletSynthBridge';
import { getAudioContext } from './AudioEngine';

export function SequenceMetadataStrip({ compact = false }: { compact?: boolean }) {
  const [meta, setMeta] = useState<LoadedSequenceMetadata | null>(() => WorkletSynthBridge.getSequenceMetadata());
  const [auditioningIdx, setAuditioningIdx] = useState<number | null>(null);
  const [showAllPresets, setShowAllPresets] = useState(false);

  useEffect(() => {
    setMeta(WorkletSynthBridge.getSequenceMetadata());
    const unsub = WorkletSynthBridge.subscribe(() => {
      setMeta(WorkletSynthBridge.getSequenceMetadata());
    });
    return () => unsub();
  }, []);

  if (!meta) return null;

  const presetsToShow = showAllPresets
    ? meta.samplePresets
    : meta.samplePresets.slice(0, compact ? 8 : 14);

  const handleAuditionSamplePreset = (preset: SequenceSamplePresetInfo, idx: number) => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    void WorkletSynthBridge.init(ctx || undefined).then(() => {
      const ch = preset.isDrum ? 9 : 0;
      WorkletSynthBridge.selectPreset(ch, preset.bankMSB, preset.bankLSB, preset.program, preset.isDrum);
      WorkletSynthBridge.noteOn(ch, preset.isDrum ? 36 : 60, 110);
      setAuditioningIdx(idx);
      setTimeout(() => {
        WorkletSynthBridge.noteOff(ch, preset.isDrum ? 36 : 60);
        setAuditioningIdx((cur) => (cur === idx ? null : cur));
      }, 360);
    });
  };

  return (
    <div
      id="sequence-metadata-strip"
      className="mb-2.5 p-2.5 bg-zinc-950/90 border border-emerald-700/40 rounded-xl flex flex-col gap-2 text-xs font-mono"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-500/60 text-emerald-300 font-black text-[9.5px] uppercase tracking-wider shrink-0">
            {meta.format}
          </span>
          {meta.isTrackerConverted && (
            <span className="px-2 py-0.5 rounded bg-cyan-950/70 border border-cyan-500/50 text-cyan-300 font-bold text-[9px] uppercase tracking-wider shrink-0">
              spessasynth_core → MIDI{meta.hasEmbeddedSoundBank ? ' + Embedded Samples' : ''}
            </span>
          )}
          <div className="flex items-center gap-1.5 min-w-0">
            <Music2 size={12} className="text-emerald-400 shrink-0" />
            <span className="font-bold text-white truncate max-w-[260px]" title={meta.title}>
              {meta.title}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[9.5px]">
          <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
            <Layers size={10} className="inline mr-1 text-cyan-400" />
            <strong className="text-white">{meta.patternCount}</strong> Patterns ·{' '}
            <strong className="text-white">{meta.rowCount}</strong> Rows
          </span>

          <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
            Active CH ({meta.activeChannels.length}):{' '}
            <strong className="text-emerald-300">
              {meta.activeChannels.length > 0
                ? meta.activeChannels.map((c) => c + 1).join(', ')
                : 'None'}
            </strong>
          </span>

          <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-amber-300 font-bold">
            {meta.bpm} BPM
          </span>
        </div>
      </div>

      {meta.samplePresets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-zinc-800/80">
          <span className="text-[9px] uppercase tracking-wider text-zinc-400 font-bold mr-1 shrink-0">
            Auto-Generated Sample Presets ({meta.samplePresets.length}):
          </span>
          {presetsToShow.map((preset, idx) => (
            <button
              key={`${preset.bankMSB}-${preset.program}-${idx}`}
              type="button"
              onClick={() => handleAuditionSamplePreset(preset, idx)}
              title={`Click to audition ${preset.name} (Bank ${preset.bankMSB}, Prog ${preset.program})`}
              className={`px-2 py-0.5 rounded border text-[9px] font-mono transition cursor-pointer flex items-center gap-1 ${
                auditioningIdx === idx
                  ? 'bg-emerald-500/25 border-emerald-400 text-emerald-200'
                  : 'bg-zinc-900/90 hover:bg-zinc-800 border-zinc-800 hover:border-cyan-500/50 text-zinc-300'
              }`}
            >
              <span className="text-cyan-400 font-bold">#{preset.program.toString().padStart(2, '0')}</span>
              <span className="truncate max-w-[135px]">{preset.name}</span>
            </button>
          ))}
          {meta.samplePresets.length > presetsToShow.length && (
            <button
              type="button"
              onClick={() => setShowAllPresets(true)}
              className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-cyan-300 text-[9px] hover:bg-zinc-800 cursor-pointer"
            >
              +{meta.samplePresets.length - presetsToShow.length} More
            </button>
          )}
          {showAllPresets && meta.samplePresets.length > (compact ? 8 : 14) && (
            <button
              type="button"
              onClick={() => setShowAllPresets(false)}
              className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-400 text-[9px] hover:bg-zinc-800 cursor-pointer"
            >
              Collapse
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface WebMidiDeckPanelProps {
  compact?: boolean;
  onStatusLog?: (msg: string) => void;
}

export default function WebMidiDeckPanel({ compact = false, onStatusLog }: WebMidiDeckPanelProps) {
  const [webMidi, setWebMidi] = useState<WebMidiState>(() => WorkletSynthBridge.getWebMidiState());
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    setWebMidi(WorkletSynthBridge.getWebMidiState());
    const unsub = WorkletSynthBridge.subscribe(() => {
      setWebMidi(WorkletSynthBridge.getWebMidiState());
    });
    return () => unsub();
  }, []);

  const handleConnectMidi = async () => {
    setIsConnecting(true);
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch {}
    }
    await WorkletSynthBridge.init(ctx || undefined);
    const state = await WorkletSynthBridge.requestWebMidiAccess();
    setWebMidi(state);
    setIsConnecting(false);
    if (state.errorMessage) {
      onStatusLog?.(`[WEB MIDI] ${state.errorMessage}`);
    } else {
      onStatusLog?.(
        `[WEB MIDI] Connected (${state.sysexEnabled ? 'SysEx ON' : 'Standard'}) — ${state.inputs.length} input(s), ${state.outputs.length} output(s)`
      );
    }
  };

  const handleRefresh = () => {
    WorkletSynthBridge.refreshWebMidiPorts();
    const state = WorkletSynthBridge.getWebMidiState();
    setWebMidi(state);
    onStatusLog?.(`[WEB MIDI] Refreshed ports: ${state.inputs.length} in / ${state.outputs.length} out`);
  };

  const statusBadge = (() => {
    if (webMidi.status === 'ready') {
      return {
        label: webMidi.sysexEnabled ? 'READY · SysEx ON' : 'READY · STANDARD',
        cls: 'bg-emerald-950/60 border-emerald-500/60 text-emerald-300'
      };
    }
    if (webMidi.status === 'blocked') {
      return {
        label: webMidi.sandboxBlocked ? 'SANDBOX BLOCKED' : 'PERMISSION DENIED',
        cls: 'bg-amber-950/60 border-amber-500/60 text-amber-300'
      };
    }
    if (webMidi.status === 'unsupported') {
      return {
        label: 'UNSUPPORTED BROWSER',
        cls: 'bg-red-950/60 border-red-500/60 text-red-300'
      };
    }
    return {
      label: 'NOT INITIALIZED',
      cls: 'bg-zinc-900 border-zinc-700 text-zinc-400'
    };
  })();

  const standaloneUrl = typeof window !== 'undefined' ? window.location.href : '/';

  return (
    <div
      id="web-midi-deck-panel"
      className={`bg-zinc-900/80 border border-indigo-800/50 rounded-xl flex flex-col gap-3 font-mono ${
        compact ? 'p-3' : 'p-4'
      }`}
    >
      {/* HEADER BAR */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
        <div className="flex items-center gap-2">
          <Keyboard size={15} className="text-indigo-400" />
          <div>
            <h3 className="text-[11px] font-black uppercase tracking-wider text-white">
              Web MIDI Hardware Interface (Keyboards &amp; External Synths)
            </h3>
            <p className="text-[9px] text-zinc-400 font-sans">
              Bi-directional SysEx-capable Web MIDI Input Thru &amp; Sequencer MIDI Output routing
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 rounded border text-[8.5px] font-bold uppercase ${statusBadge.cls}`}>
            {statusBadge.label}
          </span>

          <button
            id="web-midi-connect-btn"
            type="button"
            onClick={handleConnectMidi}
            disabled={isConnecting}
            className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[9.5px] uppercase tracking-wider flex items-center gap-1.5 transition cursor-pointer disabled:opacity-60"
          >
            <Cable size={11} />
            <span>{isConnecting ? 'Scanning...' : webMidi.status === 'ready' ? 'Rescan Web MIDI' : 'Connect Web MIDI'}</span>
          </button>

          {webMidi.status === 'ready' && (
            <button
              id="web-midi-refresh-btn"
              type="button"
              onClick={handleRefresh}
              className="p-1.5 rounded bg-zinc-950 border border-zinc-700 hover:border-cyan-500/60 text-zinc-300 hover:text-cyan-300 transition cursor-pointer"
              title="Refresh MIDI Input/Output Ports"
            >
              <RefreshCw size={11} />
            </button>
          )}
        </div>
      </div>

      {/* IFRAME SANDBOX / ERROR BANNER */}
      {webMidi.errorMessage && (
        <div
          id="web-midi-sandbox-warning"
          className="p-3 rounded-lg bg-amber-950/35 border border-amber-500/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-amber-200 text-[10px]"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="font-sans leading-relaxed">
              <strong className="font-mono uppercase text-amber-300 block mb-0.5">
                {webMidi.sandboxBlocked ? 'Iframe Sandbox Restriction Detected' : 'Web MIDI Notice'}
              </strong>
              <span>{webMidi.errorMessage}</span>
            </div>
          </div>

          {webMidi.sandboxBlocked && (
            <a
              id="web-midi-standalone-link"
              href={standaloneUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-mono font-black text-[9.5px] uppercase tracking-wider flex items-center gap-1.5 shrink-0 transition"
            >
              <ExternalLink size={11} />
              <span>Open Standalone Tab</span>
            </a>
          )}
        </div>
      )}

      {/* INPUT + OUTPUT TWO-COLUMN GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* WEB MIDI INPUT (EXTERNAL KEYBOARDS & CONTROLLERS) */}
        <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300 flex items-center gap-1.5">
              <Piano size={12} />
              MIDI Input (External Keyboards)
            </span>
            <span className="text-[9px] text-zinc-500">{webMidi.inputs.length} port(s)</span>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-zinc-400 uppercase font-bold">Input Port</label>
            <select
              id="web-midi-input-select"
              value={webMidi.selectedInputId}
              onChange={(e) => WorkletSynthBridge.setSelectedMidiInputId(e.target.value)}
              className="w-full bg-black border border-zinc-800 rounded px-2 py-1.5 text-[10.5px] text-cyan-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
            >
              {webMidi.inputs.length === 0 ? (
                <option value="">
                  {webMidi.status === 'ready'
                    ? 'No MIDIInput devices detected'
                    : 'Click "Connect Web MIDI" to scan ports'}
                </option>
              ) : (
                webMidi.inputs.map((inp) => (
                  <option key={inp.id} value={inp.id}>
                    {inp.name} ({inp.manufacturer})
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2 items-center">
            <label className="flex items-center gap-2 text-[10px] text-zinc-200 cursor-pointer bg-zinc-900/80 border border-zinc-800 rounded px-2.5 py-1.5">
              <input
                id="web-midi-thru-toggle"
                type="checkbox"
                checked={webMidi.midiThruEnabled}
                onChange={(e) => WorkletSynthBridge.setMidiThruEnabled(e.target.checked)}
                className="accent-cyan-500 cursor-pointer"
              />
              <span className="font-bold">Enable MIDI Thru</span>
            </label>

            <div className="flex flex-col gap-0.5">
              <select
                id="web-midi-input-channel-filter"
                value={webMidi.inputChannelFilter === 'all' ? 'all' : String(webMidi.inputChannelFilter)}
                onChange={(e) => {
                  const val = e.target.value;
                  WorkletSynthBridge.setInputChannelFilter(val === 'all' ? 'all' : parseInt(val, 10));
                }}
                aria-label="Input Channel Filter"
                className="w-full bg-black border border-zinc-800 rounded px-2 py-1.5 text-[10px] text-zinc-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
              >
                <option value="all">Channel Filter: All (1–16)</option>
                {Array.from({ length: 16 }, (_, ch) => (
                  <option key={ch} value={String(ch)}>
                    Filter: Channel {ch + 1}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="text-[9px] text-zinc-400 bg-black/60 border border-zinc-850 rounded px-2 py-1 truncate">
            <span className="text-cyan-400 font-bold mr-1">IN:</span>
            {webMidi.lastInputActivity}
          </div>
        </div>

        {/* WEB MIDI OUTPUT (EXTERNAL SYNTHESIZERS & VIRTUAL PORTS) */}
        <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300 flex items-center gap-1.5">
              <Radio size={12} />
              MIDI Output (External Synths)
            </span>
            <span className="text-[9px] text-zinc-500">{webMidi.outputs.length} port(s)</span>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-zinc-400 uppercase font-bold">Output Port</label>
            <select
              id="web-midi-output-select"
              value={webMidi.selectedOutputId}
              onChange={(e) => WorkletSynthBridge.setSelectedMidiOutputId(e.target.value)}
              className="w-full bg-black border border-zinc-800 rounded px-2 py-1.5 text-[10.5px] text-emerald-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
            >
              {webMidi.outputs.length === 0 ? (
                <option value="">
                  {webMidi.status === 'ready'
                    ? 'No MIDIOutput devices detected'
                    : 'Click "Connect Web MIDI" to scan ports'}
                </option>
              ) : (
                webMidi.outputs.map((out) => (
                  <option key={out.id} value={out.id}>
                    {out.name} ({out.manufacturer})
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[10px] text-zinc-200 cursor-pointer bg-zinc-900/80 border border-zinc-800 rounded px-2.5 py-1.5">
              <input
                id="web-midi-out-toggle"
                type="checkbox"
                checked={webMidi.midiOutEnabled}
                onChange={(e) => WorkletSynthBridge.setMidiOutEnabled(e.target.checked)}
                className="accent-emerald-500 cursor-pointer"
              />
              <span className="font-bold">Enable MIDI Out (Forward Playback &amp; UI CCs)</span>
            </label>

            <label className="flex items-center gap-2 text-[10px] text-zinc-300 cursor-pointer bg-zinc-900/60 border border-zinc-800 rounded px-2.5 py-1.5">
              <input
                id="web-midi-mute-internal-toggle"
                type="checkbox"
                checked={webMidi.muteInternalOnMidiOut}
                onChange={(e) => WorkletSynthBridge.setMuteInternalOnMidiOut(e.target.checked)}
                className="accent-amber-500 cursor-pointer"
              />
              <VolumeX size={11} className="text-amber-400 shrink-0" />
              <span>Mute Internal Synth when MIDI Out Active</span>
            </label>
          </div>

          <div className="text-[9px] text-zinc-400 bg-black/60 border border-zinc-850 rounded px-2 py-1 truncate">
            <span className="text-emerald-400 font-bold mr-1">OUT:</span>
            {webMidi.lastOutputActivity}
          </div>
        </div>
      </div>
    </div>
  );
}
