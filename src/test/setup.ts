import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom implements neither Web Locks nor IndexedDB. Serialize guest mutations
// within its single window; the browser suite exercises the real cross-tab locks.
vi.mock('../domain/guestWrite', () => {
  let previous: Promise<unknown> = Promise.resolve();
  return {
    waitForGuestWrites: () => previous,
    withGuestWrite: <T>(change: () => T) => {
      const next = previous.then(change);
      previous = next.catch(() => {});
      return next;
    },
  };
});
afterEach(cleanup);
