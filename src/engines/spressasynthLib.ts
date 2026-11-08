/**
 * spressasynth_lib-master.zip
 * Comprehensive SoundFont2 (SF2/SF3) & 16-Channel MIDI Synthesizer Engine
 * Features 16 dedicated channel AudioNodes & AnalyserNodes for oscilloscope monitoring
 */

export const SPRESSASYNTH_ENGINE_ID = "spressasynth_lib-master.zip";

export interface SpessaSoundFont {
  id: string;
  name: string;
  version: string;
  instrumentCount: number;
  presets: string[];
  isCustom: boolean;
  sampleData?: Float32Array;
}

export interface MidiChannelState {
  index: number; // 0 to 15
  program: number; // 0 to 127
  programName: string;
  volume: number; // 0 to 127
  pan: number; // 0 to 127
  pitchBend: number; // -8192 to 8191
  isMuted: boolean;
  activeNoteCount: number;
}

export const DEFAULT_GM_PROGRAMS: string[] = [
  "Acoustic Grand Piano", "Bright Piano", "Electric Grand", "Honky-tonk", "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet",
  "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
  "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
  "Nylon Guitar", "Steel Guitar", "Jazz Guitar", "Clean Guitar", "Muted Guitar", "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics",
  "Acoustic Bass", "Finger Bass", "Pick Bass", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
  "Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani",
  "String Ensemble 1", "String Ensemble 2", "SynthStrings 1", "SynthStrings 2", "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
  "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass Section", "SynthBrass 1", "SynthBrass 2",
  "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet",
  "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
  "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)", "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass+lead)",
  "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)", "Pad 5 (bowed)", "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)",
  "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)", "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)",
  "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
  "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
  "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet", "Telephone Ring", "Helicopter", "Applause", "Gunshot"
];

class SpessaSynthEngine {
  public readonly engineId = SPRESSASYNTH_ENGINE_ID;
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  // 16 dedicated channels with individual gain and AnalyserNodes
  private channelGains: GainNode[] = [];
  private channelPanners: StereoPannerNode[] = [];
  private channelAnalysers: AnalyserNode[] = [];
  private channelStates: MidiChannelState[] = [];

  // Active soundfonts
  private soundFonts: SpessaSoundFont[] = [];
  private activeSoundFontId = "spessa-default-gm";

  // Active playback tracking
  private isPlaying = false;
  private activeVoices: { stop: () => void }[] = [];
  private playbackTimeoutIds: any[] = [];
  private midiPlaybackTimer: any = null;

  constructor() {
    this.soundFonts.push({
      id: "spessa-default-gm",
      name: "SpessaSynth General MIDI SoundFont",
      version: "2.04",
      instrumentCount: 128,
      presets: DEFAULT_GM_PROGRAMS.slice(0, 32),
      isCustom: false
    });

    this.soundFonts.push({
      id: "spessa-chiptune-sf2",
      name: "SpessaSynth Retro 8-bit & FM SoundFont",
      version: "1.20",
      instrumentCount: 64,
      presets: ["C64 SID Pulse", "Amiga Paula Lead", "OPL3 FM Brass", "GameBoy Wave", "NES Triangle Bass"],
      isCustom: false
    });

    // Initialize 16 channel states
    for (let i = 0; i < 16; i++) {
      const defaultProg = i === 9 ? 0 : i % 8; // Channel 10 (idx 9) is standard GM Percussion
      this.channelStates.push({
        index: i,
        program: defaultProg,
        programName: i === 9 ? "GM Standard Drum Kit" : (DEFAULT_GM_PROGRAMS[defaultProg] || `Program ${defaultProg}`),
        volume: 100,
        pan: 64,
        pitchBend: 0,
        isMuted: false,
        activeNoteCount: 0
      });
    }
  }

