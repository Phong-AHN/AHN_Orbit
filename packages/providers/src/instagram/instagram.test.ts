import { beforeEach, describe, expect, it } from 'vitest';
import { InstagramProvider } from './provider.js';
import { INSTAGRAM_LOGIN_SCOPES, INSTAGRAM_PUBLISH_SCOPES } from './capabilities.js';
import type { FetchLike } from '../facebook/client.js';

/**
 * The Instagram adapter against recorded Graph responses.
 *
 * Same approach as the Facebook suite: `fetch` is injected, so nothing here
 * needs a Meta app or network access. What it cannot prove is that Meta's real
 * responses match these fixtures — the capability descriptor marks what is
 * verified from documentation and what is not.
 *
 * The cases worth having are the ones where Instagram differs from Facebook:
 * media is mandatory, publishing takes two calls, an account is discovered
 * through a Page rather than on its own, and there is no delete.
 */

interface Recorded {
  status?: number;
  body: unknown;
}

class FakeGraph {
  readonly calls: Array<{ url: string; method: string; body?: string }> = [];
  private routes: Array<{ match: RegExp; response: Recorded | (() => Recorded) }> = [];

  on(match: RegExp, response: Recorded | (() => Recorded)): this {
    this.routes.push({ match, response });
    return this;
  }

  /** Media this fake has "published", so /media reads back like a real account. */
  readonly media: Array<{ id: string; caption: string; timestamp: string; permalink: string }> = [];

  /**
   * Make /media (POST) and /media_publish and /media (GET) behave as one store.
   *
   * Reconciliation reads the account's media to decide whether an ambiguous
   * publish landed, so a static fixture cannot exercise it — the fake has to
   * remember what it accepted.
   */
  withStore(): this {
    let containers = 0;
    let published = 0;
    const pendingCaption = new Map<string, string>();

    this.on(/\/media_publish/, () => {
      published++;
      const id = `ig-media-${published}`;
      const caption = pendingCaption.get(this.lastCreationId ?? '') ?? '';
      this.media.unshift({
        id,
        caption,
        timestamp: new Date().toISOString(),
        permalink: `https://www.instagram.com/p/${id}/`,
      });
      return { body: { id } };
    });

    this.on(/\/media(\?|$)/, () => {
      // GET reads the store; POST creates a container.
      const last = this.calls.at(-1);
      if (last?.method === 'GET') return { body: { data: this.media } };

      containers++;
      const id = `container-${containers}`;
      const caption = new URLSearchParams(last?.body ?? '').get('caption') ?? '';
      pendingCaption.set(id, caption);
      this.lastCreationId = id;
      return { body: { id } };
    });

    return this;
  }

  private lastCreationId: string | undefined;

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    this.calls.push({ url, method, ...(body ? { body } : {}) });

    // `media_publish` must be matched before the looser `/media` route.
    const route = [...this.routes].reverse().find((candidate) => candidate.match.test(url));
    const recorded = route
      ? typeof route.response === 'function'
        ? route.response()
        : route.response
      : { body: { id: 'ok' } };

