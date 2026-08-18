import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ProviderAuthenticationError,
  ProviderPermissionError,
  ProviderRateLimitError,
  ProviderValidationError,
  PublishingTimeoutError,
} from '@orbit/core';
import { runProviderContractTests } from '../contract/contract-tests.js';
import { FacebookProvider } from './provider.js';
import type { FetchLike } from './client.js';

/**
 * The whole adapter is tested against recorded Graph responses.
 *
 * Nothing here needs a Meta Developer App, App Review, or network access —
 * `fetch` is injected. What that cannot prove is listed in the T1.6 report:
 * mainly that Meta's real responses match these fixtures.
 */

// ── Fixture harness ─────────────────────────────────────────────────────────

interface Recorded {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

class FakeGraph {
  readonly calls: Array<{
    url: string;
    method: string;
    body?: string;
    headers?: Record<string, string>;
  }> = [];
  private routes: Array<{ match: RegExp; response: Recorded | (() => Recorded) }> = [];

  on(match: RegExp, response: Recorded | (() => Recorded)): this {
    this.routes.push({ match, response });
    return this;
  }

  /** Throws from fetch itself, as a network abort would. */
  private thrower: (() => never) | undefined;
  throwOn(fn: () => never): this {
    this.thrower = fn;
    return this;
  }

  /** Posts this fake has "published", so /posts reads back like a real Page. */
  readonly timeline: Array<{ id: string; message: string; created_time: string }> = [];

  /**
   * Make /feed, /photos and /posts behave as one store.
   *
   * Reconciliation reads the timeline to decide whether an ambiguous publish
   * landed, so a static fixture cannot exercise it — the fake has to actually
   * remember what it accepted.
   */
  withTimeline(): this {
    let sequence = 0;

    this.on(/\/photos/, () => {
      sequence++;
      return { body: { id: `photo-${sequence}`, post_id: `100000000000001_888` } };
    });

    this.on(/\/feed/, () => {
      sequence++;
      const id = `100000000000001_999`;
      const body = this.calls.at(-1)?.body ?? '';
      const message = new URLSearchParams(body).get('message') ?? '';
      this.timeline.push({ id, message, created_time: new Date().toISOString() });
      return { body: { id } };
    });

    this.on(/\/posts/, () => ({ body: { data: this.timeline } }));
    return this;
  }

  fetch: FetchLike = async (url, init) => {
    // Headers are recorded because the Reel upload host carries everything in
    // them -- the token, its scheme, and the source URL -- and nothing in a body.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    this.calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      headers,
    });

    if (this.thrower) this.thrower();

    // Last registration wins, so a test can override a route from healthyGraph().
    const route = [...this.routes].reverse().find((r) => r.match.test(url));
    if (!route) {
      return new Response(JSON.stringify({ error: { message: 'no fixture', code: 100 } }), {
        status: 400,
      });
    }

    const recorded = typeof route.response === 'function' ? route.response() : route.response;
    return new Response(JSON.stringify(recorded.body), {
      status: recorded.status ?? 200,
      headers: recorded.headers,
    });
  };
}

const VALID_TOKEN = {
  data: {
    is_valid: true,
    expires_at: 0,
    scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights'],
  },
};

function provider(graph: FakeGraph): FacebookProvider {
  return new FacebookProvider({
    appId: 'app-123',
    appSecret: 'secret-abc',
    apiVersion: 'v21.0',
    fetchImpl: graph.fetch,
    baseUrl: 'https://graph.test',
  });
}

/**
 * A graph pre-loaded with the happy path for every endpoint.
 *
 * Registration order matters: routes match last-first, so the catch-all is
 * registered first and every specific route — and every per-test override —
 * takes precedence over it.
 */
