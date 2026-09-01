/**
 * RAG contract for the CRM agent.
 *
 * Retrieval is hybrid and structured-first: the radius search already admits the parcels
 * that satisfy the question. Those rows are the corpus. A second model call may write a
 * briefing from them, but it is not allowed to invent a parcel. Embeddings are not the
 * primary retriever — alakazam rule 8 and build-rag-systems non-negotiable 3 both forbid
 * vector-only matching when parcel ids, places, and permit predicates already decide the row.
 *
 * OpenSearch is the kit's approved vector store. This assignment keeps an in-process index
 * over the published county snapshot instead (no idle OpenSearch capacity). The interfaces
 * below are the same shape so only the adapter would change.
 */

import { isUnresolvedPermitStatus } from './permits';
import { propertyDisplay, type PermitRecord, type PropertySearchItem } from './property';

/** How many retrieved parcels are passed to the generator. Enough to brief, not a dump. */
export const RAG_EVIDENCE_LIMIT = 8;

export const RAG_CONFIDENCE_BANDS = ['auto_accept', 'review', 'fallback'] as const;

export type RagConfidenceBand = (typeof RAG_CONFIDENCE_BANDS)[number];

/** One retrieved opportunity. This is the only property shape the generator may see. */
export interface RetrievedOpportunity {
  parcel_id: string;
  address: string;
  owner: string | null;
  roof_age_years: number | null;
  distance_miles: number;
  just_value: number | null;
  unresolved_roofing: number;
  longest_open_years: number | null;
  contractor_name: string | null;
  bbb_rating: string | null;
  permit_description: string | null;
}

/**
 * Kit retrieval interfaces. The live path implements {@link RetrievalIndex} over the
 * published search; the others exist so a later OpenSearch adapter does not change callers.
 */
export interface CorpusRecord {
  id: string;
  text: string;
  metadata: RetrievedOpportunity;
}

export interface CorpusStore {
  load(): Promise<readonly CorpusRecord[]>;
}

