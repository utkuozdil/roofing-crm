import { describe, expect, it } from 'vitest';
import { CachedEmbeddingIndex } from './embeddings';
import { retrieveRankedOpportunities, snapshotIdFromProvenance } from './retrieve';
import type { EmbeddingService, OpportunitySource, PermitRecord } from '@roofing-crm/shared';

function permit(overrides: Partial<PermitRecord> = {}): PermitRecord {
  return {
    permit_number: '19-10001',
    structure_sequence: '1 0',
    permit_type_sequence: 'RR 1',
    application_type_code: 'R100',
    permit_type_code: 'RR REROOF',
    permit_type: 'Reroof residential',
    description: 'Residential reroof, shingle',
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

function item(overrides: Partial<OpportunitySource> = {}): OpportunitySource {
  return {
    parcel_id: 'near',
    owner_name: 'DOE JOHN',
    primary_address: '1 LAKE ST, LAKE MARY, FL 32746',
    latitude: 28.76,
    longitude: -81.32,
    roof_age_years: 20,
    distance_miles: 0.2,
    total_just_value: 300000,
    permits: [permit({ description: 'Kitchen remodel' })],
    ...overrides,
  };
}

/** Token-bucket embedder so "storm" ranks the storm-damage card without Bedrock. */
function lexicalEmbedder(): EmbeddingService {
  return {
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(16).fill(0);
        for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
          if (token.length < 3) continue;
          let hash = 0;
          for (let index = 0; index < token.length; index += 1) {
            hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
          }
          const slot = hash % 16;
          vector[slot] = (vector[slot] ?? 0) + 1;
        }
        return vector;
      });
    },
  };
}

describe('snapshotIdFromProvenance', () => {
  it('joins parcel and permit run ids so either publish busts the cache', () => {
    expect(
      snapshotIdFromProvenance({
        provider: 'published-parquet',
        snapshot: { runId: 'parcels-1' },
        permits: { runId: 'permits-9' },
      }),
    ).toBe('parcels-1+permits-9');
  });

  it('uses the fixture provider name when no snapshot has been published', () => {
    expect(snapshotIdFromProvenance({ provider: 'fixture' })).toBe('fixture+none');
  });
});

describe('retrieveRankedOpportunities', () => {
  it('ranks a farther storm-damage card above a closer remodel when embeddings run', async () => {
    const index = new CachedEmbeddingIndex(lexicalEmbedder(), 'test-embed');
    index.bind('run-1');

    const retrieved = await retrieveRankedOpportunities({
      question: 'storm damage roofing opportunities',
      index,
      items: [
        item(),
        item({
          parcel_id: 'storm',
          primary_address: '90 PINE ST, SANFORD, FL 32771',
          distance_miles: 4.1,
          permits: [permit({ description: 'Residential reroof after storm damage' })],
        }),
      ],
    });

    expect(retrieved.method).toBe('embedding');
    expect(retrieved.evidence.map((card) => card.parcel_id)[0]).toBe('storm');
  });

  it('falls back to lexical ranking when the embedder throws', async () => {
    const index = new CachedEmbeddingIndex(
      {
        embed: async () => {
          throw new Error('titan down');
        },
      },
      'test-embed',
    );
    index.bind('run-1');

    const retrieved = await retrieveRankedOpportunities({
      question: 'storm damage roofing opportunities',
      index,
      items: [
        item(),
        item({
          parcel_id: 'storm',
          distance_miles: 4.1,
          permits: [permit({ description: 'Residential reroof after storm damage' })],
        }),
      ],
    });

    expect(retrieved.method).toBe('lexical');
    expect(retrieved.evidence.map((card) => card.parcel_id)[0]).toBe('storm');
  });
});
