export { type IdentityProvider, type VerifiedIdentity } from './identity.js';

export {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  selectIdentityProvider,
  sessionCookie,
  clearedSessionCookie,
  createSession,
  readSession,
  requireSession,
  revokeSessions,
  type SessionCookieOptions,
} from './session.js';

export { devIdentityProvider, assertDevelopmentOnly, resetDevSessions } from './dev-provider.js';
export { firebaseIdentityProvider } from './firebase-provider.js';

export {
  resolveUser,
  resolveTenantContext,
  listAccessibleOrganizations,
  type AuthenticatedUser,
  type OrganizationSummary,
} from './principal.js';

export {
  systemContext,
  PUBLISH_WORKER_CAPABILITIES,
  HEALTH_WORKER_CAPABILITIES,
  NOTIFICATION_WORKER_CAPABILITIES,
} from './system.js';
