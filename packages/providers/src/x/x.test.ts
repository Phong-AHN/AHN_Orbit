import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock, fixedClock, setClock } from '@orbit/core';
import { runProviderContractTests } from '../contract/contract-tests.js';
import { XProvider } from './provider.js';
import type { FetchLike } from './client.js';
import { validateDraft } from '../validation.js';
import { xCapabilities } from './capabilities.js';

/**
 * The X adapter against recorded responses.
 *
 * The cases worth having are where X is unlike the other platforms here: PKCE
 * is mandatory, the token endpoint wants HTTP Basic, a 403 can mean "you
 * posted this already" rather than "you may not", every URL is rewritten to
 * t.co so reconciliation cannot compare text naively, and the limit is 280
 * *weighted* characters.
 */

interface Recorded {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class FakeX {
  readonly calls: Array<{
    url: string;
    method: string;
    body?: string;
    form?: FormData;
    headers: Record<string, string>;
  }> = [];

  private routes: Array<{ match: RegExp; method?: string; response: Recorded | (() => Recorded) }> =
    [];

  private taps: Array<(call: FakeX['calls'][number]) => void> = [];

  on(match: RegExp, response: Recorded | (() => Recorded), method?: string): this {
    this.routes.push({ match, response, ...(method ? { method } : {}) });
    return this;
  }

  /** Observe every call before it is answered, for fixtures that keep state. */
  tap(observer: (call: FakeX['calls'][number]) => void): this {
    this.taps.push(observer);
    return this;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    this.calls.push({
      url,
      method,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(init?.body instanceof FormData ? { form: init.body } : {}),
      headers,
    });
    const recordedCall = this.calls.at(-1);
    if (recordedCall) for (const observer of this.taps) observer(recordedCall);

    const route = [...this.routes]
      .reverse()
      .find(
        (candidate) =>
          candidate.match.test(url) && (!candidate.method || candidate.method === method),
      );
    const recorded = route
      ? typeof route.response === 'function'
        ? route.response()
        : route.response
      : { status: 404, body: { title: 'Not Found', detail: `no fixture for ${method} ${url}` } };

    const status = recorded.status ?? 200;
    const bodyless = status === 204 || status === 205 || status === 304;

    return new Response(
      bodyless || recorded.body === undefined ? null : JSON.stringify(recorded.body),
      { status, headers: { 'content-type': 'application/json', ...(recorded.headers ?? {}) } },
    );
  };

  callTo(pattern: RegExp, method?: string) {
    return this.calls.find((call) => pattern.test(call.url) && (!method || call.method === method));
  }

  callsTo(pattern: RegExp, method?: string) {
    return this.calls.filter(
      (call) => pattern.test(call.url) && (!method || call.method === method),
    );
  }

