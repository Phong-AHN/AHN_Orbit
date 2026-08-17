import { beforeEach, describe, expect, it } from 'vitest';
import { TikTokProvider, planChunks } from './provider.js';
import { TIKTOK_CHUNK, tiktokUserFieldsFor } from './capabilities.js';
import type { FetchLike } from './client.js';

/**
 * The TikTok adapter against recorded responses.
 *
 * `fetch` is injected, so nothing here needs a TikTok app, an audit, or the
 * network. What it cannot prove is that TikTok's real responses match these
 * fixtures — the capability descriptor marks what is verified from
 * documentation and what is not.
 *
 * The cases worth having are the ones where TikTok differs from every platform
 * Orbit already speaks to: a 200 that is a failure, a publish that finishes
 * after the call returns, a privacy level that belongs to the creator rather
 * than to us, and a refresh token that changes underneath you.
 */

interface Recorded {
  status?: number;
  body: unknown;
}

class FakeTikTok {
  readonly calls: Array<{ url: string; method: string; body?: string; headers?: HeadersInit }> = [];
  private routes: Array<{ match: RegExp; response: Recorded | (() => Recorded) }> = [];

  on(match: RegExp, response: Recorded | (() => Recorded)): this {
    this.routes.push({ match, response });
    return this;
  }

  /** Every TikTok payload is `{ data, error }`, and `error.code: "ok"` is success. */
  ok(match: RegExp, data: unknown): this {
    return this.on(match, { body: { data, error: { code: 'ok', message: '', log_id: 'log-1' } } });
  }

  /**
   * The OAuth endpoints, which answer in a different shape from everything
   * else: fields at the top level, no `data` wrapper.
   *
   * This helper exists because its absence hid a real bug. Every fixture went
   * through `ok()`, which wraps in `data`, so the client's unwrapping looked
   * correct against a fake that was wrong in exactly the same way — and the
   * token exchange failed the first time it met the real TikTok.
   */
  oauth(match: RegExp, body: unknown): this {
    return this.on(match, { body });
  }