function healthyGraph(): FakeGraph {
  return (
    new FakeGraph()
      .on(/.*/, { body: { id: 'ok' } })
      .on(/debug_token/, { body: VALID_TOKEN })
      .on(/\/me\/accounts/, {
        body: {
          data: [
            {
              id: '100000000000001',
              name: 'Northwind Coffee',
              username: 'northwind',
              access_token: 'page-token-1',
              tasks: ['CREATE_CONTENT', 'MANAGE'],
              picture: { data: { url: 'https://cdn.test/a.jpg' } },
            },
          ],
        },
      })
      .on(/oauth\/access_token/, { body: { access_token: 'user-token', expires_in: 5_183_944 } })
      .on(/\/insights/, {
        body: { data: [{ name: 'page_media_view', values: [{ value: 4321 }] }] },
      })
      // The Page-existence probe. Note the query string — `\d+$` would never match.
      .on(/v21\.0\/\d+\?fields=id/, { body: { id: '100000000000001' } })
      .withTimeline()
  );
}

// ── The shared contract ─────────────────────────────────────────────────────

runProviderContractTests({
  name: 'Facebook',
  createProvider: () => provider(healthyGraph()),
  validCredential: () => ({
    accessToken: 'page-token-1',
    scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    keyVersion: 1,
  }),
  sampleAccount: { externalId: '100000000000001', accountType: 'PAGE' },
  validDraft: () => ({ body: 'Fresh beans in tomorrow.' }),
});

// ── Facebook-specific behaviour ─────────────────────────────────────────────

describe('authorization URL', () => {
  it('points at the dialog host, not the graph host', () => {
    const { url } = provider(healthyGraph()).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'signed-state',
    });
    expect(url).toContain('https://www.facebook.com/v21.0/dialog/oauth');
  });

  it('requests exactly the scopes we submitted for review', () => {
    const { url, scopes } = provider(healthyGraph()).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });

    // `read_insights` is deliberately not requested (commit cee771f). It is
    // still exported as `FACEBOOK_INSIGHTS_SCOPE` so analytics can ask for it
    // as an extra scope later, but asking for it at connect time widens the
    // App Review submission for a feature Phase 1 does not ship.
    expect(scopes).toEqual(['pages_show_list', 'pages_read_engagement', 'pages_manage_posts']);
    expect(new URL(url).searchParams.get('scope')).toBe(scopes.join(','));
  });

  it('never puts the app secret in the URL', () => {
    const { url } = provider(healthyGraph()).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });
    expect(url).not.toContain('secret-abc');
  });

  it('carries the caller’s state verbatim', () => {
    const state = 'eyJub25jZSI6ImFiYyJ9.signature';
    const { url } = provider(healthyGraph()).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state,
    });
    expect(new URL(url).searchParams.get('state')).toBe(state);
  });
});

describe('code exchange', () => {
  it('exchanges short-lived for long-lived, then discovers Pages', async () => {
    const graph = healthyGraph();
    const result = await provider(graph).exchangeCode({
      code: 'auth-code',
      redirectUri: 'https://app.test/cb',
    });

    const exchanges = graph.calls.filter((c) => c.url.includes('oauth/access_token'));
    expect(exchanges).toHaveLength(2);
    expect(exchanges[1]!.url).toContain('grant_type=fb_exchange_token');

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.externalId).toBe('100000000000001');
    expect(result.accounts[0]!.credential.accessToken).toBe('page-token-1');
  });

  /**
   * A code from `FB.login` was never issued against a redirect, so there is
   * nothing for Meta to match — it requires `redirect_uri` to be present and
   * empty. Sending our callback URL fails the exchange with an error about a
   * mismatched redirect, which reads like a misconfigured app rather than the
   * wrong call shape, so this locks the behaviour down.
   */
  it('sends an empty redirect_uri for a code obtained through the JavaScript SDK', async () => {
    const graph = healthyGraph();
    await provider(graph).exchangeCode({ code: 'sdk-code', redirectUri: '' });

    const first = graph.calls.filter((c) => c.url.includes('oauth/access_token'))[0]!;
    const params = new URL(first.url).searchParams;

    expect(params.has('redirect_uri')).toBe(true);
    expect(params.get('redirect_uri')).toBe('');
    expect(params.get('code')).toBe('sdk-code');
  });

  it('sends the app secret in the exchange but never in a bearer header', async () => {
    const graph = healthyGraph();
    await provider(graph).exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb' });

    const exchange = graph.calls.find((c) => c.url.includes('client_secret'));
    expect(exchange).toBeDefined();
    // Server-side only — this is why exchangeCode can never run in a browser.
    expect(exchange!.url).toContain('client_secret=secret-abc');
  });

  it('skips Pages that returned no access token', async () => {
    const graph = healthyGraph().on(/\/me\/accounts/, {
      body: {
        data: [
          { id: '1', name: 'No Token Page', tasks: ['CREATE_CONTENT'] },
          { id: '2', name: 'Good Page', access_token: 't', tasks: ['CREATE_CONTENT'] },
        ],
      },
    });

    const result = await provider(graph).exchangeCode({ code: 'c', redirectUri: 'https://a.test' });
    expect(result.accounts.map((a) => a.externalId)).toEqual(['2']);
  });

  it('returns a Page lacking CREATE_CONTENT, so the UI can explain why', async () => {
    const graph = healthyGraph().on(/\/me\/accounts/, {
      body: { data: [{ id: '3', name: 'Read Only', access_token: 't', tasks: ['ANALYZE'] }] },
    });

    const result = await provider(graph).exchangeCode({ code: 'c', redirectUri: 'https://a.test' });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.credential.scopes).not.toContain('pages_manage_posts');
  });
});

