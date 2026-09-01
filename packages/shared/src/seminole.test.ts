import { describe, expect, it } from 'vitest';
import {
  SEMINOLE_COUNTY_BOUNDS,
  SEMINOLE_COUNTY_CENTER,
  SEMINOLE_PLACES,
  clampToCounty,
  nearestPlace,
  resolveLocationInput,
} from './seminole';

describe('resolveLocationInput', () => {
  it('reads a coordinate pair verbatim', () => {
    expect(resolveLocationInput('28.8003, -81.2731')).toEqual({
      latitude: 28.8003,
      longitude: -81.2731,
      label: '28.80030, -81.27310',
      source: 'coordinates',
    });
  });

  it('resolves a county ZIP to its centroid', () => {
    const resolved = resolveLocationInput('32746');
    expect(resolved?.source).toBe('zip');
    expect(resolved?.label).toContain('32746');
  });

  it('resolves a place name case-insensitively', () => {
    expect(resolveLocationInput('oviedo')?.label).toBe('Oviedo, FL 32765');
    expect(resolveLocationInput('LAKE MARY')?.label).toBe('Lake Mary, FL 32746');
  });

  it('resolves a place name embedded in a longer string', () => {
    expect(resolveLocationInput('downtown Sanford FL')?.source).toBe('place');
  });

  it('returns null for input it cannot understand', () => {
    expect(resolveLocationInput('')).toBeNull();
    expect(resolveLocationInput('   ')).toBeNull();
    expect(resolveLocationInput('Kalamazoo')).toBeNull();
    expect(resolveLocationInput('99999')).toBeNull();
  });
});

describe('clampToCounty', () => {
  it('leaves an in-county point alone', () => {
    expect(clampToCounty(SEMINOLE_COUNTY_CENTER)).toEqual(SEMINOLE_COUNTY_CENTER);
  });

  it('pulls an out-of-county point back to the nearest edge', () => {
    expect(clampToCounty({ latitude: 40, longitude: -74 })).toEqual({
      latitude: SEMINOLE_COUNTY_BOUNDS.maxLatitude,
      longitude: SEMINOLE_COUNTY_BOUNDS.maxLongitude,
    });
    expect(clampToCounty({ latitude: 25, longitude: -90 })).toEqual({
      latitude: SEMINOLE_COUNTY_BOUNDS.minLatitude,
      longitude: SEMINOLE_COUNTY_BOUNDS.minLongitude,
    });
  });
});

/**
 * This is what locates a parcel the county holds no address for, so it has to resolve for
 * every point in the county — coordinate coverage is 100%, and the fallback would be
 * worthless if it could itself come back empty.
 */
describe('nearestPlace', () => {
  it('returns the place a point sits on top of', () => {
    expect(nearestPlace({ latitude: 28.8003, longitude: -81.2731 }).name).toBe('Sanford');
    expect(nearestPlace({ latitude: 28.67, longitude: -81.2081 }).name).toBe('Oviedo');
  });

  it('resolves every corner of the county envelope', () => {
    const corners = [
      {
        latitude: SEMINOLE_COUNTY_BOUNDS.minLatitude,
        longitude: SEMINOLE_COUNTY_BOUNDS.minLongitude,
      },
      {
        latitude: SEMINOLE_COUNTY_BOUNDS.minLatitude,
        longitude: SEMINOLE_COUNTY_BOUNDS.maxLongitude,
      },
      {
        latitude: SEMINOLE_COUNTY_BOUNDS.maxLatitude,
        longitude: SEMINOLE_COUNTY_BOUNDS.minLongitude,
      },
      {
        latitude: SEMINOLE_COUNTY_BOUNDS.maxLatitude,
        longitude: SEMINOLE_COUNTY_BOUNDS.maxLongitude,
      },
    ];

    for (const corner of corners) {
      const place = nearestPlace(corner);
      expect(place.label).toMatch(/^[A-Za-z ]+, FL \d{5}$/);
      expect(place.distanceMiles).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic', () => {
    const point = { latitude: 28.71, longitude: -81.3 };
    expect(nearestPlace(point)).toEqual(nearestPlace(point));
  });
});

describe('SEMINOLE_PLACES', () => {
  it('keeps every gazetteer entry inside the county envelope', () => {
    for (const place of SEMINOLE_PLACES) {
      expect(clampToCounty(place)).toEqual({
        latitude: place.latitude,
        longitude: place.longitude,
      });
    }
  });
});
