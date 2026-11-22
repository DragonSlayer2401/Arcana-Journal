import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { JournalTransfer } from '../JournalTransfer/JournalTransfer';
import { HistoryHeader } from './components/HistoryHeader';
import { HistoryAccountPanel } from './components/HistoryAccountPanel';
import { JournalHistory } from './components/JournalHistory';

export const History = () => {
  return (
    <section className="journal">
      <HistoryHeader heading={<h1>Your reading journal.</h1>} />
      <HistoryAccountPanel />
      <JournalTransfer />
      <JournalHistory
        emptyState={
          <div className="empty-journal">
            <Icon name="book" size={46} />
            <h2>A fresh page awaits.</h2>
            <p>Your readings will find a home here.</p>
            <Link className="button button-gold" prefetch={false} href="/">
              Go to Reading
            </Link>
          </div>
        }
      />
    </section>
  );
};
