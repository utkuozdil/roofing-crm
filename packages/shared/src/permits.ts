/**
 * Seminole County permit vocabulary.
 *
 * Transcribed from the Oracle pipeline's `docs/seminole-sources.yaml`, which is the
 * authority for these codes. No permits are ingested yet, but the vocabulary is settled,
 * so the CRM classifies roofing work and canonicalises status itself rather than waiting
 * for the harvest — and does it from the real codes rather than an invented enum that
 * would have to be migrated later.
 *
 * Three properties of the source shape the model here:
 *
 *   1. There is no explicit close date. A permit's resolution date is the terminal
 *      inspection's Result Date, so `closed_date` can be absent even on resolved work.
 *      See `permitDuration` — "resolved, duration not recorded" is a real state and must
 *      not be rendered as zero.
 *   2. Application numbers are not unique. The natural key is
 *      `(AppNo, StructureSequence, PermitTypeSequence)` — see `permitNaturalKey`.
 *   3. The active type vocabulary drifts. `EZRO` returned 211 rows for 2022-10 and zero
 *      for 2026-08, and the hurricane codes are event-driven. Every roofing code is
 *      therefore classified regardless of whether it is currently in use.
 */

/**
 * Canonical permit lifecycle.
 *
 * `open` means the work is unresolved and counts toward open duration — the lead signal.
 * `void` is deliberately distinct from `closed`: voided work never happened, so it must
 * not reset a roof's age the way a signed-off reroof does.
 */
export type PermitLifecycle = 'open' | 'closed' | 'void' | 'unknown';

export const PERMIT_STATUSES = [
  'pre_issuance',
  'blocked',
  'active',
  'complete',
  'closed',
  'void',
  'unknown',
] as const;

export type PermitStatus = (typeof PERMIT_STATUSES)[number];

interface StatusFacts {
  lifecycle: PermitLifecycle;
  terminal: boolean;
  /** Mirrors `counts_toward_open_duration` in the source config. */
  countsTowardOpenDuration: boolean;
  label: string;
}

export const PERMIT_STATUS_FACTS: Record<PermitStatus, StatusFacts> = {
  pre_issuance: {
    lifecycle: 'open',
    terminal: false,
    countsTowardOpenDuration: true,
    label: 'In approval — not yet issued',
  },
  blocked: { lifecycle: 'open', terminal: false, countsTowardOpenDuration: true, label: 'On hold' },
  active: {
    lifecycle: 'open',
    terminal: false,
    countsTowardOpenDuration: true,
    label: 'Issued — work open',
  },
  complete: {
    lifecycle: 'closed',
    terminal: true,
    countsTowardOpenDuration: false,
    label: 'Complete',
  },
  closed: { lifecycle: 'closed', terminal: true, countsTowardOpenDuration: false, label: 'Closed' },
  void: { lifecycle: 'void', terminal: true, countsTowardOpenDuration: false, label: 'Voided' },
  unknown: {
    lifecycle: 'unknown',
    terminal: false,
    countsTowardOpenDuration: false,
    label: 'Status not recognised',
  },
};

/**
 * Source status strings observed in the Click2Gov responses, mapped to the canonical
 * status. The source config is explicit that this is a sampled list rather than a
 * documented enumeration, so `mapSeminolePermitStatus` quarantines anything absent
 * instead of bucketing it.
 */
export const SEMINOLE_PERMIT_STATUS_MAPPING: Record<string, PermitStatus> = {
  'IN APPROVAL': 'pre_issuance',
  'ON HOLD': 'blocked',
  'PERMIT ISSUED': 'active',
  'PERMIT COMPLETE': 'complete',
  'CERTIFICATE OF COMPLETION': 'complete',
  CLOSED: 'closed',
  VOIDED: 'void',
};

export interface MappedPermitStatus {
  status: PermitStatus;
  /**
   * True when the raw value was not in the observed vocabulary. The source config's
   * `_unmapped` rule is `alert_and_quarantine`, so a caller must surface this rather than
   * treat the permit as ordinary data.
   */
  quarantine: boolean;
}

