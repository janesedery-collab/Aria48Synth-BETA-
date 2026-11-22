import React, { useState, useEffect, useRef } from 'react';
import { X, RefreshCw, Upload, Cpu, CheckCircle2, AlertCircle } from 'lucide-react';
import { MasterAudioRouter } from '../engines/MasterAudioRouter';
import { FurnaceBridge } from '../engines/FurnaceBridge';
import { WasmBundleSlot } from '../types';

interface WasmEngineManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function WasmEngineManagerModal({ isOpen, onClose }: WasmEngineManagerModalProps) {
  const [bundles, setBundles] = useState<WasmBundleSlot[]>(() => MasterAudioRouter.getWasmBundles());
  const [busList, setBusList] = useState(() => MasterAudioRouter.getBusStatusList());
  const [customUrls, setCustomUrls] = useState<Record<string, { js: string; wasm: string }>>({
    furnace: { js: '/wasm/aria_furnace_all.js', wasm: '/wasm/aria_furnace_all.wasm' },
    tinyrsid: { js: '/websid/tinyrsid.js', wasm: '/websid/websid.wasm' },
    sunvox: { js: '/sunvox/sunvox.js', wasm: '/sunvox/sunvox.wasm' },
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const filePickRefs = useRef<Record<string, { js?: HTMLInputElement | null; wasm?: HTMLInputElement | null }>>({});
  const uploadedBlobRef = useRef<Record<string, { jsUrl?: string; wasmUrl?: string; label?: string }>>({});

  useEffect(() => {
    if (!isOpen) return;
    const refresh = () => {
      setBundles(MasterAudioRouter.getWasmBundles());
      setBusList(MasterAudioRouter.getBusStatusList());
    };
    refresh();
    const u1 = MasterAudioRouter.subscribe(refresh);
    const u2 = FurnaceBridge.subscribe(refresh);
    return () => {
      u1();
      u2();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleLoadUrl = async (id: 'furnace' | 'tinyrsid' | 'sunvox') => {
    const entry = customUrls[id];
    setFeedback(`Loading ${id} bundle from ${entry.js}...`);
    const ok = await MasterAudioRouter.hotSwapWasmBundle(id, entry.js, entry.wasm, entry.js);
    setBundles(MasterAudioRouter.getWasmBundles());
    setFeedback(
      ok
        ? `Successfully loaded and activated ${id} WASM engine.`
        : `Could not activate ${id} bundle at ${entry.js}. Upload compiled JS + WASM below.`
    );
  };

  const handleLocalFile = async (
    id: 'furnace' | 'tinyrsid' | 'sunvox',
    kind: 'js' | 'wasm',
    file: File
  ) => {
    const blobUrl = URL.createObjectURL(file);
    uploadedBlobRef.current[id] = uploadedBlobRef.current[id] || {};
    if (kind === 'js') {
      uploadedBlobRef.current[id].jsUrl = blobUrl;
      uploadedBlobRef.current[id].label = file.name;
    } else {
      uploadedBlobRef.current[id].wasmUrl = blobUrl;
    }
    const pair = uploadedBlobRef.current[id];
    if (pair.jsUrl) {
      const ok = await MasterAudioRouter.hotSwapWasmBundle(
        id,
        pair.jsUrl,
        pair.wasmUrl || customUrls[id].wasm,
        pair.label || file.name
      );
      setBundles(MasterAudioRouter.getWasmBundles());
      setFeedback(ok ? `Hot-swapped ${file.name} into ${id} engine.` : `Staged ${file.name} (${kind.toUpperCase()}).`);
    } else {
      setFeedback(`Staged ${file.name}. Now upload the matching .js Emscripten loader to initialize.`);
    }
  };

  return (
    <div id="wasm-engine-manager-modal" className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-3xl w-full p-5 flex flex-col gap-4 text-xs shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Cpu size={16} className="text-cyan-400" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">WASM Engine Manager &amp; Audio Router</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white cursor-pointer"
            aria-label="Close WASM Engine Manager"
          >
            <X size={14} />
          </button>
        </div>

        {/* 5-Engine MasterAudioRouter Status Grid */}
        <div>
          <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">
            MasterAudioRouter 5-Engine Bus
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {busList.map((bus) => (
              <div
                key={bus.kind}
                className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 flex flex-col gap-1"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-zinc-100 text-[11px]">{bus.kind}</span>
                  <button
                    type="button"
                    onClick={() => MasterAudioRouter.setEngineEnabled(bus.kind, !bus.enabled)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
                      bus.enabled ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    {bus.enabled ? 'ON' : 'OFF'}
                  </button>
                </div>
                <span className="text-[10px] text-zinc-400 font-mono tabular-nums">
                  Gain: {Math.round(bus.gain * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Hot-Swappable WASM Bundles */}
        <div className="flex flex-col gap-3">
          {bundles.map((bundle) => {
            const urls = customUrls[bundle.id];
            const isReady = bundle.status === 'ready';
            return (
              <div key={bundle.id} className="p-3.5 rounded-lg bg-zinc-950/90 border border-zinc-800 flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-zinc-100">{bundle.label}</div>
                    <div className="text-[11px] text-zinc-400 font-mono truncate max-w-md">
                      Source: {bundle.customJsName || bundle.defaultJsUrl}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 font-mono text-[11px]">
                    {isReady ? (
                      <span className="flex items-center gap-1 text-emerald-400 font-semibold">
                        <CheckCircle2 size={13} />
                        <span>Ready</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-amber-400 font-semibold">
                        <AlertCircle size={13} />
                        <span>{bundle.status}</span>
                      </span>
                    )}
                  </div>
                </div>

                {bundle.error && (
                  <div className="text-[11px] text-amber-300 bg-amber-950/25 border border-amber-800/40 rounded px-2.5 py-1.5">
                    {bundle.error}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={urls.js}
                    onChange={(e) =>
                      setCustomUrls((prev) => ({ ...prev, [bundle.id]: { ...prev[bundle.id], js: e.target.value } }))
                    }
                    placeholder="Emscripten JS loader URL"
                    className="bg-black border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-zinc-200 text-[11px]"
                  />
                  <input
                    type="text"
                    value={urls.wasm}
                    onChange={(e) =>
                      setCustomUrls((prev) => ({ ...prev, [bundle.id]: { ...prev[bundle.id], wasm: e.target.value } }))
                    }
                    placeholder=".wasm binary URL"
                    className="bg-black border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-zinc-200 text-[11px]"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleLoadUrl(bundle.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-semibold cursor-pointer"
                  >
                    <RefreshCw size={12} />
                    <span>Load from URL</span>
                  </button>

                  <input
                    type="file"
                    accept=".js,.mjs"
                    ref={(el) => {
                      filePickRefs.current[bundle.id] = filePickRefs.current[bundle.id] || {};
                      filePickRefs.current[bundle.id].js = el;
                    }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleLocalFile(bundle.id, 'js', f);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                  <input
                    type="file"
                    accept=".wasm"
                    ref={(el) => {
                      filePickRefs.current[bundle.id] = filePickRefs.current[bundle.id] || {};
                      filePickRefs.current[bundle.id].wasm = el;
                    }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleLocalFile(bundle.id, 'wasm', f);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => filePickRefs.current[bundle.id]?.js?.click()}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 cursor-pointer"
                  >
                    <Upload size={12} />
                    <span>Upload .JS</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => filePickRefs.current[bundle.id]?.wasm?.click()}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 cursor-pointer"
                  >
                    <Upload size={12} />
                    <span>Upload .WASM</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {feedback && (
          <div className="px-3 py-2 rounded bg-zinc-950 border border-cyan-800/50 text-cyan-200 font-mono text-[11px]">
            {feedback}
          </div>
        )}
      </div>
    </div>
  );
}
