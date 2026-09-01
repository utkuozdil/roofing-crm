/**
 * The published permit history, transposed into columns and aligned to the parcel snapshot.
 *
 * Four decisions carry this module, and each one is a measurement rather than a preference.
 *
 * **Both artifacts are read, and they do different jobs.** `parcel-index.parquet` is
 * pre-aggregated one row per parcel and is what makes a county-wide permit filter affordable —
 * without it every search would have to fold half a million rows to answer "does this parcel
 * have an open permit". `permits.parquet` carries the trade lines the results list and the
 * detail panel render. Both are held for the life of the container.
 *
 * **The filter reads aggregates this module derives, not the published ones.** The publisher's
 * `roofing_relevant` comes from the county's nine roofing *application-type* codes; the CRM
 * also classifies the `BPRF` *permit-type* vocabulary, which is 17,745 more rows in this
 * snapshot. Filtering on the publisher's narrower verdict while the results list labels rows
 * with the CRM's broader one would put a "roofing permit unresolved" badge on parcels that the
 * roofing-permit filter excludes. The published aggregates are still loaded and compared row
 * by row, and any disagreement is counted and reported rather than absorbed — see
 * {@link PermitSnapshot.indexDisagreements}.
 *
 * **Status comes from `status_canonical`, not from `status`.** The artifact's `status` is a
 * four-value lifecycle (`open`/`closed`/`void`/`unknown`); the CRM's is seven values, and
 * `pre_issuance`, `blocked` and `active` all collapse into `open`. Reading `status` would
 * throw away the distinction between a permit stuck in approval and one with work underway.
 * `status_raw` is mapped through the CRM's own vocabulary as a cross-check, and rows the
 * canonical value cannot supply fall back to it.
 *
 * **Rows are parsed in chunks and the row objects are dropped as they are folded in.**
 * Parsing all 511,500 at once costs several hundred megabytes of short-lived garbage. The
 * columns retain 47 MB, measured; see `permit-snapshot.test.ts` for the transposition and
 * the platform status card for the figure the container actually paid.
 */

import {
  type PermitBbbLookup,
  type PermitRecord,
  type PermitStatus,
  PERMIT_BBB_LOOKUPS,
  PERMIT_STATUSES,
  classifyRoofingPermit,
  isUnresolvedPermitStatus,
  mapSeminolePermitStatus,
} from '@roofing-crm/shared';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { z } from 'zod';
import { INT_NULL, type ParcelSnapshot, type SnapshotStore } from './parcel-snapshot';

/**
 * The permits pointer, at a fixed key of its own.
 *
 * `publish/current.json` also carries a `permits` block, but the parcel publisher rewrites that
 * object whole and drops the block until the permit step re-runs, so the parcel pointer is a
 * discovery convenience and this is the durable address.
 */
