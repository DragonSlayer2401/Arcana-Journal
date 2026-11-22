import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../styles.css';
import '../components/AccountPanel.css';
import '../components/AccountForm.css';
import '../components/CardLibrary.css';

export const metadata: Metadata = {
  title: 'Arcana Journal · Tarot Readings',
  description:
    'A quiet space for tarot with an original 78-card deck. Keep your journal on this device or sign in to sync readings across devices.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: { url: '/icon.svg', type: 'image/svg+xml' },
    apple: { url: '/apple-touch-icon.png', sizes: '180x180' },
  },
  appleWebApp: { capable: true, title: 'Arcana Journal', statusBarStyle: 'black-translucent' },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#111222',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <noscript>
          Arcana Journal needs JavaScript to draw cards securely and keep your readings on this
          device.
        </noscript>
      </body>
    </html>
  );
}