  jsonTo(pattern: RegExp, method?: string): Record<string, unknown> {
    const call = this.callTo(pattern, method);
    return call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : {};
  }
}

const VERIFIER = 'v'.repeat(43);
const NOW = Date.UTC(2026, 10, 4, 9, 0, 0);

function happyApi(): FakeX {
  return new FakeX()
    .on(/\/2\/oauth2\/token/, {
      body: {
        token_type: 'bearer',
        access_token: 'x-access',
        refresh_token: 'x-refresh-2',
        expires_in: 7200,
        scope: 'tweet.read tweet.write users.read media.write offline.access',
      },
    })
    .on(/\/2\/users\/me/, {
      body: {
        data: {
          id: 'u-1',
          name: 'Client Co',
          username: 'clientco',
          profile_image_url: 'https://pbs.test/a.jpg',
        },
      },
    })
    .on(/\/2\/media\/upload\/initialize/, {
      body: { data: { id: 'm-1', media_key: '3_m-1', expires_after_secs: 86_400 } },
    })
    .on(/\/2\/media\/upload\/m-1\/append/, { status: 204 })
    .on(/\/2\/media\/upload\/m-1\/finalize/, {
      body: { data: { id: 'm-1', expires_after_secs: 86_400 } },
    })
    .on(/\/2\/media\/upload\?/, { body: { data: { id: 'm-1' } } })
    .on(/\/2\/media\/metadata/, { body: { data: { id: 'm-1' } } })
    .on(/\/2\/tweets$/, { status: 201, body: { data: { id: 't-9', text: 'Hello' } } }, 'POST');
}

function provider(api: FakeX, overrides: Record<string, unknown> = {}): XProvider {
  return new XProvider({
    clientId: 'x-client',
    clientSecret: 'x-secret',
    fetchImpl: api.fetch,
    baseUrl: 'https://x.test',
    readMediaRange: async ({ firstByte, lastByte }: { firstByte: number; lastByte: number }) =>
      new Uint8Array(lastByte - firstByte + 1),
    pollIntervalMs: 1,
    pollBudgetMs: 50,
    ...overrides,
  });
}

const credential = {
  accessToken: 'x-access',
  refreshToken: 'x-refresh-1',
  expiresAt: new Date(NOW + 2 * 60 * 60 * 1000),
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
  keyVersion: 1,
};

const image = (overrides: Record<string, unknown> = {}) => ({
  id: 'media-a',
  kind: 'IMAGE' as const,
  mimeType: 'image/jpeg',
  sizeBytes: 300_000,
  url: 'https://cdn.test/a.jpg',
  width: 1200,
  height: 800,
  ...overrides,
});

function publishContext(overrides: Record<string, unknown> = {}) {
  return {
    credential,
    account: { externalId: 'u-1' },
    draft: { body: 'Hello from the agency', hashtags: [], mentions: [], media: [] },
    media: [],
    contentHash: 'hash-1',
    correlationId: 'corr-1',
    ...overrides,
  } as never;
}

/**
 * A stateful X for the contract suite, which publishes and then expects to
 * find what it published. Posts are stored as X stores them — with the text
 * as sent — and listed back on the timeline.
 */
function contractApi(): FakeX {
  const posted: Array<{ id: string; text: string; created_at: string }> = [];

  return happyApi()
    .tap((call) => {
      if (call.method !== 'POST' || !/\/2\/tweets$/.test(call.url) || !call.body) return;
      const { text } = JSON.parse(call.body) as { text?: string };
      posted.push({
        id: `t-${posted.length + 1}`,
        text: text ?? '',
        created_at: clock.now().toISOString(),
      });
    })
    .on(
      /\/2\/tweets$/,
      () => ({ status: 201, body: { data: { id: `t-${posted.length}` } } }),
      'POST',
    )
    .on(/\/2\/users\/u-1\/tweets/, () => ({ body: { data: posted } }))
    .on(/\/2\/users\/u-1(\?|$)/, {
      body: {
        data: {
          id: 'u-1',
          public_metrics: {
            followers_count: 10,
            following_count: 2,
            tweet_count: 3,
            listed_count: 0,
          },
        },
      },
    });
}

runProviderContractTests({
  name: 'X',
  createProvider: () => provider(contractApi()),
  validCredential: () => credential,
  sampleAccount: { externalId: 'u-1' },
  validDraft: () => ({ body: 'Fresh beans in tomorrow.' }),
});

let api: FakeX;
let restoreClock: () => void;

beforeEach(() => {
  api = happyApi();
  restoreClock = setClock(fixedClock(NOW));
});

afterEach(() => restoreClock());

describe('authorization', () => {
  it('sends an S256 challenge derived from the verifier, and never the verifier', () => {
    const { url } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'signed-state',
      codeVerifier: VERIFIER,
    });

    const params = new URL(url).searchParams;
    expect(params.get('code_challenge')).toBe(
      createHash('sha256').update(VERIFIER).digest('base64url'),
    );
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(url).not.toContain(VERIFIER);
    expect(url).not.toContain('x-secret');
  });

  /** Without offline.access there is no refresh token, and the connection dies in two hours. */
  it('asks for offline.access and media.write, space-delimited', () => {
    const { url, scopes } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
      codeVerifier: VERIFIER,
    });

    expect(scopes).toEqual(
      expect.arrayContaining(['offline.access', 'media.write', 'tweet.write']),
    );
    expect(new URL(url).searchParams.get('scope')).toBe(scopes.join(' '));
  });

  it('refuses to start a flow without a PKCE verifier', () => {
    expect(() =>
      provider(api).getAuthorizationUrl({ redirectUri: 'https://app.test/cb', state: 's' }),
    ).toThrow(/PKCE/);
  });
});

