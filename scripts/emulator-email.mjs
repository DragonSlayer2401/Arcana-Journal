import assert from 'node:assert/strict';

// Consume the same verification code that a mailbox owner would receive.
const emulator = 'http://127.0.0.1:9099';
export const verifyEmulatorEmail = async (email) => {
  const mailbox = await fetch(emulator + '/emulator/v1/projects/demo-arcana-journal/oobCodes');
  assert.ok(mailbox.ok, 'Could not open the local Auth emulator mailbox');
  const { oobCodes } = await mailbox.json();
  const message = oobCodes.find(
    (entry) => entry.email === email && entry.requestType === 'VERIFY_EMAIL',
  );
  assert.ok(message, 'Expected a verification email for the test account');
  const confirmation = await fetch(
    emulator + '/identitytoolkit.googleapis.com/v1/accounts:update?key=demo-arcana-journal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode: message.oobCode }),
    },
  );
  assert.ok(confirmation.ok, 'The Auth emulator rejected the verification code');
};
