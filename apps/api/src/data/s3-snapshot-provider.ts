/**
 * Reads the published snapshots out of the publisher's bucket and keeps them for the container.
 *
 * The publisher republishes nightly, so a container that outlives a publish would otherwise
 * serve yesterday's parcels forever. Re-reading 50 MB to find that out would be wasteful, so
 * only the small pointer objects are re-read, and the data is reloaded only when a pointer
 * names a different run.
 *
 * Permits are read from `publish/permits/current.json` rather than from the `permits` block on
 * the parcel pointer. Both name the same generation, but the parcel publisher rewrites its
 * pointer whole and drops the block until the permit step re-runs, so the block is a discovery
 * hint and this key is the durable address.
 *
 * A missing permits pointer degrades to parcels-only rather than failing the load: the site
 * stays up, the permit filters report themselves unsupported, and the status card says permit
 * history is not loaded. A *failed* load of a pointer that does exist is not swallowed — that
 * is a real fault and it clears the cache so the next request retries.
 */

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { AWS_REGION } from '@roofing-crm/shared';
import { logger } from '../observability';
import {
  type ParcelSnapshot,
  type SnapshotStore,
  loadParcelSnapshot,
  parcelSnapshotPointerSchema,
} from './parcel-snapshot';
import { loadPermitSnapshot, permitSnapshotPointerSchema } from './permit-snapshot';
import type { PublishedSnapshot, SnapshotProvider } from './published-source';

/** The two keys in the data lake the serving tier is allowed to know. */
const PUBLISH_POINTER_KEY = 'publish/current.json';
const PERMIT_POINTER_KEY = 'publish/permits/current.json';

/** How long a warm container trusts its pointers before re-reading them. Data changes nightly. */
const POINTER_TTL_MS = 10 * 60 * 1000;

export class S3SnapshotStore implements SnapshotStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string = AWS_REGION,
  ) {
    this.client = new S3Client({ region });
  }

  async readPointer(): Promise<unknown> {
    return this.readJson(PUBLISH_POINTER_KEY);
  }

  /** Null when the publisher has not published permits, which is a state and not a failure. */
  async readPermitPointer(): Promise<unknown | null> {
    try {
      return await this.readJson(PERMIT_POINTER_KEY);
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw error;
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key);
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken !== undefined);
    return keys;
  }

  async getObject(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (bytes === undefined) throw new Error(`s3://${this.bucket}/${key} returned no body`);
    return bytes;
  }

  private async readJson(key: string): Promise<unknown> {
    const bytes = await this.getObject(key);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
}

/** Extends the parcel store with the permits pointer, which is a separate published key. */
export interface PublishedSnapshotStore extends SnapshotStore {
  readPermitPointer(): Promise<unknown | null>;
}

interface CacheEntry {
  parcelRunId: string;
  permitRunId: string | null;
  snapshot: Promise<PublishedSnapshot>;
  pointerCheckedAt: number;
}

export class S3SnapshotProvider implements SnapshotProvider {
  private readonly store: PublishedSnapshotStore;
  private cache: CacheEntry | null = null;

  constructor(bucket: string, store?: PublishedSnapshotStore) {
    this.store = store ?? new S3SnapshotStore(bucket);
  }

  async get(): Promise<PublishedSnapshot> {
    const now = Date.now();
    const cached = this.cache;
    if (cached && now - cached.pointerCheckedAt < POINTER_TTL_MS) return cached.snapshot;

    const pointer = parcelSnapshotPointerSchema.parse(await this.store.readPointer());
    const rawPermitPointer = await this.store.readPermitPointer();
    const permitPointer =
      rawPermitPointer === null ? null : permitSnapshotPointerSchema.parse(rawPermitPointer);

    // Both generations have to match for the cache to stand: a new permit publish against the
    // same parcels still changes what a permit filter answers.
    if (
      cached &&
      cached.parcelRunId === pointer.runId &&
      cached.permitRunId === (permitPointer?.runId ?? null)
    ) {
      cached.pointerCheckedAt = now;
      return cached.snapshot;
    }

    const entry: CacheEntry = {
      parcelRunId: pointer.runId,
      permitRunId: permitPointer?.runId ?? null,
      snapshot: this.load(pointer, permitPointer),
      pointerCheckedAt: now,
    };
    this.cache = entry;

    entry.snapshot.catch((error: unknown) => {
      logger.error('Failed to load published snapshot', {
        parcelRunId: pointer.runId,
        permitRunId: permitPointer?.runId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.cache === entry) this.cache = null;
    });

    return entry.snapshot;
  }

  private async load(
    pointer: ReturnType<typeof parcelSnapshotPointerSchema.parse>,
    permitPointer: ReturnType<typeof permitSnapshotPointerSchema.parse> | null,
  ): Promise<PublishedSnapshot> {
    const parcels: ParcelSnapshot = await loadParcelSnapshot(this.store, pointer);
    logger.info('Published parcel snapshot ready', {
      runId: parcels.pointer.runId,
      parcels: parcels.count,
      objects: parcels.objectCount,
      fetchMs: parcels.fetchMs,
      parseMs: parcels.parseMs,
      loadMs: parcels.loadMs,
      heapUsedMb: parcels.heapUsedMb,
    });

    if (permitPointer === null) {
      logger.warn('No published permit history found; permit filters will report unsupported', {
        key: PERMIT_POINTER_KEY,
      });
      return { parcels, permits: null };
    }


    const permits = await loadPermitSnapshot(this.store, permitPointer, parcels);
    logger.info('Published permit snapshot ready', {
      runId: permits.pointer.runId,
      permitRows: permits.rowCount,
      parcelsWithPermits: permits.parcelsWithPermits,
      rowsWithoutParcel: permits.rowsWithoutParcel,
      indexedParcelsMissing: permits.indexedParcelsMissing,
      statusQuarantined: permits.statusQuarantined,
      nonContiguousParcels: permits.nonContiguousParcels,
      indexDisagreements: permits.indexDisagreements,
      fetchMs: permits.fetchMs,
      parseMs: permits.parseMs,
      loadMs: permits.loadMs,
      heapUsedMb: permits.heapUsedMb,
    });

    return { parcels, permits };
  }
}
