/**
 * The property and permit contract. This module is the single source of truth for the
 * shape of a property record, and every field name below is the name the Oracle
 * ingestion pipeline emits — the API, the fixture data source that stands in for the
 * pipeline today, and the SPA all read these names verbatim.
 *
 * Two fields are derived rather than ingested: `geohash5` (bucket for radius search)
 * and `roof_age_years` (the lead signal the whole product is built around). They are
 * computed once at the data-source boundary so no consumer re-derives them differently.
 */

import { GEOHASH_PRECISION, encodeGeohash } from './geo';
import {
  type PermitIdentity,
  type PermitStatus,
  PERMIT_STATUS_FACTS,
  isSignedOffPermitStatus,
  isUnresolvedPermitStatus,
} from './permits';
import { nearestPlace } from './seminole';

export const PROPERTY_TYPES = [
  'single_family',
  'condo',
  'townhouse',
  'mobile_home',
  'multi_family',
  'commercial',
  'vacant',
] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface PermitRecord extends PermitIdentity {
  /** Application-type dropdown code, e.g. `R100`. Drives `is_roofing`. */
  application_type_code: string | null;
  /** `PermitType` column code, a separate vocabulary, e.g. `RR REROOF`. */
  permit_type_code: string | null;
  permit_type: string;
  description: string;
  status: PermitStatus;
  issued_date: string;
  /**
   * The terminal inspection's Result Date. The source has no explicit close date, so this
   * is null while a permit is unresolved *and* can be null on resolved work whose terminal
   * inspection was not captured.
   */
  closed_date: string | null;
  contractor_name: string | null;
  contractor_license: string | null;
  /**
   * BBB letter grade for the contractor, or null when the enrichment source had no
   * match. Consumers MUST render the absence explicitly rather than hiding the row —
   * "no BBB record" is itself a signal a roofing salesperson wants to see.
   */
  bbb_rating: string | null;
  bbb_score: number | null;
  bbb_accredited: boolean | null;
  valuation: number | null;
  /** True when the permit is roofing work, which is what drives roof-age derivation. */
  is_roofing: boolean;
}

/**
 * Ingested fields, plus the two derived ones. Names match the pipeline output exactly.
 *
 * Nullability is measured against the real ingested dataset (181,218 parcels), not
 * guessed. `latitude` and `longitude` have 100% coverage and are therefore non-null, which
 * is what lets `propertyDisplay` always produce a locality for an unaddressed parcel. The
 * valuation fields had zero misses in that snapshot but stay nullable: "none missing today"
 * is not a schema guarantee, and the UI already renders absence.
 */
export interface PropertyRecord {
  parcel_id: string;
  /** Absent on ~0.8% of parcels. */
  owner_name: string | null;
  /**
   * Absent on ~9.1% of parcels — roughly one in eleven, so it lands on the first page of
   * many searches. Never render this raw; use `propertyDisplay` for a titled fallback.
   */
  primary_address: string | null;
  mailing_city_state_zip: string;
  property_type: PropertyType;
  year_built: number | null;
  last_sale_date: string | null;
  last_sale_amount: number | null;
  total_just_value: number | null;
  assessed_value: number | null;
  taxable_value: number | null;
  total_living_area: number | null;
  total_bedrooms: number | null;
  total_bathrooms: number | null;
  has_pool: boolean;
  latitude: number;
  longitude: number;
  /** Derived: {@link encodeGeohash} at precision {@link GEOHASH_PRECISION}. */
  geohash5: string;
  /** Derived: {@link deriveRoofAgeYears}. Null when neither a roof permit nor a build year is known. */
  roof_age_years: number | null;
}

/** A property joined to its permit history. What the detail panel renders. */
export interface PropertyDetail extends PropertyRecord {
  permits: PermitRecord[];
}

/** A search hit. `distance_miles` is the exact haversine distance from the search centre. */
export interface PropertySearchItem extends PropertyDetail {
  distance_miles: number;
}

