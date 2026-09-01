import { describe, expect, it } from 'vitest';
import {
  COUNTY_WIDE_RADIUS_MILES,
  NEAR_PLACE_RADIUS_MILES,
  formatNlqSummary,
  groundNlqQuery,
  mentionsCurrentView,
  statesDistance,
  type NlqContext,
  type NlqQueryDraft,
} from './nlq';
import { SEMINOLE_COUNTY_CENTER } from './seminole';

const NOW = new Date('2026-09-01T00:00:00.000Z');

/** The live map state a question is asked against. Deliberately not the county centre. */
const MAP_CONTEXT = {
  center: { latitude: 28.6611, longitude: -81.3656 },
  radiusMiles: 4,
};

function context(question: string): NlqContext {
  return { question, ...MAP_CONTEXT };
}

/** A draft with nothing set: the shape the model returns for "everything, everywhere". */
function draft(overrides: Partial<NlqQueryDraft> = {}): NlqQueryDraft {
  return {
    intent: 'property_search',
    refusalReason: null,
    locationMode: 'county',
    place: null,
    radiusMiles: null,
    minRoofAgeYears: null,
    includeUnknownRoofAge: null,
    permitStatus: null,
    minPermitOpenYears: null,
    minYearsSinceLastSale: null,
    soldSinceYear: null,
    outOfAreaOwnerOnly: null,
    poolStatus: null,
    minJustValue: null,
    propertyTypes: null,
    sort: null,
    ...overrides,
  };
}

function ground(question: string, overrides: Partial<NlqQueryDraft> = {}) {
  const result = groundNlqQuery(draft(overrides), context(question), NOW);
  if (result.status !== 'grounded') {
    throw new Error(`expected a grounded query, got refusal: ${result.reason}`);
  }
  return result.query;
}

function criterionKeys(question: string, overrides: Partial<NlqQueryDraft> = {}): string[] {
  return ground(question, overrides).criteria.map((criterion) => criterion.key);
}

describe('refusals', () => {
  it('refuses an out-of-scope intent and passes the model’s reason through', () => {
    const result = groundNlqQuery(
      draft({ intent: 'out_of_scope', refusalReason: 'The CRM holds no roof material.' }),
      context('what colour are the shingles'),
      NOW,
    );
    expect(result).toEqual({ status: 'refused', reason: 'The CRM holds no roof material.' });
  });

  it('still refuses when the model gives no reason', () => {
    const result = groundNlqQuery(
      draft({ intent: 'out_of_scope', refusalReason: null }),
      context('write me a poem'),
      NOW,
    );
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason.length).toBeGreaterThan(0);
  });

  /**
   * The gazetteer is the only source of coordinates in the system. Answering a question about
   * another county with Seminole County rows would be the confidently-wrong failure this whole
   * design exists to prevent, so an unresolvable place is a refusal, never a fallback.
   */
  it('refuses a place outside the county instead of quietly searching the county', () => {
    const result = groundNlqQuery(
      draft({ locationMode: 'place', place: 'Kalamazoo' }),
      context('old roofs in Kalamazoo'),
      NOW,
    );
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toContain('Kalamazoo');
      expect(result.reason).toContain('Seminole County');
    }
  });

  it('refuses when the model claims a place but names none', () => {
    const result = groundNlqQuery(
      draft({ locationMode: 'place', place: '   ' }),
      context('old roofs over there'),
      NOW,
    );
    expect(result.status).toBe('refused');
  });
});

