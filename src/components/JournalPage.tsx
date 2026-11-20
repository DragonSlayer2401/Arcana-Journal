import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CARD_BY_ID } from '../data/deck';
import type { Reading } from '../domain/types';
import { Icon } from './Icons';

interface Props {
  readings: Reading[];
  onOpen: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onRequestClear: () => void;
  onExport: () => Promise<string>;
  onImport: (json: string) => Promise<{ added: number; skipped: number }>;
}

const JournalBackupControls = ({ onExport, onImport }: Pick<Props, 'onExport' | 'onImport'>) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const downloadLink = useRef<HTMLAnchorElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null);

  useEffect(() => {
    if (!download) return;
    downloadLink.current?.click();
    // Give the browser time to open the download even if the page is closed immediately.
    return () => {
      window.setTimeout(() => URL.revokeObjectURL(download.url), 30_000);
    };
  }, [download]);

  const exportJournal = async () => {
    setBusy(true);
    setDownload(null);
    setError('');
    setStatus('Preparing your journal backup…');
    try {
      const json = await onExport();
      if (!fileInput.current) return;
      const blob = new Blob([json], { type: 'application/json' });
      setDownload({
        url: URL.createObjectURL(blob),
        filename: `arcana-journal-${new Date().toISOString().slice(0, 10)}.json`,
      });
      setStatus('Your backup is ready.');
    } catch (cause) {
      setStatus('');
      setError(cause instanceof Error ? cause.message : 'Could not export your journal.');
    } finally {
      setBusy(false);
    }
  };

  const importJournal = async (file: File) => {
    setBusy(true);
    setDownload(null);
    setError('');
    setStatus('Importing your journal backup…');
    try {
      const json = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Could not read the selected file.'));
        reader.readAsText(file);
      });
      const { added, skipped } = await onImport(json);
      let result = `Imported ${added} ${added === 1 ? 'reading' : 'readings'}.`;
      if (skipped) {
        result += ` Skipped ${skipped} ${skipped === 1 ? 'reading' : 'readings'} already in your journal.`;
      }
      setStatus(result);
    } catch (cause) {
      setStatus('');
      setError(cause instanceof Error ? cause.message : 'Could not import this journal backup.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="journal-backup">
      <div className="journal-backup-buttons" role="group" aria-label="Journal backups">
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={exportJournal}
        >
          Export journal
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          Import journal
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="Journal backup file"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importJournal(file);
          }}
        />
      </div>
      <p className="journal-backup-status" role="status">
        {status}
        {download && (
          <>
            {' '}
            <a ref={downloadLink} href={download.url} download={download.filename}>
              Download backup
            </a>
          </>
        )}
      </p>
      {error && (
        <p className="notice warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export const JournalPage = ({
  readings,
  onOpen,
  onRequestDelete,
  onRequestClear,
  onExport,
  onImport,
}: Props) => (
  <section className="journal">
    <div className="result-heading">
      <div>
        <p className="eyebrow">KEPT CLOSE, ON THIS DEVICE</p>
        <h1>Your reading journal.</h1>
        <p>Export a JSON backup or import one to add missing readings to your journal.</p>
      </div>
      {readings.length > 0 && (
        <button className="button button-secondary" onClick={onRequestClear}>
          <Icon name="trash" />
          Clear History
        </button>
      )}
    </div>
    <JournalBackupControls onExport={onExport} onImport={onImport} />
    {readings.length === 0 ? (
      <div className="empty-journal">
        <Icon name="book" size={46} />
        <h2>A fresh page awaits.</h2>
        <p>Your readings will find a home here.</p>
        <Link className="button button-gold" to="/">
          Go to Reading
        </Link>
      </div>
    ) : (
      <div className="journal-list">
        {readings.map((item) => {
          const date = new Date(item.createdAt);
          const dayLabel = date.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
          return (
            <article className="journal-entry" key={item.id}>
              <div className="journal-date">
                <span>{date.toLocaleDateString(undefined, { month: 'short' })}</span>
                <strong>{date.getDate()}</strong>
              </div>
              <button
                className="journal-open"
                onClick={() => onOpen(item.id)}
                aria-label={`Open reading: ${item.question || 'Open reading'}, ${dayLabel}`}
              >
                <span className="journal-meta">
                  {dayLabel} ·{' '}
                  {date.toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}{' '}
                  · {item.cards.length} {item.cards.length === 1 ? 'card' : 'cards'}
                </span>
                <h2>{item.question || 'An open reading'}</h2>
                <span className="journal-cards">
                  {item.cards
                    .map(
                      (card, i) =>
                        `${i + 1}. ${CARD_BY_ID.get(card.cardId)!.name}${card.orientation === 'reversed' ? ' (reversed)' : ' (upright)'}`,
                    )
                    .join(' · ')}
                </span>
                <span className="journal-open-label">Revisit reading</span>
              </button>
              <button
                className="icon-button delete-button"
                aria-label={`Delete reading: ${item.question || 'Open reading'}`}
                onClick={() => onRequestDelete(item.id)}
              >
                <Icon name="trash" />
              </button>
            </article>
          );
        })}
      </div>
    )}
    <p className="reflection-note">
      Stored only in this browser or installed app. Clearing its data can erase your journal.
    </p>
  </section>
);
