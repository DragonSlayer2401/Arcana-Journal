import type { Metadata } from 'next';
import { AccountAccess } from '@/features/Account/features/AccountAccess/AccountAccess';

export const metadata: Metadata = {
  title: 'Reset password',
  description: 'Request a password reset link for your Arcana Journal account.',
};

const Page = () => {
  return <AccountAccess mode="reset" />;
};

export default Page;