export function mapSeminolePermitStatus(raw: string | null | undefined): MappedPermitStatus {
  if (!raw) return { status: 'unknown', quarantine: true };
  const mapped = SEMINOLE_PERMIT_STATUS_MAPPING[raw.trim().toUpperCase()];
  return mapped ? { status: mapped, quarantine: false } : { status: 'unknown', quarantine: true };
}

export function isUnresolvedPermitStatus(status: PermitStatus): boolean {
  return PERMIT_STATUS_FACTS[status].lifecycle === 'open';
}

/** Signed off by the county. Only these reset a roof's age. */
export function isSignedOffPermitStatus(status: PermitStatus): boolean {
  return PERMIT_STATUS_FACTS[status].lifecycle === 'closed';
}

/**
 * The nine application-type codes that mean roof replacement, from `roofing_type_codes`.
 * Labels are carried so the UI can name a code it is shown.
 */
export const SEMINOLE_ROOFING_APPLICATION_TYPES: Record<string, string> = {
  EZRO: 'EZ reroof residential',
  C202: 'Hurricane / commercial reroof',
  R200: 'Hurricane / residential reroof',
  R300: 'Reroof — solar PV shingles',
  C110: 'Reroof commercial',
  R100: 'Reroof residential',
  A998: 'Siding / roof over',
  C998: 'Siding / awnings / aluminium roof / canopy commercial',
  R800: 'Tornado damage / residential',
};

/**
 * Roofing codes from the `PermitType` column, which is a *different* vocabulary from the
 * application-type dropdown. Matched on the leading code token of values such as
 * `'RR REROOF'` and `'BPRF BLDG PERMIT/ROOF'`.
 */
export const SEMINOLE_ROOFING_PERMIT_TYPE_CODES: readonly string[] = ['RR', 'BPRF'];

/**
 * Last-resort label match, for a row carrying neither vocabulary's code. Deliberately
 * narrow: it looks for roof *replacement* wording rather than the word "roof", so a roof
 * deck or a roof-mounted mechanical permit is not misread as reroofing work.
 */
const ROOFING_LABEL_PATTERN = /RE-?ROOF|ROOF OVER|AL ROOF|PERMIT\s*\/\s*ROOF/i;

export type RoofingMatchSource = 'application_type' | 'permit_type' | 'label' | 'none';

export interface RoofingClassification {
  is_roofing: boolean;
  /** Which vocabulary decided it. Kept so a surprising classification is auditable. */
  matched_on: RoofingMatchSource;
}

export interface RoofingClassificationInput {
  application_type_code?: string | null;
  permit_type_code?: string | null;
  permit_type?: string | null;
  description?: string | null;
}

/** Derives `is_roofing` from the county's own type vocabularies. */
export function classifyRoofingPermit(input: RoofingClassificationInput): RoofingClassification {
  const applicationCode = input.application_type_code?.trim().toUpperCase();
  if (applicationCode && applicationCode in SEMINOLE_ROOFING_APPLICATION_TYPES) {
    return { is_roofing: true, matched_on: 'application_type' };
  }

  const permitTypeCode = (input.permit_type_code ?? '').trim().toUpperCase().split(/\s+/)[0];
  if (permitTypeCode && SEMINOLE_ROOFING_PERMIT_TYPE_CODES.includes(permitTypeCode)) {
    return { is_roofing: true, matched_on: 'permit_type' };
  }

  const text = [input.permit_type, input.description].filter(Boolean).join(' ');
  if (text && ROOFING_LABEL_PATTERN.test(text)) {
    return { is_roofing: true, matched_on: 'label' };
  }

  return { is_roofing: false, matched_on: 'none' };
}

/**
 * Components of a permit's natural key. An application number alone is not unique — one
 * AppNo covers multiple structures and multiple permit types.
 */
export interface PermitIdentity {
  permit_number: string;
  structure_sequence: number | null;
  permit_type_sequence: number | null;
}

export function permitNaturalKey(permit: PermitIdentity): string {
  return [
    permit.permit_number,
    permit.structure_sequence ?? '_',
    permit.permit_type_sequence ?? '_',
  ].join('/');
}
