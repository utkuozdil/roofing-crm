/**
 * The one model call in the product.
 *
 * It is a single `generateObject` against a Zod schema — no tool loop, no retrieval, no
 * conversation. The model's entire job is to read one sentence and fill in a filter set;
 * it never sees a property row, so it has nothing to be confidently wrong about. What it
 * returns is validated by {@link nlqQueryDraftSchema} before this function returns, and
 * grounded into a runnable query by `groundNlqQuery` afterwards.
 *
 * The parser is an interface rather than a bare function so the router can be tested against
 * a fixed draft, which is what makes the "every returned row satisfies the stated criteria"
 * assertion a test of the search path rather than a test of a model's mood.
 */

import { SEMINOLE_PLACES, type NlqContext, type NlqQueryDraft } from '@roofing-crm/shared';
import { generateObject, type LanguageModel } from 'ai';
import { nlqQueryDraftSchema, normaliseNlqDraft } from './schema';

export interface NlqParseInput {
  question: string;
  context: NlqContext;
  now: Date;
}

export interface NlqParser {
  parse(input: NlqParseInput): Promise<NlqQueryDraft>;
}

/**
 * Everything the model is allowed to know. The place list is included verbatim because the
 * gazetteer is the only source of coordinates in the system — a name that is not on this
 * list is refused downstream, and telling the model that up front turns a hallucinated
 * location into an honest `out_of_scope` instead.
 */
export function buildSystemPrompt(now: Date, permitsAvailable = true): string {
  return [
    'You translate a roofing salesperson’s question into a structured property filter for a CRM covering Seminole County, Florida, and nothing else.',
    '',
    'You never answer the question yourself. You never invent parcels, counts, addresses, or coordinates. You only fill in the filter fields; the CRM then runs the search and reports the real matches.',
    '',
    `Today is ${now.toISOString().slice(0, 10)}.`,
    '',
    `Places the CRM can locate: ${SEMINOLE_PLACES.map((place) => `${place.name} (${place.zip})`).join(', ')}. Any other place name must be intent="out_of_scope".`,
    '',
    'Rules that matter:',
    '- Set only the filters the question actually asks for. Leave everything else null. An unrequested filter silently removes real leads.',
    '- locationMode=county whenever the question names no location at all. Use current_map ONLY when the question explicitly points at the current view — "here", "nearby", "this area", "on screen". A question with no location is a county-wide question, not a question about wherever the map happens to be pointing.',
    '- minRoofAgeYears is for roof questions only. "Properties that haven’t sold in 20 years" mentions no roof, so minRoofAgeYears must be null.',
    '- minYearsSinceLastSale and soldSinceYear are opposites. Set at most one.',
    '- "out of area", "out of state", "absentee", and "investor owned" all mean outOfAreaOwnerOnly=true.',
    '- "house", "home", and "residential" mean propertyTypes=["single_family","condo","townhouse","mobile_home","multi_family"].',
    '- A question the CRM cannot express as a filter — permit contractor reputation, roof material, square footage, anything about another county, or anything that is not a property search — is intent="out_of_scope" with a refusalReason.',
    '- Aggregate questions ("how many", "average value") are still property_search: the CRM reports the match count itself.',
    /**
     * Told rather than left to be discovered downstream. The router refuses permit questions
     * outright when the dataset has none, but a model that believes permits are searchable
     * writes refusal reasons that promise a capability the deployment does not have — and the
     * refusal text is what the operator reads.
     */
    ...(permitsAvailable
      ? []
      : [
          '- This deployment’s dataset holds parcels only, with NO permit history. Any question about permits — open permits, permit age, unpermitted work, contractors — is intent="out_of_scope", and the refusalReason must say the dataset carries no permit history. Never describe permits as something this CRM can filter on.',
        ]),
  ].join('\n');
}

function buildUserPrompt(input: NlqParseInput): string {
  return [
    `Question: ${input.question}`,
    '',
    'Current map state, for use only when the question refers to "here" or "this area":',
    `- centre: ${input.context.center.latitude.toFixed(5)}, ${input.context.center.longitude.toFixed(5)}`,
    `- radius: ${input.context.radiusMiles} miles`,
  ].join('\n');
}

export interface BedrockParserOptions {
  model: LanguageModel;
  /**
   * Whether the data source behind this deployment carries permit history. Fixed for the life
   * of the container, which is why it belongs to the parser rather than to a request.
   */
  permitsAvailable?: boolean;
  /** Kept well inside the API Gateway and Lambda 30-second ceilings. */
  timeoutMs?: number;
  /** Drafts cached per container. Bounded so a busy container cannot grow without limit. */
  cacheSize?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The filled-in draft is a small flat object — around twenty short fields. A generous ceiling
 * would not make a correct answer more likely, it would only let a confused generation run on
 * while the operator waits.
 */
const MAX_OUTPUT_TOKENS = 400;

const DEFAULT_CACHE_SIZE = 200;

/**
 * Cache key for a parse.
 *
 * The map centre and radius are deliberately **not** part of it. They appear in the prompt, but
 * the only thing the model does with a "here" question is answer `locationMode="current_map"` —
 * the actual coordinates are applied afterwards by the grounding layer, from the request. Keying
 * on them would miss the cache on every pixel of map movement while changing no answer. The date
 * is included because the prompt states today's date and relative ages depend on it.
 */
function cacheKey(input: NlqParseInput): string {
  return `${input.now.toISOString().slice(0, 10)}|${input.question.trim().toLowerCase()}`;
}

export function createNlqParser({
  model,
  permitsAvailable = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheSize = DEFAULT_CACHE_SIZE,
}: BedrockParserOptions): NlqParser {
  /**
   * Insertion-ordered, so evicting the oldest is `keys().next()`. Holds resolved drafts rather
   * than in-flight promises: a failed call must not be cached, and two identical questions
   * arriving together is not the case worth optimising for.
   */
  const cache = new Map<string, NlqQueryDraft>();

  return {
    async parse(input: NlqParseInput): Promise<NlqQueryDraft> {
      const key = cacheKey(input);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      const { object } = await generateObject({
        model,
        schema: nlqQueryDraftSchema,
        schemaName: 'PropertyQuery',
        schemaDescription: 'Structured filter set for a Seminole County property search.',
        system: buildSystemPrompt(input.now, permitsAvailable),
        prompt: buildUserPrompt(input),
        // Deterministic: the same question should parse to the same filters every time, or
        // the interpretation shown to the operator is not reproducible.
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // One retry only. A slow second attempt is worse than a clear failure message.
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });

      const draft = normaliseNlqDraft(object);

      if (cache.size >= cacheSize) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, draft);

      return draft;
    },
  };
}
