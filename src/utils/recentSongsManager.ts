/**
 * recentSongsManager.ts
 * Manages persistent storage of:
 * 1. Last played / imported songs history (localStorage + session fallback)
 * 2. Selected SoundFont preset preference persistence
 */

export interface RecentSong {
  id: string;
  title: string;
  chipType: string;
  duration: string;
  bpm: number;
  channelsCount: number;
  octaveRange?: string;
  playedAt: number;
  patterns: any[];
  allPatterns?: any[][];
  channelSoundFonts?: { [channelId: number]: string };
}

const STORAGE_KEY_RECENT_SONGS = 'aria48_recent_songs';
const STORAGE_KEY_SELECTED_SOUNDFONT = 'aria48_selected_soundfont';

const DEFAULT_SAMPLE_HISTORY: RecentSong[] = [
  {
    id: 'sample_cyber_drive',
    title: 'Cybernetic Neon Driver',
    chipType: 'General MIDI (SoundFont)',
    duration: '1:12',
    bpm: 130,
    channelsCount: 16,
    octaveRange: 'C-2 - G-5',
    playedAt: Date.now() - 1000 * 60 * 15, // 15 mins ago
    patterns: [],
    channelSoundFonts: { 1: 'gm_lead', 2: 'gm_bass', 10: 'gm_drums' }
  },
  {
    id: 'sample_space_patrol',
    title: 'Space Patrol (Amiga Mod)',
    chipType: 'PAULA (Amiga PCM)',
    duration: '0:48',
    bpm: 125,
    channelsCount: 4,
    octaveRange: 'C-3 - B-4',
    playedAt: Date.now() - 1000 * 60 * 90, // 90 mins ago
    patterns: []
  }
];

export function getRecentSongs(): RecentSong[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_SAMPLE_HISTORY;
    const raw = localStorage.getItem(STORAGE_KEY_RECENT_SONGS);
    if (!raw) {
      localStorage.setItem(STORAGE_KEY_RECENT_SONGS, JSON.stringify(DEFAULT_SAMPLE_HISTORY));
      return DEFAULT_SAMPLE_HISTORY;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_SAMPLE_HISTORY;
  } catch (err) {
    console.warn("Failed reading recent songs history:", err);
    return DEFAULT_SAMPLE_HISTORY;
  }
}

export function addRecentSong(entry: {
  title?: string;
  chipType?: string;
  duration?: string;
  bpm?: number;
  channelsCount?: number;
  octaveRange?: string;
  patterns?: any[];
  allPatterns?: any[][];
  channelSoundFonts?: { [channelId: number]: string };
}): RecentSong {
  const songTitle = entry.title?.trim() || "Untitled Track";
  const newSong: RecentSong = {
    id: `song_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    title: songTitle,
    chipType: entry.chipType || "General MIDI",
    duration: entry.duration || "1:00",
    bpm: entry.bpm || 120,
    channelsCount: entry.channelsCount || 8,
    octaveRange: entry.octaveRange || "C-2 - C-6",
    playedAt: Date.now(),
    patterns: entry.patterns || [],
    allPatterns: entry.allPatterns,
    channelSoundFonts: entry.channelSoundFonts
  };

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const current = getRecentSongs();
      // Remove any existing entry with identical title to keep top fresh
      const filtered = current.filter(s => s.title !== songTitle);
      const updated = [newSong, ...filtered].slice(0, 20); // Keep top 20
      localStorage.setItem(STORAGE_KEY_RECENT_SONGS, JSON.stringify(updated));
    }
  } catch (err) {
    console.warn("Failed writing recent song history:", err);
  }

  return newSong;
}

export function clearRecentSongs(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(STORAGE_KEY_RECENT_SONGS);
    }
  } catch (err) {
    console.warn("Failed clearing recent songs history:", err);
  }
}

/**
 * Persist user selected SoundFont preset across sessions
 */
export function saveSelectedSoundFont(presetId: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage && presetId) {
      localStorage.setItem(STORAGE_KEY_SELECTED_SOUNDFONT, presetId);
    }
  } catch (err) {
    console.warn("Failed saving selected soundfont preference:", err);
  }
}

export function getSavedSelectedSoundFont(): string {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = localStorage.getItem(STORAGE_KEY_SELECTED_SOUNDFONT);
      if (saved) return saved;
    }
  } catch (err) {
    console.warn("Failed reading selected soundfont preference:", err);
  }
  return "gm_piano";
}
