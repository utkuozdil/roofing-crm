/**
 * Geospatial primitives shared by the API's radius search and the SPA's map.
 *
 * Radius search is deliberately two-phase — geohash prefix bucket first, exact
 * haversine second — because that is the access pattern the real property store will
 * use. Keeping the fixture-backed source on the same algorithm means swapping in real
 * data changes only where the buckets are read from, never how a result set is decided.
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Mean Earth radius. Miles, because every distance in this product is user-facing. */
export const EARTH_RADIUS_MILES = 3958.7613;

/** A geohash-5 cell is roughly 3 miles on a side, which suits county-scale buckets. */
export const GEOHASH_PRECISION = 5;

/** Degrees of latitude spanned by one geohash-5 cell (12 of the 25 bits are latitude). */
const GEOHASH5_LAT_STEP = 180 / 2 ** 12;

/** Degrees of longitude spanned by one geohash-5 cell (13 of the 25 bits are longitude). */
const GEOHASH5_LON_STEP = 360 / 2 ** 13;

/** Length of one degree of latitude, used only for cheap bounding-box maths. */
const MILES_PER_DEGREE_LAT = 69.0546;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export function encodeGeohash(
  latitude: number,
  longitude: number,
  precision: number = GEOHASH_PRECISION,
): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = '';
  let bits = 0;
  let value = 0;
  let longitudeTurn = true;

  while (hash.length < precision) {
    if (longitudeTurn) {
      const mid = (lonMin + lonMax) / 2;
      if (longitude >= mid) {
        value = (value << 1) + 1;
        lonMin = mid;
      } else {
        value <<= 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latitude >= mid) {
        value = (value << 1) + 1;
        latMin = mid;
      } else {
        value <<= 1;
        latMax = mid;
      }
    }

    longitudeTurn = !longitudeTurn;
    bits += 1;
    if (bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }

  return hash;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function haversineMiles(from: GeoPoint, to: GeoPoint): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Longitude degrees per mile at a given latitude. Guarded near the poles. */
function milesPerDegreeLon(latitude: number): number {
  return Math.max(MILES_PER_DEGREE_LAT * Math.cos(toRadians(latitude)), 1e-6);
}

export interface BoundingBox {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}

export function boundingBoxAround(center: GeoPoint, radiusMiles: number): BoundingBox {
  const dLat = radiusMiles / MILES_PER_DEGREE_LAT;
  const dLon = radiusMiles / milesPerDegreeLon(center.latitude);
  return {
    minLatitude: Math.max(center.latitude - dLat, -90),
    maxLatitude: Math.min(center.latitude + dLat, 90),
    minLongitude: center.longitude - dLon,
    maxLongitude: center.longitude + dLon,
  };
}

/**
 * Every geohash-5 cell that can hold a point inside `radiusMiles` of `center`.
 *
 * The walk steps by half a cell so no cell straddling the bounding box edge is skipped,
 * and it returns cells rather than a prefix so a caller with a real key-value store can
 * fan the same set out as parallel partition reads.
 */
export function geohashCellsForRadius(
  center: GeoPoint,
  radiusMiles: number,
  precision: number = GEOHASH_PRECISION,
): string[] {
  const box = boundingBoxAround(center, radiusMiles);
  const latStep = GEOHASH5_LAT_STEP / 2;
  const lonStep = GEOHASH5_LON_STEP / 2;
  const cells = new Set<string>();

  for (let lat = box.minLatitude; lat <= box.maxLatitude + latStep; lat += latStep) {
    for (let lon = box.minLongitude; lon <= box.maxLongitude + lonStep; lon += lonStep) {
      cells.add(
        encodeGeohash(Math.min(lat, box.maxLatitude), Math.min(lon, box.maxLongitude), precision),
      );
    }
  }

  cells.add(encodeGeohash(center.latitude, center.longitude, precision));
  return [...cells].sort();
}

/** Parses `"28.75,-81.28"` and its space-separated variants. Returns null if it is not a pair. */
export function parseLatLonPair(raw: string): GeoPoint | null {
  const parts = raw
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (parts.length !== 2) return null;

  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  return { latitude, longitude };
}
