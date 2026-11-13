/**
 * videoRecorder.ts
 * Background Offline MP4 / WebM Video Exporter & Live Canvas Capture Engine
 *
 * Features:
 * - Independent Background Video Processing (renders offline completely separate from live song playback)
 * - Container formats: MP4 (.mp4 via mp4-muxer + WebCodecs) & WebM (.webm via webm-muxer + WebCodecs)
 * - Custom Frame Rate: 1 to 365 FPS (exact microsecond presentation timestamps)
 * - Resolution / Quality Presets up to 8K (480p, 720p, 1080p, 2K 1440p, 4K UHD, 8K 7680x4320)
 * - Real synced MIDI / SoundFont instrument names & real tracker pattern matrix
 * - Non-overlapping Mini Dual Split-Screen ('both'), 16-Channel Scopes, and Live Tracker modes
 */

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmArrayBufferTarget } from 'webm-muxer';
import { getAudioContext, getTinySynthMasterGain, getSyntheticMasterGain } from '../components/AudioEngine';
import { WebScope, WebScopePreset, WEBSCOPE_PRESETS } from '../engines/webscopeOscilloscope';
import { SpessaSynth } from '../engines/spressasynthLib';
import { WorkletSynthBridge } from '../engines/workletSynthBridge';
import { Chiptune3 } from '../engines/chiptune3';
import {
  OfflineSongSnapshot,
  RenderedAudioData,
  estimateSnapshotDurationSeconds,
  renderSongSnapshotOffline
} from './audioExport';

export type VideoRecordMode = 'oscilloscope' | 'tracker' | 'both';
export type VideoContainerFormat = 'mp4' | 'webm';
export type VideoQualityPreset = '480p' | '720p' | '1080p' | '1440p' | '4k' | '8k';

export const VIDEO_QUALITY_PRESETS: Record<
  VideoQualityPreset,
  { label: string; shortLabel: string; width: number; height: number; bitrateMbps: number }
> = {
  '480p': { label: '480p SD (Fast)', shortLabel: '480p', width: 854, height: 480, bitrateMbps: 3 },
  '720p': { label: '720p HD', shortLabel: '720p', width: 1280, height: 720, bitrateMbps: 6 },
  '1080p': { label: '1080p Full HD', shortLabel: '1080p', width: 1920, height: 1080, bitrateMbps: 12 },
  '1440p': { label: '1440p 2K QHD', shortLabel: '2K', width: 2560, height: 1440, bitrateMbps: 20 },
  '4k': { label: '2160p 4K UHD', shortLabel: '4K', width: 3840, height: 2160, bitrateMbps: 38 },
  '8k': { label: '4320p 8K UHD', shortLabel: '8K', width: 7680, height: 4320, bitrateMbps: 75 }
};

export interface LiveTrackerChannelSummary {
  id: number;
  chip?: string;
  soundFontPreset?: string;
  enabled?: boolean;
  mute?: boolean;
  volume?: number;
  pan?: number;
}

export interface LiveTrackerRecorderState {
  songPatterns: any[][];
  currentPatternIndex: number;
  activeRow: number;
  channels: LiveTrackerChannelSummary[];
  bpm: number;
  baseSongBpm?: number;
  trackTitle?: string | null;
  isPlaying: boolean;
  loadedAudioBuffer?: AudioBuffer | null;
  loadedMidiBuffer?: ArrayBuffer | null;
}

export interface VideoRecorderStatus {
  isRecording: boolean;
  isProcessing: boolean;
  isBackgroundJob: boolean;
  mode: VideoRecordMode | null;
  format: VideoContainerFormat;
  fps: number;
  quality: VideoQualityPreset;
  resolutionLabel: string;
  stageLabel: string;
  durationSeconds: number;
  targetDurationSeconds: number;
  progressPercent: number;
  downloadedFilename: string | null;
  errorMessage: string | null;
}

