import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatNumber } from '../format';

/**
 * Liveness, readiness, and dataset provenance in one place.
 *
 * The provenance card is the honest half: the properties the CRM is searching come from a
 * seeded fixture source, not from the county, and the UI says so rather than presenting
 * synthetic parcels as records of fact.
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
                <span className="pill pill--warn" data-testid="status-dataset-provider">
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
              </dl>
              <p>{state.probe.dataset.note}</p>
            </article>
          </>
        )}
      </section>
    </div>
  );
}
