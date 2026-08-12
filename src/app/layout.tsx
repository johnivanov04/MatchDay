import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Matchday',
    template: '%s · Matchday',
  },
  description:
    'Matchday organises pickup matches for multiple leagues: membership, signup, rosters, waitlists and teams in one place.',
  // iOS reads this rather than the manifest's icon list when somebody adds the
  // site to their home screen. Without it iOS uses a screenshot of the page as
  // the icon, which is the difference between an installed app and something
  // that looks broken. It is not a prerequisite for Web Push — being on the
  // home screen is, and that works either way.
  icons: { apple: '/apple-touch-icon.png' },
  appleWebApp: {
    capable: true,
    title: 'Matchday',
    // The header sits under the status bar in standalone mode, so a translucent
    // bar would put the status text on top of it.
    statusBarStyle: 'default',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#14181c' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-pitch-600 focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
