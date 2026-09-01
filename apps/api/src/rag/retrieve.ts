/**
 * Hybrid retrieve: structured search already admitted the parcels. This step ranks that
 * set. Embeddings first; lexical overlap if the embedder is off or throws.
 */

import {
  RAG_EVIDENCE_LIMIT,
  rankByEmbedding,
  retrieveOpportunities,
  toOpportunity,
  type OpportunitySource,
  type RetrievedOpportunity,
} from '@roofing-crm/shared';
import { opportunityTexts, type CachedEmbeddingIndex } from './embeddings';

export type RetrievalMethod = 'embedding' | 'lexical';

export interface HybridRetrieval {
  evidence: RetrievedOpportunity[];
  method: RetrievalMethod;
  questionCacheHit: boolean;
  documentCacheHits: number;
}

export function snapshotIdFromProvenance(provenance: {
  provider: string;
  snapshot?: { runId: string };
  permits?: { runId: string };
}): string {
  return `${provenance.snapshot?.runId ?? provenance.provider}+${provenance.permits?.runId ?? 'none'}`;
}

export async function retrieveRankedOpportunities(input: {
  items: readonly OpportunitySource[];
  question: string;
  index: CachedEmbeddingIndex | null;
  limit?: number;
}): Promise<HybridRetrieval> {
  const limit = input.limit ?? RAG_EVIDENCE_LIMIT;
  const pool = input.items.slice(0, Math.max(limit * 3, limit)).map(toOpportunity);

  if (pool.length === 0) {
    return { evidence: [], method: 'lexical', questionCacheHit: false, documentCacheHits: 0 };
  }

  if (input.index) {
    try {
      const embedded = await input.index.embedQuestionAndDocuments(
        input.question,
        opportunityTexts(pool),
      );
      const ranked = rankByEmbedding(
        embedded.question,
        pool.map((opportunity, index) => ({
          opportunity,
          vector: embedded.documents[index] ?? [],
        })),
      ).slice(0, limit);
      return {
        evidence: ranked,
        method: 'embedding',
        questionCacheHit: embedded.questionCacheHit,
        documentCacheHits: embedded.documentCacheHits,
      };
    } catch {
      // Fall through. A missing vector store must not take down the filter answer.
    }
  }

  return {
    evidence: retrieveOpportunities(input.items, input.question, limit),
    method: 'lexical',
    questionCacheHit: false,
    documentCacheHits: 0,
  };
}
