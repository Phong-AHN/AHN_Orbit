import type { z } from 'zod';
import type { AgentScope } from '@orbit/core';
import type { Permission } from '@orbit/rbac';
import type { RouteCall } from './dispatch';
import type { ROUTES } from './routes';

/**
 * An agent tool (D-109, docs/AGENT-MCP-PLAN.md §3–4).
 *
 * The tier is the *intended* risk; the policy engine enforces the real one.
 * A tool labelled R that tried to publish would still be refused by
 * `@orbit/rbac`, because publishing is outside every scope a read-only grant
 * carries and needs a confirmation besides.
 */
export type ToolTier =
  /** Reads. */
  | 'R'
  /** Generates text with the model; spends a credit; writes nothing outward. */
  | 'AI'
  /** Writes something only the agency sees, and can be undone. */
  | 'W1'
  /** Acts outside the agency — prepared here, executed only once confirmed. */
  | 'W2';

export interface AgentTool<Input = unknown> {
  name: string;
  /** A short human title, for clients that list tools to people. */
  title: string;
  /** Written for the model: what it does, when to use it, what it returns. */
  description: string;
  tier: ToolTier;
  /** The scope a grant needs for the tool to be listed at all. */
  scope: AgentScope;
  /** The permission the backing route checks. Documentation, and tested against the scope map. */
  permission: Permission | null;
  input: z.ZodType<Input>;
  /**
   * Whether the result carries text written by people outside the agency —
   * customers, commenters, web pages. Such a result is fenced as data before
   * the model sees it (§10.1).
   */
  untrustedOutput?: boolean;
  /** R, AI and W1 tools run directly. */
  run?: (input: Input, call: RouteCall) => Promise<unknown>;
  /** W2 tools only describe the action; it runs after the user confirms it. */
  prepare?: (input: Input, call: RouteCall) => Promise<PreparedAction>;
}

/**
 * An outward action, fully specified, waiting for the user (§5).
 *
 * `summary` is written by the server from what will actually be sent, so the
 * person confirming reads exactly what will happen — the model never writes it.
 */
export interface PreparedAction {
  summary: string;
  request: ActionRequest;
}

/** A call to one tenant API route, recorded so it can be replayed exactly once. */
export interface ActionRequest {
  route: RouteKey;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  params: Record<string, string>;
  body?: unknown;
}

export type RouteKey = keyof typeof ROUTES;
