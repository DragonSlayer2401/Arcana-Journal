import { useEffect, useRef, useState } from 'react';
import {
  backupNeedsSizeConfirmation,
  createJournalBackup,
  parseJournalBackup,
} from '../domain/journalBackup';
import type { Reading } from '../domain/types';
import { Modal } from './Modal';
import './AccountPanel.css';

export interface ImportCounts {
  added: number;
  skipped: number;
  updated?: number;
}

interface Props {
  accountEmail: string | null;
  deviceCount: number;
  recoveryReadings?: Reading[];
  getDeviceReadings: () => Reading[];
  onExport: () => Promise<string>;
  onPreview: (
    incoming: Reading[],
    onProgress: (completed: number, total: number) => void,
  ) => Promise<ImportCounts>;
  onImport: (
    incoming: Reading[],
    onProgress: (completed: number, total: number) => void,
  ) => Promise<ImportCounts>;
}

const readBackupFile = (file: File) =>
  new Promise<Reading[]>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reader.onabort = () => reject(new Error('Could not read the selected file.'));
    reader.onload = () => {
      try {
        resolve(parseJournalBackup(String(reader.result)));
      } catch (error) {
        reject(error);
      }
    };
    reader.readAsText(file);
  });

const readingCount = (count: number) => `${count} ${count === 1 ? 'reading' : 'readings'}`;

export const JournalTransfer = ({
  accountEmail,
  deviceCount,
  recoveryReadings = [],
  getDeviceReadings,
  onExport,
  onPreview,
  onImport,
}: Props) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const downloadLink = useRef<HTMLAnchorElement>(null);
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null);
  const [preview, setPreview] = useState<{
    source: string;
    readings: Reading[];
    counts: ImportCounts;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!download) return;
    downloadLink.current?.click();
    return () => {
      window.setTimeout(() => URL.revokeObjectURL(download.url), 30_000);
    };
  }, [download]);

  const run = async (message: string, action: () => Promise<void>) => {
    setBusy(true);
    setDownload(null);
    setStatus(message);
    setError('');
    try {
      await action();
    } catch (cause) {
      setStatus('');
      setError(cause instanceof Error ? cause.message : 'The journal transfer could not finish.');
    } finally {
      setBusy(false);
    }
  };

  const exportJournal = (recoveryOnly: boolean) =>
    run('Preparing your journal backup…', async () => {
      const json = recoveryOnly
        ? await createJournalBackup(() => ({
            readings: recoveryReadings,
            nextCursor: null,
          }))
        : await onExport();
      if (!fileInput.current) return;
      setDownload({
        url: URL.createObjectURL(new Blob([json], { type: 'application/json' })),
        filename: `arcana-journal-${recoveryOnly ? 'unsynced-' : ''}${new Date().toISOString().slice(0, 10)}.json`,
      });
      setStatus(
        recoveryOnly
          ? `Backup ready for ${readingCount(recoveryReadings.length)} awaiting sync.`
          : 'Your backup is ready.',
      );
    });

  const previewImport = (source: string, read: () => Reading[] | Promise<Reading[]>) =>
    run('Checking readings for import…', async () => {
      const readings = await read();
      if (!fileInput.current) return;
      const counts = await onPreview(readings, (completed, total) =>
        setStatus(`Checked ${completed} of ${readingCount(total)}…`),
      );
      setPreview({ readings, counts, source });
      setStatus('');
    });

  const finishImport = () => {
    if (!preview) return;
    void run('Importing readings…', async () => {
      const result = await onImport(preview.readings, (completed, total) =>
        setStatus(`Processed ${completed} of ${readingCount(total)}…`),
      );
      setPreview(null);
      const message = [`Imported ${readingCount(result.added)}.`];
      if (result.updated)
        message.push(`Updated reveal progress for ${readingCount(result.updated)}.`);
      if (result.skipped)
        message.push(`Skipped ${readingCount(result.skipped)} already in your journal.`);
      setStatus(message.join(' '));
    });
  };

  const dismissPreview = () => {
    setPreview(null);
    setError('');
  };

  return (
    <div className="journal-backup">
      {accountEmail && deviceCount > 0 && (
        <div className="journal-device-import">
          <p>This browser has {readingCount(deviceCount)} in its guest journal.</p>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void previewImport('Guest journal on this device', getDeviceReadings)}
          >
            Import this device’s journal
          </button>
        </div>
      )}
      <div className="journal-backup-buttons" role="group" aria-label="Journal backups">
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => void exportJournal(false)}
        >
          Export journal
        </button>
        {recoveryReadings.length > 0 && (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void exportJournal(true)}
          >
            Download unsynced readings
          </button>
        )}
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
            if (!file) return;
            if (
              backupNeedsSizeConfirmation(file.size) &&
              !window.confirm(
                `This backup is ${Math.ceil(file.size / (1024 * 1024))} MiB. It may take a while to read on this device. Open it to preview the import?`,
              )
            )
              return;
            void previewImport(file.name, () => readBackupFile(file));
          }}
        />
      </div>
      <p className="journal-backup-status" role="status">
        {!preview && status}
        {download && (
          <>
            {' '}
            <a ref={downloadLink} href={download.url} download={download.filename}>
              Download backup
            </a>
          </>
        )}
      </p>
      {!preview && error && (
        <p className="notice warning" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <Modal title="Review journal import" onClose={dismissPreview}>
          <dl className="journal-import-details">
            <dt>From</dt>
            <dd>{preview.source}</dd>
            <dt>Into</dt>
            <dd>{accountEmail || 'Guest journal on this device'}</dd>
            <dt>New readings</dt>
            <dd>{preview.counts.added}</dd>
            {Boolean(preview.counts.updated) && (
              <>
                <dt>Updated reveal progress</dt>
                <dd>{preview.counts.updated}</dd>
              </>
            )}
            <dt>Already in journal</dt>
            <dd>{preview.counts.skipped}</dd>
          </dl>
          {error && (
            <p className="notice warning" role="alert">
              {error} You can retry this import. Readings already added are kept.
            </p>
          )}
          {busy && <p role="status">{status}</p>}
          <div className="modal-actions">
            <button
              className="button button-secondary"
              type="button"
              onClick={dismissPreview}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className="button button-gold"
              type="button"
              onClick={finishImport}
              disabled={busy}
            >
              Confirm import
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};