describe('credentials', () => {
  it('exchanges with HTTP Basic and the verifier, keeping the secret out of the body', async () => {
    const connected = await provider(api).exchangeCode({
      code: 'code-1',
      redirectUri: 'https://app.test/cb',
      codeVerifier: VERIFIER,
    });

    const call = api.callTo(/\/2\/oauth2\/token/);
    expect(call?.headers['authorization']).toBe(
      `Basic ${Buffer.from('x-client:x-secret').toString('base64')}`,
    );
    const form = new URLSearchParams(call?.body);
    expect(form.get('code_verifier')).toBe(VERIFIER);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(call?.body).not.toContain('x-secret');

    expect(connected.accounts).toEqual([
      expect.objectContaining({ externalId: 'u-1', handle: 'clientco', displayName: 'Client Co' }),
    ]);
    expect(connected.accounts[0]?.credential.expiresAt?.getTime()).toBe(NOW + 7_200_000);
    expect(connected.accounts[0]?.credential.refreshToken).toBe('x-refresh-2');
  });

  it('leaves a token with more than half an hour to run alone', async () => {
    const outcome = await provider(api).refreshCredential(credential);
    expect(outcome).toEqual({ status: 'STILL_VALID' });
    expect(api.calls).toHaveLength(0);
  });

  /** X replaces the refresh token on every use; the new one is what must be stored. */
  it('refreshes near expiry and hands back the replacement refresh token', async () => {
    const outcome = await provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(NOW + 10 * 60 * 1000),
    });

    expect(outcome.status).toBe('REFRESHED');
    expect(outcome.status === 'REFRESHED' && outcome.credential.refreshToken).toBe('x-refresh-2');
    expect(new URLSearchParams(api.callTo(/oauth2\/token/)?.body).get('refresh_token')).toBe(
      'x-refresh-1',
    );
  });

  it('asks for a reconnection when X refuses the refresh token', async () => {
    api.on(/\/2\/oauth2\/token/, {
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: 'Value passed for the token was invalid.',
      },
    });

    const outcome = await provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(NOW - 1000),
    });

    expect(outcome.status).toBe('REQUIRES_RECONNECT');
  });

  /**
   * A 401 at the token endpoint is X refusing our client id and secret. Read
   * as a dead token, it told every X account to reconnect whenever a worker
   * held a wrong or rotated secret — and reconnecting fixed nothing (D-114).
   */
  it('does not blame the account when X refuses our client credentials', async () => {
    api.on(/\/2\/oauth2\/token/, {
      status: 401,
      body: {
        error: 'unauthorized_client',
        error_description: 'Missing valid authorization header',
      },
    });

    const refused = provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(NOW - 1000),
    });

    await expect(refused).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      context: expect.objectContaining({ clientStanding: true }),
    });
  });
});

