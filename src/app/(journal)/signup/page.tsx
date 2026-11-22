import type { Metadata } from 'next';
import { AccountForm } from '../../../components/AccountForm';

export const metadata: Metadata = {
  title: 'Create account',
  description:
    'Create an Arcana Journal account and verify your email to sync tarot readings across your devices.',
};

export default function Page() {
  return <AccountForm mode="signUp" />;
}
