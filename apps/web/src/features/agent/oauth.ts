import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AGENT_SCOPES,
  ForbiddenError,
  NotFoundError,
  clock,
  isUserPrincipal,
  type AgentScope,
  type TenantContext,
} from '@orbit/core';
import { systemContext } from '@orbit/auth';
import { serverEnv } from '@orbit/config';
import { platformDb, withTenant } from '@orbit/db';
import { logger } from '@orbit/observability';

/**
 * Social Square's OAuth 2.1 authorization server, for MCP clients (D-109 §6).
 *
 * Authorization code with PKCE (S256 only), refresh tokens that rotate on every
 * use, and dynamic client registration. Tokens are opaque random strings; the
 * database holds only their SHA-256, so a leaked table is not a leaked token.
 *
 * A grant binds one person, one client and one organization to scopes. It is
 * a ceiling, not a role: the person's own role is resolved on every call, and
 * the scopes can only narrow it (`@orbit/rbac` `agent.ts`).
 *
 * Lookups by token or code hash use `platformDb`: they happen before any tenant
 * is known, and a 256-bit random value is not something a caller can choose to
 * land on another tenant's row. Every write goes through `withTenant`.
 */

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const CODE_TTL_MS = 60_000;
const MAX_REDIRECT_URIS = 5;

