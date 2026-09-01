/**
 * The groundedness test.
 *
 * The parser is stubbed with a fixed draft, which is the point: the question is no longer the
 * variable, so what is under test is the claim the product makes — that the count in the
 * interpretation is the exact number of parcels the stated criteria admit, and that every one
 * of those parcels satisfies them. That is checked by re-running the returned query through
 * the same data source and re-applying `matchesFilters` to each row independently.
 *
 * This is what "structurally grounded" buys and what an embedding-based answer could not be
 * held to: there is a predicate to check the rows against.
 */

import {
  haversineMiles,
  resolveOutOfAreaOwner,
  isUnresolvedPermitStatus,
  matchesFilters,
  type NlqQueryDraft,
  type PropertySearchItem,
} from '@roofing-crm/shared';
import type { Logger } from '@aws-lambda-powertools/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { propertySource } from '../data/property-source';
import type { NlqParser } from '../nlq/parse';
import { appRouter } from './index';
import { setEmbeddingIndexForTesting, setNlqParserForTesting, setRagGeneratorForTesting } from './nlq';

/** Only the logger is read by these procedures; the rest of the Lambda context is irrelevant. */
const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function caller() {
  return appRouter.createCaller({ logger: noopLogger } as never);
}

function draft(overrides: Partial<NlqQueryDraft> = {}): NlqQueryDraft {
  return {
    intent: 'property_search',
    refusalReason: null,
    locationMode: 'county',
    place: null,
    radiusMiles: null,
    minRoofAgeYears: null,
    includeUnknownRoofAge: null,
    permitStatus: null,
    minPermitOpenYears: null,
    minYearsSinceLastSale: null,
    soldSinceYear: null,
    outOfAreaOwnerOnly: null,
    poolStatus: null,
    minJustValue: null,
    propertyTypes: null,
    sort: null,
    ...overrides,
  };
}

