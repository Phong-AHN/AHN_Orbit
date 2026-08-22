import { beforeEach, describe, expect, it } from 'vitest';
import { LinkedInProvider } from './provider.js';
import type { FetchLike } from './client.js';

/**
 * The LinkedIn adapter against recorded responses.
 *
 * The cases worth having are where LinkedIn differs from every other platform
 * here: the post id arrives in a **header**, two version headers are mandatory
 * on every call, an image must be pushed rather than fetched, discovery asks
 * "which pages may this person post to" rather than "who signed in", and a post
 * can actually be deleted.
 */

interface Recorded {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class FakeLinkedIn {
  readonly calls: Array<{
    url: string;
    method: string;
    body?: string;
    headers: Record<string, string>;
  }> = [];

  private routes: Array<{ match: RegExp; response: Recorded | (() => Recorded) }> = [];

  on(match: RegExp, response: Recorded | (() => Recorded)): this {
    this.routes.push({ match, response });
    return this;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    this.calls.push({ url, method: init?.method ?? 'GET', ...(body ? { body } : {}), headers });

    const route = [...this.routes].reverse().find((candidate) => candidate.match.test(url));
    const recorded = route
      ? typeof route.response === 'function'
        ? route.response()
        : route.response
      : { status: 404, body: { message: 'no fixture', status: 404 } };

    const status = recorded.status ?? 200;

    // 204 and its siblings *must* be constructed with a null body — passing an
    // empty string throws inside `fetch`, which then surfaces as "the platform
    // could not be reached". A fixture that fabricates a network failure is
    // worse than no fixture: it hides whatever the code actually did.
    const bodyless = status === 204 || status === 205 || status === 304;

    return new Response(
      bodyless || recorded.body === undefined ? null : JSON.stringify(recorded.body),
      {
        status,
        headers: { 'content-type': 'application/json', ...(recorded.headers ?? {}) },
      },
    );
  };

  callTo(pattern: RegExp) {
    return this.calls.find((call) => pattern.test(call.url));
  }

  bodyTo(pattern: RegExp): Record<string, unknown> {
    const call = this.callTo(pattern);
    return call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : {};
  }
}

function provider(api: FakeLinkedIn, overrides: Record<string, unknown> = {}): LinkedInProvider {
  return new LinkedInProvider({
    clientId: 'li-client',
    clientSecret: 'li-secret',
    apiVersion: '202608',
    fetchImpl: api.fetch,
    baseUrl: 'https://linkedin.test',
    readMedia: async () => new Uint8Array([1, 2, 3]),
    ...overrides,
  });
}

const credential = {
  accessToken: 'li.token',
  scopes: [
    'openid',
    'profile',
    'w_member_social',
    'w_organization_social',
    'r_organization_social',
  ],
  keyVersion: 1,
};

const image = () => ({
  id: 'm1',
  kind: 'IMAGE' as const,
  mimeType: 'image/jpeg',
  sizeBytes: 200_000,
  url: 'https://cdn.test/a.jpg',
  width: 1200,
  height: 1200,
  altText: 'A photograph',
});

function publishContext(overrides: Record<string, unknown> = {}) {
  return {
    credential,
    account: { externalId: 'urn:li:organization:123' },
    draft: { body: 'Hello LinkedIn', hashtags: [], mentions: [], media: [] },
    media: [],
    contentHash: 'hash-1',
    correlationId: 'corr-1',
    ...overrides,
  } as never;
}

/** A post is created and answers with its URN in a header, as LinkedIn does. */
function happyApi(): FakeLinkedIn {
  return new FakeLinkedIn()
    .on(/\/rest\/posts$/, {
      status: 201,
      headers: { 'x-restli-id': 'urn:li:share:987' },
    })
    .on(/\/rest\/images/, {
      body: { value: { uploadUrl: 'https://upload.test/img', image: 'urn:li:image:abc' } },
    })
    .on(/upload\.test/, { status: 201 });
}

let api: FakeLinkedIn;

beforeEach(() => {
  api = happyApi();
});

describe('capabilities', () => {
  /** The only platform in the product that permits it. */
  it('declares that a post can be deleted', () => {
    expect(provider(api).capabilities().lifecycle.delete).toBe(true);
  });

  /**
   * Video needs LinkedIn's separate Videos API, which is not built. Declaring a
   * constraint without the path would let the composer accept a video the
   * worker then refuses.
   */
  it('declares no video, because that path is not built', () => {
    expect(provider(api).capabilities().media.video).toBeNull();
  });

  it('declares one image, because multiple needs a different endpoint', () => {
    expect(provider(api).capabilities().media.maxAttachments).toBe(1);
    expect(provider(api).capabilities().media.carousel).toBe(false);
  });

  /** Not built, so the ingestion sweep must skip rather than call and throw. */
  it('declares no analytics rather than a method that throws', () => {
    const analytics = provider(api).capabilities().analytics;
    expect(analytics.post).toBe(false);
    expect(analytics.account).toBe(false);
  });
});

describe('authorization', () => {
  /** Space-delimited here; Meta uses commas. Three platforms, three habits. */
  it('space-delimits its scopes', () => {
    const { url, scopes } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'signed-state',
    });

    expect(new URL(url).searchParams.get('scope')).toBe(scopes.join(' '));
    expect(scopes).toContain('w_organization_social');
  });