export const permitSnapshotPointerSchema = z.object({
  runId: z.string().min(1),
  county: z.string().min(1),
  publishedAt: z.string().min(1),
  /** The instant the newest status observation in this generation was read. */
  referenceDate: z.string().min(1).optional(),
  files: z.object({
    permits: z.object({ key: z.string().min(1), rows: z.number().int().nonnegative() }),
    parcelIndex: z.object({ key: z.string().min(1), rows: z.number().int().nonnegative() }),
  }),
  totals: z.object({ bytes: z.number().int().nonnegative() }).optional(),
  /**
   * Coverage is carried through to the UI verbatim. A window, a status fraction and a
   * statement of what absence means are not decoration: without them "no open permit" reads
   * as a fact about the parcel when it is a fact about how far the harvest has got.
   */
  coverage: z
    .object({
      census: z
        .object({
          firstMonth: z.string().optional(),
          lastMonth: z.string().optional(),
          months: z.number().int().nonnegative().optional(),
          contiguous: z.boolean().optional(),
          complete: z.boolean().optional(),
        })
        .optional(),
      status: z
        .object({
          applicationsWithStatus: z.number().int().nonnegative().optional(),
          applicationsTotal: z.number().int().nonnegative().optional(),
        })
        .optional(),
      absenceMeaning: z.string().optional(),
    })
    .optional(),
  counts: z
    .object({
      permitRows: z.number().int().nonnegative().optional(),
      applications: z.number().int().nonnegative().optional(),
      publishedParcels: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type PermitSnapshotPointer = z.infer<typeof permitSnapshotPointerSchema>;

/** Bit positions in the per-permit flag byte. */
export const PERMIT_FLAG = {
  roofing: 1,
  accredited: 2,
  accreditedKnown: 4,
  /** The publisher's own roofing verdict, kept so the two can be compared after the load. */
  publisherRoofing: 8,
} as const;

const PERMIT_COLUMNS = [
  'parcel_id',
  'parcel_published',
  'application_no',
  'structure_sequence',
  'permit_type_sequence',
  'issued_on',
  'closed_on',
  'permit_type',
  'permit_type_code',
  'description',
  'application_type_code',
  'roofing_relevant',
  'contractor_name',
  'valuation_usd',
  'status_canonical',
  'status_raw',
  'open_years',
  'open_duration_observed_at',
  'bbb_lookup',
  'bbb_rating',
  'bbb_rating_score',
  'bbb_accredited',
] as const;

const INDEX_COLUMNS = [
  'parcel_id',
  'permit_count',
  'application_count',
  'first_permit_on',
  'last_permit_on',
  'open_permit_count',
  'open_roofing_permit_count',
  'unknown_status_permit_count',
  'max_open_years',
] as const;

/** Rows are parsed this many at a time so the row objects never all exist at once. */
const PARSE_CHUNK_ROWS = 32_000;

const STATUS_CODE = new Map<PermitStatus, number>(
  PERMIT_STATUSES.map((status, index) => [status, index]),
);
const BBB_LOOKUP_CODE = new Map<string, number>(
  PERMIT_BBB_LOOKUPS.map((lookup, index) => [lookup, index]),
);

/**
 * Where the published per-parcel aggregate and this module's own recount disagree.
 *
 * Reported rather than reconciled. The counts come from two different definitions of the same
 * words, and quietly picking one would hide the fact that they are two.
 */
export interface IndexDisagreements {
  /** Parcels the index claims a permit for that the permit rows do not place on that parcel. */
  permitCount: number;
  /** Parcels whose unresolved-permit count differs. Nonzero means the lifecycles disagree. */
  openPermitCount: number;
  /** Parcels whose roofing verdict differs — expected, and the reason the CRM recounts. */
  openRoofingPermitCount: number;
}

export interface PermitSnapshot {
  pointer: PermitSnapshotPointer;

  /** Permit rows retained: those whose parcel is in the parcel snapshot. */
  rowCount: number;
  /** Rows dropped because their parcel id is absent from the published parcel snapshot. */
  rowsWithoutParcel: number;
  /** Parcels in the published index that the parcel snapshot does not carry. */
  indexedParcelsMissing: number;
  parcelsWithPermits: number;
  /** Rows whose `status_raw` is outside the CRM's mapped vocabulary. Alert-and-quarantine. */
  statusQuarantined: number;
  /** Parcels whose permit rows were not contiguous in the published table. Expected to be 0. */
  nonContiguousParcels: number;
  indexDisagreements: IndexDisagreements;

  /**
   * Per parcel row, the half-open range of permit rows that belong to it. `permitStart` is
   * `INT_NULL` for a parcel with no permits, which is how "absent from the index" is
   * represented — a real state meaning "no permit in the published window", not "never
   * permitted".
   */
  permitStart: Int32Array;
  permitEnd: Int32Array;
  /** Per parcel row, derived with the CRM's own predicates. What the filters read. */
  permitCount: Int32Array;
  applicationCount: Int32Array;
  unresolvedCount: Int32Array;
  unresolvedRoofingCount: Int32Array;
  /** Permits whose lifecycle has not been harvested. Not closed — unknown. */
  unknownStatusCount: Int32Array;
  /** Longest open duration on the parcel, from the county's own measurement. 0 when none. */
  maxOpenYears: Float64Array;
  /** Longest open duration on a roofing permit, by the CRM's roofing vocabulary. */
  maxOpenRoofingYears: Float64Array;
  /** Published first and last permit dates, which the row-level dates cannot supply. */
  firstPermitMs: Float64Array;
  lastPermitMs: Float64Array;

  permitNumber: string[];
  structureSequence: Dictionary<Uint16Array>;
  permitTypeSequence: Dictionary<Uint16Array>;
  permitType: Dictionary<Uint16Array>;
  permitTypeCode: Dictionary<Uint16Array>;
  description: Dictionary<Uint16Array>;
  applicationTypeCode: Dictionary<Uint16Array>;
  contractorName: Dictionary<Uint32Array>;
  bbbRating: Dictionary<Uint8Array>;
  status: Uint8Array;
  bbbLookup: Uint8Array;
  issuedMs: Float64Array;
  closedMs: Float64Array;
  openYears: Float64Array;
  openYearsObservedMs: Float64Array;
  valuation: Float64Array;
  bbbScore: Float64Array;
  flags: Uint8Array;

  fetchMs: number;
  parseMs: number;
  loadMs: number;
  /** Heap retained by these columns, measured across the load. Reported on the status card. */
  heapUsedMb: number;
  bytes: number;
  readyAt: string;
}

export interface Dictionary<T extends Uint8Array | Uint16Array | Uint32Array> {
  codes: T;
  values: (string | null)[];
}

class DictionaryBuilder<T extends Uint8Array | Uint16Array | Uint32Array> {
  private readonly index = new Map<string | null, number>();
  readonly values: (string | null)[] = [];

  constructor(readonly codes: T) {}

  set(row: number, value: string | null): void {
    let code = this.index.get(value);
    if (code === undefined) {
      code = this.values.length;
      this.values.push(value);
      this.index.set(value, code);
    }
    this.codes[row] = code;
  }

  finish(): Dictionary<T> {
    return { codes: this.codes, values: this.values };
  }
}

function toText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value * 86_400_000;
  if (typeof value === 'bigint') return Number(value) * 86_400_000;
  return Number.NaN;
}

function toFloat(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.NaN;
}


/** `array[i] += 1` under `noUncheckedIndexedAccess`, without a cast at every call site. */
function bump(array: Int32Array, index: number): void {
  array[index] = (array[index] as number) + 1;
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return INT_NULL;
}

/**
 * The CRM status for a published row.
 *
 * `status_canonical` is the publisher's mapping of the county's own string into a vocabulary
 * that happens to be a subset of the CRM's, so it is taken when it fits. `status_raw` through
 * {@link mapSeminolePermitStatus} is the fallback and the cross-check: a raw value the CRM has
 * never seen is quarantined as `unknown` and counted, which is what the source config asks for.
 */
export function resolvePermitStatus(
  canonical: string | null,
  raw: string | null,
): { status: PermitStatus; quarantined: boolean } {
  if (canonical !== null && STATUS_CODE.has(canonical as PermitStatus)) {
    return { status: canonical as PermitStatus, quarantined: false };
  }
  if (raw === null && canonical === null) return { status: 'unknown', quarantined: false };
  const mapped = mapSeminolePermitStatus(raw);
  return { status: mapped.status, quarantined: mapped.quarantine };
}

interface ParsedIndexRow {
  permitCount: number;
  applicationCount: number;
  openPermitCount: number;
  openRoofingPermitCount: number;
  unknownStatusCount: number;
  firstPermitMs: number;
  lastPermitMs: number;
}

/** Reads all the objects a permit snapshot needs, so a test can supply them from fixtures. */
export interface PermitArtifacts {
  /** `parcel-index.parquet`, one row per parcel that has a permit. */
  index: Record<string, unknown>[];
  /**
   * `permits.parquet`, read in chunks. A generator rather than an array because the whole
   * point of chunking is that the caller never holds every row at once.
   */
  permitChunks: AsyncIterable<Record<string, unknown>[]>;
  bytes: number;
  /**
   * Read after the chunks are consumed, so it counts the whole load. A plain number would be
   * captured before the generator has fetched anything and report only the index.
   */
  fetchMs: () => number;
}

/**
 * Folds the published artifacts into columns aligned to `parcels`.
 *
 * Alignment is by parcel id: the permit rows arrive sorted by parcel id and the parcel
 * snapshot is ordered by geohash cell, so the permit store keeps its own order and each parcel
 * row points at a contiguous range of it.
 */
export async function buildPermitSnapshot(
  pointer: PermitSnapshotPointer,
  parcels: ParcelSnapshot,
  artifacts: PermitArtifacts,
): Promise<PermitSnapshot> {
  const startedAt = Date.now();
  let parseMs = 0;

  const parcelRows = parcels.count;
  const permitStart = new Int32Array(parcelRows).fill(INT_NULL);
  const permitEnd = new Int32Array(parcelRows).fill(INT_NULL);
  const permitCount = new Int32Array(parcelRows);
  const applicationCount = new Int32Array(parcelRows);
  const unresolvedCount = new Int32Array(parcelRows);
  const unresolvedRoofingCount = new Int32Array(parcelRows);
  const unknownStatusCount = new Int32Array(parcelRows);
  const maxOpenYears = new Float64Array(parcelRows);
  const maxOpenRoofingYears = new Float64Array(parcelRows);
  const firstPermitMs = new Float64Array(parcelRows).fill(Number.NaN);
  const lastPermitMs = new Float64Array(parcelRows).fill(Number.NaN);

  const indexParseStartedAt = Date.now();
  const published = new Map<number, ParsedIndexRow>();
  let indexedParcelsMissing = 0;
  for (const record of artifacts.index) {
    const parcelId = toText(record.parcel_id);
    if (parcelId === null) continue;
    const row = parcels.byParcelId.get(parcelId);
    if (row === undefined) {
      indexedParcelsMissing += 1;
      continue;
    }
    firstPermitMs[row] = toEpochMs(record.first_permit_on);
    lastPermitMs[row] = toEpochMs(record.last_permit_on);
    published.set(row, {
      permitCount: toInt(record.permit_count),
      applicationCount: toInt(record.application_count),
      openPermitCount: toInt(record.open_permit_count),
      openRoofingPermitCount: toInt(record.open_roofing_permit_count),
      unknownStatusCount: toInt(record.unknown_status_permit_count),
      firstPermitMs: toEpochMs(record.first_permit_on),
      lastPermitMs: toEpochMs(record.last_permit_on),
    });
  }
  parseMs += Date.now() - indexParseStartedAt;

  const capacity = pointer.files.permits.rows;
  const permitNumber = new Array<string>(capacity);
  const structureSequence = new DictionaryBuilder(new Uint16Array(capacity));
  const permitTypeSequence = new DictionaryBuilder(new Uint16Array(capacity));
  const permitType = new DictionaryBuilder(new Uint16Array(capacity));
  const permitTypeCode = new DictionaryBuilder(new Uint16Array(capacity));
  const description = new DictionaryBuilder(new Uint16Array(capacity));
  const applicationTypeCode = new DictionaryBuilder(new Uint16Array(capacity));
  const contractorName = new DictionaryBuilder(new Uint32Array(capacity));
  const bbbRating = new DictionaryBuilder(new Uint8Array(capacity));
  const status = new Uint8Array(capacity);
  const bbbLookup = new Uint8Array(capacity);
  const issuedMs = new Float64Array(capacity);
  const closedMs = new Float64Array(capacity);
  const openYears = new Float64Array(capacity);
  const openYearsObservedMs = new Float64Array(capacity);
  const valuation = new Float64Array(capacity);
  const bbbScore = new Float64Array(capacity);
  const flags = new Uint8Array(capacity);

  let written = 0;
  let rowsWithoutParcel = 0;
  let statusQuarantined = 0;
  let nonContiguousParcels = 0;
  /** Applications already counted for the parcel being filled, so both grains are right. */
  let currentParcelRow = -1;
  let currentApplications = new Set<string>();

  for await (const chunk of artifacts.permitChunks) {
    const chunkStartedAt = Date.now();

    for (const record of chunk) {
      const parcelId = toText(record.parcel_id);
      const parcelRow = parcelId === null ? undefined : parcels.byParcelId.get(parcelId);
      /**
       * A permit whose parcel is not in the published parcel snapshot is dropped rather than
       * kept unattached. `parcel_published` claims to say this, but it disagrees with the
       * snapshot on at least one row — 222130300006E0000 is flagged published and is not in
       * it — so the snapshot's own index is the authority.
       */
      if (parcelRow === undefined) {
        rowsWithoutParcel += 1;
        continue;
      }
      if (written >= capacity) break;

      if (parcelRow !== currentParcelRow) {
        currentParcelRow = parcelRow;
        currentApplications = new Set<string>();
        /**
         * A parcel's rows form one contiguous range because the published permit table is
         * sorted by parcel id. If that ever stops being true, the range opened at the first
         * occurrence would swallow every row in between, so a repeat visit is counted and the
         * range is left alone rather than silently widened.
         */
        if (permitStart[parcelRow] === INT_NULL) permitStart[parcelRow] = written;
        else nonContiguousParcels += 1;
      }

      const row = written;
      const applicationNo = toText(record.application_no) ?? '';
      permitNumber[row] = applicationNo;
      structureSequence.set(row, toText(record.structure_sequence));
      permitTypeSequence.set(row, toText(record.permit_type_sequence));
      const typeLabel = toText(record.permit_type);
      const typeCode = toText(record.permit_type_code);
      const descriptionText = toText(record.description);
      const applicationCode = toText(record.application_type_code);
      permitType.set(row, typeLabel);
      permitTypeCode.set(row, typeCode);
      description.set(row, descriptionText);
      applicationTypeCode.set(row, applicationCode);
      contractorName.set(row, toText(record.contractor_name));

      const resolved = resolvePermitStatus(
        toText(record.status_canonical),
        toText(record.status_raw),
      );
      if (resolved.quarantined) statusQuarantined += 1;
      status[row] = STATUS_CODE.get(resolved.status) as number;

      issuedMs[row] = toEpochMs(record.issued_on);
      closedMs[row] = toEpochMs(record.closed_on);
      openYears[row] = toFloat(record.open_years);
      openYearsObservedMs[row] = toEpochMs(record.open_duration_observed_at);
      valuation[row] = toFloat(record.valuation_usd);
      bbbScore[row] = toFloat(record.bbb_rating_score);
      bbbRating.set(row, toText(record.bbb_rating));
      bbbLookup[row] = BBB_LOOKUP_CODE.get(toText(record.bbb_lookup) ?? 'not_searched') ?? 3;

      const roofing = classifyRoofingPermit({
        application_type_code: applicationCode,
        permit_type_code: typeCode,
        permit_type: typeLabel,
        description: descriptionText,
      }).is_roofing;

      let packed = 0;
      if (roofing) packed |= PERMIT_FLAG.roofing;
      if (record.roofing_relevant === true) packed |= PERMIT_FLAG.publisherRoofing;
      if (typeof record.bbb_accredited === 'boolean') {
        packed |= PERMIT_FLAG.accreditedKnown;
        if (record.bbb_accredited) packed |= PERMIT_FLAG.accredited;
      }
      flags[row] = packed;

      bump(permitCount, parcelRow);
      if (!currentApplications.has(applicationNo)) {
        currentApplications.add(applicationNo);
        bump(applicationCount, parcelRow);
      }
      if (resolved.status === 'unknown') bump(unknownStatusCount, parcelRow);
      if (isUnresolvedPermitStatus(resolved.status)) {
        bump(unresolvedCount, parcelRow);
        // The county's own measurement of how long it has been open, never arithmetic on a
        // date 29% of rows do not have. See `permitOpenYears` in the shared package.
        const years = Number.isNaN(openYears[row] as number) ? 0 : (openYears[row] as number);
        if (years > (maxOpenYears[parcelRow] as number)) maxOpenYears[parcelRow] = years;
        if (roofing) {
          bump(unresolvedRoofingCount, parcelRow);
          if (years > (maxOpenRoofingYears[parcelRow] as number)) {
            maxOpenRoofingYears[parcelRow] = years;
          }
        }
      }

      written += 1;
      permitEnd[parcelRow] = written;
    }

    parseMs += Date.now() - chunkStartedAt;
  }

  let parcelsWithPermits = 0;
  for (let row = 0; row < parcelRows; row += 1) {
    if ((permitCount[row] as number) > 0) parcelsWithPermits += 1;
  }

  const indexDisagreements: IndexDisagreements = {
    permitCount: 0,
    openPermitCount: 0,
    openRoofingPermitCount: 0,
  };
  for (const [row, expected] of published) {
    if (expected.permitCount !== (permitCount[row] as number)) {
      indexDisagreements.permitCount += 1;
    }
    if (expected.openPermitCount !== (unresolvedCount[row] as number)) {
      indexDisagreements.openPermitCount += 1;
    }
    if (expected.openRoofingPermitCount !== (unresolvedRoofingCount[row] as number)) {
      indexDisagreements.openRoofingPermitCount += 1;
    }
  }


  return {
    pointer,
    rowCount: written,
    rowsWithoutParcel,
    indexedParcelsMissing,
    parcelsWithPermits,
    statusQuarantined,
    nonContiguousParcels,
    indexDisagreements,
    permitStart,
    permitEnd,
    permitCount,
    applicationCount,
    unresolvedCount,
    unresolvedRoofingCount,
    unknownStatusCount,
    maxOpenYears,
    maxOpenRoofingYears,
    firstPermitMs,
    lastPermitMs,
    permitNumber,
    structureSequence: structureSequence.finish(),
    permitTypeSequence: permitTypeSequence.finish(),
    permitType: permitType.finish(),
    permitTypeCode: permitTypeCode.finish(),
    description: description.finish(),
    applicationTypeCode: applicationTypeCode.finish(),
    contractorName: contractorName.finish(),
    bbbRating: bbbRating.finish(),
    status,
    bbbLookup,
    issuedMs,
    closedMs,
    openYears,
    openYearsObservedMs,
    valuation,
    bbbScore,
    flags,
    fetchMs: artifacts.fetchMs(),
    parseMs,
    loadMs: Date.now() - startedAt,
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e6),
    bytes: artifacts.bytes,
    readyAt: new Date().toISOString(),
  };
}

const isoDate = (ms: number): string | null =>
  Number.isNaN(ms) ? null : (new Date(ms).toISOString().slice(0, 10) as string);


/** Materialises one permit row. Only rows actually rendered are ever built into records. */
export function permitRecordAt(snapshot: PermitSnapshot, row: number): PermitRecord {
  const packed = snapshot.flags[row] as number;
  const observedMs = snapshot.openYearsObservedMs[row] as number;
  const openYears = snapshot.openYears[row] as number;
  const score = snapshot.bbbScore[row] as number;
  const valuation = snapshot.valuation[row] as number;

  return {
    permit_number: snapshot.permitNumber[row] as string,
    structure_sequence:
      snapshot.structureSequence.values[snapshot.structureSequence.codes[row] as number] ?? null,
    permit_type_sequence:
      snapshot.permitTypeSequence.values[snapshot.permitTypeSequence.codes[row] as number] ?? null,
    application_type_code:
      snapshot.applicationTypeCode.values[snapshot.applicationTypeCode.codes[row] as number] ??
      null,
    permit_type_code:
      snapshot.permitTypeCode.values[snapshot.permitTypeCode.codes[row] as number] ?? null,
    permit_type: snapshot.permitType.values[snapshot.permitType.codes[row] as number] ?? '',
    description: snapshot.description.values[snapshot.description.codes[row] as number] ?? '',
    status: PERMIT_STATUSES[snapshot.status[row] as number] as PermitStatus,
    issued_date: isoDate(snapshot.issuedMs[row] as number),
    closed_date: isoDate(snapshot.closedMs[row] as number),
    open_years: Number.isNaN(openYears) ? null : openYears,
    open_years_observed_at: Number.isNaN(observedMs) ? null : new Date(observedMs).toISOString(),
    contractor_name:
      snapshot.contractorName.values[snapshot.contractorName.codes[row] as number] ?? null,
    /** Not published. The permit census carries the contractor's name and nothing else. */
    contractor_license: null,
    bbb_lookup: PERMIT_BBB_LOOKUPS[snapshot.bbbLookup[row] as number] as PermitBbbLookup,
    bbb_rating: snapshot.bbbRating.values[snapshot.bbbRating.codes[row] as number] ?? null,
    bbb_score: Number.isNaN(score) ? null : score,
    bbb_accredited:
      (packed & PERMIT_FLAG.accreditedKnown) === 0 ? null : (packed & PERMIT_FLAG.accredited) !== 0,
    valuation: Number.isNaN(valuation) ? null : valuation,
    is_roofing: (packed & PERMIT_FLAG.roofing) !== 0,
  };
}

/** Every permit on a parcel, in the order the county filed them. */
export function permitsForParcel(snapshot: PermitSnapshot, parcelRow: number): PermitRecord[] {
  const start = snapshot.permitStart[parcelRow] as number;
  if (start === INT_NULL) return [];
  const end = snapshot.permitEnd[parcelRow] as number;
  const records: PermitRecord[] = [];
  for (let row = start; row < end; row += 1) records.push(permitRecordAt(snapshot, row));
  return records;
}

/** Reads a Parquet object out of the store and hands its rows over in bounded chunks. */
async function* readChunks(
  store: SnapshotStore,
  key: string,
  columns: readonly string[],
  onFetchMs: (ms: number) => void,
): AsyncGenerator<Record<string, unknown>[]> {
  const fetchStartedAt = Date.now();
  const bytes = await store.getObject(key);
  onFetchMs(Date.now() - fetchStartedAt);

  const file = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const total = Number(parquetMetadata(file).num_rows);

  for (let start = 0; start < total; start += PARSE_CHUNK_ROWS) {
    yield (await parquetReadObjects({
      file,
      compressors,
      columns: [...columns],
      rowStart: start,
      rowEnd: Math.min(start + PARSE_CHUNK_ROWS, total),
    })) as Record<string, unknown>[];
  }
}


/**
 * Loads the two permit objects and folds them in.
 *
 * The published artifacts are ZSTD-compressed — DuckDB writes them, where the parcel snapshot
 * comes out of Spark as Snappy — so `hyparquet` needs its codec companion. That is a real
 * dependency the publication note did not anticipate; without it the read fails outright on
 * `unsupported compression codec: ZSTD` rather than degrading.
 */
export async function loadPermitSnapshot(
  store: SnapshotStore,
  pointer: PermitSnapshotPointer,
  parcels: ParcelSnapshot,
): Promise<PermitSnapshot> {
  let fetchMs = 0;
  const addFetchMs = (ms: number): void => {
    fetchMs += ms;
  };

  const indexBytesStartedAt = Date.now();
  const indexBytes = await store.getObject(pointer.files.parcelIndex.key);
  addFetchMs(Date.now() - indexBytesStartedAt);
  const indexFile = indexBytes.buffer.slice(
    indexBytes.byteOffset,
    indexBytes.byteOffset + indexBytes.byteLength,
  ) as ArrayBuffer;
  const index = (await parquetReadObjects({
    file: indexFile,
    compressors,
    columns: [...INDEX_COLUMNS],
  })) as Record<string, unknown>[];

  return buildPermitSnapshot(pointer, parcels, {
    index,
    permitChunks: readChunks(store, pointer.files.permits.key, PERMIT_COLUMNS, addFetchMs),
    bytes: pointer.totals?.bytes ?? indexBytes.byteLength,
    fetchMs: () => fetchMs,
  });
}