describe('publishing', () => {
  it('posts the composed text — hashtags and the link written in', async () => {
    const refs: Array<Record<string, unknown>> = [];
    const result = await provider(api).publish(
      publishContext({
        draft: {
          body: 'New menu is live',
          hashtags: ['food', '#saigon'],
          mentions: [],
          media: [],
          linkUrl: 'https://client.test/menu',
        },
        recordProviderRef: async (ref: Record<string, unknown>) => {
          refs.push(ref);
        },
      }),
    );

    expect(api.jsonTo(/\/2\/tweets$/, 'POST')).toEqual({
      text: 'New menu is live\n\n#food #saigon\n\nhttps://client.test/menu',
    });
    expect(result.externalPostId).toBe('t-9');
    expect(result.permalink).toBe('https://x.com/i/web/status/t-9');
    // Recorded before the post call, without the link X will rewrite.
    expect(refs.at(-1)?.['publishedText']).toBe('New menu is live\n\n#food #saigon');
  });

  it('uploads an image in the v2 steps, sets its alt text, then attaches it', async () => {
    await provider(api).publish(publishContext({ media: [image({ altText: 'A bowl of pho' })] }));

    expect(api.jsonTo(/media\/upload\/initialize/)).toEqual({
      media_type: 'image/jpeg',
      total_bytes: 300_000,
      media_category: 'tweet_image',
    });
    expect(api.callsTo(/m-1\/append/)).toHaveLength(1);
    expect(api.callTo(/m-1\/finalize/)).toBeDefined();
    // FINALIZE returned no processing_info, so the media is ready: STATUS is
    // not asked, and X can refuse it for an image.
    expect(api.callTo(/\/2\/media\/upload\?/)).toBeUndefined();
    expect(api.jsonTo(/media\/metadata/)).toEqual({
      id: 'm-1',
      metadata: { alt_text: { text: 'A bowl of pho' } },
    });
    expect(api.jsonTo(/\/2\/tweets$/, 'POST')['media']).toEqual({ media_ids: ['m-1'] });
  });

  it('streams a video in numbered 4 MB segments and waits for processing', async () => {
    let polls = 0;
    api
      .on(/\/2\/media\/upload\/m-1\/finalize/, {
        body: {
          data: {
            id: 'm-1',
            expires_after_secs: 86_400,
            processing_info: { state: 'pending', check_after_secs: 0 },
          },
        },
      })
      .on(/\/2\/media\/upload\?/, () => {
        polls += 1;
        return {
          body: {
            data: {
              id: 'm-1',
              processing_info: { state: polls < 2 ? 'in_progress' : 'succeeded' },
            },
          },
        };
      });

    await provider(api).publish(
      publishContext({
        media: [
          {
            id: 'media-v',
            kind: 'VIDEO',
            mimeType: 'video/mp4',
            sizeBytes: 9 * 1024 * 1024,
            url: 'https://cdn.test/v.mp4',
            width: 1080,
            height: 1920,
            durationMs: 30_000,
          },
        ],
      }),
    );

    const segments = api.callsTo(/m-1\/append/).map((call) => call.form?.get('segment_index'));
    expect(segments).toEqual(['0', '1', '2']);
    expect(api.jsonTo(/media\/upload\/initialize/)['media_category']).toBe('tweet_video');
    expect(polls).toBe(2);
    expect(api.callTo(/\/2\/tweets$/, 'POST')).toBeDefined();
  });

  /** Re-uploading would restart a transcode, and a slow video could never publish. */
  it('reuses the media an earlier attempt uploaded instead of sending it again', async () => {
    await provider(api).publish(
      publishContext({
        media: [image()],
        previousRef: {
          contentHash: 'hash-1',
          mediaIds: ['m-1'],
          pendingIds: ['m-1'],
          expiresAt: NOW + 3_600_000,
        },
      }),
    );

    expect(api.callTo(/media\/upload\/initialize/)).toBeUndefined();
    // Still processing when the last attempt stopped, so it is waited on.
    expect(api.callTo(/\/2\/media\/upload\?/)).toBeDefined();
    expect(api.jsonTo(/\/2\/tweets$/, 'POST')['media']).toEqual({ media_ids: ['m-1'] });
  });

  /** A ref from before `pendingIds` cannot say what is processing; start again. */
  it('uploads afresh rather than trust a ref that does not say what is pending', async () => {
    await provider(api).publish(
      publishContext({
        media: [image()],
        previousRef: { contentHash: 'hash-1', mediaIds: ['m-old'], expiresAt: NOW + 3_600_000 },
      }),
    );

    expect(api.callTo(/media\/upload\/initialize/)).toBeDefined();
    expect(api.callTo(/\/2\/media\/upload\?/)).toBeUndefined();
  });

  it('stops before creating a post when processing outlasts the budget', async () => {
    restoreClock();
    restoreClock = () => undefined;
    const processing = { state: 'in_progress', check_after_secs: 0 };
    api
      .on(/\/2\/media\/upload\/m-1\/finalize/, {
        body: { data: { id: 'm-1', expires_after_secs: 86_400, processing_info: processing } },
      })
      .on(/\/2\/media\/upload\?/, { body: { data: { id: 'm-1', processing_info: processing } } });

    const error = await provider(api, { pollBudgetMs: 20 })
      .publish(publishContext({ media: [image()] }))
      .catch((caught: { code?: string }) => caught);

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(api.callTo(/\/2\/tweets$/, 'POST')).toBeUndefined();
  });
});

