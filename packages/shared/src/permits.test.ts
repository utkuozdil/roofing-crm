import { describe, expect, it } from 'vitest';
import {
  PERMIT_STATUS_FACTS,
  SEMINOLE_PERMIT_STATUS_MAPPING,
  SEMINOLE_ROOFING_APPLICATION_TYPES,
  classifyRoofingPermit,
  isSignedOffPermitStatus,
  isUnresolvedPermitStatus,
  mapSeminolePermitStatus,
  permitNaturalKey,
} from './permits';

describe('SEMINOLE_ROOFING_APPLICATION_TYPES', () => {
  /** The source config lists exactly nine roofing codes out of 109 application types. */
  it('carries the nine codes from the county source config', () => {
    expect(Object.keys(SEMINOLE_ROOFING_APPLICATION_TYPES).sort()).toEqual([
      'A998',
      'C110',
      'C202',
      'C998',
      'EZRO',
      'R100',
      'R200',
      'R300',
      'R800',
    ]);
  });
});

describe('classifyRoofingPermit', () => {
  it.each(Object.keys(SEMINOLE_ROOFING_APPLICATION_TYPES))(
    'classifies application type %s as roofing',
    (code) => {
      const result = classifyRoofingPermit({ application_type_code: code });
      expect(result.is_roofing).toBe(true);
      expect(result.matched_on).toBe('application_type');
    },
  );

  /**
   * The vocabulary drifts — EZRO returned 211 rows for 2022-10 and none for 2026-08 — so a
   * code that is dormant today must still classify.
   */
  it('classifies a currently dormant roofing code', () => {
    expect(classifyRoofingPermit({ application_type_code: 'EZRO' }).is_roofing).toBe(true);
  });

  it('is case and whitespace insensitive', () => {
    expect(classifyRoofingPermit({ application_type_code: ' r100 ' }).is_roofing).toBe(true);
  });

  it('falls back to the PermitType vocabulary, which is a different code set', () => {
    const result = classifyRoofingPermit({ permit_type_code: 'RR REROOF' });
    expect(result).toEqual({ is_roofing: true, matched_on: 'permit_type' });
    expect(classifyRoofingPermit({ permit_type_code: 'BPRF BLDG PERMIT/ROOF' }).is_roofing).toBe(
      true,
    );
  });

  it('falls back to label text when no code is present', () => {
    const result = classifyRoofingPermit({ description: 'Residential RE-ROOF, shingle' });
    expect(result).toEqual({ is_roofing: true, matched_on: 'label' });
  });

  it.each([
    ['A980', 'ELECTRIC SOLAR WIRING'],
    ['A979', 'SOLAR-POOL/WTR HTR SPLY'],
    ['A971', 'MECHANICAL - RESIDENTIAL'],
    ['A329', 'POOL ENCLOSURE/BOND'],
    ['A997', 'WINDOW / DOOR REPLACEMENT'],
    ['A330', 'SCREEN ROOM'],
  ])('does not classify %s (%s) as roofing', (code, label) => {
    const result = classifyRoofingPermit({ application_type_code: code, description: label });
    expect(result).toEqual({ is_roofing: false, matched_on: 'none' });
  });

  /**
   * R300 is solar PV *shingles*, which is roof replacement; A980 is solar wiring on an
   * existing roof, which is not. Both mention solar, so the codes have to decide.
   */
  it('separates solar shingles from solar wiring', () => {
    expect(
      classifyRoofingPermit({
        application_type_code: 'R300',
        description: 'REROOF - SOLAR PV SHINGLES',
      }).is_roofing,
    ).toBe(true);
    expect(
      classifyRoofingPermit({
        application_type_code: 'A980',
        description: 'Roof-mounted photovoltaic array, electrical only',
      }).is_roofing,
    ).toBe(false);
  });

  it('does not read a roof-mounted mechanical permit as roofing work', () => {
    expect(
      classifyRoofingPermit({
        application_type_code: 'A971',
        permit_type_code: 'MEC2 MECHANICAL ALL OTHER',
        description: 'Roof-mounted condenser replacement',
      }).is_roofing,
    ).toBe(false);
  });

  it('is not roofing when nothing is known', () => {
    expect(classifyRoofingPermit({})).toEqual({ is_roofing: false, matched_on: 'none' });
  });
});

describe('mapSeminolePermitStatus', () => {
  it.each(Object.entries(SEMINOLE_PERMIT_STATUS_MAPPING))('maps %s to %s', (raw, expected) => {
    expect(mapSeminolePermitStatus(raw)).toEqual({ status: expected, quarantine: false });
  });

  /** The observed list is a sample, not a documented enumeration. */
  it('quarantines a status outside the observed vocabulary', () => {
    expect(mapSeminolePermitStatus('SUSPENDED PENDING REVIEW')).toEqual({
      status: 'unknown',
      quarantine: true,
    });
    expect(mapSeminolePermitStatus(null)).toEqual({ status: 'unknown', quarantine: true });
  });

  it('does not treat an unrecognised status as a lead signal', () => {
    expect(isUnresolvedPermitStatus('unknown')).toBe(false);
    expect(isSignedOffPermitStatus('unknown')).toBe(false);
  });

  it('agrees with the source config on which statuses count toward open duration', () => {
    for (const status of ['pre_issuance', 'blocked', 'active'] as const) {
      expect(PERMIT_STATUS_FACTS[status].countsTowardOpenDuration).toBe(true);
      expect(isUnresolvedPermitStatus(status)).toBe(true);
    }
    for (const status of ['complete', 'closed', 'void'] as const) {
      expect(PERMIT_STATUS_FACTS[status].countsTowardOpenDuration).toBe(false);
    }
  });

  /** A voided permit is terminal but is not a completed job. */
  it('keeps void distinct from closed', () => {
    expect(isSignedOffPermitStatus('void')).toBe(false);
    expect(isSignedOffPermitStatus('closed')).toBe(true);
    expect(isSignedOffPermitStatus('complete')).toBe(true);
  });
});

describe('permitNaturalKey', () => {
  /** One AppNo covers several structures and permit types, so it is not a key by itself. */
  it('distinguishes rows that share an application number', () => {
    const base = { permit_number: '21-13064', structure_sequence: 1 };
    const first = permitNaturalKey({ ...base, permit_type_sequence: 1 });
    const second = permitNaturalKey({ ...base, permit_type_sequence: 2 });
    const otherStructure = permitNaturalKey({
      permit_number: '21-13064',
      structure_sequence: 2,
      permit_type_sequence: 1,
    });

    expect(new Set([first, second, otherStructure]).size).toBe(3);
  });

  it('stays stable when a sequence is missing', () => {
    expect(
      permitNaturalKey({
        permit_number: '21-13064',
        structure_sequence: null,
        permit_type_sequence: null,
      }),
    ).toBe('21-13064/_/_');
  });
});
