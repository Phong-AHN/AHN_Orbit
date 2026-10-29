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
import { MAX_KNOWLEDGE_CHARS } from '@orbit/ai';
import { closeQueues, closeSharedConnection } from '@orbit/queue';
import { CredentialCipher, registerProvider, resetRegistry } from '@orbit/providers';
import { FacebookProvider } from '@orbit/providers/facebook';
import { resetAIProvider } from '@/server/ai-provider';
import { ensureProvidersRegistered } from '@/server/providers';
import { replyToConversation } from '../messaging/service';
import {
  createKnowledgeEntry,
  getAssistant,
  suggestReply,
  updateAssistantSettings,
} from './service';

/**
 * The AI assistant's settings and suggestions, against real Postgres and the
 * real grant matrix (D-108).
 *
 * What these prove end to end:
 *
 * 1. **AUTO is an owner's decision, after a week of suggestions.** An Account
 *    Manager manages the knowledge and may switch suggestions on, and cannot
 *    let the assistant answer alone; an owner cannot either until seven days
 *    have passed.
 * 2. **A suggestion sends nothing.** It is returned and recorded; the platform
 *    is never called.
 * 3. **The knowledge budget is enforced at save time.**
 * 4. **An Approver cannot manage the assistant, and another tenant's brand is
 *    not found** even by exact id.
 * 5. **A person replying clears a hand-over.**
 */

const ORG = '018ffa91-0000-7000-8000-0000fa900001';
const ORG_B = '018ffa91-0000-7000-8000-0000fa9000b1';
const WS = '018ffa91-0000-7000-8000-0000fa900002';
const WS_B = '018ffa91-0000-7000-8000-0000fa9000b2';
const BRAND = '018ffa91-0000-7000-8000-0000fa900003';
const BRAND_B = '018ffa91-0000-7000-8000-0000fa9000b3';
const ACCOUNT = '018ffa91-0000-7000-8000-0000fa900004';
const OWNER = '018ffa91-0000-7000-8000-0000fa900010';
const MANAGER = '018ffa91-0000-7000-8000-0000fa900011';
const APPROVER = '018ffa91-0000-7000-8000-0000fa900012';
const OWNER_B = '018ffa91-0000-7000-8000-0000fa9000c0';

const NOW = new Date('2026-10-26T09:00:00.000Z');
const WEEK_LATER = new Date('2026-11-02T09:00:01.000Z');
const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let restoreClock: (() => void) | undefined;
let owner: TenantContext;
let manager: TenantContext;
let approver: TenantContext;
let ownerB: TenantContext;

const sent: string[] = [];

const settings = (mode: 'OFF' | 'SUGGEST' | 'AUTO') => ({
  mode,
  staffedHours: [{ day: 1, start: '08:00', end: '17:30' }],
  graceMinutes: 10,
  maxRepliesPerConversation: 3,
  escalationTerms: ['bảo hành'],
});

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  return (await resolveTenantContext(user, orgId)).ctx;
}

async function seedTenant(org: string, ws: string, brand: string, slug: string) {
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
    create: { id: brand, organizationId: org, workspaceId: ws, name: 'Shop', slug: 'shop' },
  });
}

async function seedMember(
  org: string,
  ws: string,
  userId: string,
  email: string,
  role: 'OWNER' | 'ACCOUNT_MANAGER' | 'APPROVER',
  workspaceRole: 'MANAGER' | 'APPROVER',
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
}

async function seedConversation(text: string) {
  const sentAt = new Date(NOW.getTime() - 60_000);
  const conversation = await platformDb.socialConversation.create({
    data: {
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      socialAccountId: ACCOUNT,
      participantExternalId: `psid-${Math.random().toString(36).slice(2, 8)}`,
      lastMessageAt: sentAt,
      lastInboundAt: sentAt,
    },
  });
  await platformDb.socialMessage.create({
    data: {
      organizationId: ORG,
      conversationId: conversation.id,
      socialAccountId: ACCOUNT,
      externalId: `mid-${conversation.id}`,
      direction: 'INBOUND',
      text,
      sentAt,
    },
  });
  return conversation.id;
}

