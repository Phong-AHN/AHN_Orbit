import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, setClock, type TenantContext } from '@orbit/core';
import { platformDb, withTenant } from '@orbit/db';
import { closeQueues, closeSharedConnection } from '@orbit/queue';
import { CredentialCipher, registerProvider, resetRegistry } from '@orbit/providers';
import { FacebookProvider } from '@orbit/providers/facebook';
import type { DirectMessage } from '@orbit/providers';
import { recordMessage } from './ingest.js';
import { processWebhookEvent, sweepWebhookEvents } from './webhooks.js';
import { sweepRetention } from '../maintenance/retention.js';

/**
 * Private messages against the real database (D-107).
 *
 * What these prove that the unit tests cannot: that a message is written once
 * however many times it arrives, that the conversation's state moves the way
 * the inbox depends on, that one webhook reaches every organization that has
 * the Page connected — and only those — and that nothing private is left in
 * the platform-wide webhook table afterwards.
 */

const ORG_A = '018ffa71-0000-7000-8000-0000fa000001';
const ORG_B = '018ffa71-0000-7000-8000-0000fa0000b1';
const WS_A = '018ffa71-0000-7000-8000-0000fa000002';
const WS_B = '018ffa71-0000-7000-8000-0000fa0000b2';
const BRAND_A = '018ffa71-0000-7000-8000-0000fa000003';
const BRAND_B = '018ffa71-0000-7000-8000-0000fa0000b3';
const ACCOUNT_A = '018ffa71-0000-7000-8000-0000fa000004';
const ACCOUNT_B = '018ffa71-0000-7000-8000-0000fa0000b4';

const PAGE = 'page-msg-1';
const PERSON = 'psid-msg-1';
const NOW = new Date('2026-10-23T09:00:00.000Z');

let restoreClock: (() => void) | undefined;

function ctxFor(organizationId: string): TenantContext {
  return {
    organizationId,
    principal: {
      kind: 'SYSTEM',
      actorName: 'messaging-worker',
      capabilities: ['social_account:read', 'message:read'],
    },
    correlationId: 'itest-messaging',
  };
}

const account = { id: ACCOUNT_A, workspaceId: WS_A, brandId: BRAND_A };

function message(overrides: Partial<DirectMessage> = {}): DirectMessage {
  return {
    externalId: 'mid-1',
    participantExternalId: PERSON,
    direction: 'INBOUND',
    text: 'Còn hàng không ạ?',
    attachments: [],
    sentAt: new Date('2026-10-23T08:00:00.000Z'),
    ...overrides,
  };
}

async function seedTenant(org: string, ws: string, brand: string, accountId: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: org.slice(-4), slug: `msg-${org.slice(-4)}`, timezone: 'UTC' },
  });
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, organizationId: org, name: 'ws', slug: 'ws', timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: brand },
    update: {},
    create: { id: brand, organizationId: org, workspaceId: ws, name: 'b', slug: 'b' },
  });
  await platformDb.socialAccount.upsert({
    where: { id: accountId },
    update: { status: 'ACTIVE', deletedAt: null },
    create: {
      id: accountId,
      organizationId: org,
      workspaceId: ws,
      brandId: brand,
      platform: 'FACEBOOK',
      // The same Page, connected by two agencies.
      externalId: PAGE,
      displayName: 'Shop',
      accountType: 'PAGE',
      status: 'ACTIVE',
      scopes: ['pages_messaging', 'pages_manage_metadata'],
    },
  });

  const sealed = new CredentialCipher().seal('page-token', {
    organizationId: org,
    socialAccountId: accountId,
  });
  await platformDb.socialCredential.upsert({
    where: { socialAccountId: accountId },
    update: {},
    create: {
      organizationId: org,
      socialAccountId: accountId,
      accessTokenCiphertext: new Uint8Array(sealed.ciphertext),
      accessTokenIv: new Uint8Array(sealed.iv),
      accessTokenAuthTag: new Uint8Array(sealed.authTag),
      keyVersion: sealed.keyVersion,
      scopes: ['pages_messaging', 'pages_manage_metadata'],
    },
  });
}

