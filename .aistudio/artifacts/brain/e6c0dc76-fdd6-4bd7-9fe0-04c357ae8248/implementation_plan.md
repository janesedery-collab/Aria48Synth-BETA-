# Universal Music & Chiptune Reader with SoundFont (SF2/SF3) & MIDI Engine

Comprehensive architecture and design plan to integrate a universal music file reader supporting Standard MIDI, classic trackers (MOD, XM, S3M, IT), retro console audio (SID, NSF, GBS, VGM, SPC, FTM), and standard audio files, backed by a real SoundFont (SF2/SF3) sampler engine, General MIDI instrument bank, and an expandable multi-channel tracker editor.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> Based on your request to include **all options**, the system will implement the full comprehensive suite:
> - **SoundFont (SF2/SF3) Engine**: Built-in General MIDI instrument sound bank + full binary `.sf2`/`.sf3` custom file parser + dynamic Web Audio synthesis fallback.
> - **Universal Music Reader**: Direct intake and parsing for Standard MIDI (`.mid`, `.midi`), Tracker formats (`.mod`, `.xm`, `.s3m`, `.it`), Console chiptune dumps (`.sid`, `.nsf`, `.gbs`, `.vgm`, `.spc`, `.ftm`, `.sunvox`), and Audio files (`.wav`, `.mp3`, `.ogg`, `.flac`).
> - **Multi-Channel Navigation**: Expandable up to 48 channels with horizontal panning, quick bank switching (Channels 1–8, 9–16, 17–24, 25–32, 33–48, All), and auto-focus active channels toggle.

- **Confirmed Decision 1**: Support all music and chiptune formats with both structured sequencer translation and direct audio/sample playback.
- **Confirmed Decision 2**: Provide built-in General MIDI instruments while enabling users to upload any `.sf2` or `.sf3` SoundFont file.
- **Confirmed Decision 3**: Provide 48-channel tracker support with bank pagination and horizontal scrolling.

---

### 1. Overview & Core Concept

- **What It Does**: Transforms the Aria48 tracker into a complete chiptune workstation and universal music workstation. Users can drag and drop any music file—whether an ancient Amiga module, Commodore 64 tune, Game Boy sound dump, NES theme, standard MIDI file, or custom SoundFont—and instantly parse it into sequenced tracker patterns, inspect channels, swap instruments, and play it back with authentic vintage chip synthesis or realistic SoundFont PCM samples.
- **Target Audience / Persona**: Chiptune composers, game audio designers, demoscene enthusiasts, retro musicians, and educators exploring vintage audio hardware architectures.
- **Key Value**: Eliminates the frustration of unsupported formats and silent stubs. Every supported file format actually parses notes, volumes, tempos, and channels into playable, editable tracker data.

---

### 2. User Experience & Visual Design

#### Key User Flows
1. **Intake & Auto-Detection**: The user drops a file (`.mid`, `.mod`, `.xm`, `.s3m`, `.it`, `.sid`, `.nsf`, `.gbs`, `.vgm`, `.spc`, `.sf2`, `.sf3`, `.wav`, `.mp3`) into the Intake Terminal or Tracker Import modal.
2. **Real-Time Translation & Telemetry**: The terminal displays real-time decoding logs (format magic bytes, detected channels, active notes count, song length, BPM, and instrument tables).
3. **SoundFont & Instrument Management**: A dedicated SoundFont panel shows active GM presets (Piano, Strings, Bass, Synth Leads, Drums) and loaded SF2/SF3 sample banks with instrument preview buttons.
4. **Interactive Tracker Playback**: Users navigate the 64-row matrix with synchronized channel playheads, oscilloscope visualizers, channel bank selectors (1–8, 9–16, etc.), and volume meters.
5. **Direct Channel Routing**: Each channel can be assigned to vintage chip waveforms (YM2612 FM, OPL3, SID, Virtual DAC) or SoundFont instrument presets.

#### Visual Identity & Theme
- **Aesthetic Direction**: High-precision retro-futuristic audio workstation (Furnace / ProTracker dark studio palette) adhering to strict anti-slop guidelines.
- **Color Palette**:
  - Dominant Neutral Canvas (60%): Deep zinc/black backdrop (`#09090b`, `#0c0a09`) with clean hairline grid borders (`#27272a`).
  - Structural Surfaces (30%): Dark slate panels (`#18181b`), subtle divider lines (`#27272a`), unboxed text metadata.
  - Accent Budget (10%): Phosphor cyan (`#06b6d4`, `#22d3ee`) for active playheads and note events; emerald green (`#10b981`) for compilation success and level meters.
- **Typography & Hierarchy**:
  - Display & Headings: `Plus Jakarta Sans` / `Outfit` for clean, confident titles without faux-code comment prefixes.
  - Tracker Matrix & Data: `JetBrains Mono` with `tabular-nums` for rock-solid vertical column alignment across channels, rows, and hexadecimal bytes.
- **Component Styling & Layout**:
  - Desktop baseline (1440px wide) with edge-to-edge layout, responsive channel viewports, and zero-pill clean metadata typography using subtle `·` separators.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Native In-Browser SF2/SF3 Parser vs External API**:
  - *Chosen Approach*: Pure client-side binary parser for SoundFont 2 (RIFF/sfbk chunks: INFO, sdta sample data, pdta preset/instrument generators) paired with Web Audio API sample decoders for SF3 (Ogg/Vorbis).
  - *Why*: Guarantees instant zero-latency loading, offline reliability, no API rate limits, and privacy for user-uploaded audio files.
  - *Alternatives Considered*: Server-side soundfont conversion was rejected due to network roundtrip latency and server resource limits.

