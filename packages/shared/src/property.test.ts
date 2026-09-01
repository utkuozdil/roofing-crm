import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROPERTY_FILTERS,
  NO_ADDRESS_ON_RECORD,
  NO_OWNER_ON_RECORD,
  computeGeohash5,
  deriveRoofAgeYears,
  isOutOfAreaOwner,
  matchesFilters,
  permitDuration,
  permitOpenYears,
  propertyDisplay,
  type PermitRecord,
  type PropertyDetail,
} from './property';

const NOW = new Date('2026-09-01T00:00:00.000Z');

function permit(overrides: Partial<PermitRecord> = {}): PermitRecord {
  return {
    permit_number: '19-10001',
    structure_sequence: 1,
    permit_type_sequence: 1,
    application_type_code: 'R100',
    permit_type_code: 'RR REROOF',
    permit_type: 'Reroof residential',
    description: 'Residential reroof, shingle',
    status: 'active',
    issued_date: '2019-04-11',
    closed_date: null,
    contractor_name: 'Central Florida Roofing Co',
    contractor_license: 'CCC1330001',
    bbb_rating: 'A+',
    bbb_score: 4.6,
    bbb_accredited: true,
    valuation: 18500,
    is_roofing: true,
    ...overrides,
  };
}

function property(overrides: Partial<PropertyDetail> = {}): PropertyDetail {
  const base: PropertyDetail = {
    parcel_id: '30-19-30-5AC-0000-0010',
    owner_name: 'DOE JOHN',
    primary_address: '1204 PARK AVE, SANFORD, FL 32771',
    mailing_city_state_zip: 'SANFORD, FL 32771',
    property_type: 'single_family',
    year_built: 1998,
    last_sale_date: '2005-06-14',
    last_sale_amount: 182000,
    total_just_value: 315000,
    assessed_value: 240000,
    taxable_value: 190000,
    total_living_area: 1780,
    total_bedrooms: 3,
    total_bathrooms: 2,
    has_pool: false,
    latitude: 28.8003,
    longitude: -81.2731,
    geohash5: 'djn0e',
    roof_age_years: 28,
    permits: [],
    ...overrides,
  };
  return base;
}

describe('deriveRoofAgeYears', () => {
  it('falls back to the build year when no roofing permit exists', () => {
    expect(deriveRoofAgeYears({ year_built: 1998 }, [], NOW)).toBe(28);
  });

  it('resets the clock on a signed-off roofing permit', () => {
    const closed = permit({ status: 'closed', closed_date: '2016-08-01' });
    expect(deriveRoofAgeYears({ year_built: 1998 }, [closed], NOW)).toBe(10);
  });

  /** An unresolved permit means the work was never certified, so the roof is still old. */
  it.each(['active', 'blocked', 'pre_issuance'] as const)(
    'ignores a roofing permit in %s status',
    (status) => {
      expect(deriveRoofAgeYears({ year_built: 1998 }, [permit({ status })], NOW)).toBe(28);
    },
  );

  /** Voided work never happened, so it must not make an old roof look new. */
  it('ignores a voided roofing permit', () => {
    const voided = permit({ status: 'void', closed_date: '2016-08-01' });
    expect(deriveRoofAgeYears({ year_built: 1998 }, [voided], NOW)).toBe(28);
  });

  /** The source has no explicit close date, so resolution can arrive without one. */
  it('uses the application date when a resolved permit has no close date', () => {
    const resolved = permit({ status: 'complete', issued_date: '2014-03-02', closed_date: null });
    expect(deriveRoofAgeYears({ year_built: 1998 }, [resolved], NOW)).toBe(12);
  });

  it('ignores non-roofing permits entirely', () => {
    const pool = permit({ status: 'complete', closed_date: '2020-01-01', is_roofing: false });
    expect(deriveRoofAgeYears({ year_built: 1998 }, [pool], NOW)).toBe(28);
  });

  it('is null when neither signal is available', () => {
    expect(deriveRoofAgeYears({ year_built: null }, [], NOW)).toBeNull();
  });
});