    return new Response(JSON.stringify(recorded.body), {
      status: recorded.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function provider(graph: FakeGraph): InstagramProvider {
  return new InstagramProvider({
    appId: 'app-123',
    appSecret: 'secret-abc',
    apiVersion: 'v25.0',
    fetchImpl: graph.fetch,
    baseUrl: 'https://graph.test',
  });
}

const credential = { accessToken: 'page-token', scopes: INSTAGRAM_PUBLISH_SCOPES };

const image = (id: string) => ({
  id,
  kind: 'IMAGE' as const,
  mimeType: 'image/jpeg',
  sizeBytes: 100_000,
  url: `https://cdn.test/${id}.jpg`,
  width: 1080,
  height: 1080,
});

function publishContext(overrides: Record<string, unknown> = {}) {
  return {
    credential,
    account: { externalId: 'ig-user-1' },
    draft: { body: 'Hello Instagram', hashtags: [], mentions: [], media: [] },
    media: [image('a')],
    contentHash: 'hash-1',
    correlationId: 'corr-1',
    ...overrides,
  } as never;
}

let graph: FakeGraph;

beforeEach(() => {
  graph = new FakeGraph().withStore();
});

describe('capabilities', () => {
  it('requires media, because Instagram cannot publish text alone', () => {
    const capabilities = provider(graph).capabilities();
    expect(capabilities.media.required).toBe(true);
    expect(capabilities.media.carousel).toBe(true);
  });

  it('refuses a caption-only draft before anything reaches the API', () => {
    const result = provider(graph).validate({
      body: 'No picture',
      hashtags: [],
      mentions: [],
      media: [],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('MEDIA_REQUIRED');
    expect(graph.calls).toHaveLength(0);
  });

  it('declares no delete, because the API has none', () => {
    expect(provider(graph).capabilities().lifecycle.delete).toBe(false);
  });
});

describe('authorization', () => {
  /**
   * The scope strings are the one thing here nothing else can check. A typo
   * type-checks, passes every local test, and fails only at Meta's dialog —
   * which is exactly how `instagram_content_publishing` (from Meta's own
   * use-case page, and wrong) got as far as a live authorization attempt.
   */
  it('asks for exactly the permissions the Instagram use case adds', () => {
    const { url, scopes } = provider(graph).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'signed-state',
    });

    expect(scopes).toEqual([
      'business_management',
      'instagram_basic',
      'instagram_content_publish',
      'pages_read_engagement',
      'pages_show_list',
    ]);
    expect(new URL(url).searchParams.get('scope')).toBe(scopes.join(','));
  });

  it('never puts the app secret in the dialog URL', () => {
    const { url } = provider(graph).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });
    expect(url).not.toContain('secret-abc');
  });
});

describe('Business Login for Instagram', () => {
  const withLogin = (graph: FakeGraph) =>
    new InstagramProvider({
      appId: 'app-123',
      appSecret: 'secret-abc',
      apiVersion: 'v25.0',
      fetchImpl: graph.fetch,
      baseUrl: 'https://graph.test',
      login: { appId: 'ig-app-9', appSecret: 'ig-secret-9' },
    });

  it('uses Instagram’s own dialog and its own app id', () => {
    const { url, scopes } = withLogin(graph).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
      accountType: 'INSTAGRAM_LOGIN',
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://www.instagram.com/oauth/authorize');
    // The second app's id, not the Facebook one.
    expect(parsed.searchParams.get('client_id')).toBe('ig-app-9');
    // Space-delimited here, where Graph uses commas.
    expect(parsed.searchParams.get('scope')).toBe(scopes.join(' '));
    expect(scopes).toContain('instagram_business_content_publish');
  });

  it('still uses the Facebook dialog when no surface is named', () => {
    const { url } = withLogin(graph).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });

    // The Page-linked flow stays the default; adding a second app changes
    // nothing for anyone already using the first.
    expect(url).toContain('facebook.com');
  });

  it('refuses the username surface when the second app is not configured', () => {
    expect(() =>
      provider(graph).getAuthorizationUrl({
        redirectUri: 'https://app.test/cb',
        state: 's',
        accountType: 'INSTAGRAM_LOGIN',
      }),
    ).toThrow(/needs its own Meta app/);
  });
});