beforeAll(async () => {
  restoreClock = setClock(fixedClock(NOW));
  resetAIProvider();

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
      fetchImpl: async (_url, init) => {
        sent.push(typeof init?.body === 'string' ? init.body : '');
        return new Response(JSON.stringify({ message_id: `m-${sent.length}` }), { status: 200 });
      },
      messaging: { enabled: true },
    }),
  );

  await seedTenant(ORG, WS, BRAND, 'ast-a');
  await seedTenant(ORG_B, WS_B, BRAND_B, 'ast-b');

  await platformDb.socialAccount.upsert({
    where: { id: ACCOUNT },
    update: { status: 'ACTIVE', deletedAt: null },
    create: {
      id: ACCOUNT,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      platform: 'FACEBOOK',
      externalId: 'page-ast-a',
      displayName: 'Shop',
      accountType: 'PAGE',
      status: 'ACTIVE',
      scopes: ['pages_messaging', 'pages_manage_metadata'],
    },
  });
  const sealed = new CredentialCipher().seal('page-token', {
    organizationId: ORG,
    socialAccountId: ACCOUNT,
  });
  await platformDb.socialCredential.upsert({
    where: { socialAccountId: ACCOUNT },
    update: {},
    create: {
      organizationId: ORG,
      socialAccountId: ACCOUNT,
      accessTokenCiphertext: new Uint8Array(sealed.ciphertext),
      accessTokenIv: new Uint8Array(sealed.iv),
      accessTokenAuthTag: new Uint8Array(sealed.authTag),
      keyVersion: sealed.keyVersion,
      scopes: ['pages_messaging', 'pages_manage_metadata'],
    },
  });

  await seedMember(ORG, WS, OWNER, 'owner@ast.test', 'OWNER', 'MANAGER');
  await seedMember(ORG, WS, MANAGER, 'manager@ast.test', 'ACCOUNT_MANAGER', 'MANAGER');
  await seedMember(ORG, WS, APPROVER, 'approver@ast.test', 'APPROVER', 'APPROVER');
  await seedMember(ORG_B, WS_B, OWNER_B, 'ownerb@ast.test', 'OWNER', 'MANAGER');

  owner = await contextFor('owner@ast.test', ORG);
  manager = await contextFor('manager@ast.test', ORG);
  approver = await contextFor('approver@ast.test', ORG);
  ownerB = await contextFor('ownerb@ast.test', ORG_B);
});

beforeEach(async () => {
  sent.length = 0;
  restoreClock?.();
  restoreClock = setClock(fixedClock(NOW));
  await platformDb.socialConversation.deleteMany({ where: { organizationId: ORG } });
  await platformDb.brandAssistant.deleteMany({ where: { organizationId: ORG } });
  await platformDb.brandKnowledgeEntry.deleteMany({ where: { organizationId: ORG } });
  await platformDb.aIUsage.deleteMany({ where: { organizationId: ORG } });
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [OWNER, MANAGER, APPROVER, OWNER_B] } } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

const faq = {
  kind: 'FAQ' as const,
  title: 'Phí giao hàng',
  question: 'Phí ship bao nhiêu?',
  content: 'Phí giao hàng nội thành là 30.000đ.',
};

