'use client';
import { useJournalSession } from '../../../App';
import { lockJournal } from '../../../cloud/journal';
import { AccountPanel } from '../../../components/AccountPanel';
import { JournalTransfer } from '../../../components/JournalTransfer';
import { JournalPage } from '../../../components/JournalPage';

export default function Journal() {
  const {
    readings,
    user,
    journalUid,
    account,
    opening,
    guestClearStatus,
    openReading,
    setConfirmDelete,
    requestClear,
    historyRevision,
    deviceCount,
    guestReadingsForTransfer,
    exportJournal,
    previewImport,
    importJournal,
  } = useJournalSession();
  return (
    <JournalPage
      readings={readings}
      account={Boolean(journalUid)}
      opening={opening}
      loading={account.loading}
      hasMore={Boolean(journalUid && account.hasMore)}
      onLoadMore={account.loadMore}
      onOpen={openReading}
      onRequestDelete={setConfirmDelete}
      onRequestClear={requestClear}
    >
      {!journalUid && guestClearStatus && <p role="status">{guestClearStatus}</p>}
      {user !== undefined && (
        <>
          <AccountPanel
            key={user?.uid ?? 'signed-out'}
            user={user}
            syncStatus={account.status}
            signOutDisabled={account.pending}
            onLock={account.trusted && journalUid ? () => lockJournal(journalUid) : undefined}
          />
          <JournalTransfer
            historyRevision={historyRevision}
            accountEmail={journalUid ? (user?.email ?? null) : null}
            recoveryReadings={account.recoveryReadings}
            deletionStorageUnreadable={account.deletionStorageUnreadable}
            recoveryComplete={account.recoveryComplete}
            getRecoveryForExport={account.getRecoveryForExport}
            savedRecovery={account.savedRecovery}
            deviceCount={deviceCount}
            getDeviceReadings={guestReadingsForTransfer}
            onExport={exportJournal}
            onPreview={previewImport}
            onImport={importJournal}
          />
        </>
      )}
    </JournalPage>
  );
}
