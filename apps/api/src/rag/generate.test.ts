import { describe, expect, it } from 'vitest';
import { generateRagBriefing, type RagGenerator } from './generate';
import type { RetrievedOpportunity } from '@roofing-crm/shared';

const card: RetrievedOpportunity = {
  parcel_id: 'real-1',
  address: '100 MAIN ST, LAKE MARY, FL 32746',
  owner: 'DOE JOHN',
  roof_age_years: 22,
  distance_miles: 0.8,
  just_value: 280000,
  unresolved_roofing: 1,
  longest_open_years: 4,
  contractor_name: 'Central Florida Roofing Co',
  bbb_rating: 'A+',
  permit_description: 'Reroof',
};

describe('generateRagBriefing', () => {
  it('strips invented citations from a model answer', async () => {
    const generator: RagGenerator = {
      generate: async (input) => ({
        answer: 'Invented parcel 99-FAKE is a great lead.',
        citedParcelIds: ['99-FAKE', 'real-1'],
        evidence: [...input.evidence],
        band: 'auto_accept',
      }),
    };

    const briefing = await generateRagBriefing(generator, {
      question: 'roofing opportunities near Lake Mary',
      matched: 1,
      centerLabel: 'Lake Mary, FL 32746',
      evidence: [card],
    });

    expect(briefing.citedParcelIds).toEqual(['real-1']);
  });

  it('falls back to the retrieved-card briefing when the model throws', async () => {
    const generator: RagGenerator = {
      generate: async () => {
        throw new Error('bedrock unreachable');
      },
    };

    const briefing = await generateRagBriefing(generator, {
      question: 'roofing opportunities near Lake Mary',
      matched: 3,
      centerLabel: 'Lake Mary, FL 32746',
      evidence: [card],
    });

    expect(briefing.answer).toContain('100 MAIN ST');
    expect(briefing.citedParcelIds).toEqual(['real-1']);
    expect(briefing.band).toBe('fallback');
  });

  it('does not call the model when the retrieved set is empty', async () => {
    let called = false;
    const generator: RagGenerator = {
      generate: async () => {
        called = true;
        throw new Error('should not run');
      },
    };

    const briefing = await generateRagBriefing(generator, {
      question: 'roofing opportunities near Geneva',
      matched: 0,
      centerLabel: 'Geneva, FL 32732',
      evidence: [],
    });

    expect(called).toBe(false);
    expect(briefing.citedParcelIds).toEqual([]);
    expect(briefing.answer).toContain('No matching roofing opportunities');
  });
});
