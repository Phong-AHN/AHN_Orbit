import { ERROR_CODES } from '@orbit/core';

/**
 * The OpenAPI description of the API (SRS §44, T1.19 DoD: "OpenAPI served").
 *
 * Hand-written rather than generated, and worth saying why. Generating it would
 * mean either a schema-first framework (which this is not — decision **D-011**
 * chose route handlers over NestJS) or decorating every route with metadata
 * that duplicates what the zod contract already says. Both cost more than they
 * return at this size.
 *
 * What it is honest about instead: it documents **the shape of the surface** —
 * authentication, the three audiences, the error envelope, and every path with
 * its permission — and it does *not* claim to enumerate every field of every
 * request body. `docs/API.md` remains the prose reference and this is the
 * machine-readable index; the two are checked against each other by a test that
 * asserts the three surfaces and the error envelope are present.
 *
 * The error envelope is generated from `ERROR_CODES`, so a new code appears here
 * without anyone remembering to add it.
 */

const SERVER_DESCRIPTION = 'Same origin as the app. All paths are relative to the deployment host.';

interface PathSpec {
  summary: string;
  permission: string;
  surface: 'agency' | 'portal' | 'admin' | 'public';
}

/**
 * The path inventory, by surface.
 *
 * Grouped this way because the surfaces are the security model (**D-012**,
 * **D-038**, **D-043**): an agency route refuses a Client, a portal route
 * refuses everyone else, and an admin route has no tenant at all. A reader of
 * this document should learn that before they learn any individual endpoint.
 */
const PATHS: Record<string, Partial<Record<'get' | 'post' | 'patch' | 'delete', PathSpec>>> = {
  '/api/health': {
    get: { summary: 'Liveness probe.', permission: 'public', surface: 'public' },
  },
  '/api/health/deep': {
    get: {
      summary: 'Dependency check: database, Redis, storage. Reports config by presence only.',
      permission: 'public',
      surface: 'public',
    },
  },

  // ── Agency surface ────────────────────────────────────────────────────────
  '/api/v1/orgs/{orgSlug}/dashboard': {
    get: { summary: 'What needs attention today.', permission: 'org:read', surface: 'agency' },
  },
  '/api/v1/orgs/{orgSlug}/posts': {
    get: { summary: 'List posts.', permission: 'post:read', surface: 'agency' },
    post: { summary: 'Create a post.', permission: 'post:create', surface: 'agency' },
  },
  '/api/v1/orgs/{orgSlug}/posts/{postId}': {
    get: { summary: 'One post with its variants.', permission: 'post:read', surface: 'agency' },
    patch: { summary: 'Edit content.', permission: 'post:update', surface: 'agency' },
    delete: { summary: 'Soft-delete a post.', permission: 'post:delete', surface: 'agency' },
  },
  '/api/v1/orgs/{orgSlug}/posts/{postId}/transition': {
    post: {
      summary: 'Move a post through the state machine. Status is never writable via PATCH.',
      permission: 'varies by transition (docs/RBAC.md §5)',
      surface: 'agency',
    },
  },
  '/api/v1/orgs/{orgSlug}/posts/{postId}/schedule': {
    post: { summary: 'Schedule a post.', permission: 'post:schedule', surface: 'agency' },
  },
  '/api/v1/orgs/{orgSlug}/approvals/{approvalId}/decide': {
    post: {
      summary: 'Record a review decision. Rides the post state machine (D-017).',
      permission: 'post:approve_internal | post:approve_client',
      surface: 'agency',
    },
  },
  '/api/v1/orgs/{orgSlug}/social-accounts': {
    get: { summary: 'Connected accounts.', permission: 'social_account:read', surface: 'agency' },
    post: {
      summary: 'Confirm which discovered accounts to connect.',
      permission: 'social_account:connect',
      surface: 'agency',
    },
  },
  '/api/v1/orgs/{orgSlug}/social-accounts/{accountId}/health': {
    get: {
      summary: 'Probe the account. Probe-driven, not expiry-driven.',
      permission: 'social_account:read',
      surface: 'agency',
    },
  },
  '/api/v1/orgs/{orgSlug}/social-accounts/{accountId}/reconnect': {
    post: {
      summary: 'Begin reconnecting. Platform and workspace come from the account row.',
      permission: 'social_account:reconnect',
      surface: 'agency',
    },
  },
  '/api/v1/orgs/{orgSlug}/publishing/jobs': {
    get: { summary: 'Publishing log.', permission: 'post:read', surface: 'agency' },
  },
  '/api/v1/orgs/{orgSlug}/publishing/variants/{variantId}/resolve': {
    post: {
      summary: 'Resolve a parked publish. Requires a reason; audited (D-029).',
      permission: 'post:retry_failed',
      surface: 'agency',
    },
  },
  '/api/v1/orgs/{orgSlug}/notifications': {
    get: { summary: 'Your notifications. Identity, not role.', permission: '—', surface: 'agency' },
  },

  // ── Client portal ─────────────────────────────────────────────────────────
  '/api/v1/portal/workspaces': {
    get: { summary: 'Workspaces this client may see.', permission: '—', surface: 'portal' },
  },
  '/api/v1/portal/workspaces/{workspaceId}/approvals': {
    get: { summary: 'Waiting on this client.', permission: 'post:read', surface: 'portal' },
  },
  '/api/v1/portal/posts/{postId}': {
    get: {
      summary: 'One post, client projection only.',
      permission: 'post:read',
      surface: 'portal',
    },
  },
  '/api/v1/portal/posts/{postId}/decide': {
    post: {
      summary: 'Approve or request changes.',
      permission: 'post:approve_client',
      surface: 'portal',
    },
  },

  // ── Platform admin ────────────────────────────────────────────────────────
  '/api/v1/admin/health': {
    get: {
      summary: 'Queues, dead letters, scale.',
      permission: 'admin:view_jobs',
      surface: 'admin',
    },
  },
  '/api/v1/admin/jobs': {
    get: { summary: 'Dead-letter browser.', permission: 'admin:view_jobs', surface: 'admin' },
  },
  '/api/v1/admin/jobs/{jobId}/retry': {
    post: {
      summary: 'Re-enqueue. Requires a reason; audited into the tenant. Refuses publish (D-045).',
      permission: 'admin:retry_job',
      surface: 'admin',
    },
  },
};

