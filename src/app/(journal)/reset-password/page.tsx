import type { Metadata } from 'next';
import { AccountForm } from '../../../components/AccountForm';

export const metadata: Metadata = {
  title: 'Reset password',
  description: 'Request a password reset link for your Arcana Journal account.',
};

export default function Page() {
  return (
    <AccountForm
      mode="reset"
      heading={<h1 id="auth-title">Reset password</h1>}
      description={
        <p className="auth-description">
          Enter your account email to request a password reset link.
        </p>
      }
    />
  );
}
