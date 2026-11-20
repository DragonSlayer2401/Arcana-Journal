import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { resetPassword, signIn, signUp } from '../cloud/journal';
import { accountError } from './accountError';
import './AccountForm.css';

type FormMode = 'signIn' | 'signUp' | 'reset';
const titles = { signIn: 'Sign in', signUp: 'Create account', reset: 'Reset password' };
const descriptions = {
  signIn: 'Open your journal on this device.',
  signUp: 'Verify your email to sync readings across your devices.',
  reset: 'Enter your account email to request a password reset link.',
};

export const AccountForm = ({ mode }: { mode: FormMode }) => {
  const [email, setEmail] = useState('');
  return (
    <section className="auth-page" aria-labelledby="auth-title">
      <h1 id="auth-title">{titles[mode]}</h1>
      <AccountFields key={mode} mode={mode} email={email} setEmail={setEmail} />
    </section>
  );
};

const AccountFields = ({
  mode,
  email,
  setEmail,
}: {
  mode: FormMode;
  email: string;
  setEmail: (email: string) => void;
}) => {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checkConfirmation, setCheckConfirmation] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const signup = mode === 'signUp';
  const reset = mode === 'reset';
  const mismatch = checkConfirmation && confirmation !== password;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (signup && confirmation !== password) {
      setCheckConfirmation(true);
      confirmationInput.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (reset) {
        await resetPassword(email.trim());
        setResetSent(true);
      } else {
        const authenticate = signup ? signUp : signIn;
        await authenticate(email.trim(), password, trusted);
      }
    } catch (cause) {
      if (
        reset &&
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'auth/user-not-found'
      ) {
        setResetSent(true);
      } else {
        setError(accountError(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  if (resetSent) {
    return (
      <>
        <p className="auth-description" role="status">
          If an account uses {email.trim()}, you’ll receive a password reset email.
        </p>
        <Link className="button button-secondary" to="/login">
          Back to sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <p className="auth-description">{descriptions[mode]}</p>
      <form
        className="auth-form"
        aria-labelledby="auth-title"
        aria-busy={busy}
        method="post"
        onSubmit={submit}
      >
        <label htmlFor="auth-email">Email address</label>
        <input
          id="auth-email"
          name="email"
          type="email"
          autoComplete={reset ? 'email' : 'username'}
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={busy}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {!reset && (
          <>
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={signup ? 'new-password' : 'current-password'}
              minLength={signup ? 6 : undefined}
              aria-describedby={signup ? 'auth-password-hint' : undefined}
              required
              disabled={busy}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {signup && (
              <>
                <p className="auth-hint" id="auth-password-hint">
                  Use at least 6 characters.
                </p>
                <label htmlFor="auth-confirmation">Confirm password</label>
                <input
                  ref={confirmationInput}
                  id="auth-confirmation"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={mismatch || undefined}
                  aria-describedby={mismatch ? 'auth-password-mismatch' : undefined}
                  required
                  disabled={busy}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
                {mismatch && (
                  <p id="auth-password-mismatch" className="notice warning" role="alert">
                    Passwords don’t match. Enter the same password in both fields.
                  </p>
                )}
              </>
            )}
            <label className="auth-trust">
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
          {busy ? 'Please wait…' : reset ? 'Send reset email' : titles[mode]}
        </button>
      </form>
      <div className="auth-links">
        {mode === 'signIn' ? (
          <>
            <Link to="/reset-password">Forgot password?</Link>
            <Link to="/signup">Create account</Link>
          </>
        ) : (
          <Link to="/login">{reset ? 'Back to sign in' : 'Sign in'}</Link>
        )}
      </div>
    </>
  );
};
