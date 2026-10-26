import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, setClock, type TenantContext } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { AI_DISCLOSURE, MockAIProvider } from '@orbit/ai';
import { closeQueues, closeSharedConnection } from '@orbit/queue';
import { CredentialCipher, registerProvider, resetRegistry } from '@orbit/providers';
import { FacebookProvider } from '@orbit/providers/facebook';
import { runAssistant, setAssistantProviderForTests } from './run.js';

/**
 * The AI assistant answering on its own, against the real database (D-108).
 *
 * The rules are unit-tested in core and @orbit/ai. What these prove is the
 * wiring around them: that a reply is sent once, with the disclosure, and
 * written as the assistant's; that a hand-over marks the conversation, tells
 * the customer once and sends nothing else; that a colleague who answered
 * keeps the conversation; and that another tenant's conversation id finds
 * nothing.
 */

const ORG_A = '018ffa81-0000-7000-8000-0000fa000001';
const ORG_B = '018ffa81-0000-7000-8000-0000fa0000b1';
const WS_A = '018ffa81-0000-7000-8000-0000fa000002';
const BRAND_A = '018ffa81-0000-7000-8000-0000fa000003';
const ACCOUNT_A = '018ffa81-0000-7000-8000-0000fa000004';
const CONVERSATION_A = '018ffa81-0000-7000-8000-0000fa000005';

const PAGE = 'page-assistant-1';
const PERSON = 'psid-assistant-1';
const NOW = new Date('2026-10-26T15:00:00.000Z');

let restoreClock: (() => void) | undefined;

/** Every message the adapter was asked to send, as Meta would receive it. */
const sent: { text: string; messagingType: string | null }[] = [];

function ctxFor(organizationId: string): TenantContext {
  return {
    organizationId,
    principal: {
      kind: 'SYSTEM',
      actorName: 'assistant-worker',
      capabilities: ['social_account:read', 'message:read', 'message:reply_ai'],
    },
    correlationId: 'itest-assistant',
  };
}

async function seed() {
  for (const org of [ORG_A, ORG_B]) {
    await platformDb.organization.upsert({
      where: { id: org },
      update: {},
      create: { id: org, name: org.slice(-4), slug: `ast-${org.slice(-4)}`, timezone: 'UTC' },
    });
  }
  await platformDb.workspace.upsert({
    where: { id: WS_A },
    update: {},
    create: { id: WS_A, organizationId: ORG_A, name: 'ws', slug: 'ws', timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: BRAND_A },
    update: {},
    create: { id: BRAND_A, organizationId: ORG_A, workspaceId: WS_A, name: 'Shop', slug: 'shop' },
  });
  await platformDb.socialAccount.upsert({
    where: { id: ACCOUNT_A },
    update: { status: 'ACTIVE', deletedAt: null },
    create: {
      id: ACCOUNT_A,
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      platform: 'FACEBOOK',
      externalId: PAGE,
      displayName: 'Shop',
      accountType: 'PAGE',
      status: 'ACTIVE',
      scopes: ['pages_messaging', 'pages_manage_metadata'],
    },
  });

  const sealed = new CredentialCipher().seal('page-token', {
    organizationId: ORG_A,
    socialAccountId: ACCOUNT_A,
  });
  await platformDb.socialCredential.upsert({
    where: { socialAccountId: ACCOUNT_A },
    update: {},
    create: {
      organizationId: ORG_A,
      socialAccountId: ACCOUNT_A,
      accessTokenCiphertext: new Uint8Array(sealed.ciphertext),
      accessTokenIv: new Uint8Array(sealed.iv),
      accessTokenAuthTag: new Uint8Array(sealed.authTag),
      keyVersion: sealed.keyVersion,
      scopes: ['pages_messaging', 'pages_manage_metadata'],
    },
  });
}

/** A brand with the assistant on, one document, and a customer who just wrote. */
async function conversationSaying(
  text: string,
  overrides: { mode?: 'OFF' | 'SUGGEST' | 'AUTO'; lastHumanReplyAt?: Date } = {},
) {
  await platformDb.brandAssistant.create({
    data: {
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      mode: overrides.mode ?? 'AUTO',
      // Never staffed, so the assistant answers at once.
      staffedHours: [],
    },
  });
  await platformDb.brandKnowledgeEntry.create({
    data: {
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      kind: 'FAQ',
      title: 'Phí giao hàng',
      question: 'Phí ship bao nhiêu?',
      content: 'Phí giao hàng nội thành là 30.000đ.',
    },
  });
  await platformDb.socialConversation.create({
    data: {
      id: CONVERSATION_A,
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      socialAccountId: ACCOUNT_A,
      participantExternalId: PERSON,
      lastMessageAt: new Date('2026-10-26T14:55:00.000Z'),
      lastInboundAt: new Date('2026-10-26T14:55:00.000Z'),
      state: 'NEW',
      ...(overrides.lastHumanReplyAt ? { lastHumanReplyAt: overrides.lastHumanReplyAt } : {}),
    },
  });
  await platformDb.socialMessage.create({
    data: {
      organizationId: ORG_A,
      conversationId: CONVERSATION_A,
      socialAccountId: ACCOUNT_A,
      externalId: 'mid-in-1',
      direction: 'INBOUND',
      text,
      sentAt: new Date('2026-10-26T14:55:00.000Z'),
    },
  });
}

