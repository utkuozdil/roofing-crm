import { describe, expect, it } from 'vitest';
import {
  SnapshotEmbeddingCache,
  briefFromEvidence,
  cosineSimilarity,
  documentEmbeddingCacheKey,
  embeddingSourceHash,
  groundCitations,
  opportunityEmbeddingText,
  questionEmbeddingCacheKey,
  ragConfidenceBand,
  rankByEmbedding,
  rerankByQuestion,
  retrieveOpportunities,
  toOpportunity,
  type OpportunitySource,
  type RetrievedOpportunity,
} from './rag';
import type { PermitRecord } from './property';

function permit(overrides: Partial<PermitRecord> = {}): PermitRecord {
  return {
    permit_number: '19-10001',
    structure_sequence: '1 0',
    permit_type_sequence: 'RR 1',
    application_type_code: 'R100',
    permit_type_code: 'RR REROOF',
    permit_type: 'Reroof residential',
    description: 'Residential reroof after storm damage',
    status: 'active',
    issued_date: '2019-04-11',
    closed_date: null,
    open_years: 6,
    open_years_observed_at: '2026-09-01',
    contractor_name: 'Central Florida Roofing Co',
    contractor_license: 'CCC1330001',
    bbb_lookup: 'rated',
    bbb_rating: 'A+',
    bbb_score: 97,
    bbb_accredited: true,
    valuation: 18500,
    is_roofing: true,
    ...overrides,
  };
}

function source(overrides: Partial<OpportunitySource> = {}): OpportunitySource {
  return {
    parcel_id: '30-19-30-5AC-0000-0010',
    owner_name: 'DOE JOHN',
    primary_address: '1204 PARK AVE, SANFORD, FL 32771',
    latitude: 28.8003,
    longitude: -81.2731,
    roof_age_years: 28,
    distance_miles: 1.2,
    total_just_value: 315000,
    permits: [permit()],
    ...overrides,
  };
}

function card(overrides: Partial<RetrievedOpportunity> = {}): RetrievedOpportunity {
  return {
    parcel_id: 'p-1',
    address: '100 MAIN ST, SANFORD, FL 32771',
    owner: 'DOE JOHN',
    roof_age_years: 22,
    distance_miles: 0.8,
    just_value: 280000,
    unresolved_roofing: 1,
    longest_open_years: 4,
    contractor_name: 'Central Florida Roofing Co',
    bbb_rating: 'A+',
    permit_description: 'Reroof',
    ...overrides,
  };
}

describe('toOpportunity', () => {
  it('counts only unresolved roofing permits and keeps the longest-open contractor', () => {
    const opportunity = toOpportunity(
      source({
        permits: [
          permit({
            permit_number: 'closed',
            status: 'closed',
            is_roofing: true,
            open_years: 1,
            contractor_name: 'Old Co',
          }),
          permit({
            permit_number: 'unknown',
            status: 'unknown',
            is_roofing: true,
            open_years: 20,
            contractor_name: 'Unknown Co',
          }),
          permit({
            permit_number: 'open-short',
            status: 'active',
            open_years: 2,
            contractor_name: 'Short Co',
            bbb_rating: 'B',
          }),
          permit({
            permit_number: 'open-long',
            status: 'active',
            open_years: 9,
            contractor_name: 'Long Co',
            bbb_rating: 'A',
          }),
        ],
      }),
    );

    expect(opportunity.unresolved_roofing).toBe(2);
    expect(opportunity.longest_open_years).toBe(9);
    expect(opportunity.contractor_name).toBe('Long Co');
    expect(opportunity.bbb_rating).toBe('A');
  });

  it('does not treat unknown status as an open roofing permit', () => {
    const opportunity = toOpportunity(
      source({
        permits: [permit({ status: 'unknown', open_years: 12, contractor_name: 'Maybe Co' })],
      }),
    );
    expect(opportunity.unresolved_roofing).toBe(0);
    expect(opportunity.longest_open_years).toBeNull();
    expect(opportunity.contractor_name).toBeNull();
  });
});

describe('retrieveOpportunities', () => {
  it('reranks a closer but unrelated parcel behind a farther storm-damage match', () => {
    const retrieved = retrieveOpportunities(
      [
        source({
          parcel_id: 'near',
          primary_address: '1 LAKE ST, LAKE MARY, FL 32746',
          distance_miles: 0.2,
          permits: [permit({ description: 'Kitchen remodel', contractor_name: 'Cabinets Inc' })],
        }),
        source({
          parcel_id: 'storm',
          primary_address: '90 PINE ST, SANFORD, FL 32771',
          distance_miles: 4.1,
          permits: [permit({ description: 'Residential reroof after storm damage' })],
        }),
      ],
      'storm damage roofing opportunities',
    );

    expect(retrieved.map((item) => item.parcel_id)).toEqual(['storm', 'near']);
  });
});

