import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_SCOPES } from '@orbit/core';
import { AGENT_CONFIRMATION_REQUIRED, AGENT_SCOPE_PERMISSIONS } from '@orbit/rbac';
import { AGENT_TOOLS } from './tools';
import { toJsonSchema } from './json-schema';

/**
 * The tool catalogue's invariants (D-109). These are what keep "the agent can
 * only do what its user confirmed" true as tools are added.
 */

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('agent tool catalogue', () => {
  it('has unique, MCP-valid names', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
  });

  it('runs reads, AI and internal writes directly, and only prepares outward ones', () => {
    for (const tool of AGENT_TOOLS) {
      if (tool.tier === 'W2') {
        expect(tool.prepare, tool.name).toBeTypeOf('function');
        expect(tool.run, tool.name).toBeUndefined();
      } else {
        expect(tool.run, tool.name).toBeTypeOf('function');
        expect(tool.prepare, tool.name).toBeUndefined();
      }
    }
  });

  it('lists a tool only under a scope that covers the permission its route checks', () => {
    for (const tool of AGENT_TOOLS) {
      expect(AGENT_SCOPES).toContain(tool.scope);
      if (tool.permission) {
        expect(AGENT_SCOPE_PERMISSIONS[tool.scope], tool.name).toContain(tool.permission);
      }
    }
  });

  it('marks every tool that needs a confirmed permission as outward', () => {
    const guardedAtSend = ['message:reply', 'comment:reply'];
    for (const tool of AGENT_TOOLS) {
      if (tool.permission && AGENT_CONFIRMATION_REQUIRED.includes(tool.permission)) {
        expect(tool.tier, tool.name).toBe('W2');
      }
      if (tool.tier === 'W2') {
        expect(
          AGENT_CONFIRMATION_REQUIRED.includes(tool.permission!) ||
            guardedAtSend.includes(tool.permission!),
          tool.name,
        ).toBe(true);
      }
    }
  });

  it('fences every tool that returns what customers or commenters wrote', () => {
    const external = [
      'list_conversations',
      'get_conversation',
      'suggest_message_reply',
      'suggest_comment_reply',
      'research_topic',
      'list_comments',
    ];
    for (const name of external) {
      expect(AGENT_TOOLS.find((t) => t.name === name)?.untrustedOutput, name).toBe(true);
    }
  });

  it('describes every input as a JSON object schema', () => {
    for (const tool of AGENT_TOOLS) {
      const schema = toJsonSchema(tool.input);
      expect(schema.type, tool.name).toBe('object');
    }
  });

  it('never lets an agent reach the routes that confirm, reject or grant', () => {
    const routes = source('./routes.ts');
    for (const forbidden of [
      '/confirm/',
      '/reject/',
      'agent-grants',
      'oauth',
      'social-accounts/oauth',
      'members',
      'invitations',
      'transfer-ownership',
      'assistant/route',
    ]) {
      expect(routes, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the confirmation guard where replies are actually sent', () => {
    expect(source('../messaging/service.ts')).toMatch(
      /export async function replyToConversation[\s\S]{0,400}assertAgentConfirmed\(ctx, 'message:reply'\)/,
    );
    expect(source('../community/service.ts')).toMatch(
      /export async function replyToComment[\s\S]{0,400}assertAgentConfirmed\(ctx, 'comment:reply'\)/,
    );
  });

  it('has the agent invocation replace only the cookie in withAuth', () => {
    const withAuth = source('../../server/with-auth.ts');
    expect(withAuth).toContain('currentAgentInvocation()');
    // The organization from the URL is checked against the grant's.
    expect(withAuth).toContain('ctx.organizationId !== agent.organizationId');
    for (const wrapper of [
      '../../server/with-portal-auth.ts',
      '../../server/with-platform-admin.ts',
    ]) {
      expect(source(wrapper), wrapper).toContain('assertNoAgent(route)');
    }
  });
});
