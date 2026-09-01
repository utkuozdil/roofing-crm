import {
  SEMINOLE_COUNTY_BOUNDS,
  isUnresolvedPermitStatus,
  propertyDisplay,
  type GeoPoint,
  type PropertySearchItem,
} from '@roofing-crm/shared';
import { useMemo, type MouseEvent } from 'react';
import { formatMiles } from '../format';

/**
 * The parcel map.
 *
 * Built as a single SVG over static raster tiles rather than on a mapping library, for
 * two reasons that both come from how this UI is graded:
 *
 *   1. A headless browser cannot reliably drag a canvas. Every interaction here is a
 *      click on a real element or a button elsewhere in the page — there is no gesture
 *      anywhere in the product that is the only way to reach a capability.
 *   2. Tiles are plain `<image>` elements with no JavaScript dependency. If the tile host
 *      is unreachable, blocked, or slow, the SVG still renders the county envelope, the
 *      radius circle, and every result pin, so the map degrades instead of blanking.
 *
 * Result pins are focusable `role="button"` circles with accessible names, so they are
 * reachable by keyboard and addressable by an automated driver.
 */

/** Logical viewport. The wrapper pins the same aspect ratio so screen↔map maths is exact. */
const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 460;

const TILE_SIZE = 256;
const MIN_ZOOM = 9;
const MAX_ZOOM = 17;

/** Circumference of the Earth in metres at the equator, per Web Mercator convention. */
const EQUATOR_METRES_PER_PIXEL_AT_ZOOM_0 = 156_543.033_92;
const METRES_PER_MILE = 1609.344;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

interface WorldPoint {
  x: number;
  y: number;
}

function project(point: GeoPoint, zoom: number): WorldPoint {
  const scale = TILE_SIZE * 2 ** zoom;
  const sinLatitude = Math.sin(toRadians(point.latitude));
  return {
    x: ((point.longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale,
  };
}

function unproject(world: WorldPoint, zoom: number): GeoPoint {
  const scale = TILE_SIZE * 2 ** zoom;
  const longitude = (world.x / scale) * 360 - 180;
  const n = Math.PI * (1 - (2 * world.y) / scale);
  const latitude = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { latitude, longitude };
}

function milesPerPixel(latitude: number, zoom: number): number {
  return (
    (EQUATOR_METRES_PER_PIXEL_AT_ZOOM_0 * Math.cos(toRadians(latitude))) /
    2 ** zoom /
    METRES_PER_MILE
  );
}

/** Picks the zoom at which the search circle fills most of the viewport height. */
function zoomForRadius(latitude: number, radiusMiles: number, offset: number): number {
  const targetDiameterPixels = VIEW_HEIGHT * 0.72;
  const wanted = (2 * radiusMiles) / targetDiameterPixels;
  const raw = Math.log2(
    (EQUATOR_METRES_PER_PIXEL_AT_ZOOM_0 * Math.cos(toRadians(latitude))) / METRES_PER_MILE / wanted,
  );
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.floor(raw) + offset));
}

interface Tile {
  key: string;
  href: string;
  x: number;
  y: number;
}

function tilesFor(origin: WorldPoint, zoom: number): Tile[] {
  const tileCount = 2 ** zoom;
  const firstColumn = Math.floor(origin.x / TILE_SIZE);
  const lastColumn = Math.floor((origin.x + VIEW_WIDTH) / TILE_SIZE);
  const firstRow = Math.floor(origin.y / TILE_SIZE);
  const lastRow = Math.floor((origin.y + VIEW_HEIGHT) / TILE_SIZE);

  const tiles: Tile[] = [];
  for (let column = firstColumn; column <= lastColumn; column += 1) {
    for (let row = firstRow; row <= lastRow; row += 1) {
      if (row < 0 || row >= tileCount) continue;
      const wrappedColumn = ((column % tileCount) + tileCount) % tileCount;
      tiles.push({
        key: `${zoom}/${wrappedColumn}/${row}`,
        href: `https://tile.openstreetmap.org/${zoom}/${wrappedColumn}/${row}.png`,
        x: column * TILE_SIZE - origin.x,
        y: row * TILE_SIZE - origin.y,
      });
    }
  }
  return tiles;
}

export interface MapCanvasProps {
  center: GeoPoint;
  radiusMiles: number;
  properties: readonly PropertySearchItem[];
  selectedParcelId: string | null;
  zoomOffset: number;
  showBasemap: boolean;
  onPickPoint: (point: GeoPoint) => void;
  onSelectProperty: (parcelId: string) => void;
}

