/**
 * Caching behaviour of the snapshot provider.
 *
 * The costs being managed here are asymmetric: re-reading the 50 MB of published data when
 * nothing changed wastes a cold start, and *not* re-reading it after a publish serves
 * yesterday's parcels for as long as the container lives. Both are tested, as is the failure
 * case — a cached rejected promise would otherwise fail every request for the rest of the
 * container's life.
 *
 * Permits have their own pointer and their own run id, so a permit-only publish has to
 * invalidate the cache too: the parcels are unchanged but what a permit filter answers is not.
 */

import { describe, expect, it, vi } from 'vitest';
import { type ParcelSnapshotPointer } from './parcel-snapshot';
import { S3SnapshotProvider, type PublishedSnapshotStore } from './s3-snapshot-provider';

vi.mock('../observability', () => ({
  logger: { info: () => undefined, error: () => undefined, warn: () => undefined },
}));

function pointer(runId: string): ParcelSnapshotPointer {
  return {
    runId,
    county: 'Seminole County, FL',
    snapshotPrefix: `s3://bucket/publish/parcels/snapshot=${runId}/`,
    parcelCount: 1,
    publishedAt: '2026-09-01T14:16:20.247Z',
  };
}

function permitPointer(runId: string): Record<string, unknown> {
  return {
    runId,
    county: 'Seminole County, FL',
    publishedAt: '2026-09-01T16:59:40.693Z',
    files: {
      permits: { key: `publish/permits/snapshot=${runId}/permits.parquet`, rows: 1 },
      parcelIndex: { key: `publish/permits/snapshot=${runId}/parcel-index.parquet`, rows: 1 },
    },
  };
}

/**
 * A store whose objects are not real Parquet. The provider's job is deciding *when* to load, so
 * the load is allowed to fail: what matters is how many times it was attempted.
 */
function countingStore(runId: () => string, permitRunId: () => string | null = () => null) {
  const calls = { pointer: 0, permitPointer: 0, list: 0 };
  const store: PublishedSnapshotStore = {
    readPointer: async () => {
      calls.pointer += 1;
      return pointer(runId());
    },
    readPermitPointer: async () => {
      calls.permitPointer += 1;
      const id = permitRunId();
      return id === null ? null : permitPointer(id);
    },
    listKeys: async () => {
      calls.list += 1;
      return ['publish/parcels/snapshot=x/geohash5=djn5h/part-0.parquet'];
    },
    getObject: async () => {
      throw new Error('not parquet');
    },
  };
  return { store, calls };
}

describe('S3SnapshotProvider', () => {
  it('re-reads only the pointer while the run is unchanged', async () => {
    const { store, calls } = countingStore(() => 'run-1');
    const provider = new S3SnapshotProvider('bucket', store);

    await expect(provider.get()).rejects.toThrow();
    // The failed load is evicted, so the next call retries rather than replaying the failure.
    await expect(provider.get()).rejects.toThrow();

    expect(calls.pointer).toBe(2);
    expect(calls.list).toBe(2);
  });

  it('does not cache a failed load', async () => {
    let attempts = 0;
    const { store } = countingStore(() => 'run-1');
    const failing: PublishedSnapshotStore = {
      ...store,
      listKeys: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient S3 failure');
        return [];
      },
    };

    const provider = new S3SnapshotProvider('bucket', failing);

    await expect(provider.get()).rejects.toThrow('transient S3 failure');
    // A second attempt reaches S3 again and fails differently, proving the first was not cached.
    await expect(provider.get()).rejects.toThrow('no Parquet objects');
    expect(attempts).toBe(2);
  });

  it('reloads when the pointer names a new run', async () => {
    let run = 'run-1';
    const prefixes: string[] = [];
    const { store } = countingStore(() => run);
    const listing: PublishedSnapshotStore = {
      ...store,
      listKeys: async (prefix) => {
        prefixes.push(prefix);
        return [];
      },
    };

    const provider = new S3SnapshotProvider('bucket', listing);
    await expect(provider.get()).rejects.toThrow('no Parquet objects');

    run = 'run-2';
    await expect(provider.get()).rejects.toThrow('no Parquet objects');

    expect(prefixes).toEqual([
      'publish/parcels/snapshot=run-1/',
      'publish/parcels/snapshot=run-2/',
    ]);
  });

  /**
   * A permit publish leaves the parcel pointer untouched, so keying the cache on the parcel run
   * alone would serve the previous permit generation until the container died — and permits are
   * the fast-moving half of this dataset while the status sweep runs.
   */
  it('reloads when only the permit generation changes', async () => {
    let permitRun: string | null = 'permits-1';
    const { store, calls } = countingStore(
      () => 'run-1',
      () => permitRun,
    );

    const provider = new S3SnapshotProvider('bucket', store);
    await expect(provider.get()).rejects.toThrow();
    expect(calls.list).toBe(1);

    permitRun = 'permits-2';
    await expect(provider.get()).rejects.toThrow();
    expect(calls.list).toBe(2);
    expect(calls.permitPointer).toBe(2);
  });

  /**
   * No permits published is a state, not a failure: the site stays up on parcels alone and the
   * permit filters report themselves unsupported.
   */
  it('loads parcels alone when no permit pointer exists', async () => {
    const { store } = countingStore(
      () => 'run-1',
      () => null,
    );
    const parcelOnly: PublishedSnapshotStore = {
      ...store,
      listKeys: async () => [],
    };

    const provider = new S3SnapshotProvider('bucket', parcelOnly);
    // The parcel load is what fails here; the missing permits pointer did not stop it being tried.
    await expect(provider.get()).rejects.toThrow('no Parquet objects');
  });

  it('rejects a pointer that is missing required fields rather than loading a partial snapshot', async () => {
    const { store } = countingStore(() => 'run-1');
    const broken: PublishedSnapshotStore = {
      ...store,
      readPointer: async () => ({ runId: 'run-1' }),
    };

    const provider = new S3SnapshotProvider('bucket', broken);
    await expect(provider.get()).rejects.toThrow();
  });

  it('accepts a pointer carrying fields this reader does not use', async () => {
    const { store } = countingStore(() => 'run-1');
    const extra: PublishedSnapshotStore = {
      ...store,
      readPointer: async () => ({
        ...pointer('run-1'),
        changeSetKey: 'publish/manifests/run-1/change_set.json',
        format: 'parquet',
        partitionedBy: ['geohash5'],
        /**
         * The publisher names the permit generation here too. It is parsed rather than dropped,
         * but it is not what the permit loader reads: this object is rewritten whole on every
         * parcel publish and loses the block until the permit step re-runs.
         */
        permits: {
          available: true,
          runId: 'permits-9af71540b16b',
          pointerKey: 'publish/permits/current.json',
        },
      }),
      listKeys: async () => [],
    };

    const provider = new S3SnapshotProvider('bucket', extra);
    // Reaching the "no objects" error means the pointer parsed rather than being rejected.
    await expect(provider.get()).rejects.toThrow('no Parquet objects');
  });
});
