/**
 * The published parcel snapshot, transposed into columns and held for the life of a Lambda
 * container.
 *
 * Four decisions are load-bearing, and each cost something to learn.
 *
 * **The snapshot is resolved through `publish/current.json`, never a hardcoded id.** Snapshot
 * ids are run-scoped and change on every publish, so a pinned id is a time bomb. The pointer
 * is the published interface; the parcel objects underneath it are an implementation detail of
 * that interface, and nothing else in the bucket is read.
 *
 * **Parquet is read with `hyparquet`, a pure-JS reader.** A native reader needs a
 * platform-specific binary in the bundle, which the shared Lambda construct has no seam for.
 *
 * **Rows are transposed into columns one partition at a time, and each partition's row objects
 * are dropped before the next is parsed.** Holding all 181,218 parsed rows alive at once costs
 * roughly 785 MB of heap — per-object and per-key overhead dominates, not the values — which
 * fits in no reasonable Lambda. Typed arrays for numerics, dictionaries for the two repetitive
 * string columns, and a packed byte for the booleans bring the same data down to a fraction of
 * that.
 *
 * **The geohash-5 partition key is trusted as the search index.** The publisher partitions by
 * `geohash5`, and that key was verified to match this repository's own `encodeGeohash` on every
 * row of a five-partition sample, so a radius search reads the cells it needs and ignores the
 * rest. Rows arrive grouped by cell, so a cell is a contiguous range rather than a list of
 * offsets.
 */

import {
  GEOHASH_PRECISION,
  PROPERTY_TYPES,
  encodeGeohash,
  type PropertyType,
} from '@roofing-crm/shared';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { z } from 'zod';

/** Sentinel for a missing integer: `Int32Array` has no null and every real value exceeds it. */
export const INT_NULL = -2147483648;

/**
 * The pointer the publisher maintains at a fixed key. Unknown fields are ignored rather than
 * rejected, so the publisher can add metadata without breaking this reader.
 */
export const parcelSnapshotPointerSchema = z.object({
  runId: z.string().min(1),
  county: z.string().min(1),
  snapshotPrefix: z.string().min(1),
  parcelCount: z.number().int().positive(),
  partitionCount: z.number().int().nonnegative().optional(),
  objectCount: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  publishedAt: z.string().min(1),
  /**
   * Where the permit history for this parcel generation sits, when the publisher has named it
   * here. Optional and not relied upon: this object is rewritten whole by the parcel publisher,
   * which drops the block until the permit step re-runs, so `publish/permits/current.json` is
   * the address the permit loader actually uses. Parsed so the block is discoverable rather
   * than silently dropped.
   */
  permits: z
    .object({
      available: z.boolean().optional(),
      runId: z.string().min(1),
      pointerKey: z.string().min(1).optional(),
    })
    .optional(),
});

export type ParcelSnapshotPointer = z.infer<typeof parcelSnapshotPointerSchema>;

/** Bit positions inside the packed flag byte. */
export const FLAG = {
  pool: 1,
  /** The publisher's absentee-owner verdict. Only meaningful when `outOfAreaKnown` is set. */
  outOfArea: 2,
  /** Distinguishes "the publisher says the owner is local" from "the publisher does not know". */
  outOfAreaKnown: 4,
} as const;

/** Columns actually read. Naming them keeps the other thirty-four out of heap entirely. */
export const SNAPSHOT_COLUMNS = [
  'parcel_id',
  'owner_name',
  'primary_address',
  'mailing_city_state_zip',
  'dor_code',
  'vacant_improved',
  'year_built',
  'roof_age',
  'last_sale_date',
  'last_sale_amount',
  'total_just_value',
  'assessed_value',
  'taxable_value',
  'total_living_area',
  'total_bedrooms',
  'total_bathrooms',
  'has_pool',
  'owner_out_of_area',
  'latitude',
  'longitude',
] as const;

