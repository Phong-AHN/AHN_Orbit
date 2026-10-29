import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  fixedClock,
  setClock,
  type TenantContext,
} from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection } from '@orbit/queue';
import { CredentialCipher, registerProvider, resetRegistry } from '@orbit/providers';
import { FacebookProvider } from '@orbit/providers/facebook';
import { ensureProvidersRegistered } from '@/server/providers';
import { disconnectAccount } from '../social/service';
import {
  getConversation,
  listConversations,
  replyToConversation,
  setConversationHandled,
} from './service';

/**
 * Replying to private messages, against real Postgres and the real grant
 * matrix (D-107).
 *
 * The rules worth proving end to end:
 *
 * 1. **The window is enforced before anything is sent** — a closed
 *    conversation is refused without the platform being called at all.
 * 2. **A reply is recorded only once the platform returned an id**, and marks
 *    the conversation handled in the same transaction.
 * 3. **An Approver reads and cannot answer**, a Client sees nothing, and a
 *    conversation in another tenant is not found even by exact id.
 * 4. **Disconnecting deletes the conversations**, messages and all.
 */

const ORG = '018ff5c0-0000-7000-8000-0000f5c00001';
const ORG_B = '018ff5c0-0000-7000-8000-0000f5c000b1';
const WS = '018ff5c0-0000-7000-8000-0000f5c00002';
const WS_B = '018ff5c0-0000-7000-8000-0000f5c000b2';
const BRAND = '018ff5c0-0000-7000-8000-0000f5c00003';
const BRAND_B = '018ff5c0-0000-7000-8000-0000f5c000b3';
const ACCOUNT = '018ff5c0-0000-7000-8000-0000f5c00004';
const ACCOUNT_B = '018ff5c0-0000-7000-8000-0000f5c000b4';
const OWNER = '018ff5c0-0000-7000-8000-0000f5c00010';
const APPROVER = '018ff5c0-0000-7000-8000-0000f5c00011';
const CLIENT = '018ff5c0-0000-7000-8000-0000f5c00012';
const OWNER_B = '018ff5c0-0000-7000-8000-0000f5c000c0';

const NOW = new Date('2026-10-23T09:00:00.000Z');
const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let restoreClock: (() => void) | undefined;
let owner: TenantContext;
let approver: TenantContext;
let client: TenantContext;
let ownerB: TenantContext;

/** Every Send API call the adapter makes. */
const sent: Array<{ url: string; body: string }> = [];

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  return (await resolveTenantContext(user, orgId)).ctx;
}

async function seedTenant(org: string, ws: string, brand: string, account: string, slug: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
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
    where: { id: account },
    update: { status: 'ACTIVE', deletedAt: null },
    create: {
      id: account,
      organizationId: org,
      workspaceId: ws,
      brandId: brand,
      platform: 'FACEBOOK',
      externalId: `page-${slug}`,
      displayName: `Page ${slug}`,
      accountType: 'PAGE',
      status: 'ACTIVE',
      scopes: ['pages_messaging', 'pages_manage_metadata'],
    },
  });
  const sealed = new CredentialCipher().seal('page-token', {
    organizationId: org,
    socialAccountId: account,
  });
  await platformDb.socialCredential.upsert({
    where: { socialAccountId: account },
    update: {},
    create: {
      organizationId: org,
      socialAccountId: account,
      accessTokenCiphertext: new Uint8Array(sealed.ciphertext),
      accessTokenIv: new Uint8Array(sealed.iv),
      accessTokenAuthTag: new Uint8Array(sealed.authTag),
      keyVersion: sealed.keyVersion,
      scopes: ['pages_messaging', 'pages_manage_metadata'],
    },
  });
}

async function seedMember(
  org: string,
  ws: string,
  userId: string,
  email: string,
  role: 'OWNER' | 'APPROVER' | 'CLIENT',
  workspaceRole: 'MANAGER' | 'APPROVER' | 'CLIENT_APPROVER',
  brand?: string,
) {
  await platformDb.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, firebaseUid: `dev:${email}`, email },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId } },
    update: { role, status: 'ACTIVE' },
    create: { organizationId: org, userId, role, status: 'ACTIVE' },
  });
  await platformDb.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId: ws, userId } },
    update: { role: workspaceRole },
    create: { organizationId: org, workspaceId: ws, userId, role: workspaceRole },
  });
  if (brand) {
    await platformDb.brandAssignment.upsert({
      where: { brandId_userId: { brandId: brand, userId } },
      update: {},
      create: { organizationId: org, brandId: brand, userId, canApprove: true },
    });
  }
}

/** A conversation whose person last wrote `hoursAgo` hours ago. */
async function seedConversation(
  hoursAgo: number,
  org = ORG,
  ws = WS,
  brand = BRAND,
  account = ACCOUNT,
) {
  const lastInboundAt = new Date(NOW.getTime() - hoursAgo * 3_600_000);
  const conversation = await platformDb.socialConversation.create({
    data: {
      organizationId: org,
      workspaceId: ws,
      brandId: brand,
      socialAccountId: account,
      participantExternalId: `psid-${hoursAgo}-${Math.random().toString(36).slice(2, 8)}`,
      participantName: 'Lan',
      lastMessageAt: lastInboundAt,
      lastInboundAt,
    },
  });
  await platformDb.socialMessage.create({
    data: {
      organizationId: org,
      conversationId: conversation.id,
      socialAccountId: account,
      externalId: `mid-${conversation.id}`,
      direction: 'INBOUND',
      text: 'Còn hàng không ạ?',
      sentAt: lastInboundAt,
    },
  });
  return conversation.id;
}

