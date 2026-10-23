import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FacebookProvider } from './provider.js';
import { InstagramProvider } from '../instagram/provider.js';
import { INSTAGRAM_LOGIN_SCOPES } from '../instagram/capabilities.js';
import { metaWebhookChallenge, parseMetaWebhook, verifyMetaSignature } from './meta-webhooks.js';
import type { FetchLike } from './client.js';

/**
 * Private messages and webhooks on the two Meta adapters (D-107).
 *
 * Recorded shapes, injected fetch, no network. What this cannot prove is that
 * Meta's live payloads match — the examples are taken from Meta's webhook
 * reference, and D-107 lists what is still unverified against a real app.
 */

interface Call {
  url: string;
  method: string;
  body?: string;
}

/** A fetch that answers by URL and records what it was asked. */
function fakeFetch(routes: Array<[RegExp, unknown]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(init?.body instanceof URLSearchParams ? { body: init.body.toString() } : {}),
    });
    const route = [...routes].reverse().find(([pattern]) => pattern.test(url));
    if (!route) {
      return new Response(JSON.stringify({ error: { message: 'no fixture', code: 100 } }), {
        status: 400,
      });
    }
    return new Response(JSON.stringify(route[1]), { status: 200 });
  };
  return { fetch, calls };
}

const PAGE = '100';
const PERSON = 'psid-7';
const pageCredential = { accessToken: 'page-token', scopes: ['pages_messaging'], keyVersion: 1 };

function facebook(fetch: FetchLike, messaging = true, humanAgent = false) {
  return new FacebookProvider({
    appId: 'app-123',
    appSecret: 'secret-abc',
    apiVersion: 'v25.0',
    fetchImpl: fetch,
    baseUrl: 'https://graph.test',
    webhookVerifyToken: 'verify-me',
    messaging: { enabled: messaging, humanAgent },
  });
}

function body(call: Call | undefined): URLSearchParams {
  return new URLSearchParams(call?.body ?? '');
}

// ── The shared helpers ──────────────────────────────────────────────────────

describe('the subscription handshake', () => {
  const query = (token: string) => ({
    'hub.mode': 'subscribe',
    'hub.verify_token': token,
    'hub.challenge': '1158201444',
  });

  it('echoes the challenge for the configured token', () => {
    expect(metaWebhookChallenge(query('verify-me'), 'verify-me')).toBe('1158201444');
  });

  it('refuses a wrong token, a wrong mode, and an unconfigured endpoint', () => {
    expect(metaWebhookChallenge(query('guess'), 'verify-me')).toBeNull();
    expect(
      metaWebhookChallenge({ ...query('verify-me'), 'hub.mode': 'unsubscribe' }, 'verify-me'),
    ).toBeNull();
    // An endpoint with no token configured must not echo anybody's challenge.
    expect(metaWebhookChallenge(query('verify-me'), undefined)).toBeNull();
  });
});

describe('the webhook signature', () => {
  const sign = (raw: string, secret: string) =>
    'sha256=' + createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

  /** Meta signs the escaped bytes it sent; the raw body is what must be hashed. */
  it('verifies against the raw body, accents and all', () => {
    const raw = '{"entry":[{"messaging":[{"message":{"text":"Ch\\u00e0o shop"}}]}]}';
    expect(verifyMetaSignature(raw, sign(raw, 's1'), ['s1'])).toBe(true);
    // The same message re-serialised with the accent decoded is a different body.
    const decoded = raw.replace('\\u00e0', 'à');
    expect(verifyMetaSignature(decoded, sign(raw, 's1'), ['s1'])).toBe(false);
  });

  it('accepts either configured secret and refuses any other', () => {
    const raw = '{}';
    expect(
      verifyMetaSignature(raw, sign(raw, 'instagram'), [undefined, 'facebook', 'instagram']),
    ).toBe(true);
    expect(verifyMetaSignature(raw, sign(raw, 'stranger'), ['facebook', 'instagram'])).toBe(false);
    expect(verifyMetaSignature(raw, undefined, ['facebook'])).toBe(false);
  });
});

