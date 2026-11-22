'use client';

import { useState, type ReactNode } from 'react';
import { useJournalSession } from '@/features/Journal/hooks/useJournalSession';
import { readingDateLabel } from '@/features/Journal/utils/readingDate';
import { ReadingSpread } from './ReadingSpread';
import { ShareReading } from './ShareReading';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';

const ReadingQuestion = ({ question }: { question: string }) => {
  const [isOpen, setIsOpen] = useState(false);
  const hasLongQuestion = question.length > 80 || /[\t\r\n]/.test(question);
  return (
    <>
      <p className="reading-question">
        <span>{question || 'An open reading. A little space to listen.'}</span>
        {hasLongQuestion && (
          <button className="question-detail" onClick={() => setIsOpen(true)}>
            Read full question
          </button>
        )}
      </p>
      {isOpen && (
        <Modal title="Your question" onClose={() => setIsOpen(false)}>
          <p className="full-reading-question">{question}</p>
        </Modal>
      )}
    </>
  );
};

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
      {!reading && !data.awaitingNewReading && (
        <section className="reading-home" aria-label="Prepare your reading">
          {children}
        </section>
      )}
      {reading && (
        <section key={reading.id} className="reading-result" aria-label="Your reading">
          <div className="result-heading">
            <div>
              <p className="eyebrow">
                {readingDateLabel(reading.createdAt)} · {reading.cards.length}{' '}
                {reading.cards.length === 1 ? 'CARD' : 'CARDS'}
              </p>
              <h1>Your moment, drawn.</h1>
              <ReadingQuestion question={reading.question} />
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
          {journalUid && <p className="reflection-note">{account.status}</p>}
        </section>
      )}
    </>
  );
};