export interface EmbeddingService {
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

/** Default Titan v2 size we request. Smaller than 1024, enough to rank short cards. */
export const RAG_EMBEDDING_DIMENSIONS = 256;

export const RAG_EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';

export interface RetrievalIndex {
  retrieve(question: string, candidates: readonly PropertySearchItem[]): RetrievedOpportunity[];
}

export interface ReviewStore {
  record(input: { question: string; citedParcelIds: readonly string[]; band: RagConfidenceBand }): Promise<void>;
}

export interface TraceSink {
  record(event: { question: string; retrievedIds: readonly string[]; band: RagConfidenceBand }): void;
}

export interface RagBriefing {
  answer: string;
  citedParcelIds: string[];
  evidence: RetrievedOpportunity[];
  band: RagConfidenceBand;
}

const SOURCE_FIELDS = [
  'parcel_id',
  'primary_address',
  'owner_name',
  'latitude',
  'longitude',
  'roof_age_years',
  'distance_miles',
  'total_just_value',
  'permits',
] as const;

export type OpportunitySource = Pick<PropertySearchItem, (typeof SOURCE_FIELDS)[number]>;

/** Turns a search hit into the card the generator is allowed to read. */
export function toOpportunity(item: OpportunitySource): RetrievedOpportunity {
  const display = propertyDisplay(item);
  const roofing = item.permits.filter(
    (permit) => permit.is_roofing && isUnresolvedPermitStatus(permit.status),
  );
  const featured = pickLongestOpen(roofing);
  const longest = featured?.open_years ?? null;

  return {
    parcel_id: item.parcel_id,
    address: display.title,
    owner: item.owner_name,
    roof_age_years: item.roof_age_years,
    distance_miles: item.distance_miles,
    just_value: item.total_just_value,
    unresolved_roofing: roofing.length,
    longest_open_years: roofing.length > 0 ? longest : null,
    contractor_name: featured?.contractor_name ?? null,
    bbb_rating: featured?.bbb_rating ?? null,
    permit_description: featured?.description ?? null,
  };
}

function pickLongestOpen(permits: readonly PermitRecord[]): PermitRecord | undefined {
  return [...permits].sort((left, right) => (right.open_years ?? 0) - (left.open_years ?? 0))[0];
}

/**
 * Retrieve from the already-filtered search hits, then rerank by token overlap with the
 * question so unstructured words (contractor, storm, street) can surface inside the set.
 */
export function retrieveOpportunities(
  items: readonly OpportunitySource[],
  question: string,
  limit = RAG_EVIDENCE_LIMIT,
): RetrievedOpportunity[] {
  const cards = items.slice(0, Math.max(limit * 3, limit)).map(toOpportunity);
  return rerankByQuestion(question, cards).slice(0, limit);
}

export function rerankByQuestion(
  question: string,
  cards: readonly RetrievedOpportunity[],
): RetrievedOpportunity[] {
  const tokens = tokenize(question);
  if (tokens.length === 0) return [...cards];

  return [...cards].sort((left, right) => {
    const delta = scoreCard(right, tokens) - scoreCard(left, tokens);
    if (delta !== 0) return delta;
    return left.distance_miles - right.distance_miles;
  });
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'for',
  'in',
  'me',
  'near',
  'of',
  'old',
  'or',
  'over',
  'show',
  'that',
  'the',
  'this',
  'to',
  'with',
  'years',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function scoreCard(card: RetrievedOpportunity, tokens: readonly string[]): number {
  const haystack = [
    card.address,
    card.owner ?? '',
    card.contractor_name ?? '',
    card.permit_description ?? '',
    card.bbb_rating ?? '',
  ]
    .join(' ')
    .toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

/** Drop any parcel id the model invented. Citations are a subset of retrieved evidence. */
export function groundCitations(
  citedParcelIds: readonly string[],
  evidence: readonly RetrievedOpportunity[],
): string[] {
  const allowed = new Set(evidence.map((card) => card.parcel_id));
  const seen = new Set<string>();
  const grounded: string[] = [];
  for (const id of citedParcelIds) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    grounded.push(id);
  }
  return grounded;
}

export function ragConfidenceBand(
  matched: number,
  cited: readonly string[],
  generated: boolean,
): RagConfidenceBand {
  if (matched === 0) return 'fallback';
  if (!generated) return 'fallback';
  if (cited.length === 0) return 'review';
  return 'auto_accept';
}

/**
 * Deterministic briefing used when the model is down and as the test default.
 * Still RAG: the sentences are assembled from retrieved cards, never from the question alone.
 */
export function briefFromEvidence(input: {
  matched: number;
  centerLabel: string;
  evidence: readonly RetrievedOpportunity[];
}): RagBriefing {
  const { matched, centerLabel, evidence } = input;
  if (matched === 0 || evidence.length === 0) {
    return {
      answer: `No matching roofing opportunities near ${centerLabel}. Nothing in the retrieved set satisfied the question.`,
      citedParcelIds: [],
      evidence: [...evidence],
      band: 'fallback',
    };
  }

  const shown = evidence.slice(0, 4);
  const lines = shown.map((card) => formatOpportunityLine(card));
  const more =
    matched > shown.length ? ` ${matched - shown.length} more matches are on the map.` : '';

  return {
    answer: `Retrieved ${matched} roofing ${
      matched === 1 ? 'opportunity' : 'opportunities'
    } near ${centerLabel}. ${lines.join(' ')}${more}`,
    citedParcelIds: shown.map((card) => card.parcel_id),
    evidence: [...evidence],
    band: 'fallback',
  };
}

/** The string that is embedded. Structured fields stay filters; this is the prose side. */
export function opportunityEmbeddingText(card: RetrievedOpportunity): string {
  return [
    card.address,
    card.owner ? `Owner ${card.owner}` : null,
    card.roof_age_years !== null
      ? `Roof about ${card.roof_age_years} years old`
      : 'Roof age unknown',
    card.unresolved_roofing > 0
      ? `${card.unresolved_roofing} unresolved roofing permit${
          card.unresolved_roofing === 1 ? '' : 's'
        }${card.longest_open_years !== null ? `, longest open ${card.longest_open_years} years` : ''}`
      : null,
    card.permit_description,
    card.contractor_name ? `Contractor ${card.contractor_name}` : null,
    card.bbb_rating ? `BBB ${card.bbb_rating}` : null,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join('. ');
}

/** Stable id for a card's embedding text. Changes when the published wording changes. */
export function embeddingSourceHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function normalizeRagQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Cache key for a question vector. Snapshot is first so a republish cannot reuse yesterday's
 * ranking, even when the salesperson types the same sentence.
 */
export function questionEmbeddingCacheKey(
  snapshotId: string,
  modelId: string,
  question: string,
): string {
  return `${snapshotId}|${modelId}|${normalizeRagQuestion(question)}`;
}

export function documentEmbeddingCacheKey(snapshotId: string, sourceHash: string): string {
  return `${snapshotId}|${sourceHash}`;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom === 0 ? 0 : dot / denom;
}

export function rankByEmbedding(
  questionVector: readonly number[],
  scored: readonly { opportunity: RetrievedOpportunity; vector: readonly number[] }[],
): RetrievedOpportunity[] {
  return [...scored]
    .map((item) => ({
      opportunity: item.opportunity,
      score: cosineSimilarity(questionVector, item.vector),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.opportunity.distance_miles - right.opportunity.distance_miles;
    })
    .map((item) => item.opportunity);
}

/**
 * In-memory vector cache. `bind` drops every vector when the snapshot id changes, which is
 * what makes "same question, new publish" re-rank against the new cards.
 */
export class SnapshotEmbeddingCache {
  private snapshotId = '';
  private readonly vectors = new Map<string, readonly number[]>();

  get currentSnapshotId(): string {
    return this.snapshotId;
  }

  get size(): number {
    return this.vectors.size;
  }

  bind(snapshotId: string): void {
    if (this.snapshotId === snapshotId) return;
    this.snapshotId = snapshotId;
    this.vectors.clear();
  }

  get(key: string): readonly number[] | undefined {
    return this.vectors.get(key);
  }

  set(key: string, vector: readonly number[]): void {
    this.vectors.set(key, vector);
  }
}

export function formatOpportunityLine(card: RetrievedOpportunity): string {
  const bits = [card.address];
  if (card.roof_age_years !== null) bits.push(`roof ${card.roof_age_years} years`);
  bits.push(`${card.distance_miles.toFixed(1)} mi`);
  if (card.unresolved_roofing > 0) {
    const open =
      card.longest_open_years !== null ? `, open ${card.longest_open_years} years` : '';
    bits.push(`${card.unresolved_roofing} open roofing permit${card.unresolved_roofing === 1 ? '' : 's'}${open}`);
  }
  if (card.contractor_name) {
    const bbb = card.bbb_rating ? ` BBB ${card.bbb_rating}` : '';
    bits.push(`${card.contractor_name}${bbb}`);
  }
  return `${bits.join(' · ')}.`;
}
