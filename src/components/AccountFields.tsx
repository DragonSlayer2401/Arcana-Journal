'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useJournalSession } from '../JournalProvider';
import { resetPassword, signIn, signUp } from '../cloud/journal';
import { accountError } from './accountError';

export type AccountMode = 'signIn' | 'signUp' | 'reset';

export function SignedOutAccount({ children }: { children: ReactNode }) {
  const { user } = useJournalSession();
  const router = useRouter();
  useEffect(() => {
    if (user) router.replace('/journal');
  }, [user, router]);
  return user ? null : children;
}

type AccountFieldsProps = {
  mode: AccountMode;
  submitLabel: string;
  description: ReactNode;
  children: ReactNode;
  trustOption: ReactNode;
  navigation: ReactNode;
};

export function AccountFields({
  mode,
  submitLabel,
  description,
  children,
  trustOption,
  navigation,
}: AccountFieldsProps) {
  const { opening, authEmail: email, setAuthEmail: setEmail } = useJournalSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mismatch, setMismatch] = useState<boolean | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const signup = mode === 'signUp';
  const reset = mode === 'reset';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || opening) return;
    setError('');
    const fields = new FormData(event.currentTarget);
    const password = String(fields.get('password') ?? '');
    if (signup && fields.get('confirmPassword') !== password) {
      setMismatch(true);
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
        await authenticate(email.trim(), password, fields.has('trusted'));
      }
    } catch (cause) {
      if (
        reset &&
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        (cause.code === 'auth/user-not-found' || cause.code === 'auth/user-disabled')
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
          If {email.trim()} is eligible for a password reset, check its inbox for a reset link.
        </p>
        <Link className="button button-secondary" prefetch={false} href="/login">
          Back to sign in
        </Link>
      </>
    );
  }

  return (
    <>
      {description}
      <form
        className="auth-form"
        aria-labelledby="auth-title"
        aria-busy={busy}
        method="post"
        onSubmit={submit}
        onChange={(event) => {
          if (mismatch !== null) {
            const fields = new FormData(event.currentTarget);
            setMismatch(fields.get('password') !== fields.get('confirmPassword'));
          }
        }}
      >
        <fieldset className="auth-fields" disabled={busy || opening}>
          <label htmlFor="auth-email">Email address</label>
          <input
            id="auth-email"
            name="email"
            type="email"
            autoComplete={reset ? 'email' : 'username'}
            autoCapitalize="none"
            spellCheck={false}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          {children}
          {signup && (
            <>
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
              />
              {mismatch && (
                <p id="auth-password-mismatch" className="notice warning" role="alert">
                  Passwords don’t match. Enter the same password in both fields.
                </p>
              )}
            </>
          )}
          {trustOption}
        </fieldset>
        {error && (
          <p className="notice warning" role="alert">
            {error}
          </p>
        )}
        <button className="button button-gold" type="submit" disabled={busy || opening}>
          {busy ? 'Please wait…' : submitLabel}
        </button>
      </form>
      {navigation}
    </>
  );
}
