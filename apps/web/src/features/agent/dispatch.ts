import { NextRequest } from 'next/server';
import { ROUTES, type RouteModule } from './routes';
import type { RouteKey } from './types';

/**
 * Calling a tenant API route from an agent tool, in process (D-109).
 *
 * The request is built here and handed to the route's exported handler, which
 * runs `withAuth` as for any browser. Two things are deliberately absent from
 * the request: a session cookie (the caller is identified by the agent
 * invocation instead) and anything the model chose as a path — the route is a
 * key into `ROUTES`, and path parameters are passed to the handler as values,
 * never spliced into a URL that something could later re-parse.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Safe to show the user; the route's own `userMessage`. */
export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AgentToolError';
  }
}

export interface RouteCallOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

export interface RouteCall {
  get<T = unknown>(
    route: RouteKey,
    params?: Record<string, string>,
    query?: RouteCallOptions['query'],
  ): Promise<T>;
  send<T = unknown>(
    route: RouteKey,
    method: Exclude<Method, 'GET'>,
    params?: Record<string, string>,
    options?: Omit<RouteCallOptions, 'query'>,
  ): Promise<T>;
}

export interface RouteCallContext {
  organizationId: string;
  correlationId: string;
  /** The real caller's address and agent label, for the audit fingerprint. */
  forwardedFor?: string | null;
  userAgent: string;
  origin: string;
}

export function routeCall(context: RouteCallContext): RouteCall {
  const invoke = async <T>(
    route: RouteKey,
    method: Method,
    params: Record<string, string>,
    options: RouteCallOptions,
  ): Promise<T> => {
    const module: RouteModule = await ROUTES[route]();
    const handler = module[method];
    if (!handler) throw new Error(`Route ${route} has no ${method} handler`);

    const url = new URL(`/api/v1/orgs/${context.organizationId}/agent/${route}`, context.origin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({
      'user-agent': context.userAgent,
      'x-correlation-id': context.correlationId,
    });
    if (context.forwardedFor) headers.set('x-forwarded-for', context.forwardedFor);
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    const request = new NextRequest(url, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    // The organization is always the invocation's; whatever a tool passes is
    // overwritten, and `withAuth` checks it against the grant regardless.
    const response = await handler(request, {
      params: Promise.resolve({ ...params, orgSlug: context.organizationId }),
    });

    const text = await response.text();
    const json: unknown = text ? safeJson(text) : null;

    if (!response.ok) {
      const error = (json as { error?: { code?: string; message?: string; retryable?: boolean } })
        ?.error;
      throw new AgentToolError(
        error?.message ?? 'The request failed.',
        error?.code ?? 'INTERNAL_ERROR',
        response.status,
        Boolean(error?.retryable),
      );
    }

    return json as T;
  };

  return {
    get: (route, params = {}, query = {}) => invoke(route, 'GET', params, { query }),
    send: (route, method, params = {}, options = {}) => invoke(route, method, params, options),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