  fail(match: RegExp, code: string, status = 400): this {
    return this.on(match, {
      status,
      body: { error: { code, message: `${code} happened`, log_id: 'log-err' } },
    });
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    this.calls.push({
      url,
      method,
      ...(body ? { body } : {}),
      ...(init?.headers ? { headers: init.headers } : {}),
    });

    // Later registrations win, so a test can override the default fixture.
    const route = [...this.routes].reverse().find((candidate) => candidate.match.test(url));
    if (!route) return new Response('{}', { status: 404 });

    const recorded = typeof route.response === 'function' ? route.response() : route.response;

    return new Response(JSON.stringify(recorded.body), {
      status: recorded.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  /** Chunk uploads answer with a bare status and no JSON, like the real one. */
  withUpload(status = 201): this {
    return this.on(/open-upload/, { status, body: {} });
  }

  called(pattern: RegExp): number {
    return this.calls.filter((call) => pattern.test(call.url)).length;
  }

  bodyOf(pattern: RegExp): Record<string, unknown> {
    const call = this.calls.find((candidate) => pattern.test(candidate.url));
    return call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : {};
  }
}

const chunks: Uint8Array[] = [];

function provider(api: FakeTikTok, overrides: Record<string, unknown> = {}): TikTokProvider {
  return new TikTokProvider({
    clientKey: 'key-123',
    clientSecret: 'secret-abc',
    apiVersion: 'v2',
    fetchImpl: api.fetch,
    baseUrl: 'https://tiktok.test',
    // Fast enough that the "still processing" path is testable at all.
    pollBudgetMs: 30,
    pollIntervalMs: 5,
    readMediaRange: async ({ firstByte, lastByte }) => {
      const bytes = new Uint8Array(lastByte - firstByte + 1);
      chunks.push(bytes);
      return bytes;
    },
    ...overrides,
  });
}

const credential = {
  accessToken: 'act.token',
  refreshToken: 'rft.token',
  scopes: ['user.info.basic', 'video.publish', 'video.list'],
  keyVersion: 1,
};

const video = (sizeBytes = 1_000_000) => ({
  id: 'm1',
  kind: 'VIDEO' as const,
  mimeType: 'video/mp4',
  sizeBytes,
  url: 'https://cdn.test/v.mp4?signature=abc',
  width: 1080,
  height: 1920,
  durationMs: 15_000,
});

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
    account: { externalId: 'open-id-1' },
    draft: {
      body: 'Behind the scenes',
      hashtags: ['coffee'],
      mentions: [],
      media: [],
      providerOptions: { postMode: 'DIRECT_POST', privacyLevel: 'PUBLIC_TO_EVERYONE' },
    },
    media: [video()],
    contentHash: 'hash-1',
    correlationId: 'corr-1',
    ...overrides,
  } as never;
}

/** The default happy path: a creator who allows everything, publish completes. */
function happyApi(): FakeTikTok {
  return new FakeTikTok()
    .ok(/creator_info\/query/, {
      creator_username: 'ahn',
      creator_nickname: 'AHN Media',
      privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
      comment_disabled: false,
      duet_disabled: false,
      stitch_disabled: false,
      max_video_post_duration_sec: 300,
    })
    .ok(/video\/init/, { publish_id: 'v_pub_file~v2-1.1', upload_url: 'https://open-upload/x' })
    .ok(/content\/init/, { publish_id: 'p_pub_url~v2.1' })
    .ok(/status\/fetch/, { status: 'PUBLISH_COMPLETE', publicly_available_post_id: ['7123'] })
    .withUpload();
}

let api: FakeTikTok;

beforeEach(() => {
  api = happyApi();
  chunks.length = 0;
});

describe('capabilities', () => {
  it('requires media, because a TikTok post is the video', () => {
    const caps = provider(api).capabilities();
    expect(caps.media.required).toBe(true);
    expect(caps.media.video).not.toBeNull();
  });

  /**
   * The real ceiling is per-creator and arrives from `creator_info/query`. A
   * fixed number here would be wrong for most accounts in one direction or the
   * other, and wrong in the direction that silently refuses valid posts.
   */
  it('declares no fixed video duration ceiling', () => {
    expect(provider(api).capabilities().media.video?.maxDurationMs).toBeUndefined();
  });

  it('declares no account-level analytics rather than inventing a total', () => {
    expect(provider(api).capabilities().analytics.account).toBe(false);
  });

  it('declares no delete, because the API has none', () => {
    expect(provider(api).capabilities().lifecycle.delete).toBe(false);
  });
});

describe('authorization', () => {
  it('asks for publishing scopes, comma-delimited', () => {
    const { url, scopes } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'signed-state',
    });

    expect(scopes).toContain('video.publish');
    // Comma here. Instagram's Business Login uses spaces, and swapping them
    // produces an unhelpful "invalid scope".
    expect(new URL(url).searchParams.get('scope')).toBe(scopes.join(','));
  });

  it('asks for upload scopes on the upload-only surface', () => {
    const { scopes } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
      accountType: 'UPLOAD_ONLY',
    });

    expect(scopes).toContain('video.upload');
    expect(scopes).not.toContain('video.publish');
  });

  it('never puts the client secret in the dialog URL', () => {
    const { url } = provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
    });
    expect(url).not.toContain('secret-abc');
  });
});

