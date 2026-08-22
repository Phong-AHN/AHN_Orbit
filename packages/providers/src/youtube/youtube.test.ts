import { beforeEach, describe, expect, it } from 'vitest';
import { YouTubeProvider, titleFrom } from './provider.js';
import type { FetchLike } from './client.js';

/**
 * The YouTube adapter against recorded responses.
 *
 * The cases worth having are the ones where YouTube is unlike the feeds:
 * uploading is a *session* opened by a header rather than a body, the
 * made-for-kids declaration is a legal statement Orbit refuses to make on
 * anybody's behalf, a quota failure is the deployment's problem rather than the
 * channel's, and Google returns a refresh token exactly once.
 */

interface Recorded {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class FakeYouTube {
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
      : { status: 404, body: { error: { code: 404, message: 'no fixture' } } };

    const status = recorded.status ?? 200;
    // 204 and friends must be built with a null body — an empty string throws
    // inside `fetch` and surfaces as "the platform could not be reached", which
    // is a network failure the fixture invented.
    const bodyless = status === 204 || status === 205 || status === 304;

    return new Response(
      bodyless || recorded.body === undefined ? null : JSON.stringify(recorded.body),
      { status, headers: { 'content-type': 'application/json', ...(recorded.headers ?? {}) } },
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

const SESSION_URL = 'https://upload.test/session/abc123';

function happyApi(): FakeYouTube {
  return new FakeYouTube()
    .on(/\/upload\/youtube\/v3\/videos/, {
      status: 200,
      headers: { location: SESSION_URL },
    })
    .on(/upload\.test\/session/, { body: { id: 'vid-987', kind: 'youtube#video' } })
    .on(/\/youtube\/v3\/channels/, {
      body: {
        items: [{ id: 'UC123', snippet: { title: 'Client Channel', customUrl: '@client' } }],
      },
    })
    .on(/oauth2.*\/token/, {
      body: {
        access_token: 'ya29.new',
        refresh_token: '1//refresh',
        expires_in: 3599,
        scope:
          'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      },
    });
}

function provider(api: FakeYouTube, overrides: Record<string, unknown> = {}): YouTubeProvider {
  return new YouTubeProvider({
    clientId: 'yt-client',
    clientSecret: 'yt-secret',
    apiVersion: 'v3',
    fetchImpl: api.fetch,
    baseUrl: 'https://youtube.test',
    tokenUrl: 'https://oauth2.test/token',
    readMedia: async () => new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  });
}

const credential = {
  accessToken: 'ya29.token',
  refreshToken: '1//refresh',
  scopes: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],
  keyVersion: 1,
};

const video = () => ({
  id: 'm1',
  kind: 'VIDEO' as const,
  mimeType: 'video/mp4',
  sizeBytes: 8_000_000,
  url: 'https://cdn.test/a.mp4',
  width: 1080,
  height: 1920,
  durationMs: 30_000,
  frameRate: 30,
  peakFrameRate: 30,
});

function publishContext(overrides: Record<string, unknown> = {}) {
  return {
    credential,
    account: { externalId: 'UC123' },
    draft: {
      body: 'A title line\n\nAnd the description underneath.',
      hashtags: [],
      mentions: [],
      media: [],
      providerOptions: { madeForKids: false },
    },
    media: [video()],
    contentHash: 'hash-1',
    correlationId: 'corr-1',
    ...overrides,
  } as never;
}

let api: FakeYouTube;

beforeEach(() => {
  api = happyApi();
});

describe('capabilities', () => {
  /** There is no text-only YouTube post. The video *is* the post. */
  it('requires media and declares no image kind at all', () => {
    const media = provider(api).capabilities().media;
    expect(media.required).toBe(true);
    expect(media.image).toBeNull();
    expect(media.maxAttachments).toBe(1);
  });

  /**
   * Deleting needs the broad `.../auth/youtube` scope, which Orbit does not
   * ask for. Declaring true would have the UI offer a button that 403s.
   */
  it('declares no delete, matching the narrow scope it asks for', () => {
    expect(provider(api).capabilities().lifecycle.delete).toBe(false);
  });

  /**
   * The December 2025 change. `videos.insert` used to cost 1,600 units against
   * a 10,000-unit pool, capping a project at six uploads a day; uploads now
   * bill to their own bucket of 100. An adapter still encoding the old figure
   * would throttle an agency to a handful of videos.
   */
  it('encodes the current upload allowance rather than the old unit cost', () => {
    const limit = provider(api).capabilities().publishing.rateLimit;
    expect(limit?.maxPosts).toBe(100);
    expect(limit?.windowMs).toBe(24 * 60 * 60 * 1000);
  });

  /** Channel figures need the Analytics API, which is a different API. */
  it('declares no account analytics rather than a method that throws', () => {
    expect(provider(api).capabilities().analytics.account).toBe(false);
  });
});

describe('authorization', () => {
  /**
   * Without both of these Google issues an access token and no refresh token,
   * and the connection dies within the hour with nothing in the logs saying
   * why. This is the single most load-bearing pair of query parameters in the
   * adapter.
   */
  it('asks for offline access and forces the consent screen', () => {
    const { url } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'signed-state',
    });

    const params = new URL(url).searchParams;
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');
  });

  it('space-delimits its scopes and asks for upload and read only', () => {
    const { url, scopes } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });

    expect(new URL(url).searchParams.get('scope')).toBe(scopes.join(' '));
    // The broad scope would also grant deleting any video on the channel.
    expect(scopes).not.toContain('https://www.googleapis.com/auth/youtube');
  });

