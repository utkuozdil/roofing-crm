/**
 * Tests for the published-snapshot source.
 *
 * The centrepiece is the equivalence check: the source filters against typed arrays rather than
 * materialised records, which is a performance decision that would be a correctness disaster if
 * the two ever drifted. Every filter combination is run through both the column predicate and
 * the shared `matchesFilters` over the same rows, and the verdicts must match. If someone adds a
 * filter to the shared predicate and forgets this file, that test fails.
 *
 * Snapshots are built from plain objects shaped like the publisher's Parquet rows, so none of
 * this needs S3, credentials, or a Parquet fixture.
 */

import {
  DEFAULT_PROPERTY_FILTERS,
  type PropertyFilters,
  type SearchSort,
  encodeGeohash,
  haversineMiles,
  matchesFilters,
} from '@roofing-crm/shared';
import { describe, expect, it } from 'vitest';
import {
  ParcelSnapshotBuilder,
  buildParcelSnapshot,
  cellFromKey,
  classifyPropertyType,
  loadParcelSnapshot,
  type ParcelSnapshotPointer,
  type SnapshotStore,
} from './parcel-snapshot';
import {
  buildPermitSnapshot,
  type PermitSnapshotPointer,
  permitsForParcel,
} from './permit-snapshot';
import { PublishedPropertyDataSource, type SnapshotProvider } from './published-source';

const NOW = new Date('2026-09-01T00:00:00.000Z');

/** Lake Mary, near enough to the real gazetteer entry to sit in a plausible cell. */
const CENTER = { latitude: 28.7589, longitude: -81.3178 };

interface RowOverrides {
  parcel_id?: string;
  owner_name?: string | null;
  primary_address?: string | null;
  mailing_city_state_zip?: string | null;
  dor_code?: string | null;
  vacant_improved?: string | null;
  year_built?: number | null;
  roof_age?: number | null;
  last_sale_date?: Date | null;
  last_sale_amount?: number | null;
  total_just_value?: number | null;
  assessed_value?: number | null;
  taxable_value?: number | null;
  total_living_area?: number | null;
  total_bedrooms?: number | null;
  total_bathrooms?: number | null;
  has_pool?: boolean | null;
  owner_out_of_area?: boolean | null;
  latitude?: number;
  longitude?: number;
}

let sequence = 0;

function row(overrides: RowOverrides = {}): Record<string, unknown> {
  sequence += 1;
  return {
    parcel_id: `parcel-${sequence}`,
    owner_name: 'DOE JOHN',
    primary_address: '1204 PARK AVE SANFORD FL 32771',
    mailing_city_state_zip: 'SANFORD, FL 32771',
    dor_code: '01 - SINGLE FAMILY',
    vacant_improved: 'Improved',
    year_built: 1998,
    roof_age: 28,
    last_sale_date: new Date('2005-06-14T00:00:00.000Z'),
    last_sale_amount: 182000,
    total_just_value: 315000,
    assessed_value: 240000,
    taxable_value: 190000,
    total_living_area: 1780,
    total_bedrooms: 3,
    total_bathrooms: 2,
    has_pool: false,
    owner_out_of_area: false,
    latitude: CENTER.latitude,
    longitude: CENTER.longitude,
    ...overrides,
  };
}

function pointer(parcelCount: number): ParcelSnapshotPointer {
  return {
    runId: 'test-run',
    county: 'Seminole County, FL',
    snapshotPrefix: 's3://bucket/publish/parcels/snapshot=test-run/',
    parcelCount,
    publishedAt: '2026-09-01T14:16:20.247Z',
  };
}

function snapshotOf(rows: Record<string, unknown>[]) {
  const byCell = new Map<string, Record<string, unknown>[]>();
  for (const record of rows) {
    const cell = encodeGeohash(record.latitude as number, record.longitude as number, 5);
    const bucket = byCell.get(cell);
    if (bucket) bucket.push(record);
    else byCell.set(cell, [record]);
  }
  return buildParcelSnapshot(
    pointer(rows.length),
    [...byCell.entries()].map(([cell, cellRows]) => ({ cell, rows: cellRows })),
  );
}

/** A permit row shaped like the publisher's, defaulting to the common case: status unharvested. */
function permitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parcel_id: 'parcel-1',
    parcel_published: true,
    application_no: '01-1234',
    structure_sequence: '0 0',
    permit_type_sequence: 'BPC 0',
    issued_on: new Date('2001-05-04T00:00:00.000Z'),
    closed_on: null,
    permit_type: 'BPC BUILDING PERMIT COMMERCIAL',
    permit_type_code: 'BPC',
    description: 'C998 SIDING/AWNINGS/ALUM ROOF/CANOPY COMM',
    application_type_code: 'C998',
    roofing_relevant: true,
    contractor_name: 'ORANGE STATE INDUSTRIES INC',
    valuation_usd: 12_000n,
    status_canonical: null,
    status_raw: null,
    open_years: null,
    open_duration_observed_at: null,
    bbb_lookup: 'not_searched',
    bbb_rating: null,
    bbb_rating_score: null,
    bbb_accredited: null,
    ...overrides,
  };
}

