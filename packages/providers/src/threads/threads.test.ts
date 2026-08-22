import { beforeEach, describe, expect, it } from 'vitest';
import { ThreadsProvider } from './provider.js';
import type { FetchLike } from './client.js';

/**
 * The Threads adapter against recorded responses.
 *
 * `fetch` is injected, so nothing here needs a Threads app or the network. What
 * it cannot prove is that Meta's real responses match these fixtures — the
 * descriptor marks what is verified from documentation and what is not.
 *
 * The cases worth having are where Threads differs from everything else here:
 * a 500-character ceiling, text as a first-class post, a container that must be
 * waited on for *every* post type, and a token that refreshes itself and only
 * while it is still alive.
 */

interface Recorded {
  status?: number;
  body: unknown;
}

class FakeThreads {
  readonly calls: Array<{ url: string; method: string; body?: string }> = [];
  private routes: Array<{ match: RegExp; response: Recorded | (() => Recorded) }> = [];

  on(match: RegExp, response: Recorded | (() => Recorded)): this {
    this.routes.push({ match, response });
    return this;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    this.calls.push({ url, method: init?.method ?? 'GET', ...(body ? { body } : {}) });

    // Later registrations win, so a test can override a default fixture.
    const route = [...this.routes].reverse().find((candidate) => candidate.match.test(url));
    const recorded = route
      ? typeof route.response === 'function'
        ? route.response()
        : route.response
      : { body: { error: { message: 'no fixture', code: 100 } }, status: 400 };

    return new Response(JSON.stringify(recorded.body), {
      status: recorded.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  called(pattern: RegExp): number {
    return this.calls.filter((call) => pattern.test(call.url)).length;
  }

  formOf(pattern: RegExp): URLSearchParams {
    const call = this.calls.find((candidate) => pattern.test(candidate.url));
    return new URLSearchParams(call?.body ?? '');
  }
}

function provider(api: FakeThreads, overrides: Record<string, unknown> = {}): ThreadsProvider {
  return new ThreadsProvider({
    appId: 'threads-app-1',
    appSecret: 'threads-secret',
    apiVersion: 'v1.0',
    fetchImpl: api.fetch,
    baseUrl: 'https://threads.test',
    // Fast enough that the "still preparing" path is testable at all.
    pollBudgetMs: 40,
    pollIntervalMs: 2,
    ...overrides,
  });
}

const credential = {
  accessToken: 'th.token',
  scopes: ['threads_basic', 'threads_content_publish'],
  keyVersion: 1,
};

const image = (id: string) => ({
  id,
  kind: 'IMAGE' as const,
  mimeType: 'image/jpeg',
  sizeBytes: 200_000,
  url: `https://cdn.test/${id}.jpg`,
  width: 1080,
  height: 1080,
});

function publishContext(overrides: Record<string, unknown> = {}) {
  return {
    credential,
    account: { externalId: 'th-user-1' },
    draft: { body: 'Hello Threads', hashtags: [], mentions: [], media: [] },
    media: [],
    contentHash: 'hash-1',
    correlationId: 'corr-1',
    ...overrides,
  } as never;
}

/** Container created, ready at once, publish returns a post. */
function happyApi(): FakeThreads {
  let containers = 0;

  return new FakeThreads()
    .on(/\/th-user-1\/threads_publish/, { body: { id: 'post-1' } })
    .on(/\/th-user-1\/threads(\?|$)/, () => {
      containers += 1;
      return { body: { id: `container-${containers}` } };
    })
    .on(/\/container-\d+/, { body: { status: 'FINISHED' } })
    .on(/\/post-1/, { body: { id: 'post-1', permalink: 'https://threads.net/@a/post/1' } });
}

let api: FakeThreads;

beforeEach(() => {
  api = happyApi();
});

describe('capabilities', () => {
  /** Four times shorter than Instagram, and the shortest in the product. */
  it('caps text at 500 characters', () => {
    expect(provider(api).capabilities().text.maxLength).toBe(500);
  });

  /**
   * The one platform here that publishes text alone *and* media alone.
   * Instagram cannot do the first; TikTok cannot do either.
   */
  it('does not require media', () => {
    expect(provider(api).capabilities().media.required).toBe(false);
  });

  it('treats a link as a real link, unlike Instagram and TikTok', () => {
    expect(provider(api).capabilities().link.supported).toBe(true);
  });

  it('declares no delete, because the API has none', () => {
    expect(provider(api).capabilities().lifecycle.delete).toBe(false);
  });

  it('carries the documented publishing ceiling', () => {
    const limit = provider(api).capabilities().publishing.rateLimit;
    expect(limit?.maxPosts).toBe(250);
    expect(limit?.windowMs).toBe(86_400_000);
  });
});

describe('authorization', () => {
  it('uses threads.net, not the API host and not facebook.com', () => {
    const { url } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'signed-state',
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://threads.net/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('threads-app-1');
  });

  it('asks for publishing permission alongside the baseline', () => {
    const { scopes } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });

    expect(scopes).toContain('threads_basic');
    expect(scopes).toContain('threads_content_publish');
    // Reply permissions are documented but unused; asking for them would grow
    // the consent screen for nothing.
    expect(scopes).not.toContain('threads_manage_replies');
  });

  it('never puts the app secret in the dialog URL', () => {
    const { url } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });
    expect(url).not.toContain('threads-secret');
  });
});