- **Decision 2: Comprehensive Multi-Format Parsing Architecture**:
  - *Chosen Approach*: Modular binary decoders in `/src/utils/chiptuneParsers.ts`:
    - MIDI: Multi-track delta-time scheduler with tempo meta-events (0x51), Note-On/Off, and channel routing.
    - MOD / XM / S3M / IT: Authentic header parsing, pattern decompression, note period translation, and tempo/speed calculation.
    - Console formats (SID, NSF, GBS, VGM, SPC, FTM): Binary header identification, voice registers extraction, and authentic musical sequence reconstruction.
    - Audio (WAV, MP3, OGG, FLAC): Native Web Audio decoding with waveform analysis and rhythm-to-step mapping.
  - *Why*: Delivers on the user's explicit requirement to make everything actually work across all music and chiptune formats.

- **Decision 3: Expandable 48-Channel Viewport with Bank Paging**:
  - *Chosen Approach*: Support up to 48 channels simultaneously, with interactive channel bank tabs (e.g. 1–8, 9–16, 17–24, 25–32, 33–48, All) and a horizontal scrollable matrix.
  - *Why*: Allows large multi-track MIDI or complex tracker songs to load without clipping, while maintaining high performance and clean usability on standard screens.

---

### 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Universal File Intake                           │
│  (Drag & Drop / File Browser: MIDI, MOD, XM, S3M, IT, SID, NSF, SF2)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
┌───────────────────────────────────┐ ┌──────────────────────────────────┐
│     Binary Chiptune Decoders      │ │   SoundFont (SF2/SF3) Engine     │
│  • Standard MIDI (MThd / MTrk)    │ │  • RIFF / sfbk Parser            │
│  • ProTracker MOD / FastTracker XM│ │  • Sample Chunks (sdta/pdta)     │
│  • ScreamTracker S3M / IT         │ │  • Built-in GM Bank              │
│  • Console Dumps (SID, NSF, GBS)  │ │  • Zone / RootKey / Tuning       │
└─────────────────┬─────────────────┘ └──────────────────┬───────────────┘
                  │                                      │
                  ▼                                      │
┌───────────────────────────────────┐                    │
│    Pattern Matrix Translator      │                    │
│  • 64 Rows × 48 Channels          │                    │
│  • Note / Inst / Vol / Delay      │                    │
│  • BPM / Octave / Duration        │                    │
└─────────────────┬─────────────────┘                    │
                  │                                      │
                  ▼                                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Hybrid Web Audio Engine                         │
│  • Oscillator Nodes (YM2612 FM, OPL3 Triangle, SID Pulse, Virtual DAC) │
│  • SoundFont Sample Buffer Players (Pitch-shifted PCM with Envelopes)  │
│  • Stereo Panners & 3-Band Equalizer (Low / Mid / High)                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
┌───────────────────────────────────┐ ┌──────────────────────────────────┐
│      Interactive Tracker UI       │ │   Channel Bank & Mixer Controls  │
│  • 64-Row Synchronized Sequencer  │ │  • Bank Tabs (1-8, 9-16, All)    │
│  • Active Cell Note Editor        │ │  • Channel Solo / Mute / Volume  │
│  • Real-Time Oscilloscope Canvas  │ │  • SoundFont Preset Selector     │
└───────────────────────────────────┘ └──────────────────────────────────┘
```

#### Key Implementation Steps
1. **SoundFont Engine (`src/utils/soundFontEngine.ts`)**:
   - SF2 binary parser extracting RIFF `sfbk` chunks (`LIST` subchunks: `INFO`, `sdta`, `pdta`).
   - Sample decoder and zone mapper (root key, fine tune, loop start/end).
   - Built-in General MIDI sound bank with lightweight synthesized PCM instrument samples for instant playback without external downloads.
   - Web Audio sample-voice player with pitch shifting (`playbackRate = Math.pow(2, (midiNote - rootKey) / 12)`).
2. **Expanded Universal Parsers (`src/utils/chiptuneParsers.ts`)**:
   - Complete Standard MIDI File (`.mid`, `.midi`) multi-track reader mapping channels 1–16 accurately.
   - FastTracker II (`.xm`), ScreamTracker III (`.s3m`), Impulse Tracker (`.it`) decoders.
   - Console audio decoders (`.sid`, `.nsf`, `.gbs`, `.vgm`, `.spc`, `.ftm`).
   - Audio file decoder (`.wav`, `.mp3`, `.ogg`, `.flac`) via Web Audio API.
3. **Channel Matrix & Bank Paging (`src/components/TrackerEditor.tsx`)**:
   - Channel bank selector buttons (1–8, 9–16, 17–24, 25–32, 33–48, All).
   - Compact / Expanded channel views with horizontal scrolling for up to 48 channels.
   - Cell editor supporting SoundFont instrument assignment.
4. **Enhanced Audio Engine (`src/components/AudioEngine.ts`)**:
   - Integrated playback supporting both synthetic chip oscillators and SoundFont PCM instrument samples.
   - Dynamic per-channel preset selection.
5. **Intake Terminal & Converter UI (`src/components/FileConverterUI.tsx`)**:
   - Support for all file formats with file type badges, detailed decoding logs, and SoundFont upload/audition tab.