describe('switching the assistant on', () => {
  it('lets an account manager manage knowledge and suggestions, but not AUTO', async () => {
    await createKnowledgeEntry(manager, BRAND, faq, fingerprint);
    await updateAssistantSettings(manager, BRAND, settings('SUGGEST'), fingerprint);

    setClock(fixedClock(WEEK_LATER));
    const overview = await getAssistant(manager, BRAND);
    expect(overview.auto.allowed).toBe(false);
    expect(overview.auto.reasons.join(' ')).toMatch(/owner or admin/);

    await expect(
      updateAssistantSettings(manager, BRAND, settings('AUTO'), fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('makes even an owner wait seven days of suggestions', async () => {
    await createKnowledgeEntry(owner, BRAND, faq, fingerprint);
    await updateAssistantSettings(owner, BRAND, settings('SUGGEST'), fingerprint);

    await expect(
      updateAssistantSettings(owner, BRAND, settings('AUTO'), fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);

    setClock(fixedClock(WEEK_LATER));
    const saved = await updateAssistantSettings(owner, BRAND, settings('AUTO'), fingerprint);
    expect(saved.mode).toBe('AUTO');
  });

  it('refuses AUTO for a brand with nothing to answer from', async () => {
    await updateAssistantSettings(owner, BRAND, settings('SUGGEST'), fingerprint);
    setClock(fixedClock(WEEK_LATER));

    await expect(
      updateAssistantSettings(owner, BRAND, settings('AUTO'), fingerprint),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses knowledge past what fits in the prompt, rather than cutting it', async () => {
    const chunk = 'x'.repeat(9_900);
    for (let i = 0; i < Math.floor(MAX_KNOWLEDGE_CHARS / 9_950); i += 1) {
      await createKnowledgeEntry(
        owner,
        BRAND,
        { kind: 'DOCUMENT', title: `D${i}`, content: chunk },
        fingerprint,
      );
    }

    await expect(
      createKnowledgeEntry(
        owner,
        BRAND,
        { kind: 'DOCUMENT', title: 'one more', content: chunk },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // An internal note never reaches the model, so it does not count.
    await expect(
      createKnowledgeEntry(
        owner,
        BRAND,
        { kind: 'DOCUMENT', title: 'note', content: chunk, usableByAssistant: false },
        fingerprint,
      ),
    ).resolves.toMatchObject({ usableByAssistant: false });
  });
});

describe('who may manage it', () => {
  it('refuses an approver', async () => {
    await expect(getAssistant(approver, BRAND)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createKnowledgeEntry(approver, BRAND, faq, fingerprint)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('does not find another organization’s brand, even by exact id', async () => {
    await expect(getAssistant(ownerB, BRAND)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createKnowledgeEntry(ownerB, BRAND, faq, fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('suggesting a reply', () => {
  it('is refused while the assistant is off', async () => {
    const conversationId = await seedConversation('Phí ship bao nhiêu?');
    await expect(suggestReply(owner, conversationId)).rejects.toBeInstanceOf(ConflictError);
  });

  it('drafts from the documents, records it, and sends nothing', async () => {
    await createKnowledgeEntry(owner, BRAND, faq, fingerprint);
    await updateAssistantSettings(owner, BRAND, settings('SUGGEST'), fingerprint);
    const conversationId = await seedConversation('Phí ship bao nhiêu vậy shop?');

    const suggestion = await suggestReply(owner, conversationId);

    expect(suggestion).toMatchObject({ action: 'REPLY', cited: [{ title: 'Phí giao hàng' }] });
    expect(suggestion.text).toContain('30.000đ');
    // A suggestion goes out as the person who sends it, so no disclosure.
    expect(suggestion.text).not.toContain('AI Assistant');
    expect(sent).toHaveLength(0);

    const decisions = await platformDb.assistantDecision.findMany({ where: { conversationId } });
    expect(decisions).toEqual([expect.objectContaining({ action: 'SUGGESTED' })]);
  });

  it('advises a hand-over for a refund without changing the conversation', async () => {
    await createKnowledgeEntry(owner, BRAND, faq, fingerprint);
    await updateAssistantSettings(owner, BRAND, settings('SUGGEST'), fingerprint);
    const conversationId = await seedConversation('Mình muốn hoàn tiền');

    const suggestion = await suggestReply(owner, conversationId);

    expect(suggestion).toMatchObject({ action: 'ESCALATE', category: 'REFUND_OR_PAYMENT' });
    expect(
      await platformDb.socialConversation.findUniqueOrThrow({ where: { id: conversationId } }),
    ).toMatchObject({ needsHuman: false });
  });
});

describe('a person replying', () => {
  it('clears the hand-over and keeps the assistant out', async () => {
    const conversationId = await seedConversation('Mình muốn hoàn tiền');
    await platformDb.socialConversation.update({
      where: { id: conversationId },
      data: { needsHuman: true, escalationReason: 'refund' },
    });

    await replyToConversation(
      owner,
      conversationId,
      { text: 'Dạ em kiểm tra ngay ạ' },
      fingerprint,
    );

    const after = await platformDb.socialConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(after).toMatchObject({ needsHuman: false, escalationReason: null, state: 'HANDLED' });
    expect(after.lastHumanReplyAt).not.toBeNull();
  });
});