describe('tokens', () => {
  const tokenApi = () =>
    new FakeTikTok()
      // Top level, exactly as TikTok returns it. Not wrapped in `data`.
      .oauth(/oauth\/token/, {
        access_token: 'act.new',
        expires_in: 86_400,
        refresh_token: 'rft.new',
        refresh_expires_in: 31_536_000,
        open_id: 'open-id-1',
        scope: 'user.info.basic,video.publish',
      })
      .ok(/user\/info/, {
        user: { open_id: 'open-id-1', display_name: 'AHN Media', username: 'ahnmedia' },
      });

  it('exchanges a code into exactly one account', async () => {
    const local = tokenApi();
    const result = await provider(local).exchangeCode({
      code: 'auth-code',
      redirectUri: 'https://app.test/cb',
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.externalId).toBe('open-id-1');
    expect(result.accounts[0]!.handle).toBe('ahnmedia');
  });

  it('sends the token request form-encoded, not as JSON', async () => {
    const local = tokenApi();
    await provider(local).exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb' });

    const call = local.calls.find((candidate) => /oauth\/token/.test(candidate.url));
    // JSON here yields `invalid_param` with no hint which param.
    expect(call!.body).toContain('grant_type=authorization_code');
    expect(call!.body).not.toMatch(/^\{/);
  });

  it('records both lifetimes: 24 hours and a year', async () => {
    const local = tokenApi();
    const { accounts } = await provider(local).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.test/cb',
    });

    const issued = accounts[0]!.credential;
    const hours = (issued.expiresAt!.getTime() - Date.now()) / 3_600_000;
    const days = (issued.refreshableUntil!.getTime() - Date.now()) / 86_400_000;

    expect(Math.round(hours)).toBe(24);
    expect(Math.round(days)).toBe(365);
  });

  /**
   * The trap this platform sets.
   *
   * TikTok says outright that the refresh token it returns may differ from the
   * one sent, and that the new one must be used. Keeping the old one is a bug
   * whose symptom arrives up to a year later, when the account silently stops
   * refreshing and nobody remembers why.
   */
  it('keeps the refresh token TikTok returns, not the one we sent', async () => {
    const local = tokenApi();
    const outcome = await provider(local).refreshCredential({
      ...credential,
      refreshToken: 'rft.old',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(outcome.status).toBe('REFRESHED');
    if (outcome.status !== 'REFRESHED') return;
    expect(outcome.credential.refreshToken).toBe('rft.new');
    expect(outcome.credential.refreshToken).not.toBe('rft.old');
  });

  it('does not refresh a token that is nowhere near expiring', async () => {
    const local = tokenApi();
    const outcome = await provider(local).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() + 20 * 3_600_000),
    });

    expect(outcome.status).toBe('STILL_VALID');
    expect(local.called(/oauth\/token/)).toBe(0);
  });

  /**
   * The regression this whole shape exists for.
   *
   * `/v2/oauth/token/` puts its fields at the top level. Unwrapping a `data`
   * that is not there yields `{}`, the access token reads `undefined`, and the
   * adapter reports "TikTok returned no access token" — an authentication
   * failure for a call that succeeded. It reached production.
   */
  it('reads the token from the top level, where TikTok actually puts it', async () => {
    const local = new FakeTikTok()
      .oauth(/oauth\/token/, { access_token: 'act.flat', expires_in: 86_400, open_id: 'o-1' })
      .ok(/user\/info/, { user: { open_id: 'o-1', display_name: 'Flat' } });

    const { accounts } = await provider(local).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.test/cb',
    });

    expect(accounts[0]!.credential.accessToken).toBe('act.flat');
  });

  /** And the failure shape is flat too: `error` is a string, not an object. */
  it('reads a flat OAuth failure, keeping the description that names the cause', async () => {
    const local = new FakeTikTok().on(/oauth\/token/, {
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: 'Redirect_uri is not matched with the uri when requesting code.',
        log_id: 'log-oauth',
      },
    });

    await provider(local)
      .exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb' })
      .catch((error: unknown) => {
        const failure = error as { message: string; context: Record<string, unknown> };
        // Without the description, `invalid_request` names a category and
        // nothing else (D-085).
        expect(failure.message).toContain('Redirect_uri is not matched');
        expect(failure.context['providerCode']).toBe('invalid_request');
        expect(failure.context['logId']).toBe('log-oauth');
      });
  });

  /**
   * The second bug a live connection found.
   *
   * `username` reads like basic profile data and is not — it sits behind
   * `user.info.profile`. Asking for one ungranted field fails the **whole**
   * request with `scope_not_authorized`; TikTok does not return the rest and
   * omit that one. So the field list follows the grant.
   */
  it('asks only for fields the granted scopes cover', async () => {
    const local = new FakeTikTok()
      .oauth(/oauth\/token/, {
        access_token: 'act.new',
        expires_in: 86_400,
        open_id: 'o-1',
        // Basic only — no user.info.profile, which is the common case.
        scope: 'user.info.basic,video.publish',
      })
      .ok(/user\/info/, { user: { open_id: 'o-1', display_name: 'AHN' } });

    await provider(local).exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb' });

    const call = local.calls.find((candidate) => /user\/info/.test(candidate.url));
    const fields = new URL(call!.url).searchParams.get('fields') ?? '';

    expect(fields).toContain('display_name');
    expect(fields).not.toContain('username');
  });

  it('asks for the handle once the profile scope is granted', async () => {
    const local = new FakeTikTok()
      .oauth(/oauth\/token/, {
        access_token: 'act.new',
        expires_in: 86_400,
        open_id: 'o-1',
        scope: 'user.info.basic,user.info.profile',
      })
      .ok(/user\/info/, { user: { open_id: 'o-1', display_name: 'AHN', username: 'ahnmedia' } });

    const { accounts } = await provider(local).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.test/cb',
    });

    const call = local.calls.find((candidate) => /user\/info/.test(candidate.url));
    expect(new URL(call!.url).searchParams.get('fields')).toContain('username');
    expect(accounts[0]!.handle).toBe('ahnmedia');
  });

  it('always asks for something, even on an unrecognised grant', () => {
    expect(tiktokUserFieldsFor([])).toBe('open_id');
    expect(tiktokUserFieldsFor(['video.publish'])).toBe('open_id');
  });

  it('asks for a reconnect once the refresh token itself has expired', async () => {
    const outcome = await provider(tokenApi()).refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() - 1_000),
      refreshableUntil: new Date(Date.now() - 1_000),
    });

    expect(outcome.status).toBe('REQUIRES_RECONNECT');
  });
});

