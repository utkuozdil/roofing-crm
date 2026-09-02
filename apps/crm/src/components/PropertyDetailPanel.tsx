import {
  PERMIT_STATUS_FACTS,
  SEMINOLE_ROOFING_APPLICATION_TYPES,
  resolveOutOfAreaOwner,
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
  /**
   * Whether the dataset behind this panel carries permit history at all.
   *
   * Without it an empty permit list would read as "the county has no permits for this parcel",
   * which is a claim about the parcel. The published snapshot carries parcels only, so the
   * truthful statement is about the dataset instead.
   */
  permitsAvailable: boolean;
  isLoading: boolean;
  onClose: () => void;
  onCreateLead: (input: { notes: string; source: string }) => Promise<void>;
  createState: { status: 'idle' | 'saving' | 'created' | 'error'; message: string | null };
  existingLeadCount: number;
}

const PERMITS_PER_PAGE = 5;

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
  permitsAvailable,
  isLoading,
  onClose,
  onCreateLead,
  createState,
  existingLeadCount,
}: PropertyDetailPanelProps) {
  const [notes, setNotes] = useState('');
  const [permitPage, setPermitPage] = useState(0);

  // Notes and pager belong to the property being viewed, so switching parcels
  // must not carry a half-typed note or a page offset across to a different one.
  useEffect(() => {
    setNotes('');
    setPermitPage(0);
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
          Select a pin on the map or a row in the candidate list to see ownership, valuation
          {permitsAvailable ? ', and permit history' : ' and roof age'}.
        </p>
      </div>
    );
  }

  const now = new Date();
  const outOfArea = resolveOutOfAreaOwner(property);
  const display = propertyDisplay(property);
  const suggestedSource = property.permits.some(
    (permit) => permit.is_roofing && isUnresolvedPermitStatus(permit.status),
  )
    ? 'Unresolved roofing permit'
    : `Roof age ${property.roof_age_years ?? 'unknown'} years`;

  const permitCount = property.permits.length;
  const permitPageCount = Math.max(1, Math.ceil(permitCount / PERMITS_PER_PAGE));
  const currentPermitPage = Math.min(permitPage, permitPageCount - 1);
  const permitFrom = permitCount === 0 ? 0 : currentPermitPage * PERMITS_PER_PAGE + 1;
  const permitTo = Math.min(permitCount, (currentPermitPage + 1) * PERMITS_PER_PAGE);
  const pagedPermits = property.permits.slice(
    currentPermitPage * PERMITS_PER_PAGE,
    (currentPermitPage + 1) * PERMITS_PER_PAGE,
  );

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
        <div className="permit-section-head">
          <h3>Permits</h3>
          {permitCount > 0 && (
            <p className="note" data-testid="permit-page-status">
              {permitFrom}–{permitTo} of {permitCount}
            </p>
          )}
        </div>
        {property.permits.length === 0 ? (
          <p
            className={permitsAvailable ? 'note' : 'note note--warn'}
            data-testid="permits-empty"
            data-reason={permitsAvailable ? 'none-for-parcel' : 'not-published'}
          >
            {permitsAvailable
              ? 'No permits on record for this parcel.'
              : 'Permit history is not part of the published county dataset, so nothing is known about permits for this parcel either way.'}
          </p>
        ) : (
          <>
            <ul className="permit-list" data-testid="permit-list">
              {pagedPermits.map((permit, pageIndex) => {
                const index = currentPermitPage * PERMITS_PER_PAGE + pageIndex;
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
            {permitPageCount > 1 && (
              <div className="permit-pager" data-testid="permit-pager">
                <button
                  className="button"
                  type="button"
                  data-testid="permit-page-prev"
                  disabled={currentPermitPage === 0}
                  onClick={() => setPermitPage((page) => Math.max(0, page - 1))}
                >
                  Previous
                </button>
                <span className="note" data-testid="permit-page-label">
                  Page {currentPermitPage + 1} of {permitPageCount}
                </span>
                <button
                  className="button"
                  type="button"
                  data-testid="permit-page-next"
                  disabled={currentPermitPage >= permitPageCount - 1}
                  onClick={() => setPermitPage((page) => Math.min(permitPageCount - 1, page + 1))}
                >
                  Next
                </button>
              </div>
            )}
          </>
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
          disabled={createState.status === 'saving' || existingLeadCount > 0}
          onClick={() => void onCreateLead({ notes, source: suggestedSource })}
        >
          {createState.status === 'saving'
            ? 'Creating lead…'
            : existingLeadCount > 0
              ? 'Already saved as a lead'
              : 'Create lead from this property'}
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
