export {
  PERMISSIONS,
  PLATFORM_PERMISSIONS,
  UNGRANTABLE_PERMISSIONS,
  isPermission,
  type Permission,
} from './permissions.js';

export {
  ROLE_GRANTS,
  PLATFORM_ADMIN_GRANTS,
  CLIENT_VISIBLE_STATUSES,
  rolesWithPermission,
  type Grant,
  type GrantScope,
  type RoleGrants,
  type RolesByReach,
} from './matrix.js';

export {
  can,
  canSomewhere,
  canPlatform,
  decide,
  decidePlatform,
  assertCan,
  effectivePermissions,
  type Decision,
  type DenialReason,
  type ResourceScope,
} from './policy.js';

export { assertTransitionAllowed, canTransition, allowedTransitions } from './transitions.js';