  it('never puts the client secret in the dialog URL', () => {
    const { url } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });
    expect(url).not.toContain('yt-secret');
  });
});

describe('credentials', () => {
  it('discovers the channels a Google account owns', async () => {
    const result = await provider(api).exchangeCode({
      code: 'auth-code',
      redirectUri: 'https://app.test/cb',
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.externalId).toBe('UC123');
    expect(result.accounts[0]?.handle).toBe('@client');
  });

  /**
   * Google returns a refresh token on the **first** authorization and never
   * again. An adapter that trusted the refresh response verbatim would drop it
   * and turn an hourly renewal into a one-time one — the connection would work
   * all afternoon and be dead by morning.
   */
  it('keeps the existing refresh token when a refresh does not return one', async () => {
    api.on(/oauth2.*\/token/, {
      body: { access_token: 'ya29.rotated', expires_in: 3599 },
    });

    const outcome = await provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    expect(outcome.status).toBe('REFRESHED');
    if (outcome.status !== 'REFRESHED') throw new Error('unreachable');
    expect(outcome.credential.accessToken).toBe('ya29.rotated');
    expect(outcome.credential.refreshToken).toBe('1//refresh');
  });

  it('will not renew a credential that has no refresh token', async () => {
    const outcome = await provider(api).refreshCredential({
      accessToken: 'ya29.token',
      scopes: [],
      keyVersion: 1,
    } as never);

    expect(outcome.status).toBe('REQUIRES_RECONNECT');
  });

  /**
   * A Google access token lives an hour, so an expired one is the ordinary
   * state between refreshes. Calling that NEEDS_RECONNECT would mark every
   * healthy channel broken several times a day.
   */
  it('does not call an expired-but-refreshable channel broken', async () => {
    const health = await provider(api).probeHealth(
      { ...credential, expiresAt: new Date(Date.now() - 60_000) } as never,
      { externalId: 'UC123' },
    );

    expect(health.status).toBe('ACTIVE');
  });

  it('does call an expired channel with no refresh token broken', async () => {
    const health = await provider(api).probeHealth(
      {
        accessToken: 'ya29.token',
        scopes: credential.scopes,
        keyVersion: 1,
        expiresAt: new Date(Date.now() - 60_000),
      } as never,
      { externalId: 'UC123' },
    );

    expect(health.status).toBe('NEEDS_RECONNECT');
  });

  /**
   * Google's revoke endpoint kills the grant for *every* channel on the
   * account. Disconnecting one client's channel must not break another's.
   */
  it('does not call Google when a channel is disconnected', async () => {
    await provider(api).revoke();
    expect(api.calls).toHaveLength(0);
  });
});

describe('publishing', () => {
  it('opens a resumable session and PUTs the bytes to the Location it returns', async () => {
    const result = await provider(api).publish(publishContext());

    const open = api.callTo(/\/upload\/youtube\/v3\/videos/);
    expect(open?.method).toBe('POST');
    expect(new URL(open?.url ?? '').searchParams.get('uploadType')).toBe('resumable');

    const put = api.callTo(/upload\.test\/session/);
    expect(put?.method).toBe('PUT');

    expect(result.externalPostId).toBe('vid-987');
    expect(result.permalink).toBe('https://www.youtube.com/watch?v=vid-987');
  });

  /**
   * Google sizes the session from these headers, and a mismatch fails the PUT
   * rather than the POST — an error that arrives after the upload and names
   * nothing useful.
   */
  it('declares the content type and length when opening the session', async () => {
    await provider(api).publish(publishContext());

    const open = api.callTo(/\/upload\/youtube\/v3\/videos/);
    expect(open?.headers['x-upload-content-type']).toBe('video/mp4');
    expect(open?.headers['x-upload-content-length']).toBe('8000000');
  });

  /**
   * **The declaration Orbit will not make for a client.**
   *
   * `selfDeclaredMadeForKids` is an audience statement under COPPA. Defaulting
   * it either way would put words in a client's mouth that nobody in the agency
   * ever saw. The refusal must happen before anything is uploaded.
   */
  it('refuses to publish without a made-for-kids declaration, before uploading', async () => {
    const ctx = publishContext({
      draft: { body: 'A video', hashtags: [], mentions: [], media: [], providerOptions: {} },
    });

    await expect(provider(api).publish(ctx)).rejects.toThrow(/made-for-kids/i);
    expect(api.calls).toHaveLength(0);
  });

  it('sends the declaration it was given rather than a default', async () => {
    const ctx = publishContext({
      draft: {
        body: 'Kids show',
        hashtags: [],
        mentions: [],
        media: [],
        providerOptions: { madeForKids: true, privacyStatus: 'unlisted' },
      },
    });

    await provider(api).publish(ctx);

    const body = api.bodyTo(/\/upload\/youtube\/v3\/videos/);
    const status = body['status'] as Record<string, unknown>;
    expect(status['selfDeclaredMadeForKids']).toBe(true);
    expect(status['privacyStatus']).toBe('unlisted');
  });

  /**
   * A caption written for a feed has no title, and the whole body would
   * overflow YouTube's 100 characters every time. First line for the title,
   * everything for the description.
   */
  it('takes the title from the first line and the description from the whole body', async () => {
    await provider(api).publish(publishContext());

    const snippet = api.bodyTo(/\/upload\/youtube\/v3\/videos/)['snippet'] as Record<
      string,
      unknown
    >;
    expect(snippet['title']).toBe('A title line');
    expect(snippet['description']).toBe('A title line\n\nAnd the description underneath.');
  });

  /**
   * The session URL is the only handle that exists, and everything after the
   * session opens is ambiguous on failure. Written *before* the bytes move —
   * a handle recorded afterwards would not exist in the case it is for.
   */
  it('records the session URL before uploading a single byte', async () => {
    const order: string[] = [];
    const api2 = happyApi();
    const recording = new YouTubeProvider({
      clientId: 'yt-client',
      clientSecret: 'yt-secret',
      apiVersion: 'v3',
      fetchImpl: async (url, init) => {
        if (/upload\.test\/session/.test(String(url))) order.push('upload');
        return api2.fetch(url, init);
      },
      baseUrl: 'https://youtube.test',
      tokenUrl: 'https://oauth2.test/token',
      readMedia: async () => new Uint8Array([1, 2, 3, 4]),
    });

    let recorded: Record<string, unknown> | undefined;

    await recording.publish(
      publishContext({
        recordProviderRef: async (ref: Record<string, unknown>) => {
          order.push('record');
          recorded = ref;
        },
      }),
    );

    expect(order).toEqual(['record', 'upload']);
    expect(recorded?.['sessionUrl']).toBe(SESSION_URL);
  });

  /** No session URL means no upload target; guessing one would upload nowhere. */
  it('refuses when Google opens a session without a Location header', async () => {
    api.on(/\/upload\/youtube\/v3\/videos/, { status: 200, body: {} });

    await expect(provider(api).publish(publishContext())).rejects.toThrow(/resumable session/i);
    expect(api.callTo(/upload\.test\/session/)).toBeUndefined();
  });

  it('refuses an image, because YouTube has no image post', async () => {
    const ctx = publishContext({
      media: [
        {
          id: 'm2',
          kind: 'IMAGE',
          mimeType: 'image/jpeg',
          sizeBytes: 100_000,
          url: 'https://cdn.test/a.jpg',
        },
      ],
    });

    await expect(provider(api).publish(ctx)).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
});

describe('failures', () => {
  /**
   * `quotaExceeded` is about the **deployment's** Google project and every
   * channel on it. Demoting the account would send an account manager to
   * reconnect a channel that is working perfectly (D-085).
   */
  it('marks a project-wide quota failure as the client standing, not a bad channel', async () => {
    api.on(/\/upload\/youtube\/v3\/videos/, {
      status: 403,
      body: {
        error: {
          code: 403,
          message: 'The request cannot be completed because you have exceeded your quota.',
          errors: [{ reason: 'quotaExceeded' }],
        },
      },
    });

    const error = await provider(api)
      .publish(publishContext())
      .catch((caught: { code?: string; context?: Record<string, unknown> }) => caught);

    expect(error.code).toBe('PROVIDER_RATE_LIMIT');
    expect(error.context?.['clientStanding']).toBe(true);
  });

  /**
   * A per-channel upload limit is *not* the project's quota. Both are rate
   * limits, but only one is somebody else's fault — and standing must not be
   * claimed for the channel's own limit.
   */
  it('keeps a per-channel upload limit distinct from the project quota', async () => {
    api.on(/\/upload\/youtube\/v3\/videos/, {
      status: 403,
      body: {
        error: { code: 403, errors: [{ reason: 'uploadLimitExceeded' }], message: 'Too many' },
      },
    });

    const error = await provider(api)
      .publish(publishContext())
      .catch((caught: { code?: string; context?: Record<string, unknown> }) => caught);

    expect(error.code).toBe('PROVIDER_RATE_LIMIT');
    expect(error.context?.['clientStanding']).toBeUndefined();
  });

  /**
   * A Google account without a channel is a real, explainable state — not an
   * outage. The generic 403 copy would send somebody looking at permissions.
   */
  it('explains a Google account that has no YouTube channel', async () => {
    api.on(/\/youtube\/v3\/channels/, {
      status: 401,
      body: { error: { code: 401, errors: [{ reason: 'youtubeSignupRequired' }] } },
    });

    const error = await provider(api)
      .exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb' })
      .catch((caught: { userMessage?: string }) => caught);

    expect(error.userMessage).toMatch(/no YouTube channel/i);
  });

  /** Nothing was sent, so "the platform rejected this" would be a plain untruth. */
  it('says it never called YouTube when it refuses a draft itself', async () => {
    const ctx = publishContext({
      draft: {
        body: 'x'.repeat(200),
        hashtags: [],
        mentions: [],
        media: [],
        providerOptions: { madeForKids: false },
      },
    });

    const error = await provider(api)
      .publish(ctx)
      .catch((caught: { context?: Record<string, unknown> }) => caught);

    expect(error.context?.['calledPlatform']).toBe(false);
    expect(api.calls).toHaveLength(0);
  });
});

describe('reconciliation', () => {
  const reconcileContext = (overrides: Record<string, unknown> = {}) =>
    ({
      credential,
      account: { externalId: 'UC123' },
      contentHash: 'hash-1',
      body: 'A title line\n\nAnd the description underneath.',
      attemptedAt: new Date('2026-08-19T10:00:00Z'),
      windowMs: 10 * 60 * 1000,
      correlationId: 'corr-1',
      ...overrides,
    }) as never;

  it('finds a video uploaded inside the window with the same title', async () => {
    api.on(/\/youtube\/v3\/search/, {
      body: {
        items: [
          {
            id: 'vid-987',
            snippet: { publishedAt: '2026-08-19T10:00:30Z', title: 'A title line' },
          },
        ],
      },
    });

    const result = await provider(api).reconcile(reconcileContext());
    expect(result.outcome).toBe('FOUND');
  });

  /** Same title, hours earlier: somebody else's upload, or a previous week's. */
  it('ignores a same-titled video outside the window', async () => {
    api.on(/\/youtube\/v3\/search/, {
      body: {
        items: [
          {
            id: 'vid-old',
            snippet: { publishedAt: '2026-08-19T04:00:00Z', title: 'A title line' },
          },
        ],
      },
    });

    expect((await provider(api).reconcile(reconcileContext())).outcome).toBe('NOT_FOUND');
  });

  /**
   * NOT_FOUND means "we looked and it is not there", and the engine publishes
   * again on that answer. Saying it because the listing failed would publish a
   * second copy.
   */
  it('is inconclusive rather than NOT_FOUND when the listing fails', async () => {
    api.on(/\/youtube\/v3\/search/, { status: 500, body: { error: { code: 500 } } });

    const result = await provider(api).reconcile(reconcileContext());
    expect(result.outcome).toBe('INCONCLUSIVE');
  });
});

describe('analytics', () => {
  /**
   * A channel can hide its like count, and YouTube then omits the field
   * entirely. Reporting 0 would claim a video nobody liked (SRS §18).
   */
  it('reports a hidden like count as unsupported rather than zero', async () => {
    api.on(/\/youtube\/v3\/videos/, {
      body: { items: [{ id: 'vid-987', statistics: { viewCount: '1200', commentCount: '3' } }] },
    });

    const metrics = await provider(api).fetchPostAnalytics(
      { externalPostId: 'vid-987', accountExternalId: 'UC123' },
      credential as never,
      { from: new Date('2026-08-01'), to: new Date('2026-08-19') },
    );

    expect(metrics.metrics['viewCount']).toBe(1200);
    expect(metrics.availability['likeCount']).toBe('UNSUPPORTED');
    expect(metrics.metrics['likeCount']).toBeUndefined();
  });
});

describe('titleFrom', () => {
  it('takes the first line and caps it at YouTube’s 100 characters', () => {
    expect(titleFrom('First\nSecond')).toBe('First');
    expect(titleFrom('x'.repeat(200))).toHaveLength(100);
  });
});