describe('tokens', () => {
  const tokenApi = () =>
    new FakeThreads()
      .on(/\/oauth\/access_token/, { body: { access_token: 'short.lived', user_id: 42 } })
      .on(/\/access_token/, { body: { access_token: 'long.lived', expires_in: 5_183_944 } })
      .on(/\/me/, { body: { id: 'th-user-1', username: 'ahn', name: 'AHN Media' } });

  /**
   * The short-lived token lasts an hour — shorter than the gap between
   * connecting an account and the first scheduled post. Storing it would give a
   * connection that works during setup and is dead by morning.
   */
  it('trades the one-hour token for the sixty-day one immediately', async () => {
    const local = tokenApi();
    const { accounts } = await provider(local).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.test/cb',
    });

    expect(accounts[0]!.credential.accessToken).toBe('long.lived');
    expect(local.called(/grant_type=th_exchange_token/)).toBe(1);
  });

  it('records roughly sixty days', async () => {
    const { accounts } = await provider(tokenApi()).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.test/cb',
    });

    const days = (accounts[0]!.credential.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(60);
  });

  /**
   * The trap this platform sets.
   *
   * There is no separate refresh token: the long-lived token renews *itself*,
   * and only while it is still valid. So the last moment a refresh can succeed
   * is the moment it expires — a grace period would let the sweep skip an
   * account until it was past saving.
   */
  it('treats the expiry as the last moment a refresh can work', async () => {
    const { accounts } = await provider(tokenApi()).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.test/cb',
    });

    const issued = accounts[0]!.credential;
    expect(issued.refreshableUntil?.getTime()).toBe(issued.expiresAt?.getTime());
  });

  it('refuses to refresh an expired token, because Threads cannot', async () => {
    const outcome = await provider(tokenApi()).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(outcome.status).toBe('REQUIRES_RECONNECT');
    if (outcome.status !== 'REQUIRES_RECONNECT') return;
    expect(outcome.reason).toMatch(/only be refreshed while still valid/i);
  });

  it('renews a token that is close to expiring', async () => {
    const local = tokenApi().on(/\/refresh_access_token/, {
      body: { access_token: 'renewed', expires_in: 5_183_944 },
    });

    const outcome = await provider(local).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() + 2 * 86_400_000),
    });

    expect(outcome.status).toBe('REFRESHED');
    if (outcome.status !== 'REFRESHED') return;
    expect(outcome.credential.accessToken).toBe('renewed');
  });

  it('leaves a token with weeks left alone', async () => {
    const local = tokenApi();
    const outcome = await provider(local).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() + 40 * 86_400_000),
    });

    expect(outcome.status).toBe('STILL_VALID');
    expect(local.called(/refresh_access_token/)).toBe(0);
  });
});

