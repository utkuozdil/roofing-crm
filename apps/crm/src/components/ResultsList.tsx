import {
  isUnresolvedPermitStatus,
  propertyDisplay,
  type PropertySearchItem,
} from '@roofing-crm/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatCurrency, formatMiles, formatYears } from '../format';

const RESULTS_PER_PAGE = 8;

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
  /**
   * How much of the radius the permit history cannot speak for. Null when no permit history is
   * loaded, which is a different statement from "measured, and this many are unknown".
   */
  permitCoverage: InRadiusPermitCoverage | null;
  isSearching: boolean;
  error: string | null;
  applied: AppliedQuery | null;
  /** Opened under the collapsed selected row. */
  detail?: ReactNode;
  onClear?: () => void;
}

/** Mirrors the API's per-search permit unknowns. */
export interface InRadiusPermitCoverage {
  withoutPermitsInRadius: number;
  unknownPermitStatusInRadius: number;
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
  permitCoverage,
  isSearching,
  error,
  applied,
  detail,
  onClear,
}: ResultsListProps) {
  const roofAgeThresholdActive = (applied?.minRoofAgeYears ?? 0) > 0;
  const permitFilterActive = applied !== undefined && (applied?.permitStatus ?? 'any') !== 'any';
  const [page, setPage] = useState(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const resultKey = [
    applied?.radiusMiles,
    applied?.minRoofAgeYears,
    applied?.permitStatus,
    applied?.sort,
    applied?.poolStatus,
    applied?.soldSinceYear,
    applied?.minJustValue,
    applied?.minYearsSinceLastSale,
    applied?.outOfAreaOwnerOnly,
    items[0]?.parcel_id,
    items.length,
    totalMatched,
  ].join('|');

  useEffect(() => {
    setPage(0);
  }, [resultKey]);

  const pageCount = Math.max(1, Math.ceil(items.length / RESULTS_PER_PAGE));

  useEffect(() => {
    if (!selectedParcelId) return;
    const index = itemsRef.current.findIndex((item) => item.parcel_id === selectedParcelId);
    if (index < 0) return;
    setPage(Math.floor(index / RESULTS_PER_PAGE));
  }, [selectedParcelId]);

  const currentPage = Math.min(page, pageCount - 1);
  const selectedItem = selectedParcelId
    ? items.find((item) => item.parcel_id === selectedParcelId)
    : undefined;
  const pageItems = useMemo(
    () => items.slice(currentPage * RESULTS_PER_PAGE, (currentPage + 1) * RESULTS_PER_PAGE),
    [items, currentPage],
  );
  const visibleItems = selectedItem ? [selectedItem] : pageItems;
  const collapsed = Boolean(selectedParcelId);

  return (
    <div className={`panel results-panel${collapsed ? ' results-panel--collapsed' : ''}`}>
      <header className="results-head">
        <h2>Lead candidates</h2>
        {collapsed && onClear && (
          <button className="button" type="button" data-testid="results-show-all" onClick={onClear}>
            Show all
          </button>
        )}
        <p
          className="visually-hidden"
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

        {!isSearching && applied && roofAgeThresholdActive && unknownRoofAgeInRadius > 0 && (
          <p
            className="visually-hidden"
            data-testid="unknown-roof-age-note"
            data-unknown-roof-age-count={unknownRoofAgeInRadius}
          >
            {applied.includeUnknownRoofAge
              ? `Including ${unknownRoofAgeInRadius} in-radius ${unknownRoofAgeInRadius === 1 ? 'parcel' : 'parcels'} with no known roof age (no recorded build year).`
              : `Excluding ${unknownRoofAgeInRadius} in-radius ${unknownRoofAgeInRadius === 1 ? 'parcel' : 'parcels'} with no known roof age (no recorded build year). Tick “Include unknown roof age” to see them.`}
          </p>
        )}

        {!isSearching && applied && permitFilterActive && permitCoverage !== null && (
          <p
            className="visually-hidden"
            data-testid="permit-coverage-note"
            data-without-permits={permitCoverage.withoutPermitsInRadius}
            data-unknown-permit-status={permitCoverage.unknownPermitStatusInRadius}
          >
            {`Permit history covers 1996 onward and has a confirmed status on a small fraction of applications. Of ${totalInRadius} in radius, ${permitCoverage.withoutPermitsInRadius} have no permit in that window and ${permitCoverage.unknownPermitStatusInRadius} hold a permit whose status is unharvested — those are unknown, not closed.`}
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
        <div className="candidate-list" data-testid="results-list">
          {visibleItems.map((property) => {
            const stalled = unresolvedRoofingPermits(property);
            const display = propertyDisplay(property);
            return (
              <article
                key={property.parcel_id}
                data-testid="result-row"
                data-parcel-id={property.parcel_id}
                data-address-missing={display.isAddressMissing ? 'true' : 'false'}
                className={`candidate${property.parcel_id === selectedParcelId ? ' is-selected' : ''}`}
              >
                <button
                  className="candidate-open"
                  type="button"
                  data-testid={`open-property-${property.parcel_id}`}
                  aria-label={`Open ${display.title}`}
                  onClick={() => onSelect(property.parcel_id)}
                >
                  {display.title}
                </button>
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
                <div className="candidate-meta">
                  <span data-testid={`row-roof-age-${property.parcel_id}`}>
                    {formatYears(property.roof_age_years)}
                  </span>
                  {stalled.length > 0 ? (
                    <span className="pill pill--bad">
                      {stalled.length} roofing permit{stalled.length === 1 ? '' : 's'} unresolved
                    </span>
                  ) : property.permits.length > 0 ? (
                    <span className="pill">{property.permits.length} on record</span>
                  ) : (
                    <span className="muted">No permits</span>
                  )}
                  <span>{formatCurrency(property.total_just_value)}</span>
                  <span>{formatMiles(property.distance_miles)}</span>
                </div>
              </article>
            );
          })}
          {!collapsed && pageCount > 1 && (
            <div className="results-pager" data-testid="results-pager">
              <button
                className="button"
                type="button"
                data-testid="results-page-prev"
                disabled={currentPage === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                Previous
              </button>
              <span className="note" data-testid="results-page-status">
                Page {currentPage + 1} of {pageCount}
              </span>
              <button
                className="button"
                type="button"
                data-testid="results-page-next"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {detail}
    </div>
  );
}
