import { useMemo, useSyncExternalStore } from 'react';
import type { ReadingPreferences } from '@/features/Journal/readingTypes';
import { defaultReadingPreferences } from '@/features/Journal/utils/journalData';
import {
  observeReadingPreferences,
  saveReadingPreference,
} from '@/services/Account/ReadingPreferences/readingPreferences.service';

type PreferenceKey = keyof ReadingPreferences;
type PreferenceEdit = { value: boolean; error: string; observed: boolean };

const accessDenied = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'permission-denied';

const createPreferenceSession = (uid?: string) => {
  let saved = defaultReadingPreferences;
  let view = { preferences: saved, ready: false, warning: '' };
  let readError = '';
  let notify: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  const edits = new Map<PreferenceKey, PreferenceEdit>();

  const refresh = () => {
    const preferences = { ...saved };
    let writeError = '';
    for (const [key, edit] of edits) {
      preferences[key] = edit.value;
      writeError ||= edit.error;
    }
    view = { preferences, ready: true, warning: writeError || readError };
    notify?.();
  };
  const observe = () => {
    if (!uid) return;
    unsubscribe?.();
    let active = true;
    const stop = observeReadingPreferences(
      uid,
      (snapshot) => {
        if (!active) return;
        saved = snapshot;
        for (const [key, edit] of edits) {
          if (snapshot[key] === edit.value) edit.observed = true;
        }
        readError = '';
        refresh();
      },
      (error) => {
        if (!active) return;
        readError = accessDenied(error)
          ? 'Firebase denied access to your saved reading preferences. You can still choose settings for this tab.'
          : 'Your saved reading preferences could not be loaded. You can still choose settings for this tab.';
        refresh();
      },
    );
    unsubscribe = () => {
      active = false;
      stop();
    };
  };
  const subscribe = (onChange: () => void) => {
    notify = onChange;
    observe();
    return () => {
      notify = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
    };
  };
  const update = async (key: PreferenceKey, value: boolean) => {
    if (!uid || !notify || !view.ready) return;
    const edit: PreferenceEdit = { value, error: '', observed: false };
    edits.set(key, edit);
    refresh();
    try {
      await saveReadingPreference(uid, key, value);
      if (edits.get(key) !== edit) return;
      // After the listener echoes a write, a subsequent snapshot can already
      // contain another device's newer choice.
      if (!edit.observed) saved = { ...saved, [key]: value };
      edits.delete(key);
    } catch (error) {
      if (edits.get(key) !== edit) return;
      edit.error = accessDenied(error)
        ? 'Firebase denied permission to save your preferences. Your choices still apply in this tab.'
        : 'Your preferences could not be saved to your account. Your choices still apply in this tab.';
    }
    refresh();
  };
  const retry = () => {
    if (!notify) return;
    if (readError) {
      readError = '';
      observe();
      refresh();
    }
    for (const [key, edit] of edits) {
      if (edit.error) void update(key, edit.value);
    }
  };
  return { subscribe, getSnapshot: () => view, update, retry };
};

export const useReadingPreferences = (uid?: string) => {
  const session = useMemo(() => createPreferenceSession(uid), [uid]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return {
    ...view,
    getPreferences: () => session.getSnapshot().preferences,
    update: session.update,
    retry: session.retry,
  };
};
