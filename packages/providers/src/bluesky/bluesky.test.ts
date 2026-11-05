import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock, fixedClock, setClock } from '@orbit/core';
import { runProviderContractTests } from '../contract/contract-tests.js';
import { validateDraft } from '../validation.js';
import { BlueskyProvider, newTid } from './provider.js';
import { blueskyCapabilities, blueskyClientMetadata } from './capabilities.js';
import { deriveEs256Key, dpopProof, keyFromPrivateJwk, type PrivateEcJwk } from './crypto.js';
import { detectFacets } from './richtext.js';
import type { FetchLike } from './client.js';

/**
 * The Bluesky adapter against recorded responses.
 *
 * The cases worth having are the ones atproto makes unusual: a pushed
 * authorization request, DPoP proofs that must carry a server nonce learned by
 * being refused, an account that must be traced back to the server that
 * vouched for it, and links and hashtags marked by UTF-8 byte offsets.
 */

interface Recorded {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Call {
  url: string;
  method: string;
  body?: string;
  bytes?: Uint8Array;
  headers: Record<string, string>;
}

class FakeAtproto {
  readonly calls: Call[] = [];
  private routes: Array<{
    match: RegExp;
    method?: string;
    response: Recorded | ((call: Call) => Recorded);
  }> = [];

  on(match: RegExp, response: Recorded | ((call: Call) => Recorded), method?: string): this {
    this.routes.push({ match, response, ...(method ? { method } : {}) });
    return this;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: Call = { url, method, headers };
    if (typeof init?.body === 'string') call.body = init.body;
    if (init?.body instanceof Blob) call.bytes = new Uint8Array(await init.body.arrayBuffer());
    this.calls.push(call);

    const route = [...this.routes]
      .reverse()
      .find((r) => r.match.test(url) && (!r.method || r.method === method));
    const recorded = route
      ? typeof route.response === 'function'
        ? route.response(call)
        : route.response
      : { status: 404, body: { error: 'NotFound', message: `no fixture for ${method} ${url}` } };

    return new Response(recorded.body === undefined ? null : JSON.stringify(recorded.body), {
      status: recorded.status ?? 200,
      headers: { 'content-type': 'application/json', ...(recorded.headers ?? {}) },
    });
  };

  callsTo(pattern: RegExp, method?: string) {
    return this.calls.filter((c) => pattern.test(c.url) && (!method || c.method === method));
  }

  form(pattern: RegExp): URLSearchParams {
    return new URLSearchParams(this.callsTo(pattern).at(-1)?.body ?? '');
  }

  json(pattern: RegExp): Record<string, unknown> {
    const body = this.callsTo(pattern).at(-1)?.body;
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  }
}

const NOW = Date.UTC(2026, 10, 5, 9, 0, 0);
const DID = 'did:plc:abc123';
const PDS = 'https://pds.test';
const ISSUER = 'https://bsky.social';
const VERIFIER = 'v'.repeat(43);
const CLIENT_ID = 'https://app.test/oauth/bluesky/client-metadata.json';

const clientJwk = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...(privateKey.export({ format: 'jwk' }) as PrivateEcJwk), kid: 'test-key' };
})();

function happyAtproto(): FakeAtproto {
  return new FakeAtproto()
    .on(/\/\.well-known\/oauth-authorization-server/, {
      body: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
      },
    })
    .on(/\/oauth\/par/, {
      status: 201,
      body: { request_uri: 'urn:ietf:params:oauth:request_uri:req-1', expires_in: 299 },
      headers: { 'dpop-nonce': 'n-2' },
    })
    .on(/\/oauth\/token/, {
      body: {
        access_token: 'at-1',
        refresh_token: 'rt-2',
        token_type: 'DPoP',
        expires_in: 1800,
        scope: 'atproto repo:app.bsky.feed.post?action=create&action=delete blob:image/*',
        sub: DID,
      },
    })
    .on(/plc\.directory/, {
      body: {
        id: DID,
        alsoKnownAs: ['at://client.bsky.social'],
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
      },
    })
    .on(/pds\.test\/\.well-known\/oauth-protected-resource/, {
      body: { authorization_servers: [ISSUER] },
    })
    .on(/app\.bsky\.actor\.getProfile/, {
      body: {
        did: DID,
        handle: 'client.bsky.social',
        displayName: 'Client Co',
        followersCount: 120,
        followsCount: 8,
        postsCount: 41,
      },
    })
    .on(/com\.atproto\.repo\.uploadBlob/, {
      body: {
        blob: { $type: 'blob', ref: { $link: 'bafy-img' }, mimeType: 'image/jpeg', size: 3 },
      },
    })
    .on(/com\.atproto\.repo\.createRecord/, (call) => {
      const { rkey } = JSON.parse(call.body ?? '{}') as { rkey: string };
      return { body: { uri: `at://${DID}/app.bsky.feed.post/${rkey}`, cid: 'bafy-post' } };
    })
    .on(/com\.atproto\.server\.getSession/, { body: { did: DID, handle: 'client.bsky.social' } });
}