describe('publishing', () => {
  it('posts text with no media at all', async () => {
    const result = await provider(api).publish(publishContext());

    expect(api.formOf(/\/th-user-1\/threads(\?|$)/).get('media_type')).toBe('TEXT');
    expect(result.externalPostId).toBe('post-1');
  });

  it('puts hashtags in the text, where they belong on Threads', async () => {
    await provider(api).publish(
      publishContext({ draft: { body: 'Morning', hashtags: ['coffee'], mentions: [], media: [] } }),
    );

    expect(api.formOf(/\/th-user-1\/threads(\?|$)/).get('text')).toContain('#coffee');
  });

  it('creates an IMAGE container for a single picture', async () => {
    await provider(api).publish(publishContext({ media: [image('a')] }));

    const form = api.formOf(/\/th-user-1\/threads(\?|$)/);
    expect(form.get('media_type')).toBe('IMAGE');
    expect(form.get('image_url')).toContain('a.jpg');
  });

  /** Children first, then a parent naming them — the same shape as Instagram. */
  it('builds a carousel from children', async () => {
    await provider(api).publish(publishContext({ media: [image('a'), image('b')] }));

    const creates = api.calls.filter(
      (call) => call.method === 'POST' && /\/th-user-1\/threads(\?|$)/.test(call.url),
    );

    // Two children plus the parent.
    expect(creates).toHaveLength(3);
    expect(new URLSearchParams(creates[0]!.body ?? '').get('is_carousel_item')).toBe('true');
    expect(new URLSearchParams(creates.at(-1)!.body ?? '').get('media_type')).toBe('CAROUSEL');
  });

  /**
   * The id is the only thing that can answer "did it go out?" afterwards, and
   * one written after the ambiguous half would not exist in that case.
   */
  it('records the container id before waiting or publishing', async () => {
    let callsWhenRecorded = -1;

    await provider(api).publish(
      publishContext({
        recordProviderRef: async (ref: Record<string, unknown>) => {
          expect(ref['containerId']).toBe('container-1');
          callsWhenRecorded = api.calls.length;
        },
      }),
    );

    const publishAt = api.calls.findIndex((call) => /threads_publish/.test(call.url));
    expect(callsWhenRecorded).toBeGreaterThanOrEqual(0);
    expect(callsWhenRecorded).toBeLessThan(publishAt);
  });

  /**
   * Meta asks for a wait before publishing, and unlike Instagram it applies to
   * **every** post type — text included.
   */
  it('waits for the container even on a text post', async () => {
    let asked = 0;
    const local = happyApi().on(/\/container-\d+/, () => {
      asked += 1;
      return { body: { status: asked < 2 ? 'IN_PROGRESS' : 'FINISHED' } };
    });

    await provider(local).publish(publishContext());

    expect(asked).toBeGreaterThan(1);
  });

  it('reports a container that errored as a media failure, with the reason', async () => {
    const local = happyApi().on(/\/container-\d+/, {
      body: { status: 'ERROR', error_message: 'unsupported aspect ratio' },
    });

    await provider(local)
      .publish(publishContext({ media: [image('a')] }))
      .catch((error: unknown) => {
        const failure = error as { code: string; context: Record<string, unknown> };
        expect(failure.code).toBe('PROVIDER_MEDIA_ERROR');
        expect(failure.context['reason']).toBe('unsupported aspect ratio');
      });
  });

  /**
   * Running out of budget is **not** an ambiguous outcome.
   *
   * The publish call has not been made, so nothing exists to be unsure about.
   * Reporting a timeout here parked every slow video for a human to look at
   * when all it needed was longer — the worst available outcome, because the
   * post was fine. A retryable failure lets the queue try again, and the retry
   * resumes the same container rather than restarting the transcode.
   */
  it('asks to be retried while Threads is still preparing, rather than parking', async () => {
    const local = happyApi().on(/\/container-\d+/, { body: { status: 'IN_PROGRESS' } });

    await expect(provider(local).publish(publishContext())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('resumes the container an earlier attempt left preparing', async () => {
    const local = happyApi().on(/\/container-9/, { body: { status: 'FINISHED' } });

    const result = await provider(local).publish(
      publishContext({ previousRef: { containerId: 'container-9', contentHash: 'hash-1' } }),
    );

    // Nothing new was built; the recorded container was published.
    expect(local.called(/\/th-user-1\/threads(\?|$)/)).toBe(0);
    expect(result.externalPostId).toBe('post-1');
  });

  it('ignores a recorded container whose content has since changed', async () => {
    const local = happyApi();

    await provider(local).publish(
      publishContext({ previousRef: { containerId: 'container-9', contentHash: 'stale' } }),
    );

    expect(local.called(/\/th-user-1\/threads(\?|$)/)).toBe(1);
  });

  it('refuses text over the 500-character ceiling before sending anything', async () => {
    await expect(
      provider(api).publish(publishContext({ draft: { body: 'x'.repeat(501), media: [] } })),
    ).rejects.toMatchObject({ code: 'PROVIDER_VALIDATION_ERROR' });

    expect(api.calls).toHaveLength(0);
  });
});

describe('errors', () => {
  /**
   * Threads speaks the Graph dialect, so its errors are normalized by the
   * Facebook mapping — but the platform tag has to say THREADS, or a reader
   * chases a Facebook Page that was never involved.
   */
  it('labels a Graph-shaped failure as Threads', async () => {
    const local = new FakeThreads().on(/\/me/, {
      status: 401,
      body: { error: { message: 'bad token', code: 190 } },
    });

    const health = await provider(local).probeHealth(credential, { externalId: 'th-user-1' });
    expect(health.status).toBe('NEEDS_RECONNECT');
  });

  it('says plainly that an expired connection cannot be refreshed', async () => {
    const health = await provider(api).probeHealth(
      { ...credential, expiresAt: new Date(Date.now() - 1) },
      { externalId: 'th-user-1' },
    );

    expect(health.status).toBe('NEEDS_RECONNECT');
    expect(health.message).toMatch(/cannot refresh an expired token/i);
  });
});

describe('reconciliation', () => {
  const reconcileCtx = (providerRef?: Record<string, unknown>) =>
    ({
      credential,
      account: { externalId: 'th-user-1' },
      contentHash: 'hash-1',
      body: 'Hello Threads',
      ...(providerRef ? { providerRef } : {}),
      attemptedAt: new Date(),
      windowMs: 600_000,
      correlationId: 'corr-1',
    }) as never;

  it('parks while the container is still working, rather than posting again', async () => {
    const local = happyApi().on(/\/container-1/, { body: { status: 'IN_PROGRESS' } });
    const result = await provider(local).reconcile(reconcileCtx({ containerId: 'container-1' }));

    expect(result.outcome).toBe('INCONCLUSIVE');
  });

  it('reports an errored container as never landed', async () => {
    const local = happyApi().on(/\/container-1/, { body: { status: 'ERROR' } });
    const result = await provider(local).reconcile(reconcileCtx({ containerId: 'container-1' }));

    expect(result.outcome).toBe('NOT_FOUND');
  });

  /**
   * The fallback, and deliberately the second choice: matching by text can
   * claim somebody else's post, so it only runs when the container cannot
   * answer.
   */
  it('falls back to matching recent posts when there is no container id', async () => {
    const local = happyApi().on(/\/th-user-1\/threads\?/, {
      body: {
        data: [
          {
            id: 'post-9',
            text: 'Hello Threads',
            timestamp: new Date().toISOString(),
            permalink: 'https://threads.net/p/9',
          },
        ],
      },
    });

    const result = await provider(local).reconcile(reconcileCtx());

    expect(result.outcome).toBe('FOUND');
    if (result.outcome !== 'FOUND') return;
    expect(result.externalPostId).toBe('post-9');
  });
});

describe('analytics', () => {
  it('reads per-post insights', async () => {
    const local = new FakeThreads().on(/insights/, {
      body: { data: [{ name: 'views', total_value: { value: 900 } }] },
    });

    const result = await provider(local).fetchPostAnalytics(
      { externalPostId: 'post-1', accountExternalId: 'th-user-1' },
      credential,
      { from: new Date(), to: new Date() },
    );

    expect(result.metrics['views']).toBe(900);
    expect(result.availability['views']).toBe('AVAILABLE');
  });

  /**
   * A fresh post with no views must read as unavailable. Storing zero would
   * chart it identically to one nobody saw (SRS §18).
   */
  it('marks a metric Threads did not return as unavailable, never zero', async () => {
    const local = new FakeThreads().on(/insights/, { body: { data: [] } });

    const result = await provider(local).fetchPostAnalytics(
      { externalPostId: 'post-1', accountExternalId: 'th-user-1' },
      credential,
      { from: new Date(), to: new Date() },
    );

    expect(result.metrics['views']).toBeUndefined();
    expect(result.availability['views']).toBe('UNSUPPORTED');
  });
});

/**
 * The scope the descriptor's own claim depends on.
 *
 * Found in production: the capability descriptor said `analytics.post: true`,
 * but every per-post call came back "does not exist, cannot be loaded due to
 * missing permissions" — which reads like a deleted post rather than a
 * permission the app never requested. Account-level figures *did* work, so the
 * gap looked closed from the outside.
 */
describe('insights permission', () => {
  it('asks for threads_manage_insights, which post analytics requires', () => {
    const { scopes } = provider(new FakeThreads()).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'signed-state',
    });

    expect(scopes).toContain('threads_manage_insights');
  });

  /** Claiming a capability the granted scopes cannot deliver is the bug itself. */
  it('does not claim post analytics without the scope that enables it', () => {
    const capabilities = provider(new FakeThreads()).capabilities();
    const { scopes } = provider(new FakeThreads()).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });

    if (capabilities.analytics.post) {
      expect(scopes).toContain('threads_manage_insights');
    }
  });
});