/**
 * Seminole County, FL municipalities and ZIPs. An owner whose mailing address falls
 * outside this set is an out-of-area owner, which is the absentee-landlord signal.
 */
export const SEMINOLE_COUNTY_CITIES: readonly string[] = [
  'SANFORD',
  'ALTAMONTE SPRINGS',
  'LAKE MARY',
  'LONGWOOD',
  'CASSELBERRY',
  'WINTER SPRINGS',
  'OVIEDO',
  'GENEVA',
  'CHULUOTA',
  'FERN PARK',
  'HEATHROW',
  'MAITLAND',
  'APOPKA',
  'GOLDENROD',
];

export const SEMINOLE_COUNTY_ZIPS: readonly string[] = [
  '32701',
  '32703',
  '32707',
  '32708',
  '32714',
  '32730',
  '32732',
  '32746',
  '32750',
  '32765',
  '32766',
  '32771',
  '32773',
  '32779',
  '32792',
];

export interface PropertyDisplay {
  /** Never empty. The address when the county has one, otherwise a parcel-id title. */
  title: string;
  /** Locality derived from the parcel's coordinates, shown alongside a fallback title. */
  locality: string | null;
  /** True when the county holds no address for this parcel. */
  isAddressMissing: boolean;
  owner: string;
  isOwnerMissing: boolean;
}

export const NO_ADDRESS_ON_RECORD = 'No address on record';
export const NO_OWNER_ON_RECORD = 'Owner not on record';

/**
 * What to put on a property card.
 *
 * About one parcel in eleven has no `primary_address`, and these are legitimate records —
 * mostly vacant and unaddressed land — so they are shown rather than filtered out. A blank
 * card title would read as a rendering fault, so an unaddressed parcel is titled by its
 * parcel id and located by the nearest municipality, derived from the coordinates that the
 * dataset guarantees are present.
 */
export function propertyDisplay(
  property: Pick<
    PropertyRecord,
    'parcel_id' | 'primary_address' | 'owner_name' | 'latitude' | 'longitude'
  >,
): PropertyDisplay {
  const address = property.primary_address?.trim();
  const owner = property.owner_name?.trim();
  const isAddressMissing = !address;

  return {
    title: address || `Parcel ${property.parcel_id}`,
    locality: isAddressMissing ? nearestPlace(property).label : null,
    isAddressMissing,
    owner: owner || NO_OWNER_ON_RECORD,
    isOwnerMissing: !owner,
  };
}

export function yearsBetween(fromIso: string, now: Date): number {
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return 0;
  return (now.getTime() - from) / (365.2425 * 24 * 60 * 60 * 1000);
}

/**
 * How long a permit has been unresolved. Resolved permits return 0 so an "open for at
 * least N years" filter never matches one. Uses `counts_toward_open_duration` from the
 * county's own status config rather than a second opinion about which statuses are open.
 */
export function permitOpenYears(permit: PermitRecord, now: Date): number {
  if (!PERMIT_STATUS_FACTS[permit.status].countsTowardOpenDuration) return 0;
  return Math.max(0, yearsBetween(permit.issued_date, now));
}

export type PermitDurationState = 'open' | 'resolved' | 'unrecorded' | 'void';

export interface PermitDuration {
  state: PermitDurationState;
  /** Elapsed years for open work, time-to-resolution for resolved work, else null. */
  years: number | null;
  /** Terminal inspection result date, when one was captured. */
  resolvedOn: string | null;
}

/**
 * Open duration, accounting for the source having no explicit close date.
 *
 * A resolved permit whose terminal inspection was never captured has no measurable
 * duration. That is `unrecorded`, not zero — reporting "0 years" for it would invent a
 * same-day turnaround that the county never recorded.
 */
export function permitDuration(permit: PermitRecord, now: Date): PermitDuration {
  if (isUnresolvedPermitStatus(permit.status)) {
    return {
      state: 'open',
      years: Math.max(0, yearsBetween(permit.issued_date, now)),
      resolvedOn: null,
    };
  }

  if (PERMIT_STATUS_FACTS[permit.status].lifecycle === 'void') {
    return { state: 'void', years: null, resolvedOn: null };
  }

  if (!permit.closed_date) {
    return { state: 'unrecorded', years: null, resolvedOn: null };
  }

  return {
    state: 'resolved',
    years: Math.max(0, yearsBetween(permit.issued_date, new Date(permit.closed_date))),
    resolvedOn: permit.closed_date,
  };
}

