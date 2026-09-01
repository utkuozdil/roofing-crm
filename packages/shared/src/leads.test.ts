import { describe, expect, it } from 'vitest';
import { SEMINOLE_COUNTY_CENTER } from './seminole';
import {
  DEFAULT_LEAD_PIPELINE_FILTERS,
  leadFilterFactsFromProperty,
  matchesLeadFilters,
  type LeadRecord,
} from './leads';
import type { PermitRecord } from './property';

function permit(overrides: Partial<PermitRecord> = {}): PermitRecord {
  return {
    permit_number: '19-10001',
    structure_sequence: '1 0',
    permit_type_sequence: 'RR 1',
    application_type_code: 'R100',
    permit_type_code: 'RR REROOF',
    permit_type: 'Reroof residential',
    description: 'Residential reroof',
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

function lead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: 'abc',
    parcelId: 'p-1',
    status: 'new',
    ownerName: 'DOE JOHN',
    primaryAddress: '1204 PARK AVE, SANFORD, FL 32771',
    roofAgeYears: 28,
    latitude: 28.8003,
    longitude: -81.2731,
    permitCount: 1,
    unresolvedPermitCount: 1,
    unresolvedRoofingCount: 1,
    longestOpenYears: 6,
    source: 'Map radius search',
    notes: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('leadFilterFactsFromProperty', () => {
  it('does not count unknown status as an open roofing permit', () => {
    const facts = leadFilterFactsFromProperty({
      latitude: 28.8,
      longitude: -81.27,
      permits: [permit({ status: 'unknown', open_years: 20, is_roofing: true })],
    });
    expect(facts.permitCount).toBe(1);
    expect(facts.unresolvedPermitCount).toBe(0);
    expect(facts.unresolvedRoofingCount).toBe(0);
    expect(facts.longestOpenYears).toBeNull();
  });
});

describe('matchesLeadFilters', () => {
  it('shows every lead when the pipeline filters are at their defaults', () => {
    expect(matchesLeadFilters(lead(), DEFAULT_LEAD_PIPELINE_FILTERS, SEMINOLE_COUNTY_CENTER)).toBe(
      true,
    );
  });

  it('filters by roof age, unresolved roofing, open duration, and radius', () => {
    const filters = {
      minRoofAgeYears: 20,
      permitStatus: 'roofing_unresolved' as const,
      minPermitOpenYears: 5,
      radiusMiles: 10,
    };
    expect(matchesLeadFilters(lead(), filters, SEMINOLE_COUNTY_CENTER)).toBe(true);
    expect(matchesLeadFilters(lead({ roofAgeYears: 12 }), filters, SEMINOLE_COUNTY_CENTER)).toBe(
      false,
    );
    expect(
      matchesLeadFilters(lead({ unresolvedRoofingCount: 0 }), filters, SEMINOLE_COUNTY_CENTER),
    ).toBe(false);
    expect(matchesLeadFilters(lead({ longestOpenYears: 2 }), filters, SEMINOLE_COUNTY_CENTER)).toBe(
      false,
    );
    expect(
      matchesLeadFilters(
        lead({ latitude: 27.5, longitude: -82.5 }),
        filters,
        SEMINOLE_COUNTY_CENTER,
      ),
    ).toBe(false);
  });

  it('drops a lead with no coordinates once a radius is set', () => {
    expect(
      matchesLeadFilters(
        lead({ latitude: null, longitude: null }),
        { ...DEFAULT_LEAD_PIPELINE_FILTERS, radiusMiles: 5 },
        SEMINOLE_COUNTY_CENTER,
      ),
    ).toBe(false);
  });
});
