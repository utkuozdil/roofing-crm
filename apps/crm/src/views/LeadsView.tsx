import { LEAD_STATUSES, LEAD_STATUS_LABELS, type LeadStatus } from '@roofing-crm/shared';
import { formatDate, formatYears } from '../format';
import type { useLeads } from '../useLeads';

/**
 * The lead pipeline. Status is a `<select>` and delete is a button per row, so the full
 * CRUD surface is reachable without any composite interaction.
 */

export interface LeadsViewProps {
  leads: ReturnType<typeof useLeads>;
}

export function LeadsView({ leads }: LeadsViewProps) {
  return (
    <div>
      <header className="content-head">
        <div>
          <h1>Lead pipeline</h1>
          <p>
            CRM lead records created from qualified properties, stored in DynamoDB and listed
            newest-first from the GSI1 recency index.
          </p>
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

      <p className="note" data-testid="leads-count">
        {leads.isLoading
          ? 'Loading leads…'
          : `${leads.leads.length} lead${leads.leads.length === 1 ? '' : 's'}`}
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

      {leads.leads.length > 0 && (
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
              {leads.leads.map((lead) => {
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
                      {/*
                        The select shows only what the API confirmed, so this line is how a
                        user — or an automated driver — knows a change is committed rather
                        than still in flight.
                      */}
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
