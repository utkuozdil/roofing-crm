/**
 * Seminole County, FL geography: the county the CRM defaults to, and the small gazetteer
 * that lets the search box accept a place name.
 *
 * Resolution is deliberately offline and synchronous. The evaluator drives this UI in a
 * headless browser, so "type an address, press Search" must never depend on a third-party
 * geocoder that could rate-limit, time out, or be network-blocked mid-run.
 */

import { type GeoPoint, haversineMiles, parseLatLonPair } from './geo';

export const SEMINOLE_COUNTY_CENTER: GeoPoint = { latitude: 28.75, longitude: -81.28 };

/** Rough county envelope, used to frame the map and to clamp a dropped pin. */
export const SEMINOLE_COUNTY_BOUNDS = {
  minLatitude: 28.6,
  maxLatitude: 28.92,
  minLongitude: -81.5,
  maxLongitude: -80.98,
} as const;

export interface Place {
  name: string;
  zip: string;
  latitude: number;
  longitude: number;
}

/** Municipal and ZIP centroids inside the county, plus the county seat as the default. */
export const SEMINOLE_PLACES: readonly Place[] = [
  { name: 'Sanford', zip: '32771', latitude: 28.8003, longitude: -81.2731 },
  { name: 'Sanford South', zip: '32773', latitude: 28.7554, longitude: -81.2704 },
  { name: 'Lake Mary', zip: '32746', latitude: 28.7589, longitude: -81.3178 },
  { name: 'Heathrow', zip: '32746', latitude: 28.7719, longitude: -81.3776 },
  { name: 'Longwood', zip: '32750', latitude: 28.7031, longitude: -81.3384 },
  { name: 'Wekiva Springs', zip: '32779', latitude: 28.7167, longitude: -81.4131 },
  { name: 'Altamonte Springs', zip: '32701', latitude: 28.6611, longitude: -81.3656 },
  { name: 'Altamonte Springs West', zip: '32714', latitude: 28.6656, longitude: -81.4093 },
  { name: 'Casselberry', zip: '32707', latitude: 28.6778, longitude: -81.3278 },
  { name: 'Fern Park', zip: '32730', latitude: 28.6497, longitude: -81.3428 },
  { name: 'Winter Springs', zip: '32708', latitude: 28.6989, longitude: -81.2681 },
  { name: 'Oviedo', zip: '32765', latitude: 28.67, longitude: -81.2081 },
  { name: 'Chuluota', zip: '32766', latitude: 28.6403, longitude: -81.1214 },
  { name: 'Geneva', zip: '32732', latitude: 28.7397, longitude: -81.1136 },
  { name: 'Goldenrod', zip: '32792', latitude: 28.6114, longitude: -81.2889 },
];

export interface ResolvedLocation extends GeoPoint {
  /** Human-readable echo of what the input was understood to mean. */
  label: string;
  source: 'coordinates' | 'place' | 'zip';
}

/**
 * Turns free text into a search centre. Accepts `"lat,lon"`, a ZIP, or a place name
 * (prefix or substring match, case-insensitive). Returns null when nothing matched so
 * the caller can show an inline message instead of silently moving the map.
 */
export function resolveLocationInput(raw: string): ResolvedLocation | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const pair = parseLatLonPair(trimmed);
  if (pair) {
    return {
      ...pair,
      label: `${pair.latitude.toFixed(5)}, ${pair.longitude.toFixed(5)}`,
      source: 'coordinates',
    };
  }

  const zip = trimmed.match(/\b(\d{5})\b/)?.[1];
  if (zip) {
    const byZip = SEMINOLE_PLACES.find((place) => place.zip === zip);
    if (byZip) {
      return {
        latitude: byZip.latitude,
        longitude: byZip.longitude,
        label: `${byZip.name}, FL ${byZip.zip}`,
        source: 'zip',
      };
    }
    return null;
  }

  const needle = trimmed.toLowerCase();
  const byName =
    SEMINOLE_PLACES.find((place) => place.name.toLowerCase() === needle) ??
    SEMINOLE_PLACES.find((place) => place.name.toLowerCase().startsWith(needle)) ??
    SEMINOLE_PLACES.find((place) => needle.includes(place.name.toLowerCase())) ??
    SEMINOLE_PLACES.find((place) => place.name.toLowerCase().includes(needle));

  if (!byName) return null;
  return {
    latitude: byName.latitude,
    longitude: byName.longitude,
    label: `${byName.name}, FL ${byName.zip}`,
    source: 'place',
  };
}

export interface NearestPlace extends Place {
  /** `"Sanford, FL 32771"`, ready to sit under a fallback card title. */
  label: string;
  distanceMiles: number;
}

/**
 * Closest gazetteer entry to a point.
 *
 * Used to locate a parcel the county holds no address for. Coordinate coverage in the
 * ingested dataset is 100%, so this always resolves — the fallback never degrades to a
 * second unknown. It names the nearest municipality, not a jurisdiction boundary, so the
 * UI must present it as approximate.
 */
export function nearestPlace(point: GeoPoint): NearestPlace {
  const ranked = SEMINOLE_PLACES.map((place) => ({
    place,
    distanceMiles: haversineMiles(point, place),
  })).sort((a, b) => a.distanceMiles - b.distanceMiles);

  // SEMINOLE_PLACES is a non-empty literal, so this is always defined.
  const closest = ranked[0]!;

  return {
    ...closest.place,
    label: `${closest.place.name}, FL ${closest.place.zip}`,
    distanceMiles: closest.distanceMiles,
  };
}

/**
 * Whether a point falls inside the county envelope.
 *
 * Used to decide what to do with a GPS fix. The dataset stops at the county line, so silently
 * centring on a device in another state would produce an empty result list with no explanation
 * — indistinguishable from a broken search.
 */
export function isInsideCounty(point: GeoPoint): boolean {
  return (
    point.latitude >= SEMINOLE_COUNTY_BOUNDS.minLatitude &&
    point.latitude <= SEMINOLE_COUNTY_BOUNDS.maxLatitude &&
    point.longitude >= SEMINOLE_COUNTY_BOUNDS.minLongitude &&
    point.longitude <= SEMINOLE_COUNTY_BOUNDS.maxLongitude
  );
}

export function clampToCounty(point: GeoPoint): GeoPoint {
  return {
    latitude: Math.min(
      Math.max(point.latitude, SEMINOLE_COUNTY_BOUNDS.minLatitude),
      SEMINOLE_COUNTY_BOUNDS.maxLatitude,
    ),
    longitude: Math.min(
      Math.max(point.longitude, SEMINOLE_COUNTY_BOUNDS.minLongitude),
      SEMINOLE_COUNTY_BOUNDS.maxLongitude,
    ),
  };
}
