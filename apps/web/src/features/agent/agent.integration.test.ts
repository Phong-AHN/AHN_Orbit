import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SCOPES, ConflictError, NotFoundError, type TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { runAsAgent, type AgentInvocation } from '@/server/agent-invocation';
import { createPost } from '@/features/posts/service';
import { createPostSchema } from '@/features/posts/contracts';
import { confirmAction, listMyActions, rejectAction } from './actions';
import { routeCall, type AgentToolError } from './dispatch';
import { runTool } from './registry';

/**
 * AI agents against the real database and the real route handlers (D-109).
 *
 * What these prove is the user's requirement in so many words: a person cannot
 * use the chatbot to do more than they could do themselves. The agent is
 * denied the other tenant even with its exact ids, denied whatever its scopes
 * leave out, cannot perform an outward action until its person confirms it in
 * their own session — and that confirmation runs once.
 */

const ORG_A = '018f2000-0000-7000-8000-002000000001';
const ORG_B = '018f2100-0000-7000-8000-002100000001';
const WS_A = '018f2000-0000-7000-8000-002000000002';
const WS_B = '018f2100-0000-7000-8000-002100000002';
const BRAND_A = '018f2000-0000-7000-8000-002000000003';
const BRAND_B = '018f2100-0000-7000-8000-002100000003';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };
const origin = 'http://localhost:3000';

let ctxA: TenantContext;
let ctxB: TenantContext;
let userA: string;
let grantA: string;

async function seed(org: string, ws: string, brand: string, slug: string, email: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, organizationId: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: brand },
    update: {},
    create: { id: brand, organizationId: org, workspaceId: ws, name: slug, slug },
  });
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId: user.id } },
    update: {},
    create: { organizationId: org, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const { ctx } = await resolveTenantContext(user, org, 'itest-agent');
  return { ctx, userId: user.id };
}

const invocationFor = (
  userId: string,
  organizationId: string,
  scopes: AgentInvocation['delegation']['scopes'] = AGENT_SCOPES,
): AgentInvocation => ({
  userId,
  organizationId,
  delegation: { channel: 'MCP', grantId: grantA, scopes },
});

const run = (name: string, args: unknown, invocation: AgentInvocation) =>
  runTool(name, args, { invocation, origin, organizationSlug: 'agent-a' });

const draft = (ctx: TenantContext, ws: string, brand: string) =>
  createPost(
    ctx,
    createPostSchema.parse({ workspaceId: ws, brandId: brand, body: 'Hello from the test' }),
    fingerprint,
  );

beforeAll(async () => {
  ({ ctx: ctxA, userId: userA } = await seed(
    ORG_A,
    WS_A,
    BRAND_A,
    'agent-a',
    'owner@agent-a.test',
  ));
  ({ ctx: ctxB } = await seed(ORG_B, WS_B, BRAND_B, 'agent-b', 'owner@agent-b.test'));
  const client = await platformDb.agentClient.create({
    data: {
      clientId: `ssc_itest_${Date.now()}`,
      name: 'Test client',
      redirectUris: ['https://client.test/cb'],
    },
  });
  const grant = await platformDb.agentGrant.create({
    data: { organizationId: ORG_A, userId: userA, clientId: client.id, scopes: [...AGENT_SCOPES] },
  });
  grantA = grant.id;
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.agentClient.deleteMany({ where: { name: 'Test client' } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '.test' } } });
});