/**
 * Roof age in whole years.
 *
 * A signed-off roofing permit resets the clock — that is the roof that is on the house
 * now. Otherwise the roof is assumed to be original to the structure. Two statuses
 * deliberately do NOT reset it: an unresolved permit, because the work was never certified
 * complete, and a voided permit, because the work never happened.
 *
 * Null for the ~10.6% of parcels with no `year_built` and no signed-off roof permit —
 * overwhelmingly vacant land. Callers must decide explicitly what to do with those; see
 * `PropertyFilters.includeUnknownRoofAge`.
 */
export function deriveRoofAgeYears(
  property: Pick<PropertyRecord, 'year_built'>,
  permits: readonly PermitRecord[],
  now: Date,
): number | null {
  const reroofDates = permits
    .filter((permit) => permit.is_roofing && isSignedOffPermitStatus(permit.status))
    // No explicit close date in the source, so fall back to the application date.
    .map((permit) => permit.closed_date ?? permit.issued_date);

  if (reroofDates.length > 0) {
    const newest = reroofDates.reduce((a, b) => (a > b ? a : b));
    return Math.max(0, Math.floor(yearsBetween(newest, now)));
  }

  if (property.year_built === null) return null;
  return Math.max(0, now.getUTCFullYear() - property.year_built);
}

export function isOutOfAreaOwner(mailingCityStateZip: string): boolean {
  const upper = mailingCityStateZip.toUpperCase();
  const zip = upper.match(/\b(\d{5})\b/)?.[1];
  if (zip && SEMINOLE_COUNTY_ZIPS.includes(zip)) return false;
  return !SEMINOLE_COUNTY_CITIES.some((city) => upper.includes(city));
}

export function computeGeohash5(property: Pick<PropertyRecord, 'latitude' | 'longitude'>): string {
  return encodeGeohash(property.latitude, property.longitude, GEOHASH_PRECISION);
}

export const PERMIT_FILTER_MODES = ['any', 'unresolved', 'roofing_unresolved', 'none'] as const;

export type PermitFilterMode = (typeof PERMIT_FILTER_MODES)[number];

export const POOL_FILTER_MODES = ['any', 'with_pool', 'without_pool'] as const;

export type PoolFilterMode = (typeof POOL_FILTER_MODES)[number];

/**
 * Property types a salesperson means by "house" or "home". Used to turn that word into a
 * predicate rather than leaving it as an unenforced adjective.
 */
export const RESIDENTIAL_PROPERTY_TYPES: readonly PropertyType[] = [
  'single_family',
  'condo',
  'townhouse',
  'mobile_home',
  'multi_family',
];

/** Result orderings the search supports. Part of the contract so the UI can offer them. */
export const SEARCH_SORTS = ['distance', 'roof_age', 'permit_age', 'just_value'] as const;

export type SearchSort = (typeof SEARCH_SORTS)[number];

