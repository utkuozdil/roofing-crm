/**
 * `PropertyDataSource` over the published snapshots — 181,218 real Seminole County parcels and
 * the 509,336 permit rows the county has published against them, read from the publisher's
 * Parquet artifacts and nothing else.
 *
 * **Filters are evaluated against columns, not materialised records.** `matchesFilters` in the
 * shared package is the product's definition of a filter and stays that way; this module holds
 * a column-wise transcription of it, and `published-source.test.ts` asserts the two agree on
 * every combination of filters over a spread of records. The reason for the transcription is
 * that materialising a record per candidate allocates 181,218 objects on a county-wide search
 * to answer a question about six numbers. Only the rows actually returned — 200 at most — are
 * ever built into `PropertyDetail`s, and only those pay for their permit rows.
 *
 * **The permit clauses read per-parcel aggregates, never the permit table.** A county-wide
 * search asks "does this parcel have an unresolved roofing permit" of every candidate; folding
 * half a million rows to answer that would make the question quadratic in the wrong thing. The
 * aggregates are built once at load time, aligned to parcel rows, and read as typed arrays.
 *
 * **What a permit filter cannot see is stated, not implied.** 42.8% of parcels carry a permit
 * in the published window, and the lifecycle of 0.04% of applications has been harvested, so
 * "no open permit" is usually "not looked at yet". Every search reports that alongside its
 * count, and the dataset banner carries the window the absence is bounded by.
 */

import {
  type PermitRecord,
  type PropertyDetail,
  type PropertyFilters,
  type PropertySearchItem,
  type PropertyType,
  type SearchSort,
  PROPERTY_TYPES,
  geohashCellsForRadius,
  haversineMilesBetween,
} from '@roofing-crm/shared';
import { FLAG, INT_NULL, type ParcelSnapshot } from './parcel-snapshot';
import { type PermitSnapshot, permitsForParcel } from './permit-snapshot';
import type {
  DatasetProvenance,
  PermitCoverage,
  PropertyDataSource,
  PropertySearchQuery,
  PropertySearchResult,
  UnsupportedFilter,
} from './property-source';

/** Milliseconds in an average Gregorian year, matching `yearsBetween` in the shared package. */
const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;

const NO_PERMITS: PermitRecord[] = [];


/** The pair of snapshots a request is served from. Permits are absent until published. */
export interface PublishedSnapshot {
  parcels: ParcelSnapshot;
  permits: PermitSnapshot | null;
}

export interface SnapshotProvider {
  get(): Promise<PublishedSnapshot>;
}

/**
 * Filters this source cannot evaluate, given what the publisher publishes.
 *
 * Returned to the caller rather than quietly ignored, because a filter that had no effect and
 * said nothing is indistinguishable from a filter that did not match. With permits published
 * this is empty; it stays in place because a permit publish can be rolled back or fail, and the
 * honest degradation is to say the filter was dropped rather than to answer zero.
 */
function unsupportedFilters(
  filters: PropertyFilters,
  sort: SearchSort,
  permits: PermitSnapshot | null,
): UnsupportedFilter[] {
  if (permits !== null) return [];

  const reason = 'Permit history is not loaded, so no permit filter can be evaluated.';
  const unsupported: UnsupportedFilter[] = [];
  if (filters.permitStatus !== 'any') unsupported.push({ filter: 'permitStatus', reason });
  if (filters.minPermitOpenYears > 0) unsupported.push({ filter: 'minPermitOpenYears', reason });
  if (sort === 'permit_age') {
    unsupported.push({
      filter: 'sort',
      reason: 'Sorting by permit age needs permit history, which is not loaded.',
    });
  }
  return unsupported;
}

