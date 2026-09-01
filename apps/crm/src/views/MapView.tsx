import {
  DEFAULT_PROPERTY_FILTERS,
  DEFAULT_RADIUS_MILES,
  SEMINOLE_COUNTY_CENTER,
  clampToCounty,
  propertyDisplay,
  resolveLocationInput,
  type GeoPoint,
  type PropertyDetail,
  type PropertyFilters,
  type PropertySearchItem,
  type SearchSort,
} from '@roofing-crm/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { MapCanvas } from '../components/MapCanvas';
import { PropertyDetailPanel } from '../components/PropertyDetailPanel';
import { RagChatMount, type NlqAppliedQuery } from '../components/RagChatMount';
import { ResultsList, type AppliedQuery } from '../components/ResultsList';
import { SearchPanel, type PanDirection } from '../components/SearchPanel';
import { useGeolocation } from '../useGeolocation';
import type { useLeads } from '../useLeads';

/**
 * The map workspace: search state, the radius query against the API, and the detail
 * panel. Search runs on mount and re-runs whenever the centre, radius, filters, or sort
 * change, debounced so dragging the radius slider does not fire a request per pixel. The
 * explicit "Search properties" button bypasses the debounce for a deterministic trigger.
 */

const SEARCH_DEBOUNCE_MS = 250;

const DEFAULT_CENTER_LABEL = 'Seminole County centre';

/** One pan step moves the centre by this fraction of the current radius. */
const PAN_FRACTION = 0.5;

const MILES_PER_DEGREE_LAT = 69.0546;

interface SearchResult {
  items: PropertySearchItem[];
  totalMatched: number;
  totalInRadius: number;
  unknownRoofAgeInRadius: number;
  cellsScanned: number;
  candidatesScanned: number;
}

const EMPTY_RESULT: SearchResult = {
  items: [],
  totalMatched: 0,
  totalInRadius: 0,
  unknownRoofAgeInRadius: 0,
  cellsScanned: 0,
  candidatesScanned: 0,
};

export interface MapViewProps {
  leads: ReturnType<typeof useLeads>;
}

