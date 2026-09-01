/**
 * Natural-language query contract.
 *
 * The design decision this module encodes: a salesperson's question is a **structured
 * predicate**, not a semantic-similarity problem. "Roofs over 20 years old within 5 miles
 * of Lake Mary whose owner lives out of state" is exactly `{ center, radiusMiles, filters }`
 * — the shape {@link PropertyFilters} already describes and the radius search already runs.
 *
 * So the language model does one narrow job: read the question and fill in that shape. It
 * never sees a property row, never ranks anything, and never produces the answer. Every
 * returned parcel is one the existing `matchesFilters` predicate admitted, so "34 matches"
 * is a fact about the dataset rather than a claim by a model.
 *
 * The model's output is a {@link NlqQueryDraft}: deliberately loose, all-nullable, and
 * stated in the vocabulary of the question (a place *name*, not coordinates). Turning that
 * draft into a runnable query is {@link groundNlqQuery}, which is pure, deterministic, and
 * fully tested without a model:
 *
 *   - place names resolve through the offline county gazetteer, so the model cannot invent
 *     a latitude;
 *   - every number is clamped to the range the search already validates;
 *   - the human-readable interpretation is derived from the *resolved* filters, not from
 *     the model's prose, which is what makes the echo trustworthy rather than decorative.
 */

import type { GeoPoint } from './geo';
import {
  DEFAULT_RADIUS_MILES,
  PERMIT_FILTER_MODES,
  POOL_FILTER_MODES,
  PROPERTY_TYPES,
  RESIDENTIAL_PROPERTY_TYPES,
  SEARCH_SORTS,
  type PermitFilterMode,
  type PoolFilterMode,
  type PropertyFilters,
  type PropertyType,
  type SearchSort,
} from './property';
import { SEMINOLE_COUNTY_CENTER, SEMINOLE_PLACES, resolveLocationInput } from './seminole';

/**
 * Radius that covers the whole county from its centre, and the cap the search enforces.
 * A question with no place in it is a county-wide question.
 */
export const COUNTY_WIDE_RADIUS_MILES = 25;

export const MAX_RADIUS_MILES = 25;
export const MIN_RADIUS_MILES = 0.5;

/** Radius assumed for "near <place>" when the question does not give one. */
export const NEAR_PLACE_RADIUS_MILES = 5;

export const MAX_QUESTION_LENGTH = 400;

/**
 * How the question located itself. Kept separate from the coordinates so an unresolvable
 * place name fails loudly instead of silently defaulting to the county centre — a search
 * that quietly moved somewhere else would be the worst kind of wrong answer here.
 */
export const NLQ_LOCATION_MODES = ['place', 'county', 'current_map'] as const;

export type NlqLocationMode = (typeof NLQ_LOCATION_MODES)[number];

/**
 * What the model is asked to emit. Every field is nullable and means "the question did not
 * say", which the grounding step turns into an explicit default it can then explain.
 */
export interface NlqQueryDraft {
  /** `out_of_scope` is the refusal path: the question is not a property search. */
  intent: 'property_search' | 'out_of_scope';
  /** Why the question cannot be answered. Required when `intent` is `out_of_scope`. */
  refusalReason: string | null;
  locationMode: NlqLocationMode;
  /** A place name or ZIP from the question, resolved against the county gazetteer. */
  place: string | null;
  radiusMiles: number | null;
  minRoofAgeYears: number | null;
  includeUnknownRoofAge: boolean | null;
  permitStatus: PermitFilterMode | null;
  minPermitOpenYears: number | null;
  minYearsSinceLastSale: number | null;
  soldSinceYear: number | null;
  outOfAreaOwnerOnly: boolean | null;
  poolStatus: PoolFilterMode | null;
  minJustValue: number | null;
  propertyTypes: PropertyType[] | null;
  sort: SearchSort | null;
}

/**
 * The request being grounded: the question itself, plus the live map state it can refer to
 * with "here" or "this area".
 *
 * The question text is part of the grounding input, not just the model input, because
 * whether "the current view" was really meant is decided from the words the operator typed
 * rather than from the mode the model chose. See {@link mentionsCurrentView}.
 */
export interface NlqContext {
  question: string;
  center: GeoPoint;
  radiusMiles: number;
}

