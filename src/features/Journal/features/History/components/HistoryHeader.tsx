'use client';

import type { ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { useJournalSession } from '@/features/Journal/hooks/useJournalSession';

export const HistoryHeader = ({ heading }: { heading: ReactNode }) => {
  const { opening, journalUid, readings, requestClear, guestClearStatus } = useJournalSession();
  return (
    <>
      <div className="result-heading">
        <div>
          {!opening && (
            <p className="eyebrow">{journalUid ? 'ACCOUNT JOURNAL' : 'ON THIS DEVICE'}</p>
          )}
          {heading}
        </div>
        {!opening && (!journalUid || readings.length > 0) && (
          <button className="button button-secondary" onClick={requestClear}>
            <Icon name="trash" />
            Clear History
          </button>
        )}
      </div>
      {!journalUid && guestClearStatus && <p role="status">{guestClearStatus}</p>}
    </>
  );
};