describe('account discovery', () => {
  it('finds the Instagram account through its Page, and keeps the Page token', async () => {
    graph
      .on(/oauth\/access_token/, { body: { access_token: 'user-token', expires_in: 5_183_944 } })
      .on(/debug_token/, { body: { data: { is_valid: true, scopes: INSTAGRAM_PUBLISH_SCOPES } } })
      .on(/\/me\/accounts/, {
        body: {
          data: [
            {
              id: 'page-1',
              name: 'Northwind Coffee',
              access_token: 'page-token-1',
              instagram_business_account: {
                id: 'ig-1',
                username: 'northwind',
                name: 'Northwind',
                profile_picture_url: 'https://cdn.test/a.jpg',
              },
            },
          ],
        },
      });

    const result = await provider(graph).exchangeCode({
      code: 'auth-code',
      redirectUri: 'https://app.test/cb',
    });

    expect(result.accounts).toHaveLength(1);
    // The id is Instagram's; the token is the Page's. Publishing needs both.
    expect(result.accounts[0]!.externalId).toBe('ig-1');
    expect(result.accounts[0]!.credential.accessToken).toBe('page-token-1');
    expect(result.accounts[0]!.handle).toBe('northwind');
  });

  it('drops a Page with no Instagram account linked to it', async () => {
    graph
      .on(/oauth\/access_token/, { body: { access_token: 'user-token' } })
      .on(/debug_token/, { body: { data: { is_valid: true, scopes: [] } } })
      .on(/\/me\/accounts/, {
        body: {
          data: [
            { id: 'page-1', name: 'No Instagram Here', access_token: 't' },
            {
              id: 'page-2',
              name: 'Linked',
              access_token: 't2',
              instagram_business_account: { id: 'ig-2', username: 'linked' },
            },
          ],
        },
      });

    const result = await provider(graph).exchangeCode({
      code: 'code',
      redirectUri: 'https://app.test/cb',
    });

    // Connecting the unlinked Page would create an account that can never
    // publish, which is worse than not offering it.
    expect(result.accounts.map((account) => account.externalId)).toEqual(['ig-2']);
  });
});

describe('publishing', () => {
  it('creates a container, then publishes it', async () => {
    const result = await provider(graph).publish(publishContext());

    const creates = graph.calls.filter(
      (call) => call.method === 'POST' && /\/ig-user-1\/media(\?|$)/.test(call.url),
    );
    const publishes = graph.calls.filter((call) => call.url.includes('media_publish'));

    expect(creates).toHaveLength(1);
    expect(publishes).toHaveLength(1);
    // The second call names the container the first returned.
    expect(publishes[0]!.body).toContain('creation_id=container-1');
    expect(result.externalPostId).toBe('ig-media-1');
  });

  it('puts hashtags in the caption, since the first comment is out of reach', async () => {
    await provider(graph).publish(
      publishContext({
        draft: { body: 'Morning', hashtags: ['coffee', '#roasters'], mentions: [], media: [] },
      }),
    );

    const create = graph.calls.find(
      (call) => call.method === 'POST' && /\/ig-user-1\/media(\?|$)/.test(call.url),
    );
    const caption = new URLSearchParams(create!.body ?? '').get('caption') ?? '';

    expect(caption).toContain('Morning');
    expect(caption).toContain('#coffee');
    // Already hashed stays as it is rather than becoming ##roasters.
    expect(caption).toContain('#roasters');
    expect(caption).not.toContain('##');
  });

  it('builds a carousel from several images', async () => {
    await provider(graph).publish(publishContext({ media: [image('a'), image('b'), image('c')] }));

    const creates = graph.calls.filter(
      (call) => call.method === 'POST' && /\/ig-user-1\/media(\?|$)/.test(call.url),
    );

    // Three children plus the parent that names them.
    expect(creates).toHaveLength(4);
    expect(creates[0]!.body).toContain('is_carousel_item=true');
    expect(creates.at(-1)!.body).toContain('media_type=CAROUSEL');
    expect(creates.at(-1)!.body).toContain('children=');
  });

  it('refuses video rather than sending something the adapter cannot build', async () => {
    await expect(
      provider(graph).publish(
        publishContext({
          media: [{ ...image('v'), kind: 'VIDEO', mimeType: 'video/mp4', durationMs: 5_000 }],
        }),
      ),
    ).rejects.toThrow();
  });

  /**
   * A publish refused by our own pre-flight, and what it must not claim.
   *
   * This came from a production failure that could not be diagnosed: the log
   * carried `PROVIDER_VALIDATION_ERROR` with a context of
   * `{ platform: 'INSTAGRAM' }` and nothing else, and the account manager was
   * told "the platform rejected this post". Meta had never been called. The
   * codes naming the real problem existed, in a `message` that was dropped.
   */
  describe('refused before sending', () => {
    const noMedia = () => provider(graph).publish(publishContext({ media: [] }));

    it('says which check failed, in the structured context', async () => {
      await expect(noMedia()).rejects.toMatchObject({
        code: 'PROVIDER_VALIDATION_ERROR',
        context: { validationCodes: 'MEDIA_REQUIRED', validationFields: 'media' },
      });
    });

    it('does not claim the platform rejected anything', async () => {
      await noMedia().catch((error: unknown) => {
        const failure = error as {
          userMessage: string;
          message: string;
          context: Record<string, unknown>;
        };

        // The old copy sent whoever read it looking at Instagram for a post
        // Instagram never saw.
        expect(failure.userMessage).not.toMatch(/platform rejected/i);
        // It says the actionable thing instead — the validator's own wording.
        expect(failure.userMessage).toMatch(/image or video/i);
        expect(failure.context['calledPlatform']).toBe(false);
      });

      // Nothing was sent. The whole point of the claim above.
      expect(graph.calls).toHaveLength(0);
    });

    it('keeps the message that names the cause, for the log', async () => {
      await expect(noMedia()).rejects.toThrow(/MEDIA_REQUIRED/);
    });

    it('stays non-retryable — the content is wrong, not the moment', async () => {
      await expect(noMedia()).rejects.toMatchObject({ retryable: false });
    });
  });
});

