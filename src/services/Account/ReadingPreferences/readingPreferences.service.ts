import type { ReadingPreferences } from '@/features/Journal/readingTypes';
import { firestoreSdk } from '../../Firebase/firebaseSdk';
import { isJournalLocked, profileDatabaseFor, trackProfileWrite } from '../account.service';

const profileFor = async (uid: string) => {
  const database = await profileDatabaseFor(uid);
  if (isJournalLocked(uid)) throw new Error('Unlock your account to change reading preferences.');
  return firestoreSdk().doc(database, 'users', uid);
};

export const observeReadingPreferences = (
  uid: string,
  onChange: (preferences: ReadingPreferences) => void,
  onError: (error: Error) => void,
) => {
  let cancelled = false;
  let unsubscribe: (() => void) | undefined;
  const active = () => !cancelled && !isJournalLocked(uid);
  const reportError = (error: Error) => {
    if (active()) onError(error);
  };
  void profileFor(uid)
    .then((profile) => {
      if (!active()) return;
      unsubscribe = firestoreSdk().onSnapshot(
        profile,
        (snapshot) => {
          if (!active()) return;
          const preferences = snapshot.data()?.readingPreferences;
          onChange({
            reversals: preferences?.reversals === true,
            instantReveal: preferences?.instantReveal === true,
          });
        },
        reportError,
      );
    })
    .catch(reportError);
  return () => {
    cancelled = true;
    try {
      unsubscribe?.();
    } catch {
      // A failed offline cache can reject cleanup. The listener is already gated.
    }
  };
};

export const saveReadingPreference = (
  uid: string,
  key: keyof ReadingPreferences,
  value: boolean,
): Promise<void> =>
  trackProfileWrite(
    uid,
    profileFor(uid).then((profile) =>
      firestoreSdk().setDoc(profile, { readingPreferences: { [key]: value } }, { merge: true }),
    ),
  );