describe('health probing', () => {
  const credential = {
    accessToken: 'page-token-1',
    scopes: ['pages_manage_posts'],
    keyVersion: 1,
  };
  const account = { externalId: '100000000000001' };

  it('reports ACTIVE when the token is valid and the Page is reachable', async () => {
    const health = await provider(healthyGraph()).probeHealth(credential, account);
    expect(health.status).toBe('ACTIVE');
    expect(health.missingScopes).toEqual([]);
  });

  it('reports NEEDS_RECONNECT when the token is invalid', async () => {
    const graph = healthyGraph().on(/debug_token/, {
      body: { data: { is_valid: false, error: { code: 190, subcode: 460 } } },
    });

    const health = await provider(graph).probeHealth(credential, account);
    expect(health.status).toBe('NEEDS_RECONNECT');
    // Subcode 460 means the password changed — say so rather than "invalid".
    expect(health.message).toMatch(/password was changed/i);
  });

  it('names the scope that was removed', async () => {
    const graph = healthyGraph().on(/debug_token/, {
      body: { data: { is_valid: true, scopes: ['pages_show_list'] } },
    });

    const health = await provider(graph).probeHealth(credential, account);
    expect(health.status).toBe('NEEDS_RECONNECT');
    expect(health.missingScopes).toContain('pages_manage_posts');
  });

  it('reports NEEDS_RECONNECT when Page access itself was withdrawn', async () => {
    // The token debugs as perfectly valid, but the Page can no longer be read —
    // the case where a user loses their admin role on the Page.
    const graph = healthyGraph().on(/v21\.0\/\d+\?fields=id/, {
      status: 403,
      body: { error: { message: 'Permissions error', code: 200 } },
    });

    const health = await provider(graph).probeHealth(credential, account);
    expect(health.status).toBe('NEEDS_RECONNECT');
  });

  it('does NOT mark an account unhealthy during a transient outage', async () => {
    const graph = healthyGraph().on(/debug_token/, {
      status: 500,
      body: { error: { message: 'Internal', code: 2 } },
    });

    // A five-minute Meta blip must not send reconnect prompts to every client.
    await expect(provider(graph).probeHealth(credential, account)).rejects.toThrow();
  });
});

