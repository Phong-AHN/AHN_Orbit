export { FacebookProvider, type FacebookProviderOptions } from './provider.js';
export {
  facebookPageCapabilities,
  FACEBOOK_DEFAULT_SCOPES,
  FACEBOOK_PUBLISH_SCOPES,
  FACEBOOK_INSIGHTS_SCOPE,
} from './capabilities.js';
export { facebookErrorMap, normalizeGraphError, reauthorizationReason } from './errors.js';
export { GraphClient, type FetchLike, type GraphClientOptions } from './client.js';
