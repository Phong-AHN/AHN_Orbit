export {
  defineCapabilities,
  metricAvailability,
  platformCapabilitiesSchema,
  mediaConstraintSchema,
  type MediaConstraint,
  type PlatformCapabilities,
} from './capabilities.js';

export {
  validateDraft,
  canEditPublished,
  countCharacters,
  errorsOnly,
  type DraftMedia,
  type ValidationIssue,
  type ValidationResult,
  type ValidationSeverity,
  type VariantDraft,
} from './validation.js';

export {
  ProviderErrorMap,
  classifyHttpStatus,
  normalizeUnknownError,
  parseRetryAfter,
  toAppError,
  type NormalizedProviderFailure,
  type ProviderErrorKind,
} from './errors.js';

export {
  CredentialCipher,
  safeEquals,
  type CredentialAad,
  type KeyResolver,
  type SealedValue,
} from './credential-cipher.js';

export {
  assertCapability,
  capabilitiesFor,
  getProvider,
  isDevelopmentOnly,
  isSupported,
  registerProvider,
  resetRegistry,
  supportedPlatforms,
  tryGetProvider,
  videoFrameRateWindows,
  frameRateAcceptedAnywhere,
  type RegisterOptions,
} from './registry.js';

export type {
  AccountHealth,
  AuthorizationUrlInput,
  CallbackInput,
  ConnectedAccounts,
  DateRange,
  DecryptedCredential,
  DiscoveredAccount,
  ExternalPostRef,
  ExternalPostStatus,
  IssuedCredential,
  MetricSet,
  ProviderEvent,
  ConversationPage,
  ConversationParticipant,
  DirectConversation,
  DirectMessage,
  FetchConversationsInput,
  MessageAttachment,
  SendMessageInput,
  SendMessageResult,
  PublishContext,
  PublishMedia,
  PublishResult,
  RawWebhookRequest,
  ReconcileContext,
  ReconcileResult,
  RefreshOutcome,
  SocialProvider,
} from './types.js';