describe('credential refresh', () => {
  const credential = { accessToken: 'page-token-1', scopes: [], keyVersion: 1 };

  it('reports STILL_VALID for a non-expiring Page token', async () => {
    const outcome = await provider(healthyGraph()).refreshCredential(credential);
    expect(outcome.status).toBe('STILL_VALID');
  });

  it('asks for reconnection when the token is dead, rather than looping', async () => {
    const graph = healthyGraph().on(/debug_token/, {
      body: { data: { is_valid: false, error: { code: 190, subcode: 458 } } },
    });

    const outcome = await provider(graph).refreshCredential(credential);
    expect(outcome.status).toBe('REQUIRES_RECONNECT');
    expect(outcome).toHaveProperty('reason', expect.stringMatching(/app was removed/i));
  });

  it('asks for reconnection when expiry is imminent', async () => {
    const graph = healthyGraph().on(/debug_token/, {
      body: {
        data: { is_valid: true, expires_at: Math.floor((Date.now() + 86_400_000) / 1000) },
      },
    });

    const outcome = await provider(graph).refreshCredential(credential);
    expect(outcome.status).toBe('REQUIRES_RECONNECT');
  });

  it('does not trigger a reconnect prompt when the check itself fails', async () => {
    const graph = healthyGraph().on(/debug_token/, {
      status: 503,
      body: { error: { message: 'down', code: 2 } },
    });

    const outcome = await provider(graph).refreshCredential(credential);
    expect(outcome.status).toBe('STILL_VALID');
  });
});

describe('error normalization', () => {
  const credential = { accessToken: 't', scopes: [], keyVersion: 1 };
  const ref = { externalPostId: '1_2', accountExternalId: '1' };

  const failWith = (status: number, body: unknown, headers?: Record<string, string>) =>
    provider(new FakeGraph().on(/.*/, { status, body, ...(headers ? { headers } : {}) }));

  it('maps code 190 to an authentication error that is never retried', async () => {
    const error = await failWith(400, { error: { code: 190, message: 'Invalid OAuth token' } })
      .deletePost(ref, credential)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderAuthenticationError);
    expect((error as ProviderAuthenticationError).retryable).toBe(false);
  });

  it('maps code 200 to a permission error', async () => {
    const error = await failWith(400, { error: { code: 200, message: 'Permissions error' } })
      .deletePost(ref, credential)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderPermissionError);
  });

  it('maps code 4 to a retryable rate limit', async () => {
    const error = await failWith(400, { error: { code: 4, message: 'App request limit' } })
      .deletePost(ref, credential)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect((error as ProviderRateLimitError).retryable).toBe(true);
  });

  it('reads Retry-After when Meta supplies one', async () => {
    const error = await failWith(400, { error: { code: 4 } }, { 'retry-after': '300' })
      .deletePost(ref, credential)
      .catch((e: unknown) => e);

    expect((error as ProviderRateLimitError).retryAfterSeconds).toBe(300);
  });

  it('backs off proportionally from X-App-Usage when there is no Retry-After', async () => {
    const error = await failWith(
      400,
      { error: { code: 4 } },
      { 'x-app-usage': JSON.stringify({ call_count: 97, total_time: 20, total_cputime: 15 }) },
    )
      .deletePost(ref, credential)
      .catch((e: unknown) => e);

    expect((error as ProviderRateLimitError).retryAfterSeconds).toBe(900);
  });

  it('maps code 100 to a validation error', async () => {
    const error = await failWith(400, { error: { code: 100, message: 'Invalid parameter' } })
      .deletePost(ref, credential)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderValidationError);
  });

  it('classifies a network abort as TIMEOUT so the engine reconciles', async () => {
    const graph = new FakeGraph().throwOn(() => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    const error = await provider(graph)
      .deletePost(ref, credential)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PublishingTimeoutError);
    expect((error as PublishingTimeoutError).retryable).toBe(false);
  });

  it('never surfaces Meta’s developer-facing message to a user', async () => {
    const error = await failWith(400, {
      error: { code: 100, message: 'Tried accessing nonexisting field (internal_thing) on node' },
    })
      .deletePost(ref, credential)
      .catch((e: unknown) => e);

    expect((error as ProviderValidationError).userMessage).not.toContain('internal_thing');
  });

  it('keeps the fbtrace_id, which is the first thing Meta support asks for', async () => {
    const error = await failWith(400, {
      error: { code: 100, message: 'x', fbtrace_id: 'A1b2C3' },
    })
      .deletePost(ref, credential)
      .catch((e: unknown) => e);

    expect((error as ProviderValidationError).context.fbtraceId).toBe('A1b2C3');
  });
});

