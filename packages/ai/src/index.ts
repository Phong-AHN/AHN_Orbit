export type {
  AdaptInput,
  AnswerMessageInput,
  AIProvider,
  AIResult,
  BrandContext,
  CaptionInput,
  GenerationBase,
  HashtagInput,
  RewriteInput,
  RewriteMode,
} from './types.js';

export { GeminiProvider, type GeminiOptions } from './gemini.js';
export { MockAIProvider } from './mock.js';
export {
  findBannedTerms,
  adaptPrompt,
  captionPrompt,
  hashtagPrompt,
  rewritePrompt,
} from './prompt.js';

export {
  AI_DISCLOSURE,
  DEFAULT_HOLDING_MESSAGE,
  ESCALATION_CATEGORIES,
  MAX_KNOWLEDGE_CHARS,
  assistantPrompt,
  checkReply,
  decideReply,
  detectEscalation,
  isStopRequest,
  normalizeForMatching,
  parseVerdict,
  redactSensitive,
  withDisclosure,
  type AssistantTurn,
  type AssistantVerdict,
  type Decision,
  type EscalationCategory,
  type KnowledgeEntry,
} from './assistant.js';
export { createAIProvider, toBrandContext } from './factory.js';