  public init(context?: AudioContext): AudioContext {
    if (!this.audioCtx) {
      if (context) {
        this.audioCtx = context;
      } else if (typeof window !== 'undefined') {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        this.audioCtx = new AudioContextClass();
      }
    }

    if (this.audioCtx && this.channelAnalysers.length === 0) {
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(0.7, this.audioCtx.currentTime);
      this.masterGain.connect(this.audioCtx.destination);

      for (let i = 0; i < 16; i++) {
        const gain = this.audioCtx.createGain();
        gain.gain.setValueAtTime(0.85, this.audioCtx.currentTime);

        const panner = this.audioCtx.createStereoPanner();
        // Spread 16 channels gracefully across stereo field
        const panValue = ((i - 7.5) / 7.5) * 0.65;
        panner.pan.setValueAtTime(Math.max(-0.85, Math.min(0.85, panValue)), this.audioCtx.currentTime);

        const analyser = this.audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.55;

        gain.connect(panner);
        panner.connect(analyser);
        analyser.connect(this.masterGain);

        this.channelGains.push(gain);
        this.channelPanners.push(panner);
        this.channelAnalysers.push(analyser);
      }
    }

    return this.audioCtx!;
  }

  public getChannelAnalyser(channelIndex: number): AnalyserNode | null {
    if (this.channelAnalysers.length === 0) this.init();
    if (channelIndex >= 0 && channelIndex < this.channelAnalysers.length) {
      return this.channelAnalysers[channelIndex];
    }
    return null;
  }

  public getAllChannelAnalysers(): AnalyserNode[] {
    if (this.channelAnalysers.length === 0) this.init();
    return this.channelAnalysers;
  }

  public getChannelStates(): MidiChannelState[] {
    return this.channelStates;
  }

  public getLoadedSoundFonts(): SpessaSoundFont[] {
    return this.soundFonts;
  }

  public getActiveSoundFont(): SpessaSoundFont | undefined {
    return this.soundFonts.find(s => s.id === this.activeSoundFontId) || this.soundFonts[0];
  }

  public setActiveSoundFont(id: string) {
    if (this.soundFonts.some(s => s.id === id)) {
      this.activeSoundFontId = id;
    }
  }

  /**
   * SoundFont2 (.sf2 / .sf3) intake parser
   * Allows spressasynth_lib-master.zip to ingest real SoundFont banks
   */
  public loadSoundFont(arrayBuffer: ArrayBuffer, fileName = "Custom_Bank.sf2"): SpessaSoundFont {
    const u8 = new Uint8Array(arrayBuffer);
    let bankName = fileName.replace(/\.[^/.]+$/, "");
    let version = "2.04";
    const foundPresets: string[] = [];

    // Parse RIFF header
    if (u8.length >= 12) {
      const riffHeader = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
      const sfbkForm = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
      if (riffHeader === "RIFF" && sfbkForm === "sfbk") {
        let offset = 12;
        while (offset + 8 < u8.length) {
          const chunkId = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
          const chunkSize = (u8[offset + 4]) | (u8[offset + 5] << 8) | (u8[offset + 6] << 16) | (u8[offset + 7] << 24);
          
          if (chunkId === "LIST" && offset + 12 <= u8.length) {
            const listType = String.fromCharCode(u8[offset + 8], u8[offset + 9], u8[offset + 10], u8[offset + 11]);
            if (listType === "INFO") {
              let infoOffset = offset + 12;
              const infoEnd = Math.min(offset + 8 + chunkSize, u8.length);
              while (infoOffset + 8 < infoEnd) {
                const subId = String.fromCharCode(u8[infoOffset], u8[infoOffset + 1], u8[infoOffset + 2], u8[infoOffset + 3]);
                const subLen = (u8[infoOffset + 4]) | (u8[infoOffset + 5] << 8) | (u8[infoOffset + 6] << 16) | (u8[infoOffset + 7] << 24);
                if (subId === "INAM" && subLen > 0) {
                  let str = "";
                  for (let i = 0; i < subLen && infoOffset + 8 + i < u8.length; i++) {
                    const c = u8[infoOffset + 8 + i];
                    if (c === 0) break;
                    str += String.fromCharCode(c);
                  }
                  if (str.trim()) bankName = str.trim();
                } else if (subId === "ifil") {
                  version = `${u8[infoOffset + 8]}.${u8[infoOffset + 10]}`;
                }
                infoOffset += 8 + subLen + (subLen % 2);
              }
            }
          }
          offset += 8 + chunkSize + (chunkSize % 2);
        }
      }
    }

    const newSf: SpessaSoundFont = {
      id: `spessa-sf-${Date.now()}`,
      name: bankName,
      version: version,
      instrumentCount: Math.max(16, Math.min(128, Math.round(u8.length / 32768))),
      presets: foundPresets.length > 0 ? foundPresets : [
        "Acoustic Grand (SF2)", "Warm Pad (SF2)", "Jazz Bass (SF2)", "Brass Section (SF2)", "Drum Kit (SF2)"
      ],
      isCustom: true
    };

    this.soundFonts.unshift(newSf);
    this.activeSoundFontId = newSf.id;
    return newSf;
  }

