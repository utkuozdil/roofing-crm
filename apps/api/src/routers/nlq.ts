/**
 * Natural-language query endpoint.
 *
 * The contract is deliberately narrow: `ask` returns **a query, an interpretation, and a
 * count** — never rows. The SPA applies the returned query to the same state its own
 * controls write to, so the map, the filter inputs, and the results list all move together
 * and there is no second result set to drift out of agreement with the first.
 *
 * The count is still produced here, by running the grounded query through the very same
 * `PropertyDataSource.search` the SPA is about to call. That is what makes "34 matches"
 * auditable: it is the cardinality of the filter set, measured by the predicate the rows
 * will be measured by, not a number a model wrote down.
 */

import {
  MAX_QUESTION_LENGTH,
  NLQ_CAPABILITIES,
  NLQ_EXAMPLE_QUESTIONS,
  PERMIT_FILTER_MODES,
  POOL_FILTER_MODES,
  PROPERTY_TYPES,
  SEMINOLE_COUNTY_CENTER,
  formatNlqSummary,
  groundNlqQuery,
  type NlqCriterion,
} from '@roofing-crm/shared';
import { z } from 'zod';
import { propertySource } from '../data/property-source';
import { createNlqParser, type NlqParser } from '../nlq/parse';
import { nlqModel, readNlqModelConfig, type NlqModelConfig } from '../nlq/model';
import { publicProcedure, router } from '../trpc';

const geoPoint = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * The live map state, sent so a question can say "here". Filters are accepted for symmetry
 * with the panel's context preview but are not merged into the parsed query: a question
 * defines its own filter set, and silently inheriting whatever was on screen would make the
 * echoed interpretation untrue.
 */
const askInput = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  center: geoPoint.default(SEMINOLE_COUNTY_CENTER),
  radiusMiles: z.number().min(0.1).max(25).default(3),
});

const DISABLED_MESSAGE =
  'Natural-language search is switched off because no language model is configured for this environment. Every filter it would set is still available on the search panel to the left.';

const REFUSAL_PREFIX = 'I can’t answer that.';

/** Cached per container: reading the environment and building a signer per question is waste. */
let parserCache: { config: NlqModelConfig; parser: NlqParser } | undefined;

function resolveParser(): { config: NlqModelConfig; parser: NlqParser } | null {
  const config = readNlqModelConfig();
  if (!config) return null;
  if (parserCache && parserCache.config.modelId === config.modelId) return parserCache;
  parserCache = { config, parser: createNlqParser({ model: nlqModel(config) }) };
  return parserCache;
}

/** Overridable so tests exercise the grounding and search path without a model. */
let parserOverride: NlqParser | null = null;

export function setNlqParserForTesting(parser: NlqParser | null): void {
  parserOverride = parser;
}

export const nlqRouter = router({
  /**
   * Asked before the operator types, so the panel can render a disabled state with worked
   * examples instead of failing on submit.
   */
  config: publicProcedure.query(() => {
    const resolved = readNlqModelConfig();
    return {
      enabled: resolved !== null,
      modelId: resolved?.modelId ?? null,
      region: resolved?.region ?? null,
      examples: NLQ_EXAMPLE_QUESTIONS,
      capabilities: NLQ_CAPABILITIES,
      message: resolved === null ? DISABLED_MESSAGE : null,
      /** Published so the UI's chips and the API's parser cannot disagree about the vocabulary. */
      vocabulary: {
        permitStatus: PERMIT_FILTER_MODES,
        poolStatus: POOL_FILTER_MODES,
        propertyTypes: PROPERTY_TYPES,
      },
    };
  }),

  ask: publicProcedure.input(askInput).mutation(async ({ input, ctx }) => {
    const parser = parserOverride ?? resolveParser()?.parser ?? null;

    if (!parser) {
      ctx.logger.warn('Natural-language query attempted with no model configured');
      return {
        status: 'unavailable' as const,
        question: input.question,
        message: DISABLED_MESSAGE,
        examples: NLQ_EXAMPLE_QUESTIONS,
        capabilities: NLQ_CAPABILITIES,
      };
    }

    const now = new Date();
    const context = {
      question: input.question,
      center: input.center,
      radiusMiles: input.radiusMiles,
    };

    let draft;
    try {
      draft = await parser.parse({ question: input.question, context, now });
    } catch (error: unknown) {
      // The model call is the only part of this path that can fail for reasons outside the
      // operator's control. It degrades to a stated failure with the filter panel still
      // available, never to a broken panel.
      ctx.logger.error('Natural-language parse failed', {
        question: input.question,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'error' as const,
        question: input.question,
        message:
          'I could not reach the language model just now, so the question was not translated. Nothing was applied to the map — the filters on the left still work.',
        examples: NLQ_EXAMPLE_QUESTIONS,
        capabilities: NLQ_CAPABILITIES,
      };
    }

    const grounded = groundNlqQuery(draft, context, now);

    if (grounded.status === 'refused') {
      ctx.logger.info('Natural-language query refused', {
        question: input.question,
        reason: grounded.reason,
      });
      return {
        status: 'refused' as const,
        question: input.question,
        message: `${REFUSAL_PREFIX} ${grounded.reason}`,
        examples: NLQ_EXAMPLE_QUESTIONS,
        capabilities: NLQ_CAPABILITIES,
      };
    }

    const { query } = grounded;

    // The same call the SPA is about to make. Running it here is what lets the summary state
    // a count that the rows will bear out.
    const result = await propertySource.search({
      center: query.center,
      radiusMiles: query.radiusMiles,
      filters: query.filters,
      sort: query.sort,
      limit: 200,
      now,
    });

    const notes = [...query.notes, ...countNotes(query.criteria, result.totalMatched)];

    ctx.logger.info('Natural-language query answered', {
      question: input.question,
      centerLabel: query.centerLabel,
      radiusMiles: query.radiusMiles,
      criteria: query.criteria.map((criterion) => criterion.key),
      totalMatched: result.totalMatched,
      totalInRadius: result.totalInRadius,
    });

    return {
      status: 'answered' as const,
      question: input.question,
      /** Applied by the SPA to its own search state; the chat holds no rows of its own. */
      query: {
        center: query.center,
        centerLabel: query.centerLabel,
        radiusMiles: query.radiusMiles,
        filters: query.filters,
        sort: query.sort,
      },
      criteria: query.criteria,
      notes,
      summary: formatNlqSummary(query.criteria, result.totalMatched),
      counts: {
        matched: result.totalMatched,
        inRadius: result.totalInRadius,
        unknownRoofAgeInRadius: result.unknownRoofAgeInRadius,
      },
      examples: NLQ_EXAMPLE_QUESTIONS,
    };
  }),
});

/**
 * An empty result is a real answer, not a failure — but it must never be a silent one, so it
 * comes with the reason it is empty and the next thing to try.
 */
function countNotes(criteria: readonly NlqCriterion[], matched: number): string[] {
  if (matched > 0) return [];
  const narrowed = criteria.filter(
    (criterion) => criterion.key !== 'sort' && criterion.key !== 'location',
  );
  return [
    narrowed.length > 0
      ? `No parcel satisfies all ${narrowed.length + 1} criteria at once. Relax one of them — every filter is on the search panel and adjustable there.`
      : 'No parcels fall inside that radius. Try a wider radius or a different place.',
  ];
}