describe('failures', () => {
  /** Mapped to PERMISSION, a duplicate would demote a working account. */
  it('reads a duplicate post as a problem with the post, not the account', async () => {
    api.on(
      /\/2\/tweets$/,
      {
        status: 403,
        body: {
          title: 'Forbidden',
          detail: 'You are not allowed to create a Tweet with duplicate content.',
        },
      },
      'POST',
    );

    const error = await provider(api)
      .publish(publishContext())
      .catch(
        (caught: { code?: string; userMessage?: string; context?: Record<string, unknown> }) =>
          caught,
      );

    expect(error.code).toBe('PROVIDER_VALIDATION_ERROR');
    expect(error.userMessage).toMatch(/identical/);
    expect(error.context?.['clientStanding']).toBeUndefined();
  });

  /** A post with media is several calls; the failure has to say which, and why. */
  it('names the step that refused, and gives X its own words', async () => {
    api.on(/\/2\/media\/upload\/m-1\/append/, {
      status: 400,
      body: {
        title: 'Invalid Request',
        detail: 'One or more parameters to your request was invalid.',
      },
    });

    const error = await provider(api)
      .publish(publishContext({ media: [image()] }))
      .catch(
        (caught: { code?: string; userMessage?: string; context?: Record<string, unknown> }) =>
          caught,
      );

    expect(error.code).toBe('PROVIDER_VALIDATION_ERROR');
    expect(error.userMessage).toBe(
      'X rejected this post: One or more parameters to your request was invalid.',
    );
    expect(error.context?.['xEndpoint']).toBe('/2/media/upload/m-1/append');
    expect(error.context?.['httpStatus']).toBe(400);
  });

  /**
   * The generic copy has to mean "this never went through here", or it cannot
   * tell a refusal from a worker still running the build before this one.
   */
  it('gives X its own words when the wait on processing is refused', async () => {
    api
      .on(/\/2\/media\/upload\/m-1\/finalize/, {
        body: {
          data: {
            id: 'm-1',
            expires_after_secs: 86_400,
            processing_info: { state: 'pending', check_after_secs: 0 },
          },
        },
      })
      .on(/\/2\/media\/upload\?/, {
        status: 400,
        body: { title: 'Invalid Request', detail: 'The media_id is not valid.' },
      });

    const error = await provider(api)
      .publish(publishContext({ media: [image()] }))
      .catch((caught: { userMessage?: string; context?: Record<string, unknown> }) => caught);

    expect(error.userMessage).toBe('X rejected this post: The media_id is not valid.');
    expect(error.context?.['xEndpoint']).toBe('/2/media/upload');
  });

  it('still says it was X when the refusal gives no reason', async () => {
    api.on(/\/2\/tweets$/, { status: 400, body: {} }, 'POST');

    const error = await provider(api)
      .publish(publishContext())
      .catch((caught: { userMessage?: string }) => caught);

    expect(error.userMessage).toBe('X rejected this post: HTTP 400');
  });

  /** A read has no post to reject: its failure is not about the content. */
  it('does not call a refused read a rejected post', async () => {
    api.on(/\/2\/users\/me/, { status: 400, body: { detail: 'Bad read' } });

    const error = await provider(api)
      .probeHealth(credential, { externalId: 'x-user-1' })
      .catch((caught: { userMessage?: string }) => caught);

    expect((error as { userMessage?: string }).userMessage).not.toMatch(/rejected this post: /);
  });

  it('reports an app that is not enrolled as client standing', async () => {
    api.on(
      /\/2\/tweets$/,
      {
        status: 403,
        body: {
          title: 'Client Forbidden',
          type: 'https://api.twitter.com/2/problems/client-forbidden',
          reason: 'client-not-enrolled',
        },
      },
      'POST',
    );

    const error = await provider(api)
      .publish(publishContext())
      .catch(
        (caught: { code?: string; userMessage?: string; context?: Record<string, unknown> }) =>
          caught,
      );

    expect(error.code).toBe('PROVIDER_PERMISSION_ERROR');
    expect(error.context?.['clientStanding']).toBe(true);
    expect(error.userMessage).toMatch(/reconnecting will not help/);
  });

  it('turns the reset header of a 429 into a delay', async () => {
    api.on(
      /\/2\/tweets$/,
      {
        status: 429,
        body: { title: 'Too Many Requests' },
        headers: { 'x-rate-limit-reset': String(Math.floor(NOW / 1000) + 120) },
      },
      'POST',
    );

    const error = await provider(api)
      .publish(publishContext())
      .catch((caught: { code?: string; retryAfterSeconds?: number }) => caught);

    expect(error.code).toBe('PROVIDER_RATE_LIMIT');
    expect(error.retryAfterSeconds).toBe(120);
  });

  /**
   * Billing refusals clear only when somebody tops up, so they are not
   * retried — and they are the app's standing, so the account stays ACTIVE.
   */
  it.each([
    [
      '402 CreditsDepleted',
      402,
      {
        title: 'CreditsDepleted',
        detail: 'Your enrolled account does not have any credits to fulfill this request.',
        type: 'https://api.twitter.com/2/problems/credits',
      },
    ],
    [
      '429 usage-capped',
      429,
      { title: 'UsageCapExceeded', type: 'https://api.twitter.com/2/problems/usage-capped' },
    ],
  ])('treats %s as billing, not retried and not the account', async (_name, status, body) => {
    api.on(/\/2\/tweets$/, { status, body }, 'POST');

    const error = await provider(api)
      .publish(publishContext())
      .catch(
        (caught: {
          code?: string;
          retryable?: boolean;
          userMessage?: string;
          context?: Record<string, unknown>;
        }) => caught,
      );

    expect(error.code).toBe('PROVIDER_PERMISSION_ERROR');
    expect(error.retryable).toBe(false);
    expect(error.context?.['clientStanding']).toBe(true);
    expect(error.userMessage).toMatch(/console\.x\.com/);
  });
});

