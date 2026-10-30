import type { Metadata } from 'next';
import Link from 'next/link';
import { clock } from '@orbit/core';
import { cn } from '@orbit/ui';

/**
 * The public homepage.
 *
 * Platform reviewers (TikTok, Meta, Google) open the website URL and expect a
 * real website about the product — not a sign-in page — with the same icon as
 * the app they were given, and the legal pages one click away. Everything here
 * describes what the product actually does today; nothing is promised that
 * the app does not ship.
 */

export const metadata: Metadata = {
  title: { absolute: 'Social Square — social media management for agencies' },
  description:
    'Plan, create, approve, schedule and publish social content for every client, then answer comments and messages and report on results — in one place.',
};

const CONTACT = 'phong@ahnmedia.com';

const PLATFORMS = [
  'Facebook',
  'Instagram',
  'TikTok',
  'YouTube',
  'LinkedIn',
  'Pinterest',
  'Threads',
];

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: 'Plan and create',
    body: 'A shared calendar per client and brand. Ideas become drafts, with captions, hashtags and images written with AI in each brand’s own voice.',
  },
  {
    title: 'Approve with your clients',
    body: 'Internal review, then client approval in a dedicated client portal. Every comment and decision is kept, so nothing goes out unapproved.',
  },
  {
    title: 'Schedule and publish',
    body: 'One post, adapted per platform and checked against each platform’s rules, published at the right time — exactly once, with a clear status for every account.',
  },
  {
    title: 'Comments and messages',
    body: 'One inbox for comments and private messages across connected accounts, with replies drafted from each brand’s own documents.',
  },
  {
    title: 'Analytics and reports',
    body: 'Performance per post and per account, compared period to period, exported as client-ready reports. Missing data is shown as missing, never as zero.',
  },
  {
    title: 'Teams and roles',
    body: 'Owners, account managers, creators, approvers and clients each see exactly what their role allows — enforced on the server, for every request.',
  },
];

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: 'Connect your clients’ accounts',
    body: 'Sign in with each platform’s official login. Social Square only requests the permissions it uses, and you can disconnect at any time.',
  },
  {
    title: 'Create and get approval',
    body: 'Draft once, tailor each version, and send it to your team and your client for approval.',
  },
  {
    title: 'Publish and report',
    body: 'Schedule it, let Social Square publish it, then follow the results and share a report.',
  },
];

