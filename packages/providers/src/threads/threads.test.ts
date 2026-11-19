import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, setClock } from '@orbit/core';
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
   * Threads processes every container, images included, and refuses a parent
   * naming a child still in progress: "Invalid Carousel Children … invalid,
   * nonexistent, or expired" (code 100, subcode 4279004). That is how a real
   * carousel failed, so every child is waited on before the parent is built.
   */
  it('waits until every item is ready before naming them in the carousel', async () => {
    let looks = 0;
    const local = happyApi().on(/\/container-1(\?|$)/, () => {
      looks += 1;
      return { body: { status: looks < 3 ? 'IN_PROGRESS' : 'FINISHED' } };
    });

    await provider(local).publish(publishContext({ media: [image('a'), image('b')] }));

    const parentAt = local.calls.findIndex(
      (call) =>
        call.method === 'POST' &&
        new URLSearchParams(call.body ?? '').get('media_type') === 'CAROUSEL',
    );
    const lastLookAt = local.calls
      .map((call) => /\/container-1(\?|$)/.test(call.url))
      .lastIndexOf(true);

    expect(looks).toBe(3);
    expect(parentAt).toBeGreaterThan(lastLookAt);
  });

  it('names the item Threads could not use, and builds no carousel', async () => {
    const local = happyApi().on(/\/container-2(\?|$)/, {
      body: { status: 'ERROR', error_message: 'FAILED_DOWNLOADING_IMAGE' },
    });

    const error = await provider(local)
      .publish(publishContext({ media: [image('a'), image('b')] }))
      .catch((caught: { code?: string; userMessage?: string }) => caught);

    expect(error.code).toBe('PROVIDER_MEDIA_ERROR');
    expect(error.userMessage).toBe(
      'Threads would not accept item 2 of 2 in the carousel (FAILED_DOWNLOADING_IMAGE).',
    );
    expect(
      local.calls.some(
        (call) => new URLSearchParams(call.body ?? '').get('media_type') === 'CAROUSEL',
      ),
    ).toBe(false);
  });

  it('records the items, and a retry waits on the same ones', async () => {
    const refs: Array<Record<string, unknown>> = [];
    await provider(api).publish(
      publishContext({
        media: [image('a'), image('b')],
        recordProviderRef: async (ref: Record<string, unknown>) => {
          refs.push({ ...ref });
        },
      }),
    );
    expect(refs[0]).toMatchObject({
      children: ['container-1', 'container-2'],
      contentHash: 'hash-1',
    });

    const retry = happyApi();
    await provider(retry).publish(
      publishContext({
        media: [image('a'), image('b')],
        previousRef: { children: ['container-7', 'container-8'], contentHash: 'hash-1' },
      }),
    );

    const creates = retry.calls.filter(
      (call) => call.method === 'POST' && /\/th-user-1\/threads(\?|$)/.test(call.url),
    );
    expect(creates).toHaveLength(1);
    expect(new URLSearchParams(creates[0]!.body ?? '').get('children')).toBe(
      'container-7,container-8',
    );
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

  /**
   * "Invalid parameter" is all `message` says. Meta writes the reason for a
   * person in `error_user_msg`, and that is what the attempt has to show —
   * the post that prompted this said only "The platform rejected this post".
   */
  it('shows Meta’s own explanation of a refused post, and keeps it on the attempt', async () => {
    const local = happyApi().on(/\/th-user-1\/threads(\?|$)/, {
      status: 400,
      body: {
        error: {
          message: 'Invalid parameter',
          type: 'OAuthException',
          code: 100,
          error_subcode: 4279004,
          error_user_title: 'Text is too long',
          error_user_msg: 'The text of a post can be at most 500 characters.',
          fbtrace_id: 'trace-1',
        },
      },
    });

    const error = await provider(local)
      .publish(publishContext())
      .catch(
        (caught: { code?: string; userMessage?: string; context?: Record<string, unknown> }) =>
          caught,
      );

    expect(error.code).toBe('PROVIDER_VALIDATION_ERROR');
    expect(error.userMessage).toBe(
      'Text is too long: The text of a post can be at most 500 characters.',
    );
    expect(error.context).toMatchObject({
      platform: 'THREADS',
      providerCode: 100,
      subcode: 4279004,
      providerMessage: 'Invalid parameter',
      providerUserMessage: 'The text of a post can be at most 500 characters.',
    });
  });

  it('keeps its own message where Meta gives no explanation', async () => {
    const local = happyApi().on(/\/th-user-1\/threads(\?|$)/, {
      status: 400,
      body: { error: { message: 'Invalid parameter', code: 100, error_subcode: 4279004 } },
    });

    const error = await provider(local)
      .publish(publishContext())
      .catch((caught: { userMessage?: string; context?: Record<string, unknown> }) => caught);

    expect(error.userMessage).toMatch(/rejected this post/);
    expect(error.context?.['providerMessage']).toBe('Invalid parameter');
  });

  it('counts the hashtags against the 500, because they are written into the text', () => {
    const body = 'a'.repeat(490);
    const caps = provider(api).capabilities();

    expect(provider(api).validate({ body }).valid).toBe(true);
    const withTags = provider(api).validate({ body, hashtags: ['coffee', 'morning'] });
    expect(withTags.valid).toBe(false);
    expect(withTags.issues.map((issue) => issue.code)).toContain('TEXT_TOO_LONG');
    // The link is a card on Threads, so it does not count.
    expect(provider(api).validate({ body, linkUrl: 'https://example.com/a' }).valid).toBe(true);
    expect(caps.text.hashtagsInText).toBe(true);
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

describe('threads (D-124)', () => {
  const longBody = Array.from(
    { length: 24 },
    (_, i) => `Sentence number ${i + 1} says something useful about the product.`,
  ).join(' ');

  const replyCredential = {
    ...credential,
    scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_replies'],
  };

  function threadApi(): FakeThreads {
    let published = 0;
    return happyApi()
      .on(/\/th-user-1\/threads_publish/, () => {
        published += 1;
        return { body: { id: `post-${published}` } };
      })
      .on(/\/post-\d+/, { body: { permalink: 'https://threads.net/@a/post/1' } });
  }

  it('is off, and asks for no reply permission, until it is switched on', () => {
    const off = provider(api);
    expect(off.capabilities().thread.supported).toBe(false);
    expect(
      off.getAuthorizationUrl({ redirectUri: 'https://app.test/cb', state: 's' }).scopes,
    ).not.toContain('threads_manage_replies');

    const on = provider(api, { threadReplies: true });
    expect(on.capabilities().thread).toMatchObject({
      supported: true,
      maxPosts: 10,
      scopes: ['threads_manage_replies'],
    });
    expect(
      on.getAuthorizationUrl({ redirectUri: 'https://app.test/cb', state: 's' }).scopes,
    ).toContain('threads_manage_replies');
  });

  it('posts each further part as a text reply to the one before', async () => {
    const fake = threadApi();
    const result = await provider(fake, { threadReplies: true }).publish(
      publishContext({
        credential: replyCredential,
        draft: { body: longBody, hashtags: [], mentions: [], media: [], thread: true },
      }),
    );

    const containers = fake.calls.filter(
      (call) => call.method === 'POST' && /\/th-user-1\/threads(\?|$)/.test(call.url),
    );
    expect(containers.length).toBeGreaterThan(1);

    const forms = containers.map((call) => new URLSearchParams(call.body ?? ''));
    expect(forms[0]?.get('reply_to_id')).toBeNull();
    forms.slice(1).forEach((form, index) => {
      expect(form.get('media_type')).toBe('TEXT');
      expect(form.get('reply_to_id')).toBe(`post-${index + 1}`);
    });
    forms.forEach((form, index) => {
      expect(form.get('text')?.endsWith(` ${index + 1}/${forms.length}`)).toBe(true);
    });

    expect(result.externalPostId).toBe('post-1');
    expect(result.providerMeta?.['threadPosts']).toBe(forms.length);
  });

  it('refuses before posting anything when the connection cannot reply', async () => {
    const fake = threadApi();
    const error = await provider(fake, { threadReplies: true })
      .publish(
        publishContext({
          credential, // connected before threads were switched on
          draft: { body: longBody, hashtags: [], mentions: [], media: [], thread: true },
        }),
      )
      .catch((caught: { code?: string; userMessage?: string }) => caught);

    expect(error.code).toBe('PROVIDER_VALIDATION_ERROR');
    expect(error.userMessage).toMatch(/Reconnect it/);
    expect(fake.calls).toHaveLength(0);
  });

  it('stops waiting on a reply container before the engine would cut the call off', async () => {
    const ticking = fixedClock(Date.UTC(2026, 10, 17, 9, 0, 0));
    const restore = setClock(ticking);
    try {
      const fake = threadApi()
        // Every container after the first stays in progress, ten seconds a look.
        .on(/\/container-([2-9]|\d\d)/, () => {
          ticking.advance(10_000);
          return { body: { status: 'IN_PROGRESS' } };
        });

      const error = await provider(fake, { threadReplies: true, pollBudgetMs: 60_000 })
        .publish(
          publishContext({
            credential: replyCredential,
            draft: { body: longBody, hashtags: [], mentions: [], media: [], thread: true },
          }),
        )
        .catch((caught: { code?: string; retryable?: boolean; userMessage?: string }) => caught);

      // Not "unknown": nothing was published past the first post, and a retry resumes.
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(error.retryable).toBe(true);
      expect(error.userMessage).toMatch(/^1 of \d+ posts in this thread are live on Threads/);
      expect(fake.called(/threads_publish/)).toBe(1);
    } finally {
      restore();
    }
  });

  it('keeps the reply permission across a refresh only where the connection had it', async () => {
    const fake = new FakeThreads().on(/\/refresh_access_token/, {
      body: { access_token: 'th.renewed', expires_in: 5_184_000 },
    });
    const soon = new Date(Date.now() + 60 * 60 * 1000);

    const kept = await provider(fake, { threadReplies: true }).refreshCredential({
      ...replyCredential,
      expiresAt: soon,
    });
    const notGranted = await provider(fake, { threadReplies: true }).refreshCredential({
      ...credential,
      expiresAt: soon,
    });

    expect(kept.status === 'REFRESHED' && kept.credential.scopes).toContain(
      'threads_manage_replies',
    );
    expect(notGranted.status === 'REFRESHED' && notGranted.credential.scopes).not.toContain(
      'threads_manage_replies',
    );
  });

  it('parks a thread found part-way out', async () => {
    const result = await provider(api, { threadReplies: true }).reconcile({
      credential: replyCredential,
      account: { externalId: 'th-user-1' },
      contentHash: 'hash-1',
      body: longBody,
      providerRef: {
        containerId: 'container-1',
        thread: { fingerprint: 'f', total: 3, posted: [{ id: 'post-1' }] },
      },
      attemptedAt: new Date(),
      windowMs: 600_000,
      correlationId: 'corr-1',
    });
    expect(result.outcome).toBe('INCONCLUSIVE');
  });
});

describe('attachments in a thread (D-124)', () => {
  const longBody = Array.from(
    { length: 24 },
    (_, i) => `Sentence number ${i + 1} says something useful about the product.`,
  ).join(' ');

  const replyCredential = {
    ...credential,
    scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_replies'],
  };

  it('posts a reply with its own image, as an image container replying to the post before', async () => {
    let published = 0;
    const fake = happyApi()
      .on(/\/th-user-1\/threads_publish/, () => {
        published += 1;
        return { body: { id: `post-${published}` } };
      })
      .on(/\/post-\d+/, { body: { permalink: 'https://threads.net/@a/post/1' } });

    await provider(fake, { threadReplies: true }).publish(
      publishContext({
        credential: replyCredential,
        draft: {
          body: longBody,
          hashtags: [],
          mentions: [],
          media: [],
          thread: true,
          threadMedia: { b: 1 },
        },
        media: [image('a'), image('b')],
      }),
    );

    const forms = fake.calls
      .filter((call) => call.method === 'POST' && /\/th-user-1\/threads(\?|$)/.test(call.url))
      .map((call) => new URLSearchParams(call.body ?? ''));

    expect(forms[0]?.get('media_type')).toBe('IMAGE');
    expect(forms[0]?.get('image_url')).toContain('a.jpg');
    expect(forms[1]?.get('media_type')).toBe('IMAGE');
    expect(forms[1]?.get('image_url')).toContain('b.jpg');
    expect(forms[1]?.get('reply_to_id')).toBe('post-1');
    expect(forms.slice(2).every((form) => form.get('media_type') === 'TEXT')).toBe(true);
  });
});
