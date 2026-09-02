import type { Logger } from '@aws-lambda-powertools/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listLeads, getLead } = vi.hoisted(() => ({
  listLeads: vi.fn(),
  getLead: vi.fn(),
}));

vi.mock('../lib/table', () => ({
  listLeads,
  getLead,
  createLead: vi.fn(),
  updateLead: vi.fn(),
  deleteLead: vi.fn(),
  LeadNotFoundError: class LeadNotFoundError extends Error {},
}));

import { appRouter } from './index';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function caller() {
  return appRouter.createCaller({ logger: noopLogger } as never);
}

const STORED = {
  items: [
    {
      leadId: 'abc',
      parcelId: '2721315CC0B000010',
      status: 'new' as const,
      ownerName: 'SMITH',
      primaryAddress: '2911 BOLAND DR OVIEDO FL 32765',
      roofAgeYears: 22,
      latitude: 28.67,
      longitude: -81.21,
      permitCount: 1,
      unresolvedPermitCount: 0,
      unresolvedRoofingCount: 0,
      longestOpenYears: null,
      source: 'Map radius search',
      notes: '',
      createdAt: '2026-09-02T09:01:31.353Z',
      updatedAt: '2026-09-02T09:01:31.353Z',
    },
  ],
  nextCursor: null,
};

describe('leads.list', () => {
  beforeEach(() => {
    listLeads.mockReset();
    getLead.mockReset();
  });

  it('returns the DynamoDB page and does not wait on the property snapshot', async () => {
    listLeads.mockResolvedValue(STORED);

    const page = await caller().leads.list({ limit: 100 });

    expect(page).toEqual(STORED);
    expect(listLeads).toHaveBeenCalledWith(100);
  });

  it('returns a stored lead by id from the table', async () => {
    getLead.mockResolvedValue(STORED.items[0]);

    await expect(caller().leads.get({ leadId: 'abc' })).resolves.toEqual(STORED.items[0]);
  });
});
