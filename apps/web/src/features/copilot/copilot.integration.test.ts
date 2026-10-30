import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError, type TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { ScriptedAgentModel } from '@orbit/ai';
import { platformDb } from '@orbit/db';
import { createPost } from '@/features/posts/service';
import { createPostSchema } from '@/features/posts/contracts';
import { getThread, listThreads, sendMessage } from './service';

/**
 * The Copilot loop against the real database and routes (D-109 phase 5), with
 * a scripted model so nothing reaches a network. What it proves: the tools the
 * model asks for run as the person, an outward one only prepares an action,
 * and a thread is its person's alone.
 */

process.env.AGENT_ENABLED_ORGS = '*';

const ORG = '018f2200-0000-7000-8000-002200000001';
const WS = '018f2200-0000-7000-8000-002200000002';
const BRAND = '018f2200-0000-7000-8000-002200000003';
const organization = { id: ORG, name: 'copilot-a', slug: 'copilot-a', timezone: 'UTC' };
const meta = { origin: 'http://localhost:3000' };

let owner: TenantContext;
let colleague: TenantContext;

async function member(email: string, role: 'OWNER' | 'ADMIN') {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: ORG, userId: user.id } },
    update: {},
    create: { organizationId: ORG, userId: user.id, role, status: 'ACTIVE' },
  });
  return (await resolveTenantContext(user, ORG, 'itest-copilot')).ctx;
}

beforeAll(async () => {
  await platformDb.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: 'copilot-a', slug: 'copilot-a', timezone: 'UTC' },
  });
  await platformDb.workspace.upsert({
    where: { id: WS },
    update: {},
    create: { id: WS, organizationId: ORG, name: 'ws', slug: 'ws', timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: BRAND },
    update: {},
    create: { id: BRAND, organizationId: ORG, workspaceId: WS, name: 'b', slug: 'b' },
  });
  owner = await member('owner@copilot-a.test', 'OWNER');
  colleague = await member('admin@copilot-a.test', 'ADMIN');
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: ORG } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '@copilot-a.test' } } });
});

describe('Copilot', () => {
  it('runs tools as the person and only prepares what goes out', async () => {
    const post = await createPost(
      owner,
      createPostSchema.parse({ workspaceId: WS, brandId: BRAND, body: 'Copilot draft' }),
      { ip: '127.0.0.1', userAgent: 'vitest' },
    );
    const model = new ScriptedAgentModel([
      { toolCalls: [{ id: 'c1', name: 'get_post', args: { postId: post.id } }] },
      { toolCalls: [{ id: 'c2', name: 'publish_now', args: { postId: post.id } }] },
      { text: 'Prepared — please confirm below.' },
    ]);

    const result = await sendMessage(
      owner,
      organization,
      { threadId: null, text: 'Publish my draft', user: { name: 'Owner' } },
      meta,
      model,
    );

    const reply = result.messages[1]!;
    expect(reply.role).toBe('assistant');
    if (reply.role !== 'assistant') return;
    expect(reply.steps.map((s) => [s.tool, s.ok])).toEqual([
      ['get_post', true],
      ['publish_now', true],
    ]);
    expect(reply.actions).toHaveLength(1);
    expect(reply.actions[0]!.summary).toContain('Copilot draft');

    // Nothing was published; the action waits for the person.
    expect((await platformDb.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe(
      'DRAFT',
    );
    const action = await platformDb.agentAction.findUniqueOrThrow({
      where: { id: reply.actions[0]!.id },
    });
    expect(action).toMatchObject({ status: 'PENDING', channel: 'COPILOT', grantId: null });

    // The model saw the tool result, fenced or not, on its second step.
    expect(model.seen[1]!.length).toBeGreaterThan(model.seen[0]!.length);

    // One credit for the turn.
    expect(
      await platformDb.aIUsage.count({ where: { organizationId: ORG, operation: 'copilot' } }),
    ).toBe(1);

    // The thread is the owner's alone — not even an Admin of the same organization sees it.
    expect((await listThreads(owner)).map((t) => t.id)).toContain(result.thread.id);
    expect(await listThreads(colleague)).toEqual([]);
    await expect(getThread(colleague, result.thread.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cannot be driven by an agent', async () => {
    const asAgent: TenantContext = {
      ...owner,
      principal: {
        ...(owner.principal as Extract<TenantContext['principal'], { kind: 'USER' }>),
        delegation: { channel: 'MCP', grantId: 'g', scopes: ['read'] },
      },
    };
    await expect(listThreads(asAgent)).rejects.toBeInstanceOf(NotFoundError);
  });
});