describe('locating the search', () => {
  it('resolves a gazetteer place and assumes a near-place radius', () => {
    const query = ground('old roofs in Sanford', { locationMode: 'place', place: 'Sanford' });
    expect(query.centerLabel).toBe('Sanford, FL 32771');
    expect(query.center).toEqual({ latitude: 28.8003, longitude: -81.2731 });
    expect(query.radiusMiles).toBe(NEAR_PLACE_RADIUS_MILES);
    expect(query.locationMode).toBe('place');
  });

  it('resolves a county ZIP', () => {
    const query = ground('roofs in 32746', { locationMode: 'place', place: '32746' });
    expect(query.centerLabel).toBe('Lake Mary, FL 32746');
  });

  it('covers the whole county when the question names no location', () => {
    const query = ground('properties that haven’t sold in 20 years');
    expect(query.center).toEqual(SEMINOLE_COUNTY_CENTER);
    expect(query.radiusMiles).toBe(COUNTY_WIDE_RADIUS_MILES);
    expect(query.criteria[0]?.label).toBe('anywhere in Seminole County, FL');
  });

  it('uses the live map centre when the question points at the current view', () => {
    const query = ground('old roofs near me', { locationMode: 'current_map' });
    expect(query.center).toEqual(MAP_CONTEXT.center);
    expect(query.radiusMiles).toBe(MAP_CONTEXT.radiusMiles);
    expect(query.centerLabel).toBe('the current map centre');
  });

  /**
   * The map context is in the prompt so "near here" works, and a model handed a 4-mile radius
   * will sometimes reach for `current_map` on a question with no location in it. Honouring that
   * would shrink a county-wide question to a 4-mile circle with nothing on screen to explain it.
   */
  it('ignores a current-view mode the question never asked for', () => {
    const query = ground('homes with a pool that sold since 2020', {
      locationMode: 'current_map',
      radiusMiles: 4,
    });
    expect(query.center).toEqual(SEMINOLE_COUNTY_CENTER);
    expect(query.radiusMiles).toBe(COUNTY_WIDE_RADIUS_MILES);
  });

  it('takes a radius from the question only when the question states a distance', () => {
    expect(
      ground('roofs within 8 miles of Oviedo', {
        locationMode: 'place',
        place: 'Oviedo',
        radiusMiles: 8,
      }).radiusMiles,
    ).toBe(8);

    // Same draft, no distance in the question: the model echoed the map's radius back.
    expect(
      ground('roofs in Oviedo', {
        locationMode: 'place',
        place: 'Oviedo',
        radiusMiles: 4,
      }).radiusMiles,
    ).toBe(NEAR_PLACE_RADIUS_MILES);
  });

  it('clamps a radius beyond the county to the search limit', () => {
    expect(ground('everything within 400 miles', { radiusMiles: 400 }).radiusMiles).toBe(
      COUNTY_WIDE_RADIUS_MILES,
    );
  });

  it('describes a stated county-centre radius as a radius, not as the whole county', () => {
    const query = ground('anything within 2 miles', { radiusMiles: 2 });
    expect(query.radiusMiles).toBe(2);
    expect(query.criteria[0]?.label).toBe('within 2 miles of the Seminole County centre');
  });
});

describe('filters a question did not ask for', () => {
  /**
   * The app defaults to a 15-year roof threshold, which is right for someone who opened the
   * map looking for roofing work and wrong for a question about sale history: it would drop
   * every newer-roofed parcel and make the reported count a quiet lie.
   */
  it('applies no roof-age threshold to a question that never mentions roofs', () => {
    const query = ground('properties that haven’t sold in 20 years', { minYearsSinceLastSale: 20 });
    expect(query.filters.minRoofAgeYears).toBe(0);
    expect(
      criterionKeys('properties that haven’t sold in 20 years', {
        minYearsSinceLastSale: 20,
      }),
    ).toEqual(['location', 'years_since_sale', 'sort']);
  });

  it('leaves every unmentioned filter off', () => {
    const query = ground('old roofs in Sanford', {
      locationMode: 'place',
      place: 'Sanford',
      minRoofAgeYears: 20,
    });
    expect(query.filters).toMatchObject({
      minRoofAgeYears: 20,
      permitStatus: 'any',
      minPermitOpenYears: 0,
      minYearsSinceLastSale: 0,
      outOfAreaOwnerOnly: false,
      poolStatus: 'any',
      soldSinceYear: 0,
      minJustValue: 0,
      propertyTypes: [],
    });
  });

  it('defaults to closest-first ordering', () => {
    expect(ground('old roofs', { minRoofAgeYears: 20 }).sort).toBe('distance');
  });
});

