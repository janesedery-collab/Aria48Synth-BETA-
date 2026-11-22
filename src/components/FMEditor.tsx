import React, { useState, useEffect, useRef } from 'react';
import { Upload, Download, Sliders, Radio } from 'lucide-react';
import {
  FurnaceBridge,
  FurnaceFMOperator,
  FurnaceRuntimeState,
} from '../engines/FurnaceBridge';

function downloadBlob(data: Uint8Array | string, fileName: string, mime = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type: 'text/plain' }) : new Blob([data.slice().buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Interactive SVG YM2612 / OPM 4-Operator & 2-Op Algorithm Routing Diagram (ALG 0-7)
 */
function FMAlgorithmDiagram({ alg, is2Op }: { alg: number; is2Op: boolean }) {
  const carriersByAlg: Record<number, number[]> = {
    0: [4],
    1: [4],
    2: [4],
    3: [4],
    4: [2, 4],
    5: [2, 3, 4],
    6: [2, 3, 4],
    7: [1, 2, 3, 4],
  };

  const activeOps = is2Op ? [1, 2] : [1, 2, 3, 4];
  const carriers = is2Op ? (alg % 2 === 0 ? [2] : [1, 2]) : carriersByAlg[alg] || [4];

  const edgesByAlg: Record<number, Array<[number, number]>> = {
    0: [[1, 2], [2, 3], [3, 4]],
    1: [[1, 3], [2, 3], [3, 4]],
    2: [[2, 3], [1, 4], [3, 4]],
    3: [[1, 2], [2, 4], [3, 4]],
    4: [[1, 2], [3, 4]],
    5: [[1, 2], [1, 3], [1, 4]],
    6: [[1, 2]],
    7: [],
  };
  const edges = is2Op ? (alg % 2 === 0 ? [[1, 2]] : []) : edgesByAlg[alg] || [];

  const coords: Record<number, { x: number; y: number }> = is2Op
    ? { 1: { x: 80, y: 38 }, 2: { x: 185, y: 38 } }
    : {
        1: { x: 42, y: 38 },
        2: { x: 102, y: 38 },
        3: { x: 162, y: 38 },
        4: { x: 222, y: 38 },
      };

  return (
    <svg viewBox="0 0 264 78" className="w-full h-20 bg-black/70 border border-zinc-800 rounded">
      {/* Feedback Loop on OP1 */}
      <path
        d={`M ${coords[1].x} 24 C ${coords[1].x - 16} 6, ${coords[1].x + 16} 6, ${coords[1].x} 24`}
        fill="none"
        stroke="#f59e0b"
        strokeWidth="1.5"
      />
      {/* Modulation Edges */}
      {edges.map(([from, to], idx) => {
        const a = coords[from];
        const b = coords[to];
        if (!a || !b) return null;
        return (
          <line
            key={idx}
            x1={a.x + 14}
            y1={a.y}
            x2={b.x - 14}
            y2={b.y}
            stroke="#38bdf8"
            strokeWidth="1.75"
          />
        );
      })}
      {/* Output Carrier Rail */}
      <line x1={24} y1={66} x2={244} y2={66} stroke="#3f3f46" strokeWidth="1" strokeDasharray="3 3" />
      <text x={246} y={69} fill="#10b981" fontSize="8" fontFamily="monospace">
        OUT
      </text>

      {activeOps.map((opNum) => {
        const pos = coords[opNum];
        const isCarrier = carriers.includes(opNum);
        return (
          <g key={opNum}>
            {isCarrier && (
              <line x1={pos.x} y1={pos.y + 13} x2={pos.x} y2={66} stroke="#10b981" strokeWidth="1.5" />
            )}
            <rect
              x={pos.x - 14}
              y={pos.y - 13}
              width={28}
              height={26}
              rx={4}
              fill={isCarrier ? '#064e3b' : '#18181b'}
              stroke={isCarrier ? '#10b981' : '#38bdf8'}
              strokeWidth="1.5"
            />
            <text
              x={pos.x}
              y={pos.y + 3}
              textAnchor="middle"
              fill={isCarrier ? '#a7f3d0' : '#bae6fd'}
              fontSize="10"
              fontWeight="bold"
              fontFamily="monospace"
            >
              OP{opNum}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function FMEditor() {
  const [state, setState] = useState<FurnaceRuntimeState>(() => FurnaceBridge.getState());
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return FurnaceBridge.subscribe(setState);
  }, []);

  const fm = state.fm;
  const sid = state.sid;
  const psg = state.psg;

  const handleImportPreset = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const reader = new FileReader();
    reader.onload = (ev) => {
      const res = ev.target?.result;
      if (!(res instanceof ArrayBuffer)) return;
      if (ext === '.fui') FurnaceBridge.importFUI(res, file.name);
      else if (ext === '.dmp') FurnaceBridge.importDMP(res, file.name);
      else if (ext === '.opm') FurnaceBridge.importOPM(new TextDecoder().decode(new Uint8Array(res)), file.name);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const renderOpSlider = (
    opIdx: number,
    key: keyof FurnaceFMOperator,
    label: string,
    max: number,
    val: number
  ) => (
    <div key={String(key)} className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-zinc-400 w-10 font-mono">{label}</span>
      <input
        type="range"
        min={0}
        max={max}
        value={val}
        onChange={(e) => FurnaceBridge.updateFMOperator(opIdx, { [key]: Number(e.target.value) })}
        className="flex-1 accent-cyan-500 cursor-pointer"
      />
      <span className="w-8 text-right font-mono text-zinc-200 tabular-nums">{val}</span>
    </div>
  );

  return (
    <div id="furnace-fm-sid-editor" className="flex flex-col gap-4 text-xs">
      {/* FM Global Controls + Import/Export */}
      <div className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-2.5 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Sliders size={15} className="text-cyan-400" />
            <input
              type="text"
              value={fm.name}
              onChange={(e) => FurnaceBridge.updateFMGlobal({ name: e.target.value })}
              className="bg-black border border-zinc-700 rounded px-2.5 py-1 text-zinc-100 font-semibold text-xs focus:outline-none focus:border-cyan-500"
              aria-label="FM Instrument Name"
            />
            <div className="flex items-center p-0.5 bg-zinc-950 border border-zinc-800 rounded">
              <button
                type="button"
                onClick={() => FurnaceBridge.updateFMGlobal({ is2Op: false })}
                className={`px-2 py-0.5 rounded text-[11px] font-semibold cursor-pointer ${
                  !fm.is2Op ? 'bg-cyan-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                4-Op
              </button>
              <button
                type="button"
                onClick={() => FurnaceBridge.updateFMGlobal({ is2Op: true })}
                className={`px-2 py-0.5 rounded text-[11px] font-semibold cursor-pointer ${
                  fm.is2Op ? 'bg-cyan-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                2-Op
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <input
              ref={importInputRef}
              type="file"
              accept=".fui,.dmp,.opm"
              onChange={handleImportPreset}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-cyan-300 border border-zinc-700 font-semibold cursor-pointer"
            >
              <Upload size={12} />
              <span>Import .FUI / .DMP / .OPM</span>
            </button>
            <button
              type="button"
              onClick={() => downloadBlob(FurnaceBridge.exportFUI(), `${fm.name || 'patch'}.fui`)}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-emerald-300 border border-zinc-700 font-semibold cursor-pointer"
            >
              <Download size={12} />
              <span>.FUI</span>
            </button>
            <button
              type="button"
              onClick={() => downloadBlob(FurnaceBridge.exportDMP(), `${fm.name || 'patch'}.dmp`)}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-amber-300 border border-zinc-700 font-semibold cursor-pointer"
            >
              <Download size={12} />
              <span>.DMP</span>
            </button>
            <button
              type="button"
              onClick={() => downloadBlob(FurnaceBridge.exportOPM(), `${fm.name || 'patch'}.opm`, 'text/plain')}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-950 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 font-semibold cursor-pointer"
            >
              <Download size={12} />
              <span>.OPM</span>
            </button>
          </div>
        </div>

        {/* Algorithm Routing + FB / FMS / AMS */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
          <div className="md:col-span-1">
            <FMAlgorithmDiagram alg={fm.alg} is2Op={fm.is2Op} />
          </div>

          <div className="md:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Algorithm (ALG 0-7)</label>
              <div className="grid grid-cols-4 gap-1">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => FurnaceBridge.updateFMGlobal({ alg: a })}
                    className={`py-1 rounded font-mono font-bold border cursor-pointer ${
                      fm.alg === a
                        ? 'bg-emerald-600 text-white border-emerald-400'
                        : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-white'
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                <span>Feedback (FB)</span>
                <span className="font-mono text-amber-300 tabular-nums">{fm.fb}</span>
              </div>
              <input
                type="range"
                min={0}
                max={7}
                value={fm.fb}
                onChange={(e) => FurnaceBridge.updateFMGlobal({ fb: Number(e.target.value) })}
                className="w-full accent-amber-500 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                <span>LFO FMS</span>
                <span className="font-mono text-cyan-300 tabular-nums">{fm.fms}</span>
              </div>
              <input
                type="range"
                min={0}
                max={7}
                value={fm.fms}
                onChange={(e) => FurnaceBridge.updateFMGlobal({ fms: Number(e.target.value) })}
                className="w-full accent-cyan-500 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                <span>LFO AMS</span>
                <span className="font-mono text-cyan-300 tabular-nums">{fm.ams}</span>
              </div>
              <input
                type="range"
                min={0}
                max={3}
                value={fm.ams}
                onChange={(e) => FurnaceBridge.updateFMGlobal({ ams: Number(e.target.value) })}
                className="w-full accent-cyan-500 cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* 4 Operators Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 pt-1">
          {(fm.is2Op ? [0, 1] : [0, 1, 2, 3]).map((opIdx) => {
            const op = fm.ops[opIdx];
            return (
              <div key={opIdx} className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 flex flex-col gap-1.5">
                <div className="flex items-center justify-between pb-1.5 mb-1 border-b border-zinc-800">
                  <span className="font-mono font-bold text-cyan-300">OP {opIdx + 1}</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => FurnaceBridge.updateFMOperator(opIdx, { am: !op.am })}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono border cursor-pointer ${
                        op.am ? 'bg-amber-600 text-white border-amber-400' : 'bg-zinc-900 text-zinc-500 border-zinc-700'
                      }`}
                    >
                      AM
                    </button>
                    <button
                      type="button"
                      onClick={() => FurnaceBridge.updateFMOperator(opIdx, { ksr: !op.ksr })}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono border cursor-pointer ${
                        op.ksr ? 'bg-emerald-600 text-white border-emerald-400' : 'bg-zinc-900 text-zinc-500 border-zinc-700'
                      }`}
                    >
                      KSR
                    </button>
                  </div>
                </div>

                {renderOpSlider(opIdx, 'tl', 'TL', 127, op.tl)}
                {renderOpSlider(opIdx, 'ar', 'AR', 31, op.ar)}
                {renderOpSlider(opIdx, 'dr', 'DR', 31, op.dr)}
                {renderOpSlider(opIdx, 'd2r', 'D2R', 31, op.d2r)}
                {renderOpSlider(opIdx, 'sl', 'SL', 15, op.sl)}
                {renderOpSlider(opIdx, 'rr', 'RR', 15, op.rr)}
                {renderOpSlider(opIdx, 'mult', 'MULT', 15, op.mult)}
                {renderOpSlider(opIdx, 'dt', 'DT', 7, op.dt)}
                {renderOpSlider(opIdx, 'dt2', 'DT2', 3, op.dt2)}
                {renderOpSlider(opIdx, 'rs', 'RS', 3, op.rs)}
                {renderOpSlider(opIdx, 'ksl', 'KSL', 3, op.ksl)}
                {renderOpSlider(opIdx, 'ssgEnv', 'SSG', 15, op.ssgEnv)}
              </div>
            );
          })}
        </div>
      </div>

      {/* SID (6581/8580) & PSG / LFSR Hardware Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* C64 SID Controls */}
        <div className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex flex-col gap-3">
          <div className="flex items-center gap-2 pb-2 border-b border-zinc-800">
            <Radio size={14} className="text-sky-400" />
            <span className="font-bold text-zinc-100">C64 SID Filter &amp; Modulation (reSIDfp)</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                <span>Filter Cutoff</span>
                <span className="font-mono text-sky-300 tabular-nums">{sid.cutoff}</span>
              </div>
              <input
                type="range"
                min={0}
                max={2047}
                value={sid.cutoff}
                onChange={(e) => FurnaceBridge.updateSIDParams({ cutoff: Number(e.target.value) })}
                className="w-full accent-sky-500 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                <span>Resonance</span>
                <span className="font-mono text-sky-300 tabular-nums">{sid.resonance}</span>
              </div>
              <input
                type="range"
                min={0}
                max={15}
                value={sid.resonance}
                onChange={(e) => FurnaceBridge.updateSIDParams({ resonance: Number(e.target.value) })}
                className="w-full accent-sky-500 cursor-pointer"
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
              <span>Pulse Width (Duty)</span>
              <span className="font-mono text-sky-300 tabular-nums">{sid.pulseWidth}</span>
            </div>
            <input
              type="range"
              min={0}
              max={4095}
              value={sid.pulseWidth}
              onChange={(e) => FurnaceBridge.updateSIDParams({ pulseWidth: Number(e.target.value) })}
              className="w-full accent-sky-500 cursor-pointer"
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            <span className="text-[11px] text-zinc-400 mr-1 self-center">Filter Mode:</span>
            {([
              ['lp', 'LP'],
              ['bp', 'BP'],
              ['hp', 'HP'],
              ['notch', 'Notch'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => FurnaceBridge.updateSIDParams({ [key]: !sid[key] })}
                className={`px-2 py-1 rounded text-[11px] font-semibold border cursor-pointer ${
                  sid[key] ? 'bg-sky-600 text-white border-sky-400' : 'bg-zinc-950 text-zinc-400 border-zinc-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5">
            <span className="text-[11px] text-zinc-400 mr-1 self-center">Wave / Sync:</span>
            {([
              ['tri', 'Tri'],
              ['saw', 'Saw'],
              ['pulse', 'Pulse'],
              ['noise', 'Noise'],
              ['ringMod', 'Ring Mod'],
              ['hardSync', 'Hard Sync'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => FurnaceBridge.updateSIDParams({ [key]: !sid[key] })}
                className={`px-2 py-1 rounded text-[11px] font-semibold border cursor-pointer ${
                  sid[key] ? 'bg-emerald-600 text-white border-emerald-400' : 'bg-zinc-950 text-zinc-400 border-zinc-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* PSG / LFSR Noise Controls */}
        <div className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex flex-col gap-3">
          <div className="flex items-center gap-2 pb-2 border-b border-zinc-800">
            <Sliders size={14} className="text-amber-400" />
            <span className="font-bold text-zinc-100">PSG Duty Cycle &amp; LFSR Noise Mode</span>
          </div>

          <div>
            <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
              <span>Pulse Duty Cycle Step</span>
              <span className="font-mono text-amber-300 tabular-nums">{psg.dutyCycle} / 7</span>
            </div>
            <input
              type="range"
              min={0}
              max={7}
              value={psg.dutyCycle}
              onChange={(e) => FurnaceBridge.updatePSGParams({ dutyCycle: Number(e.target.value) })}
              className="w-full accent-amber-500 cursor-pointer"
            />
          </div>

          <div>
            <label className="block text-[11px] text-zinc-400 mb-1">LFSR Noise Mode</label>
            <div className="flex gap-1.5">
              {(['15-bit', '7-bit', '17-bit'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => FurnaceBridge.updatePSGParams({ lfsrMode: mode })}
                  className={`px-3 py-1 rounded text-[11px] font-semibold border cursor-pointer ${
                    psg.lfsrMode === mode
                      ? 'bg-amber-600 text-white border-amber-400'
                      : 'bg-zinc-950 text-zinc-400 border-zinc-800'
                  }`}
                >
                  {mode} LFSR
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                <span>Noise Clock Divider</span>
                <span className="font-mono text-amber-300 tabular-nums">{psg.noiseFreq}</span>
              </div>
              <input
                type="range"
                min={0}
                max={31}
                value={psg.noiseFreq}
                onChange={(e) => FurnaceBridge.updatePSGParams({ noiseFreq: Number(e.target.value) })}
                className="w-full accent-amber-500 cursor-pointer"
              />
            </div>
            <div>
              <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                <span>Hardware Env Shape</span>
                <span className="font-mono text-amber-300 tabular-nums">{psg.envShape}</span>
              </div>
              <input
                type="range"
                min={0}
                max={15}
                value={psg.envShape}
                onChange={(e) => FurnaceBridge.updatePSGParams({ envShape: Number(e.target.value) })}
                className="w-full accent-amber-500 cursor-pointer"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