/**
 * The publisher's `parcel-index.parquet`, derived from the same permit rows.
 *
 * Derived rather than hand-written so the cross-check in `buildPermitSnapshot` is comparing two
 * genuinely independent counts of one population, the way it does against the real artifacts.
 */
function indexFor(permitRows: Record<string, unknown>[]): Record<string, unknown>[] {
  const byParcel = new Map<string, Record<string, unknown>[]>();
  for (const record of permitRows) {
    const parcelId = record.parcel_id as string;
    const bucket = byParcel.get(parcelId);
    if (bucket) bucket.push(record);
    else byParcel.set(parcelId, [record]);
  }

  return [...byParcel.entries()].map(([parcelId, rows]) => {
    const open = rows.filter((record) => record.status_canonical === 'active');
    return {
      parcel_id: parcelId,
      permit_count: rows.length,
      application_count: new Set(rows.map((record) => record.application_no)).size,
      first_permit_on: new Date('1998-01-01T00:00:00.000Z'),
      last_permit_on: new Date('2004-01-01T00:00:00.000Z'),
      open_permit_count: open.length,
      open_roofing_permit_count: open.filter((record) => record.roofing_relevant === true).length,
      unknown_status_permit_count: rows.filter((record) => record.status_canonical === null).length,
      max_open_years: open.reduce(
        (max, record) => Math.max(max, (record.open_years as number | null) ?? 0),
        0,
      ),
    };
  });
}

async function permitSnapshotOf(
  parcels: ReturnType<typeof snapshotOf>,
  permitRows: Record<string, unknown>[],
) {
  return buildPermitSnapshot(permitPointer(permitRows.length), parcels, {
    index: indexFor(permitRows),
    permitChunks: (async function* () {
      // Two chunks, so the fold is exercised across a boundary the way the real load is.
      const middle = Math.ceil(permitRows.length / 2);
      yield permitRows.slice(0, middle);
      yield permitRows.slice(middle);
    })(),
    bytes: 1024,
    fetchMs: () => 0,
  });
}

function permitPointer(rows: number): PermitSnapshotPointer {
  return {
    runId: 'permits-test',
    county: 'Seminole County, FL',
    publishedAt: '2026-09-01T16:59:40.693Z',
    referenceDate: '2026-09-01T15:39:45.000Z',
    files: {
      permits: { key: 'publish/permits/snapshot=permits-test/permits.parquet', rows },
      parcelIndex: { key: 'publish/permits/snapshot=permits-test/parcel-index.parquet', rows },
    },
    coverage: {
      census: { firstMonth: '1996-01', lastMonth: '2026-01', months: 361, complete: false },
      status: { applicationsWithStatus: 124, applicationsTotal: 309_369 },
      absenceMeaning: 'A parcel absent from the index had no permit issued between 1996 and 2026.',
    },
  };
}

function sourceOf(
  rows: Record<string, unknown>[],
  permitRows?: Record<string, unknown>[],
): PublishedPropertyDataSource {
  const parcels = snapshotOf(rows);
  const provider: SnapshotProvider = {
    get: async () => ({
      parcels,
      permits: permitRows === undefined ? null : await permitSnapshotOf(parcels, permitRows),
    }),
  };
  return new PublishedPropertyDataSource(provider);
}

const search = (
  source: PublishedPropertyDataSource,
  filters: Partial<PropertyFilters> = {},
  sort: SearchSort = 'distance',
) =>
  source.search({
    center: CENTER,
    radiusMiles: 5,
    filters: { ...DEFAULT_PROPERTY_FILTERS, minRoofAgeYears: 0, ...filters },
    sort,
    limit: 100,
    now: NOW,
  });

describe('classifyPropertyType', () => {
  it('reads the county DOR families present in the published snapshot', () => {
    expect(classifyPropertyType('01 - SINGLE FAMILY', 'Improved')).toBe('single_family');
    expect(classifyPropertyType('0130 - SINGLE FAMILY WATERFRONT', 'Improved')).toBe(
      'single_family',
    );
    expect(classifyPropertyType('0103 - TOWNHOME', 'Improved')).toBe('townhouse');
    expect(classifyPropertyType('04 - CONDOMINIUM', 'Improved')).toBe('condo');
    expect(classifyPropertyType('0403 - CONDO (APT CONVERSION)', 'Improved')).toBe('condo');
    expect(classifyPropertyType('02 - MOBILE/MANUFACTURED HOME', 'Improved')).toBe('mobile_home');
    expect(classifyPropertyType('0802 - MULTI FAMILY 2 UNITS', 'Improved')).toBe('multi_family');
    expect(classifyPropertyType('03 - MULTI FAMILY 10 OR MORE', 'Improved')).toBe('multi_family');
    expect(classifyPropertyType('00 - VACANT RESIDENTIAL', 'Vacant')).toBe('vacant');
    expect(classifyPropertyType('09 - RESIDENTIAL COMMON ELEMENTS/AREAS', 'Vacant')).toBe('vacant');
    expect(classifyPropertyType('71 - CHURCHES', 'Improved')).toBe('commercial');
    expect(classifyPropertyType('48 - WAREHOUSE-DISTR & STORAGE', 'Improved')).toBe('commercial');
  });

  it('trusts the county vacancy flag over the land-use family', () => {
    // 92 parcels really do carry a single-family code with no structure on them.
    expect(classifyPropertyType('01 - SINGLE FAMILY', 'Vacant')).toBe('vacant');
  });

  it('classifies an unknown or absent code as commercial rather than as a house', () => {
    expect(classifyPropertyType(null, null)).toBe('commercial');
    expect(classifyPropertyType('', null)).toBe('commercial');
  });
});