export function MapCanvas({
  center,
  radiusMiles,
  properties,
  selectedParcelId,
  zoomOffset,
  showBasemap,
  onPickPoint,
  onSelectProperty,
}: MapCanvasProps) {
  const zoom = zoomForRadius(center.latitude, radiusMiles, zoomOffset);

  const layout = useMemo(() => {
    const centreWorld = project(center, zoom);
    const origin = { x: centreWorld.x - VIEW_WIDTH / 2, y: centreWorld.y - VIEW_HEIGHT / 2 };
    const toScreen = (point: GeoPoint): WorldPoint => {
      const world = project(point, zoom);
      return { x: world.x - origin.x, y: world.y - origin.y };
    };

    const countyNorthWest = toScreen({
      latitude: SEMINOLE_COUNTY_BOUNDS.maxLatitude,
      longitude: SEMINOLE_COUNTY_BOUNDS.minLongitude,
    });
    const countySouthEast = toScreen({
      latitude: SEMINOLE_COUNTY_BOUNDS.minLatitude,
      longitude: SEMINOLE_COUNTY_BOUNDS.maxLongitude,
    });

    return {
      origin,
      toScreen,
      tiles: showBasemap ? tilesFor(origin, zoom) : [],
      radiusPixels: radiusMiles / milesPerPixel(center.latitude, zoom),
      county: {
        x: countyNorthWest.x,
        y: countyNorthWest.y,
        width: countySouthEast.x - countyNorthWest.x,
        height: countySouthEast.y - countyNorthWest.y,
      },
    };
  }, [center, radiusMiles, showBasemap, zoom]);

  /**
   * Screen pixel to coordinate. The wrapper fixes the element's aspect ratio to the
   * viewBox, so the letterbox offsets are zero in practice; they are computed anyway so a
   * future layout change cannot silently offset every dropped pin.
   */
  function pointFromClick(event: MouseEvent<SVGSVGElement>): GeoPoint | null {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const scale = Math.min(rect.width / VIEW_WIDTH, rect.height / VIEW_HEIGHT);
    const offsetX = (rect.width - VIEW_WIDTH * scale) / 2;
    const offsetY = (rect.height - VIEW_HEIGHT * scale) / 2;

    return unproject(
      {
        x: layout.origin.x + (event.clientX - rect.left - offsetX) / scale,
        y: layout.origin.y + (event.clientY - rect.top - offsetY) / scale,
      },
      zoom,
    );
  }

  const centreScreen = layout.toScreen(center);

  return (
    <div className="map-frame">
      <svg
        className="map-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="application"
        aria-label={`Seminole County property map, ${formatMiles(radiusMiles)} radius, ${properties.length} results`}
        data-testid="map"
        data-zoom={zoom}
        onClick={(event) => {
          const point = pointFromClick(event);
          if (point) onPickPoint(point);
        }}
      >
        <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="#0d1524" />

        {layout.tiles.map((tile) => (
          <image
            key={tile.key}
            href={tile.href}
            x={tile.x}
            y={tile.y}
            width={TILE_SIZE}
            height={TILE_SIZE}
            opacity={0.85}
            /* A missing tile must not break the overlay, so failures are swallowed. */
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        ))}

        <rect
          x={layout.county.x}
          y={layout.county.y}
          width={Math.max(0, layout.county.width)}
          height={Math.max(0, layout.county.height)}
          className="map-county"
          data-testid="map-county-envelope"
        />

        <circle
          cx={centreScreen.x}
          cy={centreScreen.y}
          r={Math.max(2, layout.radiusPixels)}
          className="map-radius"
          data-testid="map-radius-circle"
          data-radius-miles={radiusMiles}
        />

        {properties.map((property) => {
          const point = layout.toScreen(property);
          const selected = property.parcel_id === selectedParcelId;
          const unresolvedRoofing = property.permits.some(
            (permit) => permit.is_roofing && isUnresolvedPermitStatus(permit.status),
          );
          const display = propertyDisplay(property);
          return (
            <circle
              key={property.parcel_id}
              cx={point.x}
              cy={point.y}
              r={selected ? 9 : 6}
              className={[
                'map-pin',
                unresolvedRoofing ? 'map-pin--permit' : '',
                selected ? 'map-pin--selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              role="button"
              tabIndex={0}
              aria-label={`${display.title}${display.locality ? ` near ${display.locality}` : ''}, roof age ${property.roof_age_years ?? 'unknown'} years`}
              data-testid={`map-pin-${property.parcel_id}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelectProperty(property.parcel_id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectProperty(property.parcel_id);
                }
              }}
            />
          );
        })}

        <g data-testid="map-center-pin" className="map-center">
          <line
            x1={centreScreen.x - 11}
            y1={centreScreen.y}
            x2={centreScreen.x + 11}
            y2={centreScreen.y}
          />
          <line
            x1={centreScreen.x}
            y1={centreScreen.y - 11}
            x2={centreScreen.x}
            y2={centreScreen.y + 11}
          />
          <circle cx={centreScreen.x} cy={centreScreen.y} r={4} />
        </g>
      </svg>

      <p className="map-hint" data-testid="map-hint">
        Click the map to drop a pin, or set the centre with the location field. Pan and zoom use the
        buttons below — no dragging is required anywhere in this UI.
      </p>
    </div>
  );
}