describe('publishing on the username-login surface', () => {
  /**
   * The connection is only the beginning. Publishing, reconciling and reading a
   * post back all have to reach the host that issued the token — and
   * `graph.facebook.com` answers an Instagram-app token with an authentication
   * error, which the publish path reads as a dead credential and demotes the
   * account on.
   *
   * The result was an account disconnected by its own publish attempt, every
   * time, with a message telling the person to reconnect the thing they had
   * just reconnected.
   */
  it('sends every publishing call to graph.instagram.com', async () => {
    const seen: string[] = [];
    const globalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      seen.push(url);
      const id = url.includes('media_publish') ? 'ig-media-1' : 'container-1';
      return new Response(JSON.stringify({ id, permalink: 'https://instagram.test/p/1/' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await provider(graph).publish(
        publishContext({
          credential: { accessToken: 'ig-token', scopes: INSTAGRAM_LOGIN_SCOPES },
        }),
      );

      expect(result.externalPostId).toBe('ig-media-1');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((url) => url.startsWith('https://graph.instagram.com/'))).toBe(true);
    } finally {
      globalThis.fetch = globalFetch;
    }

    // Nothing reached the Facebook Graph client's recorded calls.
    expect(graph.calls).toHaveLength(0);
  });
});

describe('reconciliation', () => {
  it('finds a post that went out during an ambiguous attempt', async () => {
    await provider(graph).publish(
      publishContext({ draft: { body: 'Ambiguous one', hashtags: [], mentions: [], media: [] } }),
    );

    const result = await provider(graph).reconcile({
      account: { externalId: 'ig-user-1' },
      credential,
      body: 'Ambiguous one',
      attemptedAt: new Date(),
      windowMs: 10 * 60 * 1000,
      correlationId: 'corr-1',
    } as never);

    expect(result.outcome).toBe('FOUND');
  });

  it('is INCONCLUSIVE when the account cannot be read', async () => {
    const failing = new FakeGraph().on(/\/media/, { status: 500, body: { error: {} } });

    const result = await provider(failing).reconcile({
      account: { externalId: 'ig-user-1' },
      credential,
      body: 'anything',
      attemptedAt: new Date(),
      windowMs: 60_000,
      correlationId: 'corr-1',
    } as never);

    // NOT_FOUND here would licence a retry that might duplicate.
    expect(result.outcome).toBe('INCONCLUSIVE');
  });
});

/**
 * Reconciling from the container rather than from the caption (**D-055**).
 *
 * The caption match is a guess that two posts with the same words can defeat,
 * and defeating it double-posts to a client's followers. `status_code` is the
 * platform answering about *this attempt*, so it is asked first — and every one
 * of its five values has to map to the right outcome, because only NOT_FOUND
 * lets the engine try again.
 */
describe('reconciliation by container status', () => {
  function withStatus(status: string, media: unknown[] = []) {
    return new FakeGraph()
      .on(/\/container-1\?/, { body: { status_code: status } })
      .on(/\/media(\?|$)/, { body: { data: media } });
  }

  const ctx = (overrides: Record<string, unknown> = {}) =>
    ({
      account: { externalId: 'ig-user-1' },
      credential,
      body: 'Ambiguous one',
      providerRef: { containerId: 'container-1' },
      attemptedAt: new Date(),
      windowMs: 10 * 60 * 1000,
      correlationId: 'corr-1',
      ...overrides,
    }) as never;

  it('records the container id before publishing, not after', async () => {
    const seen: unknown[] = [];

    await provider(graph).publish(
      publishContext({
        recordProviderRef: async (ref: unknown) => {
          // The store has not been published to yet at this point; if this
          // fired afterwards the id would be useless in the one case it exists
          // for — a `media_publish` that never returned.
          expect(graph.media).toHaveLength(0);
          seen.push(ref);
        },
      }),
    );

    expect(seen).toEqual([{ containerId: 'container-1' }]);
  });

  it('reports FOUND when the container published and the post is on the timeline', async () => {
    const graphWith = withStatus('PUBLISHED', [
      {
        id: 'ig-media-9',
        caption: 'Ambiguous one',
        timestamp: new Date().toISOString(),
        permalink: 'https://www.instagram.com/p/ig-media-9/',
      },
    ]);

    const result = await provider(graphWith).reconcile(ctx());

    expect(result).toMatchObject({ outcome: 'FOUND', externalPostId: 'ig-media-9' });
  });

  /**
   * The case the caption match gets wrong. Instagram says it published; the
   * timeline does not show it yet. NOT_FOUND would retry a post that is live.
   */
  it('parks rather than retrying when it published but cannot be located', async () => {
    const result = await provider(withStatus('PUBLISHED', [])).reconcile(ctx());

    expect(result.outcome).toBe('INCONCLUSIVE');
  });

  it.each(['ERROR', 'EXPIRED'])('treats %s as a definite NOT_FOUND, safe to retry', async (s) => {
    const graphWith = withStatus(s);

    const result = await provider(graphWith).reconcile(ctx());

    expect(result.outcome).toBe('NOT_FOUND');

    // And on the container's word alone. An empty timeline also yields
    // NOT_FOUND, so without this the assertion above would pass even if the
    // container status were being ignored entirely.
    expect(
      graphWith.calls.some((call) => call.method === 'GET' && /\/ig-user-1\/media/.test(call.url)),
    ).toBe(false);
  });

  it.each(['IN_PROGRESS', 'FINISHED'])('parks while the container is still %s', async (s) => {
    const result = await provider(withStatus(s)).reconcile(ctx());

    // Retrying now could publish the very container that is mid-flight.
    expect(result.outcome).toBe('INCONCLUSIVE');
  });

  it('never asks about a container when none was recorded', async () => {
    const graphWith = withStatus('PUBLISHED', []);

    await provider(graphWith).reconcile(ctx({ providerRef: undefined }));

    expect(graphWith.calls.some((call) => call.url.includes('container-1'))).toBe(false);
  });

  it('falls back to the caption match when the container cannot be read', async () => {
    const graphWith = new FakeGraph()
      .on(/\/container-1\?/, { status: 400, body: { error: {} } })
      .on(/\/media(\?|$)/, {
        body: {
          data: [
            {
              id: 'ig-media-4',
              caption: 'Ambiguous one',
              timestamp: new Date().toISOString(),
            },
          ],
        },
      });

    const result = await provider(graphWith).reconcile(ctx());

    expect(result).toMatchObject({ outcome: 'FOUND', externalPostId: 'ig-media-4' });
  });
});

describe('lifecycle', () => {
  it('explains that Instagram has no delete instead of failing obscurely', async () => {
    await expect(
      provider(graph).deletePost({ externalPostId: 'ig-media-1' } as never, credential),
    ).rejects.toThrow(/Remove it in the Instagram app/);
  });

  /**
   * The two surfaces hold tokens issued by *different Meta apps*. Checking an
   * Instagram-app token against the Facebook app's `debug_token` returns
   * invalid, and the account is demoted for no reason — which is exactly what
   * happened to a live account.
   */
  it('probes a username-login account against Instagram, not Graph', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ id: 'ig-user-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const globalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;

    try {
      const health = await provider(graph).probeHealth(
        { accessToken: 'ig-token', scopes: INSTAGRAM_LOGIN_SCOPES },
        { externalId: 'ig-user-1' },
      );

      expect(health.status).toBe('ACTIVE');
      expect(seen.some((url) => url.startsWith('https://graph.instagram.com/'))).toBe(true);
      // Never the Facebook app's debug endpoint.
      expect(seen.some((url) => url.includes('debug_token'))).toBe(false);
    } finally {
      globalThis.fetch = globalFetch;
    }
  });

  it('reports NEEDS_RECONNECT when a permission was removed', async () => {
    graph.on(/debug_token/, {
      body: { data: { is_valid: true, scopes: ['instagram_basic'] } },
    });

    const health = await provider(graph).probeHealth(credential, { externalId: 'ig-user-1' });

    expect(health.status).toBe('NEEDS_RECONNECT');
    expect(health.missingScopes).toContain('instagram_content_publish');
  });
});