describe('snapshot construction', () => {
  it('coerces the county nulls the publisher actually emits', async () => {
    const source = sourceOf([
      row({
        parcel_id: 'sparse',
        owner_name: null,
        primary_address: null,
        mailing_city_state_zip: null,
        year_built: null,
        roof_age: null,
        last_sale_date: null,
        total_just_value: null,
        has_pool: null,
        owner_out_of_area: null,
      }),
    ]);

    const detail = await source.getByParcelId('sparse');
    expect(detail).not.toBeNull();
    expect(detail?.owner_name).toBeNull();
    expect(detail?.primary_address).toBeNull();
    expect(detail?.mailing_city_state_zip).toBeNull();
    expect(detail?.year_built).toBeNull();
    expect(detail?.roof_age_years).toBeNull();
    expect(detail?.last_sale_date).toBeNull();
    expect(detail?.total_just_value).toBeNull();
    // A missing boolean is false for a pool but *unknown* for absentee ownership: one is a
    // feature the county records, the other is a verdict it could not reach.
    expect(detail?.has_pool).toBe(false);
    expect(detail?.owner_out_of_area).toBeNull();
  });

  it('reads a DATE column that arrives as epoch days rather than a Date', async () => {
    const source = sourceOf([row({ parcel_id: 'epoch-days', last_sale_date: 20000 as never })]);
    const detail = await source.getByParcelId('epoch-days');
    expect(detail?.last_sale_date).toBe('2024-10-04');
  });

  it('skips a row with no parcel id rather than indexing it under an empty key', () => {
    const snapshot = snapshotOf([row(), row({ parcel_id: null as never }), row()]);
    expect(snapshot.count).toBe(2);
    expect(snapshot.byParcelId.has('')).toBe(false);
  });

  it('truncates rather than growing past the count the pointer states', () => {
    const builder = new ParcelSnapshotBuilder(pointer(1));
    builder.add({ cell: 'djn5h', rows: [row(), row(), row()] });
    expect(builder.finish(0).count).toBe(1);
  });

  it('records each cell as a contiguous range and reports the cell back on a row', async () => {
    const near = row({ parcel_id: 'near' });
    const far = row({ parcel_id: 'far', latitude: 28.81, longitude: -81.27 });
    const snapshot = snapshotOf([near, far]);

    expect(snapshot.cellRanges.size).toBe(2);
    for (const ranges of snapshot.cellRanges.values()) {
      expect(ranges).toHaveLength(1);
    }

    const source = sourceOf([near, far]);
    const detail = await source.getByParcelId('near');
    expect(detail?.geohash5).toBe(encodeGeohash(CENTER.latitude, CENTER.longitude, 5));
  });

  it('handles one cell split across two objects', () => {
    const snapshot = buildParcelSnapshot(pointer(2), [
      { cell: 'djn5h', rows: [row()] },
      { cell: 'djn5h', rows: [row()] },
    ]);
    expect(snapshot.cellRanges.get('djn5h')).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
    expect(snapshot.count).toBe(2);
  });
});

describe('cellFromKey', () => {
  it('reads the Hive partition key out of the object path', () => {
    expect(
      cellFromKey('publish/parcels/snapshot=recon-1/geohash5=djn5h/part-00004.c000.snappy.parquet'),
    ).toBe('djn5h');
  });

  it('returns null for a path that is not partitioned by geohash5', () => {
    expect(cellFromKey('publish/parcels/snapshot=recon-1/part-00004.parquet')).toBeNull();
  });
});

