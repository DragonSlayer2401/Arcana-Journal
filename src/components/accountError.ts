export const accountError = (
  cause: unknown,
  credentialMessage = 'Check your email address and password and try again.',
): string => {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : '';
  switch (code) {
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-login-credentials':
    case 'auth/invalid-credential':
      return credentialMessage;
    case 'auth/email-already-in-use':
      return 'This email already has an account. Sign in or reset your password.';
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'Choose a stronger password and try again.';
    case 'auth/network-request-failed':
      return 'Connect to the internet and try again.';
    case 'auth/too-many-requests':
      return 'Please wait a few minutes and try again.';
    case 'auth/operation-not-allowed':
      return 'Email sign-in is currently unavailable.';
    default:
      return cause instanceof Error && !code
        ? cause.message
        : 'The account request could not finish. Please try again.';
  }
};
