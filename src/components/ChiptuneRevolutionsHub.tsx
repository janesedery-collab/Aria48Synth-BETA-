import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  FolderOpen,
  LogOut,
  MessageSquare,
  RefreshCw,
  Send,
  Trash2,
  Users,
} from 'lucide-react';
import { auth, onAuthStateChanged, User } from '../lib/firebase';
import { signInWithGoogle, signOutUser } from '../utils/cloudSongsService';
import {
  CR_CATEGORIES,
  CR_LIMITS,
  CrQuestion,
  CrQuestionCategory,
  CrReply,
  createCrQuestion,
  createCrReply,
  deleteCrQuestion,
  subscribeCrQuestions,
  subscribeCrReplies,
  toggleCrQuestionStatus,
} from '../utils/crQuestionsService';

const GOOGLE_GROUP_EMBED_URL =
  'https://groups.google.com/forum/embed/?place=forum/chiptune-revolutions-cr&showsearch=true&showpopout=true';
const GOOGLE_GROUP_DIRECT_URL = 'https://groups.google.com/g/chiptune-revolutions-cr';
const DRIVE_MOD_CHIPTUNE_URL =
  'https://drive.google.com/drive/folders/1Joel5ZB-YlmV2KAMP0k6MGpE1rx7a8AU';
const DRIVE_MIDI_OTHER_URL =
  'https://drive.google.com/drive/folders/1NZ7yOt5MXlWPeCEAogpoZIKSmjrRtCmi';

function formatRelativeTimestamp(date: Date | null): string {
  if (!date) return 'Just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function MemberAvatar({
  photoUrl,
  name,
  sizeClass = 'w-9 h-9',
}: {
  photoUrl?: string | null;
  name: string;
  sizeClass?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const initial = (name || 'M').trim().charAt(0).toUpperCase() || 'M';

  if (photoUrl && !imgFailed) {
    return (
      <img
        src={photoUrl}
        alt={name}
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        className={`${sizeClass} rounded-full object-cover border border-zinc-700 shrink-0`}
      />
    );
  }

  return (
    <div
      aria-label={name}
      className={`${sizeClass} rounded-full bg-zinc-800 border border-zinc-700 text-zinc-200 font-semibold flex items-center justify-center text-xs shrink-0`}
    >
      {initial}
    </div>
  );
}

interface QuestionThreadProps {
  question: CrQuestion;
  currentUserId: string;
  onActionError: (msg: string) => void;
}

