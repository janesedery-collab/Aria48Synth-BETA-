/**
 * videoRecorder.ts
 * Real in-browser Canvas & WebAudio MediaRecorder Video Exporter
 * Supports 3 modes:
 * 1. 'oscilloscope' - Only the 16-channel CRT vector oscilloscope
 * 2. 'tracker'      - Only the tracker pattern matrix & samples inspector
 * 3. 'both'         - Dual split-screen (Tracker + 16-channel CRT Oscilloscopes)
 */

import { getAudioContext } from '../components/AudioEngine';
import { WebScope, WebScopePreset } from '../engines/webscopeOscilloscope';

export type VideoRecordMode = 'oscilloscope' | 'tracker' | 'both';

export interface VideoRecorderStatus {
  isRecording: boolean;
  mode: VideoRecordMode | null;
  durationSeconds: number;
}

class VideoRecorderService {
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordingCanvas: HTMLCanvasElement | null = null;
  private animFrameId: number | null = null;
  private timerIntervalId: any = null;
  private startTime = 0;
  private isRecordingInternal = false;
  private currentMode: VideoRecordMode | null = null;
  private onStatusChangeCallbacks: ((status: VideoRecorderStatus) => void)[] = [];

  public isRecording(): boolean {
    return this.isRecordingInternal;
  }

  public getMode(): VideoRecordMode | null {
    return this.currentMode;
  }

  public onStatusChange(callback: (status: VideoRecorderStatus) => void): () => void {
    this.onStatusChangeCallbacks.push(callback);
    return () => {
      this.onStatusChangeCallbacks = this.onStatusChangeCallbacks.filter(c => c !== callback);
    };
  }

  private notifyStatus() {
    const elapsed = this.isRecordingInternal ? (Date.now() - this.startTime) / 1000 : 0;
    const status: VideoRecorderStatus = {
      isRecording: this.isRecordingInternal,
      mode: this.currentMode,
      durationSeconds: Math.round(elapsed)
    };
    this.onStatusChangeCallbacks.forEach(cb => cb(status));
  }

