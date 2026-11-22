import { useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import JournalShell from '../app/(journal)/JournalShell';
import Reading from '../app/(journal)/page';
import Deck from '../app/(journal)/deck/page';
import Journal from '../app/(journal)/journal/page';
import Login from '../app/(journal)/login/page';
import Signup from '../app/(journal)/signup/page';
import ResetPassword from '../app/(journal)/reset-password/page';

const pages = new Map([
  ['/', Reading],
  ['/deck', Deck],
  ['/journal', Journal],
  ['/login', Login],
  ['/signup', Signup],
  ['/reset-password', ResetPassword],
]);
export const TestApp = () => {
  const Page = pages.get(usePathname())!;
  return (
    <JournalShell>
      <Page />
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
