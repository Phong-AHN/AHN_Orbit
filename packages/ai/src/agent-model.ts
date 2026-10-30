import {
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderValidationError,
} from '@orbit/core';

/**
 * A model that can call tools, for the in-app Copilot (D-109 phase 5).
 *
 * Separate from `AIProvider` because the shape is different: a conversation
 * in turns, where the model may ask for tools and read their results before
 * it answers. History is kept in the vendor's own format and is opaque to the
 * caller — Gemini, for one, attaches signatures to its turns that must come
 * back exactly as they were sent.
 *
 * The model decides which tools to *ask* for. It never runs one: the caller
 * runs each through the agent registry, under the person's own rights, and
 * outward actions still wait for the person's confirmation.
 */

export interface AgentToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface AgentToolResult {
  call: AgentToolCall;
  text: string;
  isError: boolean;
}

export interface AgentStep {
  /** The model's text for the person, possibly empty while it is calling tools. */
  text: string;
  toolCalls: AgentToolCall[];
  /** What to append to the history: the model's own turn, verbatim. */
  appended: unknown[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AgentModel {
  readonly name: string;
  readonly model: string;
  userTurn(text: string): unknown;
  toolTurn(results: readonly AgentToolResult[]): unknown;
  step(input: {
    system: string;
    history: readonly unknown[];
    tools: readonly AgentToolSpec[];
    signal?: AbortSignal | undefined;
  }): Promise<AgentStep>;
}

// ── Gemini ─────────────────────────────────────────────────────────────────────

/**
 * JSON Schema down to the OpenAPI subset Gemini's function declarations take.
 *
 * Unknown keywords are dropped rather than sent: Gemini rejects the whole
 * request for one it does not know. The arguments are validated by the tool's
 * own zod schema regardless, so a looser description costs nothing.
 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const anyOf = schema.anyOf as Array<Record<string, unknown>> | undefined;
  if (anyOf) {
    const nonNull = anyOf.filter((s) => s.type !== 'null');
    const base = toGeminiSchema(nonNull[0] ?? {});
    return {
      ...base,
      ...(nonNull.length < anyOf.length ? { nullable: true } : {}),
      ...(schema.description ? { description: schema.description } : {}),
    };
  }

  const out: Record<string, unknown> = {};
  if (typeof schema.description === 'string') out.description = schema.description;
  if ('const' in schema) {
    out.type = 'string';
    out.enum = [String(schema.const)];
    return out;
  }
  if (Array.isArray(schema.enum)) {
    out.type = 'string';
    out.enum = schema.enum.map(String);
    return out;
  }

  switch (schema.type) {
    case 'object': {
      out.type = 'object';
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      out.properties = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, toGeminiSchema(value)]),
      );
      if (Array.isArray(schema.required) && schema.required.length > 0) {
        out.required = schema.required;
      }
      return out;
    }
    case 'array':
      out.type = 'array';
      out.items = toGeminiSchema((schema.items ?? { type: 'string' }) as Record<string, unknown>);
      return out;
    case 'integer':
    case 'number':
    case 'boolean':
      out.type = schema.type;
      return out;
    default:
      out.type = 'string';
      if (schema.format === 'date-time') out.format = 'date-time';
      return out;
  }
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: unknown };
  thoughtSignature?: string;
}

interface GeminiAgentResponse {
  candidates?: Array<{ content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

export interface GeminiAgentOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GeminiAgentModel implements AgentModel {
  readonly name = 'gemini';

  constructor(private readonly options: GeminiAgentOptions) {}

  get model(): string {
    return this.options.model;
  }

  userTurn(text: string): unknown {
    return { role: 'user', parts: [{ text }] };
  }

  toolTurn(results: readonly AgentToolResult[]): unknown {
    return {
      role: 'user',
      parts: results.map((result) => ({
        functionResponse: {
          ...(result.call.id.startsWith('call-') ? {} : { id: result.call.id }),
          name: result.call.name,
          response: result.isError ? { error: result.text } : { content: result.text },
        },
      })),
    };
  }

  async step(input: {
    system: string;
    history: readonly unknown[];
    tools: readonly AgentToolSpec[];
    signal?: AbortSignal | undefined;
  }): Promise<AgentStep> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        // Built here and never stored: the key is in it.
        `${this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: input.system }] },
            contents: input.history,
            tools: [
              {
                functionDeclarations: input.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: toGeminiSchema(tool.parameters),
                })),
              },
            ],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            generationConfig: { temperature: 0.3, maxOutputTokens: 4_096, candidateCount: 1 },
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new ProviderUnavailableError('Could not reach the model', {
        cause: error instanceof Error ? error : undefined,
        userMessage: 'The Copilot is not responding. Try again in a moment.',
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }

    const body = (await response.json().catch(() => ({}))) as GeminiAgentResponse;
    if (!response.ok) {
      if (response.status === 429) {
        throw new ProviderRateLimitError('Model rate limit', {
          userMessage: 'The Copilot is busy. Try again in a minute.',
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthenticationError('Model rejected the key', {
          userMessage: 'The Copilot is not configured correctly. Tell your administrator.',
        });
      }
      throw new ProviderUnavailableError(`Model returned ${response.status}`, {
        userMessage: 'The Copilot could not answer. Try again.',
      });
    }

    const content = body.candidates?.[0]?.content;
    const parts = content?.parts ?? [];
    if (parts.length === 0) {
      throw new ProviderValidationError('The model returned nothing', {
        userMessage: 'The Copilot had nothing to say to that. Try rephrasing.',
      });
    }

    const toolCalls = parts
      .filter((part) => part.functionCall?.name)
      .map((part, index) => ({
        id: part.functionCall!.id ?? `call-${index}`,
        name: part.functionCall!.name!,
        args: part.functionCall!.args ?? {},
      }));
    const text = parts
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();

    return {
      text,
      toolCalls,
      // Verbatim, signatures included.
      appended: [{ role: 'model', parts }],
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens:
        (body.usageMetadata?.candidatesTokenCount ?? 0) +
        (body.usageMetadata?.thoughtsTokenCount ?? 0),
      latencyMs: Date.now() - started,
    };
  }
}

// ── A scripted model, for tests ───────────────────────────────────────────────

/** Plays back fixed steps. Never reaches a network. */
export class ScriptedAgentModel implements AgentModel {
  readonly name = 'scripted';
  readonly model = 'scripted-1';
  readonly seen: unknown[][] = [];
  private index = 0;

  constructor(
    private readonly script: ReadonlyArray<{ text?: string; toolCalls?: AgentToolCall[] }>,
  ) {}

  userTurn(text: string): unknown {
    return { role: 'user', text };
  }

  toolTurn(results: readonly AgentToolResult[]): unknown {
    return { role: 'tool', results };
  }

  async step(input: { history: readonly unknown[] }): Promise<AgentStep> {
    this.seen.push([...input.history]);
    const next = this.script[this.index] ?? { text: 'Done.' };
    this.index += 1;
    return {
      text: next.text ?? '',
      toolCalls: next.toolCalls ?? [],
      appended: [{ role: 'model', ...next }],
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 0,
    };
  }
}