describe('parsing message events', () => {
  const noComments = () => null;
  const delivery = (messaging: unknown[]) =>
    JSON.stringify({ object: 'page', entry: [{ id: PAGE, time: 1_760_000_000, messaging }] });

  it('reads an inbound message from the person', () => {
    const [event] = parseMetaWebhook(
      delivery([
        {
          sender: { id: PERSON },
          recipient: { id: PAGE },
          timestamp: 1_760_000_000_123,
          message: {
            mid: 'm-1',
            text: 'Còn hàng không ạ?',
            attachments: [{ type: 'image', payload: { url: 'https://cdn.test/a.jpg' } }],
          },
        },
      ]),
      noComments,
    );

    expect(event).toEqual({
      kind: 'MESSAGE',
      externalEventId: 'message:m-1',
      accountExternalId: PAGE,
      message: {
        externalId: 'm-1',
        participantExternalId: PERSON,
        direction: 'INBOUND',
        text: 'Còn hàng không ạ?',
        attachments: [{ type: 'image', url: 'https://cdn.test/a.jpg' }],
        sentAt: new Date(1_760_000_000_123),
      },
    });
  });

  /** An echo is the brand's own message; the person is then the recipient. */
  it('reads an echo as outbound, addressed to the person', () => {
    const [event] = parseMetaWebhook(
      delivery([
        {
          sender: { id: PAGE },
          recipient: { id: PERSON },
          timestamp: 1_760_000_000_500,
          message: { mid: 'm-2', text: 'Dạ còn ạ', is_echo: true },
        },
      ]),
      noComments,
    );

    expect(event?.kind).toBe('MESSAGE');
    if (event?.kind !== 'MESSAGE') return;
    expect(event.message.direction).toBe('OUTBOUND');
    expect(event.message.participantExternalId).toBe(PERSON);
  });

  /** A deletion reuses the message id, so it needs an event id of its own. */
  it('marks an unsend, under a different event id from the message', () => {
    const [event] = parseMetaWebhook(
      delivery([
        {
          sender: { id: PERSON },
          recipient: { id: PAGE },
          timestamp: 1_760_000_001_000,
          message: { mid: 'm-1', is_deleted: true },
        },
      ]),
      noComments,
    );

    expect(event).toMatchObject({
      kind: 'MESSAGE',
      externalEventId: 'message:m-1:deleted',
      deleted: true,
    });
  });

  it('drops reactions, read receipts and anything without a message', () => {
    expect(
      parseMetaWebhook(
        delivery([
          { sender: { id: PERSON }, recipient: { id: PAGE }, read: { mid: 'm-1' } },
          { sender: { id: PERSON }, recipient: { id: PAGE }, reaction: { mid: 'm-1' } },
        ]),
        noComments,
      ),
    ).toEqual([]);
  });

  /** Throwing would make Meta retry a delivery that can never parse. */
  it('yields nothing for a body that is not JSON', () => {
    expect(parseMetaWebhook('not json', noComments)).toEqual([]);
  });
});

// ── Facebook ────────────────────────────────────────────────────────────────