/** Column-wise transcription of `matchesFilters`, held equivalent to it by test. */
function matchesColumns(
  snapshot: ParcelSnapshot,
  permits: PermitSnapshot | null,
  row: number,
  filters: PropertyFilters,
  typeCodes: Set<number> | null,
  nowMs: number,
): boolean {
  if (typeCodes !== null && !typeCodes.has(snapshot.propertyType[row] as number)) return false;

  const flags = snapshot.flags[row] as number;

  if (filters.poolStatus === 'with_pool' && (flags & FLAG.pool) === 0) return false;
  if (filters.poolStatus === 'without_pool' && (flags & FLAG.pool) !== 0) return false;

  if (filters.minJustValue > 0) {
    const justValue = snapshot.totalJustValue[row] as number;
    // A parcel with no recorded value cannot be shown to clear a value floor.
    if (Number.isNaN(justValue) || justValue < filters.minJustValue) return false;
  }

  if (filters.minRoofAgeYears > 0) {
    const roofAge = snapshot.roofAge[row] as number;
    if (roofAge === INT_NULL) {
      if (!filters.includeUnknownRoofAge) return false;
    } else if (roofAge < filters.minRoofAgeYears) {
      return false;
    }
  }


  /**
   * With no permit history loaded the permit clauses are skipped, not failed. They are
   * reported as unsupported instead — see {@link unsupportedFilters}. Failing them would
   * answer "no such parcel" to a question this source cannot evaluate at all.
   */
  if (permits !== null) {
    switch (filters.permitStatus) {
      case 'unresolved':
        if ((permits.unresolvedCount[row] as number) === 0) return false;
        break;
      case 'roofing_unresolved':
        if ((permits.unresolvedRoofingCount[row] as number) === 0) return false;
        break;
      case 'none':
        if ((permits.permitCount[row] as number) > 0) return false;
        break;
      case 'any':
        break;
    }

    if (filters.minPermitOpenYears > 0) {
      if ((permits.maxOpenYears[row] as number) < filters.minPermitOpenYears) return false;
    }
  }

  if (filters.minYearsSinceLastSale > 0) {
    const saleMs = snapshot.lastSaleDateMs[row] as number;
    if (Number.isNaN(saleMs)) return false;
    if ((nowMs - saleMs) / MS_PER_YEAR < filters.minYearsSinceLastSale) return false;
  }

  if (filters.soldSinceYear > 0) {
    const saleYear = snapshot.lastSaleYear[row] as number;
    if (saleYear === INT_NULL || saleYear < filters.soldSinceYear) return false;
  }

  if (filters.outOfAreaOwnerOnly && (flags & FLAG.outOfArea) === 0) return false;

  return true;
}

function comparator(
  snapshot: ParcelSnapshot,
  permits: PermitSnapshot | null,
  sort: SearchSort,
  distances: Float64Array,
): (a: number, b: number) => number {
  switch (sort) {
    case 'roof_age':
      return (a, b) => {
        const left = snapshot.roofAge[a] as number;
        const right = snapshot.roofAge[b] as number;
        const leftValue = left === INT_NULL ? -1 : left;
        const rightValue = right === INT_NULL ? -1 : right;
        return rightValue - leftValue || (distances[a] as number) - (distances[b] as number);
      };
    case 'just_value':
      return (a, b) => {
        const left = snapshot.totalJustValue[a] as number;
        const right = snapshot.totalJustValue[b] as number;
        const leftValue = Number.isNaN(left) ? 0 : left;
        const rightValue = Number.isNaN(right) ? 0 : right;
        return rightValue - leftValue || (distances[a] as number) - (distances[b] as number);
      };
    case 'permit_age':
      // Without permit history there is no key to sort on; the filter is reported unsupported
      // and the order falls back to distance rather than to an all-zero key.
      if (permits === null) return (a, b) => (distances[a] as number) - (distances[b] as number);
      return (a, b) =>
        (permits.maxOpenYears[b] as number) - (permits.maxOpenYears[a] as number) ||
        (distances[a] as number) - (distances[b] as number);
    case 'distance':
      return (a, b) => (distances[a] as number) - (distances[b] as number);
  }
}

const nullableInt = (value: number): number | null => (value === INT_NULL ? null : value);
const nullableFloat = (value: number): number | null => (Number.isNaN(value) ? null : value);

export class PublishedPropertyDataSource implements PropertyDataSource {
  /**
   * The published interface carries permit history, so this source serves permit filters.
   *
   * A capability rather than a measurement, because the natural-language endpoint has to know
   * before it decides whether a question is answerable and cannot afford a 50 MB load to find
   * out. If a permit publish is ever rolled back the runtime truth diverges from this for one
   * container's life, and that is what `unsupportedFilters` and `provenance()` are for: the
   * filter is reported dropped rather than answered as zero.
   */
  readonly permitsAvailable = true;

