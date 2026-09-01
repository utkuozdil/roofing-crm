import { describe, expect, it } from 'vitest';
import { LEAD_GSI1PK, leadKey } from './keys';

describe('leadKey', () => {
  it('builds the LEAD#<leadId> / META primary key', () => {
    expect(leadKey('abc-123', '2026-09-01T00:00:00.000Z')).toEqual({
      PK: 'LEAD#abc-123',
      SK: 'META',
      GSI1PK: LEAD_GSI1PK,
      GSI1SK: '2026-09-01T00:00:00.000Z',
    });
  });

  it('places every lead in one GSI1 partition so leads sort by createdAt', () => {
    const first = leadKey('a', '2026-01-01T00:00:00.000Z');
    const second = leadKey('b', '2026-02-01T00:00:00.000Z');
    expect(first.GSI1PK).toBe(second.GSI1PK);
    expect(first.GSI1SK < second.GSI1SK).toBe(true);
  });
});