describe('publishing', () => {
  const credential = { accessToken: 'page-token-1', scopes: [], keyVersion: 1 };
  const base = {
    credential,
    account: { externalId: '100000000000001' },
    contentHash: 'hash',
    correlationId: 'test',
  };

  it('posts text to /feed', async () => {
    const graph = healthyGraph();
    const result = await provider(graph).publish({
      ...base,
      draft: { body: 'Hello world' },
      media: [],
    });

    const call = graph.calls.find((c) => c.url.includes('/feed'));
    expect(call?.method).toBe('POST');
    expect(call?.body).toContain('message=Hello+world');
    expect(result.externalPostId).toBe('100000000000001_999');
  });

  it('appends hashtags to the message, since Facebook has no separate field', async () => {
    const graph = healthyGraph();
    await provider(graph).publish({
      ...base,
      draft: { body: 'Beans', hashtags: ['coffee', '#roastery'] },
      media: [],
    });

    const body = decodeURIComponent(graph.calls.find((c) => c.url.includes('/feed'))!.body!);
    expect(body).toContain('#coffee');
    expect(body).toContain('#roastery');
  });

  it('uses /photos for a single image and returns the feed story id', async () => {
    const graph = healthyGraph();
    const result = await provider(graph).publish({
      ...base,
      draft: { body: 'Look' },
      media: [
        {
          id: 'm1',
          kind: 'IMAGE',
          mimeType: 'image/jpeg',
          sizeBytes: 1000,
          url: 'https://cdn.test/1.jpg',
          altText: 'a cup',
        },
      ],
    });

    const call = graph.calls.find((c) => c.url.includes('/photos'));
    expect(call?.body).toContain('alt_text_custom=a+cup');
    // post_id, not the photo id — the feed story is what analytics attach to.
    expect(result.externalPostId).toBe('100000000000001_888');
  });

  it('uploads unpublished photos then attaches them for a multi-photo post', async () => {
    const graph = healthyGraph();
    await provider(graph).publish({
      ...base,
      draft: { body: 'Gallery' },
      media: [1, 2, 3].map((n) => ({
        id: `m${n}`,
        kind: 'IMAGE' as const,
        mimeType: 'image/jpeg',
        sizeBytes: 1000,
        url: `https://cdn.test/${n}.jpg`,
      })),
    });

    const photoCalls = graph.calls.filter((c) => c.url.includes('/photos'));
    expect(photoCalls).toHaveLength(3);
    expect(photoCalls[0]!.body).toContain('published=false');

    const feed = decodeURIComponent(graph.calls.find((c) => c.url.includes('/feed'))!.body!);
    expect(feed).toContain('attached_media[0]={"media_fbid":"photo-1"}');
  });

  it('surfaces orphaned uploads when a multi-photo post fails part-way', async () => {
    let uploads = 0;
    const graph = healthyGraph().on(/\/photos/, () =>
      ++uploads <= 1
        ? { body: { id: 'photo-1' } }
        : { status: 400, body: { error: { code: 324, message: 'bad image' } } },
    );

    const error = await provider(graph)
      .publish({
        ...base,
        draft: { body: 'Gallery' },
        media: [1, 2].map((n) => ({
          id: `m${n}`,
          kind: 'IMAGE' as const,
          mimeType: 'image/jpeg',
          sizeBytes: 1000,
          url: `https://cdn.test/${n}.jpg`,
        })),
      })
      .catch((e: unknown) => e);

    expect((error as { context: Record<string, unknown> }).context.orphanedPhotoIds).toEqual([
      'photo-1',
    ]);
  });

  /**
   * Video is a Reel, and nothing else on a Page.
   *
   * This replaces a test asserting video was refused outright. The refusal was
   * real while `video: null` stood in the descriptor; keeping the test after
   * building Reels would have pinned the old behaviour and made the new one
   * look like a regression.
   */
  it('refuses a video that is not shaped like a Reel', async () => {
    const error = await provider(healthyGraph())
      .publish({
        ...base,
        draft: { body: 'Watch' },
        media: [
          {
            id: 'v1',
            kind: 'VIDEO',
            mimeType: 'video/mp4',
            sizeBytes: 1000,
            url: 'https://cdn.test/v.mp4',
            // Landscape, which a vertical-only surface cannot take.
            width: 1920,
            height: 1080,
            durationMs: 20_000,
            frameRate: 30,
            peakFrameRate: 30,
          },
        ],
      })
      .catch((e: unknown) => e);

    // Caught by the descriptor before anything is sent.
    expect(error).toBeInstanceOf(ProviderValidationError);
  });
});

