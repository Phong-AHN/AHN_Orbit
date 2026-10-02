import type { Metadata, Viewport } from 'next';
import { Fraunces, Source_Sans_3 } from 'next/font/google';
import { ToastProvider } from '@orbit/ui';
import './globals.css';

/**
 * The two faces, self-hosted by `next/font` at build time.
 *
 * **`vietnamese` is not optional.** Client, brand and workspace names reach
 * headings and body text directly, and this is a Vietnamese agency — a face
 * without the subset renders "Nguyễn" with substituted glyphs from a fallback
 * font, which looks like a rendering bug rather than a missing subset. Both
 * faces were checked against Google's own subset list before being chosen.
 *
 * Each exposes a CSS variable rather than a class, so `tokens.css` owns the
 * fallback stack and nothing has to thread a font class through 34 layouts.
 */
const display = Fraunces({
  subsets: ['latin', 'vietnamese'],
  // Fraunces is variable on both axes; optical sizing is why it was chosen, so
  // the range is kept rather than pinned to one instance.
  // No `weight`: next/font rejects `axes` alongside a fixed weight list, and
  // leaving it out is what keeps the face variable — the whole weight range
  // plus the optical sizing it was chosen for.
  axes: ['SOFT', 'WONK'],
  variable: '--font-display',
  display: 'swap',
});

const body = Source_Sans_3({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});

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
  // Kept in step with `--canvas` in tokens.css by hand: the browser chrome
  // cannot read a CSS variable, so a palette change has to be mirrored here.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f2f3ea' },
    { media: '(prefers-color-scheme: dark)', color: '#15160f' },
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
    <html lang="en" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh bg-canvas font-sans text-ink antialiased" suppressHydrationWarning>
        <a
          href="#main"
          className="sr-only rounded bg-accent px-4 py-2 text-accent-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        {/* At the root so every surface — agency, portal and admin — gets the
            same feedback. `useToast` no-ops without it rather than throwing, so
            a page still works if this is ever removed. */}
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
