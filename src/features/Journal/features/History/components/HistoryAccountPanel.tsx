'use client';

import { AccountPanel } from '@/features/Account/components/AccountPanel';
import { lockJournal } from '@/services/Account/account.service';
import { useJournalSession } from '@/features/Journal/hooks/useJournalSession';

export const HistoryAccountPanel = () => {
  const { user, journalUid, account } = useJournalSession();
  if (user === undefined) return null;
  return (
    <AccountPanel
      key={user?.uid ?? 'signed-out'}
      user={user}
      syncStatus={account.status}
      signOutDisabled={account.pending}
      onLock={account.trusted && journalUid ? () => lockJournal(journalUid) : undefined}
    />
  );
};