export interface VideoRecordOptions {
  targetDurationSeconds?: number;
  activePreset?: WebScopePreset;
  format?: VideoContainerFormat;
  fps?: number;
  quality?: VideoQualityPreset;
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

function clampFps(fps?: number): number {
  const n = Math.round(Number(fps) || 60);
  return Math.max(1, Math.min(365, n));
}

function yieldBackground(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function resampleStereoPcm(
  left: Float32Array,
  right: Float32Array,
  srcRate: number,
  dstRate: number
): { left: Float32Array; right: Float32Array } {
  if (srcRate === dstRate) {
    return { left, right };
  }
  const srcLen = Math.min(left.length, right.length);
  const dstLen = Math.max(1, Math.round((srcLen * dstRate) / srcRate));
  const outL = new Float32Array(dstLen);
  const outR = new Float32Array(dstLen);
  const ratio = srcRate / dstRate;
  for (let i = 0; i < dstLen; i++) {
    const pos = i * ratio;
    const idx0 = Math.floor(pos);
    const frac = pos - idx0;
    const idx1 = Math.min(srcLen - 1, idx0 + 1);
    outL[i] = left[idx0] + frac * (left[idx1] - left[idx0]);
    outR[i] = right[idx0] + frac * (right[idx1] - right[idx0]);
  }
  return { left: outL, right: outR };
}

class VideoRecorderService {
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordingCanvas: HTMLCanvasElement | null = null;
  private animFrameId: number | null = null;
  private timerIntervalId: any = null;
  private startTime = 0;

  private isRecordingInternal = false;
  private isProcessingInternal = false;
  private isBackgroundJobInternal = false;
  private bgAbortController: AbortController | null = null;

  private currentMode: VideoRecordMode | null = null;
  private currentFormat: VideoContainerFormat = 'mp4';
  private currentFps = 60;
  private currentQuality: VideoQualityPreset = '1080p';
  private resolutionLabel = '1920x1080';
  private stageLabel = '';
  private bgProgressPercent = 0;
  private targetDuration = 0;
  private lastDownloadedFilename: string | null = null;
  private lastErrorMessage: string | null = null;
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
    baseSongBpm: 125,
    trackTitle: null,
    isPlaying: false,
    loadedAudioBuffer: null,
    loadedMidiBuffer: null
  };

  public setLiveTrackerState(state: LiveTrackerRecorderState) {
    this.liveState = state;
  }

  public getCurrentSongSnapshot(): OfflineSongSnapshot {
    const ls = this.liveState;
    return {
      songPatterns: ls.songPatterns ? ls.songPatterns.map(p => (Array.isArray(p) ? [...p] : p)) : [],
      channels: (ls.channels || []).map(c => ({ ...c })),
      bpm: ls.bpm || 125,
      baseSongBpm: ls.baseSongBpm || ls.bpm || 125,
      trackTitle: ls.trackTitle,
      loadedAudioBuffer: ls.loadedAudioBuffer || null,
      loadedMidiBuffer: ls.loadedMidiBuffer ? ls.loadedMidiBuffer.slice(0) : null,
      soundBankBuffer: WorkletSynthBridge.getActiveSoundBankBuffer()
    };
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
    const progress = this.isBackgroundJobInternal
      ? this.bgProgressPercent
      : this.targetDuration > 0
        ? Math.min(100, (elapsed / this.targetDuration) * 100)
        : 0;

    return {
      isRecording: this.isRecordingInternal,
      isProcessing: this.isProcessingInternal,
      isBackgroundJob: this.isBackgroundJobInternal,
      mode: this.currentMode,
      format: this.currentFormat,
      fps: this.currentFps,
      quality: this.currentQuality,
      resolutionLabel: this.resolutionLabel,
      stageLabel: this.stageLabel,
      durationSeconds: Math.round(elapsed * 10) / 10,
      targetDurationSeconds: this.targetDuration,
      progressPercent: Math.round(progress),
      downloadedFilename: this.lastDownloadedFilename,
      errorMessage: this.lastErrorMessage
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

  public cancelBackgroundExport() {
    if (this.bgAbortController) {
      this.bgAbortController.abort();
      this.bgAbortController = null;
    }
  }

  /**
   * BACKGROUND OFFLINE VIDEO EXPORT (1–365 FPS, up to 8K, MP4 / WebM)
   * Runs completely independent of live UI playback: snapshots the song & SoundFont,
   * synthesizes audio offline, renders frames cleanly, and encodes via WebCodecs + MP4/WebM Muxer.
   */
  public async startBackgroundExport(
    mode: VideoRecordMode,
    options: VideoRecordOptions = {}
  ): Promise<boolean> {
    if (this.isRecordingInternal || this.isProcessingInternal || this.isBackgroundJobInternal) {
      return false;
    }

    const format: VideoContainerFormat = options.format || 'mp4';
    const fps = clampFps(options.fps || 60);
    const quality: VideoQualityPreset = options.quality || '1080p';
    const activePreset: WebScopePreset = options.activePreset || 'protracker';
    const qSpec = VIDEO_QUALITY_PRESETS[quality] || VIDEO_QUALITY_PRESETS['1080p'];

    const snapshot = options.liveState
      ? {
          songPatterns: options.liveState.songPatterns ? [...options.liveState.songPatterns] : [],
          channels: (options.liveState.channels || []).map(c => ({ ...c })),
          bpm: options.liveState.bpm || 125,
          baseSongBpm: options.liveState.baseSongBpm || options.liveState.bpm || 125,
          trackTitle: options.liveState.trackTitle,
          loadedAudioBuffer: options.liveState.loadedAudioBuffer || null,
          loadedMidiBuffer: options.liveState.loadedMidiBuffer ? options.liveState.loadedMidiBuffer.slice(0) : null,
          soundBankBuffer: WorkletSynthBridge.getActiveSoundBankBuffer()
        }
      : this.getCurrentSongSnapshot();

    const estDur = estimateSnapshotDurationSeconds(snapshot);
    const exportDur = options.targetDurationSeconds && options.targetDurationSeconds > 0
      ? options.targetDurationSeconds
      : Math.min(120, Math.max(4, estDur));

    this.bgAbortController = new AbortController();
    const signal = this.bgAbortController.signal;

    this.isBackgroundJobInternal = true;
    this.isProcessingInternal = true;
    this.isRecordingInternal = false;
    this.currentMode = mode;
    this.currentFormat = format;
    this.currentFps = fps;
    this.currentQuality = quality;
    this.targetDuration = exportDur;
    this.bgProgressPercent = 1;
    this.lastDownloadedFilename = null;
    this.lastErrorMessage = null;
    this.resolutionLabel = `${qSpec.width}x${qSpec.height}`;
    this.stageLabel = 'Snapshotting song & synthesizing offline audio...';
    this.onCompleteCallback = options.onComplete;
    this.notifyStatus();

    try {
      // 1. Offline Audio + 16-Channel Signal Snapshot Rendering (100% separate from live playback)
      const renderedAudio = await renderSongSnapshotOffline(
        snapshot,
        exportDur,
        (pct, stage) => {
          this.bgProgressPercent = Math.max(1, Math.min(28, Math.round(pct * 0.28)));
          this.stageLabel = stage;
          this.notifyStatus();
        },
        signal
      );

      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');

      // Ensure WebCodecs availability
      if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
        throw new Error('WebCodecs VideoEncoder is not available in this browser environment.');
      }

      // 2. Negotiate VideoEncoder codec for target format, resolution (up to 8K) and FPS (up to 365)
      const targetBitrate = Math.round(
        qSpec.bitrateMbps * 1_000_000 * Math.min(2.2, Math.max(1.0, fps / 60))
      );

      const videoNeg = await this.negotiateVideoCodec(
        format,
        qSpec.width,
        qSpec.height,
        fps,
        targetBitrate
      );

      if (!videoNeg) {
        throw new Error(
          `Your browser GPU/encoder does not support ${format.toUpperCase()} encoding at ${qSpec.width}x${qSpec.height} (${fps} FPS). Try a lower quality preset or WebM.`
        );
      }

      this.resolutionLabel = `${videoNeg.width}x${videoNeg.height}`;
      this.stageLabel = `Encoding ${format.toUpperCase()} (${videoNeg.width}x${videoNeg.height} @ ${fps} FPS · ${videoNeg.displayCodec})...`;
      this.notifyStatus();

      // 3. Negotiate AudioEncoder codec (AAC / Opus for MP4, Opus for WebM)
      const audioNeg = await this.negotiateAudioCodec(format);
      const audioPcm = audioNeg
        ? resampleStereoPcm(
            renderedAudio.left,
            renderedAudio.right,
            renderedAudio.sampleRate,
            audioNeg.sampleRate
          )
        : null;

      // 4. Initialize MP4 or WebM Muxer
      let mp4Muxer: Mp4Muxer<Mp4ArrayBufferTarget> | null = null;
      let webmMuxer: WebmMuxer<WebmArrayBufferTarget> | null = null;

      if (format === 'mp4') {
        mp4Muxer = new Mp4Muxer({
          target: new Mp4ArrayBufferTarget(),
          video: {
            codec: videoNeg.mp4Codec,
            width: videoNeg.width,
            height: videoNeg.height,
            frameRate: fps
          },
          audio: audioNeg
            ? {
                codec: audioNeg.mp4Codec,
                numberOfChannels: 2,
                sampleRate: audioNeg.sampleRate
              }
            : undefined,
          fastStart: 'in-memory',
          firstTimestampBehavior: 'offset'
        });
      } else {
        webmMuxer = new WebmMuxer({
          target: new WebmArrayBufferTarget(),
          video: {
            codec: videoNeg.webmCodec,
            width: videoNeg.width,
            height: videoNeg.height,
            frameRate: fps
          },
          audio: audioNeg
            ? {
                codec: audioNeg.webmCodec,
                numberOfChannels: 2,
                sampleRate: audioNeg.sampleRate
              }
            : undefined,
          firstTimestampBehavior: 'offset'
        });
      }

      // 5. Encode Offline Audio Track first cleanly
      if (audioNeg && audioPcm && typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
        let audioEncodeErr: any = null;
        const audioEncoder = new AudioEncoder({
          output: (chunk, meta) => {
            mp4Muxer?.addAudioChunk(chunk, meta);
            webmMuxer?.addAudioChunk(chunk, meta);
          },
          error: (err) => {
            audioEncodeErr = err;
          }
        });
        audioEncoder.configure({
          codec: audioNeg.codecString,
          numberOfChannels: 2,
          sampleRate: audioNeg.sampleRate,
          bitrate: 192000
        });

        const audioFramesPerChunk = 1024;
        const totalAudioSamples = audioPcm.left.length;
        for (let offset = 0; offset < totalAudioSamples; offset += audioFramesPerChunk) {
          if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
          if (audioEncodeErr) throw audioEncodeErr;
          const count = Math.min(audioFramesPerChunk, totalAudioSamples - offset);
          const planar = new Float32Array(count * 2);
          planar.set(audioPcm.left.subarray(offset, offset + count), 0);
          planar.set(audioPcm.right.subarray(offset, offset + count), count);

          const tsUs = Math.round((offset / audioNeg.sampleRate) * 1_000_000);
          const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate: audioNeg.sampleRate,
            numberOfFrames: count,
            numberOfChannels: 2,
            timestamp: tsUs,
            data: planar
          });
          audioEncoder.encode(audioData);
          audioData.close();

          if (audioEncoder.encodeQueueSize > 32) {
            await audioEncoder.flush();
          }
          if ((offset / audioFramesPerChunk) % 30 === 0) {
            await yieldBackground();
          }
        }
        await audioEncoder.flush();
        audioEncoder.close();
      }

      // 6. Setup Detached Offline Render Canvas (vector-scaled to requested resolution up to 8K)
      const canvas = document.createElement('canvas');
      canvas.width = videoNeg.width;
      canvas.height = videoNeg.height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Could not create 2D rendering context');

      const logicalW = mode === 'both' ? 1440 : 1280;
      const logicalH = mode === 'both' ? 810 : 720;
      const scaleX = videoNeg.width / logicalW;
      const scaleY = videoNeg.height / logicalH;

      let encoderErr: any = null;
      const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => {
          mp4Muxer?.addVideoChunk(chunk, meta);
          webmMuxer?.addVideoChunk(chunk, meta);
        },
        error: (err) => {
          encoderErr = err;
        }
      });