describe('radius search', () => {
  it('reads only the cells the radius can touch, then measures exact distance', async () => {
    const inside = row({ parcel_id: 'inside' });
    // Roughly 12 miles north: a different cell, and outside a 5-mile radius.
    const outside = row({ parcel_id: 'outside', latitude: 28.93, longitude: -81.3178 });
    const source = sourceOf([inside, outside]);

    const result = await search(source);

    expect(result.items.map((item) => item.parcel_id)).toEqual(['inside']);
    expect(result.totalInRadius).toBe(1);
    // The far parcel's cell is never opened, so it is not even a candidate.
    expect(result.candidatesScanned).toBe(1);
    expect(result.cellsScanned).toBeGreaterThan(1);
  });

  it('drops a candidate inside the bounding box but outside the true circle', async () => {
    /**
     * A geohash-5 cell is around three miles across, so a parcel can share the centre's cell and
     * still sit outside a one-mile radius. Found by walking the cell rather than hand-picked, so
     * the test keeps testing the haversine pass rather than a coordinate that happened to work.
     */
    const centreCell = encodeGeohash(CENTER.latitude, CENTER.longitude, 5);
    let cellMate: { latitude: number; longitude: number } | null = null;
    for (let step = 1; step <= 40 && cellMate === null; step += 1) {
      const candidate = {
        latitude: CENTER.latitude + step * 0.0005,
        longitude: CENTER.longitude + step * 0.0005,
      };
      const sameCell = encodeGeohash(candidate.latitude, candidate.longitude, 5) === centreCell;
      const beyondRadius = haversineMiles(CENTER, candidate) > 1;
      if (sameCell && beyondRadius) cellMate = candidate;
    }
    expect(cellMate).not.toBeNull();

    const corner = row({
      parcel_id: 'corner',
      ...(cellMate as { latitude: number; longitude: number }),
    });
    const source = sourceOf([row({ parcel_id: 'centre' }), corner]);

    const result = await source.search({
      center: CENTER,
      radiusMiles: 1,
      filters: { ...DEFAULT_PROPERTY_FILTERS, minRoofAgeYears: 0 },
      sort: 'distance',
      limit: 100,
      now: NOW,
    });

    expect(result.items.map((item) => item.parcel_id)).toEqual(['centre']);
    expect(result.candidatesScanned).toBeGreaterThan(result.totalInRadius);
  });

  it('counts unknown roof age in the radius even when the filter excludes it', async () => {
    const source = sourceOf([
      row({ parcel_id: 'known', roof_age: 30 }),
      row({ parcel_id: 'unknown', roof_age: null, year_built: null }),
    ]);

    const result = await search(source, { minRoofAgeYears: 20 });

    expect(result.items.map((item) => item.parcel_id)).toEqual(['known']);
    expect(result.totalInRadius).toBe(2);
    expect(result.unknownRoofAgeInRadius).toBe(1);
  });

  it('reports totalMatched beyond the page it returns', async () => {
    const rows = Array.from({ length: 12 }, () => row());
    const source = sourceOf(rows);

    const result = await source.search({
      center: CENTER,
      radiusMiles: 5,
      filters: { ...DEFAULT_PROPERTY_FILTERS, minRoofAgeYears: 0 },
      sort: 'distance',
      limit: 5,
      now: NOW,
    });

    expect(result.items).toHaveLength(5);
    expect(result.totalMatched).toBe(12);
  });
});

/**
 * The permit filters, evaluated against the aggregates the load builds.
 *
 * The population that matters is tiny and specific — 13 parcels county-wide carry a
 * confirmed-open roofing permit — so these tests are written around the shape that produces it:
 * one open roofing permit among a crowd of permits whose lifecycle nobody has harvested.
 */
describe('permit filters', () => {
  const OPEN = {
    status_canonical: 'active',
    status_raw: 'PERMIT ISSUED',
    open_years: 24.84,
    open_duration_observed_at: new Date('2026-09-01T15:39:45.000Z'),
  };

  const parcels = [row({ parcel_id: 'parcel-open' }), row({ parcel_id: 'parcel-unknown' })];
  const permits = [
    permitRow({ parcel_id: 'parcel-open', ...OPEN }),
    permitRow({ parcel_id: 'parcel-unknown', application_no: '01-9999' }),
  ];

  it('matches only the parcel with an unresolved roofing permit', async () => {
    const source = sourceOf(parcels, permits);
    const result = await search(source, { permitStatus: 'roofing_unresolved' });

    expect(result.items.map((item) => item.parcel_id)).toEqual(['parcel-open']);
    expect(result.unsupportedFilters).toEqual([]);
  });

  /**
   * The trap the whole feature turns on. 21 of the 23 confirmed-open permits carry no
   * application date, so a duration derived from `issued_date` would score them zero and this
   * filter would return nothing while looking like a correct empty result.
   */
  it('uses the county measurement, not the application date, for an open-years floor', async () => {
    const source = sourceOf(
      [row({ parcel_id: 'undated' })],
      [permitRow({ parcel_id: 'undated', ...OPEN, issued_on: null })],
    );

    const result = await search(source, { minPermitOpenYears: 3 });
    expect(result.items.map((item) => item.parcel_id)).toEqual(['undated']);

    const detail = await source.getByParcelId('undated');
    expect(detail?.permits[0]?.issued_date).toBeNull();
    expect(detail?.permits[0]?.open_years).toBeCloseTo(24.84, 2);
  });

  /** A permit nobody has looked at is not an open permit, and it is not a closed one either. */
  it('does not treat an unharvested status as open', async () => {
    const source = sourceOf(parcels, permits);
    const result = await search(source, { permitStatus: 'unresolved' });
    expect(result.items.map((item) => item.parcel_id)).toEqual(['parcel-open']);

    const unknown = await source.getByParcelId('parcel-unknown');
    expect(unknown?.permits[0]?.status).toBe('unknown');
  });

  /** "No permit history" means none in the published window, which is a real, filterable state. */
  it('matches a parcel with no permit at all for permitStatus none', async () => {
    const source = sourceOf([...parcels, row({ parcel_id: 'parcel-none' })], permits);
    const result = await search(source, { permitStatus: 'none' });
    expect(result.items.map((item) => item.parcel_id)).toEqual(['parcel-none']);
  });

  it('reports how much of the radius the permit history cannot speak for', async () => {
    const source = sourceOf([...parcels, row({ parcel_id: 'parcel-none' })], permits);
    const result = await search(source);

    expect(result.permitCoverage).toEqual({
      withoutPermitsInRadius: 1,
      unknownPermitStatusInRadius: 1,
    });
  });

  it('sorts by the longest-open permit', async () => {
    const source = sourceOf(
      [row({ parcel_id: 'shorter' }), row({ parcel_id: 'longer' })],
      [
        permitRow({ parcel_id: 'shorter', ...OPEN, open_years: 4.1 }),
        permitRow({ parcel_id: 'longer', ...OPEN, open_years: 26.6 }),
      ],
    );

    const result = await search(source, {}, 'permit_age');
    expect(result.items.map((item) => item.parcel_id)).toEqual(['longer', 'shorter']);
  });
});