describe('validation', () => {
  const caps = xCapabilities('2');

  /** "ệ" and "ạ" are in Latin Extended Additional and count as two on X. */
  it('counts Vietnamese the way X does', () => {
    // 275 characters, but "ạ", "ử" and "ớ" weigh two: 308 as X counts.
    const body = 'Bạn đã thử món mới chưa? '.repeat(11);
    expect([...body].length).toBeLessThanOrEqual(280);

    const result = validateDraft(caps, { body, media: [] });
    expect(result.issues.map((issue) => issue.code)).toContain('TEXT_TOO_LONG');
  });

  it('counts the hashtags and the link that will be written into the post', () => {
    const body = 'x'.repeat(250);
    const result = validateDraft(caps, {
      body,
      hashtags: ['launch'],
      linkUrl: 'https://client.test/a-very-long-landing-page-address',
      media: [],
    });
    // 250 + 2 + 7 + 2 + 23 = 284.
    expect(result.issues.map((issue) => issue.code)).toContain('TEXT_TOO_LONG');
  });

  it('allows four images but a video only on its own', () => {
    const still = { id: 'a', kind: 'IMAGE' as const, mimeType: 'image/jpeg', sizeBytes: 1000 };
    const video = {
      id: 'v',
      kind: 'VIDEO' as const,
      mimeType: 'video/mp4',
      sizeBytes: 1000,
      durationMs: 5000,
    };

    expect(validateDraft(caps, { body: 'ok', media: [still, still, still, still] }).valid).toBe(
      true,
    );
    expect(
      validateDraft(caps, { body: 'ok', media: [video, video] }).issues.map((issue) => issue.code),
    ).toContain('SOLO_MEDIA_KIND');
  });
});