export class OAuthError extends Error {
  constructor(
    readonly error:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'unauthorized_client'
      | 'unsupported_grant_type'
      | 'invalid_scope'
      | 'invalid_target'
      | 'access_denied'
      | 'invalid_redirect_uri'
      | 'invalid_client_metadata',
    readonly description: string,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url');
}

function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

const scoped = (organizationId: string) =>
  systemContext({ organizationId, actorName: 'agent-oauth', capabilities: [] });

/** The MCP endpoint is the only resource these tokens are for (RFC 8707). */
export function mcpResource(): string {
  return `${serverEnv().APP_URL.replace(/\/$/, '')}/api/mcp`;
}

export function issuer(): string {
  return serverEnv().APP_URL.replace(/\/$/, '');
}

// ── Scopes ─────────────────────────────────────────────────────────────────────

export function parseScopes(raw: string | null | undefined): AgentScope[] {
  // No scope requested means the narrowest one, never all of them.
  if (!raw || !raw.trim()) return ['read'];
  const requested = raw.trim().split(/\s+/);
  const unknown = requested.filter((s) => !(AGENT_SCOPES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new OAuthError('invalid_scope', `Unknown scope: ${unknown.join(' ')}`);
  }
  return AGENT_SCOPES.filter((s) => requested.includes(s));
}

// ── Clients ────────────────────────────────────────────────────────────────────

/**
 * Only https, or http on the loopback interface for desktop clients (RFC 8252).
 * No fragments, no wildcards; matched exactly later.
 */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

export async function registerClient(metadata: {
  client_name?: unknown;
  redirect_uris?: unknown;
}): Promise<{ clientId: string; name: string; redirectUris: string[] }> {
  const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  if (
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every(
      (u): u is string => typeof u === 'string' && u.length <= 2048 && isAcceptableRedirectUri(u),
    )
  ) {
    throw new OAuthError(
      'invalid_redirect_uri',
      `Provide 1–${MAX_REDIRECT_URIS} redirect URIs, each https or loopback http.`,
    );
  }

  const name =
    typeof metadata.client_name === 'string' && metadata.client_name.trim()
      ? metadata.client_name.trim().slice(0, 100)
      : 'Unnamed AI app';

  // Platform-level: a client is software, not a tenant's data.
  const client = await platformDb.agentClient.create({
    data: { clientId: newSecret('ssc'), name, redirectUris },
    select: { clientId: true, name: true, redirectUris: true },
  });
  logger.info('agent client registered', {
    clientName: name,
    redirectHosts: redirectUris.map((u) => new URL(u).host),
  });
  return client;
}

export async function findClient(clientId: string) {
  return platformDb.agentClient.findUnique({
    where: { clientId },
    select: { id: true, clientId: true, name: true, redirectUris: true },
  });
}

// ── Authorization request ──────────────────────────────────────────────────────

export interface AuthorizationRequest {
  clientId: string;
  clientName: string;
  clientRowId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: AgentScope[];
  state: string | null;
  resource: string;
}

/**
 * Validate an authorization request before anything is shown.
 *
 * The client and its redirect URI are checked first, and failures there are
 * never redirected anywhere — an unregistered redirect URI is exactly the
 * thing an attacker would supply.
 */
export async function validateAuthorizationRequest(
  params: URLSearchParams,
): Promise<AuthorizationRequest> {
  const clientId = params.get('client_id') ?? '';
  const client = clientId ? await findClient(clientId) : null;
  if (!client) throw new OAuthError('invalid_client', 'Unknown client.');

  const redirectUri = params.get('redirect_uri') ?? '';
  if (!client.redirectUris.includes(redirectUri)) {
    throw new OAuthError(
      'invalid_redirect_uri',
      'That redirect URI is not registered for this client.',
    );
  }

  if (params.get('response_type') !== 'code') {
    throw new OAuthError('invalid_request', 'response_type must be code.');
  }
  if (params.get('code_challenge_method') !== 'S256') {
    throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  }
  const codeChallenge = params.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw new OAuthError('invalid_request', 'code_challenge must be a base64url SHA-256 digest.');
  }

  const resource = params.get('resource') ?? mcpResource();
  if (resource.replace(/\/$/, '') !== mcpResource()) {
    throw new OAuthError(
      'invalid_target',
      'Tokens are only issued for the Social Square MCP server.',
    );
  }

  const state = params.get('state');
  return {
    clientId: client.clientId,
    clientName: client.name,
    clientRowId: client.id,
    redirectUri,
    codeChallenge,
    scopes: parseScopes(params.get('scope')),
    state: state && state.length <= 1024 ? state : null,
    resource: mcpResource(),
  };
}

/** Issue a code after the person consented, as themselves, in one organization. */
export async function issueAuthorizationCode(
  ctx: TenantContext,
  request: AuthorizationRequest,
  scopes: AgentScope[],
): Promise<string> {
  const person = ctx.principal;
  if (!isUserPrincipal(person) || person.delegation) {
    throw new ForbiddenError('Only a signed-in person can grant access');
  }
  if (person.organizationRole === 'CLIENT' || person.membershipStatus !== 'ACTIVE') {
    throw new ForbiddenError('This role cannot connect AI apps', {
      userMessage: 'Your role in this organization cannot connect AI apps.',
    });
  }
  // The person may grant less than was asked for, never more.
  const granted = scopes.filter((s) => request.scopes.includes(s));
  if (granted.length === 0)
    throw new OAuthError('invalid_scope', 'Choose at least one permission.');

  const code = newSecret('ssac');
  await withTenant(ctx, (db) =>
    db.agentAuthorizationCode.create({
      data: {
        organizationId: ctx.organizationId,
        codeHash: hashSecret(code),
        clientId: request.clientRowId,
        userId: person.userId,
        scopes: granted,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        expiresAt: new Date(clock.now().getTime() + CODE_TTL_MS),
      },
    }),
  );
  return code;
}

// ── Tokens ─────────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(
  organizationId: string,
  grantId: string,
  scopes: string[],
): Promise<TokenResponse> {
  const accessToken = newSecret('ssat');
  const refreshToken = newSecret('ssrt');
  const now = clock.now().getTime();

  await withTenant(scoped(organizationId), (db) =>
    db.agentToken.createMany({
      data: [
        {
          organizationId,
          grantId,
          kind: 'ACCESS',
          tokenHash: hashSecret(accessToken),
          expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
        },
        {
          organizationId,
          grantId,
          kind: 'REFRESH',
          tokenHash: hashSecret(refreshToken),
          expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
        },
      ],
    }),
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  };
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return digest.length === expected.length && timingSafeEqual(digest, expected);
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
}): Promise<TokenResponse> {
  const row = await platformDb.agentAuthorizationCode.findUnique({
    where: { codeHash: hashSecret(input.code) },
    select: {
      id: true,
      organizationId: true,
      userId: true,
      scopes: true,
      redirectUri: true,
      codeChallenge: true,
      expiresAt: true,
      usedAt: true,
      client: { select: { id: true, clientId: true } },
    },
  });
  if (!row) throw new OAuthError('invalid_grant', 'Unknown or expired code.');

  if (row.usedAt) {
    logger.warn('agent authorization code reused', {
      securityEvent: true,
      organizationId: row.organizationId,
      userId: row.userId,
    });
    throw new OAuthError('invalid_grant', 'This code was already used.');
  }

  // Claim before anything else, so two concurrent exchanges cannot both win.
  const claimed = await withTenant(scoped(row.organizationId), (db) =>
    db.agentAuthorizationCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: clock.now() },
    }),
  );
  if (claimed.count === 0) throw new OAuthError('invalid_grant', 'This code was already used.');

  if (row.expiresAt <= clock.now()) throw new OAuthError('invalid_grant', 'The code expired.');
  if (row.client.clientId !== input.clientId)
    throw new OAuthError('invalid_grant', 'Code was issued to another client.');
  if (row.redirectUri !== input.redirectUri)
    throw new OAuthError('invalid_grant', 'redirect_uri does not match.');
  if (input.resource && input.resource.replace(/\/$/, '') !== mcpResource()) {
    throw new OAuthError(
      'invalid_target',
      'Tokens are only issued for the Social Square MCP server.',
    );
  }
  if (!pkceMatches(input.codeVerifier, row.codeChallenge)) {
    throw new OAuthError('invalid_grant', 'PKCE verification failed.');
  }

  const grant = await withTenant(scoped(row.organizationId), (db) =>
    db.agentGrant.create({
      data: {
        organizationId: row.organizationId,
        userId: row.userId,
        clientId: row.client.id,
        scopes: row.scopes,
      },
      select: { id: true },
    }),
  );
  await platformDb.agentClient.update({
    where: { id: row.client.id },
    data: { lastUsedAt: clock.now() },
  });

  logger.info('agent grant created', {
    organizationId: row.organizationId,
    userId: row.userId,
    grantId: grant.id,
    scopes: row.scopes,
  });
  return issueTokens(row.organizationId, grant.id, row.scopes);
}