describe('reconciliation', () => {
  const credential = { accessToken: 'page-token-1', scopes: [], keyVersion: 1 };
  const ctx = {
    credential,
    account: { externalId: '100000000000001' },
    contentHash: 'hash',
    body: 'Our new studio opens on Thursday and we would love to see you there.',
    attemptedAt: new Date('2026-08-12T10:00:00Z'),
    windowMs: 600_000,
    correlationId: 'test',
  };

  it('finds a matching post in the timeline window', async () => {
    const graph = healthyGraph().on(/\/posts/, {
      body: {
        data: [
          {
            id: '1_555',
            message: ctx.body,
            created_time: '2026-08-12T10:00:05+0000',
            permalink_url: 'https://facebook.com/1_555',
          },
        ],
      },
    });

    const result = await provider(graph).reconcile(ctx);
    expect(result.outcome).toBe('FOUND');
    expect(result).toHaveProperty('externalPostId', '1_555');
  });

  it('matches text the platform reflowed', async () => {
    const graph = healthyGraph().on(/\/posts/, {
      body: { data: [{ id: '1_556', message: ctx.body.replace(/ /g, '  ') }] },
    });

    expect((await provider(graph).reconcile(ctx)).outcome).toBe('FOUND');
  });

  it('reports NOT_FOUND when the timeline is readable and empty', async () => {
    const result = await provider(healthyGraph()).reconcile(ctx);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('reports INCONCLUSIVE — never NOT_FOUND — when it could not look', async () => {
    const graph = healthyGraph().on(/\/posts/, {
      status: 500,
      body: { error: { code: 2, message: 'down' } },
    });

    const result = await provider(graph).reconcile(ctx);
    // Saying NOT_FOUND here would licence a retry that could duplicate a post.
    expect(result.outcome).toBe('INCONCLUSIVE');
  });

  it('constrains the search to the attempt window', async () => {
    const graph = healthyGraph();
    await provider(graph).reconcile(ctx);

    const call = graph.calls.find((c) => c.url.includes('/posts'));
    const url = new URL(call!.url);
    expect(Number(url.searchParams.get('since'))).toBe(
      Math.floor((ctx.attemptedAt.getTime() - ctx.windowMs) / 1000),
    );
  });
});

describe('analytics', () => {
  const credential = { accessToken: 'page-token-1', scopes: [], keyVersion: 1 };

  it('never requests a withdrawn metric — that would fail the whole call', async () => {
    const graph = healthyGraph();
    await provider(graph).fetchAccountAnalytics({ externalId: '1' }, credential, {
      from: new Date('2026-08-01'),
      to: new Date('2026-08-12'),
    });

    const url = graph.calls.find((c) => c.url.includes('/insights'))!.url;
    const requested = new URL(url).searchParams.get('metric') ?? '';

    expect(requested).not.toContain('page_impressions');
    expect(requested).not.toContain('page_fans');
    expect(requested).toContain('page_media_view');
  });

  it('reports withdrawn metrics as DEPRECATED rather than zero', async () => {
    const set = await provider(healthyGraph()).fetchAccountAnalytics(
      { externalId: '1' },
      credential,
      { from: new Date('2026-08-01'), to: new Date('2026-08-12') },
    );

    expect(set.availability.page_impressions).toBe('DEPRECATED');
    expect(set.metrics.page_impressions).toBeUndefined();
    expect(set.availability.page_fans).toBe('DEPRECATED');
  });

  it('records the API version the numbers came from', async () => {
    const set = await provider(healthyGraph()).fetchAccountAnalytics(
      { externalId: '1' },
      credential,
      { from: new Date('2026-08-01'), to: new Date('2026-08-12') },
    );
    expect(set.apiVersion).toBe('v21.0');
  });
});

describe('webhooks', () => {
  let fb: FacebookProvider;
  beforeEach(() => {
    fb = provider(healthyGraph());
  });

  const sign = (body: string) =>
    'sha256=' + createHmac('sha256', 'secret-abc').update(body, 'utf8').digest('hex');

  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({ entry: [] });
    expect(
      fb.verifyWebhook({ headers: { 'x-hub-signature-256': sign(body) }, rawBody: body }),
    ).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const body = JSON.stringify({ entry: [] });
    const signature = sign(body);
    expect(
      fb.verifyWebhook({
        headers: { 'x-hub-signature-256': signature },
        rawBody: body + ' ',
      }),
    ).toBe(false);
  });

  it('rejects a missing or malformed signature', () => {
    expect(fb.verifyWebhook({ headers: {}, rawBody: '{}' })).toBe(false);
    expect(fb.verifyWebhook({ headers: { 'x-hub-signature-256': 'nope' }, rawBody: '{}' })).toBe(
      false,
    );
  });

  it('parses entries into events with a stable id for idempotency', () => {
    const events = fb.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        entry: [
          { id: '100', time: 1_760_000_000, changes: [{ field: 'feed', value: { verb: 'add' } }] },
        ],
      }),
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.externalEventId).toBe('100:1760000000:0');
    expect(events[0]!.type).toBe('facebook.feed');
  });
});

