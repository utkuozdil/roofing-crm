import {
  PERMIT_FILTER_MODES,
  POOL_FILTER_MODES,
  PROPERTY_TYPES,
  SEARCH_SORTS,
  SEMINOLE_PLACES,
  type PermitFilterMode,
  type PoolFilterMode,
  type PropertyFilters,
  type PropertyType,
  type SearchSort,
} from '@roofing-crm/shared';
import type { GeoPoint } from '@roofing-crm/shared';
import { formatCoordinates } from '../format';
import type { GeolocationState } from '../useGeolocation';

/**
 * Every search control in the product.
 *
 * The map supports clicking to drop a pin, but nothing here depends on that: the centre
 * can be typed as an address, a ZIP, or a raw `lat,lon` pair; the radius has both a range
 * slider and a number input bound to the same value; and pan and zoom are buttons. That
 * redundancy is deliberate — an automated driver, a keyboard user, and a mouse user all
 * reach the same capabilities through plain form controls.
 */

const PERMIT_MODE_LABELS: Record<PermitFilterMode, string> = {
  any: 'Any permit history',
  unresolved: 'Has an unresolved permit',
  roofing_unresolved: 'Has an unresolved roofing permit',
  none: 'No permit history',
};

const POOL_MODE_LABELS: Record<PoolFilterMode, string> = {
  any: 'With or without a pool',
  with_pool: 'Has a pool',
  without_pool: 'No pool',
};

const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  single_family: 'Single family',
  condo: 'Condo',
  townhouse: 'Townhouse',
  mobile_home: 'Mobile home',
  multi_family: 'Multi family',
  commercial: 'Commercial',
  vacant: 'Vacant land',
};

const SORT_LABELS: Record<SearchSort, string> = {
  distance: 'Closest first',
  roof_age: 'Oldest roof first',
  permit_age: 'Longest-open permit first',
  just_value: 'Highest just value first',
};

export type PanDirection = 'north' | 'south' | 'east' | 'west';

export interface SearchPanelProps {
  locationText: string;
  onLocationTextChange: (value: string) => void;
  onApplyLocation: () => void;
  locationError: string | null;
  center: GeoPoint;
  centerLabel: string;
  radiusMiles: number;
  onRadiusChange: (value: number) => void;
  filters: PropertyFilters;
  onFiltersChange: (patch: Partial<PropertyFilters>) => void;
  sort: SearchSort;
  onSortChange: (value: SearchSort) => void;
  geolocation: GeolocationState;
  onUseMyLocation: () => void;
  onPan: (direction: PanDirection) => void;
  onZoom: (delta: number) => void;
  zoomOffset: number;
  showBasemap: boolean;
  onShowBasemapChange: (value: boolean) => void;
  onSearch: () => void;
  onResetFilters: () => void;
  isSearching: boolean;
}

