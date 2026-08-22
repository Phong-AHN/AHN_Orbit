import { beforeEach, describe, expect, it } from 'vitest';
import { PinterestProvider, titleFrom } from './provider.js';
import type { FetchLike } from './client.js';

/**
 * The Pinterest adapter against recorded responses.
 *
 * The cases worth having are where Pinterest is unlike a feed: a pin has to be
 * filed on a board somebody chose, a video pin needs a cover image Orbit will
 * not invent, the bytes go to a storage bucket that is not Pinterest and must
 * not see a bearer token, and a retry has to resume a transcode rather than
 * restart it.
 */

interface Recorded {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class FakePinterest {
  readonly calls: Array<{
    url: string;
    method: string;
    body?: string;
    form?: FormData;
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
    const form = init?.body instanceof FormData ? init.body : undefined;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    this.calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(body ? { body } : {}),
      ...(form ? { form } : {}),
      headers,
    });

    const route = [...this.routes].reverse().find((candidate) => candidate.match.test(url));
    const recorded = route
      ? typeof route.response === 'function'
        ? route.response()
        : route.response
      : { status: 404, body: { code: 404, message: 'no fixture' } };

    const status = recorded.status ?? 200;
    // A bodyless status must be constructed with null — an empty string throws
    // inside `fetch`, and the fixture would be inventing a network failure.
    const bodyless = status === 204 || status === 205 || status === 304;

    return new Response(
      bodyless || recorded.body === undefined ? null : JSON.stringify(recorded.body),
      { status, headers: { 'content-type': 'application/json', ...(recorded.headers ?? {}) } },
    );
  };

  callTo(pattern: RegExp) {
    return this.calls.find((call) => pattern.test(call.url));
  }

  callsTo(pattern: RegExp) {
    return this.calls.filter((call) => pattern.test(call.url));
  }

  bodyTo(pattern: RegExp): Record<string, unknown> {
    const call = this.callTo(pattern);
    return call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : {};
  }
}

const BUCKET_URL = 'https://pinterest-media-upload.test/bucket';

