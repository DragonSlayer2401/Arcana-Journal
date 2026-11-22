import type { ReactNode } from 'react';
import JournalProvider from '../../JournalProvider';
import { Icon } from '../../components/Icons';
import { JournalHeader, JournalNotices, OfflineStatus } from '../../components/JournalChrome';
import { JournalDialogs } from '../../components/JournalDialogs';

export default function JournalShell({ children }: { children: ReactNode }) {
  return (
    <JournalProvider>
      <div className="app-shell">
        <JournalHeader>
          <span className="brand-symbol">
            <Icon name="spark" size={27} />
          </span>
          <span>
            Arcana Journal
            <span className="wordmark-caption">A LITTLE SPACE FOR REFLECTION</span>
          </span>
        </JournalHeader>
        <main id="main">
          <JournalNotices />
          {children}
        </main>
        <footer className="site-footer">
          <span>Made for a moment of reflection.</span>
          <OfflineStatus />
        </footer>
        <JournalDialogs>
          <div className="help-content">
            <p>
              A complete 78-card tarot deck, a private journal, and a quiet space to reflect. Free
              to use, with no account or connection needed after offline setup.
            </p>
            <h3>Fair draws, explained</h3>
            <p>
              Each reading uses cryptographically secure random draws with unbiased shuffling. Web
              Crypto supplies unsigned 32-bit values; rejection sampling removes modulo bias.
              Fisher–Yates shuffles a fresh full deck once, then takes your chosen number of cards
              without replacement.
            </p>
            <p>
              Your question, past readings, meanings, and animations never enter the selection
              algorithm. Separate readings can repeat, even in full. With reversals enabled, each
              drawn card independently gets a secure 50/50 orientation. Without Web Crypto, drawing
              stops with an error.
            </p>
            <h3>Keep it on your iPhone</h3>
            <ol>
              <li>Open the deployed HTTPS address in Safari.</li>
              <li>Tap Share, then Add to Home Screen.</li>
              <li>Enable Open as Web App if shown, then tap Add.</li>
              <li>
                Open Arcana Journal from that icon while online. Wait for “Ready for offline use”
                before disconnecting.
              </li>
            </ol>
            <p>
              Updates wait until all app windows are closed. A cached update never reloads an active
              reading.
            </p>
            <h3>Where your journal is saved</h3>
            <p>
              Guest readings stay in this browser or installed app. Sign in and verify your email on
              the Journal page to sync account readings across devices. To bring over existing
              readings, choose Import this device’s journal and review the destination. Export
              journal saves a portable backup. Anyone with the file can read its contents.
            </p>
            <h3>The deck</h3>
            <p>
              All 78 cards illustrate the traditional Rider–Waite–Smith scenes, with newly created
              artwork in a textured, colorful style. The original scenes were illustrated by Pamela
              Colman Smith for Arthur Edward Waite. Artwork and fixed upright and reversed meanings
              are bundled on your device. No image or AI service is needed to use the app.
            </p>
            <p className="help-footnote">
              Card meanings offer prompts for reflection, not promises about what will happen.
            </p>
          </div>
        </JournalDialogs>
      </div>
    </JournalProvider>
  );
}
