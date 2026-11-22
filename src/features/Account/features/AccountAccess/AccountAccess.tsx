import { AccountDialogLink } from './components/AccountDialogLink';
import { AccountModal } from './components/AccountModal';
import { AccountFields, SignedOutAccount, type AccountMode } from './components/AccountFields';

const content = {
  signIn: { title: 'Sign in', description: 'Open your journal on this device.' },
  signUp: {
    title: 'Create account',
    description: 'Verify your email to sync readings across your devices.',
  },
  reset: {
    title: 'Reset password',
    description: 'Enter your account email to request a password reset link.',
  },
};

type AccountAccessProps = { mode: AccountMode } & (
  | { presentation?: 'standalone'; onClose?: never }
  | { presentation: 'modal'; onClose: () => void }
);

export const AccountAccess = ({ mode, presentation, onClose }: AccountAccessProps) => {
  const { title, description } = content[mode];
  const signup = mode === 'signUp';
  const reset = mode === 'reset';
  const fields = (
    <AccountFields
      key={mode}
      mode={mode}
      submitLabel={reset ? 'Send reset email' : title}
      description={<p className="auth-description">{description}</p>}
      navigation={
        <div className="auth-links">
          {mode === 'signIn' ? (
            <>
              <AccountDialogLink href="/reset-password">Forgot password?</AccountDialogLink>
              <AccountDialogLink href="/signup">Create account</AccountDialogLink>
            </>
          ) : (
            <AccountDialogLink href="/login">
              {reset ? 'Back to sign in' : 'Sign in'}
            </AccountDialogLink>
          )}
        </div>
      }
      trustOption={
        !reset && (
          <label className="auth-trust">
            <input name="trusted" type="checkbox" />
            Stay signed in and keep my journal available offline on this trusted device.
          </label>
        )
      }
    >
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
          />
          {signup && (
            <p className="auth-hint" id="auth-password-hint">
              Use at least 6 characters.
            </p>
          )}
        </>
      )}
    </AccountFields>
  );
  return (
    <SignedOutAccount>
      {presentation === 'modal' ? (
        <AccountModal title={title} onClose={onClose}>
          {fields}
        </AccountModal>
      ) : (
        <section className="auth-page" aria-labelledby="auth-title">
          <h1 id="auth-title">{title}</h1>
          {fields}
        </section>
      )}
    </SignedOutAccount>
  );
};
