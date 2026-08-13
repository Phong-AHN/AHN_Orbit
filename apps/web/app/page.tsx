import Link from 'next/link';
import { Badge, Card, CardBody, CardTitle, cn } from '@orbit/ui';

/**
 * The signed-out entry point. Replaced by a marketing site in a later phase.
 */
export default function HomePage() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6 py-16">
      <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-accent">
        AHN Group · content operations
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-ink">AHN Orbit</h1>
      <p className="mt-3 max-w-prose text-ink-muted">
        Plan, approve, schedule and publish social content for every client and brand — with an
        auditable trail from idea to published.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link
          href="/sign-in"
          className={cn(
            'inline-flex h-9 items-center justify-center rounded px-4',
            'bg-accent text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover',
          )}
        >
          Sign in
        </Link>
        <Badge tone="neutral">Phase 1 · complete</Badge>
      </div>

      <Card className="mt-12">
        <CardBody className="space-y-2">
          <CardTitle>Build status</CardTitle>
          <p className="text-sm text-ink-muted">
            Composing, approvals, scheduling, exactly-once publishing, the client portal and the
            agency dashboard all work end to end. Publishing runs against a development provider —
            real posting waits on Meta App Review.
          </p>
        </CardBody>
      </Card>

      {/* App Review checks that the policy is reachable from the app, not only
          by its URL. */}
      <footer className="mt-12 border-t border-line pt-6">
        <Link href="/privacy-policy" className="text-sm text-ink-muted hover:underline">
          Privacy policy
        </Link>
      </footer>
    </main>
  );
}
