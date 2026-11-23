type AuthSdk = typeof import('./firebaseAuth');
type FirestoreSdk = typeof import('./firebaseFirestore');

// The first account observer must attach synchronously in the browser to see
// restored sessions and changes from another tab. The server compiler removes
// this browser branch, so rendering the public pages never imports Firebase.
export const browserAuthSdk = (): AuthSdk => {
  if (typeof window !== 'undefined') return require('./firebaseAuth') as AuthSdk;
  throw new Error('Journal accounts require a browser.');
};

let firestore: FirestoreSdk | undefined;
export const loadFirestoreSdk = async () => {
  if (typeof window !== 'undefined') return (firestore ??= await import('./firebaseFirestore'));
  throw new Error('Journal accounts require a browser.');
};

// The database accessors load the SDK before returning a Firestore client.
export const firestoreSdk = (): FirestoreSdk => {
  if (!firestore) throw new Error('The account journal database has not been opened.');
  return firestore;
};
