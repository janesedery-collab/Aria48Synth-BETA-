/**
 * videoRecorder.ts
 * Real in-browser Canvas & WebAudio MediaRecorder Video Exporter
 *
 * Supports:
 * - Direct Web Audio streaming from WorkletSynthesizer, SpessaSynth, Chiptune-3, TinySynth & Synthetic Oscs
 * - Real live Tracker pattern matrix & active row sync (no placeholder/fake notes)
 * - 3 Recording Modes with clean, non-overlapping mini layouts:
 *   1. 'oscilloscope' - 16-channel CRT vector oscilloscope wall
 *   2. 'tracker'      - Live Tracker pattern matrix & active channels inspector
 *   3. 'both'         - Mini Dual Split-Screen (Mini Tracker + Mini 16-Channel CRT Scopes, zero overlap)
 */

import { getAudioContext, getTinySynthMasterGain, getSyntheticMasterGain } from '../components/AudioEngine';
import { WebScope, WebScopePreset } from '../engines/webscopeOscilloscope';
import { SpessaSynth } from '../engines/spressasynthLib';
import { WorkletSynthBridge } from '../engines/workletSynthBridge';
import { Chiptune3 } from '../engines/chiptune3';

export type VideoRecordMode = 'oscilloscope' | 'tracker' | 'both';

export interface LiveTrackerChannelSummary {
  id: number;
  chip?: string;
  soundFontPreset?: string;
  enabled?: boolean;
  mute?: boolean;
}

export interface LiveTrackerRecorderState {
  songPatterns: any[][];
  currentPatternIndex: number;
  activeRow: number;
  channels: LiveTrackerChannelSummary[];
  bpm: number;
  trackTitle?: string | null;
  isPlaying: boolean;
}

export interface VideoRecorderStatus {
  isRecording: boolean;
  isProcessing: boolean;
  mode: VideoRecordMode | null;
  durationSeconds: number;
  targetDurationSeconds: number; // 0 for continuous/manual, >0 for auto-duration
  progressPercent: number; // 0 - 100
  downloadedFilename: string | null;
}

export interface VideoRecordOptions {
  targetDurationSeconds?: number;
  activePreset?: WebScopePreset;
  liveState?: LiveTrackerRecorderState;
  onComplete?: (blob: Blob, filename: string) => void;
  onAutoStop?: () => void;
}

const SCOPE_ROLES = [
  'CH01', 'CH02', 'CH03', 'CH04',
  'CH05', 'CH06', 'CH07', 'CH08',
  'CH09', 'CH10', 'CH11', 'CH12',
  'CH13', 'CH14', 'CH15', 'CH16'
];

class VideoRecorderService {
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordingCanvas: HTMLCanvasElement | null = null;
  private animFrameId: number | null = null;
  private timerIntervalId: any = null;
  private startTime = 0;
  private isRecordingInternal = false;
  private isProcessingInternal = false;
  private currentMode: VideoRecordMode | null = null;
  private targetDuration = 0;
  private lastDownloadedFilename: string | null = null;
  private audioDestNode: MediaStreamAudioDestinationNode | null = null;
  private onCompleteCallback?: (blob: Blob, filename: string) => void;
  private onAutoStopCallback?: () => void;
  private onStatusChangeCallbacks: ((status: VideoRecorderStatus) => void)[] = [];

  private liveState: LiveTrackerRecorderState = {
    songPatterns: [],
    currentPatternIndex: 0,
    activeRow: 0,
    channels: [],
    bpm: 125,
    trackTitle: null,
    isPlaying: false
  };

  public setLiveTrackerState(state: LiveTrackerRecorderState) {
    this.liveState = state;
  }

  public isRecording(): boolean {
    return this.isRecordingInternal;
  }

  public isProcessing(): boolean {
    return this.isProcessingInternal;
  }

  public getMode(): VideoRecordMode | null {
    return this.currentMode;
  }

