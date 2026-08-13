import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'AHN Orbit',
    template: '%s · AHN Orbit',
  },
  description:
    'Multi-tenant social media and content operations for agencies — clients, brands, approvals, scheduling, publishing and analytics.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f7f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1514' },
  ],
};

/**
 * `suppressHydrationWarning` on `<html>` and `<body>`.
 *
 * Browser extensions write their own attributes onto these two elements before
 * React hydrates — Grammarly adds `data-gr-ext-installed`, password managers and
 * translators do similar. The server cannot know about them, so the mismatch is
 * real but never actionable, and the warning it produces buries the ones that
 * are.
 *
 * **This suppresses one level only.** React does not propagate it to children,
 * so a genuine mismatch inside any component still reports normally — the two
 * hydration bugs actually worth catching in this app are a locale-dependent date
 * and a `Date.now()` in a client component, and both would still be caught.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-canvas font-sans text-ink antialiased" suppressHydrationWarning>
        <a
          href="#main"
          className="sr-only rounded bg-accent px-4 py-2 text-accent-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