function happyApi(): FakePinterest {
  return new FakePinterest()
    .on(/\/v5\/user_account/, {
      body: { id: 'acct-1', username: 'clienthandle', business_name: 'Client Co' },
    })
    .on(/\/v5\/boards/, {
      body: { items: [{ id: 'board-1', name: 'Recipes', privacy: 'PUBLIC' }] },
    })
    .on(/\/v5\/media$/, {
      status: 201,
      body: {
        media_id: 'media-77',
        media_type: 'video',
        upload_url: BUCKET_URL,
        upload_parameters: { key: 'uploads/77', policy: 'signed-policy' },
      },
    })
    .on(/\/v5\/media\//, { body: { media_id: 'media-77', status: 'succeeded' } })
    .on(/pinterest-media-upload\.test/, { status: 204 })
    .on(/\/v5\/pins$/, {
      status: 201,
      body: { id: 'pin-555', created_at: '2026-08-19T10:00:05Z', title: 'A pin title' },
    })
    .on(/\/v5\/oauth\/token/, {
      body: {
        access_token: 'pina_access',
        refresh_token: 'pinr_refresh',
        expires_in: 2_592_000,
        refresh_token_expires_in: 5_184_000,
        scope: 'user_accounts:read,boards:read,pins:read,pins:write',
      },
    });
}

function provider(api: FakePinterest, overrides: Record<string, unknown> = {}): PinterestProvider {
  return new PinterestProvider({
    clientId: 'pin-client',
    clientSecret: 'pin-secret',
    apiVersion: 'v5',
    fetchImpl: api.fetch,
    baseUrl: 'https://pinterest.test',
    readMedia: async () => new Uint8Array([1, 2, 3, 4]),
    pollIntervalMs: 1,
    pollBudgetMs: 50,
    ...overrides,
  });
}

const credential = {
  accessToken: 'pina_access',
  refreshToken: 'pinr_refresh',
  scopes: ['user_accounts:read', 'boards:read', 'pins:read', 'pins:write'],
  keyVersion: 1,
};

const video = () => ({
  id: 'm1',
  kind: 'VIDEO' as const,
  mimeType: 'video/mp4',
  sizeBytes: 12_000_000,
  url: 'https://cdn.test/a.mp4',
  width: 1080,
  height: 1920,
  durationMs: 20_000,
  frameRate: 30,
  peakFrameRate: 30,
});

const cover = () => ({
  id: 'm2',
  kind: 'IMAGE' as const,
  mimeType: 'image/jpeg',
  sizeBytes: 300_000,
  url: 'https://cdn.test/cover.jpg',
  width: 1000,
  height: 1500,
  altText: 'A bowl of soup',
});

function publishContext(overrides: Record<string, unknown> = {}) {
  return {
    credential,
    account: { externalId: 'acct-1' },
    draft: {
      body: 'A pin title\n\nWhat it is about.',
      hashtags: [],
      mentions: [],
      media: [],
      linkUrl: 'https://client.test/recipe',
      providerOptions: { boardId: 'board-1' },
    },
    media: [video(), cover()],
    contentHash: 'hash-1',
    correlationId: 'corr-1',
    ...overrides,
  } as never;
}

let api: FakePinterest;

beforeEach(() => {
  api = happyApi();
});

describe('capabilities', () => {
  /**
   * Two slots, and neither is a gallery: one is the pin and the other is the
   * still Pinterest shows when the video is not playing.
   */
  it('allows two mixed attachments but declares no carousel', () => {
    const media = provider(api).capabilities().media;
    expect(media.maxAttachments).toBe(2);
    expect(media.allowsMixedKinds).toBe(true);
    expect(media.carousel).toBe(false);
    expect(media.required).toBe(true);
  });

  /** Verified: 4 seconds to 15 minutes. A 2-second clip is refused locally. */
  it('encodes the 4-second floor Pinterest enforces', () => {
    expect(provider(api).capabilities().media.video?.minDurationMs).toBe(4_000);
  });

  it('declares that a pin can be deleted, within the scope it holds', () => {
    expect(provider(api).capabilities().lifecycle.delete).toBe(true);
  });
});

describe('authorization', () => {
  /**
   * Pinterest joins scopes with **commas**. A space-joined list is accepted,
   * grants nothing, and surfaces much later as a 403 on the first publish —
   * which reads like a broken connection rather than a malformed dialog.
   */
  it('comma-delimits its scopes', () => {
    const { url, scopes } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'signed-state',
    });

    expect(new URL(url).searchParams.get('scope')).toBe(scopes.join(','));
    expect(scopes).toContain('pins:write');
  });

  /** A secret board is private by intent; an agency tool should not reach in. */
  it('asks for no secret-board scope and no write access to boards', () => {
    const { scopes } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });

    expect(scopes.some((scope) => scope.includes('secret'))).toBe(false);
    expect(scopes).not.toContain('boards:write');
  });

  it('never puts the client secret in the dialog URL', () => {
    const { url } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });
    expect(url).not.toContain('pin-secret');
  });
});

describe('credentials', () => {
  /**
   * Pinterest authenticates the token call with HTTP Basic. Putting the secret
   * in the form body returns 401 with no hint that the header was the problem.
   */
  it('authenticates the token exchange with Basic rather than a body field', async () => {
    await provider(api).exchangeCode({ code: 'code', redirectUri: 'https://app.test/cb' });

    const call = api.callTo(/\/v5\/oauth\/token/);
    expect(call?.headers['authorization']).toBe(
      `Basic ${Buffer.from('pin-client:pin-secret').toString('base64')}`,
    );
    expect(call?.body).not.toContain('pin-secret');
  });

  it('connects the single account behind the token', async () => {
    const result = await provider(api).exchangeCode({
      code: 'code',
      redirectUri: 'https://app.test/cb',
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.externalId).toBe('acct-1');
    expect(result.accounts[0]?.handle).toBe('clienthandle');
  });

  /**
   * Pinterest only returns a new refresh token when the app rotates them.
   * Trusting the response verbatim would drop the stored one on every ordinary
   * refresh and turn a self-sustaining connection into a 30-day one.
   */
  it('keeps the existing refresh token when a refresh does not return one', async () => {
    api.on(/\/v5\/oauth\/token/, {
      body: { access_token: 'pina_new', expires_in: 2_592_000 },
    });

    const outcome = await provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    expect(outcome.status).toBe('REFRESHED');
    if (outcome.status !== 'REFRESHED') throw new Error('unreachable');
    expect(outcome.credential.refreshToken).toBe('pinr_refresh');
  });

  /** 60 days idle and the refresh token is gone. A human has to reconnect. */
  it('requires a reconnect once the refresh window has passed', async () => {
    const outcome = await provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() - 60_000),
      refreshableUntil: new Date(Date.now() - 1_000),
    } as never);

    expect(outcome.status).toBe('REQUIRES_RECONNECT');
    expect(api.callTo(/\/v5\/oauth\/token/)).toBeUndefined();
  });

  it('leaves a token that is nowhere near expiry alone', async () => {
    const outcome = await provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    } as never);

    expect(outcome.status).toBe('STILL_VALID');
    expect(api.calls).toHaveLength(0);
  });
});

