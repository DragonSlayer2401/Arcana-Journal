import type { ReactNode } from 'react';
import { connection } from 'next/server';
import App from '../../App';

export default async function JournalLayout({ children }: { children: ReactNode }) {
  await connection();
  return <App>{children}</App>;
}