  constructor(private readonly provider: SnapshotProvider) {}

  private detailAt(
    snapshot: ParcelSnapshot,
    permits: PermitSnapshot | null,
    row: number,
  ): PropertyDetail {
    const flags = snapshot.flags[row] as number;
    const saleMs = snapshot.lastSaleDateMs[row] as number;

    return {
      parcel_id: snapshot.parcelId[row] as string,
      owner_name: snapshot.ownerName[row] ?? null,
      primary_address: snapshot.primaryAddress[row] ?? null,
      mailing_city_state_zip:
        snapshot.mailingCityStateZip.values[snapshot.mailingCityStateZip.codes[row] as number] ??
        null,
      owner_out_of_area:
        (flags & FLAG.outOfAreaKnown) === 0 ? null : (flags & FLAG.outOfArea) !== 0,
      property_type: PROPERTY_TYPES[snapshot.propertyType[row] as number] as PropertyType,
      dor_code: snapshot.dorCode.values[snapshot.dorCode.codes[row] as number] ?? null,
      year_built: nullableInt(snapshot.yearBuilt[row] as number),
      last_sale_date: Number.isNaN(saleMs)
        ? null
        : (new Date(saleMs).toISOString().slice(0, 10) as string),
      last_sale_amount: nullableFloat(snapshot.lastSaleAmount[row] as number),
      total_just_value: nullableFloat(snapshot.totalJustValue[row] as number),
      assessed_value: nullableFloat(snapshot.assessedValue[row] as number),
      taxable_value: nullableFloat(snapshot.taxableValue[row] as number),
      total_living_area: nullableFloat(snapshot.totalLivingArea[row] as number),
      total_bedrooms: nullableFloat(snapshot.totalBedrooms[row] as number),
      total_bathrooms: nullableFloat(snapshot.totalBathrooms[row] as number),
      has_pool: (flags & FLAG.pool) !== 0,
      latitude: snapshot.latitude[row] as number,
      longitude: snapshot.longitude[row] as number,
      geohash5: snapshot.cellByRow[row] ?? '',
      /**
       * Read from the publisher's `roof_age` rather than re-derived from `year_built`. The
       * publisher measures it from the effective year built, so a re-roofed or renovated
       * structure reports the age of what is on the roof now; deriving it here from the
       * original build year would disagree with the published figure on 1.4% of parcels.
       */
      roof_age_years: nullableInt(snapshot.roofAge[row] as number),
      permits: permits === null ? NO_PERMITS : permitsForParcel(permits, row),
    };
  }

  async search(query: PropertySearchQuery): Promise<PropertySearchResult> {
    const { parcels: snapshot, permits } = await this.provider.get();
    const now = query.now ?? new Date();
    const nowMs = now.getTime();

    const cells = geohashCellsForRadius(query.center, query.radiusMiles);
    const typeCodes =
      query.filters.propertyTypes.length === 0
        ? null
        : new Set(query.filters.propertyTypes.map((type) => PROPERTY_TYPES.indexOf(type)));

    const distances = new Float64Array(snapshot.count);
    const matched: number[] = [];

    let candidatesScanned = 0;
    let totalInRadius = 0;
    let unknownRoofAgeInRadius = 0;
    let unknownPermitStatusInRadius = 0;
    let withoutPermitsInRadius = 0;

    for (const cell of cells) {
      const ranges = snapshot.cellRanges.get(cell);
      if (ranges === undefined) continue;

      for (const range of ranges) {
        for (let row = range.start; row < range.end; row += 1) {
          candidatesScanned += 1;
          const distance = haversineMilesBetween(
            query.center.latitude,
            query.center.longitude,
            snapshot.latitude[row] as number,
            snapshot.longitude[row] as number,
          );
          if (distance > query.radiusMiles) continue;

          totalInRadius += 1;
          if ((snapshot.roofAge[row] as number) === INT_NULL) unknownRoofAgeInRadius += 1;
          if (permits !== null) {
            if ((permits.permitCount[row] as number) === 0) withoutPermitsInRadius += 1;
            else if ((permits.unknownStatusCount[row] as number) > 0) {
              unknownPermitStatusInRadius += 1;
            }
          }

          if (!matchesColumns(snapshot, permits, row, query.filters, typeCodes, nowMs)) continue;
          distances[row] = distance;
          matched.push(row);
        }
      }
    }

    matched.sort(comparator(snapshot, permits, query.sort, distances));

    const items: PropertySearchItem[] = matched.slice(0, query.limit).map((row) => ({
      ...this.detailAt(snapshot, permits, row),
      distance_miles: Math.round((distances[row] as number) * 100) / 100,
    }));

    return {
      items,
      totalMatched: matched.length,
      totalInRadius,
      unknownRoofAgeInRadius,
      cellsScanned: cells.length,
      candidatesScanned,
      unsupportedFilters: unsupportedFilters(query.filters, query.sort, permits),
      permitCoverage:
        permits === null
          ? null
          : {
              withoutPermitsInRadius,
              unknownPermitStatusInRadius,
            },
    };
  }

