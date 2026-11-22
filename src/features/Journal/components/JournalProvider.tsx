'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { observeAccount, type JournalUser } from '@/services/Account/account.service';
import { IncompleteSignOut, LockedJournal } from '@/features/Account/components/LockedJournal';
import { JournalContext } from '../hooks/useJournalSession';
import type { GuestDraft } from '../features/GuestJournal/utils/guestDraft';
import { useJournalController, type JournalSessionProps } from '../hooks/useJournalController';

const JournalProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<JournalUser | null | undefined>(undefined);
  const guestDraft = useRef<GuestDraft | null>(null);
  useEffect(() => observeAccount(setUser), []);
  if (user?.signOutIncomplete) return <IncompleteSignOut uid={user.uid} />;
  const journalUid = user?.emailVerified ? user.uid : undefined;
  return (
    <JournalSession
      key={user === undefined ? 'opening' : journalUid ? `account:${journalUid}` : 'guest'}
      user={user}
      journalUid={journalUid}
      guestDraft={guestDraft}
    >
      {children}
    </JournalSession>
  );
};

export default JournalProvider;

const JournalSession = ({ children, ...props }: JournalSessionProps & { children: ReactNode }) => {
  const session = useJournalController(props);
  const { user, locked, account, lockScope } = session;
  if (user && locked) {
    return (
      <LockedJournal
        key={user.uid}
        uid={user.uid}
        hasFailedWrites={account.hasFailedWrites}
        saving={account.saving}
        needsOpenTab={account.needsOpenTab}
        tabOnly={lockScope === 'tab'}
      />
    );
  }

  return <JournalContext.Provider value={session}>{children}</JournalContext.Provider>;
};
