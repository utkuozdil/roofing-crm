import {
  PERMIT_STATUS_FACTS,
  SEMINOLE_ROOFING_APPLICATION_TYPES,
  isOutOfAreaOwner,
  isUnresolvedPermitStatus,
  permitDuration,
  permitNaturalKey,
  propertyDisplay,
  type PermitDurationState,
  type PermitRecord,
  type PropertyDetail,
} from '@roofing-crm/shared';
import { useEffect, useState } from 'react';
import {
  NOT_AVAILABLE,
  formatCurrency,
  formatDate,
  formatNumber,
  formatYears,
  humanisePropertyType,
} from '../format';

export interface PropertyDetailPanelProps {
  property: PropertyDetail | null;
  isLoading: boolean;
  onClose: () => void;
  onCreateLead: (input: { notes: string; source: string }) => Promise<void>;
  createState: { status: 'idle' | 'saving' | 'created' | 'error'; message: string | null };
  existingLeadCount: number;
}

const PERMIT_DURATION_LABELS: Record<PermitDurationState, string> = {
  open: 'Open for',
  resolved: 'Resolved',
  unrecorded: 'Resolution date',
  void: 'Outcome',
};

/**
 * The contractor block for one permit.
 *
 * BBB enrichment does not match every contractor, and the absence is deliberately loud:
 * an explicitly marked "no BBB record" slot tells a salesperson something, whereas hiding
 * the field would read as a rendering fault.
 */
function ContractorCell({ permit, index }: { permit: PermitRecord; index: number }) {
  return (
    <>
      <div className="permit-contractor">{permit.contractor_name ?? NOT_AVAILABLE}</div>
      {permit.contractor_license && (
        <div className="mono muted">Licence {permit.contractor_license}</div>
      )}
      {permit.bbb_rating === null ? (
        <div className="bbb bbb--missing" data-testid={`permit-bbb-missing-${index}`}>
          BBB rating: no record matched
        </div>
      ) : (
        <div className="bbb" data-testid={`permit-bbb-${index}`}>
          BBB {permit.bbb_rating}
          {permit.bbb_score !== null && ` · ${permit.bbb_score.toFixed(1)}/5`}
          {permit.bbb_accredited ? ' · accredited' : ''}
        </div>
      )}
    </>
  );
}