describe('permitOpenYears', () => {
  it('measures elapsed time for an unresolved permit', () => {
    expect(permitOpenYears(permit({ issued_date: '2019-09-01' }), NOW)).toBeCloseTo(7, 1);
  });

  it('is zero for a resolved permit regardless of issue date', () => {
    expect(permitOpenYears(permit({ status: 'complete', issued_date: '2001-01-01' }), NOW)).toBe(0);
  });
});

describe('permitDuration', () => {
  it('reports elapsed years while work is open', () => {
    const duration = permitDuration(permit({ issued_date: '2019-09-01' }), NOW);
    expect(duration.state).toBe('open');
    expect(duration.years).toBeCloseTo(7, 1);
  });

  /**
   * Verified against permit 21-13064: opened 07/07/21, FINAL ROOF approved 25/10/2021,
   * which the source records as 110 days.
   */
  it('measures resolution against the terminal inspection date', () => {
    const duration = permitDuration(
      permit({ status: 'complete', issued_date: '2021-07-07', closed_date: '2021-10-25' }),
      NOW,
    );
    expect(duration.state).toBe('resolved');
    expect(duration.resolvedOn).toBe('2021-10-25');
    expect(duration.years! * 365).toBeCloseTo(110, 0);
  });

  /** Zero would invent a same-day turnaround the county never recorded. */
  it('reports unrecorded rather than zero when a resolved permit has no close date', () => {
    const duration = permitDuration(permit({ status: 'closed', closed_date: null }), NOW);
    expect(duration.state).toBe('unrecorded');
    expect(duration.years).toBeNull();
  });

  it('separates a voided permit from a resolved one', () => {
    expect(permitDuration(permit({ status: 'void' }), NOW).state).toBe('void');
  });
});

describe('propertyDisplay', () => {
  it('uses the address when the county has one', () => {
    const display = propertyDisplay(property());
    expect(display.title).toBe('1204 PARK AVE, SANFORD, FL 32771');
    expect(display.isAddressMissing).toBe(false);
    expect(display.locality).toBeNull();
  });

  /** ~9.1% of parcels. They are real records, so they get a real title. */
  it('falls back to the parcel id and nearest municipality when the address is missing', () => {
    const display = propertyDisplay(property({ primary_address: null }));
    expect(display.title).toBe('Parcel 30-19-30-5AC-0000-0010');
    expect(display.isAddressMissing).toBe(true);
    expect(display.locality).toBe('Sanford, FL 32771');
  });

  it('treats a whitespace-only address as missing', () => {
    expect(propertyDisplay(property({ primary_address: '   ' })).isAddressMissing).toBe(true);
  });

  it('names the owner gap explicitly', () => {
    const display = propertyDisplay(property({ owner_name: null }));
    expect(display.owner).toBe(NO_OWNER_ON_RECORD);
    expect(display.isOwnerMissing).toBe(true);
  });

  it('never returns an empty title', () => {
    expect(NO_ADDRESS_ON_RECORD).not.toBe('');
    expect(propertyDisplay(property({ primary_address: null })).title.length).toBeGreaterThan(0);
  });
});

describe('isOutOfAreaOwner', () => {
  it.each(['SANFORD, FL 32771', 'LAKE MARY, FL 32746', 'OVIEDO FL 32765'])(
    'treats %s as in-county',
    (mailing) => {
      expect(isOutOfAreaOwner(mailing)).toBe(false);
    },
  );

  it.each(['NEW YORK, NY 10011', 'TORONTO, ON M5V 2T6', 'MIAMI, FL 33101'])(
    'treats %s as out-of-area',
    (mailing) => {
      expect(isOutOfAreaOwner(mailing)).toBe(true);
    },
  );

  /** A ZIP inside the county wins even when the city string is an unlisted subdivision. */
  it('trusts an in-county ZIP over an unrecognised city name', () => {
    expect(isOutOfAreaOwner('BLACK HAMMOCK, FL 32732')).toBe(false);
  });
});

