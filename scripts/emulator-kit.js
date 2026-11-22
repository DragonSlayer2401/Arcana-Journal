import * as account from '../src/services/Account/account.service';
import * as journalOperations from '../src/services/Journal/journal.service';

export const journal = { ...account, ...journalOperations };
export { databaseFor } from '../src/services/Account/account.service';
export { getAuth } from 'firebase/auth';
export * as firestore from 'firebase/firestore';
export { deletionReservationName } from '../src/services/Journal/Deletions/deletionReservation';
export { checkDeletion } from '../src/services/Journal/Deletions/deletionStore';
export { collisionReadingId } from '../src/features/Journal/utils/journalBackup';
export * as readingRecovery from '../src/features/Journal/features/AccountJournal/utils/readingRecovery';
export { saveTabRecoveryCopy } from '../src/features/Journal/features/AccountJournal/utils/tabRecovery';
