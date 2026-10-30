import { describe, expect, it } from 'vitest';
import { GeminiAgentModel, toGeminiSchema } from './agent-model.js';

describe('toGeminiSchema', () => {
  it('keeps the OpenAPI subset and drops what Gemini would reject', () => {
    expect(
      toGeminiSchema({
        type: 'object',
        additionalProperties: false,
        properties: {
          postId: { type: 'string', format: 'uuid', minLength: 36 },
          when: { type: 'string', format: 'date-time' },
          note: { anyOf: [{ type: 'string', maxLength: 10 }, { type: 'null' }] },
          kind: { type: 'string', enum: ['IMAGE', 'VIDEO'] },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
          count: { type: 'integer', minimum: 1, default: 5 },
          to: { const: 'INTERNAL_REVIEW' },
        },
        required: ['postId'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        postId: { type: 'string' },
        when: { type: 'string', format: 'date-time' },
        note: { type: 'string', nullable: true },
        kind: { type: 'string', enum: ['IMAGE', 'VIDEO'] },
        tags: { type: 'array', items: { type: 'string' } },
        count: { type: 'integer' },
        to: { type: 'string', enum: ['INTERNAL_REVIEW'] },
      },
      required: ['postId'],
    });
  });
});

describe('GeminiAgentModel', () => {
  it('returns tool calls and keeps the model turn verbatim, signatures included', async () => {
    let body: { tools?: Array<{ functionDeclarations: unknown[] }>; systemInstruction?: unknown } =
      {};
    const parts = [
      { text: 'Let me look.', thoughtSignature: 'sig-1' },
      {
        functionCall: { name: 'list_posts', args: { status: 'DRAFT' } },
        thoughtSignature: 'sig-2',
      },
    ];
    const model = new GeminiAgentModel({
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as typeof body;
        return new Response(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const step = await model.step({
      system: 'rules',
      history: [model.userTurn('hi')],
      tools: [
        { name: 'list_posts', description: 'd', parameters: { type: 'object', properties: {} } },
      ],
    });

    expect(body.systemInstruction).toEqual({ parts: [{ text: 'rules' }] });
    expect(body.tools?.[0]?.functionDeclarations).toHaveLength(1);
    expect(step.toolCalls).toEqual([
      { id: 'call-0', name: 'list_posts', args: { status: 'DRAFT' } },
    ]);
    expect(step.text).toBe('Let me look.');
    expect(step.appended).toEqual([{ role: 'model', parts }]);
    expect(step.outputTokens).toBe(7);

    const reply = model.toolTurn([
      { call: step.toolCalls[0]!, text: '{"posts":[]}', isError: false },
    ]);
    expect(reply).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'list_posts', response: { content: '{"posts":[]}' } } }],
    });
  });
});