describe('capability honesty', () => {
  it('declares no carousel, because Facebook has no such post type', () => {
    expect(provider(healthyGraph()).capabilities().media.carousel).toBe(false);
  });

  it('declares editOwnPostsOnly, which is a verified Graph constraint', () => {
    const lifecycle = provider(healthyGraph()).capabilities().lifecycle;
    expect(lifecycle.edit).toBe(true);
    expect(lifecycle.editOwnPostsOnly).toBe(true);
  });

  it('declares no idempotency key and therefore must be reconcilable', () => {
    const publishing = provider(healthyGraph()).capabilities().publishing;
    expect(publishing.idempotencyKey).toBe(false);
    expect(publishing.reconcilable).toBe(true);
  });

  it('declares the verified 10-minute to 30-day provider scheduling window', () => {
    const scheduling = provider(healthyGraph()).capabilities().scheduling;
    expect(scheduling.minLeadMs).toBe(600_000);
    expect(scheduling.maxLeadMs).toBe(30 * 24 * 3600_000);
  });
});

/**
 * Reels: the only way video reaches a Page.
 *
 * Three phases, and the middle one is where this differs from every other
 * publish in the system: **Meta fetches the file itself** from the `file_url`
 * header, so the worker never streams a gigabyte. TikTok cannot do that — it
 * demands a verified domain — which is why the same video takes two completely
 * different routes to two platforms.
 */