export default function HomePage() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5 font-semibold">
            {/* The same icon as the favicon and the app listings. */}
            <img
              src="/brand/social-square-icon-512.png"
              alt=""
              width={32}
              height={32}
              className="rounded-md"
            />
            Social Square
          </Link>
          <nav
            aria-label="Main"
            className="ml-auto hidden items-center gap-6 text-sm text-ink-secondary sm:flex"
          >
            <a href="#features" className="hover:text-ink">
              Features
            </a>
            <a href="#platforms" className="hover:text-ink">
              Platforms
            </a>
            <a href="#security" className="hover:text-ink">
              Security
            </a>
            <a href="#contact" className="hover:text-ink">
              Contact
            </a>
          </nav>
          <Link
            href="/sign-in"
            className={cn(
              'ml-auto inline-flex h-9 items-center rounded px-4 text-sm font-medium sm:ml-0',
              'bg-accent text-accent-ink hover:bg-accent-hover',
            )}
          >
            Sign in
          </Link>
        </div>
      </header>

      <main id="main">
        <section className="mx-auto max-w-6xl px-6 pb-16 pt-20">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
            Social media management for agencies
          </p>
          <h1 className="mt-4 max-w-3xl font-display text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Every client’s social media, planned, approved and published in one place.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-ink-secondary">
            Social Square helps marketing agencies run content for many brands at once — from the
            first idea to the published post, the comments it gets and the report the client reads.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/sign-in"
              className="inline-flex h-11 items-center rounded bg-accent px-5 text-sm font-medium text-accent-ink hover:bg-accent-hover"
            >
              Sign in to Social Square
            </Link>
            <Link
              href="/sign-in/client"
              className="text-sm font-medium text-accent hover:underline"
            >
              Client portal
            </Link>
            <a href="#contact" className="text-sm font-medium text-ink-secondary hover:text-ink">
              Talk to us
            </a>
          </div>
        </section>

        <section id="features" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="font-display text-2xl font-semibold tracking-tight">What it does</h2>
            <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="rounded-lg border border-line bg-canvas p-5">
                  <h3 className="font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="platforms" className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="font-display text-2xl font-semibold tracking-tight">Works with</h2>
            <p className="mt-2 max-w-2xl text-ink-secondary">
              Connected through each platform’s official API and login, using only the permissions
              each feature needs.
            </p>
            <ul className="mt-6 flex flex-wrap gap-3">
              {PLATFORMS.map((platform) => (
                <li
                  key={platform}
                  className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium"
                >
                  {platform}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="font-display text-2xl font-semibold tracking-tight">How it works</h2>
            <ol className="mt-8 grid gap-6 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="rounded-lg border border-line bg-canvas p-5">
                  <span className="font-mono text-xs text-accent">Step {index + 1}</span>
                  <h3 className="mt-1 font-semibold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-8 px-6 py-16 md:grid-cols-2">
            <div>
              <h2 className="font-display text-2xl font-semibold tracking-tight">
                AI that works for you, not instead of you
              </h2>
              <p className="mt-3 text-ink-secondary">
                Squire, the built-in assistant, plans content, writes captions, creates images and
                drafts replies when you ask in plain language. It can only do what your role allows,
                and anything that goes out — a post, a schedule, a reply — waits for you to confirm
                it.
              </p>
            </div>
            <ul className="space-y-3 text-sm text-ink-secondary">
              <li className="rounded-lg border border-line bg-surface p-4">
                Content ideas grounded in each brand’s voice and what performed well.
              </li>
              <li className="rounded-lg border border-line bg-surface p-4">
                Captions, hashtags and platform versions written in the brand’s tone.
              </li>
              <li className="rounded-lg border border-line bg-surface p-4">
                Images generated for a post and saved to the media library, labelled as AI-made.
              </li>
              <li className="rounded-lg border border-line bg-surface p-4">
                Suggested replies to comments and messages from the brand’s own documents.
              </li>
            </ul>
          </div>
        </section>

        <section id="security" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="font-display text-2xl font-semibold tracking-tight">
              Security and privacy
            </h2>
            <div className="mt-6 grid gap-6 text-sm leading-relaxed text-ink-secondary md:grid-cols-3">
              <p>
                <strong className="block text-ink">Each agency’s data is separate.</strong>
                Isolation is enforced in the application and in the database for every request.
              </p>
              <p>
                <strong className="block text-ink">Credentials are encrypted.</strong>
                Platform tokens are encrypted at rest and never shown to anyone, including our
                staff.
              </p>
              <p>
                <strong className="block text-ink">Only what is needed.</strong>
                We request the platform permissions each feature uses, and you can disconnect an
                account or delete your data at any time.
              </p>
            </div>
          </div>
        </section>

        <section id="contact" className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="font-display text-2xl font-semibold tracking-tight">Contact</h2>
            <p className="mt-3 text-ink-secondary">
              Questions, support or access for your agency:{' '}
              <a href={`mailto:${CONTACT}`} className="font-medium text-accent hover:underline">
                {CONTACT}
              </a>
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 text-sm text-ink-muted">
          <span>© {clock.now().getUTCFullYear()} AHN Group · Social Square</span>
          <Link href="/privacy-policy" className="hover:underline">
            Privacy policy
          </Link>
          <Link href="/terms-of-service" className="hover:underline">
            Terms of service
          </Link>
          <Link href="/data-deletion" className="hover:underline">
            Data deletion
          </Link>
          <a href={`mailto:${CONTACT}`} className="hover:underline">
            {CONTACT}
          </a>
        </div>
      </footer>
    </div>
  );
}
