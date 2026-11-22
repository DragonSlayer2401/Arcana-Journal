import type { Metadata } from 'next';
import { AccountAccess } from '@/features/Account/features/AccountAccess/AccountAccess';

export const metadata: Metadata = {
  title: 'Create account',
  description:
    'Create an Arcana Journal account and verify your email to sync tarot readings across your devices.',
};

const Page = () => {
  return <AccountAccess mode="signUp" />;
};

export default Page;
