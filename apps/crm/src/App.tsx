import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

type Health = Awaited<ReturnType<typeof api.system.health.query>>;
type Readiness = Awaited<ReturnType<typeof api.system.readiness.query>>;

interface Probe {
  health: Health;
  readiness: Readiness;
  leadCount: number;
}

type ProbeState =
  { status: 'loading' } | { status: 'ready'; probe: Probe } | { status: 'error'; message: string };

/** Sections the CRM will grow into. Rendered disabled so the shape of the product is visible. */
const PLANNED_SECTIONS = [
  { name: 'Map & radius search', detail: 'GPS or pin-drop centre with a configurable radius' },
  { name: 'Aged roofs', detail: 'Roof age above a configurable threshold' },
  { name: 'Open permits', detail: 'Long-open roofing permits with contractor and BBB score' },
  { name: 'Leads', detail: 'Convert qualified properties into CRM lead records' },
  { name: 'Agent', detail: 'Natural-language search over property and permit data' },
];

export function App() {
  const [state, setState] = useState<ProbeState>({ status: 'loading' });

  const runProbe = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [health, readiness, leads] = await Promise.all([
        api.system.health.query(),
        api.system.readiness.query(),
        api.leads.list.query({ limit: 1 }),
      ]);
      setState({
        status: 'ready',
        probe: { health, readiness, leadCount: leads.items.length },
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
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Roofing CRM</span>
        </div>
        <nav>
          <button className="nav-item nav-item--active" type="button">
            Platform status
          </button>
          {PLANNED_SECTIONS.map((section) => (
            <button key={section.name} className="nav-item" type="button" disabled>
              {section.name}
            </button>
          ))}
        </nav>
        <p className="sidebar-foot">Phase 0 — infrastructure only</p>
      </aside>

      <main className="content">
        <header className="content-head">
          <div>
            <h1>Platform status</h1>
            <p>
              This deployment provisions the CRM&apos;s infrastructure and proves the request path
              end to end. Lead identification arrives in a later phase.
            </p>
          </div>
          <button className="refresh" type="button" onClick={() => void runProbe()}>
            Re-run checks
          </button>
        </header>

        <section className="cards">
          {state.status === 'loading' && <article className="card">Checking the API…</article>}

          {state.status === 'error' && (
            <article className="card card--error">
              <h2>API unreachable</h2>
              <p className="mono">{state.message}</p>
            </article>
          )}

          {state.status === 'ready' && (
            <>
              <article className="card">
                <h2>
                  API<span className="pill pill--ok">{state.probe.health.status}</span>
                </h2>
                <dl>
                  <dt>Service</dt>
                  <dd className="mono">{state.probe.health.service}</dd>
                  <dt>Region</dt>
                  <dd className="mono">{state.probe.health.region}</dd>
                  <dt>Checked</dt>
                  <dd className="mono">{state.probe.health.checkedAt}</dd>
                </dl>
              </article>

              <article className="card">
                <h2>
                  DynamoDB
                  <span
                    className={`pill ${state.probe.readiness.ready ? 'pill--ok' : 'pill--bad'}`}
                  >
                    {state.probe.readiness.dependencies.dynamodb}
                  </span>
                </h2>
                <p>
                  The API Lambda reached the single-table store with its own execution role. Leads
                  are keyed <code>LEAD#&lt;leadId&gt;</code> / <code>META</code> and indexed on
                  GSI1.
                </p>
              </article>

              <article className="card">
                <h2>Leads</h2>
                <p className="metric">{state.probe.leadCount}</p>
                <p>Records returned from the GSI1 read path. Empty is expected in Phase 0.</p>
              </article>
            </>
          )}
        </section>

        <section className="planned">
          <h2>Planned surfaces</h2>
          <ul>
            {PLANNED_SECTIONS.map((section) => (
              <li key={section.name}>
                <strong>{section.name}</strong>
                <span>{section.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
