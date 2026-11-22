import { afterEach, beforeEach } from 'vitest';

// Routed jsdom tests exercise the production guest write queue. Provide the
// browser's exclusive lock primitive for their single browsing context.
beforeEach(() => {
  const queues = new Map<string, Promise<void>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (name: string, callback: (lock: Pick<Lock, 'name' | 'mode'>) => unknown) => {
        if (typeof callback !== 'function') throw new Error('Only exclusive locks are available.');
        const previous = queues.get(name) ?? Promise.resolve();
        const operation = previous.then(() => callback({ name, mode: 'exclusive' }));
        const settled = operation.then(
          () => {},
          () => {},
        );
        queues.set(name, settled);
        try {
          return await operation;
        } finally {
          if (queues.get(name) === settled) queues.delete(name);
        }
      },
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
});
