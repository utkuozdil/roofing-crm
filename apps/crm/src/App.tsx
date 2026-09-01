import { useState } from 'react';
import { LIVE_SECTIONS, PLACEHOLDER_SECTIONS, type ViewId } from './nav';
import { useLeads } from './useLeads';
import { LeadsView } from './views/LeadsView';
import { MapView } from './views/MapView';
import { StatusView } from './views/StatusView';

/**
 * Application shell. Lead state is owned here rather than inside either view, so creating
 * a lead from the map's detail panel and managing it in the pipeline operate on one list.
 *
 * The placeholder sections below the live nav are rendered visibly and disabled: they are
 * an acceptance criterion in their own right, showing where the product expands past lead
 * identification without pretending any of it is built.
 */

export function App() {
  const [view, setView] = useState<ViewId>('map');
  const leads = useLeads();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Roofing CRM</span>
        </div>

        <nav aria-label="Primary">
          {LIVE_SECTIONS.map((section) => (
            <button
              key={section.id}
              className={`nav-item ${view === section.id ? 'nav-item--active' : ''}`}
              type="button"
              data-testid={`nav-${section.id}`}
              aria-current={view === section.id ? 'page' : undefined}
              onClick={() => setView(section.id)}
            >
              {section.label}
              {section.id === 'leads' && leads.leads.length > 0 && (
                <span className="nav-count">{leads.leads.length}</span>
              )}
            </button>
          ))}
        </nav>

        <nav aria-label="Planned sections, not yet available" className="nav-planned">
          <p className="nav-heading">Coming later</p>
          {PLACEHOLDER_SECTIONS.map((section) => (
            <button
              key={section.slug}
              className="nav-item"
              type="button"
              disabled
              aria-disabled="true"
              title={section.description}
              data-testid={`nav-placeholder-${section.slug}`}
            >
              {section.label}
            </button>
          ))}
        </nav>

        <p className="sidebar-foot">
          Seminole County, FL · fixture-backed property data pending the ingestion pipeline
        </p>
      </aside>

      <main className="content">
        {view === 'map' && <MapView leads={leads} />}
        {view === 'leads' && <LeadsView leads={leads} />}
        {view === 'status' && <StatusView />}

        <section className="planned" data-testid="planned-sections">
          <h2>Planned CRM surfaces</h2>
          <p className="note">
            Shown disabled so the shape of the product beyond lead identification is visible. None
            of these are implemented.
          </p>
          <ul>
            {PLACEHOLDER_SECTIONS.map((section) => (
              <li key={section.slug} data-testid={`planned-${section.slug}`} aria-disabled="true">
                <strong>{section.label}</strong>
                <span>{section.description}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