/**
 * Property class, from the county's DOR land-use code.
 *
 * The mapping is derived from the 205 distinct `dor_code` values actually present in the
 * snapshot, not from a remembered version of the Florida DOR table. Two of those values are
 * worth naming: `0103 - TOWNHOME` carries 16,222 parcels, which is why `townhouse` is a real
 * class here rather than an unreachable one, and family `09 - RESIDENTIAL COMMON
 * ELEMENTS/AREAS` is land rather than housing, so it joins family `00` in `vacant`.
 *
 * A parcel the county marks `Vacant` is vacant whatever its land-use family says — 92 parcels
 * carry a single-family code with no structure on them, and calling those houses would put
 * unroofed land in front of a roofing crew.
 *
 * The county's commercial, industrial, agricultural, institutional and government families have
 * no distinct member in {@link PROPERTY_TYPES}, so they all land in `commercial`. That is lossy,
 * and it is why `dor_code` is carried onto the record: the detail panel can show the county's
 * own label rather than this bucket.
 */
export function classifyPropertyType(
  dorCode: string | null,
  vacantImproved: string | null,
): PropertyType {
  const family = dorCode?.slice(0, 2) ?? '';
  const specific = dorCode?.slice(0, 4) ?? '';

  if (specific === '0103' || specific === '0003') return 'townhouse';
  if (vacantImproved === 'Vacant') return 'vacant';
  if (family === '00' || family === '09') return 'vacant';
  if (family === '01') return 'single_family';
  if (family === '02') return 'mobile_home';
  // 03 and 08 are multi-family by unit count; 05 cooperatives, 06 retirement homes and
  // 07 miscellaneous residential are all shared-occupancy housing.
  if (family === '03' || family === '05' || family === '06' || family === '07' || family === '08') {
    return 'multi_family';
  }
  if (family === '04') return 'condo';
  return 'commercial';
}

const PROPERTY_TYPE_CODE: Record<PropertyType, number> = Object.fromEntries(
  PROPERTY_TYPES.map((type, index) => [type, index]),
) as Record<PropertyType, number>;

export interface ParcelSnapshot {
  pointer: ParcelSnapshotPointer;
  count: number;
  /**
   * Contiguous row range per geohash-5 cell. A radius search resolves candidate cells and walks
   * only these ranges, so the candidate set is bounded by area rather than by dataset size. An
   * array of ranges rather than one, so a cell split across objects still works.
   */
  cellRanges: Map<string, { start: number; end: number }[]>;
  /**
   * The cell each row sits in. Every row of a partition shares one string, so this costs a
   * pointer per parcel rather than a string per parcel, and saves a range scan when a returned
   * row needs its own `geohash5` back.
   */
  cellByRow: string[];
  byParcelId: Map<string, number>;

  parcelId: string[];
  ownerName: (string | null)[];
  primaryAddress: (string | null)[];
  /** Dictionary-coded: a few thousand distinct "CITY, ST ZIP" values across the county. */
  mailingCityStateZip: { codes: Uint32Array; values: (string | null)[] };
  dorCode: { codes: Uint16Array; values: (string | null)[] };
  propertyType: Uint8Array;

  yearBuilt: Int32Array;
  roofAge: Int32Array;

  lastSaleDateMs: Float64Array;
  /** Derived at load: the calendar year of the sale, so a "sold since" filter reads one int. */
  lastSaleYear: Int32Array;
  lastSaleAmount: Float64Array;
  totalJustValue: Float64Array;
  assessedValue: Float64Array;
  taxableValue: Float64Array;
  totalLivingArea: Float64Array;
  totalBedrooms: Float64Array;
  totalBathrooms: Float64Array;
  latitude: Float64Array;
  longitude: Float64Array;

  flags: Uint8Array;

  /** Observability, surfaced on the dataset banner so the load is not a black box. */
  /** Wall-clock time the load spent waiting on S3, distinct from the total fetch duration. */
  fetchMs: number;
  parseMs: number;
  loadMs: number;
  heapUsedMb: number;
  readyAt: string;
  objectCount: number;
  parcelsWithoutAddress: number;
  parcelsWithoutRoofAge: number;
}

function toText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return INT_NULL;
}

function toFloat(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.NaN;
}

