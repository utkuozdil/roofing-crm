/**
 * The second model call in the RAG path.
 *
 * Parse already turned the question into a filter set and the search already retrieved the
 * matching parcels. This function writes a salesperson briefing from those cards only.
 * generateObject plus {@link groundCitations} is the safety story: a parcel id that is not
 * in the retrieved set is dropped before the answer leaves this module.
 */

import {
  briefFromEvidence,
  groundCitations,
  ragConfidenceBand,
  type RagBriefing,
  type RetrievedOpportunity,
} from '@roofing-crm/shared';
import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';

export interface RagGenerateInput {
  question: string;
  matched: number;
  centerLabel: string;
  evidence: readonly RetrievedOpportunity[];
}

export interface RagGenerator {
  generate(input: RagGenerateInput): Promise<RagBriefing>;
}

const ragAnswerSchema = z.object({
  answer: z
    .string()
    .min(1)
    .describe(
      'Two to five sentences briefing a roofing salesperson. Name only retrieved properties. Do not invent parcels, addresses, contractors, BBB ratings, or counts.',
    ),
  citedParcelIds: z
    .array(z.string())
    .describe('parcel_id values copied from the evidence list. Empty when evidence is empty.'),
});

export function buildRagSystemPrompt(): string {
  return [
    'You write a short briefing for a roofing salesperson from retrieved Seminole County, Florida property records.',
    'You never invent a parcel, address, owner, contractor, BBB rating, permit, or count.',
    'Every property you name must appear in the evidence list, and every citedParcelIds value must be copied from that list.',
    'If evidence is empty, say there are no matching roofing opportunities and cite nothing.',
    'Prefer properties with older roofs, unresolved roofing permits, long-open permits, and a listed contractor or BBB rating when those fields are present.',
  ].join(' ');
}

function buildRagUserPrompt(input: RagGenerateInput): string {
  return [
    `Question: ${input.question}`,
    `Total matches (from the county search, not for you to recount): ${input.matched}`,
    `Area: ${input.centerLabel}`,
    '',
    'Retrieved evidence:',
    JSON.stringify(input.evidence, null, 2),
  ].join('\n');
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_TOKENS = 500;

export function createRagGenerator(options: {
  model: LanguageModel;
  timeoutMs?: number;
}): RagGenerator {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async generate(input) {
      if (input.evidence.length === 0 || input.matched === 0) {
        return briefFromEvidence(input);
      }

      const { object } = await generateObject({
        model: options.model,
        schema: ragAnswerSchema,
        schemaName: 'RagBriefing',
        schemaDescription: 'Grounded briefing over retrieved Seminole County parcels.',
        system: buildRagSystemPrompt(),
        prompt: buildRagUserPrompt(input),
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });

      const citedParcelIds = groundCitations(object.citedParcelIds, input.evidence);
      return {
        answer: object.answer.trim(),
        citedParcelIds,
        evidence: [...input.evidence],
        band: ragConfidenceBand(input.matched, citedParcelIds, true),
      };
    },
  };
}

/** Used by tests and as the production fallback when the generate call fails. */
export function fallbackRagGenerator(): RagGenerator {
  return {
    generate: async (input) => briefFromEvidence(input),
  };
}

export async function generateRagBriefing(
  generator: RagGenerator,
  input: RagGenerateInput,
): Promise<RagBriefing> {
  if (input.evidence.length === 0 || input.matched === 0) {
    return briefFromEvidence(input);
  }

  try {
    const raw = await generator.generate(input);
    const citedParcelIds = groundCitations(raw.citedParcelIds, input.evidence);
    return {
      answer: raw.answer.trim(),
      citedParcelIds,
      evidence: [...input.evidence],
      band: ragConfidenceBand(input.matched, citedParcelIds, raw.band !== 'fallback'),
    };
  } catch {
    return briefFromEvidence(input);
  }
}