describe('Facebook messaging', () => {
  it('asks for the messaging scopes only when messaging is on', () => {
    const { fetch } = fakeFetch([]);
    const on = facebook(fetch, true).getAuthorizationUrl({
      redirectUri: 'https://x.test',
      state: 's',
    });
    const off = facebook(fetch, false).getAuthorizationUrl({
      redirectUri: 'https://x.test',
      state: 's',
    });

    expect(on.scopes).toEqual(expect.arrayContaining(['pages_messaging', 'pages_manage_metadata']));
    // An unknown scope fails the whole dialog, publishing included.
    expect(off.scopes).not.toContain('pages_messaging');
    expect(off.scopes).not.toContain('pages_manage_metadata');
  });

  it('describes messaging only when it is on', () => {
    const { fetch } = fakeFetch([]);
    expect(facebook(fetch, true).capabilities().messaging).toMatchObject({
      supported: true,
      replyWindowHours: 24,
      maxMessageLength: 2_000,
    });
    expect(facebook(fetch, true).capabilities().messaging.humanAgentWindowHours).toBeUndefined();
    expect(facebook(fetch, true, true).capabilities().messaging.humanAgentWindowHours).toBe(168);
    expect(facebook(fetch, false).capabilities().messaging.supported).toBe(false);
  });

  it('replies inside the window as a RESPONSE', async () => {
    const { fetch, calls } = fakeFetch([
      [/\/messages/, { recipient_id: PERSON, message_id: 'm-9' }],
    ]);

    const sent = await facebook(fetch).sendMessage({
      credential: pageCredential,
      account: { externalId: PAGE },
      recipientExternalId: PERSON,
      text: 'Dạ còn ạ',
    });

    expect(sent.externalId).toBe('m-9');
    expect(calls[0]?.url).toContain(`/v25.0/${PAGE}/messages`);
    const form = body(calls[0]);
    expect(form.get('messaging_type')).toBe('RESPONSE');
    expect(form.get('tag')).toBeNull();
    expect(JSON.parse(form.get('recipient') ?? '{}')).toEqual({ id: PERSON });
    expect(JSON.parse(form.get('message') ?? '{}')).toEqual({ text: 'Dạ còn ạ' });
  });

  it('tags a reply outside the standard window as HUMAN_AGENT', async () => {
    const { fetch, calls } = fakeFetch([[/\/messages/, { message_id: 'm-10' }]]);

    await facebook(fetch, true, true).sendMessage({
      credential: pageCredential,
      account: { externalId: PAGE },
      recipientExternalId: PERSON,
      text: 'Xin lỗi đã trả lời muộn',
      humanAgent: true,
    });

    const form = body(calls[0]);
    expect(form.get('messaging_type')).toBe('MESSAGE_TAG');
    expect(form.get('tag')).toBe('HUMAN_AGENT');
  });

  /** Accepted without an id: possibly sent, unrecognisable — never recorded as sent. */
  it('refuses to treat an unconfirmed send as sent', async () => {
    const { fetch } = fakeFetch([[/\/messages/, { recipient_id: PERSON }]]);
    await expect(
      facebook(fetch).sendMessage({
        credential: pageCredential,
        account: { externalId: PAGE },
        recipientExternalId: PERSON,
        text: 'x',
      }),
    ).rejects.toMatchObject({ userMessage: expect.stringContaining('did not confirm') });
  });

  it('reads conversations oldest-message-first and stops at `since`', async () => {
    const { fetch, calls } = fakeFetch([
      [
        /\/conversations/,
        {
          data: [
            {
              id: 't-1',
              updated_time: '2026-10-22T10:00:00+0000',
              participants: {
                data: [
                  { id: PAGE, name: 'Shop' },
                  { id: PERSON, name: 'Lan' },
                ],
              },
              messages: {
                data: [
                  {
                    id: 'm-b',
                    message: 'Dạ còn',
                    created_time: '2026-10-22T10:00:00+0000',
                    from: { id: PAGE },
                  },
                  {
                    id: 'm-a',
                    message: 'Còn hàng?',
                    created_time: '2026-10-22T09:00:00+0000',
                    from: { id: PERSON },
                  },
                ],
              },
            },
            {
              id: 't-old',
              updated_time: '2026-09-01T00:00:00+0000',
              participants: { data: [{ id: PAGE }, { id: 'psid-old' }] },
            },
          ],
          paging: { cursors: { after: 'next' }, next: 'https://graph.test/next' },
        },
      ],
    ]);

    const page = await facebook(fetch).fetchConversations({
      credential: pageCredential,
      account: { externalId: PAGE },
      since: new Date('2026-10-01T00:00:00Z'),
    });

    expect(calls[0]?.url).toContain('platform=messenger');
    expect(page.conversations).toHaveLength(1);
    const [conversation] = page.conversations;
    expect(conversation?.participant).toEqual({ externalId: PERSON, name: 'Lan' });
    expect(conversation?.messages.map((m) => [m.externalId, m.direction])).toEqual([
      ['m-a', 'INBOUND'],
      ['m-b', 'OUTBOUND'],
    ]);
    // An older conversation was reached, so there is nothing further to page.
    expect(page.nextCursor).toBeUndefined();
  });

  it('subscribes the Page to feed always, and to messages only when on', async () => {
    const on = fakeFetch([[/subscribed_apps/, { success: true }]]);
    await facebook(on.fetch, true).subscribeWebhooks({
      credential: pageCredential,
      account: { externalId: PAGE },
    });
    expect(body(on.calls[0]).get('subscribed_fields')).toBe('feed,messages,message_echoes');

    const off = fakeFetch([[/subscribed_apps/, { success: true }]]);
    await facebook(off.fetch, false).subscribeWebhooks({
      credential: pageCredential,
      account: { externalId: PAGE },
    });
    expect(body(off.calls[0]).get('subscribed_fields')).toBe('feed');
  });
});

// ── Instagram (username login) ──────────────────────────────────────────────