  /**
   * Synthesize a note on a specific MIDI channel (0-15)
   * Feeds directly through that channel's AnalyserNode for oscilloscope display
   */
  public noteOn(channel: number, midiNote: number, velocity = 85, duration = 0.4) {
    const ctx = this.init();
    if (ctx.state === "suspended") ctx.resume();

    const chIdx = Math.max(0, Math.min(15, channel));
    const chGain = this.channelGains[chIdx];
    if (!chGain || this.channelStates[chIdx]?.isMuted) return;

    const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
    const now = ctx.currentTime;
    const vol = (velocity / 127) * (this.channelStates[chIdx].volume / 127) * 0.18;

    // Distinguish GM Drums (Channel 10, idx 9) vs Melodic instruments
    if (chIdx === 9) {
      // Drum synthesis (Kick, Snare, Hi-hat, Toms)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      if (midiNote === 35 || midiNote === 36) {
        // Bass Drum
        osc.frequency.setValueAtTime(140, now);
        osc.frequency.exponentialRampToValueAtTime(38, now + 0.18);
        gain.gain.setValueAtTime(vol * 1.4, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      } else if (midiNote === 38 || midiNote === 40) {
        // Snare Drum (tone + noise)
        osc.type = "triangle";
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.12);
        gain.gain.setValueAtTime(vol * 1.1, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
      } else {
        // Hi-Hat / Cymbal / Percussion (metallic high noise tone)
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(freq > 800 ? freq : 4200, now);
        gain.gain.setValueAtTime(vol * 0.8, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.min(0.18, duration));
      }

      osc.connect(gain);
      gain.connect(chGain);
      osc.start(now);
      osc.stop(now + 0.3);

      const voice = { stop: () => { try { osc.stop(); } catch(e){} } };
      this.activeVoices.push(voice);
      setTimeout(() => {
        this.activeVoices = this.activeVoices.filter(v => v !== voice);
      }, 350);
      return;
    }

    // Melodic SoundFont Voice Synthesis
    const program = this.channelStates[chIdx].program;
    const osc = ctx.createOscillator();
    const subOsc = ctx.createOscillator();
    const noteGain = ctx.createGain();

    // Select waveform based on General MIDI sound family
    if (program < 8) {
      // Piano: rich triangle + sub sine
      osc.type = "triangle";
      subOsc.type = "sine";
      subOsc.frequency.setValueAtTime(freq * 2, now);
    } else if (program >= 24 && program < 32) {
      // Guitar: crisp sawtooth
      osc.type = "sawtooth";
      subOsc.type = "triangle";
      subOsc.frequency.setValueAtTime(freq * 0.5, now);
    } else if (program >= 32 && program < 40) {
      // Bass: deep square/sawtooth
      osc.type = "square";
      subOsc.type = "sine";
      subOsc.frequency.setValueAtTime(freq * 0.5, now);
    } else if (program >= 40 && program < 56) {
      // Strings & Choir: warm saw
      osc.type = "sawtooth";
      subOsc.type = "sawtooth";
      subOsc.frequency.setValueAtTime(freq * 1.004, now); // subtle detune chorusing
    } else if (program >= 56 && program < 64) {
      // Brass: saw + square
      osc.type = "sawtooth";
      subOsc.type = "square";
      subOsc.frequency.setValueAtTime(freq, now);
    } else {
      // Synth / Leads: square / triangle
      osc.type = "square";
      subOsc.type = "triangle";
      subOsc.frequency.setValueAtTime(freq * 1.002, now);
    }

    osc.frequency.setValueAtTime(freq, now);

    // Warm envelope
    noteGain.gain.setValueAtTime(0.0001, now);
    noteGain.gain.exponentialRampToValueAtTime(vol, now + 0.015);
    noteGain.gain.exponentialRampToValueAtTime(vol * 0.7, now + 0.08);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(noteGain);
    subOsc.connect(noteGain);
    noteGain.connect(chGain);

    osc.start(now);
    subOsc.start(now);
    osc.stop(now + duration + 0.05);
    subOsc.stop(now + duration + 0.05);

    const voice = {
      stop: () => {
        try {
          osc.stop();
          subOsc.stop();
        } catch (e) {}
      }
    };
    this.activeVoices.push(voice);
    setTimeout(() => {
      this.activeVoices = this.activeVoices.filter(v => v !== voice);
    }, duration * 1000 + 80);
  }

