import type { ReactNode } from 'react';
import { AccountRouteContent } from '@/features/Account/features/AccountAccess/components/AccountDialogHost';
import { History } from '@/features/Journal/features/History/History';

const AccountLayout = ({ children }: { children: ReactNode }) => (
  <AccountRouteContent background={<History />}>{children}</AccountRouteContent>
);

export default AccountLayout;
