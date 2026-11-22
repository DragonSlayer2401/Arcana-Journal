// A dedicated worker shares the origin's Web Locks and terminates with its tab.
// The caller terminates this worker immediately after its storage operation.
self.onmessage = ({ data: lockName }) => {
  void (async () => {
    try {
      await navigator.locks.request(lockName, () => {
        self.postMessage(true);
        return new Promise(() => {});
      });
    } catch {
      self.postMessage(false);
    }
  })();
};
