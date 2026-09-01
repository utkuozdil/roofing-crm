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
import { PublishedPropertyDataSource } from './published-source';
import { S3SnapshotProvider } from './s3-snapshot-provider';

export interface PropertySearchQuery {
  center: GeoPoint;
  radiusMiles: number;
  filters: PropertyFilters;
  sort: SearchSort;
  limit: number;
  /** Injected so tests and derived roof ages are reproducible. */
  now?: Date;
}

/** A filter the active source cannot evaluate, with the reason it cannot. */
export interface UnsupportedFilter {
  filter: 'permitStatus' | 'minPermitOpenYears' | 'sort';
  reason: string;
}

/**
 * What the loaded permit history does and does not cover.
 *
 * Every field is a bound on what an absence means, and they are carried to the UI rather than
 * summarised into a sentence here, because the numbers move with each publish and a hand-written
 * caveat would drift away from the data it describes. The county's sweep is still running: it
 * has harvested a window of months, and the lifecycle of a small fraction of the applications
 * inside it.
 */
export interface PermitCoverage {
  runId: string;
  publishedAt: string;
  /** When the newest permit-status observation in this generation was read. */
  referenceDate: string | null;
  permitRows: number;
  parcelsWithPermits: number;
  parcelsTotal: number;
  /** The census window. Nothing outside it has been harvested — which is not the same as none. */
  firstMonth: string | null;
  lastMonth: string | null;
  windowComplete: boolean;
  /** Applications whose lifecycle has been read. The rest are `unknown`, meaning unharvested. */
  applicationsWithStatus: number | null;
  applicationsTotal: number | null;
  absenceMeaning: string;
  /** Published permit rows whose parcel is not in the parcel snapshot, so they were dropped. */
  rowsWithoutParcel: number;
  indexedParcelsMissing: number;
  /** Rows whose county status string is outside the CRM's vocabulary and was quarantined. */
  statusQuarantined: number;
  /**
   * Parcels where the publisher's roofing verdict and the CRM's disagree. Expected to be
   * non-zero: the publisher counts only the nine roofing application-type codes, the CRM also
   * counts the `BPRF` permit-type vocabulary. Reported so the broader definition is visible
   * rather than looking like a miscount.
   */
  roofingDisagreements: number;
  loadMs: number;
  fetchMs: number;
  parseMs: number;
  heapUsedMb: number;
}

/**
 * Where the rows came from and what that source can and cannot answer.
 *
 * Reported to the UI so the dataset banner states the truth rather than a build-time constant,
 * and so controls that the active source cannot honour are disabled rather than misleading.
 */
export interface DatasetProvenance {
  provider: 'fixture' | 'published-parquet';
  county: string;
  rowCount: number;
  /** False when the source has no permit history, which disables the permit filters. */
  permitsAvailable: boolean;
  note: string;
  snapshot?: {
    runId: string;
    publishedAt: string;
    objectCount: number;
    loadMs: number;
    fetchMs: number;
    parseMs: number;
    heapUsedMb: number;
    readyAt: string;
  };
  /** Present when permit history is loaded. Absent is the same statement as `false` above. */
  permits?: PermitCoverage;
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
  /**
   * Filters that were requested but could not be evaluated, and were therefore dropped.
   *
   * Dropped rather than applied-to-nothing on purpose: a source with no permit history cannot
   * tell an unpermitted parcel from an unknown one, so answering "no matches" would be a
   * claim it has no grounds for. The caller is expected to say what it ignored.
   */
  unsupportedFilters: UnsupportedFilter[];
  /**
   * How much of the in-radius population the permit history cannot speak for. Null when no
   * permit history is loaded — the distinction is between "measured, and this many are unknown"
   * and "there is nothing to measure".
   */
  permitCoverage: InRadiusPermitCoverage | null;
}

/**
 * The two permit unknowns for one search, so the result header can bound its own count.
 *
 * A "no open permit" result is mostly parcels nobody has looked at. Without these numbers the
 * count reads as a survey of the county; with them it reads as what it is — a survey of the
 * fraction whose lifecycle has been harvested.
 */
export interface InRadiusPermitCoverage {
  /** In-radius parcels with no permit in the published window. */
  withoutPermitsInRadius: number;
  /** In-radius parcels carrying at least one permit whose lifecycle is unharvested. */
  unknownPermitStatusInRadius: number;
}

export interface PropertyDataSource {
  /**
   * Whether this source carries permit history at all.
   *
   * Synchronous and static, because it is a fact about the source rather than about the data it
   * has loaded: the natural-language endpoint has to know it before deciding whether a question
   * is answerable, and making it async would force a 40 MB snapshot load just to find out that
   * the feature is switched off.
   */
  readonly permitsAvailable: boolean;
  search(query: PropertySearchQuery): Promise<PropertySearchResult>;
  getByParcelId(parcelId: string, now?: Date): Promise<PropertyDetail | null>;
  /** Total rows the source holds. Used by the UI's dataset provenance banner. */
  size(): Promise<number>;
  provenance(): Promise<DatasetProvenance>;
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
  /** Fixtures synthesise permit history, so every filter is answerable against them. */
  readonly permitsAvailable = true;
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
    let withoutPermits = 0;
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
        if (property.permits.length === 0) withoutPermits += 1;

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
      // Fixtures carry permit history, so every filter is answerable against them.
      unsupportedFilters: [],
      /**
       * Fixtures synthesise a status for every permit, so there is no unharvested population
       * to warn about. Reported as zeroes rather than null so the shape does not change with
       * the source.
       */
      permitCoverage: {
        withoutPermitsInRadius: withoutPermits,
        unknownPermitStatusInRadius: 0,
      },
    };
  }

  async getByParcelId(parcelId: string, now: Date = new Date()): Promise<PropertyDetail | null> {
    const fixture = this.byParcelId.get(parcelId);
    return fixture ? materialise(fixture, now) : null;
  }

  async size(): Promise<number> {
    return this.total;
  }

  async provenance(): Promise<DatasetProvenance> {
    return {
      provider: 'fixture',
      county: 'Seminole County, FL',
      rowCount: this.total,
      permitsAvailable: true,
      note: 'Deterministic fixture dataset behind the PropertyDataSource interface, used for tests and for any environment with no published snapshot configured.',
    };
  }
}

/**
 * The active source, built once per Lambda container and reused across warm invocations.
 *
 * Selected by configuration rather than by build: with `DATA_BUCKET_NAME` set the CRM reads the
 * publisher's real snapshot, and without it the fixture source keeps the site up. That fallback
 * is the difference between a missing environment variable degrading the dataset and taking the
 * whole site down.
 */
export const propertySource: PropertyDataSource = createPropertySource();

function createPropertySource(): PropertyDataSource {
  const bucket = process.env.DATA_BUCKET_NAME?.trim();
  if (!bucket) return new FixturePropertyDataSource();
  return new PublishedPropertyDataSource(new S3SnapshotProvider(bucket));
}