  async getByParcelId(parcelId: string): Promise<PropertyDetail | null> {
    const { parcels: snapshot, permits } = await this.provider.get();
    const row = snapshot.byParcelId.get(parcelId);
    return row === undefined ? null : this.detailAt(snapshot, permits, row);
  }


  async size(): Promise<number> {
    return (await this.provider.get()).parcels.count;
  }

  async provenance(): Promise<DatasetProvenance> {
    const { parcels: snapshot, permits } = await this.provider.get();
    const parcelNote = `Published Parquet snapshot ${snapshot.pointer.runId}, ${snapshot.count.toLocaleString('en-US')} parcels across ${snapshot.objectCount} geohash-5 partitions, read through publish/current.json.`;

    return {
      provider: 'published-parquet',
      county: snapshot.pointer.county,
      rowCount: snapshot.count,
      permitsAvailable: permits !== null,
      note:
        permits === null
          ? `${parcelNote} Permit history is not loaded, so permit filters are unavailable.`
          : `${parcelNote} Permit history ${permits.pointer.runId} adds ${permits.rowCount.toLocaleString('en-US')} permit rows on ${permits.parcelsWithPermits.toLocaleString('en-US')} parcels, read through publish/permits/current.json.`,
      snapshot: {
        runId: snapshot.pointer.runId,
        publishedAt: snapshot.pointer.publishedAt,
        objectCount: snapshot.objectCount,
        loadMs: snapshot.loadMs,
        fetchMs: snapshot.fetchMs,
        parseMs: snapshot.parseMs,
        heapUsedMb: snapshot.heapUsedMb,
        readyAt: snapshot.readyAt,
      },
      permits: permits === null ? undefined : permitCoverage(snapshot, permits),
    };
  }
}

/**
 * The permit facts the UI has to keep in front of the operator.
 *
 * All of them are the same kind of fact: a bound on what absence means. A parcel with no permit
 * had none in the published window; a permit with no status has not been looked at; a
 * contractor with no BBB rating may never have been searched. None of those is "nothing
 * happened", and each is one sentence away from being read that way.
 */
function permitCoverage(parcels: ParcelSnapshot, permits: PermitSnapshot): PermitCoverage {
  const census = permits.pointer.coverage?.census;
  const status = permits.pointer.coverage?.status;

  return {
    runId: permits.pointer.runId,
    publishedAt: permits.pointer.publishedAt,
    referenceDate: permits.pointer.referenceDate ?? null,
    permitRows: permits.rowCount,
    parcelsWithPermits: permits.parcelsWithPermits,
    parcelsTotal: parcels.count,
    firstMonth: census?.firstMonth ?? null,
    lastMonth: census?.lastMonth ?? null,
    windowComplete: census?.complete ?? false,
    applicationsWithStatus: status?.applicationsWithStatus ?? null,
    applicationsTotal: status?.applicationsTotal ?? null,
    absenceMeaning:
      permits.pointer.coverage?.absenceMeaning ??
      'A parcel with no permit had none in the published window; it says nothing about permits outside it.',
    rowsWithoutParcel: permits.rowsWithoutParcel,
    indexedParcelsMissing: permits.indexedParcelsMissing,
    statusQuarantined: permits.statusQuarantined,
    roofingDisagreements: permits.indexDisagreements.openRoofingPermitCount,
    loadMs: permits.loadMs,
    fetchMs: permits.fetchMs,
    parseMs: permits.parseMs,
    heapUsedMb: permits.heapUsedMb,
  };
}