/**
 * A permit publish can be rolled back or fail, and the honest degradation is to say the filter
 * was dropped rather than to answer zero. This is the same reasoning the source used when
 * `publish/` genuinely carried no permits, kept reachable for when it does not.
 */
describe('unsupported filters with no permit history loaded', () => {
  it('reports a permit filter as unsupported and does not apply it', async () => {
    const source = sourceOf([row({ parcel_id: 'a' }), row({ parcel_id: 'b' })]);

    const result = await search(source, { permitStatus: 'roofing_unresolved' });

    // Both rows still come back: the source cannot evaluate the filter, so it says so rather
    // than returning zero and implying the county has no open roofing permits.
    expect(result.totalMatched).toBe(2);
    expect(result.unsupportedFilters).toEqual([
      {
        filter: 'permitStatus',
        reason: 'Permit history is not loaded, so no permit filter can be evaluated.',
      },
    ]);
    expect(result.permitCoverage).toBeNull();
  });

  it('reports a permit-open-years floor and a permit-age sort', async () => {
    const source = sourceOf([row()]);
    const result = await search(source, { minPermitOpenYears: 3 }, 'permit_age');
    expect(result.unsupportedFilters.map((entry) => entry.filter)).toEqual([
      'minPermitOpenYears',
      'sort',
    ]);
  });

  it('reports nothing unsupported for a query that avoids permits', async () => {
    const source = sourceOf([row()]);
    const result = await search(source, { minRoofAgeYears: 20, poolStatus: 'any' });
    expect(result.unsupportedFilters).toEqual([]);
  });

  it('states the permit capability without loading the snapshot', () => {
    let loaded = false;
    const source = new PublishedPropertyDataSource({
      get: async () => {
        loaded = true;
        return { parcels: snapshotOf([row()]), permits: null };
      },
    });
    // The natural-language endpoint reads this before deciding whether a question is
    // answerable, and it cannot afford a 50 MB load to find out.
    expect(source.permitsAvailable).toBe(true);
    expect(loaded).toBe(false);
  });
});

describe('sorting', () => {
  it('orders by roof age with unknown ages last', async () => {
    const source = sourceOf([
      row({ parcel_id: 'young', roof_age: 5 }),
      row({ parcel_id: 'unknown', roof_age: null }),
      row({ parcel_id: 'old', roof_age: 40 }),
    ]);

    const result = await search(source, { includeUnknownRoofAge: true }, 'roof_age');
    expect(result.items.map((item) => item.parcel_id)).toEqual(['old', 'young', 'unknown']);
  });

  it('orders by just value with unrecorded values last', async () => {
    const source = sourceOf([
      row({ parcel_id: 'cheap', total_just_value: 100_000 }),
      row({ parcel_id: 'unrecorded', total_just_value: null }),
      row({ parcel_id: 'dear', total_just_value: 900_000 }),
    ]);

    const result = await search(source, {}, 'just_value');
    expect(result.items.map((item) => item.parcel_id)).toEqual(['dear', 'cheap', 'unrecorded']);
  });

  it('falls back to distance when asked to sort by permit age with no permits loaded', async () => {
    const near = row({ parcel_id: 'near' });
    const further = row({ parcel_id: 'further', latitude: 28.77, longitude: -81.3178 });
    const source = sourceOf([further, near]);

    const result = await search(source, {}, 'permit_age');
    expect(result.items.map((item) => item.parcel_id)).toEqual(['near', 'further']);
  });
});

describe('absentee owners', () => {
  it("uses the publisher's verdict rather than re-deriving it from the mailing address", async () => {
    // FOREST CITY is inside the county but is not a municipality the local city list knows, so
    // the derived answer and the published one disagree. The published one wins.
    const source = sourceOf([
      row({
        parcel_id: 'local',
        mailing_city_state_zip: 'FOREST CITY, FL 32703',
        owner_out_of_area: false,
      }),
      row({
        parcel_id: 'absentee',
        mailing_city_state_zip: 'NEW YORK, NY 10001',
        owner_out_of_area: true,
      }),
    ]);

    const result = await search(source, { outOfAreaOwnerOnly: true });
    expect(result.items.map((item) => item.parcel_id)).toEqual(['absentee']);
  });

  it('does not report an owner as absentee when the publisher could not tell', async () => {
    const source = sourceOf([
      row({ parcel_id: 'unknown', mailing_city_state_zip: null, owner_out_of_area: null }),
    ]);
    const result = await search(source, { outOfAreaOwnerOnly: true });
    expect(result.totalMatched).toBe(0);
  });
});