      videoEncoder.configure({
        codec: videoNeg.codecString,
        width: videoNeg.width,
        height: videoNeg.height,
        bitrate: targetBitrate,
        framerate: videoNeg.encoderFramerateHint
      });

      const totalFrames = Math.max(1, Math.round(renderedAudio.durationSeconds * fps));
      const frameDurationUs = Math.round(1_000_000 / fps);
      const keyInterval = Math.max(15, Math.min(120, fps));
      const songTotalRows = Math.max(1, (snapshot.songPatterns?.length || 1) * 64);
      const songEstDur = Math.max(0.5, estimateSnapshotDurationSeconds(snapshot));

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        if (signal.aborted) {
          try { videoEncoder.close(); } catch {}
          throw new DOMException('Export cancelled', 'AbortError');
        }
        if (encoderErr) throw encoderErr;

        const tSec = frameIdx / fps;
        const songRatio = Math.min(0.9999, (tSec % songEstDur) / songEstDur);
        const globalRow = Math.floor(songRatio * songTotalRows);
        const curPatIdx = Math.floor(globalRow / 64) % Math.max(1, snapshot.songPatterns?.length || 1);
        const curRowIdx = globalRow % 64;

        ctx.save();
        ctx.scale(scaleX, scaleY);
        this.renderSceneFrame(ctx, logicalW, logicalH, mode, {
          elapsedSecs: tSec,
          targetDur: renderedAudio.durationSeconds,
          activePreset,
          snapshot,
          patIdx: curPatIdx,
          rowIdx: curRowIdx,
          offlineAudio: renderedAudio,
          fpsLabel: `${fps} FPS · ${qSpec.shortLabel} ${format.toUpperCase()}`
        });
        ctx.restore();