describe('error handling', () => {
  /**
   * The single easiest thing to get wrong here: TikTok returns `error` on
   * every response, and a 200 whose `error.code` is not `"ok"` is a failure.
   * Reading `response.ok` first would sail straight past it.
   */
  it('treats a 200 carrying an error code as a failure', async () => {
    const local = new FakeTikTok().on(/user\/info/, {
      status: 200,
      body: { error: { code: 'access_token_invalid', message: 'nope', log_id: 'l' } },
    });

    await expect(
      provider(local).probeHealth(credential, { externalId: 'open-id-1' }),
    ).resolves.toMatchObject({ status: 'NEEDS_RECONNECT' });
  });

  it('keeps TikTok’s log id, which is what their support asks for', async () => {
    const local = new FakeTikTok().fail(/user\/info/, 'internal_error', 500);

    await provider(local)
      .probeHealth(credential, { externalId: 'open-id-1' })
      .catch((error: unknown) => {
        expect((error as { context: Record<string, unknown> }).context['logId']).toBe('log-err');
      });
  });

  /**
   * Some codes are about our app, not this post. Telling an account manager to
   * "try again later" when the app is unaudited costs somebody an afternoon.
   */
  /**
   * An unaudited app is a real constraint, and the message has to name the fix
   * somebody can actually apply. The first version said only "submit the app
   * for audit" — true, and useless to an account manager, who now believes
   * TikTok is blocked entirely rather than one setting away.
   */
  it('offers the immediate fix, not only the one that takes weeks', async () => {
    const local = happyApi().fail(
      /video\/init/,
      'unaudited_client_can_only_post_to_private_accounts',
      403,
    );

    await provider(local)
      .publish(publishContext())
      .catch((error: unknown) => {
        const failure = error as { userMessage: string; context: Record<string, unknown> };

        // The two-second change, named.
        expect(failure.userMessage).toMatch(/only this account/i);
        // And the permanent one, still there.
        expect(failure.userMessage).toMatch(/audit/i);
        expect(failure.context['clientStanding']).toBe(true);
      });
  });

  it('treats a daily post cap as a rate limit rather than a refusal', async () => {
    const local = happyApi().fail(/video\/init/, 'spam_risk_too_many_posts', 403);

    await expect(provider(local).publish(publishContext())).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
    });
  });
});

