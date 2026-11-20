import { useState, type FormEvent } from 'react';
import {
  refreshAccount,
  resetPassword,
  sendVerification,
  signIn,
  signOutAccount,
  signUp,
  type JournalUser,
} from '../cloud/journal';
import { Modal } from './Modal';
import './AccountPanel.css';

type FormMode = 'signIn' | 'signUp' | 'reset';
const titles: Record<FormMode, string> = {
  signIn: 'Sign in',
  signUp: 'Create account',
  reset: 'Reset password',
};

const accountError = (cause: unknown) => {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : '';
  switch (code) {
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-login-credentials':
    case 'auth/invalid-credential':
      return 'Check your email address and password and try again.';
    case 'auth/email-already-in-use':
      return 'This email already has an account. Sign in or reset your password.';
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'Choose a stronger password and try again.';
    case 'auth/network-request-failed':
      return 'Connect to the internet and try again.';
    case 'auth/too-many-requests':
      return 'Please wait a few minutes and try again.';
    case 'auth/operation-not-allowed':
      return 'Email sign-in is currently unavailable.';
    default:
      return cause instanceof Error && !code
        ? cause.message
        : 'The account request could not finish. Please try again.';
  }
};

const AccountForm = ({ initialMode, onClose }: { initialMode: FormMode; onClose: () => void }) => {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);

  const changeMode = (next: FormMode) => {
    setMode(next);
    setPassword('');
    setError('');
    setResetSent(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'reset') {
        await resetPassword(email.trim());
        setResetSent(true);
      } else {
        const authenticate = mode === 'signUp' ? signUp : signIn;
        await authenticate(email.trim(), password, trusted);
        onClose();
      }
    } catch (cause) {
      setError(accountError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={titles[mode]} onClose={onClose}>
      {resetSent ? (
        <>
          <p role="status">
            If an account uses {email.trim()}, you’ll receive a password reset email.
          </p>
          <button className="button button-secondary" onClick={() => changeMode('signIn')}>
            Back to sign in
          </button>
        </>
      ) : (
        <form className="journal-account-form" onSubmit={submit}>
          <label>
            Email address
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              disabled={busy}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {mode !== 'reset' && (
            <>
              <label>
                Password
                <input
                  type="password"
                  name="password"
                  autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
                  minLength={mode === 'signUp' ? 6 : undefined}
                  required
                  disabled={busy}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {mode === 'signUp' && (
                <p className="account-password-hint">Use at least 6 characters.</p>
              )}
              <label className="account-trust">
                <input
                  type="checkbox"
                  checked={trusted}
                  disabled={busy}
                  onChange={(event) => setTrusted(event.target.checked)}
                />
                Stay signed in and keep my journal available offline on this trusted device.
              </label>
            </>
          )}
          {error && (
            <p className="notice warning" role="alert">
              {error}
            </p>
          )}
          <button className="button button-gold" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'reset' ? 'Send reset email' : titles[mode]}
          </button>
          <div className="account-form-links">
            {mode === 'signIn' ? (
              <>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => changeMode('reset')}
                >
                  Forgot password?
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => changeMode('signUp')}
                >
                  Create account
                </button>
              </>
            ) : (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => changeMode('signIn')}
              >
                Back to sign in
              </button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
};

interface Props {
  user: JournalUser | null;
  syncStatus?: string;
  signOutDisabled?: boolean;
}

export const AccountPanel = ({ user, syncStatus, signOutDisabled }: Props) => {
  const [form, setForm] = useState<FormMode | null>(null);
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
            {user ? syncStatus : 'Sign in to access your readings across devices.'}
          </p>
        </div>
        <div className="account-actions">
          {user ? (
            <button
              className="button button-secondary"
              disabled={busy || signOutDisabled}
              onClick={() => void run(signOutAccount)}
            >
              Sign out
            </button>
          ) : (
            <>
              <button className="button button-gold" onClick={() => setForm('signIn')}>
                Sign in
              </button>
              <button className="button button-secondary" onClick={() => setForm('signUp')}>
                Create account
              </button>
            </>
          )}
        </div>
      </div>
      {user && !user.emailVerified && (
        <div className="account-verification">
          <p>Your email address is awaiting verification.</p>
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
      {form && !user && <AccountForm initialMode={form} onClose={() => setForm(null)} />}
    </section>
  );
};
