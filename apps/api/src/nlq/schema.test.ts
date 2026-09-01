import { describe, expect, it } from 'vitest';
import { nlqQueryDraftSchema, normaliseNlqDraft } from './schema';
import { buildSystemPrompt } from './parse';

/**
 * A minimal but realistic model response: Bedrock's Nova models omit the fields the question
 * did not mention rather than writing `null`, so this is the exact shape that reaches the
 * schema for "houses near Lake Mary with roofs over 20 years old".
 */
const NOVA_STYLE_RESPONSE = {
  intent: 'property_search',
  locationMode: 'place',
  place: 'Lake Mary',
  minRoofAgeYears: 20,
  propertyTypes: ['single_family', 'condo'],
  sort: 'roof_age',
};

describe('nlqQueryDraftSchema', () => {
  /**
   * The measured failure this schema was changed for: with `nullable` fields, every Nova
   * response was rejected for a dozen "expected null, received undefined" errors even though
   * the parse itself was correct.
   */
  it('accepts a response that omits the fields the question did not mention', () => {
    const parsed = nlqQueryDraftSchema.parse(NOVA_STYLE_RESPONSE);
    expect(parsed.place).toBe('Lake Mary');
    expect(parsed.minRoofAgeYears).toBe(20);
  });

  it('accepts an explicit null for the same fields', () => {
    const parsed = nlqQueryDraftSchema.parse({
      ...NOVA_STYLE_RESPONSE,
      radiusMiles: null,
      permitStatus: null,
    });
    expect(parsed.radiusMiles).toBeNull();
  });

  it('rejects a value outside the filter vocabulary', () => {
    expect(() =>
      nlqQueryDraftSchema.parse({ ...NOVA_STYLE_RESPONSE, permitStatus: 'expired' }),
    ).toThrow();
    expect(() =>
      nlqQueryDraftSchema.parse({ ...NOVA_STYLE_RESPONSE, propertyTypes: ['mansion'] }),
    ).toThrow();
    expect(() => nlqQueryDraftSchema.parse({ ...NOVA_STYLE_RESPONSE, sort: 'cheapest' })).toThrow();
  });

  it('rejects a non-numeric threshold rather than coercing it', () => {
    expect(() =>
      nlqQueryDraftSchema.parse({ ...NOVA_STYLE_RESPONSE, minRoofAgeYears: 'twenty' }),
    ).toThrow();
  });
});

describe('normaliseNlqDraft', () => {
  it('collapses absent and null into null', () => {
    const draft = normaliseNlqDraft(nlqQueryDraftSchema.parse(NOVA_STYLE_RESPONSE));
    expect(draft.radiusMiles).toBeNull();
    expect(draft.permitStatus).toBeNull();
    expect(draft.includeUnknownRoofAge).toBeNull();
    expect(draft.minYearsSinceLastSale).toBeNull();
    expect(draft.refusalReason).toBeNull();
  });

  /** `null` and `0` must stay distinct: unset is not the same as a zero threshold. */
  it('preserves a genuine zero', () => {
    const draft = normaliseNlqDraft(
      nlqQueryDraftSchema.parse({ ...NOVA_STYLE_RESPONSE, minRoofAgeYears: 0 }),
    );
    expect(draft.minRoofAgeYears).toBe(0);
  });

  it('treats a whitespace-only place as no place', () => {
    const draft = normaliseNlqDraft(
      nlqQueryDraftSchema.parse({ ...NOVA_STYLE_RESPONSE, place: '   ' }),
    );
    expect(draft.place).toBeNull();
    expect(draft.locationMode).toBe('place');
  });

  /**
   * A refusal that arrives without an `intent` is still a refusal. Defaulting to
   * `property_search` would turn "I can't answer that" into a silent county-wide search.
   */
  it('reads a reason without an intent as a refusal', () => {
    const draft = normaliseNlqDraft(
      nlqQueryDraftSchema.parse({ refusalReason: 'The CRM holds no roof material.' }),
    );
    expect(draft.intent).toBe('out_of_scope');
  });

  it('reads a filter set without an intent as a search', () => {
    const draft = normaliseNlqDraft(nlqQueryDraftSchema.parse({ minRoofAgeYears: 20 }));
    expect(draft.intent).toBe('property_search');
  });

  it('infers the location mode from the presence of a place', () => {
    expect(normaliseNlqDraft(nlqQueryDraftSchema.parse({ place: 'Oviedo' })).locationMode).toBe(
      'place',
    );
    expect(normaliseNlqDraft(nlqQueryDraftSchema.parse({})).locationMode).toBe('county');
  });
});

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt(new Date('2026-09-01T00:00:00.000Z'));

  /**
   * The gazetteer is the only source of coordinates, so the model has to be told which names
   * resolve. Without the list it invents plausible neighbourhoods that then get refused.
   */
  it('lists every place the gazetteer can resolve', () => {
    for (const place of ['Sanford', 'Lake Mary', 'Oviedo', 'Chuluota', 'Goldenrod']) {
      expect(prompt).toContain(place);
    }
  });

  it('states today’s date, so “in the last 5 years” has a reference point', () => {
    expect(prompt).toContain('2026-09-01');
  });

  it('tells the model not to answer the question itself', () => {
    expect(prompt).toContain('never answer the question yourself');
  });
});
