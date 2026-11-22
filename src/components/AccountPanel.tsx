import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  refreshAccount,
  sendVerification,
  signOutAccount,
  type JournalUser,
} from '../cloud/journal';
import { accountError } from './accountError';
import './AccountPanel.css';

interface Props {
  user: JournalUser | null;
  syncStatus?: string;
  signOutDisabled?: boolean;
  onLock?: () => Promise<void>;
}

export const AccountPanel = ({ user, syncStatus, signOutDisabled, onLock }: Props) => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      setMessage((await action()) || '');
    } catch (cause) {
      setError(accountError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="journal-account" aria-label="Journal account">
      <div className="journal-account-row">
        <div>
          <h2>{user ? user.email || 'Your account' : 'Sync your journal'}</h2>
          <p aria-live="polite">
            {user
              ? user.emailVerified
                ? syncStatus
                : 'Your readings are saved in the guest journal on this device.'
              : 'Sign in to access your readings across devices.'}
          </p>
        </div>
        <div className="account-actions">
          {onLock && (
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => void run(onLock)}
            >
              Lock journal
            </button>
          )}
          {user ? (
            <button
              className="button button-secondary"
              disabled={busy || signOutDisabled}
              onClick={() => void run(() => signOutAccount(user.uid))}
            >
              Sign out
            </button>
          ) : (
            <>
              <Link className="button button-gold" to="/login">
                Sign in
              </Link>
              <Link className="button button-secondary" to="/signup">
                Create account
              </Link>
            </>
          )}
        </div>
      </div>
      {onLock && (
        <p>
          You can lock offline while changes wait to sync. Reconnect and enter your password to
          unlock.
        </p>
      )}
      {user && !user.emailVerified && (
        <div className="account-verification">
          <p>
            Open the verification link in your email, then choose Check verification to enable sync.
            If you need a new link, choose Send verification email.
          </p>
          <div className="account-actions">
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const account = await refreshAccount();
                  return account?.emailVerified
                    ? 'Email address verified.'
                    : 'Email verification is still pending.';
                })
              }
            >
              Check verification
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await sendVerification();
                  return 'Verification email sent. Check your inbox.';
                })
              }
            >
              Send verification email
            </button>
          </div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="notice warning" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};