/**
 * One applied criterion, in the words a salesperson would use.
 *
 * `key` is stable and machine-readable so the UI can render a chip per criterion and a
 * test can assert on a specific one without matching English.
 */
export interface NlqCriterion {
  key: string;
  label: string;
}

/** A question turned into a runnable query, plus everything needed to explain it. */
export interface GroundedNlqQuery {
  center: GeoPoint;
  /** What the centre was understood to be — "Lake Mary, FL 32746", "Seminole County". */
  centerLabel: string;
  radiusMiles: number;
  filters: PropertyFilters;
  sort: SearchSort;
  locationMode: NlqLocationMode;
  /** Applied criteria, in reading order. Derived from `filters`, never from model prose. */
  criteria: NlqCriterion[];
  /** Caveats the operator must see before trusting the count. */
  notes: string[];
}

export interface NlqRefusal {
  status: 'refused';
  reason: string;
}

export type NlqGroundingResult = { status: 'grounded'; query: GroundedNlqQuery } | NlqRefusal;

/** What the panel offers when it cannot answer, and what it seeds an empty input with. */
export const NLQ_EXAMPLE_QUESTIONS: readonly string[] = [
  'Houses near Lake Mary with roofs over 20 years old',
  'Show me out-of-area owners with high value properties',
  'Properties that haven’t sold in 20 years',
  'Old roofs in Sanford',
  'Homes with a pool that sold since 2020',
  'Open roofing permits stuck for more than 3 years in Oviedo',
];

/**
 * The permit example, dropped when the active dataset carries no permit history.
 *
 * An example question the CRM would refuse is worse than one fewer example: the panel offers
 * these as buttons, so a listed question that cannot be answered reads as a broken feature.
 */
export const NLQ_PERMIT_EXAMPLE = 'Open roofing permits stuck for more than 3 years in Oviedo';

/** Replaces the permit example, so the panel still offers six worked questions. */
export const NLQ_NO_PERMIT_EXAMPLE = 'Condos in Altamonte Springs worth over $250,000';

/** Stated in the refusal so a rejected question tells the operator what would work. */
export const NLQ_CAPABILITIES: readonly string[] = [
  'roof age, including parcels with no recorded build year',
  'distance from a Seminole County city, ZIP, or the current map centre',
  'permit history: unresolved, unresolved roofing, none, and how long one has been open',
  'owner mailing address inside or outside the county',
  'last sale: how long ago, or sold since a given year',
  'just value, pool, and property type',
];

/** The permit capability line, named so it can be withdrawn when permits are unavailable. */
export const NLQ_PERMIT_CAPABILITY =
  'permit history: unresolved, unresolved roofing, none, and how long one has been open';

/**
 * What the panel says it can do, given what the active dataset holds.
 *
 * Withdrawing the permit line rather than leaving it in place matters: the capability list is
 * what a refusal points the operator at, and pointing them at a filter the data cannot support
 * would send them straight into a second refusal.
 */
export function nlqCapabilities(permitsAvailable: boolean): readonly string[] {
  if (permitsAvailable) return NLQ_CAPABILITIES;
  return NLQ_CAPABILITIES.filter((line) => line !== NLQ_PERMIT_CAPABILITY);
}

export function nlqExampleQuestions(permitsAvailable: boolean): readonly string[] {
  if (permitsAvailable) return NLQ_EXAMPLE_QUESTIONS;
  return NLQ_EXAMPLE_QUESTIONS.map((question) =>
    question === NLQ_PERMIT_EXAMPLE ? NLQ_NO_PERMIT_EXAMPLE : question,
  );
}

/** Whether a grounded query leans on permit history at all. */
export function usesPermitHistory(filters: PropertyFilters, sort: SearchSort): boolean {
  return filters.permitStatus !== 'any' || filters.minPermitOpenYears > 0 || sort === 'permit_age';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value);
}

function formatMoney(value: number): string {
  return `$${value.toLocaleString('en-US')}`;
}

const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  single_family: 'single family',
  condo: 'condo',
  townhouse: 'townhouse',
  mobile_home: 'mobile home',
  multi_family: 'multi family',
  commercial: 'commercial',
  vacant: 'vacant land',
};

const PERMIT_CRITERION_LABELS: Record<Exclude<PermitFilterMode, 'any'>, string> = {
  unresolved: 'has an unresolved permit',
  roofing_unresolved: 'has an unresolved roofing permit',
  none: 'no permit history on record',
};

