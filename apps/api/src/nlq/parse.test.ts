/**
 * Tests for the parser wrapper around the one model call.
 *
 * The model itself is a `MockLanguageModelV4`, so these assert the things the product depends on
 * that a model cannot be asked to guarantee: that an identical question costs nothing the second
 * time, that the output budget is bounded, and that a failed call is not remembered as an answer.
 */

import { SEMINOLE_COUNTY_CENTER } from '@roofing-crm/shared';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createNlqParser } from './parse';

const NOW = new Date('2026-09-01T00:00:00.000Z');

const DRAFT = JSON.stringify({
  intent: 'property_search',
  locationMode: 'place',
  place: 'Sanford',
  minRoofAgeYears: 20,
});

function generated(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    },
    warnings: [],
  };
}

function modelReturning(text: string, calls: LanguageModelV4CallOptions[]) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      return generated(text);
    },
  });
}

const input = (question: string) => ({
  question,
  context: { question, center: SEMINOLE_COUNTY_CENTER, radiusMiles: 3 },
  now: NOW,
});

describe('createNlqParser', () => {
  it('calls the model once for a repeated question', async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const parser = createNlqParser({ model: modelReturning(DRAFT, calls) });

    const first = await parser.parse(input('Old roofs in Sanford'));
    const second = await parser.parse(input('Old roofs in Sanford'));

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('treats casing and surrounding whitespace as the same question', async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const parser = createNlqParser({ model: modelReturning(DRAFT, calls) });

    await parser.parse(input('Old roofs in Sanford'));
    await parser.parse(input('  old ROOFS in sanford  '));

    expect(calls).toHaveLength(1);
  });

  it('does not reuse an answer across different questions', async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const parser = createNlqParser({ model: modelReturning(DRAFT, calls) });

    await parser.parse(input('Old roofs in Sanford'));
    await parser.parse(input('Old roofs in Oviedo'));

    expect(calls).toHaveLength(2);
  });

  it('caches by question rather than by map position, so panning does not re-ask', async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const parser = createNlqParser({ model: modelReturning(DRAFT, calls) });

    await parser.parse({
      question: 'Old roofs here',
      context: { question: 'Old roofs here', center: SEMINOLE_COUNTY_CENTER, radiusMiles: 3 },
      now: NOW,
    });
    await parser.parse({
      question: 'Old roofs here',
      context: {
        question: 'Old roofs here',
        center: { latitude: 28.81, longitude: -81.36 },
        radiusMiles: 8,
      },
      now: NOW,
    });

    expect(calls).toHaveLength(1);
  });

  it('re-asks on a later day, because the prompt states the date', async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const parser = createNlqParser({ model: modelReturning(DRAFT, calls) });

    await parser.parse(input('Old roofs in Sanford'));
    await parser.parse({
      ...input('Old roofs in Sanford'),
      now: new Date('2026-09-02T00:00:00.000Z'),
    });

    expect(calls).toHaveLength(2);
  });

  it('bounds the output budget', async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const parser = createNlqParser({ model: modelReturning(DRAFT, calls) });

    await parser.parse(input('Old roofs in Sanford'));

    expect(calls[0]?.maxOutputTokens).toBe(400);
    expect(calls[0]?.temperature).toBe(0);
  });

  it('evicts the oldest entry rather than growing without limit', async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const parser = createNlqParser({ model: modelReturning(DRAFT, calls), cacheSize: 2 });

    await parser.parse(input('question one'));
    await parser.parse(input('question two'));
    await parser.parse(input('question three'));
    // "one" was evicted when "three" arrived, so asking it again costs a call.
    await parser.parse(input('question one'));
    // "three" is still cached, so it does not.
    await parser.parse(input('question three'));

    expect(calls).toHaveLength(4);
  });

  it('does not cache a failure as an answer', async () => {
    let attempts = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        attempts += 1;
        // A plain error is not retryable, so the first parse makes exactly one attempt.
        if (attempts === 1) throw new Error('bedrock unavailable');
        return generated(DRAFT);
      },
    });

    const parser = createNlqParser({ model });

    await expect(parser.parse(input('Old roofs in Sanford'))).rejects.toThrow();
    const draft = await parser.parse(input('Old roofs in Sanford'));
    expect(draft.minRoofAgeYears).toBe(20);
  });
});
