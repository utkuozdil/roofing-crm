/**
 * Bedrock embeddings for the RAG ranker.
 *
 * Questions and opportunity cards share one model. Same text, same snapshot, same vector —
 * which is why the cache is keyed by snapshot id. A republish binds a new id and drops the
 * map, so yesterday's open-permit ranking cannot be served against today's cards.
 *
 * Titan does not batch; `embedMany` fans out. We only embed the filtered candidate set
 * (tens of short cards), never the whole county roll.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import {
  AWS_REGION,
  RAG_EMBEDDING_DIMENSIONS,
  RAG_EMBEDDING_MODEL_ID,
  SnapshotEmbeddingCache,
  documentEmbeddingCacheKey,
  embeddingSourceHash,
  opportunityEmbeddingText,
  questionEmbeddingCacheKey,
  type EmbeddingService,
  type RetrievedOpportunity,
} from '@roofing-crm/shared';
import { embedMany } from 'ai';

export interface RagEmbeddingConfig {
  modelId: string;
  region: string;
}

const DISABLED = 'off';

export function readRagEmbeddingConfig(
  env: NodeJS.ProcessEnv = process.env,
): RagEmbeddingConfig | null {
  const raw = env.RAG_EMBEDDING_MODEL_ID?.trim();
  if (raw?.toLowerCase() === DISABLED) return null;
  return {
    modelId: raw || RAG_EMBEDDING_MODEL_ID,
    region: env.RAG_EMBEDDING_REGION?.trim() || env.AWS_REGION?.trim() || AWS_REGION,
  };
}

let cachedProvider:
  | { key: string; embedder: EmbeddingService; modelId: string }
  | undefined;

export function createBedrockEmbeddingService(config: RagEmbeddingConfig): EmbeddingService {
  const bedrock = createAmazonBedrock({
    region: config.region,
    credentialProvider: fromNodeProviderChain(),
  });
  const model = bedrock.embedding(config.modelId);

  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const { embeddings } = await embedMany({
        model,
        values: [...texts],
        maxParallelCalls: 8,
        providerOptions: {
          bedrock: { dimensions: RAG_EMBEDDING_DIMENSIONS, normalize: true },
        },
      });
      return embeddings;
    },
  };
}

export function resolveEmbeddingService(
  env: NodeJS.ProcessEnv = process.env,
): { embedder: EmbeddingService; modelId: string } | null {
  const config = readRagEmbeddingConfig(env);
  if (!config) return null;
  const key = `${config.region}/${config.modelId}`;
  if (cachedProvider?.key === key) return cachedProvider;
  cachedProvider = {
    key,
    modelId: config.modelId,
    embedder: createBedrockEmbeddingService(config),
  };
  return cachedProvider;
}

export interface CachedEmbedResult {
  question: readonly number[];
  documents: readonly (readonly number[])[];
  questionCacheHit: boolean;
  documentCacheHits: number;
}

/**
 * Snapshot-scoped cache in front of any {@link EmbeddingService}.
 * Bind the published run id before each ask.
 */
export class CachedEmbeddingIndex {
  constructor(
    private readonly embedder: EmbeddingService,
    private readonly modelId: string,
    private readonly cache = new SnapshotEmbeddingCache(),
  ) {}

  get snapshotId(): string {
    return this.cache.currentSnapshotId;
  }

  bind(snapshotId: string): void {
    this.cache.bind(snapshotId);
  }

  async embedQuestionAndDocuments(
    question: string,
    documents: readonly string[],
  ): Promise<CachedEmbedResult> {
    const snapshotId = this.cache.currentSnapshotId;
    const questionKey = questionEmbeddingCacheKey(snapshotId, this.modelId, question);
    const documentKeys = documents.map((text) =>
      documentEmbeddingCacheKey(snapshotId, embeddingSourceHash(text)),
    );

    const missing: { key: string; text: string }[] = [];
    const cachedQuestion = this.cache.get(questionKey);
    if (cachedQuestion === undefined) missing.push({ key: questionKey, text: question });

    for (let index = 0; index < documents.length; index += 1) {
      const key = documentKeys[index]!;
      if (this.cache.get(key) === undefined) {
        missing.push({ key, text: documents[index]! });
      }
    }

    if (missing.length > 0) {
      const vectors = await this.embedder.embed(missing.map((item) => item.text));
      for (let index = 0; index < missing.length; index += 1) {
        const vector = vectors[index];
        if (vector) this.cache.set(missing[index]!.key, vector);
      }
    }

    const questionVector = this.cache.get(questionKey);
    if (!questionVector) {
      throw new Error('question embedding missing after embed');
    }

    const documentVectors = documentKeys.map((key) => {
      const vector = this.cache.get(key);
      if (!vector) throw new Error('document embedding missing after embed');
      return vector;
    });

    return {
      question: questionVector,
      documents: documentVectors,
      questionCacheHit: cachedQuestion !== undefined,
      documentCacheHits: documentKeys.filter((key) =>
        missing.every((item) => item.key !== key),
      ).length,
    };
  }
}

export function opportunityTexts(cards: readonly RetrievedOpportunity[]): string[] {
  return cards.map(opportunityEmbeddingText);
}