beforeAll(async () => {
  restoreClock = setClock(fixedClock(NOW));

  // Spend the services' own bootstrap first: they now register the adapters
  // themselves on first use, which would otherwise replace the ones below.
  ensureProvidersRegistered();
  resetRegistry();
  registerProvider(
    new FacebookProvider({
      appId: 'app',
      appSecret: 'secret',
      apiVersion: 'v25.0',
      baseUrl: 'https://graph.test',
      fetchImpl: async (url, init) => {
        sent.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
        return new Response(JSON.stringify({ message_id: `m-${sent.length}` }), { status: 200 });
      },
      messaging: { enabled: true },
    }),
  );

  await seedTenant(ORG, WS, BRAND, ACCOUNT, 'msg-a');
  await seedTenant(ORG_B, WS_B, BRAND_B, ACCOUNT_B, 'msg-b');
  await seedMember(ORG, WS, OWNER, 'owner@msg.test', 'OWNER', 'MANAGER');
  await seedMember(ORG, WS, APPROVER, 'approver@msg.test', 'APPROVER', 'APPROVER', BRAND);
  await seedMember(ORG, WS, CLIENT, 'client@msg.test', 'CLIENT', 'CLIENT_APPROVER');
  await seedMember(ORG_B, WS_B, OWNER_B, 'ownerb@msg.test', 'OWNER', 'MANAGER');

  owner = await contextFor('owner@msg.test', ORG);
  approver = await contextFor('approver@msg.test', ORG);
  client = await contextFor('client@msg.test', ORG);
  ownerB = await contextFor('ownerb@msg.test', ORG_B);
});

beforeEach(async () => {
  sent.length = 0;
  await platformDb.socialConversation.deleteMany({
    where: { organizationId: { in: [ORG, ORG_B] } },
  });
  await platformDb.socialAccount.updateMany({
    where: { id: { in: [ACCOUNT, ACCOUNT_B] } },
    data: { status: 'ACTIVE', deletedAt: null },
  });
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [OWNER, APPROVER, CLIENT, OWNER_B] } } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

describe('replying', () => {
  it('sends inside the window, records the reply and marks the conversation handled', async () => {
    const id = await seedConversation(2);

    const message = await replyToConversation(owner, id, { text: 'Dạ còn ạ' }, fingerprint);

    expect(sent).toHaveLength(1);
    expect(new URLSearchParams(sent[0]!.body).get('messaging_type')).toBe('RESPONSE');
    expect(message).toMatchObject({ direction: 'OUTBOUND', text: 'Dạ còn ạ' });

    const conversation = await platformDb.socialConversation.findUniqueOrThrow({ where: { id } });
    expect(conversation.state).toBe('HANDLED');
    const stored = await platformDb.socialMessage.findFirstOrThrow({
      where: { conversationId: id, direction: 'OUTBOUND' },
    });
    // The platform's id, so the echo webhook recognises it.
    expect(stored.externalId).toBe('m-1');
    expect(stored.createdById).toBe(OWNER);
  });

  /** Refused before the platform is asked: nobody learns at Send that it was too late. */
  it('refuses a closed window without calling the platform', async () => {
    const id = await seedConversation(30);

    await expect(
      replyToConversation(owner, id, { text: 'Muộn rồi' }, fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(sent).toHaveLength(0);
  });

  it('says the window has closed in the conversation view', async () => {
    const id = await seedConversation(30);
    expect((await getConversation(owner, id)).window.state).toBe('CLOSED');
  });

  it('asks a connection without the messaging scopes to be reconnected', async () => {
    const id = await seedConversation(1);
    await platformDb.socialAccount.update({ where: { id: ACCOUNT }, data: { scopes: [] } });

    try {
      expect((await getConversation(owner, id)).needsReconnect).toBe(true);
      await expect(
        replyToConversation(owner, id, { text: 'x' }, fingerprint),
      ).rejects.toMatchObject({ userMessage: expect.stringContaining('reconnected') });
      expect(sent).toHaveLength(0);
    } finally {
      await platformDb.socialAccount.update({
        where: { id: ACCOUNT },
        data: { scopes: ['pages_messaging', 'pages_manage_metadata'] },
      });
    }
  });
});

describe('who may do what', () => {
  it('lets an Approver read the inbox and refuses them a reply', async () => {
    const id = await seedConversation(1);

    expect((await listConversations(approver)).map((c) => c.id)).toContain(id);
    await expect(
      replyToConversation(approver, id, { text: 'x' }, fingerprint),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setConversationHandled(approver, id, true, fingerprint)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(sent).toHaveLength(0);
  });

  /** Private messages never reach the portal. */
  it('shows a Client nothing', async () => {
    await seedConversation(1);
    await expect(listConversations(client)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('hides another tenant’s conversation even by exact id', async () => {
    const theirs = await seedConversation(1, ORG_B, WS_B, BRAND_B, ACCOUNT_B);

    await expect(getConversation(owner, theirs)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      replyToConversation(owner, theirs, { text: 'x' }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await listConversations(owner)).map((c) => c.id)).not.toContain(theirs);
    expect(sent).toHaveLength(0);
    // Their own owner still sees it.
    expect((await listConversations(ownerB)).map((c) => c.id)).toContain(theirs);
  });
});

describe('disconnecting', () => {
  it('deletes the account’s conversations and their messages', async () => {
    const id = await seedConversation(1);

    await disconnectAccount(owner, ACCOUNT, fingerprint);

    expect(await platformDb.socialConversation.count({ where: { id } })).toBe(0);
    expect(await platformDb.socialMessage.count({ where: { conversationId: id } })).toBe(0);
  });
});