function provider(api: FakeAtproto): BlueskyProvider {
  return new BlueskyProvider({
    clientId: CLIENT_ID,
    privateKeyJwk: clientJwk,
    fetchImpl: api.fetch,
    readMedia: async () => new Uint8Array([1, 2, 3]),
  });
}

const sessionKey = deriveEs256Key(Buffer.from('k'), 'session');
const credential = {
  accessToken: JSON.stringify({
    v: 1,
    token: 'at-1',
    dpop: sessionKey.privateJwk,
    pds: PDS,
    issuer: ISSUER,
    did: DID,
  }),
  refreshToken: 'rt-1',
  expiresAt: new Date(NOW + 30 * 60 * 1000),
  scopes: ['atproto', 'repo:app.bsky.feed.post?action=create&action=delete', 'blob:image/*'],
  keyVersion: 1,
};

function decodeJwt(jwt: string) {
  const [header, payload] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>,
  };
}

function verifies(jwt: string, publicJwk: Record<string, unknown>): boolean {
  const [header, payload, signature] = jwt.split('.');
  return verify(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    { key: createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature!, 'base64url'),
  );
}

let api: FakeAtproto;
let restoreClock: () => void;

beforeEach(() => {
  api = happyAtproto();
  restoreClock = setClock(fixedClock(NOW));
});
afterEach(() => restoreClock());

/** A stateful PDS for the contract suite, which publishes and then expects to find it. */
function contractAtproto(): FakeAtproto {
  const records: Array<{ uri: string; value: { text: string; createdAt: string } }> = [];
  return happyAtproto()
    .on(/com\.atproto\.repo\.createRecord/, (call) => {
      const { rkey, record } = JSON.parse(call.body ?? '{}') as {
        rkey: string;
        record: { text: string };
      };
      const uri = `at://${DID}/app.bsky.feed.post/${rkey}`;
      records.push({ uri, value: { text: record.text, createdAt: clock.now().toISOString() } });
      return { body: { uri, cid: 'bafy' } };
    })
    .on(/com\.atproto\.repo\.listRecords/, () => ({ body: { records } }))
    .on(/com\.atproto\.repo\.deleteRecord/, {
      status: 400,
      body: { error: 'InvalidRequest', message: 'Could not find record' },
    });
}

runProviderContractTests({
  name: 'Bluesky',
  createProvider: () => provider(contractAtproto()),
  validCredential: () => credential,
  sampleAccount: { externalId: DID },
  validDraft: () => ({ body: 'Fresh beans in tomorrow.' }),
});

describe('crypto', () => {
  it('derives the same key from the same secret and label, and a different one otherwise', () => {
    const a = deriveEs256Key(Buffer.from('secret'), 'flow-1');
    expect(deriveEs256Key(Buffer.from('secret'), 'flow-1').publicJwk).toEqual(a.publicJwk);
    expect(deriveEs256Key(Buffer.from('secret'), 'flow-2').publicJwk).not.toEqual(a.publicJwk);
  });

  /** RFC 9449: htu without query, ath the hash of the token, the server's nonce. */
  it('builds a DPoP proof a verifier accepts', () => {
    const proof = dpopProof({
      key: sessionKey,
      method: 'get',
      url: `${PDS}/xrpc/x.y?z=1`,
      nowMs: NOW,
      nonce: 'n-1',
      accessToken: 'at-1',
    });
    const { header, payload } = decodeJwt(proof);
    expect(header).toMatchObject({ typ: 'dpop+jwt', alg: 'ES256' });
    expect(payload).toMatchObject({
      htm: 'GET',
      htu: `${PDS}/xrpc/x.y`,
      nonce: 'n-1',
      ath: createHash('sha256').update('at-1').digest('base64url'),
    });
    expect(verifies(proof, header['jwk'] as Record<string, unknown>)).toBe(true);
  });

  it('round-trips a private JWK', () => {
    expect(keyFromPrivateJwk(clientJwk).publicJwk.kid).toBe('test-key');
  });
});

