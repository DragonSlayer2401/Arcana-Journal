import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
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
import { NativeNavigationContext } from './TestLink';

const pages = new Map([
  ['/', Reading],
  ['/deck', DeckCatalog],
  ['/journal', Journal],
  ['/login', Login],
  ['/signup', Signup],
  ['/reset-password', ResetPassword],
]);
const RenderedRouteContext = createContext('/');

export const TestApp = () => {
  const Page = pages.get(useContext(RenderedRouteContext))!;
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

interface TestRoute {
  path: string;
  renderedRoute: string;
  state: unknown;
}

export const TestRouter = ({ children, path = '/' }: { children: ReactNode; path?: string }) => {
  const [routes, setRoutes] = useState<TestRoute[]>([{ path, renderedRoute: path, state: null }]);
  const [position, setPosition] = useState(0);
  const current = routes[position];
  // Each mounted test app owns its history. Native navigation keeps its current page mounted.
  useLayoutEffect(() => {
    window.history.replaceState(current.state, '', current.path);
  }, [current]);
  const navigate = (next: TestRoute, replace: boolean) => {
    if (replace) {
      const updated = [...routes];
      updated[position] = next;
      setRoutes(updated);
    } else {
      setRoutes([...routes.slice(0, position + 1), next]);
      setPosition(position + 1);
    }
  };
  const navigatePage = (path: string, replace: boolean) =>
    navigate({ path, renderedRoute: path, state: null }, replace);
  const navigateNative = (path: string, replace: boolean) =>
    navigate({ path, renderedRoute: current.renderedRoute, state: window.history.state }, replace);
  const router: AppRouterInstance = {
    push: (path) => navigatePage(path, false),
    replace: (path) => navigatePage(path, true),
    refresh() {},
    prefetch() {},
    back: () => setPosition(Math.max(0, position - 1)),
    forward: () => setPosition(Math.min(routes.length - 1, position + 1)),
    bfcacheId: current.path,
  };
  return (
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={current.path}>
        <NativeNavigationContext.Provider value={navigateNative}>
          <RenderedRouteContext.Provider value={current.renderedRoute}>
            {children}
          </RenderedRouteContext.Provider>
        </NativeNavigationContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
};
