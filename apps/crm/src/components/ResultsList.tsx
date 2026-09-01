import {
  isUnresolvedPermitStatus,
  propertyDisplay,
  type PropertySearchItem,
} from '@roofing-crm/shared';
import { formatCurrency, formatMiles, formatYears } from '../format';

/**
 * The browsable candidate list. Each row's address is a button rather than a clickable
 * `<tr>`, so opening a property is a single accessible-name lookup for a driver and a real
 * keyboard target for a user.
 */

/**
 * The query the rendered rows actually answer, echoed onto the DOM.
 *
 * Search is debounced, so "no longer showing the word Searching" is not proof a change has
 * taken effect — the previous result set is still on screen until the new response lands.
 * Publishing the applied query makes settling observable: a reader (or a test) can see
 * whether the list in front of them reflects the controls as they are now set.
 */
export interface AppliedQuery {
  radiusMiles: number;
  minRoofAgeYears: number;
  includeUnknownRoofAge: boolean;
  permitStatus: string;
  sort: string;
  /**
   * The filters a natural-language question can set that the original controls did not have.
   * Published for the same reason as the rest: a chat answer that claims to have applied
   * "sold since 2020" is only believable if the rendered rows say which query they answer.
   */
  poolStatus: string;
  soldSinceYear: number;
  minJustValue: number;
  minYearsSinceLastSale: number;
  outOfAreaOwnerOnly: boolean;
}

export interface ResultsListProps {
  items: readonly PropertySearchItem[];
  selectedParcelId: string | null;
  onSelect: (parcelId: string) => void;
  totalMatched: number;
  totalInRadius: number;
  unknownRoofAgeInRadius: number;
  isSearching: boolean;
  error: string | null;
  applied: AppliedQuery | null;
}

function unresolvedRoofingPermits(property: PropertySearchItem) {
  return property.permits.filter(
    (permit) => permit.is_roofing && isUnresolvedPermitStatus(permit.status),
  );
}

export function ResultsList({
  items,
  selectedParcelId,
  onSelect,
  totalMatched,
  totalInRadius,
  unknownRoofAgeInRadius,
  isSearching,
  error,
  applied,
}: ResultsListProps) {
  const roofAgeThresholdActive = (applied?.minRoofAgeYears ?? 0) > 0;

  return (
    <div className="panel results-panel">
      <header className="results-head">
        <h2>Lead candidates</h2>
        <p
          className="note"
          data-testid="result-count"
          data-searching={isSearching ? 'true' : 'false'}
          data-radius-miles={applied?.radiusMiles}
          data-roof-age={applied?.minRoofAgeYears}
          data-unknown-roof-age={applied ? String(applied.includeUnknownRoofAge) : undefined}
          data-permit-status={applied?.permitStatus}
          data-sort={applied?.sort}
          data-pool={applied?.poolStatus}
          data-sold-since={applied?.soldSinceYear}
          data-min-just-value={applied?.minJustValue}
          data-years-since-sale={applied?.minYearsSinceLastSale}
          data-out-of-area={applied ? String(applied.outOfAreaOwnerOnly) : undefined}
        >
          {isSearching
            ? 'Searching…'
            : `${totalMatched} matching ${totalMatched === 1 ? 'property' : 'properties'} of ${totalInRadius} in radius${
                items.length < totalMatched ? ` — showing ${items.length}` : ''
              }`}
        </p>

        {/*
          The roof-age threshold's effect on parcels with no build year is stated rather
          than implied. About one parcel in nine has no derivable roof age, so an unstated
          exclusion would quietly remove a tenth of the county from every search.
        */}
        {!isSearching && applied && roofAgeThresholdActive && unknownRoofAgeInRadius > 0 && (
          <p
            className={applied.includeUnknownRoofAge ? 'note' : 'note note--warn'}
            data-testid="unknown-roof-age-note"
            data-unknown-roof-age-count={unknownRoofAgeInRadius}
          >
            {applied.includeUnknownRoofAge
              ? `Including ${unknownRoofAgeInRadius} in-radius ${unknownRoofAgeInRadius === 1 ? 'parcel' : 'parcels'} with no known roof age (no recorded build year).`
              : `Excluding ${unknownRoofAgeInRadius} in-radius ${unknownRoofAgeInRadius === 1 ? 'parcel' : 'parcels'} with no known roof age (no recorded build year). Tick “Include unknown roof age” to see them.`}
          </p>
        )}
      </header>

      {error && (
        <p className="note note--bad" role="alert" data-testid="results-error">
          {error}
        </p>
      )}

      {!error && !isSearching && items.length === 0 && (
        <p className="note" data-testid="results-empty">
          No properties match. Widen the radius, lower the roof-age threshold, or relax the permit
          filter.
        </p>
      )}

      {items.length > 0 && (
        <div className="table-scroll">
          <table className="results-table" data-testid="results-list">
            <caption className="visually-hidden">
              Properties matching the current radius and filters
            </caption>
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Roof age</th>
                <th scope="col">Permits</th>
                <th scope="col">Just value</th>
                <th scope="col">Distance</th>
              </tr>
            </thead>
            <tbody>
              {items.map((property) => {
                const stalled = unresolvedRoofingPermits(property);
                const display = propertyDisplay(property);
                return (
                  <tr
                    key={property.parcel_id}
                    data-testid="result-row"
                    data-parcel-id={property.parcel_id}
                    data-address-missing={display.isAddressMissing ? 'true' : 'false'}
                    className={property.parcel_id === selectedParcelId ? 'is-selected' : undefined}
                  >
                    <td>
                      <button
                        className="link-button"
                        type="button"
                        data-testid={`open-property-${property.parcel_id}`}
                        aria-label={`Open ${display.title}`}
                        onClick={() => onSelect(property.parcel_id)}
                      >
                        {display.title}
                      </button>
                      {/*
                        An unaddressed parcel is a legitimate record, not a broken one, so it
                        keeps a real title and says where it is rather than rendering blank.
                      */}
                      {display.locality && (
                        <span className="muted" data-testid="row-locality">
                          Unaddressed parcel near {display.locality}
                        </span>
                      )}
                      <span
                        className={display.isOwnerMissing ? 'muted' : 'mono muted'}
                        data-testid="row-owner"
                      >
                        {display.owner}
                      </span>
                    </td>
                    <td data-testid={`row-roof-age-${property.parcel_id}`}>
                      {formatYears(property.roof_age_years)}
                    </td>
                    <td>
                      {stalled.length > 0 ? (
                        <span className="pill pill--bad">
                          {stalled.length} roofing permit{stalled.length === 1 ? '' : 's'}{' '}
                          unresolved
                        </span>
                      ) : property.permits.length > 0 ? (
                        <span className="pill">{property.permits.length} on record</span>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                    <td>{formatCurrency(property.total_just_value)}</td>
                    <td>{formatMiles(property.distance_miles)}</td>
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