describe('authorization', () => {
  /** The nonce is only learned by being refused for not having one. */
  it('pushes the request, retrying once with the nonce the server asked for', async () => {
    let attempt = 0;
    api.on(/\/oauth\/par/, () => {
      attempt += 1;
      return attempt === 1
        ? { status: 400, body: { error: 'use_dpop_nonce' }, headers: { 'dpop-nonce': 'n-1' } }
        : { status: 201, body: { request_uri: 'urn:req-1' }, headers: { 'dpop-nonce': 'n-2' } };
    });

    const { url } = await provider(api).getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 'nonce-state',
      codeVerifier: VERIFIER,
    });

    const pushes = api.callsTo(/\/oauth\/par/);
    expect(pushes).toHaveLength(2);
    expect(decodeJwt(pushes[1]!.headers['dpop']!).payload['nonce']).toBe('n-1');

    const form = api.form(/\/oauth\/par/);
    expect(form.get('state')).toBe('nonce-state');
    expect(form.get('code_challenge')).toBe(
      createHash('sha256').update(VERIFIER).digest('base64url'),
    );
    expect(form.get('code_challenge_method')).toBe('S256');
    expect(form.get('scope')).toContain('repo:app.bsky.feed.post');

    // Social Square authenticates itself, with the issuer as audience.
    const assertion = form.get('client_assertion')!;
    expect(decodeJwt(assertion).payload).toMatchObject({
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      aud: ISSUER,
    });
    expect(verifies(assertion, keyFromPrivateJwk(clientJwk).publicJwk)).toBe(true);

    expect(url).toBe(
      `${ISSUER}/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&request_uri=urn%3Areq-1`,
    );
    expect(url).not.toContain(VERIFIER);
  });

  it('refuses to start without a PKCE verifier', async () => {
    await expect(
      provider(api).getAuthorizationUrl({ redirectUri: 'https://app.test/cb', state: 's' }),
    ).rejects.toThrow(/PKCE/);
  });
});

