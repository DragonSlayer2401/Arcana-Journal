// The suites share one emulator app and register with the same node:test runner.
import '../src/features/Account/features/AccountAccess/__tests__/ManageAccount/SignOutAcrossTabs.emulator.test.mjs';
import '../src/features/Journal/features/AccountJournal/__tests__/ClearHistory/ClearAccountHistory.emulator.test.mjs';
import '../src/features/Journal/features/JournalTransfer/__tests__/ExportReadings/ExportDuringChanges.emulator.test.mjs';
import '../src/features/Journal/features/JournalTransfer/__tests__/ImportReadings/VerifyGuestImport.emulator.test.mjs';
import '../src/features/Account/features/AccountAccess/__tests__/UnlockJournal/LockTrustedJournal.emulator.test.mjs';
import '../src/features/Journal/features/AccountJournal/__tests__/DeleteReadings/DeleteOffline.emulator.test.mjs';
import '../src/features/Journal/features/AccountJournal/__tests__/RecoverUnsyncedReadings/RecoverOfflineReadings.emulator.test.mjs';
import '../src/features/Journal/features/JournalTransfer/__tests__/PortableBackup/TransferWithPendingDeletion.emulator.test.mjs';
import '../src/features/Account/features/AccountAccess/__tests__/ManageDeviceTrust/WithdrawTrust.emulator.test.mjs';
import '../src/features/Journal/features/JournalTransfer/__tests__/PortableBackup/PortableJournal.emulator.test.mjs';
