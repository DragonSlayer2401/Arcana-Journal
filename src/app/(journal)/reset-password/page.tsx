import type { Metadata } from 'next';
import { AccountForm } from '../../../components/AccountForm';

export const metadata: Metadata = {
  title: 'Reset password',
  description: 'Request a password reset link for your Arcana Journal account.',
};

export default function Page() {
  return <AccountForm mode="reset" />;
}
