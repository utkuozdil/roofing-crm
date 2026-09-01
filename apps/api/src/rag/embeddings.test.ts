import { describe, expect, it } from 'vitest';
import {
  CachedEmbeddingIndex,
  readRagEmbeddingConfig,
  type CachedEmbedResult,
} from './embeddings';
import type { EmbeddingService } from '@roofing-crm/shared';

function countingEmbedder(): EmbeddingService & { calls: number; lastTexts: string[] } {
  const service = {
    calls: 0,
    lastTexts: [] as string[],
    async embed(texts: readonly string[]) {
      service.calls += 1;
      service.lastTexts = [...texts];
      return texts.map((text, index) => [text.length, index, 1]);
    },
  };
  return service;
}

describe('readRagEmbeddingConfig', () => {
  it('defaults to Titan v2 when the env is unset', () => {
    const config = readRagEmbeddingConfig({});
    expect(config?.modelId).toBe('amazon.titan-embed-text-v2:0');
  });

  it('can be switched off without disabling the chat', () => {
    expect(readRagEmbeddingConfig({ RAG_EMBEDDING_MODEL_ID: 'off' })).toBeNull();
  });
});

describe('CachedEmbeddingIndex', () => {
  it('embeds a repeated question once on the same snapshot', async () => {
    const embedder = countingEmbedder();
    const index = new CachedEmbeddingIndex(embedder, 'amazon.titan-embed-text-v2:0');
    index.bind('run-1');

    const first = await index.embedQuestionAndDocuments('Old roofs in Sanford', ['card-a']);
    const second = await index.embedQuestionAndDocuments('old roofs in sanford', ['card-a']);

    expect(first.questionCacheHit).toBe(false);
    expect(second.questionCacheHit).toBe(true);
    expect(second.documentCacheHits).toBe(1);
    expect(embedder.calls).toBe(1);
    expect(second.question).toEqual(first.question);
  });

  it('drops the question vector when the published snapshot changes', async () => {
    const embedder = countingEmbedder();
    const index = new CachedEmbeddingIndex(embedder, 'amazon.titan-embed-text-v2:0');
    index.bind('run-1');
    await index.embedQuestionAndDocuments('Old roofs in Sanford', ['card-a']);

    index.bind('run-2');
    const afterPublish: CachedEmbedResult = await index.embedQuestionAndDocuments(
      'Old roofs in Sanford',
      ['card-a-updated'],
    );

    expect(afterPublish.questionCacheHit).toBe(false);
    expect(afterPublish.documentCacheHits).toBe(0);
    expect(embedder.calls).toBe(2);
  });
});