        const tsUs = Math.round((frameIdx * 1_000_000) / fps);
        const frame = new VideoFrame(canvas, {
          timestamp: tsUs,
          duration: frameDurationUs
        });
        videoEncoder.encode(frame, { keyFrame: frameIdx % keyInterval === 0 });
        frame.close();

        // Backpressure control & UI yield so main app/audio keeps running smoothly in foreground
        if (videoEncoder.encodeQueueSize > 12) {
          while (videoEncoder.encodeQueueSize > 6 && !signal.aborted) {
            await yieldBackground();
          }
        } else if (frameIdx % Math.max(2, Math.min(12, Math.round(fps / 15))) === 0) {
          await yieldBackground();
        }

        if (frameIdx % Math.max(1, Math.floor(totalFrames / 60)) === 0 || frameIdx === totalFrames - 1) {
          this.bgProgressPercent = 28 + Math.round(((frameIdx + 1) / totalFrames) * 68);
          this.stageLabel = `Background ${format.toUpperCase()} ${qSpec.shortLabel} @ ${fps} FPS (${frameIdx + 1}/${totalFrames} frames)`;
          this.notifyStatus();
        }
      }

      this.stageLabel = `Finalizing ${format.toUpperCase()} container...`;
      this.bgProgressPercent = 97;
      this.notifyStatus();

      await videoEncoder.flush();
      videoEncoder.close();

      let finalBuffer: ArrayBuffer;
      let mimeType: string;
      if (mp4Muxer) {
        mp4Muxer.finalize();
        finalBuffer = mp4Muxer.target.buffer;
        mimeType = 'video/mp4';
      } else if (webmMuxer) {
        webmMuxer.finalize();
        finalBuffer = webmMuxer.target.buffer;
        mimeType = 'video/webm';
      } else {
        throw new Error('Muxer unavailable');
      }

      const blob = new Blob([finalBuffer], { type: mimeType });
      const safeTitle = (snapshot.trackTitle || 'Aria48').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `${safeTitle}_${mode.toUpperCase()}_${qSpec.shortLabel}_${fps}fps_${Date.now()}.${format}`;

      this.triggerDownload(blob, filename);
      this.lastDownloadedFilename = filename;
      this.bgProgressPercent = 100;
      this.stageLabel = `Exported ${filename}`;
      this.onCompleteCallback?.(blob, filename);
      return true;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.lastErrorMessage = 'Background video export cancelled.';
      } else {
        console.error('Background video export error:', err);
        this.lastErrorMessage = err?.message || 'Background video export failed.';
      }
      return false;
    } finally {
      this.bgAbortController = null;
      this.isBackgroundJobInternal = false;
      this.isProcessingInternal = false;
      this.currentMode = null;
      this.notifyStatus();
    }
  }

  private async negotiateVideoCodec(
    format: VideoContainerFormat,
    width: number,
    height: number,
    fps: number,
    bitrate: number
  ): Promise<{
    codecString: string;
    mp4Codec: 'avc' | 'hevc' | 'vp9' | 'av1';
    webmCodec: 'V_VP9' | 'V_VP8' | 'V_AV1';
    width: number;
    height: number;
    encoderFramerateHint: number;
    displayCodec: string;
  } | null> {
    if (typeof VideoEncoder === 'undefined' || !VideoEncoder.isConfigSupported) return null;

    type Candidate = {
      codecString: string;
      mp4Codec: 'avc' | 'hevc' | 'vp9' | 'av1';
      webmCodec: 'V_VP9' | 'V_VP8' | 'V_AV1';
      displayCodec: string;
    };

    const mp4Candidates: Candidate[] =
      width <= 4096
        ? [
            { codecString: 'avc1.640034', mp4Codec: 'avc', webmCodec: 'V_VP9', displayCodec: 'H.264 High' },
            { codecString: 'avc1.640033', mp4Codec: 'avc', webmCodec: 'V_VP9', displayCodec: 'H.264' },
            { codecString: 'avc1.64002a', mp4Codec: 'avc', webmCodec: 'V_VP9', displayCodec: 'H.264' },
            { codecString: 'av01.0.16M.08', mp4Codec: 'av1', webmCodec: 'V_AV1', displayCodec: 'AV1' },
            { codecString: 'vp09.00.62.08', mp4Codec: 'vp9', webmCodec: 'V_VP9', displayCodec: 'VP9' },
            { codecString: 'hev1.1.6.L180.90', mp4Codec: 'hevc', webmCodec: 'V_VP9', displayCodec: 'HEVC' }
          ]
        : [
            // 8K (7680x4320) requires Level 6.x VP9 / AV1 / HEVC
            { codecString: 'vp09.00.62.08', mp4Codec: 'vp9', webmCodec: 'V_VP9', displayCodec: 'VP9 8K' },
            { codecString: 'av01.0.17M.08', mp4Codec: 'av1', webmCodec: 'V_AV1', displayCodec: 'AV1 8K' },
            { codecString: 'av01.0.16M.08', mp4Codec: 'av1', webmCodec: 'V_AV1', displayCodec: 'AV1' },
            { codecString: 'hev1.1.6.L180.90', mp4Codec: 'hevc', webmCodec: 'V_VP9', displayCodec: 'HEVC 8K' }
          ];

    const webmCandidates: Candidate[] = [
      { codecString: 'vp09.00.62.08', mp4Codec: 'vp9', webmCodec: 'V_VP9', displayCodec: 'VP9' },
      { codecString: 'vp09.00.51.08', mp4Codec: 'vp9', webmCodec: 'V_VP9', displayCodec: 'VP9' },
      { codecString: 'vp09.00.41.08', mp4Codec: 'vp9', webmCodec: 'V_VP9', displayCodec: 'VP9' },
      { codecString: 'av01.0.16M.08', mp4Codec: 'av1', webmCodec: 'V_AV1', displayCodec: 'AV1' },
      { codecString: 'vp8', mp4Codec: 'vp9', webmCodec: 'V_VP8', displayCodec: 'VP8' }
    ];

    const candidates = format === 'mp4' ? mp4Candidates : webmCandidates;
    const framerateHints = fps > 120 ? [fps, 120, 60] : [fps, 60];

    for (const c of candidates) {
      for (const fr of framerateHints) {
        try {
          const res = await VideoEncoder.isConfigSupported({
            codec: c.codecString,
            width,
            height,
            bitrate,
            framerate: fr
          });
          if (res.supported) {
            return {
              ...c,
              width,
              height,
              encoderFramerateHint: fr
            };
          }
        } catch {}
      }
    }
    return null;
  }

  private async negotiateAudioCodec(format: VideoContainerFormat): Promise<{
    codecString: string;
    mp4Codec: 'aac' | 'opus';
    webmCodec: 'A_OPUS';
    sampleRate: number;
  } | null> {
    if (typeof AudioEncoder === 'undefined' || !AudioEncoder.isConfigSupported) return null;

    const candidates =
      format === 'mp4'
        ? [
            { codecString: 'mp4a.40.2', mp4Codec: 'aac' as const, webmCodec: 'A_OPUS' as const, sampleRate: 48000 },
            { codecString: 'mp4a.40.2', mp4Codec: 'aac' as const, webmCodec: 'A_OPUS' as const, sampleRate: 44100 },
            { codecString: 'opus', mp4Codec: 'opus' as const, webmCodec: 'A_OPUS' as const, sampleRate: 48000 }
          ]
        : [
            { codecString: 'opus', mp4Codec: 'opus' as const, webmCodec: 'A_OPUS' as const, sampleRate: 48000 }
          ];

    for (const c of candidates) {
      try {
        const res = await AudioEncoder.isConfigSupported({
          codec: c.codecString,
          numberOfChannels: 2,
          sampleRate: c.sampleRate,
          bitrate: 192000
        });
        if (res.supported) return c;
      } catch {}
    }
    return null;
  }

  /**
   * Optional live capture fallback if someone uses manual live recording
   */
  public startRecording(mode: VideoRecordMode, options: VideoRecordOptions = {}): boolean {
    if (this.isRecordingInternal || this.isProcessingInternal || this.isBackgroundJobInternal) return false;

    if (options.liveState) {
      this.liveState = options.liveState;
    }

    try {
      const format = options.format || 'webm';
      const fps = clampFps(options.fps || 30);
      const quality = options.quality || '720p';
      const qSpec = VIDEO_QUALITY_PRESETS[quality] || VIDEO_QUALITY_PRESETS['720p'];

      this.currentFormat = format;
      this.currentFps = fps;
      this.currentQuality = quality;
      this.resolutionLabel = `${qSpec.width}x${qSpec.height}`;
      this.stageLabel = 'Live capture recording';
      this.targetDuration = options.targetDurationSeconds || 0;
      this.onCompleteCallback = options.onComplete;
      this.onAutoStopCallback = options.onAutoStop;
      const activePreset = options.activePreset || 'protracker';
      this.lastDownloadedFilename = null;
      this.lastErrorMessage = null;

      const logicalW = mode === 'both' ? 1440 : 1280;
      const logicalH = mode === 'both' ? 810 : 720;

      this.recordingCanvas = document.createElement('canvas');
      this.recordingCanvas.width = qSpec.width;
      this.recordingCanvas.height = qSpec.height;
      const ctx = this.recordingCanvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Could not initialize 2D render context');

      const videoStream = this.recordingCanvas.captureStream(Math.min(120, fps));
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
          if (spessaMaster) { try { spessaMaster.connect(dest); } catch {} }
          const chiptuneMaster = Chiptune3.getMasterGain();
          if (chiptuneMaster) { try { chiptuneMaster.connect(dest); } catch {} }
          const tinyMaster = getTinySynthMasterGain();
          if (tinyMaster) { try { tinyMaster.connect(dest); } catch {} }
          const synthMaster = getSyntheticMasterGain();
          if (synthMaster) { try { synthMaster.connect(dest); } catch {} }

          const audioTracks = dest.stream.getAudioTracks();
          if (audioTracks.length > 0) {
            videoStream.addTrack(audioTracks[0]);
          }
        } catch (e) {
          console.warn('Audio track routing bypassed:', e);
        }
      }

      const mimeTypes =
        format === 'mp4'
          ? ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
          : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
      let selectedMime: string | undefined = undefined;
      for (const mime of mimeTypes) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
          selectedMime = mime;
          break;
        }
      }

      const recorderOptions: MediaRecorderOptions = {
        videoBitsPerSecond: qSpec.bitrateMbps * 1_000_000,
        audioBitsPerSecond: 192000
      };
      if (selectedMime) {
        recorderOptions.mimeType = selectedMime;
      }

      this.mediaRecorder = new MediaRecorder(videoStream, recorderOptions);
      this.recordedChunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
      };
      this.mediaRecorder.onstop = () => {
        this.processAndFinishDownload(mode);
      };

      this.mediaRecorder.start(250);
      this.isRecordingInternal = true;
      this.isProcessingInternal = false;
      this.isBackgroundJobInternal = false;
      this.currentMode = mode;
      this.startTime = Date.now();

      const scaleX = qSpec.width / logicalW;
      const scaleY = qSpec.height / logicalH;
      const snapshot = this.getCurrentSongSnapshot();

      const drawLoop = () => {
        if (!this.isRecordingInternal || !ctx || !this.recordingCanvas) return;
        const elapsedSecs = (Date.now() - this.startTime) / 1000;
        if (this.targetDuration > 0 && elapsedSecs >= this.targetDuration) {
          this.onAutoStopCallback?.();
          this.stopRecording();
          return;
        }

        ctx.save();
        ctx.scale(scaleX, scaleY);
        this.renderSceneFrame(ctx, logicalW, logicalH, mode, {
          elapsedSecs,
          targetDur: this.targetDuration,
          activePreset,
          snapshot: {
            ...snapshot,
            songPatterns: this.liveState.songPatterns,
            channels: this.liveState.channels,
            bpm: this.liveState.bpm,
            trackTitle: this.liveState.trackTitle
          },
          patIdx: this.liveState.currentPatternIndex || 0,
          rowIdx: this.liveState.activeRow || 0,
          fpsLabel: `${fps} FPS · ${qSpec.shortLabel}`
        });
        ctx.restore();

        this.animFrameId = requestAnimationFrame(drawLoop);
      };

      this.animFrameId = requestAnimationFrame(drawLoop);
      this.timerIntervalId = setInterval(() => this.notifyStatus(), 250);
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

  private triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
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
      const filename = `Aria48_${mode.toUpperCase()}_${Date.now()}.${ext}`;
      this.triggerDownload(blob, filename);
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

  /**
   * Unified Scene Renderer (shared between isolated Offline Background Export and Live Capture)
   */
  private renderSceneFrame(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    mode: VideoRecordMode,
    params: {
      elapsedSecs: number;
      targetDur: number;
      activePreset: WebScopePreset;
      snapshot: OfflineSongSnapshot;
      patIdx: number;
      rowIdx: number;
      offlineAudio?: RenderedAudioData;
      fpsLabel: string;
    }
  ) {
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, width, height);

    const mins = Math.floor(params.elapsedSecs / 60);
    const secs = Math.floor(params.elapsedSecs % 60);
    const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    this.drawTopMiniHud(ctx, width, mode, timeStr, params.targetDur, params.snapshot, params.patIdx, params.rowIdx, params.fpsLabel);

    const contentY = 44;
    const contentH = height - contentY - (params.targetDur > 0 ? 10 : 6);

    if (mode === 'oscilloscope') {
      this.drawOscilloscopePanel(
        ctx, 12, contentY, width - 24, contentH,
        params.activePreset, false, params.snapshot, params.elapsedSecs, params.offlineAudio
      );
    } else if (mode === 'tracker') {
      this.drawTrackerPanel(ctx, 12, contentY, width - 24, contentH, false, params.snapshot, params.patIdx, params.rowIdx, params.offlineAudio?.channelLabels);
    } else {
      const gap = 10;
      const paneW = Math.floor((width - 24 - gap) / 2);
      this.drawTrackerPanel(ctx, 12, contentY, paneW, contentH, true, params.snapshot, params.patIdx, params.rowIdx, params.offlineAudio?.channelLabels);

      ctx.fillStyle = '#27272a';
      ctx.fillRect(12 + paneW + 4, contentY, 2, contentH);

      this.drawOscilloscopePanel(
        ctx, 12 + paneW + gap, contentY, paneW, contentH,
        params.activePreset, true, params.snapshot, params.elapsedSecs, params.offlineAudio
      );
    }

    if (params.targetDur > 0) {
      const pct = Math.min(1, params.elapsedSecs / params.targetDur);
      ctx.fillStyle = '#27272a';
      ctx.fillRect(0, height - 5, width, 5);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
      ctx.fillRect(0, height - 5, width * pct, 5);
    }
  }

  private drawTopMiniHud(
    ctx: CanvasRenderingContext2D,
    width: number,
    mode: VideoRecordMode,
    timeStr: string,
    targetDur: number,
    snapshot: OfflineSongSnapshot,
    patIdx: number,
    rowIdx: number,
    fpsLabel: string
  ) {
    ctx.fillStyle = '#111114';
    ctx.fillRect(0, 0, width, 38);
    ctx.fillStyle = '#27272a';
    ctx.fillRect(0, 37, width, 1);

    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(20, 19, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fafafa';
    ctx.font = 'bold 11px monospace';
    const targetStr = targetDur > 0 ? ` / ${Math.round(targetDur)}s` : '';
    ctx.fillText(`REC ${timeStr}${targetStr} · ${fpsLabel}`, 32, 23);

    const title = (snapshot.trackTitle || 'Aria48 Sequence').slice(0, 34);
    const modeLabel = mode === 'both' ? 'MINI DUAL' : mode.toUpperCase();
    const hudRight = `${title} · ${snapshot.bpm || 125} BPM · PAT ${patIdx.toString().padStart(2, '0')} ROW ${rowIdx.toString().padStart(2, '0')} · ${modeLabel}`;

    ctx.fillStyle = '#22d3ee';
    ctx.font = 'bold 10.5px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(hudRight, width - 16, 23);
    ctx.textAlign = 'left';
  }

  private resolveRowCell(songPatterns: any[][], patIdx: number, rowIdx: number, chId: number): { note: string; inst: string; vol: string } {
    if (!songPatterns || songPatterns.length === 0) {
      return { note: '---', inst: '..', vol: '..' };
    }
    const safePat = songPatterns[Math.max(0, Math.min(songPatterns.length - 1, patIdx))];
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

  private resolveSyncedInstrumentName(
    idx: number,
    snapshot: OfflineSongSnapshot,
    offlineLabels?: string[]
  ): string {
    if (offlineLabels && offlineLabels[idx]) {
      return offlineLabels[idx];
    }
    const workletCh = WorkletSynthBridge.getChannelState(idx);
    if (workletCh?.patchName) return workletCh.patchName;
    const spessaStates = SpessaSynth.getChannelStates();
    if (spessaStates[idx]?.programName) return spessaStates[idx].programName;
    const chMeta = snapshot.channels?.[idx];
    if (chMeta?.soundFontPreset) {
      return chMeta.soundFontPreset.replace(/^gm_/, '').replace(/_/g, ' ').toUpperCase();
    }
    return SCOPE_ROLES[idx];
  }

  private drawTrackerPanel(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    pw: number,
    ph: number,
    mini: boolean,
    snapshot: OfflineSongSnapshot,
    curPatRaw: number,
    curRowRaw: number,
    offlineLabels?: string[]
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

    const headerH = mini ? 26 : 32;
    ctx.fillStyle = '#141418';
    ctx.fillRect(px, py, pw, headerH);
    ctx.fillStyle = '#27272a';
    ctx.fillRect(px, py + headerH - 1, pw, 1);

    const pats = snapshot.songPatterns || [];
    const totalPats = Math.max(1, pats.length);
    const curPat = Math.max(0, Math.min(totalPats - 1, curPatRaw));
    const curRow = Math.max(0, Math.min(63, curRowRaw));

    ctx.fillStyle = '#22d3ee';
    ctx.font = mini ? 'bold 10px monospace' : 'bold 11.5px monospace';
    ctx.fillText(
      mini
        ? `MINI TRACKER · PAT ${curPat.toString().padStart(2, '0')}/${(totalPats - 1).toString().padStart(2, '0')} · ROW ${curRow.toString(16).toUpperCase().padStart(2, '0')}`
        : `ARIA48 LIVE TRACKER MATRIX · PAT ${curPat.toString().padStart(2, '0')}/${(totalPats - 1).toString().padStart(2, '0')} · ROW ${curRow.toString(16).toUpperCase().padStart(2, '0')}`,
      px + 10,
      py + (mini ? 17 : 21)
    );

    const maxCols = mini ? 6 : 8;
    const enabled = (snapshot.channels || []).filter(c => c.enabled);
    const chosenChannels = (enabled.length > 0 ? enabled : (snapshot.channels || [])).slice(0, maxCols);
    while (chosenChannels.length < maxCols) {
      chosenChannels.push({ id: chosenChannels.length + 1, chip: 'GM' });
    }

    const footerH = mini ? 0 : 44;
    const gridX = px + 6;
    const gridY = py + headerH + 4;
    const gridW = pw - 12;
    const gridH = ph - headerH - footerH - 8;

    const gutterW = mini ? 30 : 40;
    const colW = Math.floor((gridW - gutterW) / maxCols);
    const colHeaderH = mini ? 24 : 30;

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

      const instName = this.resolveSyncedInstrumentName(ch.id - 1, snapshot, offlineLabels).slice(0, mini ? 11 : 14);
      ctx.fillStyle = '#a1a1aa';
      ctx.font = mini ? '8px monospace' : '8.5px monospace';
      ctx.fillText(instName, cx + 6, gridY + (mini ? 20 : 24));
    });

    const rowsBodyY = gridY + colHeaderH + 2;
    const rowsBodyH = gridH - colHeaderH - 4;
    const rowH = mini ? 22 : 24;
    const visibleRowCount = Math.max(8, Math.floor(rowsBodyH / rowH));
    const centerSlot = Math.floor(visibleRowCount * 0.35);

    for (let r = 0; r < visibleRowCount; r++) {
      const globalOffset = curPat * 64 + curRow + (r - centerSlot);
      const rowY = rowsBodyY + r * rowH;
      if (rowY + rowH > gridY + gridH) break;
      if (globalOffset < 0 || globalOffset >= totalPats * 64) continue;

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

      ctx.fillStyle = isCurrent ? '#67e8f9' : (rRow % 4 === 0 ? '#a1a1aa' : '#52525b');
      ctx.font = isCurrent ? 'bold 10px monospace' : '9.5px monospace';
      ctx.fillText(rRow.toString(16).toUpperCase().padStart(2, '0'), gridX + 7, rowY + 15);

      chosenChannels.forEach((ch, cIdx) => {
        const cx = gridX + gutterW + cIdx * colW;
        const cell = this.resolveRowCell(pats, rPat, rRow, ch.id);
        const hasNote = cell.note !== '---' && cell.note !== '';

        ctx.font = isCurrent ? 'bold 10px monospace' : '9.5px monospace';
        ctx.fillStyle = isCurrent
          ? (hasNote ? '#ffffff' : '#67e8f9')
          : cell.note === '===' || cell.note === 'OFF'
            ? '#f87171'
            : hasNote
              ? '#4ade80'
              : '#3f3f46';

        const cellText = mini ? `${cell.note} ${cell.inst}` : `${cell.note} ${cell.inst} ${cell.vol}`;
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
        .map(ch => `CH${ch.id.toString().padStart(2, '0')}:${this.resolveSyncedInstrumentName(ch.id - 1, snapshot, offlineLabels).slice(0, 14)}`)
        .join('  ·  ');
      ctx.fillStyle = '#67e8f9';
      ctx.font = '9px monospace';
      ctx.fillText(chipText, px + 10, fy + 32);
    }

    ctx.restore();
  }

  private drawOscilloscopePanel(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    pw: number,
    ph: number,
    preset: WebScopePreset,
    mini: boolean,
    snapshot: OfflineSongSnapshot,
    elapsedSecs: number,
    offlineAudio?: RenderedAudioData
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
    const pStyle = WEBSCOPE_PRESETS[preset] || WEBSCOPE_PRESETS.protracker;

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const idx = row * 4 + col;
        const x = gridX + col * (cellW + gap);
        const y = gridY + row * (cellH + gap);

        ctx.fillStyle = '#050507';
        ctx.fillRect(x, y, cellW, cellH);
        ctx.strokeStyle = '#27272a';
        ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);

        const labelH = mini ? 14 : 16;
        ctx.fillStyle = '#18181b';
        ctx.fillRect(x + 1, y + 1, cellW - 2, labelH);

        const chMeta = snapshot.channels?.[idx];
        const instName = this.resolveSyncedInstrumentName(idx, snapshot, offlineAudio?.channelLabels);
        const maxLabelChars = mini ? 16 : 22;
        const chLabel = `${SCOPE_ROLES[idx]} ${instName}`.slice(0, maxLabelChars);

        ctx.fillStyle = chMeta?.mute ? '#f87171' : '#fbbf24';
        ctx.font = mini ? 'bold 8.5px monospace' : 'bold 9.5px monospace';
        ctx.fillText(chLabel, x + 5, y + (mini ? 11 : 12));

        const scopeX = x + 2;
        const scopeY = y + labelH + 2;
        const scopeW = Math.max(20, cellW - 4);
        const scopeH = Math.max(12, cellH - labelH - 4);

        if (offlineAudio) {
          this.drawOfflineScopeWaveform(
            ctx,
            scopeX,
            scopeY,
            scopeW,
            scopeH,
            offlineAudio.channelSignals[idx],
            offlineAudio.sampleRate,
            elapsedSecs,
            Boolean(chMeta?.mute),
            pStyle
          );
        } else {
          const liveCanvas = this.getReusableSubCanvas();
          const isActiveAudio = this.liveState.isPlaying || SpessaSynth.isMidiPlaying() || Chiptune3.isChiptunePlaying();
          WebScope.renderChannel(liveCanvas, idx, isActiveAudio && !chMeta?.mute, {
            preset,
            scanlines: true,
            glowBloom: true,
            gridDividers: true,
            triggerLock: true,
            phaseSync: true
          });
          ctx.drawImage(liveCanvas, scopeX, scopeY, scopeW, scopeH);
        }
      }
    }

    ctx.restore();
  }

  private reusableSubCanvas: HTMLCanvasElement | null = null;
  private getReusableSubCanvas(): HTMLCanvasElement {
    if (!this.reusableSubCanvas) {
      this.reusableSubCanvas = document.createElement('canvas');
      this.reusableSubCanvas.width = 240;
      this.reusableSubCanvas.height = 104;
    }
    return this.reusableSubCanvas;
  }

  /**
   * Draw vector-crisp CRT oscilloscope trace from isolated offline per-channel PCM snapshot
   */
  private drawOfflineScopeWaveform(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    signal: Float32Array | undefined,
    sampleRate: number,
    elapsedSecs: number,
    isMuted: boolean,
    pStyle: (typeof WEBSCOPE_PRESETS)['protracker']
  ) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    ctx.fillStyle = pStyle.fill;
    ctx.fillRect(x, y, w, h);

    // Graticule center axis
    const midY = y + h * 0.5;
    ctx.strokeStyle = pStyle.grid;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, midY);
    ctx.lineTo(x + w, midY);
    ctx.stroke();

    if (signal && signal.length > 0 && !isMuted) {
      const centerSample = Math.floor(elapsedSecs * sampleRate);
      const winLen = 512;
      const baseStart = Math.max(0, Math.min(signal.length - winLen, centerSample - 256));

      // Rising zero-crossing trigger lock for stable CRT trace
      let trig = baseStart;
      const searchEnd = Math.min(signal.length - 1, baseStart + 256);
      for (let i = baseStart + 1; i < searchEnd; i++) {
        if (signal[i - 1] <= 0 && signal[i] > 0) {
          trig = i;
          break;
        }
      }

      const drawSamples = Math.min(256, signal.length - trig);
      if (drawSamples > 4) {
        ctx.strokeStyle = pStyle.stroke;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < drawSamples; i++) {
          const px = x + (i / (drawSamples - 1)) * w;
          const v = Math.max(-1, Math.min(1, signal[trig + i] * 1.35));
          const py = midY - v * (h * 0.42);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }

    ctx.restore();
  }
}

export const VideoRecorder = new VideoRecorderService();
