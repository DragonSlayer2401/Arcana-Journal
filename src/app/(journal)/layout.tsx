import type { ReactNode } from 'react';
import { connection } from 'next/server';
import JournalShell from './JournalShell';

export default async function JournalLayout({ children }: { children: ReactNode }) {
  await connection();
  return <JournalShell>{children}</JournalShell>;
}