export interface PropertyFilters {
  /** Roof age threshold in years. The assignment's default is 15. */
  minRoofAgeYears: number;
  /**
   * What a roof-age threshold does to a parcel whose roof age is unknown.
   *
   * Roughly 10.6% of the county has no `year_built`, so this is not a rounding error —
   * leaving it implicit would silently drop one parcel in nine and read as a bug. The
   * default is `false`: a roofing crew asking for roofs older than 15 years is asking for
   * roofs, and a parcel with no building does not qualify. The exclusion is surfaced as a
   * count in the results header and is reversible from a checkbox, so the choice is the
   * operator's and its cost is visible.
   */
  includeUnknownRoofAge: boolean;
  permitStatus: PermitFilterMode;
  /** Only match when some unresolved permit has been open at least this long. */
  minPermitOpenYears: number;
  /** Only match when the last recorded sale is at least this old. 0 disables it. */
  minYearsSinceLastSale: number;
  /** Only match properties whose owner mails outside Seminole County. */
  outOfAreaOwnerOnly: boolean;
  poolStatus: PoolFilterMode;
  /**
   * Only match a sale recorded on or after 1 January of this year. 0 disables it.
   *
   * The mirror image of {@link minYearsSinceLastSale} — recent movers rather than long-held
   * stock — so setting both is contradictory and callers are expected to pick one.
   */
  soldSinceYear: number;
  /** Only match properties whose total just value is at least this many dollars. 0 disables it. */
  minJustValue: number;
  /**
   * Restrict to these property types. Empty means every type.
   *
   * Mutable rather than `readonly` because this shape crosses the tRPC boundary in both
   * directions, and a readonly array cannot satisfy the Zod schema that validates it.
   */
  propertyTypes: PropertyType[];
}

export const DEFAULT_PROPERTY_FILTERS: PropertyFilters = {
  minRoofAgeYears: 15,
  includeUnknownRoofAge: false,
  permitStatus: 'any',
  minPermitOpenYears: 0,
  minYearsSinceLastSale: 0,
  outOfAreaOwnerOnly: false,
  poolStatus: 'any',
  soldSinceYear: 0,
  minJustValue: 0,
  propertyTypes: [],
};

export const DEFAULT_RADIUS_MILES = 3;

/**
 * Single predicate both the API and its tests apply, so a filter can never mean one
 * thing on the server and another in a test fixture.
 */
export function matchesFilters(
  property: PropertyDetail,
  filters: PropertyFilters,
  now: Date,
): boolean {
  if (filters.minRoofAgeYears > 0) {
    if (property.roof_age_years === null) {
      if (!filters.includeUnknownRoofAge) return false;
    } else if (property.roof_age_years < filters.minRoofAgeYears) {
      return false;
    }
  }

  const unresolved = property.permits.filter((permit) => isUnresolvedPermitStatus(permit.status));

  switch (filters.permitStatus) {
    case 'unresolved':
      if (unresolved.length === 0) return false;
      break;
    case 'roofing_unresolved':
      if (!unresolved.some((permit) => permit.is_roofing)) return false;
      break;
    case 'none':
      if (property.permits.length > 0) return false;
      break;
    case 'any':
      break;
  }

  if (filters.minPermitOpenYears > 0) {
    const longest = unresolved.reduce(
      (max, permit) => Math.max(max, permitOpenYears(permit, now)),
      0,
    );
    if (longest < filters.minPermitOpenYears) return false;
  }

  if (filters.minYearsSinceLastSale > 0) {
    if (property.last_sale_date === null) return false;
    if (yearsBetween(property.last_sale_date, now) < filters.minYearsSinceLastSale) return false;
  }

  if (filters.outOfAreaOwnerOnly && !isOutOfAreaOwner(property.mailing_city_state_zip)) {
    return false;
  }

  if (filters.poolStatus === 'with_pool' && !property.has_pool) return false;
  if (filters.poolStatus === 'without_pool' && property.has_pool) return false;

  if (filters.soldSinceYear > 0) {
    // A parcel with no recorded sale date cannot be shown to have sold in the window. The
    // sale date is missing on ~13% of parcels, so this excludes rather than guesses.
    if (property.last_sale_date === null) return false;
    if (saleYear(property.last_sale_date) < filters.soldSinceYear) return false;
  }

  if (filters.minJustValue > 0 && (property.total_just_value ?? 0) < filters.minJustValue) {
    return false;
  }

  if (filters.propertyTypes.length > 0 && !filters.propertyTypes.includes(property.property_type)) {
    return false;
  }

  return true;
}

/** Calendar year of an ISO sale date. Returns 0 for an unparseable value so it cannot match. */
function saleYear(isoDate: string): number {
  const year = Number.parseInt(isoDate.slice(0, 4), 10);
  return Number.isFinite(year) ? year : 0;
}