describe('publishing', () => {
  /**
   * **The choice Orbit will not make.** Which board a client's content is filed
   * under is editorial. Picking whichever board came back first would file it
   * somewhere nobody chose, and the refusal has to happen before any upload.
   */
  it('refuses a pin with no board, before touching the API', async () => {
    const ctx = publishContext({
      draft: { body: 'A pin', hashtags: [], mentions: [], media: [], providerOptions: {} },
    });

    await expect(provider(api).publish(ctx)).rejects.toThrow(/board/i);
    expect(api.calls).toHaveLength(0);
  });

  /**
   * **The other one.** Pinterest shows a still wherever the video is not
   * playing and will not take a frame for you. Generating one would put an
   * unreviewed image in front of a client's audience, so the post has to carry
   * it — and the refusal comes before the transcode, not after.
   */
  it('refuses a video pin with no cover image, before uploading anything', async () => {
    const ctx = publishContext({ media: [video()] });

    await expect(provider(api).publish(ctx)).rejects.toThrow(/cover/i);
    expect(api.callTo(/\/v5\/media/)).toBeUndefined();
  });

  it('registers, uploads, waits and then creates the pin', async () => {
    const result = await provider(api).publish(publishContext());

    expect(api.callTo(/\/v5\/media$/)?.method).toBe('POST');
    expect(api.callTo(/pinterest-media-upload\.test/)?.method).toBe('POST');
    expect(api.callTo(/\/v5\/media\//)).toBeDefined();

    const pin = api.bodyTo(/\/v5\/pins$/);
    expect(pin['board_id']).toBe('board-1');
    expect(pin['media_source']).toEqual({
      source_type: 'video_id',
      media_id: 'media-77',
      cover_image_url: 'https://cdn.test/cover.jpg',
    });

    expect(result.externalPostId).toBe('pin-555');
    expect(result.permalink).toBe('https://www.pinterest.com/pin/pin-555/');
  });

  /**
   * The bucket is not Pinterest. An Authorization header it did not expect
   * makes it refuse the whole upload, and the policy fields have to be written
   * before the file part or the bucket rejects the bytes before it knows the
   * policy.
   */
  it('uploads to the bucket with the policy fields first and no bearer token', async () => {
    await provider(api).publish(publishContext());

    const upload = api.callTo(/pinterest-media-upload\.test/);
    expect(upload?.headers['authorization']).toBeUndefined();

    const keys = [...(upload?.form?.keys() ?? [])];
    expect(keys).toEqual(['key', 'policy', 'file']);
  });

  /**
   * `media_id` is the only handle a retry has. Written before the bytes move —
   * a handle recorded afterwards would not exist in the case it is for.
   */
  it('records the media id before uploading a single byte', async () => {
    const order: string[] = [];
    const api2 = happyApi();

    const recording = new PinterestProvider({
      clientId: 'pin-client',
      clientSecret: 'pin-secret',
      apiVersion: 'v5',
      fetchImpl: async (url, init) => {
        if (/pinterest-media-upload\.test/.test(String(url))) order.push('upload');
        return api2.fetch(url, init);
      },
      baseUrl: 'https://pinterest.test',
      readMedia: async () => new Uint8Array([1, 2, 3, 4]),
      pollIntervalMs: 1,
      pollBudgetMs: 50,
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
    expect(recorded?.['mediaId']).toBe('media-77');
  });

  /**
   * Without this a video slower than one poll budget could never publish: every
   * attempt would re-register, re-upload and run out of budget at the same
   * point in the transcode.
   */
  it('resumes a previous upload instead of re-registering and re-uploading', async () => {
    await provider(api).publish(
      publishContext({
        previousRef: { mediaId: 'media-77', contentHash: 'hash-1', kind: 'video' },
      }),
    );

    expect(api.callTo(/\/v5\/media$/)).toBeUndefined();
    expect(api.callTo(/pinterest-media-upload\.test/)).toBeUndefined();
    expect(api.bodyTo(/\/v5\/pins$/)['media_source']).toMatchObject({ media_id: 'media-77' });
  });

  /**
   * A handle from a *different* draft must not be resumed — it would attach
   * last week's video to this week's pin.
   */
  it('ignores a recorded handle that belongs to different content', async () => {
    await provider(api).publish(
      publishContext({
        previousRef: { mediaId: 'media-old', contentHash: 'hash-other', kind: 'video' },
      }),
    );

    expect(api.callTo(/\/v5\/media$/)).toBeDefined();
    expect(api.bodyTo(/\/v5\/pins$/)['media_source']).toMatchObject({ media_id: 'media-77' });
  });

  /** An image pin skips the whole media dance — Pinterest fetches the URL. */
  it('creates an image pin straight from the media URL', async () => {
    await provider(api).publish(publishContext({ media: [cover()] }));

    expect(api.callTo(/\/v5\/media/)).toBeUndefined();
    expect(api.bodyTo(/\/v5\/pins$/)['media_source']).toEqual({
      source_type: 'image_url',
      url: 'https://cdn.test/cover.jpg',
    });
  });

  it('takes the pin title from the first line and the link from the draft', async () => {
    await provider(api).publish(publishContext());

    const pin = api.bodyTo(/\/v5\/pins$/);
    expect(pin['title']).toBe('A pin title');
    expect(pin['description']).toBe('A pin title\n\nWhat it is about.');
    expect(pin['link']).toBe('https://client.test/recipe');
  });
});

describe('waiting for the transcode', () => {
  /**
   * Running out of budget is **not** ambiguous: no pin has been created, so
   * nothing went out. A TIMEOUT here would park every slow video for a human
   * when all it needed was longer.
   */
  it('asks to be retried rather than parked when the transcode is still running', async () => {
    api.on(/\/v5\/media\//, { body: { media_id: 'media-77', status: 'processing' } });

    const error = await provider(api)
      .publish(publishContext())
      .catch((caught: { code?: string }) => caught);

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(api.callTo(/\/v5\/pins$/)).toBeUndefined();
  });

  it('reports a failed transcode as a media problem and creates no pin', async () => {
    api.on(/\/v5\/media\//, { body: { media_id: 'media-77', status: 'failed' } });

    const error = await provider(api)
      .publish(publishContext())
      .catch((caught: { code?: string }) => caught);

    expect(error.code).toBe('PROVIDER_MEDIA_ERROR');
    expect(api.callTo(/\/v5\/pins$/)).toBeUndefined();
  });

  it('creates the pin as soon as the media succeeds', async () => {
    let polls = 0;
    api.on(/\/v5\/media\//, () => {
      polls += 1;
      return { body: { media_id: 'media-77', status: polls < 2 ? 'processing' : 'succeeded' } };
    });

    await provider(api).publish(publishContext());

    expect(polls).toBe(2);
    expect(api.callTo(/\/v5\/pins$/)).toBeDefined();
  });
});

describe('failures', () => {
  /**
   * A 429 is the account's own daily allowance, not a broken connection.
   * Demoting the account would send somebody to reconnect one that works
   * perfectly (D-085).
   */
  it('marks a rate limit as the client standing rather than a bad account', async () => {
    api.on(/\/v5\/pins$/, {
      status: 429,
      body: { code: 8, message: 'You have exceeded your rate limit' },
      headers: { 'retry-after': '120' },
    });

    const error = await provider(api)
      .publish(publishContext())
      .catch((caught: { code?: string; context?: Record<string, unknown> }) => caught);

    expect(error.code).toBe('PROVIDER_RATE_LIMIT');
    expect(error.context?.['clientStanding']).toBe(true);
  });

  /** Nothing was sent, so "the platform rejected this" would be a plain untruth. */
  it('says it never called Pinterest when it refuses a draft itself', async () => {
    const ctx = publishContext({
      draft: {
        body: 'x'.repeat(900),
        hashtags: [],
        mentions: [],
        media: [],
        providerOptions: { boardId: 'board-1' },
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
      account: { externalId: 'acct-1' },
      contentHash: 'hash-1',
      body: 'A pin title\n\nWhat it is about.',
      attemptedAt: new Date('2026-08-19T10:00:00Z'),
      windowMs: 10 * 60 * 1000,
      correlationId: 'corr-1',
      ...overrides,
    }) as never;

  it('finds a pin created inside the window with the same title', async () => {
    api.on(/\/v5\/pins\?/, {
      body: {
        items: [{ id: 'pin-555', created_at: '2026-08-19T10:00:05Z', title: 'A pin title' }],
      },
    });

    expect((await provider(api).reconcile(reconcileContext())).outcome).toBe('FOUND');
  });

  it('ignores a same-titled pin created outside the window', async () => {
    api.on(/\/v5\/pins\?/, {
      body: {
        items: [{ id: 'pin-old', created_at: '2026-08-18T10:00:00Z', title: 'A pin title' }],
      },
    });

    expect((await provider(api).reconcile(reconcileContext())).outcome).toBe('NOT_FOUND');
  });

  /**
   * NOT_FOUND makes the engine publish again. Saying it because the listing
   * failed would create a second pin.
   */
  it('is inconclusive rather than NOT_FOUND when the listing fails', async () => {
    api.on(/\/v5\/pins\?/, { status: 500, body: { code: 0, message: 'oops' } });

    expect((await provider(api).reconcile(reconcileContext())).outcome).toBe('INCONCLUSIVE');
  });
});

describe('analytics', () => {
  /**
   * The video metrics are simply absent on an image pin — Pinterest omits
   * rather than zeroes them. Storing 0 would report a video nobody watched for
   * a pin that has no video at all (SRS §18).
   */
  it('reports an absent metric as unsupported rather than zero', async () => {
    api.on(/\/v5\/pins\/.*\/analytics/, {
      body: { ALL: { summary_metrics: { IMPRESSION: 400, SAVE: 12, PIN_CLICK: 7 } } },
    });

    const metrics = await provider(api).fetchPostAnalytics(
      { externalPostId: 'pin-555', accountExternalId: 'acct-1' },
      credential as never,
      { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-08-19T00:00:00Z') },
    );

    expect(metrics.metrics['IMPRESSION']).toBe(400);
    expect(metrics.availability['VIDEO_MRC_VIEW']).toBe('UNSUPPORTED');
    expect(metrics.metrics['VIDEO_MRC_VIEW']).toBeUndefined();
  });

  it('sends plain dates, which is the only format the endpoint accepts', async () => {
    api.on(/\/v5\/pins\/.*\/analytics/, { body: { ALL: { summary_metrics: {} } } });

    await provider(api).fetchPostAnalytics(
      { externalPostId: 'pin-555', accountExternalId: 'acct-1' },
      credential as never,
      { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-08-19T00:00:00Z') },
    );

    const params = new URL(api.callTo(/analytics/)?.url ?? '').searchParams;
    expect(params.get('start_date')).toBe('2026-08-01');
    expect(params.get('end_date')).toBe('2026-08-19');
  });
});

describe('boards', () => {
  it('lists the boards a pin can be filed on', async () => {
    const boards = await provider(api).listBoards(credential as never);

    expect(boards).toEqual([{ id: 'board-1', name: 'Recipes', privacy: 'PUBLIC' }]);
  });
});

describe('titleFrom', () => {
  it('takes the first line and caps it at 100 characters', () => {
    expect(titleFrom('First\nSecond')).toBe('First');
    expect(titleFrom('x'.repeat(200))).toHaveLength(100);
  });
});
