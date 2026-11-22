'use client';

import type { ReactNode } from 'react';
import { useJournalSession } from '../hooks/useJournalSession';
import { readingDateLabel } from '../utils/readingDate';
import { Modal } from '@/components/Modal';

export const JournalDialogs = ({ children }: { children: ReactNode }) => {
  const {
    updateAvailable,
    help,
    setHelp,
    confirmDelete,
    setConfirmDelete,
    journalUid,
    clearReview,
    clearReviewError,
    account,
    deleteReadings,
  } = useJournalSession();
  return (
    <>
      {updateAvailable && (
        <p className="update-note" role="status">
          An update is cached. It will be used after all Arcana Journal windows close. Your saved
          cards will stay the same.
        </p>
      )}

      {help && (
        <Modal title="About Arcana Journal" onClose={() => setHelp(false)}>
          {children}
        </Modal>
      )}
      {confirmDelete && (
        <Modal
          title={confirmDelete === 'all' ? 'Clear your journal?' : 'Delete this reading?'}
          onClose={() => setConfirmDelete(null)}
        >
          {confirmDelete !== 'all' && (
            <p>
              {confirmDelete.question || 'An open reading'} ·{' '}
              {readingDateLabel(confirmDelete.createdAt)}
            </p>
          )}
          <p>
            {journalUid
              ? confirmDelete === 'all'
                ? clearReview
                  ? `This will remove the ${clearReview.documents.length} synced ${clearReview.documents.length === 1 ? 'reading' : 'readings'} reviewed here and the current unsynced readings in this browser. Account readings added or changed after review will be kept.`
                  : clearReviewError || 'Checking the readings in your account…'
                : account.isFailedDraw(confirmDelete.id)
                  ? 'This unsynced reading will be discarded from this tab.'
                  : 'This reading will be removed from your account and every synced device.'
              : confirmDelete === 'all'
                ? 'This clears the guest readings shown here, any unreadable guest history, and all guest recovery copies in this browser.'
                : 'This reading will be removed from this device.'}{' '}
            {(confirmDelete !== 'all' || !journalUid || clearReview) && 'This cannot be undone.'}
          </p>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={() => setConfirmDelete(null)}>
              Keep {confirmDelete === 'all' ? 'Readings' : 'Reading'}
            </button>
            <button
              className="button button-danger"
              disabled={Boolean(journalUid && confirmDelete === 'all' && !clearReview)}
              onClick={deleteReadings}
            >
              {confirmDelete === 'all' ? 'Clear All Readings' : 'Delete Reading'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
};