export function MapView({ leads }: MapViewProps) {
  const [center, setCenter] = useState<GeoPoint>(SEMINOLE_COUNTY_CENTER);
  const [centerLabel, setCenterLabel] = useState(DEFAULT_CENTER_LABEL);
  const [locationText, setLocationText] = useState('');
  const [locationError, setLocationError] = useState<string | null>(null);
  const [radiusMiles, setRadiusMiles] = useState(DEFAULT_RADIUS_MILES);
  const [filters, setFilters] = useState<PropertyFilters>(DEFAULT_PROPERTY_FILTERS);
  const [sort, setSort] = useState<SearchSort>('distance');
  const [zoomOffset, setZoomOffset] = useState(0);
  const [showBasemap, setShowBasemap] = useState(true);

  const [result, setResult] = useState<SearchResult>(EMPTY_RESULT);
  const [applied, setApplied] = useState<AppliedQuery | null>(null);
  const [isSearching, setIsSearching] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);

  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(null);
  const [fetchedProperty, setFetchedProperty] = useState<PropertyDetail | null>(null);
  const [isLoadingProperty, setIsLoadingProperty] = useState(false);

  /** Guards against an earlier in-flight search overwriting a later one's results. */
  const requestSequence = useRef(0);

  const moveCenter = useCallback((point: GeoPoint, label: string) => {
    setCenter(point);
    setCenterLabel(label);
    setLocationError(null);
  }, []);

  const { geolocation, requestGeolocation } = useGeolocation(
    useCallback(
      (point: GeoPoint) => {
        moveCenter(point, 'Your device position');
      },
      [moveCenter],
    ),
  );

  useEffect(() => {
    const handle = setTimeout(() => {
      const sequence = requestSequence.current + 1;
      requestSequence.current = sequence;
      setIsSearching(true);

      api.properties.search
        .query({ center, radiusMiles, filters, sort, limit: 200 })
        .then((response) => {
          if (requestSequence.current !== sequence) return;
          setResult(response);
          // Published alongside the rows so the UI states which query they answer.
          setApplied({
            radiusMiles,
            minRoofAgeYears: filters.minRoofAgeYears,
            includeUnknownRoofAge: filters.includeUnknownRoofAge,
            permitStatus: filters.permitStatus,
            sort,
            poolStatus: filters.poolStatus,
            soldSinceYear: filters.soldSinceYear,
            minJustValue: filters.minJustValue,
            minYearsSinceLastSale: filters.minYearsSinceLastSale,
            outOfAreaOwnerOnly: filters.outOfAreaOwnerOnly,
          });
          setSearchError(null);
        })
        .catch((error: unknown) => {
          if (requestSequence.current !== sequence) return;
          setSearchError(
            `Property search failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setResult(EMPTY_RESULT);
        })
        .finally(() => {
          if (requestSequence.current === sequence) setIsSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [center, radiusMiles, filters, sort, searchNonce]);

  const selectedFromResults = useMemo(
    () => result.items.find((item) => item.parcel_id === selectedParcelId) ?? null,
    [result.items, selectedParcelId],
  );

  /**
   * Search hits already carry the full detail, so opening a pin costs no request. The
   * fetch is only for a selection that has dropped out of the current result set — a
   * filter change, say — which would otherwise blank the panel.
   */
  useEffect(() => {
    if (selectedParcelId === null || selectedFromResults) {
      setFetchedProperty(null);
      return;
    }

    let cancelled = false;
    setIsLoadingProperty(true);
    api.properties.get
      .query({ parcelId: selectedParcelId })
      .then((property) => {
        if (!cancelled) setFetchedProperty(property);
      })
      .catch(() => {
        if (!cancelled) setFetchedProperty(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingProperty(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedParcelId, selectedFromResults]);

  const selectedProperty: PropertyDetail | null = selectedFromResults ?? fetchedProperty;

  const handleApplyLocation = useCallback(() => {
    const resolved = resolveLocationInput(locationText);
    if (!resolved) {
      setLocationError(
        'Could not read that location. Enter a Seminole County city or ZIP, or coordinates as “28.75,-81.28”.',
      );
      return;
    }
    moveCenter({ latitude: resolved.latitude, longitude: resolved.longitude }, resolved.label);
  }, [locationText, moveCenter]);

  /**
   * A question's answer is applied to the same state the controls write to — centre, radius,
   * every filter, and the sort. That is what makes the chat a driver of this view rather than
   * a second view: the map re-frames, the inputs move to the parsed values, and the results
   * list re-queries through the ordinary search effect below.
   */
  const handleApplyNlqQuery = useCallback((query: NlqAppliedQuery) => {
    setCenter(query.center);
    setCenterLabel(`${query.centerLabel} — from your question`);
    // Kept in step so the location box shows the centre the question chose rather than
    // whatever was typed there before.
    setLocationText(`${query.center.latitude.toFixed(5)},${query.center.longitude.toFixed(5)}`);
    setLocationError(null);
    setRadiusMiles(query.radiusMiles);
    setFilters(query.filters);
    setSort(query.sort);
  }, []);

  const handlePan = useCallback(
    (direction: PanDirection) => {
      const latitudeStep = (radiusMiles * PAN_FRACTION) / MILES_PER_DEGREE_LAT;
      const longitudeStep =
        (radiusMiles * PAN_FRACTION) /
        (MILES_PER_DEGREE_LAT * Math.cos((center.latitude * Math.PI) / 180));

      const moved = {
        north: { latitude: center.latitude + latitudeStep, longitude: center.longitude },
        south: { latitude: center.latitude - latitudeStep, longitude: center.longitude },
        east: { latitude: center.latitude, longitude: center.longitude + longitudeStep },
        west: { latitude: center.latitude, longitude: center.longitude - longitudeStep },
      }[direction];

      moveCenter(clampToCounty(moved), `Panned ${direction}`);
    },
    [center, radiusMiles, moveCenter],
  );

  const handleCreateLead = useCallback(
    async ({ notes, source }: { notes: string; source: string }) => {
      if (!selectedProperty) return;
      // A lead's snapshot fields carry the resolved display label, so a lead created from an
      // unaddressed parcel is identifiable in the pipeline instead of arriving blank.
      const display = propertyDisplay(selectedProperty);
      await leads.create({
        parcelId: selectedProperty.parcel_id,
        ownerName: display.owner,
        primaryAddress: display.title,
        roofAgeYears: selectedProperty.roof_age_years,
        source,
        notes,
      });
    },
    [leads, selectedProperty],
  );

  const existingLeadCount = selectedProperty
    ? leads.leads.filter((lead) => lead.parcelId === selectedProperty.parcel_id).length
    : 0;

  return (
    <div className="map-view">
      <header className="content-head">
        <div>
          <h1>Map &amp; radius search</h1>
          <p>
            Seminole County, FL. Set a centre by address, ZIP, coordinates, GPS, or a dropped pin,
            then filter for aged roofs and stalled roofing permits.
          </p>
        </div>
        <p className="note mono" data-testid="search-diagnostics">
          {result.cellsScanned} geohash-5 cells · {result.candidatesScanned} candidates measured
        </p>
      </header>

      <div className="map-layout">
        <SearchPanel
          locationText={locationText}
          onLocationTextChange={setLocationText}
          onApplyLocation={handleApplyLocation}
          locationError={locationError}
          center={center}
          centerLabel={centerLabel}
          radiusMiles={radiusMiles}
          onRadiusChange={setRadiusMiles}
          filters={filters}
          onFiltersChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
          sort={sort}
          onSortChange={setSort}
          geolocation={geolocation}
          onUseMyLocation={requestGeolocation}
          onPan={handlePan}
          onZoom={(delta) => setZoomOffset((current) => Math.min(3, Math.max(-3, current + delta)))}
          zoomOffset={zoomOffset}
          showBasemap={showBasemap}
          onShowBasemapChange={setShowBasemap}
          onSearch={() => setSearchNonce((value) => value + 1)}
          onResetFilters={() => {
            setFilters(DEFAULT_PROPERTY_FILTERS);
            setRadiusMiles(DEFAULT_RADIUS_MILES);
            setSort('distance');
          }}
          isSearching={isSearching}
        />

        <div className="map-column">
          <MapCanvas
            center={center}
            radiusMiles={radiusMiles}
            properties={result.items}
            selectedParcelId={selectedParcelId}
            zoomOffset={zoomOffset}
            showBasemap={showBasemap}
            onPickPoint={(point) => {
              const clamped = clampToCounty(point);
              setLocationText(`${clamped.latitude.toFixed(5)},${clamped.longitude.toFixed(5)}`);
              moveCenter(clamped, 'Dropped pin');
            }}
            onSelectProperty={setSelectedParcelId}
          />

          <ResultsList
            items={result.items}
            selectedParcelId={selectedParcelId}
            onSelect={setSelectedParcelId}
            totalMatched={result.totalMatched}
            totalInRadius={result.totalInRadius}
            unknownRoofAgeInRadius={result.unknownRoofAgeInRadius}
            isSearching={isSearching}
            error={searchError}
            applied={applied}
          />
        </div>

        <div className="detail-column">
          <PropertyDetailPanel
            property={selectedProperty}
            isLoading={isLoadingProperty}
            onClose={() => {
              setSelectedParcelId(null);
              leads.resetCreateState();
            }}
            onCreateLead={handleCreateLead}
            createState={leads.createState}
            existingLeadCount={existingLeadCount}
          />

          <RagChatMount
            center={center}
            radiusMiles={radiusMiles}
            filters={filters}
            resultCount={result.totalMatched}
            onApplyQuery={handleApplyNlqQuery}
          />
        </div>
      </div>
    </div>
  );
}
