import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatNumber } from '../format';

/**
 * Liveness, readiness, and dataset provenance in one place.
 *
 * The provenance card is the honest half. It names the source the API is actually reading, the
 * published snapshot it came from, and — just as importantly — what that source does not carry,
 * so a filter the UI has disabled has a stated reason somewhere the operator can find it.
 */

type Health = Awaited<ReturnType<typeof api.system.health.query>>;
type Readiness = Awaited<ReturnType<typeof api.system.readiness.query>>;
type Dataset = Awaited<ReturnType<typeof api.properties.dataset.query>>;

interface Probe {
  health: Health;
  readiness: Readiness;
  dataset: Dataset;
  leadCount: number;
}

type ProbeState =
  { status: 'loading' } | { status: 'ready'; probe: Probe } | { status: 'error'; message: string };

export function StatusView() {
  const [state, setState] = useState<ProbeState>({ status: 'loading' });

  const runProbe = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [health, readiness, dataset, leads] = await Promise.all([
        api.system.health.query(),
        api.system.readiness.query(),
        api.properties.dataset.query(),
        api.leads.list.query({ limit: 100 }),
      ]);
      setState({
        status: 'ready',
        probe: { health, readiness, dataset, leadCount: leads.items.length },
      });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  return (
    <div>
      <header className="content-head">
        <div>
          <h1>Platform status</h1>
          <p>
            Request path, datastore reachability, and the provenance of the property dataset the map
            is reading.
          </p>
        </div>
        <button
          className="button"
          type="button"
          data-testid="rerun-checks"
          onClick={() => void runProbe()}
        >
          Re-run checks
        </button>
      </header>

      <section className="cards">
        {state.status === 'loading' && <article className="panel">Checking the API…</article>}

        {state.status === 'error' && (
          <article className="panel panel--error" data-testid="status-error">
            <h2>API unreachable</h2>
            <p className="mono">{state.message}</p>
          </article>
        )}

        {state.status === 'ready' && (
          <>
            <article className="panel">
              <h2>
                API<span className="pill pill--ok">{state.probe.health.status}</span>
              </h2>
              <dl className="detail-grid">
                <dt>Service</dt>
                <dd className="mono">{state.probe.health.service}</dd>
                <dt>Region</dt>
                <dd className="mono">{state.probe.health.region}</dd>
                <dt>Phase</dt>
                <dd className="mono">{state.probe.health.phase}</dd>
                <dt>Checked</dt>
                <dd className="mono">{state.probe.health.checkedAt}</dd>
              </dl>
            </article>

            <article className="panel">
              <h2>
                DynamoDB
                <span className={`pill ${state.probe.readiness.ready ? 'pill--ok' : 'pill--bad'}`}>
                  {state.probe.readiness.dependencies.dynamodb}
                </span>
              </h2>
              <p>
                The API Lambda reached the single-table store with its own execution role. Leads are
                keyed <code>LEAD#&lt;leadId&gt;</code> / <code>META</code> and indexed on GSI1 by
                creation time.
              </p>
              <p className="metric" data-testid="status-lead-count">
                {state.probe.leadCount}
              </p>
              <p>Lead records currently stored.</p>
            </article>

            <article className="panel">
              <h2>
                Property dataset
                <span
                  className={`pill ${
                    state.probe.dataset.provider === 'published-parquet' ? 'pill--ok' : 'pill--warn'
                  }`}
                  data-testid="status-dataset-provider"
                >
                  {state.probe.dataset.provider}
                </span>
              </h2>
              <dl className="detail-grid">
                <dt>County</dt>
                <dd>{state.probe.dataset.county}</dd>
                <dt>Rows</dt>
                <dd className="mono" data-testid="status-dataset-rows">
                  {formatNumber(state.probe.dataset.rowCount)}
                </dd>
                <dt>Permit history</dt>
                <dd className="mono" data-testid="status-dataset-permits">
                  {state.probe.dataset.permitsAvailable ? 'available' : 'not loaded'}
                </dd>
                {state.probe.dataset.permits && (
                  <>
                    <dt>Permit rows</dt>
                    <dd className="mono" data-testid="status-permit-rows">
                      {formatNumber(state.probe.dataset.permits.permitRows)} on{' '}
                      {formatNumber(state.probe.dataset.permits.parcelsWithPermits)} parcels
                    </dd>
                    <dt>Permit load</dt>
                    <dd className="mono" data-testid="status-permit-load">
                      {state.probe.dataset.permits.loadMs} ms fetch+parse,{' '}
                      {state.probe.dataset.permits.heapUsedMb} MB heap
                    </dd>
                  </>
                )}
                {state.probe.dataset.snapshot && (
                  <>
                    <dt>Snapshot</dt>
                    <dd className="mono" data-testid="status-dataset-snapshot">
                      {state.probe.dataset.snapshot.runId}
                    </dd>
                    <dt>Published</dt>
                    <dd className="mono">{state.probe.dataset.snapshot.publishedAt}</dd>
                    <dt>Partitions</dt>
                    <dd className="mono">{state.probe.dataset.snapshot.objectCount}</dd>
                    <dt>Load</dt>
                    <dd className="mono" data-testid="status-dataset-load">
                      {state.probe.dataset.snapshot.loadMs} ms fetch+parse,{' '}
                      {state.probe.dataset.snapshot.heapUsedMb} MB heap
                    </dd>
                  </>
                )}
              </dl>
              <p>{state.probe.dataset.note}</p>
            </article>

            {state.probe.dataset.permits && (
              <PermitCoveragePanel coverage={state.probe.dataset.permits} />
            )}
          </>
        )}
      </section>
    </div>
  );
}