/**
 * Account insights are a different API from media insights wearing the same
 * name (verified 2026-08-14 against Meta's Instagram User Insights reference).
 *
 * Both differences here have already cost a live integration somewhere: the
 * metric spelled `saved` on a media object is `saves` on an account, and the
 * account endpoint answers in `total_value` rather than `values` once
 * `metric_type` is set. Getting either wrong does not degrade — it produces an
 * invalid-metric error or a metric recorded as broken when it arrived fine.
 */
describe('account-level insights', () => {
  const accountGraph = () =>
    new FakeGraph().on(/\/insights/, {
      body: {
        data: [
          { name: 'reach', total_value: { value: 1234 } },
          { name: 'views', total_value: { value: 5678 } },
          { name: 'saves', total_value: { value: 42 } },
        ],
      },
    });

  it('asks for metric_type=total_value, which these metrics require', async () => {
    const graphWith = accountGraph();

    await provider(graphWith).fetchAccountAnalytics({ externalId: 'ig-user-1' }, credential, {
      from: new Date('2026-08-01'),
      to: new Date('2026-08-14'),
    } as never);

    const call = graphWith.calls.at(-1);
    expect(call?.url).toContain('metric_type=total_value');
  });

  it('reads total_value rather than the values series', async () => {
    const result = await provider(accountGraph()).fetchAccountAnalytics(
      { externalId: 'ig-user-1' },
      credential,
      { from: new Date('2026-08-01'), to: new Date('2026-08-14') } as never,
    );

    expect(result.metrics['reach']).toBe(1234);
    expect(result.availability['reach']).toBe('AVAILABLE');
  });

  it('spells it saves at account level and saved at media level', async () => {
    const graphWith = accountGraph();

    await provider(graphWith).fetchAccountAnalytics({ externalId: 'ig-user-1' }, credential, {
      from: new Date('2026-08-01'),
      to: new Date('2026-08-14'),
    } as never);

    const account = graphWith.calls.at(-1)?.url ?? '';
    expect(account).toMatch(/saves/);
    expect(account).not.toMatch(/saved/);

    const mediaGraph = new FakeGraph().on(/\/insights/, { body: { data: [] } });
    await provider(mediaGraph).fetchPostAnalytics(
      { externalPostId: 'ig-media-1', accountExternalId: 'ig-user-1' },
      credential,
      { from: new Date(), to: new Date() } as never,
    );

    expect(mediaGraph.calls.at(-1)?.url ?? '').toMatch(/saved/);
  });

  /**
   * One bad metric in a batch fails the whole request, so a follower-gated
   * metric would leave a small account with no analytics at all rather than one
   * missing number.
   */
  it('never asks for the metrics that carry a 100-follower minimum', async () => {
    const graphWith = accountGraph();

    await provider(graphWith).fetchAccountAnalytics({ externalId: 'ig-user-1' }, credential, {
      from: new Date('2026-08-01'),
      to: new Date('2026-08-14'),
    } as never);

    const url = graphWith.calls.at(-1)?.url ?? '';
    expect(url).not.toMatch(/follows_and_unfollows/);
    expect(url).not.toMatch(/follower_demographics/);
    expect(url).not.toMatch(/engaged_audience_demographics/);
  });
});