const SORT_CRITERION_LABELS: Record<SearchSort, string> = {
  distance: 'closest first',
  roof_age: 'oldest roof first',
  permit_age: 'longest-open permit first',
  just_value: 'highest just value first',
};

/**
 * Turns a model draft into a query the existing search can run.
 *
 * Pure and synchronous: given the same draft and context it always produces the same
 * query, the same labels, and the same notes. That is what lets the interpretation shown
 * to the operator be tested without a model in the loop.
 */
export function groundNlqQuery(
  draft: NlqQueryDraft,
  context: NlqContext,
  now: Date,
): NlqGroundingResult {
  if (draft.intent === 'out_of_scope') {
    return {
      status: 'refused',
      reason:
        draft.refusalReason?.trim() ||
        'That question is not a property search over Seminole County parcel and permit data.',
    };
  }

  const location = resolveCenter(draft, context);
  if (location.status === 'refused') return location;

  const criteria: NlqCriterion[] = [];
  const notes: string[] = [];

  /**
   * The base is every filter switched **off**, not `DEFAULT_PROPERTY_FILTERS`.
   *
   * The app's 15-year roof-age default is right for someone who opened the map to look for
   * roofing work. It is wrong for "properties that haven't sold in 20 years", where it
   * would silently drop every parcel with a newer roof and make the count a quiet lie. A
   * question gets exactly the filters it asked for, and each one is echoed back.
   */
  const filters: PropertyFilters = {
    minRoofAgeYears: 0,
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

  criteria.push({
    key: 'location',
    label: location.countyWide
      ? `anywhere in ${location.label}`
      : `within ${formatRadius(location.radiusMiles)} of ${location.label}`,
  });

  if (draft.minRoofAgeYears !== null && draft.minRoofAgeYears > 0) {
    filters.minRoofAgeYears = clamp(round(draft.minRoofAgeYears), 0, 70);
    criteria.push({
      key: 'roof_age',
      // "at least", not "over": the predicate is `>=`, and the echo has to describe the
      // comparison that actually ran or it is not an audit trail.
      label: `roof age at least ${filters.minRoofAgeYears} years`,
    });
  }

  /**
   * Roof age is null for the ~10.6% of parcels with no building. When a roof threshold is
   * on, that population is excluded, and requirement is that the answer says so rather
   * than quietly returning a smaller set.
   */
  if (filters.minRoofAgeYears > 0) {
    filters.includeUnknownRoofAge = draft.includeUnknownRoofAge ?? false;
    notes.push(
      filters.includeUnknownRoofAge
        ? 'Parcels with no recorded build year are included, so some rows have no derivable roof age.'
        : 'Parcels with no recorded build year — about one in ten of the county, mostly land with no building — cannot satisfy a roof-age threshold and are excluded.',
    );
  } else if (draft.includeUnknownRoofAge === true) {
    // Nothing to include or exclude without a threshold; saying so avoids implying the
    // flag did something.
    notes.push(
      'No roof-age threshold was applied, so every parcel is in scope regardless of build year.',
    );
  }

  if (draft.permitStatus !== null && draft.permitStatus !== 'any') {
    filters.permitStatus = draft.permitStatus;
    criteria.push({ key: 'permit_status', label: PERMIT_CRITERION_LABELS[draft.permitStatus] });
  }

  if (draft.minPermitOpenYears !== null && draft.minPermitOpenYears > 0) {
    filters.minPermitOpenYears = clamp(round(draft.minPermitOpenYears), 0, 40);
    criteria.push({
      key: 'permit_open_years',
      label: `a permit open at least ${filters.minPermitOpenYears} years`,
    });
  }

  if (draft.minYearsSinceLastSale !== null && draft.minYearsSinceLastSale > 0) {
    filters.minYearsSinceLastSale = clamp(round(draft.minYearsSinceLastSale), 0, 80);
    criteria.push({
      key: 'years_since_sale',
      label: `no sale in the last ${filters.minYearsSinceLastSale} years`,
    });
  }

  if (draft.soldSinceYear !== null && draft.soldSinceYear > 0) {
    filters.soldSinceYear = clamp(round(draft.soldSinceYear), 1900, now.getUTCFullYear());
    criteria.push({ key: 'sold_since', label: `sold since ${filters.soldSinceYear}` });
  }

  /**
   * The two sale filters are opposites. Applying both would return nothing and look like a
   * data problem, so the contradiction is named and the recency filter is dropped.
   */
  if (filters.minYearsSinceLastSale > 0 && filters.soldSinceYear > 0) {
    filters.soldSinceYear = 0;
    const dropped = criteria.findIndex((criterion) => criterion.key === 'sold_since');
    if (dropped !== -1) criteria.splice(dropped, 1);
    notes.push(
      'The question asked for both a long-held property and a recent sale, which cannot both be true. Only the "no recent sale" criterion was applied.',
    );
  }

  if (draft.outOfAreaOwnerOnly === true) {
    filters.outOfAreaOwnerOnly = true;
    criteria.push({
      key: 'out_of_area_owner',
      label: 'owner mails outside Seminole County',
    });
  }

  if (draft.poolStatus !== null && draft.poolStatus !== 'any') {
    filters.poolStatus = draft.poolStatus;
    criteria.push({
      key: 'pool',
      label: draft.poolStatus === 'with_pool' ? 'has a pool' : 'has no pool',
    });
  }

  if (draft.minJustValue !== null && draft.minJustValue > 0) {
    filters.minJustValue = clamp(round(draft.minJustValue), 0, 50_000_000);
    criteria.push({
      key: 'just_value',
      label: `just value at least ${formatMoney(filters.minJustValue)}`,
    });
  }

  const types = normaliseTypes(draft.propertyTypes);
  if (types.length > 0) {
    filters.propertyTypes = types;
    criteria.push({ key: 'property_type', label: describeTypes(types) });
  }

  const sort = draft.sort !== null && SEARCH_SORTS.includes(draft.sort) ? draft.sort : 'distance';
  criteria.push({ key: 'sort', label: SORT_CRITERION_LABELS[sort] });

  return {
    status: 'grounded',
    query: {
      center: location.center,
      centerLabel: location.label,
      radiusMiles: location.radiusMiles,
      filters,
      sort,
      locationMode: location.mode,
      criteria,
      notes,
    },
  };
}

interface ResolvedCenter {
  status: 'resolved';
  center: GeoPoint;
  label: string;
  radiusMiles: number;
  mode: NlqLocationMode;
  /** True when the radius covers the county, so the echo can say "anywhere in" truthfully. */
  countyWide: boolean;
}

/**
 * Whether the question itself states a distance.
 *
 * The map context is put in the prompt so "near here" works, and a model handed a radius of
 * 3 will sometimes copy it back out even for a county-wide question — which would quietly
 * shrink the search to a three-mile circle while the interpretation said "anywhere in
 * Seminole County". A radius is therefore only taken from the model when the operator
 * actually asked for one.
 */
const STATED_DISTANCE_PATTERN = /\b\d+(?:\.\d+)?\s*(?:mi|mile|miles|km|kilometre|kilometer)s?\b/i;

export function statesDistance(question: string): boolean {
  return STATED_DISTANCE_PATTERN.test(question);
}

/**
 * Words that make a question about the current map rather than about the county.
 *
 * Deliberately narrow. Falling back to the map's centre is a 3-mile search by default, so
 * treating a county-wide question as a local one would hide most of the county's leads.
 */
const CURRENT_VIEW_PATTERN =
  /\b(here|nearby|near me|around me|this area|these results|on screen|on the map|current (view|map|area)|where i am|this radius)\b/i;

export function mentionsCurrentView(question: string): boolean {
  return CURRENT_VIEW_PATTERN.test(question);
}

/**
 * Resolves the search centre offline.
 *
 * The gazetteer is the only source of coordinates, so a place the county does not contain
 * is a refusal rather than a silent fallback. Answering a question about Kalamazoo with
 * Seminole County rows would be confidently wrong, which is the failure mode this whole
 * design exists to avoid.
 *
 * The mode is re-derived here rather than taken on trust, because a model that reaches for
 * `current_map` on a question that names no location at all turns a county-wide search into
 * a 3-mile one — same wrong answer, no visible cause. A place name wins outright; the
 * current view is honoured only if the operator's own words asked for it.
 */
function resolveCenter(draft: NlqQueryDraft, context: NlqContext): ResolvedCenter | NlqRefusal {
  const requestedRadius =
    draft.radiusMiles === null || !statesDistance(context.question)
      ? null
      : clamp(draft.radiusMiles, MIN_RADIUS_MILES, MAX_RADIUS_MILES);

  const place = draft.place?.trim();

  if (place) {
    const resolved = resolveLocationInput(place);
    if (!resolved) {
      return {
        status: 'refused',
        reason: `“${place}” is not a place in Seminole County, FL, which is the only county this CRM holds data for. I can search ${SEMINOLE_PLACES.map((entry) => entry.name).join(', ')}, any county ZIP, or coordinates.`,
      };
    }

    return {
      status: 'resolved',
      center: { latitude: resolved.latitude, longitude: resolved.longitude },
      label: resolved.label,
      radiusMiles: requestedRadius ?? NEAR_PLACE_RADIUS_MILES,
      mode: 'place',
      countyWide: false,
    };
  }

  if (draft.locationMode === 'place') {
    return {
      status: 'refused',
      reason: `The question seemed to name a place but I could not read which one. I cover ${SEMINOLE_PLACES.map((entry) => entry.name).join(', ')}, any Seminole County ZIP, or the area currently on the map.`,
    };
  }

  if (draft.locationMode === 'current_map' && mentionsCurrentView(context.question)) {
    return {
      status: 'resolved',
      center: context.center,
      label: 'the current map centre',
      radiusMiles:
        requestedRadius ?? clamp(context.radiusMiles, MIN_RADIUS_MILES, MAX_RADIUS_MILES),
      mode: 'current_map',
      countyWide: false,
    };
  }

  if (requestedRadius !== null) {
    return {
      status: 'resolved',
      center: SEMINOLE_COUNTY_CENTER,
      label: 'the Seminole County centre',
      radiusMiles: requestedRadius,
      mode: 'county',
      countyWide: requestedRadius >= COUNTY_WIDE_RADIUS_MILES,
    };
  }

  return {
    status: 'resolved',
    center: SEMINOLE_COUNTY_CENTER,
    label: 'Seminole County, FL',
    radiusMiles: COUNTY_WIDE_RADIUS_MILES,
    mode: 'county',
    countyWide: true,
  };
}

function normaliseTypes(types: PropertyType[] | null): PropertyType[] {
  if (!types || types.length === 0) return [];
  const valid = types.filter((type) => PROPERTY_TYPES.includes(type));
  // A request for every type is the same as no restriction; keeping it would produce a
  // criterion chip that narrows nothing.
  if (valid.length === PROPERTY_TYPES.length) return [];
  return [...new Set(valid)];
}

/**
 * "residential only" beats listing five type names, which is what "houses" actually means
 * and what the operator would recognise as their own word.
 */
function describeTypes(types: readonly PropertyType[]): string {
  const isResidentialSet =
    types.length === RESIDENTIAL_PROPERTY_TYPES.length &&
    RESIDENTIAL_PROPERTY_TYPES.every((type) => types.includes(type));
  if (isResidentialSet) return 'residential property only';
  return `${types.map((type) => PROPERTY_TYPE_LABELS[type]).join(', ')} only`;
}

function formatRadius(miles: number): string {
  const rounded = Math.round(miles * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'mile' : 'miles'}`;
}

/**
 * The one-line interpretation shown above the results: what was applied, and how many
 * parcels satisfied it. The count comes from the search, so this sentence cannot claim a
 * number the rows do not support.
 */
export function formatNlqSummary(criteria: readonly NlqCriterion[], matched: number): string {
  const applied = criteria
    .filter((criterion) => criterion.key !== 'sort')
    .map((criterion) => criterion.label);
  const clauses = applied.length > 0 ? applied.join(', ') : 'no filters';
  return `${capitalise(clauses)} — ${matched} ${matched === 1 ? 'match' : 'matches'}.`;
}

function capitalise(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/** Kept beside the modes it validates so a new filter mode cannot be forgotten here. */
export const NLQ_FILTER_VOCABULARY = {
  permitStatus: PERMIT_FILTER_MODES,
  poolStatus: POOL_FILTER_MODES,
  propertyTypes: PROPERTY_TYPES,
  sort: SEARCH_SORTS,
  defaultRadiusMiles: DEFAULT_RADIUS_MILES,
} as const;