describe('matchesFilters', () => {
  it('applies the 15-year default roof age threshold', () => {
    expect(matchesFilters(property({ roof_age_years: 28 }), DEFAULT_PROPERTY_FILTERS, NOW)).toBe(
      true,
    );
    expect(matchesFilters(property({ roof_age_years: 4 }), DEFAULT_PROPERTY_FILTERS, NOW)).toBe(
      false,
    );
  });

  /**
   * The documented default. ~10.6% of the county has no build year, so this exclusion is
   * load-bearing and the UI states it rather than letting it happen quietly.
   */
  it('excludes an unknown roof age by default when a threshold is set', () => {
    expect(DEFAULT_PROPERTY_FILTERS.includeUnknownRoofAge).toBe(false);
    expect(matchesFilters(property({ roof_age_years: null }), DEFAULT_PROPERTY_FILTERS, NOW)).toBe(
      false,
    );
  });

  it('admits an unknown roof age when the operator opts in', () => {
    const filters = { ...DEFAULT_PROPERTY_FILTERS, includeUnknownRoofAge: true };
    expect(matchesFilters(property({ roof_age_years: null }), filters, NOW)).toBe(true);
  });

  /** Opting in must not also admit a roof that is merely too new. */
  it('still applies the threshold to a known roof age when unknowns are included', () => {
    const filters = { ...DEFAULT_PROPERTY_FILTERS, includeUnknownRoofAge: true };
    expect(matchesFilters(property({ roof_age_years: 4 }), filters, NOW)).toBe(false);
    expect(matchesFilters(property({ roof_age_years: 28 }), filters, NOW)).toBe(true);
  });

  it('filters on unresolved permits', () => {
    const filters = { ...DEFAULT_PROPERTY_FILTERS, permitStatus: 'unresolved' as const };
    expect(matchesFilters(property({ permits: [permit()] }), filters, NOW)).toBe(true);
    expect(matchesFilters(property({ permits: [] }), filters, NOW)).toBe(false);
    expect(
      matchesFilters(property({ permits: [permit({ status: 'complete' })] }), filters, NOW),
    ).toBe(false);
  });

  it('narrows to unresolved roofing permits', () => {
    const filters = { ...DEFAULT_PROPERTY_FILTERS, permitStatus: 'roofing_unresolved' as const };
    expect(
      matchesFilters(property({ permits: [permit({ is_roofing: false })] }), filters, NOW),
    ).toBe(false);
    expect(matchesFilters(property({ permits: [permit()] }), filters, NOW)).toBe(true);
  });

  it('filters on how long a permit has been open', () => {
    const filters = { ...DEFAULT_PROPERTY_FILTERS, minPermitOpenYears: 5 };
    expect(
      matchesFilters(property({ permits: [permit({ issued_date: '2010-01-01' })] }), filters, NOW),
    ).toBe(true);
    expect(
      matchesFilters(property({ permits: [permit({ issued_date: '2025-01-01' })] }), filters, NOW),
    ).toBe(false);
  });

  it('filters on years since last sale', () => {
    const filters = { ...DEFAULT_PROPERTY_FILTERS, minYearsSinceLastSale: 10 };
    expect(matchesFilters(property({ last_sale_date: '2005-06-14' }), filters, NOW)).toBe(true);
    expect(matchesFilters(property({ last_sale_date: '2024-06-14' }), filters, NOW)).toBe(false);
    expect(matchesFilters(property({ last_sale_date: null }), filters, NOW)).toBe(false);
  });

  it('filters on out-of-area ownership', () => {
    const filters = { ...DEFAULT_PROPERTY_FILTERS, outOfAreaOwnerOnly: true };
    expect(matchesFilters(property(), filters, NOW)).toBe(false);
    expect(
      matchesFilters(property({ mailing_city_state_zip: 'NEW YORK, NY 10011' }), filters, NOW),
    ).toBe(true);
  });

  it('passes everything through when the roof threshold is zero', () => {
    const filters = { ...DEFAULT_PROPERTY_FILTERS, minRoofAgeYears: 0 };
    expect(matchesFilters(property({ roof_age_years: null }), filters, NOW)).toBe(true);
  });
});

describe('computeGeohash5', () => {
  it('produces a five-character hash from the coordinate pair', () => {
    const hash = computeGeohash5({ latitude: 28.8003, longitude: -81.2731 });
    expect(hash).toHaveLength(5);
    expect(hash).toMatch(/^[0-9b-hjkmnp-z]{5}$/);
  });
});
