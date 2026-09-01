import {
  DEFAULT_PROPERTY_FILTERS,
  SEMINOLE_COUNTY_BOUNDS,
  SEMINOLE_COUNTY_CENTER,
  SEMINOLE_PLACES,
  classifyRoofingPermit,
  computeGeohash5,
  haversineMiles,
  isOutOfAreaOwner,
  isUnresolvedPermitStatus,
  matchesFilters,
  permitNaturalKey,
  propertyDisplay,
} from '@roofing-crm/shared';
import { describe, expect, it } from 'vitest';
import { MEASURED_MISSING_RATES, loadPropertyFixtures } from './fixtures';
import { FixturePropertyDataSource, type PropertySearchQuery } from './property-source';

const NOW = new Date('2026-09-01T00:00:00.000Z');
const source = new FixturePropertyDataSource();
const fixtures = loadPropertyFixtures();

function query(overrides: Partial<PropertySearchQuery> = {}): PropertySearchQuery {
  return {
    center: SEMINOLE_COUNTY_CENTER,
    radiusMiles: 5,
    filters: { ...DEFAULT_PROPERTY_FILTERS, minRoofAgeYears: 0 },
    sort: 'distance',
    limit: 500,
    now: NOW,
    ...overrides,
  };
}

describe('the fixture dataset', () => {
  it('holds a few hundred rows across every gazetteer place', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(300);
    expect(fixtures.length).toBeLessThanOrEqual(600);
  });

  it('is deterministic across loads', () => {
    expect(loadPropertyFixtures()).toBe(fixtures);
    expect(fixtures[0]?.parcel_id).toBe(loadPropertyFixtures()[0]?.parcel_id);
  });

  it('gives every row a unique parcel id', () => {
    expect(new Set(fixtures.map((row) => row.parcel_id)).size).toBe(fixtures.length);
  });

  it('stores a geohash5 consistent with its own coordinates', () => {
    for (const row of fixtures) {
      expect(row.geohash5).toBe(computeGeohash5(row));
    }
  });

  it('places every row inside the county envelope', () => {
    for (const row of fixtures) {
      expect(row.latitude).toBeGreaterThanOrEqual(SEMINOLE_COUNTY_BOUNDS.minLatitude);
      expect(row.latitude).toBeLessThanOrEqual(SEMINOLE_COUNTY_BOUNDS.maxLatitude);
      expect(row.longitude).toBeGreaterThanOrEqual(SEMINOLE_COUNTY_BOUNDS.minLongitude);
      expect(row.longitude).toBeLessThanOrEqual(SEMINOLE_COUNTY_BOUNDS.maxLongitude);
    }
  });

  /**
   * The fixture reproduces the field-level sparsity measured across the 181,218 ingested
   * parcels. A tidier dataset would leave the address fallback and the unknown-roof-age
   * exclusion untested locally and then expose them on real data.
   */
  it.each(Object.entries(MEASURED_MISSING_RATES))(
    'reproduces the measured missing rate for %s',
    (field, rate) => {
      const missing = fixtures.filter(
        (row) => row[field as keyof typeof MEASURED_MISSING_RATES] === null,
      ).length;
      const observed = missing / fixtures.length;
      // Wide tolerance: a few hundred rows cannot land a 0.8% rate precisely, and the point
      // is that each gap has a real population rather than that it hits an exact frequency.
      expect(observed).toBeGreaterThan(rate * 0.4);
      expect(observed).toBeLessThan(rate * 2.2 + 0.02);
    },
  );

  /** Measured as always present, so an absence here would be a fixture bug. */
  it.each([
    'latitude',
    'longitude',
    'total_just_value',
    'assessed_value',
    'taxable_value',
  ] as const)('always populates %s', (field) => {
    for (const row of fixtures) {
      expect(row[field]).not.toBeNull();
    }
  });

  it('gives every unaddressed parcel a usable title and locality', () => {
    const unaddressed = fixtures.filter((row) => row.primary_address === null);
    expect(unaddressed.length).toBeGreaterThan(10);

    for (const row of unaddressed) {
      const display = propertyDisplay(row);
      expect(display.title).toContain(row.parcel_id);
      expect(display.locality).toMatch(/, FL \d{5}$/);
    }
  });

  it('derives is_roofing from the county application-type vocabulary', () => {
    const permits = fixtures.flatMap((row) => row.permits);
    expect(permits.length).toBeGreaterThan(50);

    for (const permit of permits) {
      expect(permit.is_roofing).toBe(
        classifyRoofingPermit({
          application_type_code: permit.application_type_code,
          permit_type_code: permit.permit_type_code,
          permit_type: permit.permit_type,
          description: permit.description,
        }).is_roofing,
      );
    }
    expect(permits.some((permit) => permit.is_roofing)).toBe(true);
    expect(permits.some((permit) => !permit.is_roofing)).toBe(true);
  });

  /** An application number covers several rows, so only the natural key is unique. */
  it('keeps permits on one parcel distinguishable by natural key', () => {
    for (const row of fixtures) {
      const keys = row.permits.map(permitNaturalKey);
      expect(new Set(keys).size).toBe(row.permits.length);
    }
  });

  /** Resolution is a terminal inspection date, which is not always captured. */
  it('includes resolved permits with no close date', () => {
    const unrecorded = fixtures.flatMap((row) =>
      row.permits.filter(
        (permit) =>
          (permit.status === 'complete' || permit.status === 'closed') &&
          permit.closed_date === null,
      ),
    );
    expect(unrecorded.length).toBeGreaterThan(0);
  });

  /** Each acceptance-criterion filter needs a non-empty population to be demonstrable. */
  it('contains enough of every lead signal to demonstrate each filter', () => {
    const withUnresolved = fixtures.filter((row) =>
      row.permits.some((permit) => isUnresolvedPermitStatus(permit.status)),
    );
    const withUnresolvedRoofing = withUnresolved.filter((row) =>
      row.permits.some((permit) => permit.is_roofing && isUnresolvedPermitStatus(permit.status)),
    );
    const staleRoofing = withUnresolvedRoofing.filter((row) =>
      row.permits.some((permit) => permit.is_roofing && permit.issued_date < '2020-01-01'),
    );
    const outOfArea = fixtures.filter((row) => isOutOfAreaOwner(row.mailing_city_state_zip));
    const missingBbb = fixtures.filter((row) =>
      row.permits.some((permit) => permit.contractor_name !== null && permit.bbb_rating === null),
    );

    expect(withUnresolved.length).toBeGreaterThan(30);
    expect(withUnresolvedRoofing.length).toBeGreaterThan(15);
    expect(staleRoofing.length).toBeGreaterThan(10);
    expect(outOfArea.length).toBeGreaterThan(15);
    expect(missingBbb.length).toBeGreaterThan(10);
  });
});