function QuestionThread({ question, currentUserId, onActionError }: QuestionThreadProps) {
  const [replies, setReplies] = useState<CrReply[]>([]);
  const [repliesLoading, setRepliesLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [submittingReply, setSubmittingReply] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setRepliesLoading(true);
    const unsub = subscribeCrReplies(
      question.id,
      (items) => {
        setReplies(items);
        setRepliesLoading(false);
      },
      (err) => {
        setRepliesLoading(false);
        onActionError(err.message);
      }
    );
    return () => unsub();
  }, [question.id, onActionError]);

  const handleToggleStatus = async () => {
    setTogglingStatus(true);
    try {
      await toggleCrQuestionStatus(question.id, question.status);
    } catch (err: any) {
      onActionError(err?.message || 'Unable to update question status.');
    } finally {
      setTogglingStatus(false);
    }
  };

  const handlePostReply = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = replyText.trim();
    if (!trimmed) return;
    setSubmittingReply(true);
    try {
      await createCrReply(question.id, trimmed);
      setReplyText('');
    } catch (err: any) {
      onActionError(err?.message || 'Unable to post reply.');
    } finally {
      setSubmittingReply(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteCrQuestion(question.id);
    } catch (err: any) {
      onActionError(err?.message || 'Unable to delete question.');
      setDeleting(false);
    }
  };

  const isResolved = question.status === 'Resolved';
  const isAuthor = question.authorId === currentUserId;

  return (
    <article className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <MemberAvatar photoUrl={question.authorPhoto} name={question.authorName} />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-zinc-100 leading-snug break-words">
              {question.subject}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400">
              <span className="text-cyan-400 font-medium">{question.category}</span>
              <span aria-hidden="true">·</span>
              <span className="text-zinc-300">{question.authorName}</span>
              {question.authorEmail && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-zinc-500 truncate max-w-[220px]">{question.authorEmail}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-zinc-500">
                {formatRelativeTimestamp(question.createdAt)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-medium ${
              isResolved ? 'text-emerald-400' : 'text-amber-400'
            }`}
          >
            {isResolved ? <CheckCircle2 size={14} /> : <CircleDot size={14} />}
            <span>{question.status}</span>
          </span>

          <button
            type="button"
            onClick={handleToggleStatus}
            disabled={togglingStatus}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-700 bg-zinc-950 hover:bg-zinc-800 text-zinc-200 transition whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {togglingStatus ? 'Updating...' : isResolved ? 'Reopen' : 'Mark Resolved'}
          </button>

          {isAuthor && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              title="Delete your question"
              aria-label="Delete your question"
              className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-950 rounded-lg border border-transparent hover:border-zinc-800 transition cursor-pointer disabled:opacity-40"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-words font-sans pl-12">
        {question.details}
      </p>

      {/* Replies Section separated by hairline divider (no nested cards) */}
      <div className="border-t border-zinc-800/80 pt-3 pl-12 flex flex-col gap-3">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span className="font-medium text-zinc-300 flex items-center gap-1.5">
            <MessageSquare size={13} className="text-zinc-500" />
            <span className="tabular-nums">
              {repliesLoading ? 'Loading replies...' : `${replies.length} ${replies.length === 1 ? 'Reply' : 'Replies'}`}
            </span>
          </span>
        </div>

        {replies.length > 0 && (
          <div className="flex flex-col divide-y divide-zinc-800/60">
            {replies.map((reply) => (
              <div key={reply.id} className="py-2.5 first:pt-0 last:pb-0 flex items-start gap-2.5">
                <MemberAvatar
                  photoUrl={reply.authorPhoto}
                  name={reply.authorName}
                  sizeClass="w-7 h-7"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
                    <span className="font-medium text-zinc-200">{reply.authorName}</span>
                    {reply.authorEmail && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-zinc-500 truncate max-w-[200px]">{reply.authorEmail}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-zinc-500">
                      {formatRelativeTimestamp(reply.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-words font-sans">
                    {reply.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handlePostReply} className="flex items-center gap-2 pt-1">
          <input
            type="text"
            value={replyText}
            maxLength={CR_LIMITS.REPLY_MAX}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Write a reply..."
            className="flex-1 bg-zinc-950 border border-zinc-800 focus:border-cyan-500 rounded-lg px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none font-sans"
          />
          <button
            type="submit"
            disabled={submittingReply || !replyText.trim()}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white rounded-lg text-xs font-medium transition flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Send size={12} />
            <span>{submittingReply ? 'Sending...' : 'Reply'}</span>
          </button>
        </form>
      </div>
    </article>
  );
}

class HubErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorMsg: string }
> {
  declare state: { hasError: boolean; errorMsg: string };
  declare props: { children: React.ReactNode };
  declare setState: (next: { hasError: boolean; errorMsg: string }) => void;

  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMsg: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMsg: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="max-w-3xl mx-auto mt-10 bg-zinc-900 border border-red-800/60 rounded-xl p-6 text-zinc-200 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-red-400 font-semibold text-sm">
            <AlertCircle size={18} />
            <span>Community Hub Encountered an Error</span>
          </div>
          <p className="text-xs text-zinc-400 font-mono break-all">{this.state.errorMsg}</p>
          <div>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, errorMsg: '' })}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-lg text-xs font-medium cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ChiptuneRevolutionsHubInner() {
  const [user, setUser] = useState<User | null>(() => auth.currentUser);
  const [authReady, setAuthReady] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [questions, setQuestions] = useState<CrQuestion[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [firestoreError, setFirestoreError] = useState<string | null>(null);

  // Ask a Question form
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const [category, setCategory] = useState<CrQuestionCategory>('MIDI');
  const [submittingQuestion, setSubmittingQuestion] = useState(false);

  // Feed filter
  const [categoryFilter, setCategoryFilter] = useState<'All' | CrQuestionCategory>('All');
  const [statusFilter, setStatusFilter] = useState<'All' | 'Open' | 'Resolved'>('All');

  // Google Group iframe toggle
  const [showGoogleGroup, setShowGoogleGroup] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
      if (!currentUser) {
        setQuestions([]);
        setShowGoogleGroup(false);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || !user) return;
    setQuestionsLoading(true);
    setFirestoreError(null);

    const unsub = subscribeCrQuestions(
      (items) => {
        setQuestions(items);
        setQuestionsLoading(false);
      },
      (err) => {
        setQuestionsLoading(false);
        setFirestoreError(err.message);
      }
    );

    return () => unsub();
  }, [authReady, user]);

  const handleSignIn = async () => {
    setIsSigningIn(true);
    setAuthError(null);
    try {
      const signedIn = await signInWithGoogle();
      setUser(signedIn);
    } catch (err: any) {
      if (err?.code !== 'auth/popup-closed-by-user') {
        setAuthError(err?.message || 'Google Sign-In failed. Please try again.');
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    setAuthError(null);
    try {
      await signOutUser();
    } catch (err: any) {
      setAuthError(err?.message || 'Sign out failed.');
    }
  };

  const handleSubmitQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    setFirestoreError(null);
    setSubmittingQuestion(true);
    try {
      await createCrQuestion({ subject, details, category });
      setSubject('');
      setDetails('');
    } catch (err: any) {
      setFirestoreError(err?.message || 'Failed to submit question.');
    } finally {
      setSubmittingQuestion(false);
    }
  };

  const filteredQuestions = useMemo(() => {
    return questions.filter((q) => {
      if (categoryFilter !== 'All' && q.category !== categoryFilter) return false;
      if (statusFilter !== 'All' && q.status !== statusFilter) return false;
      return true;
    });
  }, [questions, categoryFilter, statusFilter]);

  if (!authReady) {
    return (
      <div className="max-w-5xl mx-auto py-16 flex items-center justify-center gap-2 text-xs text-zinc-400">
        <RefreshCw size={15} className="animate-spin text-cyan-400" />
        <span>Checking Firebase authentication...</span>
      </div>
    );
  }

  // 1. FIREBASE LOGIN GATE (Hide all community features until signed in)
  if (!user) {
    return (
      <div className="max-w-2xl mx-auto my-12 bg-zinc-900/80 border border-zinc-800 rounded-xl p-8 flex flex-col items-center text-center gap-5">
        <div className="w-12 h-12 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-center text-cyan-400">
          <Users size={24} />
        </div>

        <div className="space-y-2 max-w-md">
          <h2 className="text-xl font-bold text-zinc-100 tracking-tight">
            Chiptune Revolutions (CR)
          </h2>
          <p className="text-sm text-zinc-300 leading-relaxed font-sans">
            Sign in with your Google account to ask questions and join Chiptune Revolutions (CR)
          </p>
        </div>

        {authError && (
          <div className="w-full max-w-md px-4 py-2.5 rounded-lg bg-red-950/60 border border-red-800/60 text-xs text-red-300 flex items-center gap-2 text-left">
            <AlertCircle size={15} className="shrink-0" />
            <span>{authError}</span>
          </div>
        )}

        <button
          id="cr-google-signin-btn"
          type="button"
          onClick={handleSignIn}
          disabled={isSigningIn}
          className="px-5 py-2.5 bg-white hover:bg-zinc-100 text-zinc-900 rounded-lg text-sm font-semibold transition flex items-center gap-2.5 shadow cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
        >
          {isSigningIn ? (
            <RefreshCw size={16} className="animate-spin text-zinc-700" />
          ) : (
            <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
          )}
          <span>Sign in with Google</span>
        </button>
      </div>
    );
  }

  // SIGNED-IN COMMUNITY HUB
  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-6 pb-8">
      {/* Member Identity Header & Google Group Toggle */}
      <section className="bg-zinc-900/75 border border-zinc-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5 min-w-0">
          <MemberAvatar
            photoUrl={user.photoURL}
            name={user.displayName || user.email || 'CR Member'}
            sizeClass="w-11 h-11"
          />
          <div className="min-w-0">
            <h2 className="text-base font-bold text-zinc-100 tracking-tight truncate">
              Chiptune Revolutions (CR) Community Hub
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
              <span className="font-medium text-zinc-200">{user.displayName || 'CR Member'}</span>
              {user.email && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{user.email}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            id="cr-toggle-google-group-btn"
            type="button"
            onClick={() => setShowGoogleGroup((prev) => !prev)}
            aria-expanded={showGoogleGroup}
            className={`px-4 py-2 rounded-lg text-xs font-medium border transition whitespace-nowrap shrink-0 cursor-pointer ${
              showGoogleGroup
                ? 'bg-cyan-600 border-cyan-500 text-white'
                : 'bg-zinc-950 hover:bg-zinc-800 border-zinc-700 text-zinc-100'
            }`}
          >
            {showGoogleGroup ? 'Close Google Group' : 'Open Google Group'}
          </button>

          <button
            id="cr-signout-btn"
            type="button"
            onClick={handleSignOut}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-zinc-950 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 transition flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut size={13} />
            <span>Sign Out</span>
          </button>
        </div>
      </section>

      {/* 4. Shared Music Folders Bar */}
      <section
        aria-label="Shared Music Folders"
        className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3"
      >
        <div>
          <h3 className="text-xs font-semibold text-zinc-200">Shared Music Folders</h3>
          <p className="text-xs text-zinc-400 font-sans mt-0.5">
            Browse and exchange community tracker modules, chiptunes, and MIDI archives on Google Drive.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <a
            href={DRIVE_MOD_CHIPTUNE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg bg-zinc-950 hover:bg-zinc-800 border border-zinc-700 hover:border-cyan-500/60 text-xs font-medium text-cyan-300 transition inline-flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <FolderOpen size={14} />
            <span>Amiga .MOD &amp; Chiptune Exchanging</span>
            <ExternalLink size={12} className="text-zinc-500" />
          </a>

          <a
            href={DRIVE_MIDI_OTHER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg bg-zinc-950 hover:bg-zinc-800 border border-zinc-700 hover:border-emerald-500/60 text-xs font-medium text-emerald-300 transition inline-flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <FolderOpen size={14} />
            <span>MIDI and Other music types</span>
            <ExternalLink size={12} className="text-zinc-500" />
          </a>
        </div>
      </section>

      {/* 3. Direct Google Group Iframe View */}
      {showGoogleGroup && (
        <section className="bg-zinc-900/75 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-100">
              Chiptune Revolutions (CR) Google Group
            </h3>
            <a
              href={GOOGLE_GROUP_DIRECT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-cyan-400 hover:text-cyan-300 hover:underline inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <span>Open Google Group directly in new tab</span>
              <ExternalLink size={12} />
            </a>
          </div>
          <p className="text-xs text-zinc-400 font-sans">
            If your browser blocks third-party cookies inside embedded frames, use the direct link above to view and post in the group.
          </p>
          <div className="w-full overflow-hidden rounded-lg border border-zinc-800 bg-white">
            <iframe
              title="Chiptune Revolutions (CR) Google Group"
              src={GOOGLE_GROUP_EMBED_URL}
              width="100%"
              height="700"
              className="w-full block border-0"
            />
          </div>
        </section>
      )}

      {/* Firestore Error Alert */}
      {firestoreError && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
            <span className="break-words">{firestoreError}</span>
          </div>
          <button
            type="button"
            onClick={() => setFirestoreError(null)}
            className="text-xs text-red-300 hover:text-white shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 2. Real-Time Questions Engine */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Ask a Question Form */}
        <section className="lg:col-span-4 bg-zinc-900/70 border border-zinc-800 rounded-xl p-5 flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Ask a Question</h3>
            <p className="text-xs text-zinc-400 font-sans mt-1">
              Questions sync live with all signed-in CR members.
            </p>
          </div>

          <form onSubmit={handleSubmitQuestion} className="flex flex-col gap-3.5">
            <div>
              <label
                htmlFor="cr-question-subject"
                className="block text-xs font-medium text-zinc-300 mb-1.5"
              >
                Subject
              </label>
              <input
                id="cr-question-subject"
                type="text"
                required
                minLength={CR_LIMITS.SUBJECT_MIN}
                maxLength={CR_LIMITS.SUBJECT_MAX}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Amiga .MOD panning on channels 1–4"
                className="w-full bg-zinc-950 border border-zinc-800 focus:border-cyan-500 rounded-lg px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none font-sans"
              />
            </div>

            <div>
              <span className="block text-xs font-medium text-zinc-300 mb-1.5">Category</span>
              <div className="flex flex-wrap gap-1.5">
                {CR_CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategory(cat)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition whitespace-nowrap shrink-0 cursor-pointer ${
                      category === cat
                        ? 'bg-cyan-600 border-cyan-500 text-white'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="cr-question-details"
                className="block text-xs font-medium text-zinc-300 mb-1.5"
              >
                Question Details
              </label>
              <textarea
                id="cr-question-details"
                required
                rows={5}
                minLength={CR_LIMITS.DETAILS_MIN}
                maxLength={CR_LIMITS.DETAILS_MAX}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="Describe what you're building, soundfont or module format, and what you'd like help with..."
                className="w-full bg-zinc-950 border border-zinc-800 focus:border-cyan-500 rounded-lg px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none font-sans resize-y"
              />
            </div>

            <button
              id="cr-submit-question-btn"
              type="submit"
              disabled={submittingQuestion}
              className="w-full py-2.5 px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white rounded-lg text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
            >
              <Send size={13} />
              <span>{submittingQuestion ? 'Posting Question...' : 'Post Question Live'}</span>
            </button>
          </form>
        </section>

        {/* Live Questions Feed */}
        <section className="lg:col-span-8 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-zinc-900/60 border border-zinc-800 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-100">
              <span>Live Questions</span>
              <span className="text-zinc-400 font-mono tabular-nums">
                ({filteredQuestions.length})
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 p-1 bg-zinc-950 border border-zinc-800 rounded-lg">
                {(['All', ...CR_CATEGORIES] as const).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategoryFilter(cat)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition whitespace-nowrap shrink-0 cursor-pointer ${
                      categoryFilter === cat
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1 p-1 bg-zinc-950 border border-zinc-800 rounded-lg">
                {(['All', 'Open', 'Resolved'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition whitespace-nowrap shrink-0 cursor-pointer ${
                      statusFilter === st
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {questionsLoading ? (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8 flex items-center justify-center gap-2 text-xs text-zinc-400">
              <RefreshCw size={15} className="animate-spin text-cyan-400" />
              <span>Loading real-time CR feed...</span>
            </div>
          ) : filteredQuestions.length === 0 ? (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-10 text-center flex flex-col items-center gap-2">
              <MessageSquare size={24} className="text-zinc-600" />
              <p className="text-sm font-medium text-zinc-200">No questions match this view yet</p>
              <p className="text-xs text-zinc-400 font-sans max-w-sm">
                Use the Ask a Question form to start the first live thread for Chiptune Revolutions (CR).
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {filteredQuestions.map((q) => (
                <div key={q.id}>
                  <QuestionThread
                    question={q}
                    currentUserId={user.uid}
                    onActionError={(msg) => setFirestoreError(msg)}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function ChiptuneRevolutionsHub() {
  return (
    <HubErrorBoundary>
      <ChiptuneRevolutionsHubInner />
    </HubErrorBoundary>
  );
}