export function PropertyDetailPanel({
  property,
  isLoading,
  onClose,
  onCreateLead,
  createState,
  existingLeadCount,
}: PropertyDetailPanelProps) {
  const [notes, setNotes] = useState('');

  // Notes belong to the property being viewed, not to the panel, so switching properties
  // must not carry a half-typed note across to a different parcel.
  useEffect(() => {
    setNotes('');
  }, [property?.parcel_id]);

  if (isLoading) {
    return (
      <div className="panel detail-panel" data-testid="property-detail-loading">
        <p className="note">Loading property…</p>
      </div>
    );
  }

  if (!property) {
    return (
      <div className="panel detail-panel" data-testid="property-detail-empty">
        <h2>Property detail</h2>
        <p className="note">
          Select a pin on the map or a row in the candidate list to see ownership, valuation, and
          permit history.
        </p>
      </div>
    );
  }

  const now = new Date();
  const outOfArea = isOutOfAreaOwner(property.mailing_city_state_zip);
  const display = propertyDisplay(property);
  const suggestedSource = property.permits.some(
    (permit) => permit.is_roofing && isUnresolvedPermitStatus(permit.status),
  )
    ? 'Unresolved roofing permit'
    : `Roof age ${property.roof_age_years ?? 'unknown'} years`;

  return (
    <div className="panel detail-panel" data-testid="property-detail">
      <header className="detail-head">
        <div>
          <h2 data-testid="detail-address" data-address-missing={String(display.isAddressMissing)}>
            {display.title}
          </h2>
          <p className="mono muted" data-testid="detail-parcel-id">
            Parcel {property.parcel_id}
          </p>
          {/*
            The county holds no address for roughly one parcel in eleven. Naming the nearest
            municipality — from coordinates, which are always present — keeps the card
            locatable instead of just blank.
          */}
          {display.locality && (
            <p className="note note--warn" data-testid="detail-address-missing">
              No address on record for this parcel. Nearest municipality: {display.locality}.
            </p>
          )}
        </div>
        <button className="button" type="button" data-testid="close-property" onClick={onClose}>
          Close
        </button>
      </header>

      <dl className="detail-grid">
        <dt>Owner</dt>
        <dd
          className={display.isOwnerMissing ? 'muted' : undefined}
          data-testid="detail-owner"
          data-owner-missing={String(display.isOwnerMissing)}
        >
          {display.owner}
        </dd>

        <dt>Owner mailing</dt>
        <dd data-testid="detail-mailing">
          {property.mailing_city_state_zip}
          {outOfArea && (
            <span className="pill pill--warn" data-testid="detail-out-of-area">
              Out of area
            </span>
          )}
        </dd>

        <dt>Property type</dt>
        <dd data-testid="detail-property-type">{humanisePropertyType(property.property_type)}</dd>

        <dt>Year built</dt>
        <dd data-testid="detail-year-built">{formatNumber(property.year_built)}</dd>

        <dt>Roof age (derived)</dt>
        <dd data-testid="detail-roof-age">
          {formatYears(property.roof_age_years)}
          {property.roof_age_years === null && (
            <small className="muted">
              No recorded build year and no signed-off roofing permit, so roof age cannot be
              derived. Excluded by a roof-age threshold unless “Include unknown roof age” is ticked.
            </small>
          )}
        </dd>

        <dt>Last sale date</dt>
        <dd data-testid="detail-last-sale-date">{formatDate(property.last_sale_date)}</dd>

        <dt>Last sale amount</dt>
        <dd data-testid="detail-last-sale-amount">{formatCurrency(property.last_sale_amount)}</dd>

        <dt>Total just value</dt>
        <dd data-testid="detail-just-value">{formatCurrency(property.total_just_value)}</dd>

        <dt>Assessed value</dt>
        <dd data-testid="detail-assessed-value">{formatCurrency(property.assessed_value)}</dd>

        <dt>Taxable value</dt>
        <dd data-testid="detail-taxable-value">{formatCurrency(property.taxable_value)}</dd>

        <dt>Living area</dt>
        <dd data-testid="detail-living-area">
          {formatNumber(property.total_living_area, 'sq ft')}
        </dd>

        <dt>Beds / baths</dt>
        <dd data-testid="detail-beds-baths">
          {formatNumber(property.total_bedrooms)} / {formatNumber(property.total_bathrooms)}
        </dd>

        <dt>Pool</dt>
        <dd data-testid="detail-pool">{property.has_pool ? 'Yes' : 'No'}</dd>

        <dt>Coordinates</dt>
        <dd className="mono" data-testid="detail-coordinates">
          {property.latitude.toFixed(5)}, {property.longitude.toFixed(5)} · geohash5{' '}
          {property.geohash5}
        </dd>
      </dl>

      <section className="detail-section">
        <h3>Permits</h3>
        {property.permits.length === 0 ? (
          <p className="note" data-testid="permits-empty">
            No permits on record for this parcel.
          </p>
        ) : (
          <ul className="permit-list" data-testid="permit-list">
            {property.permits.map((permit, index) => {
              const duration = permitDuration(permit, now);
              const unresolved = isUnresolvedPermitStatus(permit.status);
              return (
                // An application number covers several structures and permit types, so the
                // natural key is what keeps sibling rows distinct.
                <li key={permitNaturalKey(permit)} className="permit" data-testid="permit-row">
                  <div className="permit-head">
                    <strong>{permit.permit_type}</strong>
                    <span
                      className={`pill ${unresolved ? 'pill--bad' : 'pill--ok'}`}
                      data-testid={`permit-status-${index}`}
                    >
                      {PERMIT_STATUS_FACTS[permit.status].label}
                    </span>
                    {permit.is_roofing && (
                      <span className="pill pill--warn" data-testid={`permit-roofing-${index}`}>
                        Roofing
                      </span>
                    )}
                  </div>
                  <p className="muted">{permit.description}</p>
                  <dl className="permit-grid">
                    <dt>Permit</dt>
                    <dd className="mono">{permitNaturalKey(permit)}</dd>
                    <dt>Type code</dt>
                    <dd className="mono" data-testid={`permit-type-code-${index}`}>
                      {permit.application_type_code ?? NOT_AVAILABLE}
                      {permit.application_type_code &&
                        permit.application_type_code in SEMINOLE_ROOFING_APPLICATION_TYPES && (
                          <small className="muted">
                            {SEMINOLE_ROOFING_APPLICATION_TYPES[permit.application_type_code]}
                          </small>
                        )}
                    </dd>
                    <dt>Issued</dt>
                    <dd>{formatDate(permit.issued_date)}</dd>
                    <dt>{PERMIT_DURATION_LABELS[duration.state]}</dt>
                    <dd
                      data-testid={`permit-duration-${index}`}
                      data-duration-state={duration.state}
                    >
                      {duration.state === 'open' && formatYears(duration.years)}
                      {duration.state === 'resolved' && formatDate(duration.resolvedOn)}
                      {duration.state === 'void' && 'Application voided'}
                      {/*
                        The source has no explicit close date — resolution is the terminal
                        inspection's result date. When that inspection was not captured the
                        duration is genuinely unknown, and "0 years" would be a fabrication.
                      */}
                      {duration.state === 'unrecorded' && (
                        <span className="muted">No terminal inspection date recorded</span>
                      )}
                    </dd>
                    <dt>Valuation</dt>
                    <dd>{formatCurrency(permit.valuation)}</dd>
                    <dt>Contractor</dt>
                    <dd>
                      <ContractorCell permit={permit} index={index} />
                    </dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="detail-section">
        <h3>Create CRM lead</h3>
        {existingLeadCount > 0 && (
          <p className="note" data-testid="existing-lead-note">
            {existingLeadCount} lead{existingLeadCount === 1 ? '' : 's'} already exist for this
            parcel.
          </p>
        )}
        <label className="field" htmlFor="lead-notes-input">
          <span>Notes</span>
          <textarea
            id="lead-notes-input"
            data-testid="lead-notes-input"
            name="notes"
            rows={3}
            placeholder="Roof past service life; owner mails out of state."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <button
          className="button button--primary"
          type="button"
          data-testid="create-lead-button"
          disabled={createState.status === 'saving'}
          onClick={() => void onCreateLead({ notes, source: suggestedSource })}
        >
          {createState.status === 'saving' ? 'Creating lead…' : 'Create lead from this property'}
        </button>
        {createState.message && (
          <p
            className={`note ${createState.status === 'error' ? 'note--bad' : 'note--ok'}`}
            role="status"
            data-testid="create-lead-status"
          >
            {createState.message}
          </p>
        )}
      </section>
    </div>
  );
}
