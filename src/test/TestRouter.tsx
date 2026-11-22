import { useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import JournalShell from '@/features/Journal/Journal';
import Reading from '../app/(journal)/page';
import { DeckCatalog } from '@/features/Tarot/features/DeckCatalog/DeckCatalog';
import Journal from '../app/(journal)/journal/page';
import AccountLayout from '../app/(journal)/(account)/layout';
import Login from '../app/(journal)/(account)/login/page';
import Signup from '../app/(journal)/(account)/signup/page';
import ResetPassword from '../app/(journal)/(account)/reset-password/page';

const pages = new Map([
  ['/', Reading],
  ['/deck', DeckCatalog],
  ['/journal', Journal],
  ['/login', Login],
  ['/signup', Signup],
  ['/reset-password', ResetPassword],
]);
export const TestApp = () => {
  const pathname = usePathname();
  const Page = pages.get(pathname)!;
  const isAccountPage = Page === Login || Page === Signup || Page === ResetPassword;
  return (
    <JournalShell>
      {isAccountPage ? (
        <AccountLayout>
          <Page />
        </AccountLayout>
      ) : (
        <Page />
      )}
    </JournalShell>
  );
};

// Each mounted app gets its own URL, like two separate browser tabs.
export const TestRouter = ({ children, path = '/' }: { children: ReactNode; path?: string }) => {
  const [pathname, setPath] = useState(path);
  const router: AppRouterInstance = {
    push: setPath,
    replace: setPath,
    refresh() {},
    prefetch() {},
    back() {},
    forward() {},
    bfcacheId: pathname,
  };
  return (
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>{children}</PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
};
