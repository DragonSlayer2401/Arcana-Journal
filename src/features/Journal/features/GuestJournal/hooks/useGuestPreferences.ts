import { useEffect, useRef, useState } from 'react';
import type { ReadingPreferences } from '@/features/Journal/readingTypes';
import { defaultReadingPreferences } from '@/features/Journal/utils/journalData';
import { guestStorageKey, loadData } from '../utils/guestStorage';

type PreferenceKey = keyof ReadingPreferences;
const storageKey = (key: PreferenceKey) => `${guestStorageKey}.preferences.${key}`;
const readPreference = (key: PreferenceKey, fallback: boolean) => {
  try {
    const stored = localStorage.getItem(storageKey(key));
    return stored === 'true' || (stored !== 'false' && fallback);
  } catch {
    return fallback;
  }
};

export const useGuestPreferences = (isGuest: boolean, legacy: ReadingPreferences) => {
  const [preferences, setPreferences] = useState<ReadingPreferences>(() =>
    isGuest
      ? {
          reversals: readPreference('reversals', legacy.reversals),
          instantReveal: readPreference('instantReveal', legacy.instantReveal),
        }
      : defaultReadingPreferences,
  );
  const current = useRef(preferences);
  const unsaved = useRef(new Set<PreferenceKey>()).current;
  useEffect(() => {
    if (!isGuest) return;
    const onStorage = (event: StorageEvent) => {
      const keys = (['reversals', 'instantReveal'] as const).filter(
        (key) => event.key === null || event.key === storageKey(key),
      );
      if (!keys.length || event.storageArea !== localStorage) return;
      const fallback = loadData().data.settings;
      const next = { ...current.current };
      for (const key of keys) {
        next[key] = readPreference(key, fallback[key]);
        unsaved.delete(key);
      }
      current.current = next;
      setPreferences(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [isGuest, unsaved]);
  const updatePreference = (key: PreferenceKey, value: boolean) => {
    try {
      // Each switch can be saved before the next navigation, even while another tab writes a reading.
      localStorage.setItem(storageKey(key), String(value));
      unsaved.delete(key);
    } catch {
      unsaved.add(key);
    }
    current.current = { ...current.current, [key]: value };
    setPreferences(current.current);
  };
  return {
    preferences,
    getPreferences: () => current.current,
    updatePreference,
    preferenceWarning: unsaved.size
      ? 'This browser could not save your reading preferences. Your choices are available for this session.'
      : '',
  };
};
