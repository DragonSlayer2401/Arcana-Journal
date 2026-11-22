'use client';
import { useJournalSession } from '../../../App';
import { CardLibrary } from '../../../components/CardLibrary';

export default function Deck() {
  const { opening } = useJournalSession();
  return <CardLibrary opening={opening} />;
}