  it('never puts the client secret in the dialog URL', () => {
    const { url } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });
    expect(url).not.toContain('li-secret');
  });
});

describe('every request', () => {
  /**
   * Both headers are mandatory on every versioned call, and omitting either
   * yields a 400 that names neither of them.
   */
  it('carries the version and protocol headers', async () => {
    await provider(api).publish(publishContext());

    const call = api.callTo(/\/rest\/posts$/);
    expect(call?.headers['linkedin-version']).toBe('202608');
    expect(call?.headers['x-restli-protocol-version']).toBe('2.0.0');
  });
});

describe('discovering pages', () => {
  const aclApi = () =>
    new FakeLinkedIn()
      .on(/oauth\/v2\/accessToken/, { body: { access_token: 'li.new', expires_in: 5_184_000 } })
      .on(/organizationAcls/, {
        body: {
          elements: [
            { organization: 'urn:li:organization:1', role: 'ADMINISTRATOR', state: 'APPROVED' },
            // A role that cannot publish. Offering it would produce a
            // connection that fails at publish time.
            { organization: 'urn:li:organization:2', role: 'ANALYST', state: 'APPROVED' },
          ],
        },
      })
      .on(/rest\/organizations\?/, {
        body: { results: { 'urn:li:organization:1': { localizedName: 'AHN Media' } } },
      });

  it('offers only pages the member may actually post to', async () => {
    const { accounts } = await provider(aclApi()).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.test/cb',
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.externalId).toBe('urn:li:organization:1');
    expect(accounts[0]!.displayName).toBe('AHN Media');
  });

  /**
   * A member who administers no page authorises perfectly and has nothing to
   * connect. Returning an empty list is correct; the connect flow explains it.
   */
  it('returns nothing when the member administers no page', async () => {
    const local = aclApi().on(/organizationAcls/, { body: { elements: [] } });

    const { accounts } = await provider(local).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.test/cb',
    });

    expect(accounts).toEqual([]);
  });
});