const SURFACE_NOTES: Record<PathSpec['surface'], string> = {
  agency:
    'Internal roles only. A CLIENT principal is refused with 404 (D-038). Tenant comes from the URL and is cross-checked against membership.',
  portal:
    'CLIENT principals only; everyone else is refused with 404. The tenant is derived from the workspace or post named in the path, never from the URL (D-012, D-038).',
  admin:
    'Platform administrators only; everyone else is refused with 404. No tenant context exists on this surface, so client content is unreachable rather than merely forbidden (D-043).',
  public: 'No authentication.',
};

export function buildOpenApiDocument(version: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AHN Orbit API',
      version,
      description: [
        'Multi-tenant agency social media management.',
        '',
        '**Three surfaces, and they do not overlap.** Every route belongs to exactly one, and',
        'each refuses the others with `404` rather than `403` — a 403 would confirm the',
        'endpoint exists.',
        '',
        Object.entries(SURFACE_NOTES)
          .map(([surface, note]) => `- **${surface}** — ${note}`)
          .join('\n'),
        '',
        'Cross-tenant access is `404` everywhere, including when the exact UUID is known.',
        'No endpoint, at any privilege level, returns credential material.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: SERVER_DESCRIPTION }],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: '__orbit_session',
          description:
            'HttpOnly session cookie minted by POST /api/v1/auth/session from a Firebase ID token. Roles are read from Postgres on every request, never from the token (D-004).',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'retryable'],
              properties: {
                code: { type: 'string', enum: [...ERROR_CODES] },
                message: {
                  type: 'string',
                  description: 'Safe for display. Never a provider payload or a stack trace.',
                },
                details: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { field: { type: 'string' }, issue: { type: 'string' } },
                  },
                },
                retryable: { type: 'boolean' },
                retryAfter: { type: 'integer', description: 'Seconds.' },
                correlationId: {
                  type: 'string',
                  description: 'Quote this to support; it keys every log line for the request.',
                },
              },
            },
          },
        },
      },
    },
    security: [{ sessionCookie: [] }],
    paths: Object.fromEntries(
      Object.entries(PATHS).map(([path, methods]) => [
        path,
        Object.fromEntries(
          Object.entries(methods).map(([method, spec]) => [
            method,
            {
              summary: spec.summary,
              tags: [spec.surface],
              description: `Permission: \`${spec.permission}\`. Surface: ${spec.surface}.`,
              ...(spec.surface === 'public' ? { security: [] } : {}),
              responses: {
                '200': { description: 'Success.' },
                '400': errorResponse(
                  'Validation failed, or the body carried a server-derived field.',
                ),
                '401': errorResponse('No usable session.'),
                '403': errorResponse('Authenticated, but not permitted.'),
                '404': errorResponse(
                  'Not found — or found and not yours, which is deliberately indistinguishable.',
                ),
                '409': errorResponse('Conflicts with current state.'),
              },
            },
          ]),
        ),
      ]),
    ),
    tags: Object.entries(SURFACE_NOTES).map(([name, description]) => ({ name, description })),
  };
}

function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}
