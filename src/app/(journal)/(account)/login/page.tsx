import type { Metadata } from 'next';
import { AccountAccess } from '@/features/Account/features/AccountAccess/AccountAccess';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to Arcana Journal to access your saved tarot readings across devices.',
};

const Page = () => {
  return <AccountAccess mode="signIn" />;
};

export default Page;