describe('tokens', () => {
  /**
   * Refresh tokens are granted only to approved partners. Claiming a refresh
   * window we do not have would let the sweep skip an account it should have
   * been warning about.
   */
  it('records no refresh window when LinkedIn issued no refresh token', async () => {
    const local = new FakeLinkedIn()
      .on(/oauth\/v2\/accessToken/, { body: { access_token: 'li.new', expires_in: 5_184_000 } })
      .on(/organizationAcls/, { body: { elements: [] } });

    const { userCredential } = await provider(local).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.test/cb',
    });

    expect(userCredential?.expiresAt).toBeDefined();
    expect(userCredential?.refreshableUntil).toBeUndefined();
  });

  it('says plainly that an app without refresh tokens needs a fresh sign-in', async () => {
    const outcome = await provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() + 1_000),
    });

    expect(outcome.status).toBe('REQUIRES_RECONNECT');
    if (outcome.status !== 'REQUIRES_RECONNECT') return;
    expect(outcome.reason).toMatch(/does not have refresh tokens/i);
  });

  it('leaves a token with weeks left alone, refresh token or not', async () => {
    const outcome = await provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() + 40 * 86_400_000),
    });

    expect(outcome.status).toBe('STILL_VALID');
  });
});

describe('publishing', () => {
  /**
   * The id is in `x-restli-id` on a 201 with an empty body. Reading the body
   * for it finds nothing and looks like a platform fault.
   */
  it('takes the post id from the response header', async () => {
    const result = await provider(api).publish(publishContext());

    expect(result.externalPostId).toBe('urn:li:share:987');
    expect(result.permalink).toContain('urn:li:share:987');
  });

  it('sends the fields LinkedIn requires', async () => {
    await provider(api).publish(publishContext());
    const body = api.bodyTo(/\/rest\/posts$/);

    expect(body['author']).toBe('urn:li:organization:123');
    expect(body['lifecycleState']).toBe('PUBLISHED');
    expect(body['visibility']).toBe('PUBLIC');
    expect((body['distribution'] as Record<string, unknown>)['feedDistribution']).toBe('MAIN_FEED');
  });

  it('puts hashtags inline, where LinkedIn renders them', async () => {
    await provider(api).publish(
      publishContext({ draft: { body: 'Hiring', hashtags: ['jobs'], media: [] } }),
    );

    expect(String(api.bodyTo(/\/rest\/posts$/)['commentary'])).toContain('#jobs');
  });

  /**
   * Registered and pushed **before** the post exists. A post created first and
   * then failed on media would be visible and wrong; an orphaned image is
   * invisible.
   */
  it('uploads the image before creating the post', async () => {
    await provider(api).publish(publishContext({ media: [image()] }));

    const uploadAt = api.calls.findIndex((call) => /upload\.test/.test(call.url));
    const postAt = api.calls.findIndex((call) => /\/rest\/posts$/.test(call.url));

    expect(uploadAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeLessThan(postAt);
  });

  it('attaches the image urn and its alt text', async () => {
    await provider(api).publish(publishContext({ media: [image()] }));

    const media = (api.bodyTo(/\/rest\/posts$/)['content'] as Record<string, unknown>)[
      'media'
    ] as Record<string, unknown>;

    expect(media['id']).toBe('urn:li:image:abc');
    expect(media['altText']).toBe('A photograph');
  });

  /**
   * LinkedIn does not scrape the URL — the docs say so outright — so a title
   * has to be supplied or the post renders as a bare link.
   */
  it('supplies a title for a link post, because LinkedIn will not scrape one', async () => {
    await provider(api).publish(
      publishContext({
        draft: { body: 'Our new case study', linkUrl: 'https://example.com/x', media: [] },
      }),
    );

    const article = (api.bodyTo(/\/rest\/posts$/)['content'] as Record<string, unknown>)[
      'article'
    ] as Record<string, unknown>;

    expect(article['source']).toBe('https://example.com/x');
    expect(article['title']).toBe('Our new case study');
  });

  it('refuses a second image before sending anything', async () => {
    await expect(
      provider(api).publish(publishContext({ media: [image(), { ...image(), id: 'm2' }] })),
    ).rejects.toMatchObject({ code: 'PROVIDER_VALIDATION_ERROR' });

    expect(api.calls).toHaveLength(0);
  });

  it('refuses video, which this adapter does not build', async () => {
    await expect(
      provider(api).publish(
        publishContext({
          media: [{ ...image(), kind: 'VIDEO', mimeType: 'video/mp4', durationMs: 10_000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_VALIDATION_ERROR' });
  });

  it('is a configuration failure, not a media one, without a reader', async () => {
    const local = happyApi();

    await expect(
      provider(local, { readMedia: undefined }).publish(publishContext({ media: [image()] })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('errors', () => {
  /**
   * LinkedIn calls 409 a write conflict and says to retry. Treating it as
   * permanent would throw away a post over a momentary collision.
   */
  it('treats a write conflict as retryable', async () => {
    const local = happyApi().on(/\/rest\/posts$/, {
      status: 409,
      body: { message: 'conflict', status: 409 },
    });

    await expect(provider(local).publish(publishContext())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('treats a lost page role as a permission failure, not a dead token', async () => {
    const local = happyApi().on(/\/rest\/posts$/, {
      status: 403,
      body: { message: 'ACCESS_DENIED', status: 403 },
    });

    await expect(provider(local).publish(publishContext())).rejects.toMatchObject({
      code: 'PROVIDER_PERMISSION_ERROR',
    });
  });
});

describe('health', () => {
  /**
   * Reading the page back proves the token *and* the role. Losing an admin
   * role is the thing that actually changes, and "reconnect" only helps once
   * somebody restores it — so the message says that rather than implying a
   * two-click fix.
   */
  it('names the missing page role rather than blaming the connection', async () => {
    const local = new FakeLinkedIn().on(/rest\/organizations\//, {
      status: 403,
      body: { message: 'ACCESS_DENIED', status: 403 },
    });

    const health = await provider(local).probeHealth(credential, {
      externalId: 'urn:li:organization:123',
    });

    expect(health.status).toBe('NEEDS_RECONNECT');
    expect(health.message).toMatch(/permission to post to that page/i);
  });
});

describe('deleting', () => {
  /** The one platform where this works at all. */
  it('deletes a post', async () => {
    const local = new FakeLinkedIn().on(/\/rest\/posts\//, { status: 204 });

    await expect(
      provider(local).deletePost(
        { externalPostId: 'urn:li:share:987', accountExternalId: 'urn:li:organization:123' },
        credential,
      ),
    ).resolves.toBeUndefined();

    expect(local.callTo(/\/rest\/posts\//)?.headers['x-restli-method']).toBe('DELETE');
  });
});

describe('reconciliation', () => {
  const reconcileCtx = () =>
    ({
      credential,
      account: { externalId: 'urn:li:organization:123' },
      contentHash: 'hash-1',
      body: 'Hello LinkedIn',
      attemptedAt: new Date(),
      windowMs: 600_000,
      correlationId: 'corr-1',
    }) as never;

  it('finds a post published inside the window', async () => {
    const local = new FakeLinkedIn().on(/\/rest\/posts\?/, {
      body: {
        elements: [{ id: 'urn:li:share:555', commentary: 'Hello LinkedIn', createdAt: Date.now() }],
      },
    });

    const result = await provider(local).reconcile(reconcileCtx());

    expect(result.outcome).toBe('FOUND');
    if (result.outcome !== 'FOUND') return;
    expect(result.externalPostId).toBe('urn:li:share:555');
  });

  it('ignores a matching post from outside the window', async () => {
    const local = new FakeLinkedIn().on(/\/rest\/posts\?/, {
      body: {
        elements: [
          {
            id: 'urn:li:share:555',
            commentary: 'Hello LinkedIn',
            // Yesterday: the same words, a different post.
            createdAt: Date.now() - 86_400_000,
          },
        ],
      },
    });

    expect((await provider(local).reconcile(reconcileCtx())).outcome).toBe('NOT_FOUND');
  });

  /** Unreachable is not the same as not published. */
  it('parks rather than guessing when LinkedIn cannot be reached', async () => {
    const local = new FakeLinkedIn().on(/\/rest\/posts\?/, { status: 500, body: {} });

    expect((await provider(local).reconcile(reconcileCtx())).outcome).toBe('INCONCLUSIVE');
  });
});