/** `hyparquet` decodes a DATE logical type to a `Date`; a plainer writer may emit epoch days. */
function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value * 86_400_000;
  if (typeof value === 'bigint') return Number(value) * 86_400_000;
  return Number.NaN;
}

class DictionaryBuilder<T extends Uint16Array | Uint32Array> {
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
}

/** A parsed Parquet object together with the cell its partition path names. */
export interface ParcelPartition {
  cell: string;
  rows: Record<string, unknown>[];
}

/**
 * Writes partitions into pre-allocated columns as they arrive.
 *
 * Sized from the pointer's `parcelCount`. A snapshot that turns out to hold more rows than its
 * pointer claims is truncated rather than trusted: silently growing the arrays would let a
 * mis-stated pointer quietly double the container's memory.
 */
export class ParcelSnapshotBuilder {
  private readonly startedAt = Date.now();
  private parseMs = 0;
  private row = 0;
  private parcelsWithoutAddress = 0;
  private parcelsWithoutRoofAge = 0;
  private partitionsAdded = 0;

  private readonly size: number;
  private readonly parcelId: string[];
  private readonly ownerName: (string | null)[];
  private readonly primaryAddress: (string | null)[];
  private readonly mailing: DictionaryBuilder<Uint32Array>;
  private readonly dor: DictionaryBuilder<Uint16Array>;
  private readonly propertyType: Uint8Array;
  private readonly yearBuilt: Int32Array;
  private readonly roofAge: Int32Array;
  private readonly lastSaleDateMs: Float64Array;
  private readonly lastSaleYear: Int32Array;
  private readonly lastSaleAmount: Float64Array;
  private readonly totalJustValue: Float64Array;
  private readonly assessedValue: Float64Array;
  private readonly taxableValue: Float64Array;
  private readonly totalLivingArea: Float64Array;
  private readonly totalBedrooms: Float64Array;
  private readonly totalBathrooms: Float64Array;
  private readonly latitude: Float64Array;
  private readonly longitude: Float64Array;
  private readonly flags: Uint8Array;
  private readonly cellRanges = new Map<string, { start: number; end: number }[]>();
  private readonly cellByRow: string[];
  private readonly byParcelId = new Map<string, number>();

  constructor(private readonly pointer: ParcelSnapshotPointer) {
    const size = pointer.parcelCount;
    this.size = size;
    this.parcelId = new Array<string>(size);
    this.ownerName = new Array<string | null>(size);
    this.primaryAddress = new Array<string | null>(size);
    this.mailing = new DictionaryBuilder(new Uint32Array(size));
    this.dor = new DictionaryBuilder(new Uint16Array(size));
    this.propertyType = new Uint8Array(size);
    this.yearBuilt = new Int32Array(size);
    this.roofAge = new Int32Array(size);
    this.lastSaleDateMs = new Float64Array(size);
    this.lastSaleYear = new Int32Array(size);
    this.lastSaleAmount = new Float64Array(size);
    this.totalJustValue = new Float64Array(size);
    this.assessedValue = new Float64Array(size);
    this.taxableValue = new Float64Array(size);
    this.totalLivingArea = new Float64Array(size);
    this.totalBedrooms = new Float64Array(size);
    this.totalBathrooms = new Float64Array(size);
    this.latitude = new Float64Array(size);
    this.longitude = new Float64Array(size);
    this.flags = new Uint8Array(size);
    this.cellByRow = new Array<string>(size);
  }