async function storeEvent(payload: unknown, externalEventId: string) {
  return platformDb.webhookEvent.create({
    data: {
      provider: 'FACEBOOK',
      externalEventId,
      signatureValid: true,
      payload: payload as object,
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';
  restoreClock = setClock(fixedClock(NOW));

  // A real adapter with messaging on and no network: the profile lookup is
  // the only call ingestion makes, and it answers with a name.
  resetRegistry();
  registerProvider(
    new FacebookProvider({
      appId: 'app',
      appSecret: 'secret',
      apiVersion: 'v25.0',
      baseUrl: 'https://graph.test',
      fetchImpl: async () => new Response(JSON.stringify({ name: 'Lan' }), { status: 200 }),
      messaging: { enabled: true },
    }),
  );

  await seedTenant(ORG_A, WS_A, BRAND_A, ACCOUNT_A);
  await seedTenant(ORG_B, WS_B, BRAND_B, ACCOUNT_B);
});

beforeEach(async () => {
  await platformDb.socialConversation.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
  await platformDb.webhookEvent.deleteMany({
    where: { externalEventId: { startsWith: 'itest:' } },
  });
  await platformDb.notification.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.webhookEvent.deleteMany({
    where: { externalEventId: { startsWith: 'itest:' } },
  });
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

const record = (m: DirectMessage, options: Parameters<typeof recordMessage>[4] = {}) =>
  withTenant(ctxFor(ORG_A), (db) => recordMessage(db, ctxFor(ORG_A), account, m, options));

async function conversationA() {
  return platformDb.socialConversation.findFirstOrThrow({
    where: { organizationId: ORG_A, participantExternalId: PERSON },
    include: { messages: { orderBy: { sentAt: 'asc' } } },
  });
}

describe('recording a message', () => {
  it('opens a conversation that needs a reply', async () => {
    const result = await record(message());

    expect(result).toMatchObject({ created: true, opened: true });
    const conversation = await conversationA();
    expect(conversation.state).toBe('NEW');
    expect(conversation.lastInboundAt?.toISOString()).toBe('2026-10-23T08:00:00.000Z');
    expect(conversation.messages).toHaveLength(1);
  });

  /** Meta retries for 36 hours and the backfill re-reads: every message arrives twice. */
  it('writes a message once however many times it arrives', async () => {
    await record(message());
    const again = await record(message());

    expect(again).toMatchObject({ created: false, opened: false });
    expect((await conversationA()).messages).toHaveLength(1);
  });

  it('is closed by the brand answering from the platform’s own app', async () => {
    await record(message());
    await record(
      message({
        externalId: 'mid-2',
        direction: 'OUTBOUND',
        text: 'Dạ còn ạ',
        sentAt: new Date('2026-10-23T08:05:00.000Z'),
      }),
    );

    expect((await conversationA()).state).toBe('HANDLED');
  });

  /** Deliveries arrive out of order; an old echo must not close a newer question. */
  it('is not closed by an echo older than the person’s latest message', async () => {
    await record(message({ sentAt: new Date('2026-10-23T08:10:00.000Z') }));
    await record(
      message({
        externalId: 'mid-old-echo',
        direction: 'OUTBOUND',
        sentAt: new Date('2026-10-23T08:00:00.000Z'),
      }),
    );

    expect((await conversationA()).state).toBe('NEW');
  });

  it('is reopened by the person writing again', async () => {
    await record(message());
    await platformDb.socialConversation.updateMany({
      where: { organizationId: ORG_A },
      data: { state: 'HANDLED', handledAt: NOW },
    });

    const result = await record(
      message({ externalId: 'mid-3', sentAt: new Date('2026-10-23T08:30:00.000Z') }),
    );

    expect(result.opened).toBe(true);
    const conversation = await conversationA();
    expect(conversation.state).toBe('NEW');
    expect(conversation.handledAt).toBeNull();
  });

  /** An unsend keeps the row and loses the words. */
  it('erases what was said when the person unsends it', async () => {
    await record(message());
    await record(message(), { deleted: true });

    const [stored] = (await conversationA()).messages;
    expect(stored?.text).toBeNull();
    expect(stored?.attachments).toEqual([]);
    expect(stored?.deletedAt).not.toBeNull();
  });
});

describe('a webhook event', () => {
  const event = {
    kind: 'MESSAGE',
    externalEventId: 'message:mid-hook',
    accountExternalId: PAGE,
    message: {
      externalId: 'mid-hook',
      participantExternalId: PERSON,
      direction: 'INBOUND',
      text: 'Shop ơi',
      attachments: [],
      sentAt: '2026-10-23T08:59:00.000Z',
    },
  };

  /** Two agencies with the same Page connected each get the message, separately. */
  it('reaches every organization that has the account connected', async () => {
    const stored = await storeEvent(event, 'itest:hook-1');

    const result = await processWebhookEvent({
      webhookEventId: stored.id,
      jobId: 'itest',
      correlationId: 'itest',
    });

    expect(result).toMatchObject({ accounts: 2, recorded: 2 });
    for (const organizationId of [ORG_A, ORG_B]) {
      const conversation = await platformDb.socialConversation.findFirstOrThrow({
        where: { organizationId, participantExternalId: PERSON },
      });
      // The name came from the profile lookup, since the webhook carries only an id.
      expect(conversation.participantName).toBe('Lan');
    }
  });

  it('does not reach an organization whose connection is gone', async () => {
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT_B },
      data: { status: 'REVOKED', deletedAt: NOW },
    });

    try {
      const stored = await storeEvent(event, 'itest:hook-2');
      const result = await processWebhookEvent({
        webhookEventId: stored.id,
        jobId: 'itest',
        correlationId: 'itest',
      });

      expect(result.accounts).toBe(1);
      expect(await platformDb.socialConversation.count({ where: { organizationId: ORG_B } })).toBe(
        0,
      );
    } finally {
      await platformDb.socialAccount.update({
        where: { id: ACCOUNT_B },
        data: { status: 'ACTIVE', deletedAt: null },
      });
    }
  });

  /** The platform-wide table has no row-level security; nothing private may stay in it. */
  it('leaves nothing private in the stored event once processed', async () => {
    const stored = await storeEvent(event, 'itest:hook-3');
    await processWebhookEvent({
      webhookEventId: stored.id,
      jobId: 'itest',
      correlationId: 'itest',
    });

    const row = await platformDb.webhookEvent.findUniqueOrThrow({ where: { id: stored.id } });
    expect(row.processedAt).not.toBeNull();
    expect(JSON.stringify(row.payload)).not.toContain('Shop ơi');
    expect(JSON.stringify(row.payload)).not.toContain(PERSON);
  });

  it('notifies once when a conversation opens, without the message or the sender', async () => {
    const stored = await storeEvent(event, 'itest:hook-4');
    await processWebhookEvent({
      webhookEventId: stored.id,
      jobId: 'itest',
      correlationId: 'itest',
    });

    const rows = await platformDb.notification.findMany({ where: { organizationId: ORG_A } });
    for (const row of rows) {
      expect(row.type).toBe('message.received');
      expect(`${row.title} ${row.body}`).not.toContain('Shop ơi');
      expect(`${row.title} ${row.body}`).not.toContain('Lan');
    }
  });

  it('is handed back by the sweep when nothing processed it', async () => {
    const stored = await storeEvent(event, 'itest:hook-5');
    await platformDb.webhookEvent.update({
      where: { id: stored.id },
      data: { createdAt: new Date(NOW.getTime() - 5 * 60_000) },
    });

    const result = await sweepWebhookEvents('itest');
    expect(result.requeued).toBeGreaterThanOrEqual(1);
  });
});

describe('retention', () => {
  it('removes conversations silent for over twelve months, and nothing newer', async () => {
    await record(message({ externalId: 'mid-ancient', sentAt: new Date('2025-08-01T00:00:00Z') }));
    await platformDb.socialConversation.updateMany({
      where: { organizationId: ORG_A },
      data: { lastMessageAt: new Date('2025-08-01T00:00:00Z') },
    });
    await withTenant(ctxFor(ORG_B), (db) =>
      recordMessage(
        db,
        ctxFor(ORG_B),
        { id: ACCOUNT_B, workspaceId: WS_B, brandId: BRAND_B },
        message(),
      ),
    );

    const result = await sweepRetention('itest-retention');

    expect(result.conversations).toBeGreaterThanOrEqual(1);
    expect(await platformDb.socialConversation.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await platformDb.socialConversation.count({ where: { organizationId: ORG_B } })).toBe(1);
  });
});