describe('rerankByQuestion', () => {
  it('keeps search order when the question has no overlapping tokens', () => {
    const ranked = rerankByQuestion('xyz', [card({ parcel_id: 'a' }), card({ parcel_id: 'b' })]);
    expect(ranked.map((item) => item.parcel_id)).toEqual(['a', 'b']);
  });
});

describe('groundCitations', () => {
  it('drops invented parcel ids and duplicates', () => {
    const evidence = [card({ parcel_id: 'real-1' }), card({ parcel_id: 'real-2' })];
    expect(groundCitations(['real-2', 'invented', 'real-2', 'real-1'], evidence)).toEqual([
      'real-2',
      'real-1',
    ]);
  });
});

describe('ragConfidenceBand', () => {
  it('falls back when nothing matched or the model did not run', () => {
    expect(ragConfidenceBand(0, [], true)).toBe('fallback');
    expect(ragConfidenceBand(4, ['p-1'], false)).toBe('fallback');
  });

  it('reviews a generated answer that cited nothing', () => {
    expect(ragConfidenceBand(4, [], true)).toBe('review');
  });

  it('auto-accepts a generated answer that cited retrieved parcels', () => {
    expect(ragConfidenceBand(4, ['p-1'], true)).toBe('auto_accept');
  });
});

describe('embedding text and cache keys', () => {
  it('changes the source hash when a permit description changes', () => {
    const before = opportunityEmbeddingText(card());
    const after = opportunityEmbeddingText(card({ permit_description: 'Hurricane reroof' }));
    expect(embeddingSourceHash(before)).not.toBe(embeddingSourceHash(after));
  });

  it('namespaces question vectors by snapshot so a republish cannot reuse them', () => {
    const first = questionEmbeddingCacheKey('run-1', 'amazon.titan-embed-text-v2:0', 'Old roofs');
    const sameQuestion = questionEmbeddingCacheKey(
      'run-2',
      'amazon.titan-embed-text-v2:0',
      'old   roofs',
    );
    expect(first).not.toBe(sameQuestion);
    expect(questionEmbeddingCacheKey('run-1', 'amazon.titan-embed-text-v2:0', 'OLD ROOFS')).toBe(
      first,
    );
  });

  it('drops cached vectors when the snapshot id changes', () => {
    const cache = new SnapshotEmbeddingCache();
    cache.bind('run-1');
    cache.set(documentEmbeddingCacheKey('run-1', 'abc'), [1, 0]);
    expect(cache.size).toBe(1);

    cache.bind('run-2');
    expect(cache.size).toBe(0);
    expect(cache.get(documentEmbeddingCacheKey('run-1', 'abc'))).toBeUndefined();
  });
});

describe('rankByEmbedding', () => {
  it('ranks the card whose vector is closer to the question', () => {
    const ranked = rankByEmbedding(
      [1, 0],
      [
        { opportunity: card({ parcel_id: 'far', distance_miles: 0.1 }), vector: [0, 1] },
        { opportunity: card({ parcel_id: 'near', distance_miles: 4 }), vector: [0.9, 0.1] },
      ],
    );
    expect(ranked.map((item) => item.parcel_id)).toEqual(['near', 'far']);
  });

  it('returns 0 similarity for mismatched lengths rather than throwing', () => {
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
  });
});

describe('briefFromEvidence', () => {
  it('names retrieved parcels and does not invent any', () => {
    const briefing = briefFromEvidence({
      matched: 12,
      centerLabel: 'Lake Mary, FL 32746',
      evidence: [card({ parcel_id: 'p-1', address: '100 MAIN ST, LAKE MARY, FL 32746' })],
    });

    expect(briefing.citedParcelIds).toEqual(['p-1']);
    expect(briefing.answer).toContain('100 MAIN ST');
    expect(briefing.answer).toContain('12 roofing opportunities');
    expect(briefing.answer).toContain('11 more matches');
    expect(briefing.band).toBe('fallback');
  });

  it('says the retrieved set is empty instead of guessing', () => {
    const briefing = briefFromEvidence({
      matched: 0,
      centerLabel: 'Geneva, FL 32732',
      evidence: [],
    });
    expect(briefing.citedParcelIds).toEqual([]);
    expect(briefing.answer).toContain('No matching roofing opportunities');
  });
});
