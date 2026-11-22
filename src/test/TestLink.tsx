import { useRouter } from 'next/navigation';
import type { ComponentProps } from 'react';
import type Link from 'next/link';

// Vitest does not run Next's navigation dispatcher. Exercise the real page components
// and their session with links connected to each test's in-memory router.
export default function TestLink({
  href,
  prefetch,
  onClick,
  children,
  ...props
}: ComponentProps<typeof Link>) {
  const router = useRouter();
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
        router.push(String(href));
      }}
    >
      {children}
    </a>
  );
}
