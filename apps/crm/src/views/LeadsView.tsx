import {
  DEFAULT_LEAD_PIPELINE_FILTERS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  SEMINOLE_COUNTY_CENTER,
  matchesLeadFilters,
  resolveLocationInput,
  type LeadPipelineFilters,
  type LeadStatus,
  type PermitFilterMode,
} from '@roofing-crm/shared';
import { useMemo, useState } from 'react';
import { formatDate, formatYears } from '../format';
import type { useLeads } from '../useLeads';

/**
 * The lead pipeline. Status is a `<select>` and delete is a button per row, so the full
 * CRUD surface is reachable without any composite interaction.
 *
 * Filters reuse the map's vocabulary — roof age, permit status / open duration, radius —
 * and default to off so a saved lead is not hidden until the operator asks.
 */

export interface LeadsViewProps {
  leads: ReturnType<typeof useLeads>;
}

const PERMIT_MODE_LABELS: Record<PermitFilterMode, string> = {
  any: 'Any permit history',
  unresolved: 'Has an unresolved permit',
  roofing_unresolved: 'Has an unresolved roofing permit',
  none: 'No permit history',
};

export function LeadsView({ leads }: LeadsViewProps) {
  const [filters, setFilters] = useState<LeadPipelineFilters>(DEFAULT_LEAD_PIPELINE_FILTERS);
  const [center, setCenter] = useState(SEMINOLE_COUNTY_CENTER);
  const [centerLabel, setCenterLabel] = useState('Seminole County centre');
  const [locationText, setLocationText] = useState('');
  const [locationError, setLocationError] = useState<string | null>(null);

  const visible = useMemo(
    () => leads.leads.filter((lead) => matchesLeadFilters(lead, filters, center)),
    [leads.leads, filters, center],
  );

  const applyLocation = () => {
    const resolved = resolveLocationInput(locationText);
    if (!resolved) {
      setLocationError(
        'Could not read that location. Enter a Seminole County city or ZIP, or coordinates as “28.75,-81.28”.',
      );
      return;
    }
    setCenter({ latitude: resolved.latitude, longitude: resolved.longitude });
    setCenterLabel(resolved.label);
    setLocationError(null);
  };

  const resetFilters = () => {
    setFilters(DEFAULT_LEAD_PIPELINE_FILTERS);
    setCenter(SEMINOLE_COUNTY_CENTER);
    setCenterLabel('Seminole County centre');
    setLocationText('');
    setLocationError(null);
  };

  const patch = (next: Partial<LeadPipelineFilters>) => {
    setFilters((current) => ({ ...current, ...next }));
  };

  return (
    <div>
      <header className="content-head">
        <div>
          <h1>Lead pipeline</h1>
          <p>Leads you created from properties on the map, newest first.</p>
        </div>
        <button
          className="button"
          type="button"
          data-testid="refresh-leads"
          onClick={() => void leads.refresh()}
        >
          Refresh
        </button>
      </header>

      <section className="panel lead-filters" data-testid="lead-filters" aria-label="Filter saved leads">
        <div className="search-bar">
          <div className="search-bar-block">
            <label className="field" htmlFor="lead-roof-age">
              <span>
                Roof at least <strong data-testid="lead-roof-age-value">{filters.minRoofAgeYears}</strong>{' '}
                years
              </span>
              <input
                id="lead-roof-age"
                data-testid="lead-roof-age"
                type="range"
                min={0}
                max={70}
                step={1}
                value={filters.minRoofAgeYears}
                onChange={(event) => patch({ minRoofAgeYears: Number(event.target.value) })}
              />
            </label>
          </div>

          <div className="search-bar-block">
            <label className="field" htmlFor="lead-permit-status">
              <span>Permit status</span>
              <select
                id="lead-permit-status"
                data-testid="lead-permit-status"
                value={filters.permitStatus}
                onChange={(event) =>
                  patch({ permitStatus: event.target.value as PermitFilterMode })
                }
              >
                {Object.entries(PERMIT_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="search-bar-block">
            <label className="field" htmlFor="lead-permit-open-years">
              <span>
                Open at least{' '}
                <strong data-testid="lead-permit-open-years-value">{filters.minPermitOpenYears}</strong>{' '}
                years
              </span>
              <input
                id="lead-permit-open-years"
                data-testid="lead-permit-open-years"
                type="range"
                min={0}
                max={40}
                step={1}
                value={filters.minPermitOpenYears}
                onChange={(event) => patch({ minPermitOpenYears: Number(event.target.value) })}
              />
            </label>
          </div>

          <div className="search-bar-block">
            <label className="field" htmlFor="lead-radius">
              <span>
                Radius <strong data-testid="lead-radius-value">{filters.radiusMiles}</strong> miles
                {filters.radiusMiles === 0 ? ' · any distance' : ''}
              </span>
              <input
                id="lead-radius"
                data-testid="lead-radius"
                type="range"
                min={0}
                max={25}
                step={0.5}
                value={filters.radiusMiles}
                onChange={(event) => patch({ radiusMiles: Number(event.target.value) })}
              />
            </label>
          </div>
        </div>

        <div className="search-bar-foot">
          <label className="field" htmlFor="lead-centre">
            <span>Centre</span>
            <input
              id="lead-centre"
              data-testid="lead-centre"
              type="text"
              placeholder="City, ZIP, or lat, lon"
              value={locationText}
              onChange={(event) => setLocationText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyLocation();
                }
              }}
            />
          </label>
          <button className="button" type="button" data-testid="lead-centre-set" onClick={applyLocation}>
            Set
          </button>
          <button className="button" type="button" data-testid="lead-filters-reset" onClick={resetFilters}>
            Reset filters
          </button>
          <p className="note" data-testid="lead-centre-label">
            {centerLabel}
            {filters.radiusMiles > 0 ? ` · ${filters.radiusMiles} mi` : ''}
          </p>
        </div>
        {locationError && (
          <p className="note note--bad" role="alert" data-testid="lead-centre-error">
            {locationError}
          </p>
        )}
      </section>

      <p className="note" data-testid="leads-count">
        {leads.isLoading
          ? 'Loading leads…'
          : visible.length === leads.leads.length
            ? `${leads.leads.length} lead${leads.leads.length === 1 ? '' : 's'}`
            : `${visible.length} of ${leads.leads.length} lead${leads.leads.length === 1 ? '' : 's'}`}
      </p>

      {leads.error && (
        <p className="note note--bad" role="alert" data-testid="leads-error">
          {leads.error}
        </p>
      )}

      {!leads.isLoading && leads.leads.length === 0 && (
        <p className="note" data-testid="leads-empty">
          No leads yet. Open a property from the map and create one.
        </p>
      )}

      {!leads.isLoading && leads.leads.length > 0 && visible.length === 0 && (
        <p className="note" data-testid="leads-filtered-empty">
          No saved leads match these filters. Reset them, or widen the radius.
        </p>
      )}

      {visible.length > 0 && (
        <div className="panel table-scroll">
          <table className="results-table" data-testid="leads-list">
            <caption className="visually-hidden">CRM lead records</caption>
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Owner</th>
                <th scope="col">Roof age</th>
                <th scope="col">Source</th>
                <th scope="col">Created</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((lead) => {
                const saveState = leads.saveStates[lead.leadId];
                const isSaving = saveState === 'saving';
                return (
                  <tr key={lead.leadId} data-testid="lead-row" data-lead-id={lead.leadId}>
                    <td>
                      <span>{lead.primaryAddress}</span>
                      <span className="mono muted">{lead.parcelId}</span>
                      {lead.notes && <span className="muted">{lead.notes}</span>}
                    </td>
                    <td>{lead.ownerName}</td>
                    <td>{formatYears(lead.roofAgeYears)}</td>
                    <td>{lead.source}</td>
                    <td>{formatDate(lead.createdAt)}</td>
                    <td>
                      <label className="visually-hidden" htmlFor={`lead-status-${lead.leadId}`}>
                        Status for {lead.primaryAddress}
                      </label>
                      <select
                        id={`lead-status-${lead.leadId}`}
                        data-testid={`lead-status-${lead.leadId}`}
                        className="lead-status"
                        value={lead.status}
                        disabled={isSaving}
                        onChange={(event) =>
                          void leads.updateStatus(lead.leadId, event.target.value as LeadStatus)
                        }
                      >
                        {LEAD_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {LEAD_STATUS_LABELS[status]}
                          </option>
                        ))}
                      </select>
                      <span
                        className={`save-state save-state--${saveState ?? 'idle'}`}
                        role="status"
                        data-testid={`lead-save-state-${lead.leadId}`}
                      >
                        {saveState === 'saving'
                          ? 'Saving…'
                          : saveState === 'saved'
                            ? 'Saved'
                            : saveState === 'error'
                              ? 'Not saved'
                              : ''}
                      </span>
                    </td>
                    <td>
                      <button
                        className="button button--danger"
                        type="button"
                        data-testid={`delete-lead-${lead.leadId}`}
                        aria-label={`Delete lead for ${lead.primaryAddress}`}
                        disabled={isSaving}
                        onClick={() => void leads.remove(lead.leadId)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
