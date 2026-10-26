import { InternalError } from '@orbit/core';
import { GeminiProvider } from './gemini.js';
import { MockAIProvider } from './mock.js';
import type { AIProvider, BrandContext } from './types.js';

/**
 * Pieces the web app and the worker both need (D-108).
 *
 * The web app suggests replies and the worker sends them; both build the same
 * provider from the same settings and the same brand context from the same
 * row. Kept here so the two cannot disagree about either.
 */

/**
 * Gemini when a key is configured, the mock otherwise — and never the mock in
 * production, where a fake answer would be sent to a real customer.
 */
export function createAIProvider(config: {
  apiKey: string | undefined;
  model: string;
  production: boolean;
}): AIProvider {
  if (config.apiKey) return new GeminiProvider({ apiKey: config.apiKey, model: config.model });

  if (config.production) {
    throw new InternalError('GEMINI_API_KEY is not set', {
      userMessage: 'The writing assistant is not configured. Tell an administrator.',
    });
  }

  return new MockAIProvider();
}

/** The Brand Brain row, as the prompts read it. Null when the brand has none. */
export function toBrandContext(
  brandName: string,
  voice: {
    companyDescription: string | null;
    productsServices: string | null;
    targetAudience: string | null;
    brandVoice: string | null;
    tone: string | null;
    website: string | null;
    preferredTerms: string[];
    bannedTerms: string[];
    ctas: string[];
    exampleContent: unknown;
  } | null,
): BrandContext | null {
  if (!voice) return null;

  return {
    brandName,
    ...(voice.companyDescription ? { companyDescription: voice.companyDescription } : {}),
    ...(voice.productsServices ? { productsServices: voice.productsServices } : {}),
    ...(voice.targetAudience ? { targetAudience: voice.targetAudience } : {}),
    ...(voice.brandVoice ? { brandVoice: voice.brandVoice } : {}),
    ...(voice.tone ? { tone: voice.tone } : {}),
    ...(voice.website ? { website: voice.website } : {}),
    preferredTerms: voice.preferredTerms,
    bannedTerms: voice.bannedTerms,
    ctas: voice.ctas,
    // A Json column; anything unexpected in it is discarded.
    exampleContent: Array.isArray(voice.exampleContent)
      ? voice.exampleContent.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}
