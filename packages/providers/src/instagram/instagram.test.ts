import { beforeEach, describe, expect, it } from 'vitest';
import { InstagramProvider } from './provider.js';
import { INSTAGRAM_PUBLISH_SCOPES } from './capabilities.js';
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
    apiVersion: 'v21.0',
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
      apiVersion: 'v21.0',
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

describe('lifecycle', () => {
  it('explains that Instagram has no delete instead of failing obscurely', async () => {
    await expect(
      provider(graph).deletePost({ externalPostId: 'ig-media-1' } as never, credential),
    ).rejects.toThrow(/Remove it in the Instagram app/);
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