describe('roof age', () => {
  it('reports the published roof age rather than deriving it from the build year', async () => {
    // A re-roofed structure: the publisher measures from the effective year built, so its
    // roof_age is younger than the original build year implies.
    const source = sourceOf([row({ parcel_id: 'reroofed', year_built: 1960, roof_age: 4 })]);
    const detail = await source.getByParcelId('reroofed');
    expect(detail?.year_built).toBe(1960);
    expect(detail?.roof_age_years).toBe(4);
  });
});

/**
 * The column predicate and the shared record predicate must agree.
 *
 * This is the load-bearing test of the whole module. The search path reads per-parcel aggregates
 * built at load time; the detail path materialises `PermitRecord`s and runs the shared
 * `matchesFilters` over them. Those are two implementations of one definition, and the permit
 * clauses are where they are most likely to drift — the aggregates are counted with the CRM's
 * roofing vocabulary and the county's own open-duration measurement, and if either side used a
 * different one the results list would badge parcels the filter excludes.
 */
describe('column predicate matches the shared record predicate', () => {
  const rows = [
    row({ parcel_id: 'plain' }),
    row({ parcel_id: 'no-roof-age', roof_age: null, year_built: null }),
    row({ parcel_id: 'no-sale', last_sale_date: null }),
    row({ parcel_id: 'recent-sale', last_sale_date: new Date('2023-03-02T00:00:00.000Z') }),
    row({ parcel_id: 'no-value', total_just_value: null }),
    row({ parcel_id: 'pool', has_pool: true }),
    row({
      parcel_id: 'absentee',
      owner_out_of_area: true,
      mailing_city_state_zip: 'DENVER, CO 80202',
    }),
    row({ parcel_id: 'unknown-owner', owner_out_of_area: null, mailing_city_state_zip: null }),
    row({ parcel_id: 'condo', dor_code: '04 - CONDOMINIUM' }),
    row({ parcel_id: 'townhouse', dor_code: '0103 - TOWNHOME' }),
    row({
      parcel_id: 'vacant',
      dor_code: '00 - VACANT RESIDENTIAL',
      vacant_improved: 'Vacant',
      roof_age: null,
      year_built: null,
    }),
    row({ parcel_id: 'young-roof', roof_age: 3, year_built: 2023 }),
    row({ parcel_id: 'dear', total_just_value: 1_250_000 }),
  ];

  /**
   * Permit rows spanning every case the aggregates have to get right: an open roofing permit the
   * county measured but never dated, an open permit that is not roofing, a resolved one, a
   * voided one, and the common case of a permit nobody has looked at.
   */
  const permits = [
    permitRow({
      parcel_id: 'plain',
      status_canonical: 'active',
      status_raw: 'PERMIT ISSUED',
      open_years: 24.84,
      issued_on: null,
      open_duration_observed_at: new Date('2026-09-01T15:39:45.000Z'),
    }),
    permitRow({ parcel_id: 'plain', application_no: '01-2222' }),
    permitRow({
      parcel_id: 'pool',
      application_no: '02-3333',
      application_type_code: 'A972',
      description: 'A972 ELECTRICAL - RESIDENTIAL',
      permit_type: 'ELMS ELECTRIC MISCELLANEOUS',
      permit_type_code: 'ELMS',
      roofing_relevant: false,
      status_canonical: 'active',
      status_raw: 'PERMIT ISSUED',
      open_years: 6.2,
    }),
    permitRow({
      parcel_id: 'condo',
      application_no: '03-4444',
      status_canonical: 'complete',
      status_raw: 'PERMIT COMPLETE',
      closed_on: new Date('2004-08-01T00:00:00.000Z'),
    }),
    permitRow({
      parcel_id: 'townhouse',
      application_no: '04-5555',
      status_canonical: 'void',
      status_raw: 'VOIDED',
    }),
    permitRow({ parcel_id: 'no-sale', application_no: '05-6666' }),
    permitRow({
      parcel_id: 'dear',
      application_no: '06-7777',
      status_canonical: 'active',
      status_raw: 'PERMIT ISSUED',
      open_years: 1.4,
    }),
    permitRow({
      parcel_id: 'absentee',
      application_no: '07-8888',
      status_canonical: 'active',
      status_raw: 'PERMIT ISSUED',
      open_years: 11.5,
    }),
  ];

  const filterCases: { name: string; filters: Partial<PropertyFilters> }[] = [
    { name: 'any unresolved permit', filters: { permitStatus: 'unresolved' } },
    { name: 'unresolved roofing permit', filters: { permitStatus: 'roofing_unresolved' } },
    { name: 'no permit history', filters: { permitStatus: 'none' } },
    { name: 'permit open at least 3 years', filters: { minPermitOpenYears: 3 } },
    { name: 'permit open at least 20 years', filters: { minPermitOpenYears: 20 } },
    {
      name: 'unresolved roofing permit open at least 3 years',
      filters: { permitStatus: 'roofing_unresolved', minPermitOpenYears: 3 },
    },
    { name: 'defaults with no roof floor', filters: {} },
    { name: 'roof age 20', filters: { minRoofAgeYears: 20 } },
    {
      name: 'roof age 20 including unknown',
      filters: { minRoofAgeYears: 20, includeUnknownRoofAge: true },
    },
    { name: 'roof age 15 default exclusion', filters: { minRoofAgeYears: 15 } },
    { name: 'sold since 2020', filters: { soldSinceYear: 2020 } },
    { name: 'no sale in 20 years', filters: { minYearsSinceLastSale: 20 } },
    { name: 'with pool', filters: { poolStatus: 'with_pool' } },
    { name: 'without pool', filters: { poolStatus: 'without_pool' } },
    { name: 'absentee owners', filters: { outOfAreaOwnerOnly: true } },
    { name: 'value floor', filters: { minJustValue: 400_000 } },
    {
      name: 'residential types',
      filters: {
        propertyTypes: ['single_family', 'condo', 'townhouse', 'mobile_home', 'multi_family'],
      },
    },
    { name: 'condos only', filters: { propertyTypes: ['condo'] } },
    { name: 'vacant only', filters: { propertyTypes: ['vacant'] } },
    {
      name: 'everything at once',
      filters: {
        minRoofAgeYears: 20,
        includeUnknownRoofAge: true,
        soldSinceYear: 0,
        minYearsSinceLastSale: 10,
        poolStatus: 'without_pool',
        outOfAreaOwnerOnly: true,
        minJustValue: 200_000,
        propertyTypes: ['single_family', 'condo'],
        permitStatus: 'unresolved',
      },
    },
  ];

  for (const testCase of filterCases) {
    it(`agrees on: ${testCase.name}`, async () => {
      const source = sourceOf(rows, permits);
      const filters: PropertyFilters = {
        ...DEFAULT_PROPERTY_FILTERS,
        minRoofAgeYears: 0,
        ...testCase.filters,
      };

      const result = await search(source, testCase.filters);
      const columnVerdict = new Set(result.items.map((item) => item.parcel_id));

      const recordVerdict = new Set<string>();
      for (const record of rows) {
        const detail = await source.getByParcelId(record.parcel_id as string);
        if (detail === null) continue;
        if (matchesFilters(detail, filters, NOW)) recordVerdict.add(detail.parcel_id);
      }

      expect([...columnVerdict].sort()).toEqual([...recordVerdict].sort());
      // A filter set that excludes everything would make the comparison vacuous.
      expect(recordVerdict.size + columnVerdict.size).toBeGreaterThan(0);
    });
  }
});

