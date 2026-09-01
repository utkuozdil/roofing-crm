import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listLeads, probeTable } from './table';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

afterEach(() => {
  ddbMock.reset();
});

describe('probeTable', () => {
  it('treats a sentinel-key miss as a reachable table', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(probeTable()).resolves.toBe(true);
  });

  it('propagates DynamoDB failures so readiness can report them', async () => {
    ddbMock.on(GetCommand).rejects(new Error('ResourceNotFoundException'));
    await expect(probeTable()).rejects.toThrow('ResourceNotFoundException');
  });
});

describe('listLeads', () => {
  it('queries GSI1 newest-first and reports no cursor when the page is complete', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ PK: 'LEAD#1', SK: 'META' }] });

    const page = await listLeads(10);

    expect(page).toEqual({ items: [{ PK: 'LEAD#1', SK: 'META' }], nextCursor: null });
    const call = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(call?.IndexName).toBe('GSI1');
    expect(call?.ScanIndexForward).toBe(false);
  });

  it('serialises LastEvaluatedKey into an opaque cursor', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { PK: 'LEAD#9' } });

    const page = await listLeads(1);

    expect(page.nextCursor).toBe(JSON.stringify({ PK: 'LEAD#9' }));
  });
});