async function revokeGrantUnchecked(
  organizationId: string,
  grantId: string,
  reason: string,
  by?: string,
) {
  await withTenant(scoped(organizationId), (db) =>
    db.agentGrant.updateMany({
      where: { id: grantId, revokedAt: null },
      data: { revokedAt: clock.now(), revokedReason: reason, revokedById: by ?? null },
    }),
  );
}

/**
 * Rotate a refresh token. A refresh token is good once: a second use means it
 * was copied, so the whole grant is revoked and both holders are signed out.
 */
export async function refreshTokens(input: {
  refreshToken: string;
  clientId: string;
}): Promise<TokenResponse> {
  const row = await platformDb.agentToken.findUnique({
    where: { tokenHash: hashSecret(input.refreshToken) },
    select: {
      id: true,
      organizationId: true,
      kind: true,
      usedAt: true,
      expiresAt: true,
      grant: {
        select: { id: true, revokedAt: true, scopes: true, client: { select: { clientId: true } } },
      },
    },
  });
  if (!row || row.kind !== 'REFRESH')
    throw new OAuthError('invalid_grant', 'Unknown refresh token.');
  if (row.grant.client.clientId !== input.clientId)
    throw new OAuthError('invalid_grant', 'Token was issued to another client.');

  if (row.usedAt) {
    logger.warn('agent refresh token reused; revoking the grant', {
      securityEvent: true,
      organizationId: row.organizationId,
      grantId: row.grant.id,
    });
    await revokeGrantUnchecked(row.organizationId, row.grant.id, 'refresh token reused');
    throw new OAuthError('invalid_grant', 'Refresh token reuse detected; access was revoked.');
  }
  if (row.grant.revokedAt || row.expiresAt <= clock.now()) {
    throw new OAuthError('invalid_grant', 'Access was revoked or expired. Connect again.');
  }

  const claimed = await withTenant(scoped(row.organizationId), (db) =>
    db.agentToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: clock.now() },
    }),
  );
  if (claimed.count === 0) {
    await revokeGrantUnchecked(row.organizationId, row.grant.id, 'refresh token reused');
    throw new OAuthError('invalid_grant', 'Refresh token reuse detected; access was revoked.');
  }

  return issueTokens(row.organizationId, row.grant.id, row.grant.scopes);
}

