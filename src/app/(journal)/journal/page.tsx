import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '../../../components/Icons';
import { JournalPage } from '../../../components/JournalPage';
import '../../../components/AccountPanel.css';

export const metadata: Metadata = {
  title: 'Reading Journal',
  description: 'Revisit your tarot readings, open saved spreads, and manage your journal backups.',
};

export default function Journal() {
  return (
    <JournalPage
      heading={<h1>Your reading journal.</h1>}
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
  );
}
