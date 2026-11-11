import { 
  collection, 
  doc, 
  setDoc, 
  getDocs, 
  deleteDoc, 
  query, 
  orderBy, 
  serverTimestamp 
} from 'firebase/firestore';
import { 
  auth, 
  googleAuthProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  db, 
  User 
} from '../lib/firebase';
import { Channel } from '../types';

export type { User };

export interface CloudSong {
  id: string;
  userId: string;
  authorName: string;
  title: string;
  chipType: string;
  bpm: number;
  duration: string;
  channelsCount: number;
  patterns: any[];        // First pattern matrix
  allPatterns?: any[][];  // Full multi-pattern chronological sequence
  channelSoundFonts?: { [channelId: number]: string };
  soundFontPreset?: string;
  createdAt: any;
  updatedAt?: any;
}

// Google Sign-In with popup
export async function signInWithGoogle(): Promise<User> {
  try {
    const result = await signInWithPopup(auth, googleAuthProvider);
    return result.user;
  } catch (err: any) {
    console.error("Google sign-in error:", err);
    throw err;
  }
}

// Sign-Out
export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

// Subscribe to auth state
export function onAuthUserChanged(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

// Get currently logged-in user
export function getCurrentUser(): User | null {
  return auth.currentUser;
}

/**
 * Export / Save current active song to Google Cloud account
 */
export async function saveSongToCloud(
  title: string,
  bpm: number,
  chipType: string,
  channels: Channel[],
  patterns: any[],
  allPatterns?: any[][],
  duration?: string,
  channelSoundFonts?: { [channelId: number]: string }
): Promise<CloudSong> {
  const user = getCurrentUser();
  if (!user) {
    throw new Error("Please sign in with Google to save songs to your cloud account.");
  }

  const songId = `song_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const songsCol = collection(db, 'users', user.uid, 'cloud_songs');
  const songDocRef = doc(songsCol, songId);

  const activeChannels = channels.filter(c => c.enabled).length || 8;
  const songDuration = duration || "1:04";

  // Build channel soundfonts mapping if not provided
  const resolvedSoundFonts: { [channelId: number]: string } = channelSoundFonts || {};
  channels.forEach(c => {
    if (c.soundFontPreset) {
      resolvedSoundFonts[c.id] = c.soundFontPreset;
    }
  });

  const songData = {
    id: songId,
    userId: user.uid,
    authorName: user.displayName || user.email || "Aria48 Producer",
    title: title.trim() || `Untitled Song ${new Date().toLocaleDateString()}`,
    chipType: chipType || 'General MIDI (SoundFont)',
    bpm: Math.max(30, Math.min(320, bpm)),
    duration: songDuration,
    channelsCount: activeChannels,
    patterns: patterns,
    allPatterns: allPatterns || [patterns],
    channelSoundFonts: resolvedSoundFonts,
    soundFontPreset: channels[0]?.soundFontPreset || 'gm_piano',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await setDoc(songDocRef, songData);

  return {
    ...songData,
    createdAt: new Date().toISOString()
  };
}

/**
 * Fetch all saved songs belonging to current Google user
 */
export async function getUserCloudSongs(): Promise<CloudSong[]> {
  const user = getCurrentUser();
  if (!user) return [];

  try {
    const songsCol = collection(db, 'users', user.uid, 'cloud_songs');
    const q = query(songsCol);
    const snapshot = await getDocs(q);

    const songs: CloudSong[] = [];
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      songs.push({
        id: docSnap.id,
        userId: data.userId || user.uid,
        authorName: data.authorName || "Producer",
        title: data.title || "Untitled",
        chipType: data.chipType || "General MIDI",
        bpm: data.bpm || 125,
        duration: data.duration || "1:00",
        channelsCount: data.channelsCount || 8,
        patterns: data.patterns || [],
        allPatterns: data.allPatterns || (data.patterns ? [data.patterns] : []),
        channelSoundFonts: data.channelSoundFonts || {},
        soundFontPreset: data.soundFontPreset,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || new Date().toISOString()),
        updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : undefined
      });
    });

    // Sort by created time descending
    songs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return songs;
  } catch (err: any) {
    console.error("Error fetching cloud songs:", err);
    return [];
  }
}

/**
 * Delete a saved song from user's Google Cloud account
 */
export async function deleteUserCloudSong(songId: string): Promise<void> {
  const user = getCurrentUser();
  if (!user) throw new Error("Must be signed in to delete songs.");

  const songDocRef = doc(db, 'users', user.uid, 'cloud_songs', songId);
  await deleteDoc(songDocRef);
}
