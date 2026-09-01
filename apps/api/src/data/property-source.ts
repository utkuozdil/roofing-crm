/**
 * The seam between the CRM and the property dataset.
 *
 * `PropertyDataSource` is the only thing the tRPC router knows about. Today the single
 * implementation is fixture-backed; when the Oracle pipeline lands, a second
 * implementation reading the real store slots in at {@link propertySource} and neither
 * the router nor the SPA changes.
 *
 * Radius search is two-phase by design, not by convenience:
 *   1. Compute every geohash-5 cell that can contain an in-radius point, and read only
 *      those buckets. Over real data these are partition reads; over fixtures they are
 *      map lookups. Either way the candidate set is bounded by area, not by dataset size.
 *   2. Measure exact haversine distance on the candidates and drop the corners of the
 *      bounding box that fall outside the true circle.
 */

import {
  type GeoPoint,
  type PropertyDetail,
  type PropertyFilters,
  type PropertySearchItem,
  type SearchSort,
  deriveRoofAgeYears,
  geohashCellsForRadius,
  haversineMiles,
  matchesFilters,
  permitOpenYears,
} from '@roofing-crm/shared';
import { loadPropertyFixtures, type PropertyFixture } from './fixtures';

export interface PropertySearchQuery {
  center: GeoPoint;
  radiusMiles: number;
  filters: PropertyFilters;
  sort: SearchSort;
  limit: number;
  /** Injected so tests and derived roof ages are reproducible. */
  now?: Date;
}

export interface PropertySearchResult {
  items: PropertySearchItem[];
  /** Matches before `limit` was applied, so the UI can say "showing 50 of 137". */
  totalMatched: number;
  /** Candidates that were inside the radius but failed the filters. */
  totalInRadius: number;
  /**
   * In-radius parcels with no derivable roof age — no build year and no signed-off roofing
   * permit. Returned on every search so the UI can state what the roof-age threshold is
   * doing to them instead of dropping about one parcel in nine without saying so.
   */
  unknownRoofAgeInRadius: number;
  /** Geohash-5 buckets read in phase one. Surfaced so the algorithm is observable. */
  cellsScanned: number;
  /** Rows the haversine pass measured. */
  candidatesScanned: number;
}

export interface PropertyDataSource {
  search(query: PropertySearchQuery): Promise<PropertySearchResult>;
  getByParcelId(parcelId: string, now?: Date): Promise<PropertyDetail | null>;
  /** Total rows the source holds. Used by the UI's dataset provenance banner. */
  size(): Promise<number>;
}

function materialise(fixture: PropertyFixture, now: Date): PropertyDetail {
  return {
    ...fixture,
    roof_age_years: deriveRoofAgeYears(fixture, fixture.permits, now),
  };
}

/** Longest time any unresolved permit on the property has been open. */
function longestOpenPermitYears(property: PropertyDetail, now: Date): number {
  return property.permits.reduce((max, permit) => Math.max(max, permitOpenYears(permit, now)), 0);
}

function comparator(
  sort: SearchSort,
  now: Date,
): (a: PropertySearchItem, b: PropertySearchItem) => number {
  switch (sort) {
    case 'roof_age':
      return (a, b) =>
        (b.roof_age_years ?? -1) - (a.roof_age_years ?? -1) || a.distance_miles - b.distance_miles;
    case 'permit_age':
      return (a, b) =>
        longestOpenPermitYears(b, now) - longestOpenPermitYears(a, now) ||
        a.distance_miles - b.distance_miles;
    case 'just_value':
      return (a, b) =>
        (b.total_just_value ?? 0) - (a.total_just_value ?? 0) ||
        a.distance_miles - b.distance_miles;
    case 'distance':
      return (a, b) => a.distance_miles - b.distance_miles;
  }
}

export class FixturePropertyDataSource implements PropertyDataSource {
  private readonly byCell = new Map<string, PropertyFixture[]>();
  private readonly byParcelId = new Map<string, PropertyFixture>();
  private readonly total: number;

  constructor(fixtures: readonly PropertyFixture[] = loadPropertyFixtures()) {
    for (const fixture of fixtures) {
      const bucket = this.byCell.get(fixture.geohash5);
      if (bucket) {
        bucket.push(fixture);
      } else {
        this.byCell.set(fixture.geohash5, [fixture]);
      }
      this.byParcelId.set(fixture.parcel_id, fixture);
    }
    this.total = fixtures.length;
  }

  async search(query: PropertySearchQuery): Promise<PropertySearchResult> {
    const now = query.now ?? new Date();
    const cells = geohashCellsForRadius(query.center, query.radiusMiles);

    let candidatesScanned = 0;
    let totalInRadius = 0;
    let unknownRoofAgeInRadius = 0;
    const matched: PropertySearchItem[] = [];

    for (const cell of cells) {
      const bucket = this.byCell.get(cell);
      if (!bucket) continue;

      for (const fixture of bucket) {
        candidatesScanned += 1;
        const distance = haversineMiles(query.center, fixture);
        if (distance > query.radiusMiles) continue;
        totalInRadius += 1;

        const property = materialise(fixture, now);
        if (property.roof_age_years === null) unknownRoofAgeInRadius += 1;

        if (!matchesFilters(property, query.filters, now)) continue;
        matched.push({ ...property, distance_miles: Math.round(distance * 100) / 100 });
      }
    }

    matched.sort(comparator(query.sort, now));

    return {
      items: matched.slice(0, query.limit),
      totalMatched: matched.length,
      totalInRadius,
      unknownRoofAgeInRadius,
      cellsScanned: cells.length,
      candidatesScanned,
    };
  }

  async getByParcelId(parcelId: string, now: Date = new Date()): Promise<PropertyDetail | null> {
    const fixture = this.byParcelId.get(parcelId);
    return fixture ? materialise(fixture, now) : null;
  }

  async size(): Promise<number> {
    return this.total;
  }
}

/**
 * Module-scoped so the fixture index is built once per Lambda container and reused
 * across warm invocations. Swap the constructor here for the pipeline-backed source.
 */
export const propertySource: PropertyDataSource = new FixturePropertyDataSource();
