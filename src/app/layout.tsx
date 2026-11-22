import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.scss';

export const metadata: Metadata = {
  title: { default: 'Arcana Journal · Tarot Readings', template: 'Arcana Journal · %s' },
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

const RootLayout = ({ children }: { children: ReactNode }) => {
  return (
    <html lang="en">
      {/* Browser extensions such as Grammarly add body attributes before hydration. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
};

export default RootLayout;