describe('loadParcelSnapshot', () => {
  it('reads the prefix from the pointer and ignores non-Parquet objects', async () => {
    const requested: string[] = [];
    const store: SnapshotStore = {
      readPointer: async () => pointer(1),
      listKeys: async (prefix) => {
        requested.push(prefix);
        return [
          'publish/parcels/snapshot=test-run/_SUCCESS',
          'publish/parcels/snapshot=test-run/geohash5=djn5h/part-0.parquet',
        ];
      },
      getObject: async () => {
        throw new Error('should not fetch');
      },
    };

    // The prefix is stripped of the s3:// bucket portion before listing.
    await expect(loadParcelSnapshot(store, pointer(1))).rejects.toThrow('should not fetch');
    expect(requested).toEqual(['publish/parcels/snapshot=test-run/']);
  });

  it('fails loudly when the snapshot prefix holds no Parquet objects', async () => {
    const store: SnapshotStore = {
      readPointer: async () => pointer(1),
      listKeys: async () => ['publish/parcels/snapshot=test-run/_SUCCESS'],
      getObject: async () => new Uint8Array(),
    };

    await expect(loadParcelSnapshot(store, pointer(1))).rejects.toThrow('no Parquet objects');
  });
});

describe('provenance', () => {
  it('names both published snapshots and carries the permit coverage through', async () => {
    const source = sourceOf(
      [row({ parcel_id: 'with-permit' }), row({ parcel_id: 'without' })],
      [permitRow({ parcel_id: 'with-permit' })],
    );
    const provenance = await source.provenance();

    expect(provenance.provider).toBe('published-parquet');
    expect(provenance.county).toBe('Seminole County, FL');
    expect(provenance.rowCount).toBe(2);
    expect(provenance.permitsAvailable).toBe(true);
    expect(provenance.snapshot?.runId).toBe('test-run');
    expect(provenance.note).toContain('permits-test');

    /**
     * The coverage block is what keeps the count honest on screen. Every field is a bound on
     * what an absence means, and it comes from the publisher's manifest rather than from a
     * sentence written here that would drift from it.
     */
    expect(provenance.permits).toMatchObject({
      runId: 'permits-test',
      permitRows: 1,
      parcelsWithPermits: 1,
      parcelsTotal: 2,
      firstMonth: '1996-01',
      lastMonth: '2026-01',
      windowComplete: false,
      applicationsWithStatus: 124,
      applicationsTotal: 309_369,
      referenceDate: '2026-09-01T15:39:45.000Z',
    });
    expect(provenance.permits?.absenceMeaning).toContain('1996');
  });

  it('states that permits are not loaded when the pointer is missing', async () => {
    const source = sourceOf([row()]);
    const provenance = await source.provenance();

    expect(provenance.permitsAvailable).toBe(false);
    expect(provenance.permits).toBeUndefined();
    expect(provenance.note).toContain('Permit history is not loaded');
  });
});

