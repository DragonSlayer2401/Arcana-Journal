import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  backupNeedsSizeConfirmation,
  createJournalBackup,
  mergeJournalReadings,
  parseJournalBackup,
  UncheckedDeletionsExportError,
} from '../domain/journalBackup';
import type { Reading } from '../domain/types';
import type { RecoveryCopy } from '../domain/readingRecovery';
import type { WatchExportHistory } from '../cloud/journal';
import { Modal } from './Modal';
import './AccountPanel.css';

export interface ImportCounts {
  added: number;
  skipped: number;
  updated?: number;
  uncheckedDeletions?: boolean;
}

export interface JournalExport {
  json: string;
  scope: 'journal' | 'cloud-and-tab' | 'unchecked-deletions';
  watchHistory?: WatchExportHistory;
}

interface SavedRecovery {
  readings: Reading[];
  isCurrent: () => boolean;
  discard: () => void;
  retainUntilChecked: () => { copies: RecoveryCopy[]; discard: () => void };
}

interface Props {
  historyRevision?: number;
  accountEmail: string | null;
  deviceCount: number | 'unsaved';
  recoveryReadings?: Reading[];
  deletionStorageUnreadable?: boolean;
  recoveryComplete?: boolean;
  getRecoveryForExport?: () => { readings: Reading[]; complete: boolean };
  savedRecovery?: SavedRecovery;
  getDeviceReadings: () => Reading[] | Promise<Reading[]>;
  onExport: (allowUncheckedDeletions?: boolean) => Promise<JournalExport>;
  onPreview: (
    incoming: Reading[],
    onProgress: (completed: number, total: number) => void,
  ) => Promise<ImportCounts>;
  onImport: (
    incoming: Reading[],
    onProgress: (completed: number, total: number) => void,
    allowUncheckedDeletions?: boolean,
    retainedCopies?: RecoveryCopy[],
    recovering?: boolean,
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
  historyRevision = 0,
  accountEmail,
  deviceCount,
  recoveryReadings = [],
  deletionStorageUnreadable = false,
  recoveryComplete = true,
  getRecoveryForExport,
  savedRecovery,
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
    recovery?: SavedRecovery;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [exportWarning, setExportWarning] = useState('');
  const exportGeneration = useRef(0);
  const objectUrl = useRef<{ url: string; revoke: () => void } | null>(null);
  const lastActionWasExport = useRef(false);

  const revokeDownload = useCallback(() => {
    objectUrl.current?.revoke();
    objectUrl.current = null;
  }, []);
  const invalidateExports = useCallback(() => {
    exportGeneration.current++;
    revokeDownload();
    setDownload(null);
    setExportWarning('');
    if (lastActionWasExport.current) {
      setStatus('');
      setError('');
      setBusy(false);
    }
  }, [revokeDownload]);
  useLayoutEffect(() => {
    invalidateExports();
    // A document frozen in the back-forward cache retains its React tree.
    // Expire its export before another tab can change the journal while it sleeps.
    window.addEventListener('pagehide', invalidateExports);
    return () => {
      window.removeEventListener('pagehide', invalidateExports);
      exportGeneration.current++;
      revokeDownload();
    };
  }, [historyRevision, invalidateExports, revokeDownload]);

  useEffect(() => {
    if (download && objectUrl.current?.url === download.url) downloadLink.current?.click();
  }, [download]);

  const run = async (
    message: string,
    action: (current: () => boolean) => Promise<void>,
    exporting = false,
  ) => {
    const generation = exportGeneration.current;
    const current = () =>
      !!fileInput.current && (!exporting || generation === exportGeneration.current);
    lastActionWasExport.current = exporting;
    setBusy(true);
    revokeDownload();
    setDownload(null);
    setStatus(message);
    setError('');
    try {
      await action(current);
    } catch (cause) {
      if (!current()) return;
      setStatus('');
      if (cause instanceof UncheckedDeletionsExportError) setExportWarning(cause.message);
      else
        setError(cause instanceof Error ? cause.message : 'The journal transfer could not finish.');
    } finally {
      if (current()) setBusy(false);
    }
  };

  const prepareDownload = (
    json: string,
    fileScope: string,
    message: string,
    watchHistory?: WatchExportHistory,
  ) => {
    if (!fileInput.current) return;
    const urls = window.URL;
    const url = urls.createObjectURL(new Blob([json], { type: 'application/json' }));
    const stop = watchHistory?.(() => {
      if (objectUrl.current?.url === url) invalidateExports();
    });
    objectUrl.current = {
      url,
      revoke: () => {
        stop?.();
        urls.revokeObjectURL(url);
      },
    };
    setDownload({
      url,
      filename: `arcana-journal-${fileScope}${new Date().toISOString().slice(0, 10)}.json`,
    });
    setStatus(message);
  };

  const exportGuestJournal = () =>
    run(
      'Preparing your guest journal backup…',
      async (current) => {
        const readings = await getDeviceReadings();
        const json = await createJournalBackup(() => ({ readings, nextCursor: null }));
        if (current())
          prepareDownload(
            json,
            'guest-',
            `Guest backup ready for ${readingCount(readings.length)}.`,
          );
      },
      true,
    );

  const exportJournal = (source: 'journal' | 'available' | 'recovery') =>
    run(
      'Preparing your journal backup…',
      async (current) => {
        const recovery =
          source === 'recovery'
            ? (getRecoveryForExport?.() ?? {
                readings: recoveryReadings,
                complete: recoveryComplete,
              })
            : null;
        const partial = recovery?.complete === false;
        if (partial && (recoveryComplete || !recovery.readings.length))
          throw new Error(
            'Some recovery copies could not be read. Check storage access before downloading your unsynced readings.',
          );
        if (recovery && !recovery.readings.length) {
          setStatus('No readings are awaiting sync.');
          return;
        }
        let json: string;
        let watchHistory: WatchExportHistory | undefined;
        let fileScope = '';
        let message = 'Your backup is ready.';
        if (recovery) {
          json = await createJournalBackup(async () => ({
            readings: (await mergeJournalReadings([], recovery.readings)).readings,
            nextCursor: null,
          }));
          fileScope = partial ? 'unsynced-partial-' : 'unsynced-';
          message = partial
            ? `Partial backup ready for ${readingCount(recovery.readings.length)}. Other recovery copies could not be read.`
            : `Backup ready for ${readingCount(recovery.readings.length)} awaiting sync.`;
        } else {
          const result = await onExport(source === 'available');
          if (!current()) return;
          if (source === 'journal') setExportWarning('');
          json = result.json;
          watchHistory = result.watchHistory;
          if (result.scope === 'unchecked-deletions') {
            fileScope = 'cloud-and-this-tab-unchecked-deletions-';
            message =
              'This backup contains cloud readings and recovery copies available in this tab. It may include readings waiting to be deleted.';
          } else if (result.scope === 'cloud-and-tab') {
            fileScope = 'cloud-and-this-tab-';
            message =
              'Backup includes cloud readings and recovery copies available in this tab. Other tabs may have unsynced readings.';
          }
        }
        if (current()) prepareDownload(json, fileScope, message, watchHistory);
      },
      true,
    );

  const previewImport = (
    source: string,
    read: () => Reading[] | Promise<Reading[]>,
    recovery?: SavedRecovery,
  ) =>
    run('Checking readings for import…', async () => {
      const readings = await read();
      if (!fileInput.current) return;
      const counts = await onPreview(readings, (completed, total) =>
        setStatus(`Checked ${completed} of ${readingCount(total)}…`),
      );
      setPreview({ readings, counts, source, recovery });
      setStatus('');
    });

  const finishImport = () => {
    if (!preview) return;
    void run('Importing readings…', async () => {
      if (preview.recovery && !preview.recovery.isCurrent()) {
        setPreview(null);
        throw new Error(
          'The recovery copies changed or are unavailable. Review the current copies before importing.',
        );
      }
      const unchecked = preview.counts.uncheckedDeletions === true;
      const retained = unchecked ? preview.recovery?.retainUntilChecked() : undefined;
      const result = await onImport(
        preview.readings,
        (completed, total) => setStatus(`Processed ${completed} of ${readingCount(total)}…`),
        unchecked,
        retained?.copies,
        preview.recovery !== undefined,
      );
      if (!result.uncheckedDeletions) (retained?.discard ?? preview.recovery?.discard)?.();
      setPreview(null);
      const message = [`Imported ${readingCount(result.added)}.`];
      if (result.updated)
        message.push(`Updated reveal progress for ${readingCount(result.updated)}.`);
      if (result.skipped)
        message.push(`Skipped ${readingCount(result.skipped)} already in your journal.`);
      if (result.uncheckedDeletions && preview.recovery)
        message.push(
          'Your recovery copies are still available because saved deletions could not be checked.',
        );
      setStatus(message.join(' '));
    });
  };

  const dismissPreview = () => {
    setPreview(null);
    setError('');
  };

  return (
    <div className="journal-backup">
      {accountEmail && savedRecovery && savedRecovery.readings.length > 0 && (
        <div className="journal-device-import">
          <p>
            This browser has a recovery copy of {readingCount(savedRecovery.readings.length)} for
            your account.
          </p>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void previewImport(
                'Unsynced readings on this device',
                () => savedRecovery.readings,
                savedRecovery,
              )
            }
          >
            Recover unsynced readings
          </button>
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'Discard these recovery copies from this browser? Unsynced readings could be lost.',
                )
              ) {
                savedRecovery.discard();
                invalidateExports();
              }
            }}
          >
            Discard recovery copies
          </button>
        </div>
      )}
      {accountEmail && (deviceCount === 'unsaved' || deviceCount > 0) && (
        <div className="journal-device-import">
          {deviceCount === 'unsaved' ? (
            <>
              <p>
                This tab has unsaved guest changes. Download a guest backup before closing or
                reloading.
              </p>
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => void exportGuestJournal()}
              >
                Download guest backup
              </button>
            </>
          ) : (
            <p>This browser has {readingCount(deviceCount)} in its guest journal.</p>
          )}
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
      {deletionStorageUnreadable && (
        <p>
          This browser cannot check saved deletions. Restore storage access for a checked backup, or
          export the available readings, which may include readings waiting to be deleted.
        </p>
      )}
      {exportWarning && !deletionStorageUnreadable && <p role="alert">{exportWarning}</p>}
      <div className="journal-backup-buttons" role="group" aria-label="Journal backups">
        {!deletionStorageUnreadable && (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void exportJournal('journal')}
          >
            Export journal
          </button>
        )}
        {(exportWarning || deletionStorageUnreadable) && (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void exportJournal('available')}
          >
            Export available readings
          </button>
        )}
        {recoveryReadings.length > 0 && (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void exportJournal('recovery')}
          >
            {recoveryComplete
              ? 'Download unsynced readings'
              : 'Download available unsynced readings (partial backup)'}
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
          {preview.counts.uncheckedDeletions && (
            <p className="notice warning">
              Saved deletions could not be checked. A matching reading might still be deleted after
              this import. Restore browser storage to check before importing.
            </p>
          )}
          {preview.recovery && (
            <ul aria-label="Readings to recover">
              {preview.readings.map((reading, index) => (
                <li key={index}>
                  {reading.question || 'Untitled reading'} ·{' '}
                  {new Date(reading.createdAt).toLocaleDateString()}
                </li>
              ))}
            </ul>
          )}
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