  public getStatus(): VideoRecorderStatus {
    const elapsed = this.isRecordingInternal ? (Date.now() - this.startTime) / 1000 : 0;
    const progress = this.targetDuration > 0 ? Math.min(100, (elapsed / this.targetDuration) * 100) : 0;
    return {
      isRecording: this.isRecordingInternal,
      isProcessing: this.isProcessingInternal,
      mode: this.currentMode,
      durationSeconds: Math.round(elapsed * 10) / 10,
      targetDurationSeconds: this.targetDuration,
      progressPercent: Math.round(progress),
      downloadedFilename: this.lastDownloadedFilename
    };
  }

  public onStatusChange(callback: (status: VideoRecorderStatus) => void): () => void {
    this.onStatusChangeCallbacks.push(callback);
    return () => {
      this.onStatusChangeCallbacks = this.onStatusChangeCallbacks.filter(c => c !== callback);
    };
  }

  private notifyStatus() {
    const status = this.getStatus();
    this.onStatusChangeCallbacks.forEach(cb => {
      try {
        cb(status);
      } catch (e) {
        console.error('Status callback error:', e);
      }
    });
  }

  /**
   * Start video capture for the chosen target
   */
  public startRecording(mode: VideoRecordMode, options: VideoRecordOptions = {}): boolean {
    if (this.isRecordingInternal || this.isProcessingInternal) return false;

    if (options.liveState) {
      this.liveState = options.liveState;
    }

    try {
      this.targetDuration = options.targetDurationSeconds || 0;
      this.onCompleteCallback = options.onComplete;
      this.onAutoStopCallback = options.onAutoStop;
      const activePreset = options.activePreset || 'protracker';
      this.lastDownloadedFilename = null;

      // 1. Setup Master Recording Canvas
      const width = mode === 'both' ? 1440 : 1280;
      const height = mode === 'both' ? 810 : 720;

      this.recordingCanvas = document.createElement('canvas');
      this.recordingCanvas.width = width;
      this.recordingCanvas.height = height;
      const ctx = this.recordingCanvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Could not initialize 2D render context');

      // 2. Setup Canvas Video Stream & Web Audio Destination
      const videoStream = this.recordingCanvas.captureStream(30);
      const audioCtx = getAudioContext();

      if (audioCtx) {
        try {
          if (audioCtx.state === 'suspended') {
            void audioCtx.resume();
          }

          const dest = audioCtx.createMediaStreamDestination();
          this.audioDestNode = dest;

          WorkletSynthBridge.connectRecordingDestination(dest);

          const spessaMaster = SpessaSynth.getMasterGain();
          if (spessaMaster) {
            try { spessaMaster.connect(dest); } catch {}
          }

          const chiptuneMaster = Chiptune3.getMasterGain();
          if (chiptuneMaster) {
            try { chiptuneMaster.connect(dest); } catch {}
          }

          const tinyMaster = getTinySynthMasterGain();
          if (tinyMaster) {
            try { tinyMaster.connect(dest); } catch {}
          }

          const synthMaster = getSyntheticMasterGain();
          if (synthMaster) {
            try { synthMaster.connect(dest); } catch {}
          }

          const audioTracks = dest.stream.getAudioTracks();
          if (audioTracks.length > 0) {
            videoStream.addTrack(audioTracks[0]);
          }
        } catch (e) {
          console.warn('Audio track routing bypassed:', e);
        }
      }

      // 3. MediaRecorder Initialization
      const mimeTypes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4'
      ];
      let selectedMime: string | undefined = undefined;
      for (const mime of mimeTypes) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
          selectedMime = mime;
          break;
        }
      }

      const recorderOptions: MediaRecorderOptions = {
        videoBitsPerSecond: 3500000,
        audioBitsPerSecond: 192000
      };
      if (selectedMime) {
        recorderOptions.mimeType = selectedMime;
      }

      this.mediaRecorder = new MediaRecorder(videoStream, recorderOptions);
      this.recordedChunks = [];

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.processAndFinishDownload(mode);
      };

      this.mediaRecorder.start(250);
      this.isRecordingInternal = true;
      this.isProcessingInternal = false;
      this.currentMode = mode;
      this.startTime = Date.now();

      // 4. Render Animation Loop
      let channelSubCanvas: HTMLCanvasElement | null = null;
      if (mode === 'oscilloscope' || mode === 'both') {
        channelSubCanvas = document.createElement('canvas');
        channelSubCanvas.width = 240;
        channelSubCanvas.height = 104;
      }

      const drawLoop = () => {
        if (!this.isRecordingInternal || !ctx || !this.recordingCanvas) return;

        const now = Date.now();
        const elapsedSecs = (now - this.startTime) / 1000;

        if (this.targetDuration > 0 && elapsedSecs >= this.targetDuration) {
          this.onAutoStopCallback?.();
          this.stopRecording();
          return;
        }

        // Clean background
        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, width, height);

        const mins = Math.floor(elapsedSecs / 60);
        const secs = Math.floor(elapsedSecs % 60);
        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

        // Top Mini Unified HUD Bar (height: 38px) — zero overlap with panels below
        this.drawTopMiniHud(ctx, width, mode, timeStr);

        const contentY = 44;
        const contentH = height - contentY - (this.targetDuration > 0 ? 10 : 6);

        if (mode === 'oscilloscope') {
          this.drawOscilloscopePanel(ctx, 12, contentY, width - 24, contentH, channelSubCanvas, activePreset, false);
        } else if (mode === 'tracker') {
          this.drawTrackerPanel(ctx, 12, contentY, width - 24, contentH, false);
        } else {
          // MINI DUAL SPLIT: Strict non-overlapping bounds for Left Mini Tracker & Right Mini Oscilloscope
          const gap = 10;
          const paneW = Math.floor((width - 24 - gap) / 2);
          this.drawTrackerPanel(ctx, 12, contentY, paneW, contentH, true);

          ctx.fillStyle = '#27272a';
          ctx.fillRect(12 + paneW + 4, contentY, 2, contentH);

          this.drawOscilloscopePanel(ctx, 12 + paneW + gap, contentY, paneW, contentH, channelSubCanvas, activePreset, true);
        }

        // Auto progress bar on bottom edge
        if (this.targetDuration > 0) {
          const pct = Math.min(1, elapsedSecs / this.targetDuration);
          ctx.fillStyle = '#27272a';
          ctx.fillRect(0, height - 5, width, 5);
          ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
          ctx.fillRect(0, height - 5, width * pct, 5);
        }

        this.animFrameId = requestAnimationFrame(drawLoop);
      };

      this.animFrameId = requestAnimationFrame(drawLoop);

      this.timerIntervalId = setInterval(() => {
        this.notifyStatus();
      }, 250);

      this.notifyStatus();
      return true;
    } catch (err) {
      console.error('Failed to start video recorder:', err);
      this.isRecordingInternal = false;
      this.isProcessingInternal = false;
      this.currentMode = null;
      this.notifyStatus();
      return false;
    }
  }

  public stopRecording() {
    if (!this.isRecordingInternal || !this.mediaRecorder) return;

    this.isRecordingInternal = false;
    this.isProcessingInternal = true;
    this.notifyStatus();

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }

    try {
      if (this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    } catch (e) {
      console.warn('MediaRecorder stop exception:', e);
      this.processAndFinishDownload(this.currentMode || 'both');
    }
  }

  private processAndFinishDownload(mode: VideoRecordMode) {
    if (this.audioDestNode) {
      WorkletSynthBridge.disconnectRecordingDestination(this.audioDestNode);
      try { SpessaSynth.getMasterGain()?.disconnect(this.audioDestNode); } catch {}
      try { Chiptune3.getMasterGain()?.disconnect(this.audioDestNode); } catch {}
      try { getTinySynthMasterGain()?.disconnect(this.audioDestNode); } catch {}
      try { getSyntheticMasterGain()?.disconnect(this.audioDestNode); } catch {}
      this.audioDestNode = null;
    }

    if (this.recordedChunks.length === 0) {
      this.isProcessingInternal = false;
      this.currentMode = null;
      this.notifyStatus();
      return;
    }

    try {
      const mime = this.mediaRecorder?.mimeType || 'video/webm';
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(this.recordedChunks, { type: mime });
      const filename = `Aria48_${mode.toUpperCase()}_Video_${Date.now()}.${ext}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => URL.revokeObjectURL(url), 5000);

      this.lastDownloadedFilename = filename;
      this.onCompleteCallback?.(blob, filename);
    } catch (err) {
      console.error('Video export processing error:', err);
    } finally {
      this.recordedChunks = [];
      this.currentMode = null;
      this.isProcessingInternal = false;
      this.notifyStatus();
    }
  }

  private drawTopMiniHud(
    ctx: CanvasRenderingContext2D,
    width: number,
    mode: VideoRecordMode,
    timeStr: string
  ) {
    ctx.fillStyle = '#111114';
    ctx.fillRect(0, 0, width, 38);
    ctx.fillStyle = '#27272a';
    ctx.fillRect(0, 37, width, 1);

    // REC dot & compact timer
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(20, 19, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fafafa';
    ctx.font = 'bold 11px monospace';
    const targetStr = this.targetDuration > 0 ? ` / ${this.targetDuration}s` : '';
    ctx.fillText(`REC ${timeStr}${targetStr}`, 32, 23);

    // Center-right track badge clipped safely
    const patIdx = Math.max(0, this.liveState.currentPatternIndex || 0);
    const rowIdx = Math.max(0, this.liveState.activeRow || 0);
    const title = (this.liveState.trackTitle || 'Aria48 Sequence').slice(0, 36);
    const modeLabel = mode === 'both' ? 'MINI DUAL' : mode.toUpperCase();
    const hudRight = `${title} · ${this.liveState.bpm || 125} BPM · PAT ${patIdx.toString().padStart(2, '0')} ROW ${rowIdx.toString().padStart(2, '0')} · ${modeLabel}`;

    ctx.fillStyle = '#22d3ee';
    ctx.font = 'bold 10.5px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(hudRight, width - 16, 23);
    ctx.textAlign = 'left';
  }

  private resolveRowCell(patIdx: number, rowIdx: number, chId: number): { note: string; inst: string; vol: string } {
    const pats = this.liveState.songPatterns;
    if (!pats || pats.length === 0) {
      return { note: '---', inst: '..', vol: '..' };
    }
    const safePat = pats[Math.max(0, Math.min(pats.length - 1, patIdx))];
    const rowObj = safePat?.[rowIdx];
    const cell = rowObj?.[chId];
    if (!cell) {
      return { note: '---', inst: '..', vol: '..' };
    }
    return {
      note: typeof cell.note === 'string' ? cell.note : '---',
      inst: typeof cell.inst === 'string' ? cell.inst : '..',
      vol: typeof cell.vol === 'string' ? cell.vol : '..'
    };
  }

  /**
   * Draw bounded, strictly non-overlapping Live Tracker Panel (full or mini)
   */
  private drawTrackerPanel(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    pw: number,
    ph: number,
    mini: boolean
  ) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, pw, ph);
    ctx.clip();

    ctx.fillStyle = '#0b0b0e';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    // Mini Panel Header
    const headerH = mini ? 26 : 32;
    ctx.fillStyle = '#141418';
    ctx.fillRect(px, py, pw, headerH);
    ctx.fillStyle = '#27272a';
    ctx.fillRect(px, py + headerH - 1, pw, 1);

    const pats = this.liveState.songPatterns || [];
    const totalPats = Math.max(1, pats.length);
    const curPat = Math.max(0, Math.min(totalPats - 1, this.liveState.currentPatternIndex || 0));
    const curRow = Math.max(0, Math.min(63, this.liveState.activeRow || 0));

    ctx.fillStyle = '#22d3ee';
    ctx.font = mini ? 'bold 10px monospace' : 'bold 11.5px monospace';
    ctx.fillText(
      mini
        ? `MINI TRACKER · PAT ${curPat.toString().padStart(2, '0')}/${(totalPats - 1).toString().padStart(2, '0')} · ROW ${curRow.toString(16).toUpperCase().padStart(2, '0')}`
        : `ARIA48 LIVE TRACKER MATRIX · PAT ${curPat.toString().padStart(2, '0')}/${(totalPats - 1).toString().padStart(2, '0')} · ROW ${curRow.toString(16).toUpperCase().padStart(2, '0')}`,
      px + 10,
      py + (mini ? 17 : 21)
    );

    // Determine visible channels (prefer enabled channels or first 6 in mini / 8 in standalone)
    const maxCols = mini ? 6 : 8;
    const enabled = (this.liveState.channels || []).filter(c => c.enabled);
    const chosenChannels = (enabled.length > 0 ? enabled : (this.liveState.channels || [])).slice(0, maxCols);
    while (chosenChannels.length < maxCols) {
      chosenChannels.push({ id: chosenChannels.length + 1, chip: 'GM' });
    }

    // Optional compact bottom channel legend in standalone mode (zero side overlap!)
    const footerH = mini ? 0 : 44;
    const gridX = px + 6;
    const gridY = py + headerH + 4;
    const gridW = pw - 12;
    const gridH = ph - headerH - footerH - 8;

    const gutterW = mini ? 30 : 40;
    const colW = Math.floor((gridW - gutterW) / maxCols);
    const colHeaderH = mini ? 24 : 30;

    // Channel Column Headers
    ctx.fillStyle = '#18181b';
    ctx.fillRect(gridX, gridY, gridW, colHeaderH);
    ctx.fillStyle = '#71717a';
    ctx.font = 'bold 9px monospace';
    ctx.fillText('ROW', gridX + 5, gridY + 15);

    chosenChannels.forEach((ch, cIdx) => {
      const cx = gridX + gutterW + cIdx * colW;
      ctx.fillStyle = '#27272a';
      ctx.fillRect(cx, gridY, 1, gridH);

      ctx.fillStyle = ch.mute ? '#ef4444' : '#38bdf8';
      ctx.font = mini ? 'bold 9px monospace' : 'bold 10px monospace';
      ctx.fillText(`CH${ch.id.toString().padStart(2, '0')}`, cx + 6, gridY + 11);

      const chipShort = (ch.soundFontPreset || ch.chip || 'Synth')
        .replace('General MIDI (SoundFont)', 'GM SF2')
        .replace('gm_', '')
        .slice(0, mini ? 10 : 13);
      ctx.fillStyle = '#a1a1aa';
      ctx.font = mini ? '8px monospace' : '8.5px monospace';
      ctx.fillText(chipShort, cx + 6, gridY + (mini ? 20 : 24));
    });

    // Live Pattern Rows synced to activeRow
    const rowsBodyY = gridY + colHeaderH + 2;
    const rowsBodyH = gridH - colHeaderH - 4;
    const rowH = mini ? 22 : 24;
    const visibleRowCount = Math.max(8, Math.floor(rowsBodyH / rowH));
    const centerSlot = Math.floor(visibleRowCount * 0.35);

    for (let r = 0; r < visibleRowCount; r++) {
      const globalOffset = curPat * 64 + curRow + (r - centerSlot);
      const rowY = rowsBodyY + r * rowH;
      if (rowY + rowH > gridY + gridH) break;

      if (globalOffset < 0 || globalOffset >= totalPats * 64) {
        continue;
      }

      const rPat = Math.floor(globalOffset / 64);
      const rRow = globalOffset % 64;
      const isCurrent = r === centerSlot;

      ctx.fillStyle = isCurrent
        ? 'rgba(8, 145, 178, 0.32)'
        : rRow % 4 === 0
          ? '#121217'
          : '#09090c';
      ctx.fillRect(gridX, rowY, gridW, rowH - 1);

      if (isCurrent) {
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(gridX, rowY, 3, rowH - 1);
      }

      // Row hex index
      ctx.fillStyle = isCurrent ? '#67e8f9' : (rRow % 4 === 0 ? '#a1a1aa' : '#52525b');
      ctx.font = isCurrent ? 'bold 10px monospace' : '9.5px monospace';
      ctx.fillText(rRow.toString(16).toUpperCase().padStart(2, '0'), gridX + 7, rowY + 15);

      // Real Notes / Inst / Vol per channel
      chosenChannels.forEach((ch, cIdx) => {
        const cx = gridX + gutterW + cIdx * colW;
        const cell = this.resolveRowCell(rPat, rRow, ch.id);
        const hasNote = cell.note !== '---' && cell.note !== '';

        ctx.font = isCurrent ? 'bold 10px monospace' : '9.5px monospace';
        ctx.fillStyle = isCurrent
          ? (hasNote ? '#ffffff' : '#67e8f9')
          : cell.note === '===' || cell.note === 'OFF'
            ? '#f87171'
            : hasNote
              ? '#4ade80'
              : '#3f3f46';

        const cellText = mini
          ? `${cell.note} ${cell.inst}`
          : `${cell.note} ${cell.inst} ${cell.vol}`;
        ctx.fillText(cellText, cx + 6, rowY + 15);
      });
    }

    if (!mini && footerH > 0) {
      const fy = py + ph - footerH;
      ctx.fillStyle = '#141418';
      ctx.fillRect(px, fy, pw, footerH);
      ctx.fillStyle = '#27272a';
      ctx.fillRect(px, fy, pw, 1);

      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 9.5px monospace';
      ctx.fillText('ACTIVE CHANNELS:', px + 10, fy + 16);

      const chipText = chosenChannels
        .map(ch => `CH${ch.id.toString().padStart(2, '0')}:${(ch.soundFontPreset || ch.chip || 'Synth').slice(0, 12)}`)
        .join('  ·  ');
      ctx.fillStyle = '#67e8f9';
      ctx.font = '9px monospace';
      ctx.fillText(chipText, px + 10, fy + 32);
    }

    ctx.restore();
  }

  /**
   * Draw bounded, strictly non-overlapping 16-Channel CRT Oscilloscope Panel (full or mini)
   */
  private drawOscilloscopePanel(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    pw: number,
    ph: number,
    subCanvas: HTMLCanvasElement | null,
    preset: WebScopePreset,
    mini: boolean
  ) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, pw, ph);
    ctx.clip();

    ctx.fillStyle = '#0b0b0e';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    // Mini Panel Header
    const headerH = mini ? 26 : 32;
    ctx.fillStyle = '#141418';
    ctx.fillRect(px, py, pw, headerH);
    ctx.fillStyle = '#27272a';
    ctx.fillRect(px, py + headerH - 1, pw, 1);

    ctx.fillStyle = '#f59e0b';
    ctx.font = mini ? 'bold 10px monospace' : 'bold 11.5px monospace';
    ctx.fillText(
      mini ? 'MINI 16-CH WEBSCOPE CRT WALL' : 'WEBSCOPE 16-CHANNEL CRT VECTOR OSCILLOSCOPE MATRIX',
      px + 10,
      py + (mini ? 17 : 21)
    );

    const pad = 6;
    const gridX = px + pad;
    const gridY = py + headerH + pad;
    const gridW = pw - pad * 2;
    const gridH = ph - headerH - pad * 2;

    const gap = mini ? 4 : 6;
    const cellW = Math.floor((gridW - gap * 3) / 4);
    const cellH = Math.floor((gridH - gap * 3) / 4);
    const isActiveAudio = this.liveState.isPlaying || SpessaSynth.isMidiPlaying() || Chiptune3.isChiptunePlaying();

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const idx = row * 4 + col;
        const x = gridX + col * (cellW + gap);
        const y = gridY + row * (cellH + gap);

        ctx.fillStyle = '#050507';
        ctx.fillRect(x, y, cellW, cellH);
        ctx.strokeStyle = '#27272a';
        ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);

        // Mini label strictly inside cell header
        const labelH = mini ? 14 : 16;
        ctx.fillStyle = '#18181b';
        ctx.fillRect(x + 1, y + 1, cellW - 2, labelH);

        ctx.fillStyle = '#fbbf24';
        ctx.font = mini ? 'bold 8.5px monospace' : 'bold 9.5px monospace';
        const chMeta = this.liveState.channels?.[idx];
        const chLabel = chMeta?.soundFontPreset
          ? `${SCOPE_ROLES[idx]} ${chMeta.soundFontPreset.replace('gm_', '').slice(0, 8)}`
          : SCOPE_ROLES[idx];
        ctx.fillText(chLabel, x + 5, y + (mini ? 11 : 12));

        if (subCanvas) {
          WebScope.renderChannel(subCanvas, idx, isActiveAudio && !chMeta?.mute, {
            preset,
            scanlines: true,
            glowBloom: true,
            gridDividers: true,
            triggerLock: true,
            phaseSync: true
          });
          ctx.drawImage(subCanvas, x + 2, y + labelH + 2, cellW - 4, Math.max(12, cellH - labelH - 4));
        }
      }
    }

    ctx.restore();
  }
}

export const VideoRecorder = new VideoRecorderService();