export function SearchPanel(props: SearchPanelProps) {
  const {
    locationText,
    onLocationTextChange,
    onApplyLocation,
    locationError,
    center,
    centerLabel,
    radiusMiles,
    onRadiusChange,
    filters,
    onFiltersChange,
    sort,
    onSortChange,
    geolocation,
    onUseMyLocation,
    onPan,
    onZoom,
    zoomOffset,
    showBasemap,
    onShowBasemapChange,
    onSearch,
    onResetFilters,
    isSearching,
  } = props;

  return (
    <div className="panel search-panel">
      <form
        className="field-group"
        onSubmit={(event) => {
          event.preventDefault();
          onApplyLocation();
        }}
      >
        <h2>Search location</h2>

        <label className="field" htmlFor="location-input">
          <span>Address, city, ZIP, or “lat,lon”</span>
          <input
            id="location-input"
            data-testid="location-input"
            name="location"
            type="text"
            autoComplete="off"
            list="seminole-places"
            placeholder="Lake Mary  ·  32771  ·  28.75,-81.28"
            value={locationText}
            onChange={(event) => onLocationTextChange(event.target.value)}
          />
        </label>

        <div className="row">
          <button className="button button--primary" type="submit" data-testid="apply-location">
            Set search location
          </button>
          <button
            className="button"
            type="button"
            data-testid="use-my-location"
            onClick={onUseMyLocation}
            disabled={geolocation.status === 'requesting'}
          >
            {geolocation.status === 'requesting' ? 'Locating…' : 'Use my location'}
          </button>
        </div>

        {locationError && (
          <p className="note note--bad" role="alert" data-testid="location-error">
            {locationError}
          </p>
        )}

        {/*
          Geolocation is denied by default in a headless browser, so this status line is the
          normal path rather than an edge case. It reports the outcome and the map keeps the
          previous centre — the UI never blanks because permission was refused.
        */}
        <p className="note" role="status" data-testid="geolocation-status">
          {geolocation.message}
        </p>

        <p className="note mono" data-testid="center-readout">
          Centre {formatCoordinates(center.latitude, center.longitude)} — {centerLabel}
        </p>

        <datalist id="seminole-places">
          {SEMINOLE_PLACES.map((place) => (
            <option key={`${place.name}-${place.zip}`} value={place.name} />
          ))}
        </datalist>
      </form>

      <div className="field-group">
        <h2>Radius</h2>
        <label className="field" htmlFor="radius-slider">
          <span>
            Search radius: <strong data-testid="radius-value">{radiusMiles}</strong> miles
          </span>
          <input
            id="radius-slider"
            data-testid="radius-slider"
            name="radiusSlider"
            type="range"
            min={0.5}
            max={25}
            step={0.5}
            value={radiusMiles}
            onChange={(event) => onRadiusChange(Number(event.target.value))}
          />
        </label>

        <label className="field field--narrow" htmlFor="radius-input">
          <span>Radius in miles</span>
          <input
            id="radius-input"
            data-testid="radius-input"
            name="radiusMiles"
            type="number"
            min={0.5}
            max={25}
            step={0.5}
            value={radiusMiles}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onRadiusChange(Math.min(25, Math.max(0.5, next)));
            }}
          />
        </label>
      </div>

      <div className="field-group">
        <h2>Lead filters</h2>

        <label className="field" htmlFor="roof-age-slider">
          <span>
            Roof age at least{' '}
            <strong data-testid="roof-age-value">{filters.minRoofAgeYears}</strong> years
          </span>
          <input
            id="roof-age-slider"
            data-testid="roof-age-slider"
            name="roofAgeSlider"
            type="range"
            min={0}
            max={70}
            step={1}
            value={filters.minRoofAgeYears}
            onChange={(event) => onFiltersChange({ minRoofAgeYears: Number(event.target.value) })}
          />
        </label>

        <label className="field field--narrow" htmlFor="roof-age-input">
          <span>Roof age threshold (years)</span>
          <input
            id="roof-age-input"
            data-testid="roof-age-input"
            name="minRoofAgeYears"
            type="number"
            min={0}
            max={70}
            step={1}
            value={filters.minRoofAgeYears}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) {
                onFiltersChange({ minRoofAgeYears: Math.min(70, Math.max(0, Math.round(next))) });
              }
            }}
          />
        </label>

        {/*
          The roof-age threshold has to say what it does to a parcel with no build year.
          About one parcel in nine has none — vacant land, mostly — so the behaviour is an
          operator's choice on a labelled control, not an unstated default.
        */}
        <label className="field field--check" htmlFor="unknown-roof-age-checkbox">
          <input
            id="unknown-roof-age-checkbox"
            data-testid="unknown-roof-age-checkbox"
            name="includeUnknownRoofAge"
            type="checkbox"
            checked={filters.includeUnknownRoofAge}
            onChange={(event) => onFiltersChange({ includeUnknownRoofAge: event.target.checked })}
          />
          <span>
            Include unknown roof age
            <small className="muted">
              {filters.minRoofAgeYears === 0
                ? 'No threshold applied, so every parcel is included regardless of build year.'
                : filters.includeUnknownRoofAge
                  ? 'Parcels with no recorded build year pass the roof-age threshold.'
                  : 'Parcels with no recorded build year are excluded by the roof-age threshold.'}
            </small>
          </span>
        </label>

        <label className="field" htmlFor="permit-status-select">
          <span>Permit status</span>
          <select
            id="permit-status-select"
            data-testid="permit-status-select"
            name="permitStatus"
            value={filters.permitStatus}
            onChange={(event) =>
              onFiltersChange({ permitStatus: event.target.value as PermitFilterMode })
            }
          >
            {PERMIT_FILTER_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {PERMIT_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--narrow" htmlFor="permit-open-years-input">
          <span>Permit open at least (years)</span>
          <input
            id="permit-open-years-input"
            data-testid="permit-open-years-input"
            name="minPermitOpenYears"
            type="number"
            min={0}
            max={40}
            step={1}
            value={filters.minPermitOpenYears}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) {
                onFiltersChange({
                  minPermitOpenYears: Math.min(40, Math.max(0, Math.round(next))),
                });
              }
            }}
          />
        </label>

        <label className="field field--narrow" htmlFor="years-since-sale-input">
          <span>Years since last sale, at least</span>
          <input
            id="years-since-sale-input"
            data-testid="years-since-sale-input"
            name="minYearsSinceLastSale"
            type="number"
            min={0}
            max={80}
            step={1}
            value={filters.minYearsSinceLastSale}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) {
                onFiltersChange({
                  minYearsSinceLastSale: Math.min(80, Math.max(0, Math.round(next))),
                });
              }
            }}
          />
        </label>

        <label className="field field--check" htmlFor="out-of-area-checkbox">
          <input
            id="out-of-area-checkbox"
            data-testid="out-of-area-checkbox"
            name="outOfAreaOwnerOnly"
            type="checkbox"
            checked={filters.outOfAreaOwnerOnly}
            onChange={(event) => onFiltersChange({ outOfAreaOwnerOnly: event.target.checked })}
          />
          <span>Out-of-area owner only (mailing address outside Seminole County)</span>
        </label>

        {/*
          The four controls below exist because the natural-language panel can set them, and
          anything the chat applies has to be visible and reversible here — otherwise the app
          would be holding a filter the operator cannot see or undo.
        */}
        <label className="field" htmlFor="pool-select">
          <span>Pool</span>
          <select
            id="pool-select"
            data-testid="pool-select"
            name="poolStatus"
            value={filters.poolStatus}
            onChange={(event) =>
              onFiltersChange({ poolStatus: event.target.value as PoolFilterMode })
            }
          >
            {POOL_FILTER_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {POOL_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--narrow" htmlFor="sold-since-input">
          <span>Sold since (year, 0 for any)</span>
          <input
            id="sold-since-input"
            data-testid="sold-since-input"
            name="soldSinceYear"
            type="number"
            min={0}
            max={2100}
            step={1}
            value={filters.soldSinceYear}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) return;
              const year = Math.round(next);
              // Anything between 1 and 1899 is a typo, not a year the county records.
              onFiltersChange({
                soldSinceYear: year <= 0 ? 0 : Math.min(2100, Math.max(1900, year)),
              });
            }}
          />
        </label>

        <label className="field field--narrow" htmlFor="min-just-value-input">
          <span>Just value at least ($)</span>
          <input
            id="min-just-value-input"
            data-testid="min-just-value-input"
            name="minJustValue"
            type="number"
            min={0}
            max={50_000_000}
            step={25_000}
            value={filters.minJustValue}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) {
                onFiltersChange({
                  minJustValue: Math.min(50_000_000, Math.max(0, Math.round(next))),
                });
              }
            }}
          />
        </label>

        <fieldset className="field field--types" data-testid="property-type-filter">
          <legend>
            Property type
            <small className="muted">
              {filters.propertyTypes.length === 0
                ? 'Every type is included.'
                : `${filters.propertyTypes.length} of ${PROPERTY_TYPES.length} types included.`}
            </small>
          </legend>
          {PROPERTY_TYPES.map((type) => (
            <label className="field field--check" key={type} htmlFor={`property-type-${type}`}>
              <input
                id={`property-type-${type}`}
                data-testid={`property-type-${type}`}
                name="propertyTypes"
                type="checkbox"
                checked={filters.propertyTypes.includes(type)}
                onChange={(event) =>
                  onFiltersChange({
                    propertyTypes: event.target.checked
                      ? [...filters.propertyTypes, type]
                      : filters.propertyTypes.filter((existing) => existing !== type),
                  })
                }
              />
              <span>{PROPERTY_TYPE_LABELS[type]}</span>
            </label>
          ))}
        </fieldset>

        <label className="field" htmlFor="sort-select">
          <span>Sort results by</span>
          <select
            id="sort-select"
            data-testid="sort-select"
            name="sort"
            value={sort}
            onChange={(event) => onSortChange(event.target.value as SearchSort)}
          >
            {SEARCH_SORTS.map((option) => (
              <option key={option} value={option}>
                {SORT_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        <div className="row">
          <button
            className="button button--primary"
            type="button"
            data-testid="search-button"
            onClick={onSearch}
            disabled={isSearching}
          >
            {isSearching ? 'Searching…' : 'Search properties'}
          </button>
          <button
            className="button"
            type="button"
            data-testid="reset-filters"
            onClick={onResetFilters}
          >
            Reset filters
          </button>
        </div>
      </div>

      <div className="field-group">
        <h2>Map view</h2>
        <div className="pan-grid" role="group" aria-label="Pan and zoom the map">
          <button
            className="button button--icon"
            type="button"
            data-testid="map-pan-north"
            onClick={() => onPan('north')}
          >
            Pan north
          </button>
          <button
            className="button button--icon"
            type="button"
            data-testid="map-pan-west"
            onClick={() => onPan('west')}
          >
            Pan west
          </button>
          <button
            className="button button--icon"
            type="button"
            data-testid="map-pan-east"
            onClick={() => onPan('east')}
          >
            Pan east
          </button>
          <button
            className="button button--icon"
            type="button"
            data-testid="map-pan-south"
            onClick={() => onPan('south')}
          >
            Pan south
          </button>
          <button
            className="button button--icon"
            type="button"
            data-testid="map-zoom-in"
            onClick={() => onZoom(1)}
            disabled={zoomOffset >= 3}
          >
            Zoom in
          </button>
          <button
            className="button button--icon"
            type="button"
            data-testid="map-zoom-out"
            onClick={() => onZoom(-1)}
            disabled={zoomOffset <= -3}
          >
            Zoom out
          </button>
        </div>

        <label className="field field--check" htmlFor="basemap-checkbox">
          <input
            id="basemap-checkbox"
            data-testid="basemap-checkbox"
            name="showBasemap"
            type="checkbox"
            checked={showBasemap}
            onChange={(event) => onShowBasemapChange(event.target.checked)}
          />
          <span>Show basemap tiles (off renders the geometry only)</span>
        </label>
      </div>
    </div>
  );
}