beforeEach(async () => {
  await platformDb.agentAction.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.agentGrant.updateMany({ where: { id: grantA }, data: { revokedAt: null } });
  await platformDb.post.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

describe('agent tools through the real routes', () => {
  it('reads its own tenant', async () => {
    const post = await draft(ctxA, WS_A, BRAND_A);
    const outcome = await run('get_post', { postId: post.id }, invocationFor(userA, ORG_A));
    expect(outcome.kind).toBe('result');
  });

  it('is denied the other tenant even with its exact ids', async () => {
    const theirs = await draft(ctxB, WS_B, BRAND_B);
    const outcome = await run('get_post', { postId: theirs.id }, invocationFor(userA, ORG_A));
    expect(outcome).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });

    const create = await run(
      'create_post_draft',
      { workspaceId: WS_B, brandId: BRAND_B, body: 'into B' },
      invocationFor(userA, ORG_A),
    );
    expect(create.kind).toBe('error');
    expect(await platformDb.post.count({ where: { organizationId: ORG_B } })).toBe(1);
  });

  it('is denied an organization its person does not belong to, whatever the grant says', async () => {
    const theirs = await draft(ctxB, WS_B, BRAND_B);
    // A forged invocation: person A, organization B.
    const outcome = await run('get_post', { postId: theirs.id }, invocationFor(userA, ORG_B));
    expect(outcome).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
  });

  it('cannot use a tool its scopes leave out', async () => {
    const outcome = await run(
      'create_post_draft',
      { workspaceId: WS_A, brandId: BRAND_A, body: 'x' },
      invocationFor(userA, ORG_A, ['read']),
    );
    expect(outcome).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
    expect(await platformDb.post.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('is refused by the route itself when it calls an outward action unconfirmed', async () => {
    const post = await draft(ctxA, WS_A, BRAND_A);
    const call = routeCall({
      organizationId: ORG_A,
      correlationId: 'itest',
      userAgent: 'vitest',
      origin,
    });
    await expect(
      runAsAgent(invocationFor(userA, ORG_A), () =>
        call.send('postPublishNow', 'POST', { postId: post.id }),
      ),
    ).rejects.toMatchObject({ status: 403 } satisfies Partial<AgentToolError>);
  });

  it('cannot reach the person-only routes even by naming them', async () => {
    const outcome = await run('confirm_action', { actionId: grantA }, invocationFor(userA, ORG_A));
    expect(outcome).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
  });
});

describe('agent actions', () => {
  it('prepares, and runs exactly once when its person confirms', async () => {
    const post = await draft(ctxA, WS_A, BRAND_A);
    const prepared = await run('publish_now', { postId: post.id }, invocationFor(userA, ORG_A));
    expect(prepared.kind).toBe('confirmation');
    if (prepared.kind !== 'confirmation') return;

    // Nothing happened yet.
    expect((await platformDb.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe(
      'DRAFT',
    );

    // A DRAFT cannot be published, so the confirmed call reaches the route and
    // is refused by the state machine — the action records that, once.
    const first = await confirmAction(ctxA, prepared.action.id, { origin });
    expect(first.status).toBe('FAILED');
    await expect(confirmAction(ctxA, prepared.action.id, { origin })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('cannot be confirmed by someone else, nor by the agent', async () => {
    const post = await draft(ctxA, WS_A, BRAND_A);
    const prepared = await run('publish_now', { postId: post.id }, invocationFor(userA, ORG_A));
    if (prepared.kind !== 'confirmation') throw new Error('expected a confirmation');

    await expect(confirmAction(ctxB, prepared.action.id, { origin })).rejects.toBeInstanceOf(
      ConflictError,
    );

    const asAgent: TenantContext = {
      ...ctxA,
      principal: {
        ...(ctxA.principal as Extract<TenantContext['principal'], { kind: 'USER' }>),
        delegation: invocationFor(userA, ORG_A).delegation,
      },
    };
    await expect(confirmAction(asAgent, prepared.action.id, { origin })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(listMyActions(asAgent)).rejects.toBeInstanceOf(NotFoundError);

    await rejectAction(ctxA, prepared.action.id);
    await expect(confirmAction(ctxA, prepared.action.id, { origin })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('does not run when the AI app was revoked after preparing it', async () => {
    const post = await draft(ctxA, WS_A, BRAND_A);
    const prepared = await run('publish_now', { postId: post.id }, invocationFor(userA, ORG_A));
    if (prepared.kind !== 'confirmation') throw new Error('expected a confirmation');

    await platformDb.agentGrant.update({ where: { id: grantA }, data: { revokedAt: new Date() } });
    await expect(confirmAction(ctxA, prepared.action.id, { origin })).rejects.toBeInstanceOf(
      ConflictError,
    );
    const row = await platformDb.agentAction.findUniqueOrThrow({
      where: { id: prepared.action.id },
    });
    expect(row.status).toBe('FAILED');
  });

  it('records an agent change as one in the audit log', async () => {
    const outcome = await run(
      'create_post_draft',
      { workspaceId: WS_A, brandId: BRAND_A, body: 'drafted by an agent' },
      invocationFor(userA, ORG_A),
    );
    expect(outcome.kind).toBe('result');
    const entry = await platformDb.auditLog.findFirst({
      where: { organizationId: ORG_A, actorUserId: userA },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry?.reason).toContain('via AI agent (MCP)');
  });
});