describe('Instagram messaging', () => {
  const globalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = globalFetch;
  });

  /** graph.instagram.com is reached through the global fetch, not the Graph client. */
  function instagramHost(routes: Array<[RegExp, unknown]>) {
    const fake = fakeFetch(routes);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      fake.fetch(String(input), init)) as typeof fetch;
    return fake;
  }

  function instagram(messaging = true) {
    return new InstagramProvider({
      appId: 'fb-app',
      appSecret: 'fb-secret',
      apiVersion: 'v25.0',
      fetchImpl: fakeFetch([]).fetch,
      baseUrl: 'https://graph.test',
      webhookVerifyToken: 'verify-me',
      messaging: { enabled: messaging },
      login: { appId: 'ig-app', appSecret: 'ig-secret' },
    });
  }

  const loginCredential = {
    accessToken: 'ig-token',
    scopes: [...INSTAGRAM_LOGIN_SCOPES, 'instagram_business_manage_messages'],
    keyVersion: 1,
  };

  it('offers messaging on the username-login surface only', () => {
    expect(instagram().capabilities('INSTAGRAM_LOGIN').messaging).toMatchObject({
      supported: true,
      maxMessageBytes: 1_000,
      scopes: ['instagram_business_manage_messages'],
    });
    expect(instagram().capabilities('INSTAGRAM_BUSINESS').messaging.supported).toBe(false);
    expect(instagram(false).capabilities('INSTAGRAM_LOGIN').messaging.supported).toBe(false);
  });

  it('asks for the messaging scope only when messaging is on', () => {
    const input = { redirectUri: 'https://x.test', state: 's', accountType: 'INSTAGRAM_LOGIN' };
    expect(instagram(true).getAuthorizationUrl(input).scopes).toContain(
      'instagram_business_manage_messages',
    );
    expect(instagram(false).getAuthorizationUrl(input).scopes).not.toContain(
      'instagram_business_manage_messages',
    );
  });

  /**
   * The credential records what was granted. A constant here is why a scope
   * added later could never be seen, and every reply was refused as "reconnect".
   */
  it('records the granted permissions from the token exchange', async () => {
    instagramHost([
      [
        /api\.instagram\.com\/oauth\/access_token/,
        {
          access_token: 'short',
          user_id: 1,
          permissions: 'instagram_business_basic,instagram_business_manage_messages',
        },
      ],
      [/graph\.instagram\.com\/access_token/, { access_token: 'long', expires_in: 5_184_000 }],
      [/graph\.instagram\.com\/me/, { id: 'app-scoped', username: 'shop' }],
    ]);

    const result = await instagram().exchangeCode({
      code: 'c',
      redirectUri: 'https://x.test',
      accountType: 'INSTAGRAM_LOGIN',
    });

    expect(result.accounts[0]?.credential.scopes).toEqual([
      'instagram_business_basic',
      'instagram_business_manage_messages',
    ]);
  });

  it('replies through /me/messages on the Instagram host', async () => {
    const fake = instagramHost([[/graph\.instagram\.com\/me\/messages/, { message_id: 'ig-m-1' }]]);

    const sent = await instagram().sendMessage({
      credential: loginCredential,
      account: { externalId: 'app-scoped' },
      recipientExternalId: 'igsid-1',
      text: 'Dạ shop còn ạ',
    });

    expect(sent.externalId).toBe('ig-m-1');
    const form = body(fake.calls[0]);
    expect(JSON.parse(form.get('recipient') ?? '{}')).toEqual({ id: 'igsid-1' });
    expect(form.get('access_token')).toBe('ig-token');
    expect(form.get('tag')).toBeNull();
  });

  /** Webhooks name the account by its professional id, which /me's `id` is not. */
  it('subscribes and reports the id webhooks will use', async () => {
    const fake = instagramHost([
      [/subscribed_apps/, { success: true }],
      [/graph\.instagram\.com\/me\?/, { user_id: '17841465889188894', id: '28988773447411015' }],
    ]);

    const result = await instagram().subscribeWebhooks({
      credential: loginCredential,
      account: { externalId: '28988773447411015' },
    });

    expect(result.webhookExternalId).toBe('17841465889188894');
    expect(body(fake.calls[0]).get('subscribed_fields')).toBe('comments,messages');
  });

  it('accepts a webhook signed with the Instagram app secret', () => {
    const raw = JSON.stringify({ object: 'instagram', entry: [] });
    const signature = 'sha256=' + createHmac('sha256', 'ig-secret').update(raw).digest('hex');
    expect(
      instagram().verifyWebhook({ headers: { 'x-hub-signature-256': signature }, rawBody: raw }),
    ).toBe(true);
  });

  it('turns a comment change into comment activity on the media', () => {
    const events = instagram().parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        object: 'instagram',
        entry: [
          {
            id: '17841465889188894',
            time: 1_760_000_000,
            changes: [
              {
                field: 'comments',
                value: { id: 'c-1', text: 'Đẹp quá', media: { id: 'media-5' } },
              },
            ],
          },
        ],
      }),
    });

    expect(events).toEqual([
      {
        kind: 'COMMENT_ACTIVITY',
        externalEventId: 'comment:c-1',
        accountExternalId: '17841465889188894',
        externalPostId: 'media-5',
        occurredAt: new Date(1_760_000_000 * 1_000),
      },
    ]);
  });
});