async function conversation() {
  return platformDb.socialConversation.findFirstOrThrow({
    where: { id: CONVERSATION_A },
    include: { messages: { orderBy: { sentAt: 'asc' } }, decisions: true },
  });
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';
  restoreClock = setClock(fixedClock(NOW));

  resetRegistry();
  let counter = 0;
  registerProvider(
    new FacebookProvider({
      appId: 'app',
      appSecret: 'secret',
      apiVersion: 'v25.0',
      baseUrl: 'https://graph.test',
      fetchImpl: async (_url, init) => {
        const form = new URLSearchParams(String(init?.body ?? ''));
        const message = JSON.parse(form.get('message') ?? '{}') as { text?: string };
        sent.push({ text: message.text ?? '', messagingType: form.get('messaging_type') });
        counter += 1;
        return new Response(
          JSON.stringify({ message_id: `mid-out-${counter}`, recipient_id: PERSON }),
          {
            status: 200,
          },
        );
      },
      messaging: { enabled: true },
    }),
  );
  setAssistantProviderForTests(new MockAIProvider());

  await seed();
});

beforeEach(async () => {
  sent.length = 0;
  await platformDb.socialConversation.deleteMany({ where: { organizationId: ORG_A } });
  await platformDb.brandAssistant.deleteMany({ where: { organizationId: ORG_A } });
  await platformDb.brandKnowledgeEntry.deleteMany({ where: { organizationId: ORG_A } });
  await platformDb.aIUsage.deleteMany({ where: { organizationId: ORG_A } });
  await platformDb.notification.deleteMany({ where: { organizationId: ORG_A } });
});

afterAll(async () => {
  restoreClock?.();
  setAssistantProviderForTests(undefined);
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

const run = (organizationId = ORG_A) =>
  runAssistant({
    ctx: ctxFor(organizationId),
    conversationId: CONVERSATION_A,
    correlationId: 'itest-assistant',
  });

describe('answering on its own', () => {
  it('answers from the documents, says it is automated, and writes it down as its own', async () => {
    await conversationSaying('Phí ship bao nhiêu vậy shop?');

    expect(await run()).toBe('REPLIED');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('30.000đ');
    expect(sent[0]!.text.endsWith(AI_DISCLOSURE)).toBe(true);
    // The standard window only, never the Human Agent tag.
    expect(sent[0]!.messagingType).toBe('RESPONSE');

    const after = await conversation();
    const reply = after.messages.at(-1)!;
    expect(reply).toMatchObject({
      direction: 'OUTBOUND',
      sentByAssistant: true,
      createdById: null,
    });
    expect(after).toMatchObject({ state: 'HANDLED', assistantReplyCount: 1, needsHuman: false });
    // The assistant is not a person: it does not count as one having replied.
    expect(after.lastHumanReplyAt).toBeNull();
    expect(after.decisions).toEqual([
      expect.objectContaining({ action: 'REPLIED', citedEntryIds: [expect.any(String)] }),
    ]);
  });

  it('does nothing twice: the brand has spoken since the customer did', async () => {
    await conversationSaying('Phí ship bao nhiêu vậy shop?');

    await run();
    expect(await run()).toBe('SKIPPED');
    expect(sent).toHaveLength(1);
  });
});

describe('handing over', () => {
  it('hands a refund to the team, tells the customer once, and sends nothing else', async () => {
    await conversationSaying('Mình muốn hoàn tiền đơn hôm qua');

    expect(await run()).toBe('ESCALATED');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Nhân viên');
    expect(sent[0]!.text.endsWith(AI_DISCLOSURE)).toBe(true);

    const after = await conversation();
    expect(after).toMatchObject({ needsHuman: true, state: 'NEW', assistantReplyCount: 0 });
    expect(after.decisions).toEqual([
      expect.objectContaining({ action: 'ESCALATED', category: 'REFUND_OR_PAYMENT' }),
    ]);

    // Handed over: the assistant stays out until a person has dealt with it.
    expect(await run()).toBe('SKIPPED');
    expect(sent).toHaveLength(1);
  });

  it('stops when the customer asks it to, without a holding message', async () => {
    await conversationSaying('dừng');

    expect(await run()).toBe('PAUSED');

    expect(sent).toHaveLength(0);
    expect(await conversation()).toMatchObject({ assistantPaused: true, needsHuman: true });
  });

  it('hands over a question the documents do not answer', async () => {
    await conversationSaying('Shop có bán xe máy không?');

    expect(await run()).toBe('ESCALATED');
    expect((await conversation()).needsHuman).toBe(true);
  });
});

describe('staying out', () => {
  it('leaves a conversation a colleague answered recently', async () => {
    await conversationSaying('Phí ship bao nhiêu vậy shop?', {
      lastHumanReplyAt: new Date('2026-10-26T14:00:00.000Z'),
    });

    expect(await run()).toBe('SKIPPED');
    expect(sent).toHaveLength(0);
  });

  it('does nothing for a brand that has only suggestions on', async () => {
    await conversationSaying('Phí ship bao nhiêu vậy shop?', { mode: 'SUGGEST' });

    expect(await run()).toBe('SKIPPED');
    expect(sent).toHaveLength(0);
  });

  /** The tenant comes from the job's context; another tenant's id finds nothing. */
  it('finds nothing through another organization', async () => {
    await conversationSaying('Phí ship bao nhiêu vậy shop?');

    expect(await run(ORG_B)).toBe('SKIPPED');
    expect(sent).toHaveLength(0);
  });
});
