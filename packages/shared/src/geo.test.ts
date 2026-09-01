import { describe, expect, it } from 'vitest';
import { encodeGeohash, geohashCellsForRadius, haversineMiles, parseLatLonPair } from './geo';
import { SEMINOLE_COUNTY_CENTER } from './seminole';

describe('encodeGeohash', () => {
  it('matches known reference geohashes', () => {
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    expect(encodeGeohash(0, 0, 5)).toBe('s0000');
  });

  it('puts the county centre in a stable precision-5 cell', () => {
    expect(encodeGeohash(28.75, -81.28, 5)).toBe('djn5w');
  });

  /**
   * Cross-implementation conformance with the Oracle pipeline's Python encoder, which
   * writes the `geohash5` partition keys this search reads. The two were compared on these
   * ten coordinates, including the poles, the antimeridian, and the null island, and agreed
   * exactly. Pinning the expected values here means a change to either encoder that would
   * silently make the prefix pass skip partitions fails a test instead.
   */
  it.each([
    [28.642469, -81.454396, 'djn4f'],
    [28.646815, -81.433877, 'djn4f'],
    [28.641075, -81.34618, 'djn4u'],
    [28.648885, -81.320266, 'djn4v'],
    [28.629407, -81.287777, 'djn4y'],
    [28.8003, -81.2731, 'djn5y'],
    [28.75, -81.28, 'djn5w'],
    [0, 0, 's0000'],
    [-90, -180, '00000'],
    [90, 180, 'zzzzz'],
  ])('agrees with the pipeline encoder on %s,%s', (latitude, longitude, expected) => {
    expect(encodeGeohash(latitude, longitude, 5)).toBe(expected);
  });
});

describe('haversineMiles', () => {
  it('is zero for a point against itself', () => {
    expect(haversineMiles(SEMINOLE_COUNTY_CENTER, SEMINOLE_COUNTY_CENTER)).toBe(0);
  });

  it('measures one degree of latitude as ~69 miles', () => {
    const distance = haversineMiles(
      { latitude: 28, longitude: -81 },
      { latitude: 29, longitude: -81 },
    );
    expect(distance).toBeGreaterThan(68.5);
    expect(distance).toBeLessThan(69.5);
  });

  it('is symmetric', () => {
    const a = { latitude: 28.8, longitude: -81.27 };
    const b = { latitude: 28.66, longitude: -81.37 };
    expect(haversineMiles(a, b)).toBeCloseTo(haversineMiles(b, a), 10);
  });
});

describe('geohashCellsForRadius', () => {
  it('always includes the centre cell', () => {
    const cells = geohashCellsForRadius(SEMINOLE_COUNTY_CENTER, 0.1);
    expect(cells).toContain(encodeGeohash(28.75, -81.28, 5));
  });

  it('grows the candidate cell set as the radius grows', () => {
    const small = geohashCellsForRadius(SEMINOLE_COUNTY_CENTER, 1);
    const large = geohashCellsForRadius(SEMINOLE_COUNTY_CENTER, 15);
    expect(large.length).toBeGreaterThan(small.length);
    for (const cell of small) {
      expect(large).toContain(cell);
    }
  });

  /**
   * The whole point of the prefix phase is that it never discards a real hit. A cell set
   * that missed an in-radius point would silently under-report leads.
   */
  it('covers every point inside the radius', () => {
    const radiusMiles = 6;
    const cells = new Set(geohashCellsForRadius(SEMINOLE_COUNTY_CENTER, radiusMiles));

    for (let bearing = 0; bearing < 360; bearing += 7) {
      for (const fraction of [0.25, 0.6, 0.99]) {
        const distance = radiusMiles * fraction;
        const radians = (bearing * Math.PI) / 180;
        const latitude = SEMINOLE_COUNTY_CENTER.latitude + (distance * Math.cos(radians)) / 69.0546;
        const longitude =
          SEMINOLE_COUNTY_CENTER.longitude +
          (distance * Math.sin(radians)) /
            (69.0546 * Math.cos((SEMINOLE_COUNTY_CENTER.latitude * Math.PI) / 180));
        expect(cells.has(encodeGeohash(latitude, longitude, 5))).toBe(true);
      }
    }
  });
});

describe('parseLatLonPair', () => {
  it.each([
    ['28.75,-81.28', 28.75, -81.28],
    ['28.75, -81.28', 28.75, -81.28],
    ['  28.8003 -81.2731 ', 28.8003, -81.2731],
    ['28.75;-81.28', 28.75, -81.28],
  ])('parses %s', (input, latitude, longitude) => {
    expect(parseLatLonPair(input)).toEqual({ latitude, longitude });
  });

  it.each(['Sanford', '32771', '', '28.75', '28.75,-81.28,3', '91,-81', '28,-181', 'a,b'])(
    'rejects %s',
    (input) => {
      expect(parseLatLonPair(input)).toBeNull();
    },
  );
});
