import { useRouter } from 'next/navigation';
import { createContext, useContext, type ComponentProps } from 'react';
import type Link from 'next/link';

export const NativeNavigationContext = createContext<(path: string, replace: boolean) => void>(
  () => {},
);

// Vitest does not run Next's navigation dispatcher. Exercise the real page components
// and their session with links connected to each test's in-memory router.
const TestLink = ({
  href,
  prefetch,
  replace,
  onClick,
  onNavigate,
  children,
  ...props
}: ComponentProps<typeof Link>) => {
  const router = useRouter();
  const navigateNative = useContext(NativeNavigationContext);
  return (
    <a
      {...props}
      href={String(href)}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        let cancelled = false;
        const previousUrl = window.location.href;
        const previousLength = window.history.length;
        onNavigate?.({
          preventDefault: () => {
            cancelled = true;
          },
        });
        if (cancelled) {
          if (window.location.href !== previousUrl)
            navigateNative(window.location.pathname, window.history.length === previousLength);
        } else if (replace) router.replace(String(href));
        else router.push(String(href));
      }}
    >
      {children}
    </a>
  );
};

export default TestLink;