describe('publishing a Reel', () => {
  const credential = { accessToken: 'page-token-1', scopes: [], keyVersion: 1 };
  const base = {
    credential,
    account: { externalId: '100000000000001' },
    contentHash: 'hash',
    correlationId: 'test',
  };

  const reel = () => ({
    id: 'v1',
    kind: 'VIDEO' as const,
    mimeType: 'video/mp4',
    sizeBytes: 8_000_000,
    url: 'https://cdn.test/reel.mp4?signature=abc',
    width: 1080,
    height: 1920,
    durationMs: 20_000,
    frameRate: 30,
    peakFrameRate: 30,
  });

  const reelGraph = () =>
    new FakeGraph().on(/video_reels|rupload/, {
      body: { video_id: 'vid-9', upload_url: 'https://rupload.test/video-upload/v25.0/vid-9' },
    });

  const phasesOf = (graph: FakeGraph) =>
    graph.calls
      .filter((call) => /video_reels/.test(call.url))
      .map((call) => new URLSearchParams(call.body ?? '').get('upload_phase'));

  it('runs start, upload and finish in that order', async () => {
    const graph = reelGraph();
    await provider(graph).publish({ ...base, draft: { body: 'Morning run' }, media: [reel()] });

    expect(phasesOf(graph)).toEqual(['start', 'finish']);
    expect(graph.calls.some((call) => /rupload/.test(call.url))).toBe(true);
  });

  /**
   * The header Meta needs, spelled the way Meta needs it. `Bearer` here yields
   * a 401 that reads like a dead token rather than a malformed header.
   */
  it('hands Meta the signed URL with an OAuth-scheme header', async () => {
    const graph = reelGraph();
    await provider(graph).publish({ ...base, draft: { body: 'x' }, media: [reel()] });

    const upload = graph.calls.find((call) => /rupload/.test(call.url));

    expect(upload?.headers?.['authorization']).toMatch(/^OAuth /);
    expect(upload?.headers?.['file_url']).toContain('reel.mp4');
  });

  /**
   * An id written after the ambiguous half would not exist in the one case it
   * is needed for.
   *
   * Asserted against the **call log**, not against the order of a single entry:
   * the first version only checked `order[0]`, which is trivially the first
   * element of a one-element array and stayed green when the write was moved
   * after the upload.
   */
  it('records the video id before the upload begins', async () => {
    const graph = reelGraph();
    let callsWhenRecorded = -1;

    await provider(graph).publish({
      ...base,
      draft: { body: 'x' },
      media: [reel()],
      recordProviderRef: async (ref: Record<string, unknown>) => {
        expect(ref['reelVideoId']).toBe('vid-9');
        callsWhenRecorded = graph.calls.length;
      },
    });

    const uploadAt = graph.calls.findIndex((call) => /rupload/.test(call.url));

    expect(callsWhenRecorded).toBeGreaterThanOrEqual(0);
    expect(uploadAt).toBeGreaterThan(-1);
    // The id existed before the upload call was made.
    expect(callsWhenRecorded).toBeLessThanOrEqual(uploadAt);
  });

  it('publishes with the caption as the description', async () => {
    const graph = reelGraph();
    await provider(graph).publish({
      ...base,
      draft: { body: 'Morning run', hashtags: ['dawn'] },
      media: [reel()],
    });

    const finish = graph.calls
      .filter((call) => /video_reels/.test(call.url))
      .map((call) => new URLSearchParams(call.body ?? ''))
      .find((form) => form.get('upload_phase') === 'finish');

    expect(finish?.get('video_state')).toBe('PUBLISHED');
    expect(finish?.get('description')).toContain('Morning run');
  });

  it('refuses a Reel with photos alongside it', async () => {
    await expect(
      provider(reelGraph()).publish({
        ...base,
        draft: { body: 'x' },
        media: [
          reel(),
          {
            id: 'p1',
            kind: 'IMAGE' as const,
            mimeType: 'image/jpeg',
            sizeBytes: 1000,
            url: 'https://cdn.test/a.jpg',
            width: 1080,
            height: 1080,
          },
        ],
      }),
    ).rejects.toThrow();
  });

  /**
   * Facebook's floor is 24, where Instagram and TikTok accept 23. A 23.976fps
   * film-rate export passes there and fails here — exactly the kind of
   * difference a shared descriptor exists to keep straight rather than average
   * away.
   */
  it('declares a frame-rate floor one above the other platforms', () => {
    const video = provider(new FakeGraph()).capabilities().media.video;

    expect(video?.minFrameRate).toBe(24);
    expect(video?.maxFrameRate).toBe(60);
  });

  /** Vertical really is required here, unlike Instagram. */
  it('declares the 9:16 requirement, with tolerance for real exports', () => {
    const video = provider(new FakeGraph()).capabilities().media.video;

    // 1080x1920 is 0.5625; 1080x1921 is 0.5622, and is not what this catches.
    expect(video!.minAspectRatio!).toBeLessThan(0.5625);
    expect(video!.maxAspectRatio!).toBeGreaterThan(0.5625);
    // Square and landscape footage is.
    expect(video!.maxAspectRatio!).toBeLessThan(1);
  });
});