type PermitCoverage = NonNullable<Dataset['permits']>;

const percent = (part: number | null, whole: number | null): string => {
  if (part === null || whole === null) return 'not measured';
  return whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(part / whole < 0.01 ? 2 : 1)}%`;
};

/**
 * What the permit history cannot answer.
 *
 * Every number here bounds a conclusion the results list would otherwise imply. The permit
 * filters are only as good as the harvest behind them, and the harvest is a 1996-onward window
 * covering two parcels in five with a status on one application in eight hundred. Stating that
 * is the difference between "these are the county's open roofing permits" and "these are the
 * open roofing permits the county has confirmed", and only the second one is true.
 */
function PermitCoveragePanel({ coverage }: { coverage: PermitCoverage }) {
  const statusShare = percent(coverage.applicationsWithStatus, coverage.applicationsTotal);

  return (
    <article className="panel" data-testid="status-permit-coverage">
      <h2>
        Permit coverage
        <span className="pill pill--warn">partial</span>
      </h2>

      <dl className="detail-grid">
        <dt>History window</dt>
        <dd className="mono" data-testid="permit-coverage-window">
          {coverage.firstMonth ?? 'unknown'} to {coverage.lastMonth ?? 'unknown'}
          {coverage.windowComplete ? '' : ' (open-ended)'}
        </dd>

        <dt>Parcels with a permit</dt>
        <dd className="mono" data-testid="permit-coverage-parcels">
          {formatNumber(coverage.parcelsWithPermits)} of {formatNumber(coverage.parcelsTotal)} (
          {percent(coverage.parcelsWithPermits, coverage.parcelsTotal)})
        </dd>

        <dt>Applications with a status</dt>
        <dd className="mono" data-testid="permit-coverage-status">
          {formatNumber(coverage.applicationsWithStatus)} of{' '}
          {formatNumber(coverage.applicationsTotal)} ({statusShare})
        </dd>

        <dt>Status measured at</dt>
        <dd className="mono">{coverage.referenceDate ?? 'not stated'}</dd>

        <dt>Rows without a parcel</dt>
        <dd className="mono" data-testid="permit-coverage-dropped">
          {formatNumber(coverage.rowsWithoutParcel)} dropped,{' '}
          {formatNumber(coverage.indexedParcelsMissing)} indexed parcels absent
        </dd>

        <dt>Status strings quarantined</dt>
        <dd className="mono">{formatNumber(coverage.statusQuarantined)}</dd>

        <dt>Roofing verdict differs</dt>
        <dd className="mono" data-testid="permit-coverage-roofing">
          {formatNumber(coverage.roofingDisagreements)} parcels
        </dd>
      </dl>

      <p>
        <strong>No permit on a parcel is not "never permitted".</strong>{' '}
        {coverage.absenceMeaning ??
          `A parcel with no permit here had none issued inside the published window.`}
      </p>

      <p>
        <strong>An unknown status is unharvested, not closed.</strong> Only {statusShare} of
        applications have had their lifecycle read, so a parcel with an unknown-status permit is
        never presented as having no open permit — the permit filters match on confirmed-open
        permits only, and every search reports how many in-radius parcels it could not speak for.
      </p>

      <p>
        <strong>A missing contractor rating has four distinct meanings.</strong> The detail panel
        separates <em>rated</em>, <em>matched but unrated</em>, <em>searched with no match</em>, and{' '}
        <em>never looked up</em>, because collapsing them would read as a judgement on the
        contractor rather than a gap in the lookup.
      </p>
    </article>
  );
}
