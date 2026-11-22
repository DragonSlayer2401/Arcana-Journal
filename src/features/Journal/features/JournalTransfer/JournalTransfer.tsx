'use client';

import { JournalTransferControls } from './components/JournalTransferControls';
import { useJournalTransfer } from './hooks/useJournalTransfer';

export const JournalTransfer = () => {
  const transfer = useJournalTransfer();
  return transfer && <JournalTransferControls {...transfer} />;
};
