import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  SESSION_COOKIE_NAME,
  listAccessibleOrganizations,
  requireSession,
  resolveUser,
  type AuthenticatedUser,
} from '@orbit/auth';
import { agentEnabledFor, agentsEnabledAnywhere } from '@/features/agent/availability';
import { OAuthError, validateAuthorizationRequest } from '@/features/agent/oauth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect an AI app',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SCOPES: Array<{ scope: string; label: string; detail: string }> = [
  {
    scope: 'read',
    label: 'Read your workspace',
    detail: 'Brands, accounts, posts, calendar, analytics and reports you can see.',
  },
  {
    scope: 'content',
    label: 'Draft content',
    detail:
      'Create and edit ideas and drafts, write captions with AI, send drafts to internal review.',
  },
  {
    scope: 'workflow',
    label: 'Publish and schedule',
    detail:
      'Prepare scheduling, publishing, approvals and sending to clients. Each one waits for your confirmation in Social Square.',
  },
  {
    scope: 'engagement',
    label: 'Inbox and comments',
    detail:
      'Read private messages and comments, draft replies. Every reply waits for your confirmation in Social Square.',
  },
];

/**
 * The OAuth consent screen for MCP clients (D-109 §6).
 *
 * Shows who is asking (name, and the host the code goes back to), and lets the
 * person choose one organization and grant fewer permissions than requested.
 * An invalid request is shown here and never redirected — an unregistered
 * redirect URI is exactly what an attacker would supply. The page cannot be
 * framed (`X-Frame-Options: DENY` site-wide), so it cannot be clickjacked.
 */
export default async function AuthorizePage({ searchParams }: PageProps) {
  if (!agentsEnabledAnywhere()) notFound();

  const raw = await searchParams;
  const params = new URLSearchParams(
    Object.entries(raw).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])),
  );

  let request;
  try {
    request = await validateAuthorizationRequest(params);
  } catch (error) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-ink">This connection request is not valid</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          {error instanceof OAuthError
            ? error.description
            : 'Start the connection again from the AI app.'}
        </p>
      </Shell>
    );
  }

  let user: AuthenticatedUser;
  try {
    user = await resolveUser(
      await requireSession((await cookies()).get(SESSION_COOKIE_NAME)?.value),
    );
  } catch {
    redirect(`/sign-in?next=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`);
  }

  const organizations = (await listAccessibleOrganizations(user.id)).filter(
    (org) => org.role !== 'CLIENT' && agentEnabledFor(org),
  );
  const redirectHost = new URL(request.redirectUri).host;

  return (
    <Shell>
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">Social Square</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
        Allow “{request.clientName}” to act for you?
      </h1>
      <p className="mt-2 text-sm text-ink-secondary">
        Signed in as <span className="text-ink">{user.email}</span>. After you allow it, you are
        sent back to <span className="font-mono text-ink">{redirectHost}</span>. Only continue if
        you started this from an AI app you trust.
      </p>

      {organizations.length === 0 ? (
        <p className="mt-6 rounded-md border border-line bg-surface-sunken px-4 py-3 text-sm text-ink">
          None of your organizations can use AI apps yet.
        </p>
      ) : (
        <form method="post" action="/oauth/authorize/decision" className="mt-6 space-y-5">
          {[...params.entries()].map(([key, value]) => (
            <input key={key} type="hidden" name={`req_${key}`} value={value} />
          ))}

          <label className="block text-sm">
            <span className="font-medium text-ink">Organization</span>
            <select
              name="organizationId"
              required
              className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-ink"
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">It may</legend>
            {SCOPES.filter((s) => (request.scopes as string[]).includes(s.scope)).map((s) => (
              <label
                key={s.scope}
                className="flex gap-3 rounded-md border border-line bg-surface px-4 py-3 text-sm"
              >
                <input type="checkbox" name="scope" value={s.scope} defaultChecked />
                <span>
                  <span className="block font-medium text-ink">{s.label}</span>
                  <span className="block text-ink-secondary">{s.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <p className="text-xs text-ink-muted">
            It can never do more than your own role allows, cannot connect or remove accounts,
            manage members, delete anything or see billing. Revoke it at any time in Settings →
            Connected AI apps.
          </p>

          <div className="flex gap-3">
            <button
              type="submit"
              name="decision"
              value="allow"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink"
            >
              Allow
            </button>
            <button
              type="submit"
              name="decision"
              value="deny"
              className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="mx-auto max-w-xl px-6 py-16">
      {children}
    </main>
  );
}