describe('unknown roof age', () => {
  /** ~10.6% of the county has no build year. A threshold silently dropping them is the bug. */
  it('states the exclusion whenever a roof-age threshold is applied', () => {
    const query = ground('roofs over 20 years old', { minRoofAgeYears: 20 });
    expect(query.filters.includeUnknownRoofAge).toBe(false);
    expect(query.notes.join(' ')).toContain('no recorded build year');
    expect(query.notes.join(' ')).toContain('excluded');
  });

  it('states the inclusion when the question implies unbuilt parcels count', () => {
    const query = ground('roofs over 20 years old including parcels with no build year', {
      minRoofAgeYears: 20,
      includeUnknownRoofAge: true,
    });
    expect(query.filters.includeUnknownRoofAge).toBe(true);
    expect(query.notes.join(' ')).toContain('included');
  });

  it('says the flag did nothing when there is no threshold for it to act on', () => {
    const query = ground('every parcel including unknowns', { includeUnknownRoofAge: true });
    expect(query.filters.minRoofAgeYears).toBe(0);
    expect(query.notes.join(' ')).toContain('No roof-age threshold');
  });
});

describe('contradictory sale filters', () => {
  /**
   * "Long held" and "recently sold" cannot both hold. Applying both returns zero rows, which
   * reads as a data fault rather than as a badly posed question.
   */
  it('keeps the long-held filter, drops the recency filter, and says so', () => {
    const query = ground('long-held homes that sold since 2020', {
      minYearsSinceLastSale: 20,
      soldSinceYear: 2020,
    });
    expect(query.filters.minYearsSinceLastSale).toBe(20);
    expect(query.filters.soldSinceYear).toBe(0);
    expect(query.criteria.map((criterion) => criterion.key)).not.toContain('sold_since');
    expect(query.notes.join(' ')).toContain('cannot both be true');
  });
});

describe('clamping and normalising', () => {
  it('clamps a roof age beyond the control’s range', () => {
    expect(
      ground('roofs over 900 years old', { minRoofAgeYears: 900 }).filters.minRoofAgeYears,
    ).toBe(70);
  });

  it('rounds a fractional threshold to whole years', () => {
    expect(ground('roofs over 17.6 years', { minRoofAgeYears: 17.6 }).filters.minRoofAgeYears).toBe(
      18,
    );
  });

  it('clamps a future sale year to this year', () => {
    expect(ground('sold since 2099', { soldSinceYear: 2099 }).filters.soldSinceYear).toBe(2026);
  });

  it('discards a property-type list covering every type', () => {
    const query = ground('all property types', {
      propertyTypes: [
        'single_family',
        'condo',
        'townhouse',
        'mobile_home',
        'multi_family',
        'commercial',
        'vacant',
      ],
    });
    expect(query.filters.propertyTypes).toEqual([]);
    expect(query.criteria.map((criterion) => criterion.key)).not.toContain('property_type');
  });

  it('de-duplicates a repeated property type', () => {
    expect(ground('condos', { propertyTypes: ['condo', 'condo'] }).filters.propertyTypes).toEqual([
      'condo',
    ]);
  });

  /** A zero threshold means "not asked for", so it must not produce a criterion chip. */
  it('treats a zero threshold as unset', () => {
    expect(criterionKeys('anything', { minRoofAgeYears: 0, minJustValue: 0 })).toEqual([
      'location',
      'sort',
    ]);
  });
});