describe('analytics', () => {
  it('maps public and private metrics, and reads video views off the media', async () => {
    api.on(/\/2\/tweets\/t-9/, {
      body: {
        data: {
          id: 't-9',
          public_metrics: {
            impression_count: 900,
            like_count: 40,
            reply_count: 3,
            retweet_count: 5,
            quote_count: 1,
            bookmark_count: 2,
          },
          non_public_metrics: { url_link_clicks: 12, user_profile_clicks: 7, engagements: 70 },
        },
        includes: { media: [{ type: 'video', public_metrics: { view_count: 300 } }] },
      },
    });

    const set = await provider(api).fetchPostAnalytics(
      { externalPostId: 't-9', accountExternalId: 'u-1' },
      credential,
      { from: new Date(NOW - 24 * 60 * 60 * 1000), to: new Date(NOW) },
    );

    expect(set.metrics).toEqual({
      x_impressions: 900,
      x_likes: 40,
      x_replies: 3,
      x_reposts: 5,
      x_quotes: 1,
      x_bookmarks: 2,
      x_link_clicks: 12,
      x_profile_clicks: 7,
      x_engagements: 70,
      x_video_views: 300,
    });
    expect(api.callTo(/tweets\/t-9/)?.url).toContain('non_public_metrics');
  });

  /** Asking for private metrics on an old post is an error; not asking is the honest answer. */
  it('does not ask for private metrics past 30 days, and says they are missing', async () => {
    api.on(/\/2\/tweets\/t-9/, {
      body: { data: { id: 't-9', public_metrics: { impression_count: 10, like_count: 1 } } },
    });

    const set = await provider(api).fetchPostAnalytics(
      { externalPostId: 't-9', accountExternalId: 'u-1' },
      credential,
      { from: new Date(NOW - 40 * 24 * 60 * 60 * 1000), to: new Date(NOW) },
    );

    expect(api.callTo(/tweets\/t-9/)?.url).not.toContain('non_public_metrics');
    expect(set.availability['x_link_clicks']).toBe('UNSUPPORTED');
    expect(set.metrics['x_link_clicks']).toBeUndefined();
    expect(set.availability['x_video_views']).toBe('UNSUPPORTED');
  });

  it('reads follower counts for the account', async () => {
    api.on(/\/2\/users\/u-1/, {
      body: {
        data: {
          id: 'u-1',
          public_metrics: {
            followers_count: 1200,
            following_count: 80,
            tweet_count: 431,
            listed_count: 9,
          },
        },
      },
    });

    const set = await provider(api).fetchAccountAnalytics({ externalId: 'u-1' }, credential, {
      from: new Date(NOW - 1000),
      to: new Date(NOW),
    });

    expect(set.metrics).toEqual({ x_followers: 1200, x_following: 80, x_posts: 431, x_listed: 9 });
  });
});

describe('reconciliation and lifecycle', () => {
  /** X rewrites links to t.co and appends one for media; a naive comparison never matches. */
  it('finds the post despite the t.co rewriting, using the recorded text', async () => {
    api.on(/\/2\/users\/u-1\/tweets/, {
      body: {
        data: [
          {
            id: 't-9',
            text: 'Short one\n\n#food https://t.co/abc https://t.co/media',
            created_at: new Date(NOW).toISOString(),
          },
        ],
      },
    });

    const result = await provider(api).reconcile({
      credential,
      account: { externalId: 'u-1' },
      contentHash: 'hash-1',
      body: 'Short one',
      providerRef: { publishedText: 'Short one\n\n#food' },
      attemptedAt: new Date(NOW),
      windowMs: 10 * 60 * 1000,
      correlationId: 'corr-1',
    });

    expect(result).toMatchObject({ outcome: 'FOUND', externalPostId: 't-9' });
  });

  it('is inconclusive, not "not found", when X cannot be reached', async () => {
    api.on(/\/2\/users\/u-1\/tweets/, { status: 503, body: { title: 'Service Unavailable' } });

    const result = await provider(api).reconcile({
      credential,
      account: { externalId: 'u-1' },
      contentHash: 'hash-1',
      body: 'Short one',
      attemptedAt: new Date(NOW),
      windowMs: 10 * 60 * 1000,
      correlationId: 'corr-1',
    });

    expect(result.outcome).toBe('INCONCLUSIVE');
  });

  /** A deleted post is a 200 with `errors` and no `data`. */
  it('reports a deleted post as gone', async () => {
    api.on(/\/2\/tweets\/t-9/, {
      body: {
        errors: [{ title: 'Not Found Error', detail: 'Could not find tweet with id: [t-9].' }],
      },
    });

    const status = await provider(api).getPostStatus(
      { externalPostId: 't-9', accountExternalId: 'u-1' },
      credential,
    );
    expect(status.exists).toBe(false);
  });
});
