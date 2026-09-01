/**
 * The Zod schema the model is constrained to, and the normaliser that turns whatever it
 * returns into the shared {@link NlqQueryDraft}.
 *
 * This is the whole safety story for the model call: `generateObject` will not return until
 * the model has produced something this schema accepts, so nothing downstream ever handles
 * free-form text.
 *
 * Fields are `nullish` rather than `nullable` for a measured reason: asked for a filter the
 * question does not mention, Bedrock's Nova models omit the key entirely instead of writing
 * `null`. Both mean "the question did not say", so rejecting one of them would be a
 * provider-shaped failure rather than a real one. {@link normaliseNlqDraft} collapses the two
 * into `null` so the grounding step has exactly one absent value to reason about.
 *
 * `null` stays distinct from `0` throughout: "the question did not mention roof age" and
 * "the question asked for a zero-year threshold" must not be the same input.
 */

import {
  NLQ_LOCATION_MODES,
  PERMIT_FILTER_MODES,
  POOL_FILTER_MODES,
  PROPERTY_TYPES,
  SEARCH_SORTS,
  type NlqQueryDraft,
} from '@roofing-crm/shared';
import { z } from 'zod';

export const nlqQueryDraftSchema = z.object({
  intent: z
    .enum(['property_search', 'out_of_scope'])
    .nullish()
    .describe(
      'property_search when the question can be expressed as a filter over Seminole County parcels and permits. out_of_scope for anything else, including questions about other counties, general knowledge, chit-chat, or data this CRM does not hold.',
    ),
  refusalReason: z
    .string()
    .nullish()
    .describe(
      'When intent is out_of_scope, one plain sentence naming what cannot be answered and why. Null otherwise.',
    ),
  locationMode: z
    .enum(NLQ_LOCATION_MODES)
    .nullish()
    .describe(
      'place when the question names a town, neighbourhood, or ZIP. current_map when it says "here", "this area", or "on screen". county when it names no location at all.',
    ),
  place: z
    .string()
    .nullish()
    .describe(
      'The place named in the question, copied as written, or a five-digit ZIP. Null unless locationMode is place. Never invent coordinates.',
    ),
  radiusMiles: z
    .number()
    .nullish()
    .describe('Radius in miles if the question states a distance. Null otherwise.'),
  minRoofAgeYears: z
    .number()
    .nullish()
    .describe(
      'Minimum roof age in years. Set this ONLY when the question is about roofs or roof age. "old roofs" with no number means 20. Null when roofs are not mentioned — do not apply a roof filter to a question that did not ask for one.',
    ),
  includeUnknownRoofAge: z
    .boolean()
    .nullish()
    .describe(
      'True only when the question implies parcels with no building should count, e.g. it asks about vacant land or says "including unknown". Null otherwise.',
    ),
  permitStatus: z
    .enum(PERMIT_FILTER_MODES)
    .nullish()
    .describe(
      'unresolved for any open permit, roofing_unresolved for an open roofing permit specifically, none for parcels with no permit history, any or null for no permit constraint.',
    ),
  minPermitOpenYears: z
    .number()
    .nullish()
    .describe('Minimum years an unresolved permit has been open, when the question says so.'),
  minYearsSinceLastSale: z
    .number()
    .nullish()
    .describe(
      'Minimum years since the last recorded sale. Use for "has not sold in N years" or "owned for over N years".',
    ),
  soldSinceYear: z
    .number()
    .nullish()
    .describe(
      'Four-digit year for "sold since YYYY" or "sold in the last N years". The opposite of minYearsSinceLastSale — never set both.',
    ),
  outOfAreaOwnerOnly: z
    .boolean()
    .nullish()
    .describe(
      'True for absentee owners: "out of area", "out of state", "owner lives elsewhere", "investor owned".',
    ),
  poolStatus: z
    .enum(POOL_FILTER_MODES)
    .nullish()
    .describe('with_pool or without_pool when the question mentions a pool.'),
  minJustValue: z
    .number()
    .nullish()
    .describe(
      'Minimum total just value in dollars. For a vague "high value" or "expensive" with no figure, use 400000.',
    ),
  propertyTypes: z
    .array(z.enum(PROPERTY_TYPES))
    .nullish()
    .describe(
      'Restrict to these types. "house", "home", or "residential" means the five residential types. Null for no restriction.',
    ),
  sort: z
    .enum(SEARCH_SORTS)
    .nullish()
    .describe(
      'just_value when the question is about value, roof_age when about the oldest roofs, permit_age when about the longest-stalled permits, otherwise distance or null.',
    ),
});

export type NlqQueryDraftInput = z.infer<typeof nlqQueryDraftSchema>;

/**
 * Collapses absent and null into null.
 *
 * The declared return type is the shared contract, so the compiler requires every field to
 * be accounted for here — a filter added to `NlqQueryDraft` without a line in this function
 * fails `tsc` rather than arriving as `undefined` at runtime.
 */
export function normaliseNlqDraft(raw: NlqQueryDraftInput): NlqQueryDraft {
  const refusalReason = raw.refusalReason?.trim() || null;

  return {
    /**
     * A model that omits `intent` has still told us which branch it is on: a refusal reason
     * without an intent is a refusal, and anything else is a search. Guessing `property_search`
     * unconditionally would turn a refusal into a silent county-wide query.
     */
    intent: raw.intent ?? (refusalReason ? 'out_of_scope' : 'property_search'),
    refusalReason,
    locationMode: raw.locationMode ?? (raw.place?.trim() ? 'place' : 'county'),
    place: raw.place?.trim() || null,
    radiusMiles: raw.radiusMiles ?? null,
    minRoofAgeYears: raw.minRoofAgeYears ?? null,
    includeUnknownRoofAge: raw.includeUnknownRoofAge ?? null,
    permitStatus: raw.permitStatus ?? null,
    minPermitOpenYears: raw.minPermitOpenYears ?? null,
    minYearsSinceLastSale: raw.minYearsSinceLastSale ?? null,
    soldSinceYear: raw.soldSinceYear ?? null,
    outOfAreaOwnerOnly: raw.outOfAreaOwnerOnly ?? null,
    poolStatus: raw.poolStatus ?? null,
    minJustValue: raw.minJustValue ?? null,
    propertyTypes: raw.propertyTypes ?? null,
    sort: raw.sort ?? null,
  };
}