describe('radius search', () => {
  it('returns only properties inside the radius', async () => {
    const result = await source.search(query({ radiusMiles: 2 }));
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.distance_miles).toBeLessThanOrEqual(2);
      expect(haversineMiles(SEMINOLE_COUNTY_CENTER, item)).toBeLessThanOrEqual(2.01);
    }
  });

  /**
   * The geohash phase is an optimisation, so it must agree exactly with a brute-force
   * haversine sweep of the whole dataset. If it ever disagreed the CRM would silently
   * hide leads.
   */
  it('agrees with a brute-force scan of the whole dataset', async () => {
    for (const radiusMiles of [0.5, 2, 5, 12, 25]) {
      const result = await source.search(query({ radiusMiles }));
      const expected = fixtures
        .filter((row) => haversineMiles(SEMINOLE_COUNTY_CENTER, row) <= radiusMiles)
        .map((row) => row.parcel_id)
        .sort();
      expect([...result.items.map((item) => item.parcel_id)].sort()).toEqual(expected);
    }
  });

  it('reads fewer candidates than the dataset holds for a small radius', async () => {
    const result = await source.search(query({ radiusMiles: 1 }));
    expect(result.cellsScanned).toBeGreaterThan(0);
    expect(result.candidatesScanned).toBeLessThan(fixtures.length);
    expect(result.candidatesScanned).toBeGreaterThanOrEqual(result.items.length);
  });

  it('grows monotonically with the radius', async () => {
    const small = await source.search(query({ radiusMiles: 1 }));
    const large = await source.search(query({ radiusMiles: 6 }));
    expect(large.totalMatched).toBeGreaterThan(small.totalMatched);
  });

  it('centres on any point, not just the county centre', async () => {
    const oviedo = SEMINOLE_PLACES.find((place) => place.name === 'Oviedo')!;
    const result = await source.search(query({ center: oviedo, radiusMiles: 1.5 }));
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      // Unaddressed parcels are legitimate records and are never filtered out, so the
      // locality assertion goes through the display fallback rather than the raw address.
      const display = propertyDisplay(item);
      expect(item.primary_address ?? display.locality).toMatch(/OVIEDO|Oviedo/);
    }
  });

  it('applies the filters it was given', async () => {
    const filters = { ...DEFAULT_PROPERTY_FILTERS, minRoofAgeYears: 25 };
    const result = await source.search(query({ radiusMiles: 25, filters }));
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.roof_age_years).toBeGreaterThanOrEqual(25);
      expect(matchesFilters(item, filters, NOW)).toBe(true);
    }
    expect(result.totalInRadius).toBeGreaterThan(result.totalMatched);
  });

  it('narrows to unresolved roofing permits', async () => {
    const result = await source.search(
      query({
        radiusMiles: 25,
        filters: {
          ...DEFAULT_PROPERTY_FILTERS,
          minRoofAgeYears: 0,
          permitStatus: 'roofing_unresolved',
        },
      }),
    );
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(
        item.permits.some((permit) => permit.is_roofing && isUnresolvedPermitStatus(permit.status)),
      ).toBe(true);
    }
  });

  /**
   * The count behind the results-panel note. It has to be reported whether or not the
   * unknowns are being excluded, otherwise the UI cannot say what the threshold is doing.
   */
  describe('unknown roof age reporting', () => {
    it('counts in-radius parcels with no derivable roof age', async () => {
      const result = await source.search(query({ radiusMiles: 25 }));
      const expected = fixtures.filter(
        (row) =>
          haversineMiles(SEMINOLE_COUNTY_CENTER, row) <= 25 &&
          row.year_built === null &&
          !row.permits.some(
            (permit) =>
              permit.is_roofing && (permit.status === 'complete' || permit.status === 'closed'),
          ),
      ).length;

      expect(result.unknownRoofAgeInRadius).toBe(expected);
      expect(result.unknownRoofAgeInRadius).toBeGreaterThan(0);
    });

    it('reports the same count whether or not the unknowns are excluded', async () => {
      const excluded = await source.search(
        query({ radiusMiles: 25, filters: { ...DEFAULT_PROPERTY_FILTERS } }),
      );
      const included = await source.search(
        query({
          radiusMiles: 25,
          filters: { ...DEFAULT_PROPERTY_FILTERS, includeUnknownRoofAge: true },
        }),
      );

      expect(included.unknownRoofAgeInRadius).toBe(excluded.unknownRoofAgeInRadius);
      expect(included.totalMatched).toBe(excluded.totalMatched + excluded.unknownRoofAgeInRadius);
    });

    it('excludes unknown roof ages under the default filters', async () => {
      const result = await source.search(
        query({ radiusMiles: 25, filters: { ...DEFAULT_PROPERTY_FILTERS } }),
      );
      for (const item of result.items) {
        expect(item.roof_age_years).not.toBeNull();
      }
    });

    it('returns them when the operator opts in', async () => {
      const result = await source.search(
        query({
          radiusMiles: 25,
          filters: { ...DEFAULT_PROPERTY_FILTERS, includeUnknownRoofAge: true },
        }),
      );
      expect(result.items.some((item) => item.roof_age_years === null)).toBe(true);
    });
  });

  it('honours the limit while still reporting the full match count', async () => {
    const result = await source.search(query({ radiusMiles: 25, limit: 5 }));
    expect(result.items).toHaveLength(5);
    expect(result.totalMatched).toBeGreaterThan(5);
  });

  it.each([['distance', (a: number, b: number) => a <= b]])(
    'sorts by %s',
    async (_sort, ordered) => {
      const result = await source.search(query({ radiusMiles: 10 }));
      for (let index = 1; index < result.items.length; index += 1) {
        expect(
          ordered(result.items[index - 1]!.distance_miles, result.items[index]!.distance_miles),
        ).toBe(true);
      }
    },
  );

  it('sorts by roof age descending', async () => {
    const result = await source.search(query({ radiusMiles: 10, sort: 'roof_age' }));
    for (let index = 1; index < result.items.length; index += 1) {
      const previous = result.items[index - 1]!.roof_age_years ?? -1;
      const current = result.items[index]!.roof_age_years ?? -1;
      expect(previous).toBeGreaterThanOrEqual(current);
    }
  });

  it('sorts by longest-open permit descending', async () => {
    const result = await source.search(query({ radiusMiles: 25, sort: 'permit_age' }));
    const first = result.items[0]!;
    expect(first.permits.some((permit) => isUnresolvedPermitStatus(permit.status))).toBe(true);
  });

  it('returns an empty result far outside the county rather than throwing', async () => {
    const result = await source.search(
      query({ center: { latitude: 40.7128, longitude: -74.006 }, radiusMiles: 5 }),
    );
    expect(result.items).toEqual([]);
    expect(result.totalMatched).toBe(0);
  });
});

describe('getByParcelId', () => {
  it('round-trips a known parcel with its derived roof age', async () => {
    const known = fixtures[7]!;
    const property = await source.getByParcelId(known.parcel_id, NOW);
    expect(property?.parcel_id).toBe(known.parcel_id);
    expect(property?.owner_name).toBe(known.owner_name);
    expect(property?.permits).toEqual(known.permits);
    expect(property).toHaveProperty('roof_age_years');
  });

  it('returns null for an unknown parcel', async () => {
    expect(await source.getByParcelId('00-00-00-000-0000-0000')).toBeNull();
  });
});

describe('size', () => {
  it('reports the row count the provenance banner shows', async () => {
    expect(await source.size()).toBe(fixtures.length);
  });
});
