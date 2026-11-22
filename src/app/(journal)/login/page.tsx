import type { Metadata } from 'next';
import { AccountForm } from '../../../components/AccountForm';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to Arcana Journal to access your saved tarot readings across devices.',
};

export default function Page() {
  return <AccountForm mode="signIn" />;
}
