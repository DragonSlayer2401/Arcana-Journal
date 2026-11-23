import type { Reading, ReadingPreferences, Settings } from '../readingTypes';

export const defaultReadingPreferences: ReadingPreferences = {
  reversals: false,
  instantReveal: false,
};

export interface AppData {
  version: 1;
  settings: Settings;
  readings: Reading[];
  activeId: string | null;
  awaitingNewReading: boolean;
}
export const freshData = (): AppData => ({
  version: 1,
  settings: { mode: 'three', customCount: 5, ...defaultReadingPreferences },
  readings: [],
  activeId: null,
  awaitingNewReading: false,
});
export const readSettings = (value: unknown): Settings | null => {
  const settings = value as Settings | null;
  if (
    !settings ||
    !['one', 'three', 'custom'].includes(settings.mode) ||
    !Number.isInteger(settings.customCount) ||
    settings.customCount < 1 ||
    settings.customCount > 10 ||
    typeof settings.reversals !== 'boolean'
  ) {
    return null;
  }
  return { ...settings, instantReveal: settings.instantReveal === true };
};
