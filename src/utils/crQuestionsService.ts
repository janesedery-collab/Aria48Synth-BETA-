import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';

export const CR_CATEGORIES = ['MIDI', 'Amiga .MOD', 'Oscilloscope', 'General'] as const;
export type CrQuestionCategory = (typeof CR_CATEGORIES)[number];
export type CrQuestionStatus = 'Open' | 'Resolved';

export const CR_LIMITS = {
  SUBJECT_MIN: 3,
  SUBJECT_MAX: 160,
  DETAILS_MIN: 3,
  DETAILS_MAX: 4000,
  REPLY_MIN: 1,
  REPLY_MAX: 2000,
  NAME_MAX: 100,
  PHOTO_MAX: 1024,
  EMAIL_MAX: 256,
} as const;

export interface CrQuestion {
  id: string;
  subject: string;
  details: string;
  category: CrQuestionCategory;
  status: CrQuestionStatus;
  authorId: string;
  authorName: string;
  authorPhoto: string;
  authorEmail: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface CrReply {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  authorPhoto: string;
  authorEmail: string;
  createdAt: Date | null;
}

function toDateOrNull(val: unknown): Date | null {
  if (val instanceof Timestamp) return val.toDate();
  if (val && typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate();
  }
  if (typeof val === 'string' || typeof val === 'number') {
    const parsed = new Date(val);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function sanitizeCategory(raw: unknown): CrQuestionCategory {
  if (typeof raw === 'string' && (CR_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as CrQuestionCategory;
  }
  return 'General';
}

export function subscribeCrQuestions(
  onData: (questions: CrQuestion[]) => void,
  onError: (err: Error) => void
): () => void {
  const colRef = collection(db, 'cr_questions');
  const q = query(colRef, orderBy('createdAt', 'desc'));

  return onSnapshot(
    q,
    (snapshot) => {
      const items: CrQuestion[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          subject: String(data.subject || ''),
          details: String(data.details || ''),
          category: sanitizeCategory(data.category),
          status: data.status === 'Resolved' ? 'Resolved' : 'Open',
          authorId: String(data.authorId || ''),
          authorName: String(data.authorName || 'CR Member'),
          authorPhoto: String(data.authorPhoto || ''),
          authorEmail: String(data.authorEmail || ''),
          createdAt: toDateOrNull(data.createdAt),
          updatedAt: toDateOrNull(data.updatedAt),
        };
      });
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'cr_questions');
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export function subscribeCrReplies(
  questionId: string,
  onData: (replies: CrReply[]) => void,
  onError: (err: Error) => void
): () => void {
  const path = `cr_questions/${questionId}/replies`;
  const repliesRef = collection(db, 'cr_questions', questionId, 'replies');
  const q = query(repliesRef, orderBy('createdAt', 'asc'));

  return onSnapshot(
    q,
    (snapshot) => {
      const items: CrReply[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          body: String(data.body || ''),
          authorId: String(data.authorId || ''),
          authorName: String(data.authorName || 'CR Member'),
          authorPhoto: String(data.authorPhoto || ''),
          authorEmail: String(data.authorEmail || ''),
          createdAt: toDateOrNull(data.createdAt),
        };
      });
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function createCrQuestion(params: {
  subject: string;
  details: string;
  category: CrQuestionCategory;
}): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Sign in with your Google account to ask a question.');
  }

  const subject = params.subject.trim().slice(0, CR_LIMITS.SUBJECT_MAX);
  const details = params.details.trim().slice(0, CR_LIMITS.DETAILS_MAX);
  if (subject.length < CR_LIMITS.SUBJECT_MIN) {
    throw new Error(`Subject must be at least ${CR_LIMITS.SUBJECT_MIN} characters.`);
  }
  if (details.length < CR_LIMITS.DETAILS_MIN) {
    throw new Error(`Question details must be at least ${CR_LIMITS.DETAILS_MIN} characters.`);
  }

  const category = sanitizeCategory(params.category);
  const authorName = (user.displayName || user.email || 'CR Member').slice(0, CR_LIMITS.NAME_MAX);
  const authorPhoto = (user.photoURL || '').slice(0, CR_LIMITS.PHOTO_MAX);
  const authorEmail = (user.email || '').slice(0, CR_LIMITS.EMAIL_MAX);

  try {
    const ref = await addDoc(collection(db, 'cr_questions'), {
      subject,
      details,
      category,
      status: 'Open' as CrQuestionStatus,
      authorId: user.uid,
      authorName,
      authorPhoto,
      authorEmail,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, 'cr_questions');
  }
}

export async function createCrReply(questionId: string, rawBody: string): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Sign in with your Google account to post a reply.');
  }

  const body = rawBody.trim().slice(0, CR_LIMITS.REPLY_MAX);
  if (body.length < CR_LIMITS.REPLY_MIN) {
    throw new Error('Reply cannot be empty.');
  }

  const path = `cr_questions/${questionId}/replies`;
  const authorName = (user.displayName || user.email || 'CR Member').slice(0, CR_LIMITS.NAME_MAX);
  const authorPhoto = (user.photoURL || '').slice(0, CR_LIMITS.PHOTO_MAX);
  const authorEmail = (user.email || '').slice(0, CR_LIMITS.EMAIL_MAX);

  try {
    const ref = await addDoc(collection(db, 'cr_questions', questionId, 'replies'), {
      body,
      authorId: user.uid,
      authorName,
      authorPhoto,
      authorEmail,
      createdAt: serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function toggleCrQuestionStatus(
  questionId: string,
  currentStatus: CrQuestionStatus
): Promise<CrQuestionStatus> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Sign in with your Google account to update question status.');
  }

  const nextStatus: CrQuestionStatus = currentStatus === 'Open' ? 'Resolved' : 'Open';
  const path = `cr_questions/${questionId}`;
  try {
    await updateDoc(doc(db, 'cr_questions', questionId), {
      status: nextStatus,
      updatedAt: serverTimestamp(),
    });
    return nextStatus;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteCrQuestion(questionId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Sign in with your Google account to delete a question.');
  }
  const path = `cr_questions/${questionId}`;
  try {
    await deleteDoc(doc(db, 'cr_questions', questionId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