  add(partition: ParcelPartition): void {
    const parseStartedAt = Date.now();
    const start = this.row;
    this.partitionsAdded += 1;

    for (const record of partition.rows) {
      if (this.row >= this.size) break;

      const id = toText(record.parcel_id);
      // A row with no parcel id cannot be addressed, linked to a lead, or de-duplicated.
      if (id === null) continue;

      const row = this.row;
      const address = toText(record.primary_address);
      if (address === null) this.parcelsWithoutAddress += 1;

      this.parcelId[row] = id;
      this.ownerName[row] = toText(record.owner_name);
      this.primaryAddress[row] = address;
      this.mailing.set(row, toText(record.mailing_city_state_zip));

      const dorCode = toText(record.dor_code);
      this.dor.set(row, dorCode);
      this.propertyType[row] =
        PROPERTY_TYPE_CODE[classifyPropertyType(dorCode, toText(record.vacant_improved))];

      this.yearBuilt[row] = toInt(record.year_built);
      const roof = toInt(record.roof_age);
      this.roofAge[row] = roof;
      if (roof === INT_NULL) this.parcelsWithoutRoofAge += 1;

      const saleMs = toEpochMs(record.last_sale_date);
      this.lastSaleDateMs[row] = saleMs;
      this.lastSaleYear[row] = Number.isNaN(saleMs) ? INT_NULL : new Date(saleMs).getUTCFullYear();
      this.lastSaleAmount[row] = toFloat(record.last_sale_amount);
      this.totalJustValue[row] = toFloat(record.total_just_value);
      this.assessedValue[row] = toFloat(record.assessed_value);
      this.taxableValue[row] = toFloat(record.taxable_value);
      this.totalLivingArea[row] = toFloat(record.total_living_area);
      this.totalBedrooms[row] = toFloat(record.total_bedrooms);
      this.totalBathrooms[row] = toFloat(record.total_bathrooms);
      this.latitude[row] = toFloat(record.latitude);
      this.longitude[row] = toFloat(record.longitude);

      let packed = 0;
      if (record.has_pool === true) packed |= FLAG.pool;
      if (typeof record.owner_out_of_area === 'boolean') {
        packed |= FLAG.outOfAreaKnown;
        if (record.owner_out_of_area) packed |= FLAG.outOfArea;
      }
      this.flags[row] = packed;

      this.cellByRow[row] = partition.cell;
      this.byParcelId.set(id, row);
      this.row += 1;
    }

    if (this.row > start) {
      const ranges = this.cellRanges.get(partition.cell);
      if (ranges) ranges.push({ start, end: this.row });
      else this.cellRanges.set(partition.cell, [{ start, end: this.row }]);
    }

    this.parseMs += Date.now() - parseStartedAt;
  }

  finish(fetchMs: number): ParcelSnapshot {
    return {
      pointer: this.pointer,
      count: this.row,
      cellRanges: this.cellRanges,
      cellByRow: this.cellByRow,
      byParcelId: this.byParcelId,
      parcelId: this.parcelId,
      ownerName: this.ownerName,
      primaryAddress: this.primaryAddress,
      mailingCityStateZip: { codes: this.mailing.codes, values: this.mailing.values },
      dorCode: { codes: this.dor.codes, values: this.dor.values },
      propertyType: this.propertyType,
      yearBuilt: this.yearBuilt,
      roofAge: this.roofAge,
      lastSaleDateMs: this.lastSaleDateMs,
      lastSaleYear: this.lastSaleYear,
      lastSaleAmount: this.lastSaleAmount,
      totalJustValue: this.totalJustValue,
      assessedValue: this.assessedValue,
      taxableValue: this.taxableValue,
      totalLivingArea: this.totalLivingArea,
      totalBedrooms: this.totalBedrooms,
      totalBathrooms: this.totalBathrooms,
      latitude: this.latitude,
      longitude: this.longitude,
      flags: this.flags,
      fetchMs,
      parseMs: this.parseMs,
      loadMs: Date.now() - this.startedAt,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e6),
      readyAt: new Date().toISOString(),
      objectCount: this.partitionsAdded,
      parcelsWithoutAddress: this.parcelsWithoutAddress,
      parcelsWithoutRoofAge: this.parcelsWithoutRoofAge,
    };
  }
}

/** Convenience for tests: build a snapshot from partitions already in memory. */
export function buildParcelSnapshot(
  pointer: ParcelSnapshotPointer,
  partitions: readonly ParcelPartition[],
): ParcelSnapshot {
  const builder = new ParcelSnapshotBuilder(pointer);
  for (const partition of partitions) builder.add(partition);
  return builder.finish(0);
}

/**
 * The bucket operations the loader needs, named as an interface so the snapshot can be loaded
 * from fixtures in a test without an S3 client or credentials.
 */
