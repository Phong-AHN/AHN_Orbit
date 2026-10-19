import { beforeEach, describe, expect, it } from 'vitest';
import { InstagramProvider } from './provider.js';
import {
  INSTAGRAM_COMMENT_SCOPES,
  INSTAGRAM_DEFAULT_SCOPES,
  INSTAGRAM_INSIGHTS_SCOPES,
  INSTAGRAM_LOGIN_COMMENT_SCOPES,
  INSTAGRAM_LOGIN_INSIGHTS_SCOPES,
  INSTAGRAM_LOGIN_SCOPES,
  INSTAGRAM_PUBLISH_SCOPES,
} from './capabilities.js';
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

function provider(graph: FakeGraph, overrides: Record<string, unknown> = {}): InstagramProvider {
  return new InstagramProvider({
    appId: 'app-123',
    appSecret: 'secret-abc',
    apiVersion: 'v25.0',
    fetchImpl: graph.fetch,
    baseUrl: 'https://graph.test',
    // Fast enough that the "still transcoding" path is testable at all.
    reelPollBudgetMs: 200,
    reelPollIntervalMs: 1,
    ...overrides,
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
      // Neither of these is in the use-case default set. Asked for here
      // because a scope cannot be added to a grant already issued, so an
      // account connected without them needs a second reconnection.
      'instagram_manage_comments',
      'instagram_manage_insights',
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

  /**
   * Replaces a test that asserted video was refused outright.
   *
   * It was true while `video: null` stood in the descriptor. After Reels
   * shipped it kept passing — not because video was refused, but because the
   * fixture had no container status and the publish timed out waiting. A test
   * that passes for a reason it does not state is worse than no test: it would
   * have gone on reporting "video is refused" through any future change.
   *
   * What is actually still refused is a clip under Instagram's three-second
   * floor, and the descriptor catches it before anything is sent.
   */
  it('refuses a clip below the three-second floor, before sending anything', async () => {
    await expect(
      provider(graph).publish(
        publishContext({
          media: [
            {
              ...image('v'),
              kind: 'VIDEO',
              mimeType: 'video/mp4',
              durationMs: 1_500,
              frameRate: 30,
              peakFrameRate: 30,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_VALIDATION_ERROR',
      context: { validationCodes: 'MEDIA_TOO_SHORT_DURATION' },
    });

    // Nothing reached the API. That is what "before sending anything" means.
    expect(graph.calls).toHaveLength(0);
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

/**
 * Reels: the only way video reaches Instagram.
 *
 * Two things separate this from an image post, and both are places to get it
 * wrong. The container is not ready when it is created -- `media_publish` on an
 * `IN_PROGRESS` container fails -- and Instagram fetches the file itself from
 * `video_url`, with no byte upload offered at all.
 */
describe('publishing a Reel', () => {
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

  const ready = (graph: FakeGraph) =>
    graph.on(/container-1\?|\/container-1$/, { body: { status_code: 'FINISHED' } });

  it('creates a REELS container from the signed URL', async () => {
    const local = ready(new FakeGraph().withStore());
    await provider(local).publish(publishContext({ media: [reel()] }));

    const create = local.calls.find(
      (call) => call.method === 'POST' && /\/ig-user-1\/media(\?|$)/.test(call.url),
    );
    const form = new URLSearchParams(create!.body ?? '');

    expect(form.get('media_type')).toBe('REELS');
    expect(form.get('video_url')).toContain('reel.mp4');
    // A Reel that never reaches the grid is not what an agency means by
    // "post a Reel" for a client.
    expect(form.get('share_to_feed')).toBe('true');
  });

  /**
   * The ordering that makes reconciliation possible: an id written after the
   * ambiguous half would not exist in the case it is needed for.
   */
  it('records the container id before waiting on it', async () => {
    const order: string[] = [];
    const local = ready(new FakeGraph().withStore());

    await provider(local).publish(
      publishContext({
        media: [reel()],
        recordProviderRef: async (ref: Record<string, unknown>) => {
          order.push(`ref:${String(ref['containerId'])}`);
        },
      }),
    );

    expect(order[0]).toBe('ref:container-1');
  });

  it('waits for the container before publishing it', async () => {
    let asked = 0;
    const local = new FakeGraph().withStore().on(/container-1/, () => {
      asked += 1;
      return { body: { status_code: asked < 2 ? 'IN_PROGRESS' : 'FINISHED' } };
    });

    const result = await provider(local, { reelPollIntervalMs: 1 }).publish(
      publishContext({ media: [reel()] }),
    );

    expect(asked).toBeGreaterThan(1);
    expect(result.externalPostId).toBe('ig-media-1');
  });

  /** Instagram rejecting the file is a media problem, and terminal. */
  it('reports a container that errored as a media failure', async () => {
    const local = new FakeGraph()
      .withStore()
      .on(/container-1/, { body: { status_code: 'ERROR', status: 'bad codec' } });

    await expect(
      provider(local).publish(publishContext({ media: [reel()] })),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIA_ERROR' });
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
  it('asks to be retried while Instagram is still transcoding, rather than parking', async () => {
    const local = new FakeGraph()
      .withStore()
      .on(/container-1/, { body: { status_code: 'IN_PROGRESS' } });

    await expect(
      provider(local, { reelPollBudgetMs: 20, reelPollIntervalMs: 5 }).publish(
        publishContext({ media: [reel()] }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  /** And the retry picks the container back up instead of building another. */
  it('resumes the container an earlier attempt left transcoding', async () => {
    const local = new FakeGraph()
      .withStore()
      .on(/container-9/, { body: { status_code: 'FINISHED' } });

    const result = await provider(local).publish(
      publishContext({
        media: [reel()],
        previousRef: { containerId: 'container-9', contentHash: 'hash-1' },
      }),
    );

    // No new container was created; the recorded one was published.
    const creates = local.calls.filter(
      (call) => call.method === 'POST' && /\/ig-user-1\/media(\?|$)/.test(call.url),
    );
    expect(creates).toHaveLength(0);
    expect(result.externalPostId).toBe('ig-media-1');
  });

  /**
   * Only when the content still matches. A container built from an older draft
   * would publish text nobody approved.
   */
  it('ignores a recorded container whose content has since changed', async () => {
    const local = new FakeGraph()
      .withStore()
      .on(/container-1/, { body: { status_code: 'FINISHED' } });

    await provider(local).publish(
      publishContext({
        media: [reel()],
        previousRef: { containerId: 'container-9', contentHash: 'a-different-hash' },
      }),
    );

    const creates = local.calls.filter(
      (call) => call.method === 'POST' && /\/ig-user-1\/media(\?|$)/.test(call.url),
    );
    expect(creates).toHaveLength(1);
  });

  it('refuses a Reel with photos alongside it', async () => {
    const local = ready(new FakeGraph().withStore());

    await expect(
      provider(local).publish(publishContext({ media: [reel(), image('a')] })),
    ).rejects.toThrow();
  });

  /** Meta accepts 0.01:1 to 10:1 and only *recommends* 9:16. */
  it('does not impose the recommended aspect ratio Meta merely suggests', () => {
    const video = provider(new FakeGraph()).capabilities().media.video;

    expect(video).not.toBeNull();
    expect(video?.minAspectRatio).toBeUndefined();
    expect(video?.maxAspectRatio).toBeUndefined();
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

    // The content hash rides along so a retry can tell whether this container
    // still matches the draft it was built from.
    expect(seen).toEqual([{ containerId: 'container-1', contentHash: 'hash-1' }]);
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

describe('the capability descriptor varies by connection flow', () => {
  /**
   * The reason this exists at all. The two flows use different *names* for one
   * permission, so a single descriptor listing both would make `replyScopes`
   * name a scope no credential can hold — and the reply path refuses on a
   * missing scope, so every reply would be rejected as "needs reconnecting" on
   * an account that was correctly connected.
   */
  it('names the Facebook-Login comment scope for a Page-linked account', () => {
    const engagement = provider(graph).capabilities('INSTAGRAM_BUSINESS').engagement;

    expect(engagement.replyScopes).toEqual(['instagram_manage_comments']);
  });

  it('names the Business-Login comment scope for a username account', () => {
    const engagement = provider(graph).capabilities('INSTAGRAM_LOGIN').engagement;

    expect(engagement.replyScopes).toEqual(['instagram_business_manage_comments']);
  });

  /**
   * The two scope lists must stay disjoint. If a refactor ever made them equal,
   * every test above would still pass while the distinction they exist to
   * protect had quietly disappeared.
   */
  it('keeps the two scope names distinct', () => {
    expect(INSTAGRAM_COMMENT_SCOPES).not.toEqual(INSTAGRAM_LOGIN_COMMENT_SCOPES);
  });

  /** A caller that does not know gets the flow almost every account uses. */
  it('falls back to the Facebook-Login descriptor when the type is unknown', () => {
    const unknown = provider(graph).capabilities(null).engagement;

    expect(unknown.replyScopes).toEqual(['instagram_manage_comments']);
    expect(provider(graph).capabilities().engagement.replyScopes).toEqual([
      'instagram_manage_comments',
    ]);
  });

  /**
   * A scope cannot be added to a grant already issued. If the connect flow does
   * not ask for the comment scope, every account connected from now on needs a
   * second reconnection later — the mistake `read_insights` already cost once.
   */
  it('asks for the comment scope at connect time on both flows', () => {
    expect(INSTAGRAM_DEFAULT_SCOPES).toContain('instagram_manage_comments');
    expect(INSTAGRAM_LOGIN_SCOPES).toContain('instagram_business_manage_comments');
  });

  /** Claimed only for what is implemented: no hide, no delete, no moderation UI. */
  it('claims reading and threaded replying, and not moderation', () => {
    const engagement = provider(graph).capabilities('INSTAGRAM_BUSINESS').engagement;

    expect(engagement.readComments).toBe(true);
    expect(engagement.reply).toBe(true);
    expect(engagement.threadedReply).toBe(true);
    expect(engagement.moderate).toBe(false);
    expect(engagement.maxReplyLength).toBe(2_200);
  });
});

describe('reading comments', () => {
  const ref = { externalPostId: 'ig-media-1', accountExternalId: 'ig-user-1' };

  /**
   * Instagram's vocabulary, not Facebook's: `text` not `message`, `timestamp`
   * not `created_time`, `username` not `from.name`, and the reply nested under
   * its parent rather than flattened by `filter=stream`.
   */
  const thread = {
    data: [
      {
        id: 'c-1',
        text: 'Is this in stock?',
        timestamp: '2026-10-12T09:00:00+0000',
        username: 'mai.tran',
        from: { id: '777', username: 'mai.tran' },
        replies: {
          data: [
            {
              id: 'c-2',
              text: 'Yes — in store from Friday!',
              timestamp: '2026-10-12T10:00:00+0000',
              username: 'northwind.coffee',
              // The connected account itself.
              from: { id: 'ig-user-1', username: 'northwind.coffee' },
            },
          ],
        },
      },
    ],
  };

  function graphWithThread() {
    return new FakeGraph().on(/\/comments/, { body: thread });
  }

  /**
   * The edge returns only top-level comments. Without the `replies` field
   * expansion the brand's own answer is never read back, so a comment the
   * client answered from the Instagram app sits in the queue unhandled forever.
   */
  it('flattens the nested replies into the page', async () => {
    const page = await provider(graphWithThread()).fetchComments!({ ref, credential });

    expect(page.comments.map((c) => c.externalId)).toEqual(['c-1', 'c-2']);
    expect(page.comments[0]?.message).toBe('Is this in stock?');
    expect(page.comments[0]?.parentExternalId).toBeUndefined();
    expect(page.comments[1]?.parentExternalId).toBe('c-1');
  });

  it('asks for the replies expansion, because the edge omits them', async () => {
    const graphWith = graphWithThread();
    await provider(graphWith).fetchComments!({ ref, credential });

    const url = decodeURIComponent(graphWith.calls.at(-1)?.url ?? '');
    expect(url).toContain('replies.limit(50){');
    expect(url).toContain('text');
    expect(url).toContain('timestamp');
    // Facebook's field names would silently return nothing useful here.
    expect(url).not.toMatch(/fields=[^&]*created_time/);
    expect(url).not.toContain('filter=stream');
  });

  /**
   * The distinction the whole queue rests on. Without it the brand's own
   * replies come back as things needing attention, and every answered comment
   * reappears as unanswered.
   */
  it('marks the account’s own reply as ours and the public’s as not', async () => {
    const page = await provider(graphWithThread()).fetchComments!({ ref, credential });

    expect(page.comments[0]?.ours).toBe(false);
    expect(page.comments[1]?.ours).toBe(true);
  });

  /**
   * The reason `AudienceComment` has no field for a commenter id: the adapter
   * is the only layer that holds one, and it consumes it. Asserted on the
   * returned object rather than trusted to the type, because a type is erased
   * and a stray property would still travel.
   */
  it('hands back no commenter identifier at all', async () => {
    const page = await provider(graphWithThread()).fetchComments!({ ref, credential });
    const audience = page.comments[0]!;

    expect(audience.authorName).toBe('mai.tran');
    expect(JSON.stringify(audience)).not.toContain('777');
    expect(Object.keys(audience)).not.toContain('from');
    expect(Object.keys(audience)).not.toContain('authorExternalId');
  });

  /**
   * This edge cannot be filtered by timestamp, so `since` is applied here. It
   * saves a database round trip per historical comment on every pass; it does
   * not save an API call, and the request must not pretend otherwise.
   */
  it('applies `since` to the rows, since the edge has no such parameter', async () => {
    const graphWith = graphWithThread();
    const page = await provider(graphWith).fetchComments!({
      ref,
      credential,
      since: new Date('2026-10-12T09:30:00Z'),
    });

    expect(page.comments.map((c) => c.externalId)).toEqual(['c-2']);

    const url = decodeURIComponent(graphWith.calls.at(-1)?.url ?? '');
    expect(url).not.toContain('since=');
    expect(url).not.toContain('until=');
  });

  /**
   * The optimisation that must not be made. Top-level comments come back
   * newest-first, so an old comment sits on a late page — and a reply posted
   * to it today arrives nested under it there. Stopping at the first fully
   * stale page would skip it, and since the watermark only moves forward it
   * would be skipped on every pass after that too.
   */
  it('keeps paging when `since` filters a page down to nothing', async () => {
    const graphWith = new FakeGraph().on(/\/comments/, {
      body: {
        data: [
          {
            id: 'old-1',
            text: 'Last month',
            timestamp: '2026-09-01T09:00:00+0000',
            username: 'someone',
            from: { id: '888', username: 'someone' },
          },
        ],
        paging: { cursors: { after: 'page-2' }, next: 'https://graph.test/next' },
      },
    });

    const page = await provider(graphWith).fetchComments!({
      ref,
      credential,
      since: new Date('2026-10-12T00:00:00Z'),
    });

    expect(page.comments).toEqual([]);
    expect(page.nextCursor).toBe('page-2');
  });

  /** The edge caps a page at 50 whether or not we ask, so the clamp is explicit. */
  it('never asks for more than the edge returns', async () => {
    const graphWith = graphWithThread();
    await provider(graphWith).fetchComments!({ ref, credential, limit: 100 });

    expect(graphWith.calls.at(-1)?.url).toContain('limit=50');
  });

  /**
   * Meta returns an `after` cursor on the last page too, so paging on the
   * cursor alone never terminates — the ingestion loop would run forever over
   * the same final page.
   */
  it('reports no next page when Meta sends no `next` link', async () => {
    const graphWith = new FakeGraph().on(/\/comments/, {
      body: { ...thread, paging: { cursors: { after: 'cursor-on-last-page' } } },
    });

    const page = await provider(graphWith).fetchComments!({ ref, credential });

    expect(page.nextCursor).toBeUndefined();
  });

  /** A row we cannot dedupe, reply to, or order is dropped rather than guessed at. */
  it('drops a comment with no id or no usable timestamp', async () => {
    const graphWith = new FakeGraph().on(/\/comments/, {
      body: {
        data: [
          { text: 'no id', timestamp: '2026-10-12T09:00:00+0000' },
          { id: 'no-time', text: 'no timestamp' },
          { id: 'bad-time', text: 'unparseable', timestamp: 'not a date' },
          { id: 'good', text: 'fine', timestamp: '2026-10-12T09:00:00+0000' },
        ],
      },
    });

    const page = await provider(graphWith).fetchComments!({ ref, credential });

    expect(page.comments.map((c) => c.externalId)).toEqual(['good']);
  });

  /** A username-login account must not be read from graph.facebook.com. */
  it('reads a username-login account from graph.instagram.com', async () => {
    const seen: string[] = [];
    const globalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify(thread), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const page = await provider(graph).fetchComments!({
        ref,
        credential: { accessToken: 'ig-token', scopes: INSTAGRAM_LOGIN_SCOPES },
      });

      expect(page.comments).toHaveLength(2);
      expect(seen.every((url) => url.startsWith('https://graph.instagram.com/'))).toBe(true);
    } finally {
      globalThis.fetch = globalFetch;
    }

    expect(graph.calls).toHaveLength(0);
  });
});

describe('replying to a comment', () => {
  /**
   * The media's `comments` edge would post a new top-level comment that nobody
   * is notified about. `/replies` on the comment itself is what threads it and
   * reaches the person who asked.
   */
  it('posts to the comment’s replies edge, not the media’s comments edge', async () => {
    const graphWith = new FakeGraph().on(/\/replies/, { body: { id: 'reply-1' } });

    const result = await provider(graphWith).replyToComment!({
      commentExternalId: 'c-1',
      message: 'Yes, from Friday!',
      credential,
    });

    expect(result.externalId).toBe('reply-1');

    const call = graphWith.calls.at(-1)!;
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/c-1/replies');
    expect(new URLSearchParams(call.body ?? '').get('message')).toBe('Yes, from Friday!');
  });

  /**
   * A reply we cannot identify is one we might send again: the next ingestion
   * pass would not recognise it as ours, so the comment stays in the queue and
   * somebody answers it twice. Reported as a failure rather than recorded as
   * sent — the same posture an ambiguous publish takes (D-027).
   */
  it('refuses an acknowledgement that carries no id', async () => {
    const graphWith = new FakeGraph().on(/\/replies/, { body: {} });

    await expect(
      provider(graphWith).replyToComment!({
        commentExternalId: 'c-1',
        message: 'Hello',
        credential,
      }),
    ).rejects.toThrow(/did not confirm|without returning an id/i);
  });

  it('sends a username-login reply to graph.instagram.com', async () => {
    const seen: string[] = [];
    const globalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ id: 'reply-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await provider(graph).replyToComment!({
        commentExternalId: 'c-1',
        message: 'Hello',
        credential: { accessToken: 'ig-token', scopes: INSTAGRAM_LOGIN_SCOPES },
      });

      expect(result.externalId).toBe('reply-1');
      expect(seen.every((url) => url.startsWith('https://graph.instagram.com/'))).toBe(true);
    } finally {
      globalThis.fetch = globalFetch;
    }

    expect(graph.calls).toHaveLength(0);
  });
});

/**
 * Every capability the descriptor claims must have a scope behind it.
 *
 * This is here because the literal list above is the wrong kind of test on its
 * own: it pins what the code *says* without checking it against what the code
 * *promises*. `instagram_manage_insights` was missing for months while that
 * assertion passed, on the strength of a comment asserting Instagram needed no
 * insights scope. Meta's insights reference says otherwise, and the failure
 * mode was invisible — a token without it still reads media fields and fails
 * only the metrics call, so publishing worked and analytics returned a
 * permission error.
 *
 * Tying the two together is what makes the next missing scope a test failure
 * instead of a support ticket.
 */
describe('claimed capabilities all have a scope', () => {
  const insightsScope = (scopes: readonly string[]) =>
    scopes.some((scope) => scope.includes('insights'));
  const publishScope = (scopes: readonly string[]) =>
    scopes.some((scope) => scope.includes('content_publish'));

  it('backs the analytics claim with an insights scope on both flows', () => {
    const business = provider(graph).capabilities('INSTAGRAM_BUSINESS');
    const login = provider(graph).capabilities('INSTAGRAM_LOGIN');

    // Guard the premise: if analytics were ever dropped the assertions below
    // would pass vacuously.
    expect(business.analytics.post || business.analytics.account).toBe(true);
    expect(login.analytics.post || login.analytics.account).toBe(true);

    expect(insightsScope(INSTAGRAM_DEFAULT_SCOPES)).toBe(true);
    expect(insightsScope(INSTAGRAM_LOGIN_SCOPES)).toBe(true);
  });

  it('backs the publishing claim with a publish scope on both flows', () => {
    expect(publishScope(INSTAGRAM_DEFAULT_SCOPES)).toBe(true);
    expect(publishScope(INSTAGRAM_LOGIN_SCOPES)).toBe(true);
  });

  it('backs the reply claim with the scope the descriptor itself names', () => {
    for (const type of ['INSTAGRAM_BUSINESS', 'INSTAGRAM_LOGIN'] as const) {
      const capabilities = provider(graph).capabilities(type);
      const requested =
        type === 'INSTAGRAM_LOGIN' ? INSTAGRAM_LOGIN_SCOPES : INSTAGRAM_DEFAULT_SCOPES;

      expect(capabilities.engagement.reply).toBe(true);
      expect(capabilities.engagement.replyScopes.length).toBeGreaterThan(0);
      // The scope the reply path checks a credential against must be one the
      // connect flow actually asked for, or every reply is refused.
      for (const scope of capabilities.engagement.replyScopes) {
        expect(requested as readonly string[]).toContain(scope);
      }
    }
  });

  /** The two namespaces must not leak into each other's flow. */
  it('keeps the two flows\u2019 scope namespaces separate', () => {
    expect(INSTAGRAM_DEFAULT_SCOPES.some((s) => s.startsWith('instagram_business_'))).toBe(false);
    expect(INSTAGRAM_LOGIN_SCOPES).not.toContain(...INSTAGRAM_INSIGHTS_SCOPES);
    expect(INSTAGRAM_LOGIN_SCOPES).toContain(...INSTAGRAM_LOGIN_INSIGHTS_SCOPES);
  });
});

/**
 * Business Login tokens expire on a clock. Page tokens do not.
 *
 * This is the pair of behaviours that used to be one: `refreshCredential` read
 * `/me`, proved the token worked *today*, and returned STILL_VALID — while the
 * 60-day expiry it was issued with came closer. Every Instagram connection in
 * the product would have died on the same afternoon, recoverable only by
 * emailing every client.
 */
describe('renewing a Business Login token', () => {
  const DAY = 24 * 60 * 60 * 1_000;

  /** A credential on the username surface, expiring in `days`. */
  function loginCredential(days: number) {
    return {
      accessToken: 'ig-token',
      scopes: INSTAGRAM_LOGIN_SCOPES,
      expiresAt: new Date(Date.now() + days * DAY),
    };
  }

  async function withStubbedFetch<T>(
    responder: (url: string) => unknown,
    run: () => Promise<T>,
  ): Promise<{ result: T; urls: string[] }> {
    const urls: string[] = [];
    const globalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      return new Response(JSON.stringify(responder(url)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      return { result: await run(), urls };
    } finally {
      globalThis.fetch = globalFetch;
    }
  }

  it('refreshes a token that is old enough, and returns the new one', async () => {
    const { result, urls } = await withStubbedFetch(
      () => ({ access_token: 'renewed-token', expires_in: 5_183_944 }),
      // Issued 40 days ago, so 20 days remain: well past Meta's 24-hour floor.
      () => provider(graph).refreshCredential(loginCredential(20) as never),
    );

    expect(result.status).toBe('REFRESHED');
    if (result.status !== 'REFRESHED') throw new Error('expected a refresh');

    expect(result.credential.accessToken).toBe('renewed-token');
    // Renewed for another 60 days from today, not from the original issue date.
    expect(result.credential.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
    // A refresh renews a token; it does not re-grant consent.
    expect(result.credential.scopes).toEqual(INSTAGRAM_LOGIN_SCOPES);

    expect(urls.at(-1)).toContain('/refresh_access_token');
    expect(urls.at(-1)).toContain('grant_type=ig_refresh_token');
  });

  /**
   * Meta will not renew a token under 24 hours old. Asking anyway would turn a
   * brand-new connection into a refusal, so a young token reports healthy and
   * is left for the next sweep.
   */
  it('leaves a token younger than a day alone', async () => {
    const { result, urls } = await withStubbedFetch(
      () => ({ access_token: 'should-not-be-called' }),
      // Issued hours ago: nearly the full 60 days still to run.
      () => provider(graph).refreshCredential(loginCredential(59.9) as never),
    );

    expect(result.status).toBe('STILL_VALID');
    expect(urls).toHaveLength(0);
  });

  /**
   * Recording the old token as renewed is how a connection dies silently on a
   * date nobody is watching, so an answer with no token is a failed refresh.
   */
  it('asks for a reconnection when no token comes back', async () => {
    const { result } = await withStubbedFetch(
      () => ({}),
      () => provider(graph).refreshCredential(loginCredential(20) as never),
    );

    expect(result.status).toBe('REQUIRES_RECONNECT');
  });

  /** A Page token has no clock to beat, so there is nothing to call. */
  it('never calls the refresh endpoint for a Page-linked account', async () => {
    const graphWith = new FakeGraph().on(/debug_token/, {
      body: { data: { is_valid: true, scopes: [...INSTAGRAM_PUBLISH_SCOPES] } },
    });

    await provider(graphWith).refreshCredential(credential as never);

    expect(graphWith.calls.every((call) => !call.url.includes('refresh_access_token'))).toBe(true);
  });
});
