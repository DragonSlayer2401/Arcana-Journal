export type OfflineStatus = 'checking' | 'ready' | 'unavailable' | 'error';

/** Report readiness only after the controlling worker checks every required asset. */
export const subscribeOfflineStatus = (
  callback: (status: OfflineStatus, updateAvailable: boolean) => void,
): (() => void) => {
  let disposed = false;
  let registration: ServiceWorkerRegistration | undefined;
  let pendingUpdate: ServiceWorker | undefined;
  let cancelCheck: (() => void) | undefined;
  let sequence = 0;
  const cleanups = new Set<() => void>();
  const watched = new WeakSet<ServiceWorker>();
  const report = (status: OfflineStatus) => {
    if (!disposed)
      callback(status, Boolean(registration?.waiting || pendingUpdate?.state === 'installed'));
  };

  if (!import.meta.env.PROD || !globalThis.isSecureContext || !('serviceWorker' in navigator)) {
    report('unavailable');
    return () => {
      disposed = true;
    };
  }

  const check = () => {
    if (disposed) return;
    const request = ++sequence;
    // Replace an unfinished check; completed checks retain no callback or timer.
    cancelCheck?.();
    const worker = navigator.serviceWorker.controller;
    if (!worker) {
      report('checking');
      return;
    }
    const channel = new MessageChannel();
    let settled = false;
    const finish = (status: OfflineStatus) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      if (cancelCheck === cancel) cancelCheck = undefined;
      if (request === sequence) report(status);
    };
    const cancel = () => finish('error');
    const timeout = globalThis.setTimeout(() => finish('error'), 8000);
    cancelCheck = cancel;
    channel.port1.onmessage = (event: MessageEvent<{ type?: string; ready?: boolean }>) => {
      if (event.data?.type === 'OFFLINE_STATUS')
        finish(event.data.ready === true ? 'ready' : 'error');
    };
    try {
      worker.postMessage({ type: 'CHECK_OFFLINE' }, [channel.port2]);
    } catch {
      finish('error');
    }
  };

  const watchWorker = (worker: ServiceWorker | null) => {
    if (!worker || watched.has(worker)) return;
    watched.add(worker);
    const cleanup = () => {
      worker.removeEventListener('statechange', onState);
      cleanups.delete(cleanup);
    };
    const onState = () => {
      // The state event may precede registration.waiting becoming observable.
      // Track the installed successor itself so the update notice is not lost.
      if (
        worker.state === 'installed' &&
        navigator.serviceWorker.controller &&
        worker !== navigator.serviceWorker.controller
      ) {
        pendingUpdate = worker;
      }
      if (worker.state === 'activated' || worker.state === 'redundant') {
        if (pendingUpdate === worker) pendingUpdate = undefined;
        cleanup();
      }
      if (worker.state === 'redundant' && !navigator.serviceWorker.controller) report('error');
      else check();
    };
    worker.addEventListener('statechange', onState);
    cleanups.add(cleanup);
    onState();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };
  navigator.serviceWorker.addEventListener('controllerchange', check);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', onVisible);
  cleanups.add(() => {
    navigator.serviceWorker.removeEventListener('controllerchange', check);
    window.removeEventListener('focus', check);
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', onVisible);
  });

  report('checking');
  void navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then((value) => {
      if (disposed) return;
      registration = value;
      const onUpdate = () => watchWorker(value.installing);
      value.addEventListener('updatefound', onUpdate);
      cleanups.add(() => value.removeEventListener('updatefound', onUpdate));
      watchWorker(value.installing);
      watchWorker(value.waiting);
      check();
      // No skipWaiting message and no page reload: the active reading is untouched.
    })
    .catch(() => {
      if (navigator.serviceWorker.controller) check();
      else report('error');
    });

  return () => {
    disposed = true;
    sequence += 1;
    cancelCheck?.();
    cleanups.forEach((cleanup) => cleanup());
    cleanups.clear();
  };
};