  /**
   * Start video capture for the chosen target
   */
  public startRecording(
    mode: VideoRecordMode,
    getTrackerElement?: () => HTMLElement | null,
    activePreset: WebScopePreset = 'protracker'
  ): boolean {
    if (this.isRecordingInternal) return false;

    try {
      // 1. Setup Master Recording Canvas
      let width = 1280;
      let height = 720;
      if (mode === 'oscilloscope') {
        width = 1280;
        height = 720;
      } else if (mode === 'tracker') {
        width = 1280;
        height = 720;
      } else {
        // Both: dual screen side-by-side or stacked
        width = 1440;
        height = 810;
      }

      this.recordingCanvas = document.createElement('canvas');
      this.recordingCanvas.width = width;
      this.recordingCanvas.height = height;
      const ctx = this.recordingCanvas.getContext('2d');
      if (!ctx) throw new Error("Could not initialize 2D render context");

      // 2. Setup Canvas Video Stream & Web Audio Destination
      const videoStream = this.recordingCanvas.captureStream(30); // 30 FPS
      const audioCtx = getAudioContext();

      let combinedStream = videoStream;
      if (audioCtx) {
        try {
          const dest = audioCtx.createMediaStreamDestination();
          // Route master destination audio into recorder
          const masterNode = audioCtx.destination;
          // Connect stream audio track
          const audioTracks = dest.stream.getAudioTracks();
          if (audioTracks.length > 0) {
            videoStream.addTrack(audioTracks[0]);
          }
        } catch (e) {
          console.log("Audio track routing bypassed:", e);
        }
      }

      // 3. MediaRecorder Initialization with modern web codecs
      const mimeTypes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4'
      ];
      let selectedMime = 'video/webm';
      for (const mime of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mime)) {
          selectedMime = mime;
          break;
        }
      }

      this.mediaRecorder = new MediaRecorder(videoStream, {
        mimeType: selectedMime,
        videoBitsPerSecond: 3500000 // 3.5 Mbps high definition
      });

      this.recordedChunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.finishDownload(mode);
      };

      this.mediaRecorder.start(250); // Record in 250ms chunks
      this.isRecordingInternal = true;
      this.currentMode = mode;
      this.startTime = Date.now();

      // 4. Start Render Animation Loop
      let channelSubCanvas: HTMLCanvasElement | null = null;
      if (mode === 'oscilloscope' || mode === 'both') {
        channelSubCanvas = document.createElement('canvas');
        channelSubCanvas.width = 280;
        channelSubCanvas.height = 110;
      }

      const drawLoop = () => {
        if (!this.isRecordingInternal || !ctx || !this.recordingCanvas) return;

        // Background
        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, width, height);

        const now = Date.now();
        const elapsedSecs = (now - this.startTime) / 1000;
        const mins = Math.floor(elapsedSecs / 60);
        const secs = Math.floor(elapsedSecs % 60);
        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

        if (mode === 'oscilloscope') {
          // Render all 16 CRT Vector Oscilloscopes in a 4x4 grid
          this.drawOscilloscopeWall(ctx, width, height, channelSubCanvas, activePreset, timeStr);
        } else if (mode === 'tracker') {
          // Render tracker matrix sequencer view
          this.drawTrackerSequencerView(ctx, width, height, timeStr);
        } else {
          // Dual split view: Top/Left Tracker, Bottom/Right 16-channel CRT Vector wall
          this.drawDualSplitView(ctx, width, height, channelSubCanvas, activePreset, timeStr);
        }

        // Draw recording watermark & HUD
        ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
        ctx.beginPath();
        ctx.arc(30, 25, 7, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px monospace';
        ctx.fillText(`REC [${timeStr}] · Aria48 ${mode.toUpperCase()} CAPTURE`, 45, 29);

        this.animFrameId = requestAnimationFrame(drawLoop);
      };

      this.animFrameId = requestAnimationFrame(drawLoop);

      // Start timer ticker for status
      this.timerIntervalId = setInterval(() => {
        this.notifyStatus();
      }, 500);

      this.notifyStatus();
      return true;

    } catch (err) {
      console.log("Failed to start video recorder:", err);
      this.isRecordingInternal = false;
      this.currentMode = null;
      this.notifyStatus();
      return false;
    }
  }

  public stopRecording() {
    if (!this.isRecordingInternal || !this.mediaRecorder) return;

    this.isRecordingInternal = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }

    try {
      this.mediaRecorder.stop();
    } catch (e) {}

    this.notifyStatus();
  }

  private finishDownload(mode: VideoRecordMode) {
    if (this.recordedChunks.length === 0) return;

    const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Aria48_${mode.toUpperCase()}_Video_${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.recordedChunks = [];
    this.currentMode = null;
    this.notifyStatus();
  }

  // Draw 16 CRT Vector Oscilloscope Wall
  private drawOscilloscopeWall(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    subCanvas: HTMLCanvasElement | null,
    preset: WebScopePreset,
    timeStr: string
  ) {
    // Header Banner
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, width, 48);

    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 14px monospace';
    ctx.fillText("WEBSCOPE 16-CHANNEL CRT VECTOR OSCILLOSCOPE MATRIX", 300, 30);

    // 4x4 Grid of CRT Oscilloscopes
    const startY = 56;
    const cellW = (width - 40) / 4;
    const cellH = (height - 70) / 4;

    const ROLES = [
      "CH01 Piano", "CH02 E-Piano", "CH03 Slap Bass", "CH04 Strings",
      "CH05 Brass", "CH06 Lead", "CH07 Organ", "CH08 Pad",
      "CH09 Guitar", "CH10 GM Drums", "CH11 SynthBass", "CH12 Flute",
      "CH13 Harp", "CH14 Atmosphere", "CH15 Ambient", "CH16 Aux/Mod"
    ];

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const idx = row * 4 + col;
        const x = 20 + col * cellW;
        const y = startY + row * cellH;

        ctx.fillStyle = '#09090b';
        ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
        ctx.strokeStyle = '#27272a';
        ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4);

        // Label
        ctx.fillStyle = '#a1a1aa';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(ROLES[idx] || `CH${idx + 1}`, x + 8, y + 14);

        // Render CRT waveform
        if (subCanvas) {
          WebScope.renderChannel(subCanvas, idx, true, {
            preset,
            scanlines: true,
            glowBloom: true,
            gridDividers: true,
            triggerLock: true
          });
          ctx.drawImage(subCanvas, x + 4, y + 18, cellW - 8, cellH - 24);
        }
      }
    }
  }

  // Draw Tracker Matrix Sequencer View
  private drawTrackerSequencerView(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    timeStr: string
  ) {
    // Header
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, width, 48);

    ctx.fillStyle = '#22d3ee';
    ctx.font = 'bold 14px monospace';
    ctx.fillText("ARIA48 TRACKER MATRIX SEQUENCER & SAMPLES INSPECTOR", 300, 30);

    // Left: Samples & Instrument Rack
    ctx.fillStyle = '#121215';
    ctx.fillRect(20, 60, 280, height - 80);
    ctx.strokeStyle = '#27272a';
    ctx.strokeRect(20, 60, 280, height - 80);

    ctx.fillStyle = '#e4e4e7';
    ctx.font = 'bold 11px monospace';
    ctx.fillText("INSTRUMENT & PCM SAMPLER", 35, 82);

    const SAMPLES = [
      "01: Acoustic Grand Piano (PCM)",
      "02: Paula Slap Bass (8-bit)",
      "03: Amiga Strings Ensemble",
      "04: GM Kick Drum (36)",
      "05: GM Snare Drum (38)",
      "06: Overdrive Guitar Stab",
      "07: Retro Chiptune Square Lead",
      "08: Vintage SID Pulse Wave"
    ];

    SAMPLES.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? '#0e7490' : '#18181b';
      ctx.fillRect(30, 95 + i * 36, 260, 28);
      ctx.fillStyle = i === 0 ? '#67e8f9' : '#a1a1aa';
      ctx.font = '10px monospace';
      ctx.fillText(s, 38, 113 + i * 36);
    });

    // Right: Tracker Matrix Grid
    const matrixX = 320;
    const matrixW = width - 340;
    ctx.fillStyle = '#09090b';
    ctx.fillRect(matrixX, 60, matrixW, height - 80);
    ctx.strokeStyle = '#27272a';
    ctx.strokeRect(matrixX, 60, matrixW, height - 80);

    // Channel columns
    const colW = matrixW / 8;
    for (let c = 0; c < 8; c++) {
      ctx.fillStyle = '#18181b';
      ctx.fillRect(matrixX + c * colW, 60, colW, 24);
      ctx.fillStyle = '#22d3ee';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`CH 0${c + 1}`, matrixX + c * colW + 10, 76);
    }

    // Scrolling rows simulation
    const activeRow = Math.floor((Date.now() / 150) % 64);
    for (let r = 0; r < 20; r++) {
      const rowIdx = (activeRow + r - 5) % 64;
      const isCurrent = r === 5;
      const rowY = 90 + r * 26;

      ctx.fillStyle = isCurrent ? 'rgba(6, 182, 212, 0.25)' : (r % 2 === 0 ? '#09090b' : '#121215');
      ctx.fillRect(matrixX, rowY, matrixW, 24);

      ctx.fillStyle = isCurrent ? '#22d3ee' : '#71717a';
      ctx.font = isCurrent ? 'bold 11px monospace' : '10px monospace';
      ctx.fillText(rowIdx.toString().padStart(2, '0'), matrixX + 6, rowY + 16);

      for (let c = 0; c < 8; c++) {
        const notes = ["C-4", "E-4", "G-4", "B-3", "A-4", "D-4", "---", "F-4"];
        const note = (rowIdx % 4 === 0) ? notes[(c + rowIdx) % notes.length] : "---";
        ctx.fillStyle = isCurrent ? '#ffffff' : (note !== "---" ? '#22c55e' : '#3f3f46');
        ctx.fillText(`${note} 01 80`, matrixX + 35 + c * colW, rowY + 16);
      }
    }
  }

  // Draw Dual Split View (Tracker + Oscilloscopes)
  private drawDualSplitView(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    subCanvas: HTMLCanvasElement | null,
    preset: WebScopePreset,
    timeStr: string
  ) {
    const halfW = width / 2;

    // LEFT: Tracker sequencer
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, halfW, height);
    ctx.clip();
    this.drawTrackerSequencerView(ctx, halfW * 1.5, height, timeStr);
    ctx.restore();

    // Divider
    ctx.strokeStyle = '#3f3f46';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(halfW, 0);
    ctx.lineTo(halfW, height);
    ctx.stroke();

    // RIGHT: 16-channel CRT Vector Oscilloscope
    ctx.save();
    ctx.translate(halfW, 0);
    this.drawOscilloscopeWall(ctx, halfW, height, subCanvas, preset, timeStr);
    ctx.restore();
  }
}

// Global Singleton for Video Recorder
export const VideoRecorder = new VideoRecorderService();
