'use client';

import type { ReactNode } from 'react';
import { useJournalSession } from '../JournalProvider';
import { readingDateLabel } from '../domain/readingDate';
import { CardArtwork } from './CardArtwork';
import { Modal } from './Modal';

export function JournalDialogs({ children }: { children: ReactNode }) {
  const {
    updateAvailable,
    help,
    setHelp,
    selected,
    selectedCard,
    details,
    setDetails,
    confirmDelete,
    setConfirmDelete,
    journalUid,
    clearReview,
    clearReviewError,
    account,
    deleteReadings,
    copyText,
    setCopyText,
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
      {selected && selectedCard && details !== null && (
        <Modal
          title={selectedCard.name}
          onClose={() => setDetails(null)}
          className="card-detail-modal"
        >
          <div className="card-detail">
            <div className="detail-art">
              <CardArtwork card={selectedCard} reversed={selected.orientation === 'reversed'} />
            </div>
            <div>
              <p className="eyebrow">
                CARD {details + 1} ·{' '}
                {selectedCard.arcana === 'major'
                  ? 'MAJOR ARCANA'
                  : selectedCard.suit?.toUpperCase()}
              </p>
              <span className="orientation-badge">{selected.orientation}</span>
              <div className="keyword-list">
                {selectedCard[selected.orientation].keywords.map((word) => (
                  <span key={word}>{word}</span>
                ))}
              </div>
              <p className="card-meaning">{selectedCard[selected.orientation].meaning}</p>
              <p className="field-hint">Notice what connects with your own experience.</p>
            </div>
          </div>
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
      {copyText && (
        <Modal title="Copy your reading" onClose={() => setCopyText(null)}>
          <p>Your browser couldn’t access the clipboard. Select and copy the text below.</p>
          <textarea
            className="copy-fallback"
            aria-label="Reading text to copy"
            readOnly
            value={copyText}
            onFocus={(event) => event.target.select()}
            rows={12}
          />
        </Modal>
      )}
    </>
  );
}
