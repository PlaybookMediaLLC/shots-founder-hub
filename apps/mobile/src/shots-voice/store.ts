import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

import { captureOperationalError } from "@/lib/error-reporting";

import type { VoicePassResult } from "./engine";
import { parseStoredVoiceNote, type VoiceNoteState } from "./model";

// App-local Shots voice state on this device only, never in the canonical
// SQLite schema or CloudSync: the account's choices, and one queue per
// account and workspace so one account's work is never sent under another's
// session (plan 5.1).
// shortcut: each change rewrites the queue's JSON; fine for the plan's few
// thousand notes per person, move to SQLite-backed app storage beyond that.

export type ShotsVoicePrefs = {
  workspaceId: string | null;
  workspaceName: string | null;
  sendNew: boolean;
  uploadAudio: boolean;
};

type Snapshot = {
  accountId: string | null;
  ready: boolean;
  prefs: ShotsVoicePrefs;
  notes: VoiceNoteState[];
  status: VoicePassResult | null;
};

const DEFAULT_PREFS: ShotsVoicePrefs = {
  workspaceId: null,
  workspaceName: null,
  sendNew: false,
  uploadAudio: false,
};
const EMPTY: Snapshot = {
  accountId: null,
  ready: false,
  prefs: DEFAULT_PREFS,
  notes: [],
  status: null,
};
const prefsKey = (accountId: string) => `anarlog:shots-voice:${accountId}`;
const queueKey = (accountId: string, workspaceId: string) =>
  `anarlog:shots-voice:${accountId}:${workspaceId}`;

let snapshot = EMPTY;
const listeners = new Set<() => void>();
let chain: Promise<void> = Promise.resolve();

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

// Store changes run one at a time, so a queue is never read while it is written.
function serially(task: () => Promise<void>): Promise<void> {
  const run = chain.catch(() => {}).then(task);
  chain = run;
  return run;
}

export function getShotsVoice(): Snapshot {
  return snapshot;
}

export function subscribeShotsVoice(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useShotsVoice(): Snapshot {
  return useSyncExternalStore(
    subscribeShotsVoice,
    getShotsVoice,
    getShotsVoice,
  );
}

export function whenShotsVoiceReady(): Promise<void> {
  return chain.catch(() => {});
}

async function readJson(key: string): Promise<unknown> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    captureOperationalError(error, {
      operation: "shots_voice_store_read",
      level: "warning",
    });
    return null;
  }
}

async function readQueue(accountId: string, workspaceId: string | null) {
  if (!workspaceId) return [];
  const value = (await readJson(queueKey(accountId, workspaceId))) as {
    notes?: unknown;
  } | null;
  if (!Array.isArray(value?.notes)) return [];
  return value.notes.flatMap((note: unknown) => {
    const parsed = parseStoredVoiceNote(note);
    return parsed ? [parsed] : [];
  });
}

/** Loads the signed-in account's choices and queue; null clears them from memory (the queue stays on disk). */
export function activateShotsVoice(accountId: string | null): Promise<void> {
  return serially(async () => {
    if (!accountId) {
      publish(EMPTY);
      return;
    }
    const stored = (await readJson(
      prefsKey(accountId),
    )) as Partial<ShotsVoicePrefs> | null;
    const prefs: ShotsVoicePrefs = {
      workspaceId:
        typeof stored?.workspaceId === "string" ? stored.workspaceId : null,
      workspaceName:
        typeof stored?.workspaceName === "string" ? stored.workspaceName : null,
      sendNew: stored?.sendNew === true,
      uploadAudio: stored?.uploadAudio === true,
    };
    publish({
      accountId,
      ready: true,
      prefs,
      notes: await readQueue(accountId, prefs.workspaceId),
      status: null,
    });
  });
}

export function setShotsVoicePrefs(
  patch: Partial<ShotsVoicePrefs>,
): Promise<void> {
  return serially(async () => {
    const { accountId } = snapshot;
    if (!accountId) throw new Error("Sign in to Shots to change this.");
    const prefs = { ...snapshot.prefs, ...patch };
    await AsyncStorage.setItem(prefsKey(accountId), JSON.stringify(prefs));
    const moved = prefs.workspaceId !== snapshot.prefs.workspaceId;
    publish({
      ...snapshot,
      prefs,
      notes: moved
        ? await readQueue(accountId, prefs.workspaceId)
        : snapshot.notes,
      status: moved ? null : snapshot.status,
    });
  });
}

function writeQueue(
  accountId: string,
  workspaceId: string,
  change: (notes: VoiceNoteState[]) => VoiceNoteState[],
): Promise<void> {
  return serially(async () => {
    // A pass for a queue that is no longer active writes nothing; its work replays.
    if (
      snapshot.accountId !== accountId ||
      snapshot.prefs.workspaceId !== workspaceId
    )
      return;
    const notes = change(snapshot.notes);
    publish({ ...snapshot, notes });
    await AsyncStorage.setItem(
      queueKey(accountId, workspaceId),
      JSON.stringify({ notes }),
    );
  });
}

export function saveShotsVoiceNote(
  accountId: string,
  workspaceId: string,
  note: VoiceNoteState,
): Promise<void> {
  return writeQueue(accountId, workspaceId, (notes) =>
    notes.some((item) => item.sessionId === note.sessionId)
      ? notes.map((item) => (item.sessionId === note.sessionId ? note : item))
      : [...notes, note],
  );
}

export function removeShotsVoiceNote(
  accountId: string,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  return writeQueue(accountId, workspaceId, (notes) =>
    notes.filter((note) => note.sessionId !== sessionId),
  );
}

/** Clears refusals and waits so every note is tried on the next pass. */
export function retryShotsVoiceNotes(): Promise<void> {
  const { accountId, prefs } = snapshot;
  if (!accountId || !prefs.workspaceId) return Promise.resolve();
  return writeQueue(accountId, prefs.workspaceId, (notes) =>
    notes.map((note) => ({
      ...note,
      failed: null,
      blocked: null,
      attempts: 0,
      nextAttemptAt: 0,
    })),
  );
}

export function setShotsVoiceStatus(
  accountId: string,
  workspaceId: string,
  status: VoicePassResult,
) {
  if (
    snapshot.accountId === accountId &&
    snapshot.prefs.workspaceId === workspaceId
  )
    publish({ ...snapshot, status });
}
