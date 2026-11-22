import workerSource from './storageLock.worker.js?raw';

export class StorageLockUnavailableError extends Error {}

// Both routes acquire the same origin-wide Web Lock, including across tabs
// with different window permissions. Bundling the worker also supports offline use.
export const withStorageLock = async <T>(
  name: string,
  operation: () => T | Promise<T>,
): Promise<T> => {
  let started = false;
  try {
    if (navigator.locks) {
      return await navigator.locks.request(name, () => {
        started = true;
        return operation();
      });
    }
  } catch (error) {
    if (started) throw error;
  }
  let worker: Worker | undefined;
  let url: string | undefined;
  try {
    url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    worker = new Worker(url);
    const broker = worker;
    await new Promise<void>((resolve, reject) => {
      broker.onerror = reject;
      broker.onmessage = ({ data }) => (data === true ? resolve() : reject());
      broker.postMessage(name);
    });
  } catch {
    worker?.terminate();
    if (url) URL.revokeObjectURL(url);
    throw new StorageLockUnavailableError('This browser cannot coordinate storage across tabs.');
  }
  try {
    return await operation();
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
};