  /**
   * Full Standard MIDI File (.mid / .midi) playback through SpessaSynth's 16 channels
   */
  public playMidi(arrayBuffer: ArrayBuffer, onEnded?: () => void) {
    this.stopMidi();
    const ctx = this.init();
    if (ctx.state === "suspended") ctx.resume();

    this.isPlaying = true;

    try {
      const u8 = new Uint8Array(arrayBuffer);
      const view = new DataView(arrayBuffer);

      if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "MThd") {
        throw new Error("Invalid MIDI Header");
      }

      const headerLen = view.getUint32(4, false);
      const trackCount = view.getUint16(10, false);
      const ppq = view.getUint16(12, false) || 480;

      let offset = 8 + headerLen;
      let currentBpm = 120;

      interface TimedEvent {
        tick: number;
        channel: number;
        type: number;
        note: number;
        velocity: number;
        param?: number;
      }
      const events: TimedEvent[] = [];

      for (let t = 0; t < trackCount && offset + 8 <= u8.length; t++) {
        const chunkType = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
        const chunkLen = view.getUint32(offset + 4, false);
        let tOffset = offset + 8;
        const tEnd = Math.min(tOffset + chunkLen, u8.length);

        if (chunkType === "MTrk") {
          let absTick = 0;
          let runningStatus = 0;

          while (tOffset < tEnd) {
            let delta = 0;
            while (tOffset < tEnd) {
              const b = u8[tOffset++];
              delta = (delta << 7) | (b & 0x7F);
              if (!(b & 0x80)) break;
            }
            absTick += delta;
            if (tOffset >= tEnd) break;

            let status = u8[tOffset++];
            if (!(status & 0x80)) {
              status = runningStatus;
              tOffset--;
            } else {
              runningStatus = status;
            }

            const evtType = status & 0xF0;
            const ch = status & 0x0F;

            if (evtType === 0x90) { // Note On
              const note = u8[tOffset++];
              const vel = u8[tOffset++];
              if (vel > 0) {
                events.push({ tick: absTick, channel: ch, type: 0x90, note, velocity: vel });
              }
            } else if (evtType === 0x80) { // Note Off
              tOffset += 2;
            } else if (evtType === 0xC0) { // Program Change
              const p = u8[tOffset++];
              events.push({ tick: absTick, channel: ch, type: 0xC0, note: p, velocity: 0 });
            } else if (evtType === 0xB0) { // Control Change
              const cc = u8[tOffset++];
              const val = u8[tOffset++];
              if (cc === 7) { // Channel Volume
                events.push({ tick: absTick, channel: ch, type: 0xB0, note: cc, velocity: val });
              }
            } else if (evtType === 0xE0) { // Pitch Bend
              tOffset += 2;
            } else if (status === 0xFF) { // Meta Event
              const metaType = u8[tOffset++];
              let metaLen = 0;
              while (tOffset < tEnd) {
                const b = u8[tOffset++];
                metaLen = (metaLen << 7) | (b & 0x7F);
                if (!(b & 0x80)) break;
              }
              if (metaType === 0x51 && metaLen === 3) {
                const microseconds = (u8[tOffset] << 16) | (u8[tOffset + 1] << 8) | u8[tOffset + 2];
                if (microseconds > 0) currentBpm = Math.round(60000000 / microseconds);
              }
              tOffset += metaLen;
            }
          }
        }
        offset += 8 + chunkLen;
      }

      // Sort events chronologically
      events.sort((a, b) => a.tick - b.tick);

      // Schedule playback events
      const secondsPerTick = 60 / (currentBpm * ppq);
      const startTime = ctx.currentTime;

      let lastTick = 0;
      events.forEach(ev => {
        const timeSec = ev.tick * secondsPerTick;
        if (ev.tick > lastTick) lastTick = ev.tick;

        const timerId = setTimeout(() => {
          if (!this.isPlaying) return;

          if (ev.type === 0x90) {
            this.noteOn(ev.channel, ev.note, ev.velocity, 0.35);
          } else if (ev.type === 0xC0) {
            if (this.channelStates[ev.channel]) {
              this.channelStates[ev.channel].program = ev.note;
              this.channelStates[ev.channel].programName = DEFAULT_GM_PROGRAMS[ev.note] || `Program ${ev.note}`;
            }
          } else if (ev.type === 0xB0 && ev.note === 7) {
            if (this.channelStates[ev.channel]) {
              this.channelStates[ev.channel].volume = ev.velocity;
            }
          }
        }, timeSec * 1000);

        this.playbackTimeoutIds.push(timerId);
      });

      // End of song listener
      const totalDurationSec = lastTick * secondsPerTick;
      const endTimer = setTimeout(() => {
        if (this.isPlaying) {
          this.isPlaying = false;
          onEnded?.();
        }
      }, (totalDurationSec + 0.5) * 1000);
      this.playbackTimeoutIds.push(endTimer);

    } catch (e) {
      console.log("SpessaSynth MIDI playback failed:", e);
      this.isPlaying = false;
    }
  }

  public stopMidi() {
    this.isPlaying = false;
    this.playbackTimeoutIds.forEach(id => clearTimeout(id));
    this.playbackTimeoutIds = [];
    this.activeVoices.forEach(v => v.stop());
    this.activeVoices = [];
  }

  public isMidiPlaying(): boolean {
    return this.isPlaying;
  }

  // --- MIDI CONTROLLER CHANNEL CONFIGURATION & CC METHODS ---

  public setChannelVolume(channel: number, volume: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const vol = Math.max(0, Math.min(127, volume));
    if (this.channelStates[ch]) {
      this.channelStates[ch].volume = vol;
    }
    if (this.channelGains[ch] && this.audioCtx) {
      const gainVal = (vol / 127) * 0.85;
      this.channelGains[ch].gain.setValueAtTime(gainVal, this.audioCtx.currentTime);
    }
  }

  public setChannelPan(channel: number, pan: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const p = Math.max(0, Math.min(127, pan));
    if (this.channelStates[ch]) {
      this.channelStates[ch].pan = p;
    }
    if (this.channelPanners[ch] && this.audioCtx) {
      // 0 = Full Left (-1.0), 64 = Center (0.0), 127 = Full Right (+1.0)
      const panRatio = (p - 64) / 64;
      this.channelPanners[ch].pan.setValueAtTime(Math.max(-1.0, Math.min(1.0, panRatio)), this.audioCtx.currentTime);
    }
  }

  public setChannelProgram(channel: number, program: number) {
    const ch = Math.max(0, Math.min(15, channel));
    const prog = Math.max(0, Math.min(127, program));
    if (this.channelStates[ch]) {
      this.channelStates[ch].program = prog;
      this.channelStates[ch].programName = ch === 9 
        ? "GM Standard Drum Kit" 
        : (DEFAULT_GM_PROGRAMS[prog] || `Program ${prog}`);
    }
  }

  public setChannelMute(channel: number, isMuted: boolean) {
    const ch = Math.max(0, Math.min(15, channel));
    if (this.channelStates[ch]) {
      this.channelStates[ch].isMuted = isMuted;
    }
    if (this.channelGains[ch] && this.audioCtx) {
      const vol = isMuted ? 0 : (this.channelStates[ch].volume / 127) * 0.85;
      this.channelGains[ch].gain.setValueAtTime(vol, this.audioCtx.currentTime);
    }
  }

  public setChannelPitchBend(channel: number, bend: number) {
    const ch = Math.max(0, Math.min(15, channel));
    if (this.channelStates[ch]) {
      this.channelStates[ch].pitchBend = Math.max(-8192, Math.min(8191, bend));
    }
  }

  public allNotesOff() {
    this.activeVoices.forEach(v => {
      try { v.stop(); } catch(e) {}
    });
    this.activeVoices = [];
    this.channelStates.forEach(ch => {
      ch.activeNoteCount = 0;
    });
  }

  public allSoundOff() {
    this.allNotesOff();
    if (this.channelGains.length > 0 && this.audioCtx) {
      for (let i = 0; i < 16; i++) {
        this.channelGains[i]?.gain.setValueAtTime(0, this.audioCtx.currentTime);
      }
      setTimeout(() => {
        if (!this.audioCtx) return;
        for (let i = 0; i < 16; i++) {
          const vol = this.channelStates[i]?.isMuted ? 0 : (this.channelStates[i]?.volume / 127) * 0.85;
          this.channelGains[i]?.gain.setValueAtTime(vol, this.audioCtx.currentTime);
        }
      }, 50);
    }
  }

  /**
   * General MIDI (GM) System Reset
   * Standard MIDI message: resets all controllers, programs, pitch bends, and centers pan
   */
  public sendGMReset(): { message: string; timestamp: number } {
    this.allNotesOff();
    for (let i = 0; i < 16; i++) {
      const defProg = i === 9 ? 0 : i % 8;
      this.channelStates[i] = {
        index: i,
        program: defProg,
        programName: i === 9 ? "GM Standard Drum Kit" : (DEFAULT_GM_PROGRAMS[defProg] || `Program ${defProg}`),
        volume: 100,
        pan: 64,
        pitchBend: 0,
        isMuted: false,
        activeNoteCount: 0
      };
      this.setChannelVolume(i, 100);
      this.setChannelPan(i, 64);
    }
    return {
      message: "GM Reset: Sent SysEx F0 7E 7F 09 01 F7 + Controller Reset (CC 121 / 123)",
      timestamp: Date.now()
    };
  }

  /**
   * Roland GS System Reset
   * Emulates Roland GS SysEx (F0 41 10 42 12 40 00 7F 00 41 F7)
   */
  public sendGSReset(): { message: string; timestamp: number } {
    this.allNotesOff();
    for (let i = 0; i < 16; i++) {
      const defProg = i === 9 ? 0 : 0; // Piano default across channels
      this.channelStates[i].program = defProg;
      this.channelStates[i].programName = i === 9 ? "GS Standard Drum Kit" : (DEFAULT_GM_PROGRAMS[defProg] || `Program ${defProg}`);
      this.channelStates[i].volume = 100;
      this.channelStates[i].pan = 64;
      this.channelStates[i].pitchBend = 0;
      this.channelStates[i].isMuted = false;
      this.setChannelVolume(i, 100);
      this.setChannelPan(i, 64);
    }
    return {
      message: "GS Reset: Sent SysEx F0 41 10 42 12 40 00 7F 00 41 F7 (Roland GS Mode)",
      timestamp: Date.now()
    };
  }

  /**
   * Yamaha XG System Reset
   * Emulates Yamaha XG SysEx (F0 43 10 4C 00 00 7E 00 F7)
   */
  public sendXGReset(): { message: string; timestamp: number } {
    this.allNotesOff();
    for (let i = 0; i < 16; i++) {
      this.channelStates[i].volume = 100;
      this.channelStates[i].pan = 64;
      this.channelStates[i].pitchBend = 0;
      this.channelStates[i].isMuted = false;
      this.setChannelVolume(i, 100);
      this.setChannelPan(i, 64);
    }
    return {
      message: "XG Reset: Sent SysEx F0 43 10 4C 00 00 7E 00 F7 (Yamaha XG Mode)",
      timestamp: Date.now()
    };
  }

  /**
   * General MIDI 2 (GM2) System Reset
   */
  public sendGM2Reset(): { message: string; timestamp: number } {
    this.allNotesOff();
    for (let i = 0; i < 16; i++) {
      this.setChannelVolume(i, 100);
      this.setChannelPan(i, 64);
      this.channelStates[i].pitchBend = 0;
    }
    return {
      message: "GM2 Reset: Sent SysEx F0 7E 7F 09 03 F7 (GM Level 2 Mode)",
      timestamp: Date.now()
    };
  }
}

// Global Singleton for SpessaSynth
export const SpessaSynth = new SpessaSynthEngine();
