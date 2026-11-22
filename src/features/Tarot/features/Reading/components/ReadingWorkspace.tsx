'use client';

import type { ReactNode } from 'react';
import { useJournalSession } from '@/features/Journal/hooks/useJournalSession';
import { readingDateLabel } from '@/features/Journal/utils/readingDate';
import { ReadingSpread } from './ReadingSpread';
import { ShareReading } from './ShareReading';
import { Icon } from '@/components/Icon';

export const ReadingWorkspace = ({
  children,
  cardBack,
}: {
  children: ReactNode;
  cardBack: ReactNode;
}) => {
  const { account, reading, data, journalUid, newReading, reveal } = useJournalSession();
  const revealedCount = reading?.revealed.filter(Boolean).length ?? 0;
  return (
    <>
      {account.loadingActive && (
        <div className="empty-journal">
          <p role="status">Looking for your saved reading…</p>
          <button className="button button-secondary" onClick={newReading}>
            Start a new reading
          </button>
        </div>
      )}
      {!account.loadingActive && !reading && data.awaitingNewReading && (
        <section className="empty-journal">
          <Icon name="moon" size={46} />
          <h1>A little space to begin again.</h1>
          <p>
            {journalUid
              ? 'This reading is unavailable on this device.'
              : 'Your previous reading has been removed.'}
          </p>
          <button className="button button-gold" onClick={newReading}>
            <Icon name="spark" />
            New Reading
          </button>
        </section>
      )}
      {!reading && !data.awaitingNewReading && children}
      {reading && (
        <section key={reading.id} className="reading-result" aria-label="Your reading">
          <div className="result-heading">
            <div>
              <p className="eyebrow">
                {readingDateLabel(reading.createdAt)} · {reading.cards.length}{' '}
                {reading.cards.length === 1 ? 'CARD' : 'CARDS'}
              </p>
              <h1>Your moment, drawn.</h1>
              <p className="reading-question">
                {reading.question || 'An open reading. A little space to listen.'}
              </p>
            </div>
            <button className="button button-secondary" onClick={newReading}>
              <Icon name="spark" />
              New Reading
            </button>
          </div>
          <div className="reveal-bar">
            <p role="status" aria-live="polite">
              {revealedCount === reading.cards.length
                ? 'Your spread is revealed. Tap a card to explore its meaning.'
                : `${revealedCount} of ${reading.cards.length} revealed · Tap a card when you’re ready.`}
            </p>
            <button
              className="text-button"
              onClick={() => reveal()}
              disabled={revealedCount === reading.cards.length}
            >
              Reveal All
            </button>
          </div>
          <ReadingSpread reading={reading} cardBack={cardBack} onReveal={reveal} />
          <ShareReading reading={reading} />
          <p className="reflection-note">
            {journalUid ? account.status : 'A prompt for reflection. You decide what resonates.'}
          </p>
        </section>
      )}
    </>
  );
};