export interface VerifiedAgentToken {
  grantId: string;
  organizationId: string;
  userId: string;
  scopes: AgentScope[];
}

/** Resolve a bearer token, or `null`. Expired, revoked and refresh tokens all fail. */
export async function verifyAccessToken(token: string): Promise<VerifiedAgentToken | null> {
  if (!token.startsWith('ssat_') || token.length > 200) return null;
  const row = await platformDb.agentToken.findUnique({
    where: { tokenHash: hashSecret(token) },
    select: {
      kind: true,
      expiresAt: true,
      organizationId: true,
      grant: {
        select: { id: true, userId: true, scopes: true, revokedAt: true, lastUsedAt: true },
      },
    },
  });
  if (!row || row.kind !== 'ACCESS' || row.expiresAt <= clock.now() || row.grant.revokedAt)
    return null;

  // Recorded for the person's "connected apps" list; at most once a minute.
  const now = clock.now();
  if (!row.grant.lastUsedAt || now.getTime() - row.grant.lastUsedAt.getTime() > 60_000) {
    await withTenant(scoped(row.organizationId), (db) =>
      db.agentGrant.update({ where: { id: row.grant.id }, data: { lastUsedAt: now } }),
    ).catch(() => undefined);
  }

  return {
    grantId: row.grant.id,
    organizationId: row.organizationId,
    userId: row.grant.userId,
    scopes: row.grant.scopes.filter((s): s is AgentScope =>
      (AGENT_SCOPES as readonly string[]).includes(s),
    ),
  };
}

/** RFC 7009: revoking either token ends the whole grant. Unknown tokens succeed silently. */
export async function revokeByToken(token: string): Promise<void> {
  const row = await platformDb.agentToken.findUnique({
    where: { tokenHash: hashSecret(token) },
    select: { organizationId: true, grantId: true },
  });
  if (row) await revokeGrantUnchecked(row.organizationId, row.grantId, 'revoked by the client');
}

// ── Managing grants in Social Square ───────────────────────────────────────────

function personOf(ctx: TenantContext) {
  if (!isUserPrincipal(ctx.principal) || ctx.principal.delegation) throw new NotFoundError('Grant');
  return ctx.principal;
}

/** The person's own grants; Owners and Admins see everyone's in the organization. */
export async function listGrants(ctx: TenantContext) {
  const person = personOf(ctx);
  const orgWide = person.organizationRole === 'OWNER' || person.organizationRole === 'ADMIN';
  return withTenant(ctx, (db) =>
    db.agentGrant.findMany({
      where: { revokedAt: null, ...(orgWide ? {} : { userId: person.userId }) },
      select: {
        id: true,
        scopes: true,
        createdAt: true,
        lastUsedAt: true,
        client: { select: { name: true } },
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  );
}

export async function revokeGrant(ctx: TenantContext, grantId: string): Promise<void> {
  const person = personOf(ctx);
  const orgWide = person.organizationRole === 'OWNER' || person.organizationRole === 'ADMIN';
  const updated = await withTenant(ctx, (db) =>
    db.agentGrant.updateMany({
      where: { id: grantId, revokedAt: null, ...(orgWide ? {} : { userId: person.userId }) },
      data: {
        revokedAt: clock.now(),
        revokedById: person.userId,
        revokedReason: orgWide ? 'revoked in Social Square' : 'revoked by its owner',
      },
    }),
  );
  if (updated.count === 0) throw new NotFoundError('Grant');
}