function stubParser(result: NlqQueryDraft | Error): NlqParser {
  return {
    parse: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** Re-runs the query the answer published, so the rows can be checked against the criteria. */
async function rowsFor(query: {
  center: { latitude: number; longitude: number };
  radiusMiles: number;
  filters: Parameters<typeof matchesFilters>[1];
  sort: 'distance' | 'roof_age' | 'permit_age' | 'just_value';
}): Promise<PropertySearchItem[]> {
  const result = await propertySource.search({ ...query, limit: 500 });
  return result.items;
}

afterEach(() => {
  setNlqParserForTesting(null);
  setRagGeneratorForTesting(null);
  setEmbeddingIndexForTesting(undefined);
});

describe('nlq.config', () => {
  it('reports the feature as unavailable with worked examples when no model is set', async () => {
    const previous = process.env.NLQ_MODEL_ID;
    delete process.env.NLQ_MODEL_ID;
    try {
      const config = await caller().nlq.config();
      expect(config.enabled).toBe(false);
      expect(config.modelId).toBeNull();
      expect(config.message).toContain('no language model is configured');
      // The disabled panel is made of these, so an empty list would render a blank state.
      expect(config.examples.length).toBeGreaterThanOrEqual(4);
      expect(config.capabilities.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.NLQ_MODEL_ID;
      else process.env.NLQ_MODEL_ID = previous;
    }
  });

  it('reports the configured model when one is set', async () => {
    const previous = process.env.NLQ_MODEL_ID;
    process.env.NLQ_MODEL_ID = 'us.amazon.nova-pro-v1:0';
    try {
      const config = await caller().nlq.config();
      expect(config.enabled).toBe(true);
      expect(config.modelId).toBe('us.amazon.nova-pro-v1:0');
      expect(config.message).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.NLQ_MODEL_ID;
      else process.env.NLQ_MODEL_ID = previous;
    }
  });
});

describe('nlq.ask degrades instead of failing', () => {
  it('reports unavailability rather than throwing when no model is configured', async () => {
    const previous = process.env.NLQ_MODEL_ID;
    delete process.env.NLQ_MODEL_ID;
    try {
      const answer = await caller().nlq.ask({ question: 'old roofs in Sanford' });
      expect(answer.status).toBe('unavailable');
      if (answer.status === 'unavailable') expect(answer.examples.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.NLQ_MODEL_ID;
      else process.env.NLQ_MODEL_ID = previous;
    }
  });

  /** A model outage must not break the panel, and must not look like an empty result set. */
  it('reports a model failure as a stated error, not an empty answer', async () => {
    setNlqParserForTesting(stubParser(new Error('bedrock unreachable')));
    const answer = await caller().nlq.ask({ question: 'old roofs in Sanford' });
    expect(answer.status).toBe('error');
    if (answer.status === 'error') {
      expect(answer.message).toContain('could not reach the language model');
      expect(answer.message).toContain('filters on the left');
    }
  });

  it('rejects an empty question at the input boundary', async () => {
    setNlqParserForTesting(stubParser(draft()));
    await expect(caller().nlq.ask({ question: '   ' })).rejects.toThrow();
  });

  it('rejects a question longer than the input limit', async () => {
    setNlqParserForTesting(stubParser(draft()));
    await expect(caller().nlq.ask({ question: 'roof '.repeat(200) })).rejects.toThrow();
  });

  it('returns a refusal with capabilities rather than an empty result set', async () => {
    setNlqParserForTesting(
      stubParser(draft({ intent: 'out_of_scope', refusalReason: 'The CRM holds no roof colour.' })),
    );
    const answer = await caller().nlq.ask({ question: 'what colour are the roofs' });
    expect(answer.status).toBe('refused');
    if (answer.status === 'refused') {
      expect(answer.message).toContain('can’t answer that');
      expect(answer.message).toContain('roof colour');
      expect(answer.capabilities.length).toBeGreaterThan(0);
    }
  });
});

describe('an answered question is grounded in the rows it describes', () => {
  it('reports a count that is exactly the number of parcels the filters admit', async () => {
    setNlqParserForTesting(
      stubParser(draft({ locationMode: 'place', place: 'Lake Mary', minRoofAgeYears: 20 })),
    );
    const answer = await caller().nlq.ask({
      question: 'houses near Lake Mary with roofs over 20 years old',
    });
    expect(answer.status).toBe('answered');
    if (answer.status !== 'answered') return;

    const rows = await rowsFor(answer.query);
    expect(rows).toHaveLength(answer.counts.matched);
    expect(answer.counts.matched).toBeGreaterThan(0);
    expect(answer.summary).toContain(`${answer.counts.matched} matches`);
  });

  it('returns only parcels that satisfy every stated criterion', async () => {
    setNlqParserForTesting(
      stubParser(
        draft({
          locationMode: 'place',
          place: 'Sanford',
          minRoofAgeYears: 25,
          outOfAreaOwnerOnly: true,
          permitStatus: 'unresolved',
        }),
      ),
    );
    const answer = await caller().nlq.ask({
      question: 'old roofs in Sanford with out-of-area owners and an open permit',
    });
    if (answer.status !== 'answered') throw new Error(`expected an answer, got ${answer.status}`);

    const rows = await rowsFor(answer.query);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // Checked field by field rather than by calling the same predicate the search used, so
      // this fails if the criteria and the filters ever stop describing the same thing.
      expect(row.roof_age_years).not.toBeNull();
      expect(row.roof_age_years!).toBeGreaterThanOrEqual(25);
      expect(resolveOutOfAreaOwner(row)).toBe(true);
      expect(row.permits.some((permit) => isUnresolvedPermitStatus(permit.status))).toBe(true);
      expect(haversineMiles(answer.query.center, row)).toBeLessThanOrEqual(
        answer.query.radiusMiles,
      );
    }
  });

  it.each([
    ['a pool and a recent sale', draft({ poolStatus: 'with_pool', soldSinceYear: 2020 })],
    ['long-held property', draft({ minYearsSinceLastSale: 20 })],
    [
      'high just value',
      draft({ outOfAreaOwnerOnly: true, minJustValue: 400_000, sort: 'just_value' }),
    ],
    ['an unresolved roofing permit', draft({ permitStatus: 'roofing_unresolved' })],
  ] as const)('holds for %s', async (_label, parsed) => {
    setNlqParserForTesting(stubParser(parsed));
    const answer = await caller().nlq.ask({ question: 'a question about ' + _label });
    if (answer.status !== 'answered') throw new Error(`expected an answer, got ${answer.status}`);

    const rows = await rowsFor(answer.query);
    expect(rows).toHaveLength(answer.counts.matched);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(matchesFilters(row, answer.query.filters, new Date())).toBe(true);
    }
  });

  it('publishes a criterion for every filter it turned on, and none for the rest', async () => {
    setNlqParserForTesting(
      stubParser(draft({ poolStatus: 'with_pool', soldSinceYear: 2020, propertyTypes: ['condo'] })),
    );
    const answer = await caller().nlq.ask({ question: 'condos with a pool sold since 2020' });
    if (answer.status !== 'answered') throw new Error('expected an answer');

    expect(answer.criteria.map((criterion) => criterion.key)).toEqual([
      'location',
      'sold_since',
      'pool',
      'property_type',
      'sort',
    ]);
  });

  /**
   * An empty result is a legitimate answer, but it must arrive with the interpretation and a
   * reason. A silently empty list is indistinguishable from a broken search.
   */
  it('explains an empty result instead of returning a bare zero', async () => {
    setNlqParserForTesting(
      stubParser(
        draft({
          locationMode: 'place',
          place: 'Geneva',
          radiusMiles: 1,
          minRoofAgeYears: 70,
          poolStatus: 'with_pool',
          minJustValue: 5_000_000,
        }),
      ),
    );
    const answer = await caller().nlq.ask({
      question: 'huge 70 year old roofs with pools within 1 mile of Geneva',
    });
    if (answer.status !== 'answered') throw new Error('expected an answer');

    expect(answer.counts.matched).toBe(0);
    expect(answer.summary).toContain('0 matches');
    expect(answer.criteria.length).toBeGreaterThan(1);
    expect(answer.notes.join(' ')).toContain('Relax one of them');
  });

  /** The 15-year default belongs to the map's own controls, not to an arbitrary question. */
  it('does not apply the app’s default roof-age threshold to a sale-history question', async () => {
    setNlqParserForTesting(stubParser(draft({ minYearsSinceLastSale: 20 })));
    const answer = await caller().nlq.ask({
      question: 'properties that haven’t sold in 20 years',
    });
    if (answer.status !== 'answered') throw new Error('expected an answer');

    expect(answer.query.filters.minRoofAgeYears).toBe(0);
    const rows = await rowsFor(answer.query);
    // Proof it is not merely permitted but actually present: newer roofs are in the result.
    expect(rows.some((row) => (row.roof_age_years ?? 99) < 15)).toBe(true);
  });

  it('states the unknown-roof-age exclusion whenever it applies a roof threshold', async () => {
    setNlqParserForTesting(stubParser(draft({ minRoofAgeYears: 20 })));
    const answer = await caller().nlq.ask({ question: 'roofs over 20 years old' });
    if (answer.status !== 'answered') throw new Error('expected an answer');

    expect(answer.notes.join(' ')).toContain('no recorded build year');
    expect(answer.counts.unknownRoofAgeInRadius).toBeGreaterThan(0);
  });

  it('returns a query the property search accepts unchanged', async () => {
    setNlqParserForTesting(stubParser(draft({ minRoofAgeYears: 20 })));
    const answer = await caller().nlq.ask({ question: 'roofs over 20 years old' });
    if (answer.status !== 'answered') throw new Error('expected an answer');

    // The SPA applies this query through `properties.search`, so it has to validate there.
    const viaRouter = await caller().properties.search({
      center: answer.query.center,
      radiusMiles: answer.query.radiusMiles,
      filters: answer.query.filters,
      sort: answer.query.sort,
    });
    expect(viaRouter.totalMatched).toBe(answer.counts.matched);
  });

  it('returns a briefing whose citations are retrieved parcels, not invented ones', async () => {
    setNlqParserForTesting(
      stubParser(draft({ locationMode: 'place', place: 'Lake Mary', minRoofAgeYears: 20 })),
    );
    const answer = await caller().nlq.ask({
      question: 'houses near Lake Mary with roofs over 20 years old',
    });
    if (answer.status !== 'answered') throw new Error(`expected an answer, got ${answer.status}`);

    expect(answer.answer.length).toBeGreaterThan(0);
    expect(answer.citedParcelIds.length).toBeGreaterThan(0);
    const retrieved = new Set(answer.evidence.map((card) => card.parcel_id));
    for (const id of answer.citedParcelIds) expect(retrieved.has(id)).toBe(true);

    const rows = await rowsFor(answer.query);
    const admitted = new Set(rows.map((row) => row.parcel_id));
    for (const card of answer.evidence) expect(admitted.has(card.parcel_id)).toBe(true);
  });
});