describe('connecting', () => {
  it('binds the token to the same DPoP key the request was pushed with', async () => {
    const bluesky = provider(api);
    await bluesky.getAuthorizationUrl({
      redirectUri: 'https://app.test/cb',
      state: 's',
      codeVerifier: VERIFIER,
    });
    const connected = await bluesky.exchangeCode({
      code: 'c-1',
      redirectUri: 'https://app.test/cb',
      codeVerifier: VERIFIER,
    });

    const pushedKey = decodeJwt(api.callsTo(/\/oauth\/par/)[0]!.headers['dpop']!).header['jwk'];
    const tokenKey = decodeJwt(api.callsTo(/\/oauth\/token/)[0]!.headers['dpop']!).header['jwk'];
    expect(tokenKey).toEqual(pushedKey);

    expect(connected.accounts).toEqual([
      expect.objectContaining({
        externalId: DID,
        handle: 'client.bsky.social',
        displayName: 'Client Co',
      }),
    ]);
    const session = JSON.parse(connected.accounts[0]!.credential.accessToken) as Record<
      string,
      unknown
    >;
    expect(session).toMatchObject({ token: 'at-1', pds: PDS, did: DID, issuer: ISSUER });
    expect(api.form(/\/oauth\/token/).get('code_verifier')).toBe(VERIFIER);
  });

  /** Without this check, any authorization server could claim any account. */
  it('refuses an account whose PDS trusts a different authorization server', async () => {
    api.on(/pds\.test\/\.well-known\/oauth-protected-resource/, {
      body: { authorization_servers: ['https://evil.test'] },
    });

    await expect(
      provider(api).exchangeCode({
        code: 'c',
        redirectUri: 'https://app.test/cb',
        codeVerifier: VERIFIER,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_ERROR' });
  });

  it('refreshes near expiry with the session key, and keeps the account', async () => {
    const outcome = await provider(api).refreshCredential({
      ...credential,
      expiresAt: new Date(NOW + 60_000),
    });

    expect(outcome.status).toBe('REFRESHED');
    if (outcome.status !== 'REFRESHED') return;
    expect(outcome.credential.refreshToken).toBe('rt-2');
    expect(JSON.parse(outcome.credential.accessToken)).toMatchObject({ did: DID, pds: PDS });
    expect(decodeJwt(api.callsTo(/\/oauth\/token/)[0]!.headers['dpop']!).header['jwk']).toEqual(
      (({ kid: _k, ...rest }) => rest)(sessionKey.publicJwk),
    );
  });

  it('leaves a token with time to run alone', async () => {
    expect(await provider(api).refreshCredential(credential)).toEqual({ status: 'STILL_VALID' });
    expect(api.calls).toHaveLength(0);
  });
});

describe('facets', () => {
  /** Byte offsets, not characters: "đã" is four bytes, not two. */
  it('marks links and hashtags by UTF-8 byte offsets', () => {
    const text = 'Món mới đã có https://a.test/menu. #phở #2026';
    const facets = detectFacets(text);
    const slice = (start: number, end: number) => Buffer.from(text).subarray(start, end).toString();

    expect(facets).toHaveLength(2);
    expect(slice(facets[0]!.index.byteStart, facets[0]!.index.byteEnd)).toBe('https://a.test/menu');
    expect(facets[0]!.features[0]).toEqual({
      $type: 'app.bsky.richtext.facet#link',
      uri: 'https://a.test/menu',
    });
    expect(slice(facets[1]!.index.byteStart, facets[1]!.index.byteEnd)).toBe('#phở');
    expect(facets[1]!.features[0]).toEqual({ $type: 'app.bsky.richtext.facet#tag', tag: 'phở' });
  });
});

describe('publishing', () => {
  it('uploads images, then writes the post under a key recorded first', async () => {
    const refs: Array<Record<string, unknown>> = [];
    const result = await provider(api).publish({
      credential,
      account: { externalId: DID },
      draft: { body: 'Hello', hashtags: ['launch'], media: [], linkUrl: 'https://a.test' },
      media: [
        {
          id: 'm',
          kind: 'IMAGE',
          mimeType: 'image/jpeg',
          sizeBytes: 3,
          url: 'https://cdn/m',
          width: 1200,
          height: 800,
          altText: 'A bowl',
        },
      ],
      contentHash: 'h-1',
      correlationId: 'c',
      recordProviderRef: async (ref) => {
        refs.push(ref);
      },
    } as never);

    const upload = api.callsTo(/uploadBlob/)[0]!;
    expect(upload.headers['content-type']).toBe('image/jpeg');
    expect(upload.headers['authorization']).toBe('DPoP at-1');

    const body = api.json(/createRecord/) as { rkey: string; record: Record<string, unknown> };
    expect(refs[0]).toMatchObject({ rkey: body.rkey, contentHash: 'h-1' });
    expect(body.record['text']).toBe('Hello\n\n#launch\n\nhttps://a.test');
    expect(body.record['embed']).toMatchObject({
      $type: 'app.bsky.embed.images',
      images: [{ alt: 'A bowl', aspectRatio: { width: 1200, height: 800 } }],
    });
    expect((body.record['facets'] as unknown[]).length).toBe(2);
    expect(result.permalink).toBe(`https://bsky.app/profile/${DID}/post/${body.rkey}`);
  });

  /** A retry whose first attempt landed is refused for the key; the record existing is the answer. */
  it('treats a reused key that already exists as published', async () => {
    api
      .on(/createRecord/, {
        status: 400,
        body: { error: 'InvalidRequest', message: 'Record already exists' },
      })
      .on(/com\.atproto\.repo\.getRecord/, {
        body: { uri: `at://${DID}/app.bsky.feed.post/3kprev`, value: { text: 'Hello' } },
      });

    const result = await provider(api).publish({
      credential,
      account: { externalId: DID },
      draft: { body: 'Hello', media: [] },
      media: [],
      contentHash: 'h-1',
      correlationId: 'c',
      previousRef: { rkey: '3kprev', contentHash: 'h-1' },
    } as never);

    expect(result.externalPostId).toBe(`at://${DID}/app.bsky.feed.post/3kprev`);
  });

  it('counts graphemes, as Bluesky does', () => {
    const caps = blueskyCapabilities('atproto');
    // 300 family emoji: 300 graphemes, 2,100 code points.
    expect(validateDraft(caps, { body: '👨‍👩‍👧'.repeat(300), media: [] }).valid).toBe(true);
    expect(validateDraft(caps, { body: 'a'.repeat(301), media: [] }).valid).toBe(false);
  });
});

describe('reconciliation', () => {
  const base = {
    credential,
    account: { externalId: DID },
    contentHash: 'h-1',
    body: 'Hello',
    attemptedAt: new Date(NOW),
    windowMs: 600_000,
    correlationId: 'c',
  };

  it('answers by record key when the attempt recorded one', async () => {
    api.on(/getRecord/, {
      status: 400,
      body: { error: 'RecordNotFound', message: 'Could not locate record' },
    });
    expect((await provider(api).reconcile({ ...base, providerRef: { rkey: '3kx' } })).outcome).toBe(
      'NOT_FOUND',
    );

    api.on(/getRecord/, {
      body: {
        uri: `at://${DID}/app.bsky.feed.post/3kx`,
        value: { createdAt: new Date(NOW).toISOString() },
      },
    });
    expect(await provider(api).reconcile({ ...base, providerRef: { rkey: '3kx' } })).toMatchObject({
      outcome: 'FOUND',
      externalPostId: `at://${DID}/app.bsky.feed.post/3kx`,
    });
  });

  it('is inconclusive, never "not found", when the PDS cannot be reached', async () => {
    api.on(/getRecord/, { status: 503, body: { error: 'Unavailable' } });
    expect((await provider(api).reconcile({ ...base, providerRef: { rkey: '3kx' } })).outcome).toBe(
      'INCONCLUSIVE',
    );
  });
});

describe('analytics', () => {
  it('reads public counts, and says what Bluesky did not report', async () => {
    api.on(/getPosts/, {
      body: {
        posts: [{ uri: 'at://x', likeCount: 9, repostCount: 2, replyCount: 1, quoteCount: 0 }],
      },
    });

    const set = await provider(api).fetchPostAnalytics(
      { externalPostId: `at://${DID}/app.bsky.feed.post/3kx`, accountExternalId: DID },
      credential,
      { from: new Date(NOW - 1000), to: new Date(NOW) },
    );

    expect(set.metrics).toEqual({
      bsky_likes: 9,
      bsky_reposts: 2,
      bsky_replies: 1,
      bsky_quotes: 0,
    });
    expect(set.availability['bsky_bookmarks']).toBe('UNSUPPORTED');
  });

  it('reads follower counts for the account', async () => {
    const set = await provider(api).fetchAccountAnalytics({ externalId: DID }, credential, {
      from: new Date(NOW - 1000),
      to: new Date(NOW),
    });
    expect(set.metrics).toEqual({ bsky_followers: 120, bsky_following: 8, bsky_posts: 41 });
  });
});

describe('client metadata and record keys', () => {
  it('describes the same client the adapter authenticates as', () => {
    const metadata = blueskyClientMetadata('https://app.test');
    expect(metadata).toMatchObject({
      client_id: CLIENT_ID,
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      dpop_bound_access_tokens: true,
      redirect_uris: ['https://app.test/api/v1/social/oauth/bluesky/callback'],
      jwks_uri: 'https://app.test/oauth/bluesky/jwks.json',
    });
    expect(String(metadata['scope'])).toMatch(/^atproto /);
  });

  it('makes record keys in TID form, sortable by time', () => {
    const a = newTid(NOW);
    const b = newTid(NOW + 1000);
    expect(a).toMatch(/^[2-7a-z]{13}$/);
    expect(a < b).toBe(true);
  });
});
