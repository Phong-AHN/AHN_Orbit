import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { devIdentityProvider } from '@orbit/auth';
import { platformDb } from '@orbit/db';

/**
 * A client cannot reach an agency *page*, not just an agency *endpoint*.
 *
 * ## The gap this covers
 *
 * `with-auth.ts` has always refused a `CLIENT` principal on every agency route
 * with `assertNotClient`, and `portal-context.ts` states the rule behind it:
 * "a page must not be able to reach data by a looser path than an endpoint
 * would". **`requirePageContext` had no such check.** A client who opened
 * `/orgs/{slug}/dashboard` got a rendered agency shell — navigation, the
 * organization's name, whatever their limited grants returned server-side —
 * and every client-side call from it then 404'd.
 *
 * Sign-in made it reachable without typing a URL: both forms landed on `/orgs`,
 * which forwards anybody with exactly one organization straight into the agency
 * dashboard. For a client that was the only destination they could get.
 *
 * ## Why this test mocks two modules
 *
 * Page contexts read the session through `cookies()` from `next/headers` and
 * signal with `redirect()` from `next/navigation`, neither of which exists
 * outside a real request scope — which is why the route-level tests in
 * `portal.integration.test.ts` can pass a cookie header on a fabricated
 * `Request` and these cannot. The database, the memberships, the session cookie
 * and the tenant resolution are all real; only the two Next primitives are
 * stood in for.
 *
 * `redirect()` genuinely throws in Next, so the stand-in throws too. A test
 * where it returned normally would let execution continue past a redirect and
 * prove the opposite of what it claims.
 */

const ORG = '018ffb00-0000-7000-8000-0000fb000001';
const WS = '018ffb00-0000-7000-8000-0000fb000002';
const WS_OTHER = '018ffb00-0000-7000-8000-0000fb000003';
const OWNER = '018ffb00-0000-7000-8000-0000fb000004';
const CLIENT = '018ffb00-0000-7000-8000-0000fb000005';
const CLIENT_TWO_WS = '018ffb00-0000-7000-8000-0000fb000006';
const CLIENT_NO_WS = '018ffb00-0000-7000-8000-0000fb000007';

/** Set per test; the `next/headers` stand-in reads it. */
let activeCookie = '';

class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`NEXT_REDIRECT:${target}`);
  }
}

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === '__orbit_session' && activeCookie ? { name, value: activeCookie } : undefined,
    }),
}));

vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
  notFound: () => {
    throw new RedirectSignal('NOT_FOUND');
  },
}));

// Imported after the mocks are registered, since the module reads them on call
// but resolves them at import.
const { requirePageContext } = await import('./page-context');

/** Where this principal is sent, or `null` when the page renders for them. */
async function visitAgencyPage(cookie: string, orgSlug = 'surface-sep'): Promise<string | null> {
  activeCookie = cookie;

  try {
    await requirePageContext(orgSlug);
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
}

let ownerCookie = '';
let clientCookie = '';
let clientTwoCookie = '';
let clientNoWsCookie = '';

beforeAll(async () => {
  await platformDb.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: 'Surface Separation', slug: 'surface-sep', timezone: 'UTC' },
  });

  for (const [id, name] of [
    [WS, 'acme'],
    [WS_OTHER, 'beta'],
  ] as const) {
    await platformDb.workspace.upsert({
      where: { id },
      update: {},
      create: { id, organizationId: ORG, name, slug: name, timezone: 'UTC' },
    });
  }

  const seed = async (
    id: string,
    email: string,
    role: string,
    workspaces: Array<{ id: string; role: string }> = [],
  ) => {
    await platformDb.user.upsert({
      where: { id },
      update: {},
      create: { id, firebaseUid: `dev:${email}`, email },
    });
    await platformDb.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: ORG, userId: id } },
      update: { role: role as 'CLIENT', status: 'ACTIVE' },
      create: { organizationId: ORG, userId: id, role: role as 'CLIENT', status: 'ACTIVE' },
    });

    for (const workspace of workspaces) {
      await platformDb.workspaceMembership.upsert({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: id } },
        update: {},
        create: {
          organizationId: ORG,
          workspaceId: workspace.id,
          userId: id,
          role: workspace.role as 'CLIENT_APPROVER',
        },
      });
    }
  };

  await seed(OWNER, 'owner@surface-sep.test', 'OWNER');
  await seed(CLIENT, 'client@surface-sep.test', 'CLIENT', [
    { id: WS, role: 'CLIENT_APPROVER' },
  ]);
  await seed(CLIENT_TWO_WS, 'client-two@surface-sep.test', 'CLIENT', [
    { id: WS, role: 'CLIENT_APPROVER' },
    { id: WS_OTHER, role: 'CLIENT_VIEWER' },
  ]);
  await seed(CLIENT_NO_WS, 'client-none@surface-sep.test', 'CLIENT');

  const cookie = (email: string) =>
    devIdentityProvider.createSessionCookie(`dev:${email}`, 3_600_000);

  ownerCookie = await cookie('owner@surface-sep.test');
  clientCookie = await cookie('client@surface-sep.test');
  clientTwoCookie = await cookie('client-two@surface-sep.test');
  clientNoWsCookie = await cookie('client-none@surface-sep.test');
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: ORG } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '@surface-sep.test' } } });
});

describe('an agency page', () => {
  it('renders for agency staff', async () => {
    expect(await visitAgencyPage(ownerCookie)).toBeNull();
  });

  /** The whole point. Before this, the page rendered. */
  it('sends a client to their own portal instead', async () => {
    expect(await visitAgencyPage(clientCookie)).toBe(`/portal/${WS}`);
  });

  /**
   * Not guessed at. A client of two workspaces is asked which one — sending
   * them into the first would be putting them in a brand at random.
   */
  it('asks a client of several workspaces which one', async () => {
    expect(await visitAgencyPage(clientTwoCookie)).toBe('/portal');
  });

  /**
   * A client membership with no workspace behind it has nowhere to go, and a
   * redirect to the portal would bounce — the portal would refuse them and send
   * them back. `/continue` is the one page that renders rather than redirects.
   */
  it('does not bounce a client who has no workspace at all', async () => {
    expect(await visitAgencyPage(clientNoWsCookie)).toBe('/continue');
  });

  it('sends an unauthenticated visitor to sign in', async () => {
    const target = await visitAgencyPage('');

    expect(target).toContain('/sign-in');
    expect(target).toContain('next=');
  });

  /**
   * Unchanged by this work, and asserted so it stays that way: an organization
   * somebody is not a member of answers exactly as one that does not exist, so
   * page navigation cannot be used to enumerate tenants.
   */
  it('answers the same for a foreign organization as for a missing one', async () => {
    expect(await visitAgencyPage(ownerCookie, 'no-such-organization')).toBe('/orgs');
  });
});