/**
 * The trade lines the detail panel renders, and the two mappings that would otherwise produce
 * plausible-looking wrong data.
 */
describe('permit records', () => {
  it('maps the county lifecycle into the CRM vocabulary rather than collapsing it', async () => {
    const source = sourceOf(
      [row({ parcel_id: 'p' })],
      [
        permitRow({ parcel_id: 'p', status_canonical: 'active', status_raw: 'PERMIT ISSUED' }),
        permitRow({
          parcel_id: 'p',
          application_no: '01-2',
          status_canonical: 'pre_issuance',
          status_raw: 'IN APPROVAL',
        }),
        permitRow({
          parcel_id: 'p',
          application_no: '01-3',
          status_canonical: 'blocked',
          status_raw: 'ON HOLD',
        }),
      ],
    );

    const detail = await source.getByParcelId('p');
    // The artifact's four-value `status` calls all three of these `open`; the CRM's seven-value
    // vocabulary keeps them apart, which is what the detail panel's labels are for.
    expect(detail?.permits.map((permit) => permit.status)).toEqual([
      'active',
      'pre_issuance',
      'blocked',
    ]);
  });

  it('keeps the composite sequence tokens the county actually renders', async () => {
    const source = sourceOf(
      [row({ parcel_id: 'p' })],
      [permitRow({ parcel_id: 'p', structure_sequence: '0 0', permit_type_sequence: 'BPFN 0' })],
    );

    const detail = await source.getByParcelId('p');
    expect(detail?.permits[0]?.structure_sequence).toBe('0 0');
    expect(detail?.permits[0]?.permit_type_sequence).toBe('BPFN 0');
  });

  it('distinguishes the four kinds of missing BBB rating', async () => {
    const source = sourceOf(
      [row({ parcel_id: 'p' })],
      [
        permitRow({ parcel_id: 'p', bbb_lookup: 'searched_no_match' }),
        permitRow({ parcel_id: 'p', application_no: '01-2', bbb_lookup: 'not_searched' }),
        permitRow({ parcel_id: 'p', application_no: '01-3', bbb_lookup: 'matched_unrated' }),
        permitRow({
          parcel_id: 'p',
          application_no: '01-4',
          bbb_lookup: 'rated',
          bbb_rating: 'A-',
          bbb_rating_score: 93,
          bbb_accredited: true,
        }),
      ],
    );

    const detail = await source.getByParcelId('p');
    expect(detail?.permits.map((permit) => permit.bbb_lookup)).toEqual([
      'searched_no_match',
      'not_searched',
      'matched_unrated',
      'rated',
    ]);
    // BBB publishes a 0–100 score, not a five-point one.
    expect(detail?.permits[3]?.bbb_score).toBe(93);
    expect(detail?.permits[3]?.bbb_accredited).toBe(true);
    expect(detail?.permits[0]?.bbb_accredited).toBeNull();
  });

  it('drops a permit row whose parcel the snapshot does not carry', async () => {
    /**
     * `parcel_published` is the publisher's own claim and it is wrong on at least one row —
     * 222130300006E0000 is flagged published and is absent from the parcel snapshot — so the
     * snapshot's index is the authority and the row is dropped rather than left unattached.
     */
    const parcels = snapshotOf([row({ parcel_id: 'present' })]);
    const permits = await permitSnapshotOf(parcels, [
      permitRow({ parcel_id: 'present' }),
      permitRow({ parcel_id: 'absent', parcel_published: true }),
    ]);

    expect(permits.rowCount).toBe(1);
    expect(permits.rowsWithoutParcel).toBe(1);
    expect(permits.indexedParcelsMissing).toBe(1);
    expect(permitsForParcel(permits, 0)).toHaveLength(1);
  });

  it('agrees with the published per-parcel index it is checked against', async () => {
    const parcels = snapshotOf([row({ parcel_id: 'p' })]);
    const permits = await permitSnapshotOf(parcels, [
      permitRow({ parcel_id: 'p', status_canonical: 'active', status_raw: 'PERMIT ISSUED' }),
      permitRow({ parcel_id: 'p', application_no: '01-2' }),
    ]);

    expect(permits.indexDisagreements).toEqual({
      permitCount: 0,
      openPermitCount: 0,
      openRoofingPermitCount: 0,
    });
    expect(permits.nonContiguousParcels).toBe(0);
    expect(permits.statusQuarantined).toBe(0);
  });

  it('quarantines a county status string outside the mapped vocabulary', async () => {
    const parcels = snapshotOf([row({ parcel_id: 'p' })]);
    const permits = await permitSnapshotOf(parcels, [
      permitRow({ parcel_id: 'p', status_canonical: null, status_raw: 'SOMETHING NEW' }),
    ]);

    expect(permits.statusQuarantined).toBe(1);
    // Quarantined, not bucketed: an unrecognised status is not evidence the permit is closed.
    expect(permitsForParcel(permits, 0)[0]?.status).toBe('unknown');
  });
});
