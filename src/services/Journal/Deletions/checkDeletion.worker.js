import { checkDeletion } from './deletionStore';

// Only the presence of a matching request leaves the worker.
self.onmessage = async ({ data }) => {
  try {
    self.postMessage(await checkDeletion(data));
  } catch {
    self.postMessage(null);
  }
};
