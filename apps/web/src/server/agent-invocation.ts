import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentDelegation } from '@orbit/core';

/**
 * Who an agent tool call is acting for (**D-109**).
 *
 * An agent tool does not reimplement any API: it calls the very route handler
 * the browser calls, in process, so authentication is the only step that
 * differs. A browser proves who it is with the session cookie; an agent call
 * has no cookie, and instead runs inside this context, which the MCP route sets
 * after verifying a bearer token against a stored grant, and the Copilot route
 * sets from the signed-in user's own session.
 *
 * `withAuth` reads it in place of the cookie and then runs every other step
 * unchanged — tenant resolution with the membership cross-check, the Client
 * refusal, the permission and resource check — with the delegation attached to
 * the principal, so `@orbit/rbac` narrows to the agent's scopes.
 *
 * Nothing outside `features/agent` may call `runAsAgent`: the context is an
 * already-authenticated identity, and an HTTP request can never enter one.
 * `AsyncLocalStorage` keeps it to the async call tree of the tool call that
 * set it, so it cannot leak into another request.
 */
export interface AgentInvocation {
  userId: string;
  /** The organization the grant or Copilot thread is bound to. */
  organizationId: string;
  delegation: AgentDelegation;
}

const storage = new AsyncLocalStorage<AgentInvocation>();

export function runAsAgent<T>(invocation: AgentInvocation, run: () => Promise<T>): Promise<T> {
  return storage.run(Object.freeze({ ...invocation }), run);
}

export function currentAgentInvocation(): AgentInvocation | undefined {
  return storage.getStore();
}
