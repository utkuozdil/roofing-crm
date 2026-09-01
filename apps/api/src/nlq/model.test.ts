/**
 * Tests for model configuration and the Bedrock structured-output workaround.
 *
 * The middleware tests are the load-bearing ones. Without the middleware every question fails
 * against Claude Haiku 4.5 on Bedrock with a 400, and the failure is invisible until a real
 * request is made — so the transformation is asserted here rather than trusted.
 */

import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { jsonSchemaAsToolMiddleware, readNlqModelConfig } from './model';

const SCHEMA = {
  type: 'object',
  properties: { intent: { type: 'string' } },
} as const;

function callOptions(
  overrides: Partial<LanguageModelV4CallOptions> = {},
): LanguageModelV4CallOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Old roofs in Sanford' }] }],
    ...overrides,
  } as LanguageModelV4CallOptions;
}

async function transform(params: LanguageModelV4CallOptions): Promise<LanguageModelV4CallOptions> {
  const transformParams = jsonSchemaAsToolMiddleware.transformParams;
  if (transformParams === undefined) throw new Error('middleware has no transformParams');
  return transformParams({ params, type: 'generate', model: {} as never });
}

describe('readNlqModelConfig', () => {
  it('is disabled when no model id is configured', () => {
    expect(readNlqModelConfig({})).toBeNull();
    expect(readNlqModelConfig({ NLQ_MODEL_ID: '   ' })).toBeNull();
  });

  it('defaults the region to the service region', () => {
    const config = readNlqModelConfig({
      NLQ_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    });
    expect(config).toEqual({
      modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      region: 'us-east-2',
    });
  });

  it('prefers an explicit model region over the Lambda region', () => {
    const config = readNlqModelConfig({
      NLQ_MODEL_ID: 'model',
      NLQ_MODEL_REGION: 'us-west-2',
      AWS_REGION: 'eu-west-1',
    });
    expect(config?.region).toBe('us-west-2');
  });
});

describe('jsonSchemaAsToolMiddleware', () => {
  it('moves a JSON response schema onto a forced tool', async () => {
    const params = await transform(
      callOptions({ responseFormat: { type: 'json', schema: SCHEMA as never } }),
    );

    // The response format Bedrock rejects for this model is gone...
    expect(params.responseFormat).toEqual({ type: 'text' });
    // ...and the schema is carried by a tool the model is required to call.
    expect(params.toolChoice).toEqual({ type: 'tool', toolName: 'json' });
    expect(params.tools).toEqual([
      {
        type: 'function',
        name: 'json',
        description: 'Respond with a JSON object matching the schema.',
        inputSchema: SCHEMA,
      },
    ]);
  });

  it('leaves a plain text call untouched', async () => {
    const original = callOptions();
    const params = await transform(original);
    expect(params).toBe(original);
  });

  it('leaves a JSON call with no schema untouched', async () => {
    const original = callOptions({ responseFormat: { type: 'json' } });
    const params = await transform(original);
    expect(params).toBe(original);
  });

  it('unwraps the tool call back into text for generateObject to parse', async () => {
    const wrapGenerate = jsonSchemaAsToolMiddleware.wrapGenerate;
    if (wrapGenerate === undefined) throw new Error('middleware has no wrapGenerate');

    const result = await wrapGenerate({
      doGenerate: async () =>
        ({
          content: [
            { type: 'tool-call', toolCallId: '1', toolName: 'json', input: '{"intent":"x"}' },
          ],
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }) as never,
      params: callOptions(),
      model: {} as never,
      doStream: undefined as never,
    } as never);

    expect(result.content).toEqual([{ type: 'text', text: '{"intent":"x"}' }]);
  });

  it('passes a response through unchanged when the model answered with text', async () => {
    const wrapGenerate = jsonSchemaAsToolMiddleware.wrapGenerate;
    if (wrapGenerate === undefined) throw new Error('middleware has no wrapGenerate');

    const content = [{ type: 'text', text: '{"intent":"y"}' }];
    const result = await wrapGenerate({
      doGenerate: async () =>
        ({
          content,
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }) as never,
      params: callOptions(),
      model: {} as never,
      doStream: undefined as never,
    } as never);

    expect(result.content).toBe(content);
  });
});
