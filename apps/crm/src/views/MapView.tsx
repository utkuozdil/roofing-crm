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
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../api';
import {
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MapCanvas,
  mapBaseZoom,
  mapZoomForRadius,
} from '../components/MapCanvas';
import { MapControls } from '../components/MapControls';
import { PropertyDetailPanel } from '../components/PropertyDetailPanel';
import { RagChatMount, type NlqAppliedQuery } from '../components/RagChatMount';
import {
  ResultsList,
  type AppliedQuery,
  type InRadiusPermitCoverage,
} from '../components/ResultsList';
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

const MAP_MIN_HEIGHT = 220;
const MAP_MAX_HEIGHT = 720;
const DEFAULT_MAP_HEIGHT = 520;

interface SearchResult {
  items: PropertySearchItem[];
  totalMatched: number;
  totalInRadius: number;
  unknownRoofAgeInRadius: number;
  permitCoverage: InRadiusPermitCoverage | null;
  cellsScanned: number;
  candidatesScanned: number;
}

const EMPTY_RESULT: SearchResult = {
  items: [],
  totalMatched: 0,
  totalInRadius: 0,
  unknownRoofAgeInRadius: 0,
  permitCoverage: null,
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
  const [mapHeight, setMapHeight] = useState(DEFAULT_MAP_HEIGHT);
  const mapStageRef = useRef<HTMLDivElement>(null);

  const [result, setResult] = useState<SearchResult>(EMPTY_RESULT);
  const [applied, setApplied] = useState<AppliedQuery | null>(null);
  const [isSearching, setIsSearching] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);

  /**
   * Assumed true until the API says otherwise, so a slow provenance call never briefly greys out
   * a filter that in fact works. Getting it wrong for a moment in the permissive direction costs
   * one refused search; getting it wrong the other way looks like a broken control.
   */
  const [permitsAvailable, setPermitsAvailable] = useState(true);
  const [datasetRows, setDatasetRows] = useState<number | null>(null);

  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(null);
  const [fetchedProperty, setFetchedProperty] = useState<PropertyDetail | null>(null);
  const [isLoadingProperty, setIsLoadingProperty] = useState(false);

  /** Guards against an earlier in-flight search overwriting a later one's results. */
  const requestSequence = useRef(0);

  const setMapSizeFromHeight = useCallback((raw: number) => {
    setMapHeight(Math.min(MAP_MAX_HEIGHT, Math.max(MAP_MIN_HEIGHT, Math.round(raw))));
  }, []);

  const onMapResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const top = mapStageRef.current?.getBoundingClientRect().top ?? event.clientY - mapHeight;
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      setMapSizeFromHeight(moveEvent.clientY - top);
    };
    const onUp = (upEvent: PointerEvent) => {
      handle.releasePointerCapture(upEvent.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }, [mapHeight, setMapSizeFromHeight]);

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
    // Provenance decides which controls the dataset can honour. A failure here is not worth
    // surfacing on the map: the Status view reports the dataset, and the filters stay enabled.
    api.properties.dataset
      .query()
      .then((dataset) => {
        setPermitsAvailable(dataset.permitsAvailable);
        setDatasetRows(dataset.rowCount);
      })
      .catch(() => undefined);
  }, []);

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

  const handleZoom = useCallback(
    (delta: number) => {
      setZoomOffset((current) => {
        const base = mapBaseZoom(center.latitude, radiusMiles);
        const nextZoom = Math.min(
          MAP_MAX_ZOOM,
          Math.max(MAP_MIN_ZOOM, base + current + delta),
        );
        return nextZoom - base;
      });
    },
    [center.latitude, radiusMiles],
  );

  const mapZoom = mapZoomForRadius(center.latitude, radiusMiles, zoomOffset);

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
          <h1>Find leads</h1>
          <p>Seminole County, FL</p>
          {datasetRows !== null && (
            <p className="note" data-testid="dataset-strip">
              {datasetRows.toLocaleString('en-US')} parcels
              {permitsAvailable
                ? ' · permit history loaded'
                : ' · parcels only, no permit history yet'}
            </p>
          )}
        </div>
        <p className="visually-hidden" data-testid="search-diagnostics">
          {result.cellsScanned} geohash-5 cells · {result.candidatesScanned} candidates measured
        </p>
      </header>

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
          permitsAvailable={permitsAvailable}
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

      <RagChatMount
        center={center}
        radiusMiles={radiusMiles}
        filters={filters}
        resultCount={result.totalMatched}
        onApplyQuery={handleApplyNlqQuery}
      />

      <div className="map-workspace">
        <div className="map-column">
          <div
            ref={mapStageRef}
            className="map-stage"
            data-testid="map-stage"
            style={{ height: mapHeight }}
          >
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
              onZoom={handleZoom}
            />
            <MapControls
              onPan={handlePan}
              onZoom={handleZoom}
              canZoomIn={mapZoom < MAP_MAX_ZOOM}
              canZoomOut={mapZoom > MAP_MIN_ZOOM}
            />
          </div>
          <button
            className="map-resize-handle"
            type="button"
            data-testid="map-resize-handle"
            aria-label="Drag to resize the map"
            onPointerDown={onMapResizePointerDown}
          />
          <label className="visually-hidden" htmlFor="map-size-slider">
            Map height
            <input
              id="map-size-slider"
              data-testid="map-size-slider"
              type="range"
              min={MAP_MIN_HEIGHT}
              max={MAP_MAX_HEIGHT}
              step={10}
              value={Math.min(MAP_MAX_HEIGHT, Math.max(MAP_MIN_HEIGHT, mapHeight))}
              onChange={(event) => setMapSizeFromHeight(Number(event.target.value))}
            />
            <input
              data-testid="map-size-input"
              type="number"
              min={MAP_MIN_HEIGHT}
              max={MAP_MAX_HEIGHT}
              step={10}
              value={Math.min(MAP_MAX_HEIGHT, Math.max(MAP_MIN_HEIGHT, mapHeight))}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) setMapSizeFromHeight(next);
              }}
              aria-label="Map height in pixels"
            />
          </label>
        </div>

        <ResultsList
          items={result.items}
          selectedParcelId={selectedParcelId}
          onSelect={setSelectedParcelId}
          onClear={() => {
            setSelectedParcelId(null);
            leads.resetCreateState();
          }}
          totalMatched={result.totalMatched}
          totalInRadius={result.totalInRadius}
          unknownRoofAgeInRadius={result.unknownRoofAgeInRadius}
          permitCoverage={result.permitCoverage}
          isSearching={isSearching}
          error={searchError}
          applied={applied}
          detail={
            (selectedParcelId || isLoadingProperty) && (
              <PropertyDetailPanel
                property={selectedProperty}
                permitsAvailable={permitsAvailable}
                isLoading={isLoadingProperty}
                onClose={() => {
                  setSelectedParcelId(null);
                  leads.resetCreateState();
                }}
                onCreateLead={handleCreateLead}
                createState={leads.createState}
                existingLeadCount={existingLeadCount}
              />
            )
          }
        />
      </div>
    </div>
  );
}