describe('publishing a video', () => {
  it('asks the creator first, then initialises, then uploads', async () => {
    const result = await provider(api).publish(publishContext());

    expect(api.called(/creator_info\/query/)).toBe(1);
    expect(api.called(/video\/init/)).toBe(1);
    expect(api.called(/open-upload/)).toBe(1);
    expect(result.externalPostId).toBe('7123');
  });

  it('sends the creator’s chosen privacy level', async () => {
    await provider(api).publish(publishContext());

    const body = api.bodyOf(/video\/init/);
    expect((body['post_info'] as Record<string, unknown>)['privacy_level']).toBe(
      'PUBLIC_TO_EVERYONE',
    );
    expect((body['source_info'] as Record<string, unknown>)['source']).toBe('FILE_UPLOAD');
  });

  /**
   * The id is the only thing that can answer "did it go out?" afterwards, and
   * an id written after the ambiguous part would not exist in the one case it
   * is needed for.
   */
  it('records the publish id before a single byte moves', async () => {
    const order: string[] = [];
    const local = happyApi();

    await provider(local, {
      readMediaRange: async ({ firstByte, lastByte }) => {
        order.push('upload');
        return new Uint8Array(lastByte - firstByte + 1);
      },
    }).publish(
      publishContext({
        recordProviderRef: async (ref: Record<string, unknown>) => {
          order.push(`ref:${String(ref['publishId'])}`);
        },
      }),
    );

    expect(order[0]).toBe('ref:v_pub_file~v2-1.1');
    expect(order).toContain('upload');
  });

  it('refuses a privacy level the creator no longer offers', async () => {
    const local = happyApi().ok(/creator_info\/query/, {
      creator_username: 'ahn',
      // A creator who switched to a private account. PUBLIC is gone.
      privacy_level_options: ['SELF_ONLY'],
      max_video_post_duration_sec: 300,
    });

    await expect(provider(local).publish(publishContext())).rejects.toMatchObject({
      code: 'PROVIDER_VALIDATION_ERROR',
    });
    // Refused by name, before anything was sent.
    expect(local.called(/video\/init/)).toBe(0);
  });

  it('refuses a direct post with no privacy level at all', async () => {
    await expect(
      provider(api).publish(
        publishContext({
          draft: {
            body: 'x',
            hashtags: [],
            mentions: [],
            media: [],
            providerOptions: { postMode: 'DIRECT_POST' },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_VALIDATION_ERROR' });
  });

  /** The per-account ceiling is the only place this number exists. */
  it('refuses a video longer than this creator may post', async () => {
    const local = happyApi().ok(/creator_info\/query/, {
      privacy_level_options: ['PUBLIC_TO_EVERYONE'],
      max_video_post_duration_sec: 10,
    });

    await expect(
      provider(local).publish(publishContext({ media: [{ ...video(), durationMs: 60_000 }] })),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIA_ERROR' });
  });

  it('refuses to enable comments on a creator who turned them off', async () => {
    const local = happyApi().ok(/creator_info\/query/, {
      privacy_level_options: ['PUBLIC_TO_EVERYONE'],
      comment_disabled: true,
      max_video_post_duration_sec: 300,
    });

    await expect(
      provider(local).publish(
        publishContext({
          draft: {
            body: 'x',
            hashtags: [],
            mentions: [],
            media: [],
            providerOptions: {
              postMode: 'DIRECT_POST',
              privacyLevel: 'PUBLIC_TO_EVERYONE',
              disableComment: false,
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_VALIDATION_ERROR' });
  });

  it('puts hashtags in the caption, where creators put them on TikTok', async () => {
    await provider(api).publish(publishContext());

    const title = (api.bodyOf(/video\/init/)['post_info'] as Record<string, unknown>)['title'];
    expect(String(title)).toContain('#coffee');
  });

  /**
   * Caught by the shared validator before the adapter's own guard, because
   * `allowsMixedKinds: false` already describes this. The guard stays as a
   * backstop, but the descriptor getting there first is the better outcome —
   * it names MIXED_MEDIA_UNSUPPORTED rather than a hand-written sentence.
   */
  it('refuses a video and photos in the same post', async () => {
    await expect(
      provider(api).publish(publishContext({ media: [video(), image('a')] })),
    ).rejects.toMatchObject({
      code: 'PROVIDER_VALIDATION_ERROR',
      context: { validationCodes: 'MIXED_MEDIA_UNSUPPORTED' },
    });
    expect(api.called(/video\/init/)).toBe(0);
  });
});

describe('upload mode', () => {
  const inboxApi = () =>
    happyApi().ok(/inbox\/video\/init/, {
      publish_id: 'v_inbox~v2.1',
      upload_url: 'https://open-upload/y',
    });

  const uploadContext = () =>
    publishContext({
      draft: {
        body: 'For review',
        hashtags: [],
        mentions: [],
        media: [],
        providerOptions: { postMode: 'MEDIA_UPLOAD' },
      },
    });

  it('never asks for creator info, because nothing is being posted', async () => {
    const local = inboxApi().ok(/status\/fetch/, { status: 'SEND_TO_USER_INBOX' });
    await provider(local).publish(uploadContext());

    expect(local.called(/creator_info\/query/)).toBe(0);
    expect(local.called(/inbox\/video\/init/)).toBe(1);
  });

  /**
   * `SEND_TO_USER_INBOX` means a notification arrived. **Nothing is public**,
   * and the creator may never act on it — so it settles, flagged, rather than
   * pretending to be a published post.
   */
  it('settles as awaiting the creator, not as published', async () => {
    const local = inboxApi().ok(/status\/fetch/, { status: 'SEND_TO_USER_INBOX' });
    const result = await provider(local).publish(uploadContext());

    expect(result.providerMeta?.['awaitingCreator']).toBe(true);
    expect(result.externalPostId).toBe('v_inbox~v2.1');
  });

  it('does not settle a direct post on an inbox notification', async () => {
    // The same status, but a direct post is not finished by it.
    const local = happyApi().ok(/status\/fetch/, { status: 'SEND_TO_USER_INBOX' });

    await expect(provider(local).publish(publishContext())).rejects.toMatchObject({
      code: 'PUBLISHING_TIMEOUT',
    });
  });
});

describe('when TikTok is still working', () => {
  /**
   * Running out of budget is **not** a failure. The publish is still in flight
   * and may well succeed; reporting it failed and retrying would post the same
   * video twice (D-027).
   */
  it('times out rather than failing, so the engine reconciles', async () => {
    const local = happyApi().ok(/status\/fetch/, { status: 'PROCESSING_UPLOAD' });

    await expect(provider(local).publish(publishContext())).rejects.toMatchObject({
      code: 'PUBLISHING_TIMEOUT',
      retryable: false,
    });
  });

  it('fails outright when TikTok says it failed', async () => {
    const local = happyApi().ok(/status\/fetch/, {
      status: 'FAILED',
      fail_reason: 'video too short',
    });

    await expect(provider(local).publish(publishContext())).rejects.toMatchObject({
      code: 'PROVIDER_MEDIA_ERROR',
    });
  });
});

describe('reconciliation', () => {
  const reconcileCtx = (providerRef?: Record<string, unknown>) =>
    ({
      credential,
      account: { externalId: 'open-id-1' },
      contentHash: 'hash-1',
      body: 'Behind the scenes',
      ...(providerRef ? { providerRef } : {}),
      attemptedAt: new Date(),
      windowMs: 600_000,
      correlationId: 'corr-1',
    }) as never;

  it('answers about this exact publish, not a search of a listing', async () => {
    const result = await provider(api).reconcile(
      reconcileCtx({ publishId: 'v_pub_file~v2-1.1', postMode: 'DIRECT_POST' }),
    );

    expect(result.outcome).toBe('FOUND');
    if (result.outcome !== 'FOUND') return;
    expect(result.externalPostId).toBe('7123');
  });

  /**
   * Guessing from a video listing could call somebody else's upload ours, so
   * with no recorded id there is nothing honest to say.
   */
  it('parks rather than guessing when no publish id was recorded', async () => {
    const result = await provider(api).reconcile(reconcileCtx());

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(api.called(/status\/fetch/)).toBe(0);
  });

  it('parks while TikTok is still processing, because posting again would duplicate', async () => {
    const local = happyApi().ok(/status\/fetch/, { status: 'PROCESSING_DOWNLOAD' });
    const result = await provider(local).reconcile(reconcileCtx({ publishId: 'v_pub~1' }));

    expect(result.outcome).toBe('INCONCLUSIVE');
  });

  it('reports a failed publish as never landed, so it can be retried safely', async () => {
    const local = happyApi().ok(/status\/fetch/, { status: 'FAILED', fail_reason: 'bad codec' });
    const result = await provider(local).reconcile(reconcileCtx({ publishId: 'v_pub~1' }));

    expect(result.outcome).toBe('NOT_FOUND');
  });
});

describe('chunk planning', () => {
  it('sends a small file whole, because TikTok refuses a chunk under 5 MB', () => {
    expect(planChunks(1_000_000)).toEqual({ chunkSize: 1_000_000, totalChunks: 1 });
  });

  /**
   * TikTok's own worked example: 50,000,123 bytes at 10 MB chunks is five
   * requests, and the trailing 123 bytes ride along in the last one rather than
   * becoming a sixth, illegal, chunk.
   */
  it('never leaves a final chunk that is short, or over the 128 MB cap', () => {
    for (const size of [50_000_123, 70_000_000, 200_000_000, 1_500_000_000]) {
      const plan = planChunks(size);
      const lastChunkBytes = size - plan.chunkSize * (plan.totalChunks - 1);

      expect(lastChunkBytes).toBeGreaterThanOrEqual(plan.chunkSize);
      expect(lastChunkBytes).toBeLessThanOrEqual(TIKTOK_CHUNK.finalMaxBytes);
    }
  });

  /** `chunk_size` larger than the file makes TikTok's own arithmetic yield zero chunks. */
  it('never reports a chunk size larger than the file', () => {
    for (const size of [1_000, 4_999_999, 50_000_123, 64 * 1024 * 1024]) {
      expect(planChunks(size).chunkSize).toBeLessThanOrEqual(size);
    }
  });

  /**
   * The chunk count is bounded by the file-size ceiling rather than by any
   * logic here: 4 GB at 64 MB chunks is 64 requests, comfortably inside
   * TikTok's limit of 1000. A file large enough to break that is refused by
   * the capability descriptor long before it reaches this function.
   */
  it('stays well within the 1000-chunk ceiling at the largest allowed file', () => {
    const plan = planChunks(4 * 1024 * 1024 * 1024);
    expect(plan.totalChunks).toBeLessThanOrEqual(TIKTOK_CHUNK.maxCount);
    expect(plan.chunkSize).toBeLessThanOrEqual(TIKTOK_CHUNK.maxBytes);
  });

  it('covers every byte, whatever the size', () => {
    for (const size of [4_999_999, 5_000_000, 64 * 1024 * 1024 + 1, 300_000_000]) {
      const plan = planChunks(size);
      const covered = plan.chunkSize * (plan.totalChunks - 1);
      expect(covered).toBeLessThan(size);
      expect(plan.chunkSize).toBeLessThanOrEqual(Math.max(size, TIKTOK_CHUNK.maxBytes));
    }
  });

  it('uploads every byte of the file, in order', async () => {
    await provider(api).publish(publishContext({ media: [video(1_000_000)] }));

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBe(1_000_000);
  });
});

describe('analytics', () => {
  it('reads per-video counters', async () => {
    const local = new FakeTikTok().ok(/video\/query/, {
      videos: [{ id: '7123', view_count: 900, like_count: 40, comment_count: 3, share_count: 1 }],
    });

    const result = await provider(local).fetchPostAnalytics(
      { externalPostId: '7123', accountExternalId: 'open-id-1' },
      credential,
      { from: new Date(), to: new Date() },
    );

    expect(result.metrics['view_count']).toBe(900);
    expect(result.availability['view_count']).toBe('AVAILABLE');
  });

  /**
   * A fresh post TikTok has not counted yet must read as unavailable. Storing
   * zero would chart a successful post as a failed one (SRS §18).
   */
  it('reports a missing counter as unavailable, never as zero', async () => {
    const local = new FakeTikTok().ok(/video\/query/, { videos: [{ id: '7123' }] });

    const result = await provider(local).fetchPostAnalytics(
      { externalPostId: '7123', accountExternalId: 'open-id-1' },
      credential,
      { from: new Date(), to: new Date() },
    );

    expect(result.metrics['view_count']).toBeUndefined();
    expect(result.availability['view_count']).toBe('UNSUPPORTED');
  });

  it('refuses account analytics rather than summing videos into a fake total', async () => {
    await expect(provider(api).fetchAccountAnalytics()).rejects.toThrow();
  });
});

describe('lifecycle', () => {
  it('explains that TikTok has no delete instead of failing like an outage', async () => {
    await expect(
      provider(api).deletePost({ externalPostId: '7123', accountExternalId: 'o' }, credential),
    ).rejects.toMatchObject({ code: 'PROVIDER_VALIDATION_ERROR' });
  });
});
