import { useState } from 'react';
import { resetLockedJournalPassword, signOutAccount, unlockJournal } from '../cloud/journal';
import { accountError } from './accountError';
import './AccountForm.css';

export const IncompleteSignOut = ({ uid }: { uid: string }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = async () => {
    setBusy(true);
    setError('');
    try {
      await signOutAccount(uid);
    } catch (cause) {
      setError(accountError(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page" aria-labelledby="sign-out-title">
      <h1 id="sign-out-title">Sign-out incomplete</h1>
      <p className="notice warning" role="alert">
        Your journal is hidden in this tab. Other tabs or a reopened app may still show it. Use your
        device’s screen lock before handing it over.
      </p>
      <p>Allow browser storage changes and retry to finish signing out.</p>
      <button className="button button-gold" type="button" onClick={retry} disabled={busy}>
        {busy ? 'Signing out…' : 'Retry sign out'}
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
};

interface Props {
  uid: string;
  hasFailedWrites: boolean;
  saving: boolean;
  needsOpenTab?: boolean;
  tabOnly?: boolean;
}

export const LockedJournal = ({ uid, hasFailedWrites, saving, needsOpenTab, tabOnly }: Props) => {
  const [password, setPassword] = useState('');
  const [request, setRequest] = useState<'unlock' | 'reset' | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [error, setError] = useState('');
  const busy = request !== null;

  const submit = async (action: 'unlock' | 'reset') => {
    if (busy) return;
    setRequest(action);
    setResetSent(false);
    setError('');
    try {
      if (action === 'reset') {
        await resetLockedJournalPassword(uid);
        setResetSent(true);
      } else {
        await unlockJournal(uid, password);
      }
    } catch (cause) {
      setError(
        accountError(
          cause,
          action === 'reset'
            ? 'The reset email could not be sent.'
            : 'Check your password and try again.',
        ),
      );
    } finally {
      setPassword('');
      setRequest(null);
    }
  };

  return (
    <main className="auth-page" aria-labelledby="lock-title">
      <h1 id="lock-title">Journal locked</h1>
      <p className="auth-description">
        Connect to the internet and enter your account password to unlock this journal.
      </p>
      {tabOnly && (
        <p className="notice warning" role="alert">
          This browser could only lock this tab. Other tabs or a reopened app may still show your
          journal. Use the device’s screen lock before handing it over.
        </p>
      )}
      {hasFailedWrites || needsOpenTab ? (
        <p className="notice warning" role="alert">
          Closing this tab could lose unsynced changes. Keep it open until you can unlock and sync,
          retry, or download your unsynced readings.
        </p>
      ) : saving ? (
        <p role="status">
          A recovery copy of your pending readings is saved on this device for your account.
        </p>
      ) : null}
      <form
        className="auth-form"
        aria-labelledby="lock-title"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit('unlock');
        }}
        method="post"
      >
        <label htmlFor="unlock-password">Password</label>
        <input
          id="unlock-password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          disabled={busy}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && (
          <p className="notice warning" role="alert">
            {error}
          </p>
        )}
        <button className="button button-gold" type="submit" disabled={busy}>
          {request === 'unlock' ? 'Unlocking…' : 'Unlock journal'}
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => void submit('reset')}
        >
          {request === 'reset' ? 'Sending reset email…' : 'Send password reset email'}
        </button>
        {resetSent && (
          <p role="status">
            Check your account inbox for a reset link. After changing your password, return here and
            enter the new password to unlock.
          </p>
        )}
      </form>
    </main>
  );
};