export interface SnapshotStore {
  readPointer(): Promise<unknown>;
  listKeys(prefix: string): Promise<string[]>;
  getObject(key: string): Promise<Uint8Array>;
}

/** Parallel GETs. The objects average ~700 KB, so ten in flight saturates the link. */
const FETCH_CONCURRENCY = 10;

/** `.../geohash5=djn5h/part-000...parquet` — the partition key is in the path, not the file. */
export function cellFromKey(key: string): string | null {
  return key.match(/geohash5=([^/]+)\//)?.[1] ?? null;
}

/**
 * Fetches every object and folds it into the snapshot.
 *
 * Fetching runs ahead of parsing at a bounded depth so the network is never idle while the CPU
 * transposes, but the queue is capped: an unbounded prefetch would hold all 40 MB of compressed
 * bytes *and* the parsed rows at once, which is the peak this design is built to avoid. Each
 * buffer is released as soon as its rows are folded in.
 */
export async function loadParcelSnapshot(
  store: SnapshotStore,
  pointer: ParcelSnapshotPointer,
): Promise<ParcelSnapshot> {
  const prefix = pointer.snapshotPrefix.replace(/^s3:\/\/[^/]+\//, '');
  const keys = (await store.listKeys(prefix)).filter((key) => key.endsWith('.parquet'));
  if (keys.length === 0) {
    throw new Error(`published snapshot ${pointer.runId} has no Parquet objects at ${prefix}`);
  }

  const builder = new ParcelSnapshotBuilder(pointer);
  /**
   * Wall-clock time the parse loop spent blocked on the network, not the sum of the fetch
   * durations. Summing overlapping concurrent fetches produces a number larger than the whole
   * load took, which is worse than no measurement at all.
   */
  let fetchWaitMs = 0;

  const inFlight = new Map<number, Promise<Uint8Array>>();
  const startFetch = (index: number): void => {
    const key = keys[index];
    if (key === undefined) return;
    inFlight.set(index, store.getObject(key));
  };

  for (let index = 0; index < Math.min(FETCH_CONCURRENCY, keys.length); index += 1) {
    startFetch(index);
  }

  for (let index = 0; index < keys.length; index += 1) {
    const pending = inFlight.get(index);
    if (pending === undefined) throw new Error(`object ${index} was never fetched`);
    const waitStartedAt = Date.now();
    const bytes = await pending;
    fetchWaitMs += Date.now() - waitStartedAt;
    inFlight.delete(index);
    startFetch(index + FETCH_CONCURRENCY);

    const file = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    /**
     * The parcel objects are Snappy, which `hyparquet` reads on its own. The codec pack is
     * passed anyway so the reader does not depend on which writer produced the snapshot — the
     * permit artifacts come out of DuckDB as ZSTD and fail outright without it.
     */
    const rows = (await parquetReadObjects({
      file,
      compressors,
      columns: [...SNAPSHOT_COLUMNS],
    })) as Record<string, unknown>[];

    // The partition path is the fast path for the cell, but a snapshot that ever stops being
    // partitioned by geohash5 must still be searchable, so fall back to computing it.
    const cell = cellFromKey(keys[index] as string);
    if (cell !== null) builder.add({ cell, rows });
    else for (const partition of groupRowsByCell(rows)) builder.add(partition);
  }

  return builder.finish(fetchWaitMs);
}

/** Fallback for an unpartitioned snapshot: bucket rows by their own coordinates. */
function groupRowsByCell(rows: Record<string, unknown>[]): ParcelPartition[] {
  const byCell = new Map<string, Record<string, unknown>[]>();
  for (const record of rows) {
    const latitude = toFloat(record.latitude);
    const longitude = toFloat(record.longitude);
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) continue;
    const cell = encodeGeohash(latitude, longitude, GEOHASH_PRECISION);
    const bucket = byCell.get(cell);
    if (bucket) bucket.push(record);
    else byCell.set(cell, [record]);
  }
  return [...byCell.entries()].map(([cell, cellRows]) => ({ cell, rows: cellRows }));
}