describe('the echoed interpretation', () => {
  /**
   * The labels are built from the resolved filters rather than from the model's prose, which is
   * what makes the echo an audit trail instead of a second opinion.
   */
  it('names every applied criterion in the operator’s own vocabulary', () => {
    const query = ground('houses near Lake Mary with roofs over 20 years old', {
      locationMode: 'place',
      place: 'Lake Mary',
      minRoofAgeYears: 20,
      propertyTypes: ['single_family', 'condo', 'townhouse', 'mobile_home', 'multi_family'],
      sort: 'roof_age',
    });

    expect(query.criteria).toEqual([
      { key: 'location', label: 'within 5 miles of Lake Mary, FL 32746' },
      { key: 'roof_age', label: 'roof age at least 20 years' },
      { key: 'property_type', label: 'residential property only' },
      { key: 'sort', label: 'oldest roof first' },
    ]);
  });

  it('describes the money and ownership filters as amounts, not codes', () => {
    const query = ground('out-of-area owners with high value properties', {
      outOfAreaOwnerOnly: true,
      minJustValue: 400_000,
      sort: 'just_value',
    });
    expect(query.criteria.map((criterion) => criterion.label)).toEqual([
      'anywhere in Seminole County, FL',
      'owner mails outside Seminole County',
      'just value at least $400,000',
      'highest just value first',
    ]);
  });

  it('describes the permit filters', () => {
    const query = ground('roofing permits open more than 3 years', {
      permitStatus: 'roofing_unresolved',
      minPermitOpenYears: 3,
    });
    expect(query.criteria.map((criterion) => criterion.label)).toContain(
      'has an unresolved roofing permit',
    );
    expect(query.criteria.map((criterion) => criterion.label)).toContain(
      'a permit open at least 3 years',
    );
  });

  /** The predicate is `>=`, so the label must say "at least" and not "over". */
  it('states the comparison the search actually runs', () => {
    const query = ground('roofs over 20 years old', { minRoofAgeYears: 20 });
    const label = query.criteria.find((criterion) => criterion.key === 'roof_age')?.label;
    expect(label).toBe('roof age at least 20 years');
  });
});

describe('formatNlqSummary', () => {
  it('joins the applied criteria and reports the measured count', () => {
    const query = ground('houses near Lake Mary with roofs over 20 years old', {
      locationMode: 'place',
      place: 'Lake Mary',
      minRoofAgeYears: 20,
      outOfAreaOwnerOnly: true,
    });
    expect(formatNlqSummary(query.criteria, 34)).toBe(
      'Within 5 miles of Lake Mary, FL 32746, roof age at least 20 years, owner mails outside Seminole County — 34 matches.',
    );
  });

  /** Sort order is not a filter, so it must not appear as one in the count sentence. */
  it('leaves the sort out of the applied criteria', () => {
    const query = ground('old roofs', { minRoofAgeYears: 20, sort: 'roof_age' });
    expect(formatNlqSummary(query.criteria, 1)).not.toContain('oldest roof first');
  });

  it('reports an empty result as a count rather than as nothing', () => {
    const query = ground('old roofs', { minRoofAgeYears: 20 });
    expect(formatNlqSummary(query.criteria, 0)).toContain('0 matches');
  });

  it('agrees in number with a single match', () => {
    const query = ground('old roofs', { minRoofAgeYears: 20 });
    expect(formatNlqSummary(query.criteria, 1)).toContain('1 match.');
  });
});

describe('the deterministic question readers', () => {
  it.each([
    'old roofs near me',
    'what is in this area',
    'stalled permits on the map',
    'high value homes nearby',
    'anything in the current view',
  ])('reads %s as a question about the current view', (question) => {
    expect(mentionsCurrentView(question)).toBe(true);
  });

  it.each([
    'old roofs in Sanford',
    'properties that haven’t sold in 20 years',
    'homes with a pool that sold since 2020',
  ])('reads %s as not about the current view', (question) => {
    expect(mentionsCurrentView(question)).toBe(false);
  });

  it.each(['within 5 miles of Lake Mary', '2mi from Oviedo', 'inside 10 kilometres'])(
    'reads a distance out of %s',
    (question) => {
      expect(statesDistance(question)).toBe(true);
    },
  );

  it.each(['old roofs in Sanford', 'roofs over 20 years old', 'sold since 2020'])(
    'reads no distance out of %s',
    (question) => {
      expect(statesDistance(question)).toBe(false);
    },
  );
});
