import React, { useState, useEffect } from 'react';
import { 
  X, Cloud, CloudUpload, CloudDownload, LogIn, LogOut, Check, 
  Trash2, Play, Music, Cpu, Layers, Disc3, ShieldCheck, AlertCircle, RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  signInWithGoogle, 
  signOutUser, 
  getCurrentUser, 
  onAuthUserChanged, 
  saveSongToCloud, 
  getUserCloudSongs, 
  deleteUserCloudSong, 
  CloudSong 
} from '../utils/cloudSongsService';
import { Channel } from '../types';
import { User } from '../lib/firebase';

interface CloudSongsModalProps {
  isOpen: boolean;
  onClose: () => void;
  patterns: any[];
  allPatterns?: any[][];
  channels: Channel[];
  bpm: number;
  trackTitle?: string | null;
  trackDuration?: string | null;
  trackChipType?: string | null;
  onImportSong: (
    patterns: any[], 
    bpm: number, 
    duration?: string, 
    title?: string, 
    chipType?: string, 
    octaveRange?: string, 
    channelsCount?: number,
    allPatterns?: any[][],
    audioBuffer?: AudioBuffer,
    channelSoundFonts?: { [channelId: number]: string }
  ) => void;
}

export default function CloudSongsModal({
  isOpen,
  onClose,
  patterns,
  allPatterns,
  channels,
  bpm,
  trackTitle,
  trackDuration,
  trackChipType,
  onImportSong
}: CloudSongsModalProps) {
  const [user, setUser] = useState<User | null>(getCurrentUser());
  const [activeTab, setActiveTab] = useState<'export' | 'import'>('import');
  const [cloudSongs, setCloudSongs] = useState<CloudSong[]>([]);
  const [isLoadingSongs, setIsLoadingSongs] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Export form fields
  const [exportTitle, setExportTitle] = useState(trackTitle || 'My Tracker Track');

  // Listen to auth state
  useEffect(() => {
    const unsubscribe = onAuthUserChanged((currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        loadUserSongs();
      } else {
        setCloudSongs([]);
      }
    });
    return () => unsubscribe();
  }, []);

  // Update default export title when modal opens
  useEffect(() => {
    if (isOpen) {
      setExportTitle(trackTitle || 'My Tracker Track');
      if (user) {
        loadUserSongs();
      }
    }
  }, [isOpen, trackTitle, user]);

  const loadUserSongs = async () => {
    setIsLoadingSongs(true);
    try {
      const songs = await getUserCloudSongs();
      setCloudSongs(songs);
    } catch (e: any) {
      console.error("Failed to load cloud songs:", e);
    } finally {
      setIsLoadingSongs(false);
    }
  };

  const handleSignIn = async () => {
    setIsSigningIn(true);
    setStatusMessage(null);
    try {
      const loggedUser = await signInWithGoogle();
      setUser(loggedUser);
      setStatusMessage({ type: 'success', text: `Signed in as ${loggedUser.displayName || loggedUser.email}` });
      setTimeout(() => setStatusMessage(null), 3000);
      await loadUserSongs();
    } catch (err: any) {
      if (err.code !== 'auth/popup-closed-by-user') {
        setStatusMessage({ type: 'error', text: `Google Sign-In failed: ${err.message}` });
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOutUser();
      setUser(null);
      setCloudSongs([]);
      setStatusMessage({ type: 'success', text: 'Signed out of Google account' });
      setTimeout(() => setStatusMessage(null), 2500);
    } catch (e: any) {
      console.error("Sign-out error:", e);
    }
  };

  const handleExportToCloud = async () => {
    if (!user) {
      await handleSignIn();
      return;
    }

    setIsSaving(true);
    setStatusMessage(null);

    try {
      const saved = await saveSongToCloud(
        exportTitle,
        bpm,
        trackChipType || channels[0]?.chip || 'General MIDI',
        channels,
        patterns,
        allPatterns,
        trackDuration || undefined
      );

      setStatusMessage({ type: 'success', text: `Song "${saved.title}" saved to your Google Cloud library!` });
      await loadUserSongs();
      setActiveTab('import');
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Failed to save: ${err.message}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleImportCloudSong = (song: CloudSong) => {
    try {
      onImportSong(
        song.patterns,
        song.bpm,
        song.duration,
        song.title,
        song.chipType,
        undefined,
        song.channelsCount,
        song.allPatterns,
        undefined,
        song.channelSoundFonts
      );
      setStatusMessage({ type: 'success', text: `Imported "${song.title}" (${song.bpm} BPM) from Cloud!` });
      setTimeout(() => {
        setStatusMessage(null);
        onClose();
      }, 1200);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Import failed: ${err.message}` });
    }
  };

  const handleDeleteCloudSong = async (songId: string, songTitle: string) => {
    if (!confirm(`Are you sure you want to delete "${songTitle}" from your Google Cloud library?`)) {
      return;
    }

    try {
      await deleteUserCloudSong(songId);
      setCloudSongs(prev => prev.filter(s => s.id !== songId));
      setStatusMessage({ type: 'success', text: `Deleted "${songTitle}" from Cloud.` });
      setTimeout(() => setStatusMessage(null), 2500);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Delete failed: ${err.message}` });
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4 backdrop-blur-md font-mono select-none">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          className="bg-zinc-950 border-2 border-indigo-500/40 rounded-2xl max-w-2xl w-full p-6 text-zinc-100 shadow-[0_0_50px_rgba(99,102,241,0.2)] flex flex-col gap-4 relative overflow-hidden max-h-[90vh]"
        >
          {/* Ambient Glow */}
          <div className="absolute top-0 right-0 w-56 h-56 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-56 h-56 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

          {/* Modal Header with Google Profile Badge */}
          <div className="flex items-center justify-between border-b border-zinc-850 pb-3 z-10 flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-950/60 border border-indigo-500/50 rounded-xl text-indigo-400">
                <Cloud size={22} className="animate-pulse" />
              </div>
              <div>
                <h2 className="text-base font-black uppercase tracking-wider text-white flex items-center gap-2">
                  Google Cloud Library
                  <span className="text-[9px] px-1.5 py-0.5 bg-indigo-950 text-indigo-300 rounded font-normal border border-indigo-800">
                    Export & Import
                  </span>
                </h2>
                <p className="text-[11px] text-zinc-400 font-sans">
                  Synchronize your songs, patterns, and soundfont presets across any device
                </p>
              </div>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 text-zinc-500 hover:text-white hover:bg-zinc-900 rounded-lg transition"
            >
              <X size={18} />
            </button>
          </div>

          {/* GOOGLE SIGN IN BAR */}
          <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-3 flex items-center justify-between gap-3 flex-wrap">
            {user ? (
              <div className="flex items-center gap-3">
                {user.photoURL ? (
                  <img 
                    src={user.photoURL} 
                    alt={user.displayName || "User"} 
                    className="w-9 h-9 rounded-full border border-indigo-500/50 object-cover" 
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-sm">
                    {(user.displayName || user.email || "U")[0].toUpperCase()}
                  </div>
                )}
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    {user.displayName || "Google Producer"}
                    <span className="text-[8.5px] px-1.5 py-0.2 bg-emerald-950 text-emerald-300 border border-emerald-800 rounded">
                      Linked
                    </span>
                  </span>
                  <span className="text-[10px] text-zinc-400 font-sans truncate max-w-[200px]">
                    {user.email}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center p-1.5 border border-zinc-700">
                  {/* Google SVG G Icon */}
                  <svg viewBox="0 0 24 24" className="w-full h-full">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-bold text-white">Sign in with Google</p>
                  <p className="text-[10px] text-zinc-400 font-sans">
                    Save tracker songs to cloud storage and import on any computer
                  </p>
                </div>
              </div>
            )}

            <div>
              {user ? (
                <button
                  onClick={handleSignOut}
                  className="px-3 py-1.5 bg-zinc-850 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5 border border-zinc-750 cursor-pointer"
                >
                  <LogOut size={12} />
                  <span>Sign Out</span>
                </button>
              ) : (
                <button
                  id="google-signin-btn"
                  onClick={handleSignIn}
                  disabled={isSigningIn}
                  className="px-3.5 py-1.5 bg-white hover:bg-zinc-100 text-zinc-900 rounded-lg text-xs font-bold transition flex items-center gap-2 shadow cursor-pointer font-sans"
                >
                  {isSigningIn ? (
                    <RefreshCw size={13} className="animate-spin text-zinc-700" />
                  ) : (
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                    </svg>
                  )}
                  <span>Sign in with Google</span>
                </button>
              )}
            </div>
          </div>

          {/* STATUS NOTIFICATION TOAST */}
          {statusMessage && (
            <motion.div
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              className={`p-2.5 rounded-lg text-xs flex items-center gap-2 ${
                statusMessage.type === 'success' 
                  ? 'bg-emerald-950/70 border border-emerald-500/60 text-emerald-300' 
                  : 'bg-red-950/70 border border-red-500/60 text-red-300'
              }`}
            >
              {statusMessage.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
              <span>{statusMessage.text}</span>
            </motion.div>
          )}

          {/* NAVIGATION TABS: IMPORT VS EXPORT */}
          <div className="flex items-center gap-2 border-b border-zinc-800 pb-2">
            <button
              onClick={() => setActiveTab('import')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition cursor-pointer ${
                activeTab === 'import'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-850'
              }`}
            >
              <CloudDownload size={13} />
              <span>Import from Cloud ({cloudSongs.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('export')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition cursor-pointer ${
                activeTab === 'export'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-850'
              }`}
            >
              <CloudUpload size={13} />
              <span>Export Song to Cloud</span>
            </button>

            <button
              onClick={loadUserSongs}
              disabled={isLoadingSongs || !user}
              className="ml-auto p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900 rounded-lg transition disabled:opacity-30 cursor-pointer"
              title="Refresh Cloud Library"
            >
              <RefreshCw size={13} className={isLoadingSongs ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* TAB CONTENT: EXPORT */}
          {activeTab === 'export' && (
            <div className="flex flex-col gap-3 py-1">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3">
                <div>
                  <label className="text-[10px] text-zinc-400 uppercase tracking-wider font-bold block mb-1">
                    Song Title
                  </label>
                  <input
                    type="text"
                    value={exportTitle}
                    onChange={(e) => setExportTitle(e.target.value)}
                    placeholder="Enter song title..."
                    className="w-full bg-black border border-zinc-800 focus:border-indigo-500 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none"
                  />
                </div>

                {/* Song Metadata Summary Pill */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10.5px]">
                  <div className="bg-black/60 p-2 rounded border border-zinc-850 flex flex-col">
                    <span className="text-zinc-600 text-[8.5px] uppercase">TEMPO</span>
                    <span className="text-cyan-400 font-bold">{bpm} BPM</span>
                  </div>
                  <div className="bg-black/60 p-2 rounded border border-zinc-850 flex flex-col">
                    <span className="text-zinc-600 text-[8.5px] uppercase">CHANNELS</span>
                    <span className="text-emerald-400 font-bold">{channels.filter(c => c.enabled).length || 8} CH</span>
                  </div>
                  <div className="bg-black/60 p-2 rounded border border-zinc-850 flex flex-col">
                    <span className="text-zinc-600 text-[8.5px] uppercase">CHIP ENGINE</span>
                    <span className="text-amber-400 font-bold truncate">{trackChipType || 'General MIDI'}</span>
                  </div>
                  <div className="bg-black/60 p-2 rounded border border-zinc-850 flex flex-col">
                    <span className="text-zinc-600 text-[8.5px] uppercase">PATTERNS</span>
                    <span className="text-indigo-400 font-bold">{allPatterns?.length || 1} Blocks</span>
                  </div>
                </div>

                <button
                  id="cloud-save-btn"
                  onClick={handleExportToCloud}
                  disabled={isSaving}
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold rounded-lg text-xs uppercase tracking-wider transition flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(99,102,241,0.3)] cursor-pointer mt-1"
                >
                  {isSaving ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Saving to Cloud...</span>
                    </>
                  ) : (
                    <>
                      <CloudUpload size={14} />
                      <span>Save & Export Song to Google Account</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* TAB CONTENT: IMPORT */}
          {activeTab === 'import' && (
            <div className="flex-1 overflow-y-auto max-h-[380px] custom-scrollbar flex flex-col gap-2 pr-1">
              {!user ? (
                <div className="p-8 text-center flex flex-col items-center justify-center gap-3 bg-zinc-900/40 rounded-xl border border-zinc-850">
                  <Cloud size={32} className="text-zinc-600" />
                  <p className="text-xs text-zinc-400 max-w-sm font-sans">
                    Sign in with your Google account above to view and import your saved cloud songs.
                  </p>
                  <button
                    onClick={handleSignIn}
                    className="px-4 py-2 bg-white text-zinc-900 rounded-lg text-xs font-bold hover:bg-zinc-100 transition flex items-center gap-2 font-sans cursor-pointer"
                  >
                    <span>Sign in with Google</span>
                  </button>
                </div>
              ) : isLoadingSongs ? (
                <div className="p-8 text-center flex items-center justify-center gap-2 text-zinc-500 text-xs">
                  <RefreshCw size={14} className="animate-spin text-indigo-400" />
                  <span>Loading your cloud library...</span>
                </div>
              ) : cloudSongs.length === 0 ? (
                <div className="p-8 text-center flex flex-col items-center justify-center gap-2 bg-zinc-900/40 rounded-xl border border-zinc-850">
                  <Music size={28} className="text-zinc-600" />
                  <p className="text-xs font-bold text-zinc-300">No songs saved in cloud yet</p>
                  <p className="text-[10.5px] text-zinc-500 font-sans max-w-sm">
                    Switch to the &quot;Export Song to Cloud&quot; tab to save your first pattern sequence under this account!
                  </p>
                  <button
                    onClick={() => setActiveTab('export')}
                    className="mt-2 px-3 py-1.5 bg-indigo-950 text-indigo-300 border border-indigo-700/60 rounded-lg text-xs font-bold hover:bg-indigo-900 transition cursor-pointer"
                  >
                    Export Current Song
                  </button>
                </div>
              ) : (
                cloudSongs.map((song) => (
                  <div
                    key={song.id}
                    className="bg-black/80 hover:bg-zinc-900 border border-zinc-850 hover:border-indigo-500/50 rounded-xl p-3 flex items-center justify-between gap-3 transition group"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-indigo-950/70 border border-indigo-700/50 flex items-center justify-center text-indigo-400 flex-shrink-0">
                        <Music size={15} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-bold text-white truncate group-hover:text-indigo-300 transition-colors">
                          {song.title}
                        </span>
                        <div className="flex items-center gap-2 text-[9.5px] text-zinc-400 font-sans mt-0.5">
                          <span className="text-cyan-400 font-mono font-bold">{song.bpm} BPM</span>
                          <span>•</span>
                          <span className="text-emerald-400">{song.channelsCount} CH</span>
                          <span>•</span>
                          <span className="text-amber-400 font-mono truncate max-w-[90px]">{song.chipType}</span>
                          <span>•</span>
                          <span className="text-zinc-500 font-mono">
                            {new Date(song.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {/* Direct Import Button */}
                      <button
                        onClick={() => handleImportCloudSong(song)}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[10.5px] font-bold uppercase tracking-wider transition flex items-center gap-1.5 shadow cursor-pointer"
                        title="Import sequence into active tracker"
                      >
                        <Play size={11} fill="currentColor" />
                        <span>Import</span>
                      </button>

                      {/* Delete Button */}
                      <button
                        onClick={() => handleDeleteCloudSong(song.id, song.title)}
                        className="p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-950/40 rounded-lg transition border border-transparent hover:border-red-800/40 cursor-pointer"
                        title="Delete from Google Cloud"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Modal Footer */}
          <div className="flex items-center justify-between text-[10px] text-zinc-500 border-t border-zinc-900 pt-3">
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={12} className="text-indigo-400" />
              Direct Firebase Auth & Cloud Firestore Integration
            </span>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-lg font-bold transition"
            >
              Close
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
