import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LeadNotFoundError,
  createLead,
  deleteLead,
  getLead,
  listLeads,
  probeTable,
  updateLead,
} from './table';

const ddbMock = mockClient(DynamoDBDocumentClient);

const STORED_LEAD = {
  PK: 'LEAD#abc',
  SK: 'META',
  GSI1PK: 'LEAD',
  GSI1SK: '2026-09-01T00:00:00.000Z',
  leadId: 'abc',
  parcelId: '30-19-30-5AC-0000-0010',
  status: 'new',
  ownerName: 'DOE JOHN',
  primaryAddress: '1204 PARK AVE, SANFORD, FL 32771',
  roofAgeYears: 28,
  source: 'Map radius search',
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function conditionalCheckFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: 'The conditional request failed',
    $metadata: {},
  });
}

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
    ddbMock.on(QueryCommand).resolves({ Items: [STORED_LEAD] });

    const page = await listLeads(10);

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(call?.IndexName).toBe('GSI1');
    expect(call?.ScanIndexForward).toBe(false);
  });

  /** The SPA renders leads directly, so table keys must never leak into its props. */
  it('strips the table and index keys from every item', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [STORED_LEAD] });

    const [lead] = (await listLeads(10)).items;

    expect(lead).not.toHaveProperty('PK');
    expect(lead).not.toHaveProperty('SK');
    expect(lead).not.toHaveProperty('GSI1PK');
    expect(lead).not.toHaveProperty('GSI1SK');
    expect(lead?.leadId).toBe('abc');
    expect(lead?.status).toBe('new');
  });

  it('serialises LastEvaluatedKey into an opaque cursor', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { PK: 'LEAD#9' } });

    const page = await listLeads(1);

    expect(page.nextCursor).toBe(JSON.stringify({ PK: 'LEAD#9' }));
  });
});

describe('getLead', () => {
  it('returns null on a miss rather than throwing', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(getLead('missing')).resolves.toBeNull();
  });

  it('returns the lead without its table keys', async () => {
    ddbMock.on(GetCommand).resolves({ Item: STORED_LEAD });
    await expect(getLead('abc')).resolves.toMatchObject({
      leadId: 'abc',
      parcelId: STORED_LEAD.parcelId,
    });
  });
});

describe('createLead', () => {
  it('writes the lead with its GSI1 recency keys and a generated id', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const lead = await createLead({
      parcelId: '30-19-30-5AC-0000-0010',
      ownerName: 'DOE JOHN',
      primaryAddress: '1204 PARK AVE, SANFORD, FL 32771',
      roofAgeYears: 28,
      source: 'Map radius search',
      notes: 'Aged roof, permit open since 2019',
    });

    expect(lead.leadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lead.status).toBe('new');
    expect(lead.createdAt).toBe(lead.updatedAt);

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item).toMatchObject({
      PK: `LEAD#${lead.leadId}`,
      SK: 'META',
      GSI1PK: 'LEAD',
      GSI1SK: lead.createdAt,
      parcelId: '30-19-30-5AC-0000-0010',
    });
  });

  it('returns the existing lead instead of minting a second row for the same parcel', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [STORED_LEAD] });

    const lead = await createLead({
      parcelId: STORED_LEAD.parcelId,
      ownerName: 'OTHER',
      primaryAddress: 'OTHER',
      roofAgeYears: 10,
      source: 's',
      notes: '',
    });

    expect(lead.leadId).toBe('abc');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  /** Guards against a retried invocation overwriting an existing lead. */
  it('refuses to overwrite an existing item', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    await createLead({
      parcelId: 'p',
      ownerName: 'o',
      primaryAddress: 'a',
      roofAgeYears: null,
      source: 's',
      notes: '',
    });
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.ConditionExpression).toBe(
      'attribute_not_exists(PK)',
    );
  });
});

describe('updateLead', () => {
  it('updates only the attributes it was given', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...STORED_LEAD, status: 'contacted' } });

    const lead = await updateLead({ leadId: 'abc', status: 'contacted' });

    expect(lead.status).toBe('contacted');
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toBe('SET #updatedAt = :updatedAt, #status = :status');
    expect(input?.ExpressionAttributeValues?.[':status']).toBe('contacted');
    expect(input?.ExpressionAttributeValues).not.toHaveProperty(':notes');
  });

  it('can update notes alongside status', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: STORED_LEAD });

    await updateLead({ leadId: 'abc', status: 'quoted', notes: 'Quoted 14.2k' });

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toContain('#notes = :notes');
    expect(input?.ExpressionAttributeValues?.[':notes']).toBe('Quoted 14.2k');
  });

  /**
   * A bare UpdateItem creates the item when it is missing, which would resurrect a
   * deleted lead as a keys-only ghost row. The existence guard is what prevents that.
   */
  it('translates a failed existence guard into LeadNotFoundError', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(updateLead({ leadId: 'gone', status: 'won' })).rejects.toBeInstanceOf(
      LeadNotFoundError,
    );
    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ConditionExpression).toBe(
      'attribute_exists(PK)',
    );
  });

  it('propagates unrelated DynamoDB failures untouched', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceededException'));
    await expect(updateLead({ leadId: 'abc', status: 'won' })).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    );
  });
});

describe('deleteLead', () => {
  it('deletes by lead id', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await deleteLead('abc');
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input.Key).toEqual({
      PK: 'LEAD#abc',
      SK: 'META',
    });
  });

  it('reports a missing lead as LeadNotFoundError', async () => {
    ddbMock.on(DeleteCommand).rejects(conditionalCheckFailed());
    await expect(deleteLead('gone')).rejects.toBeInstanceOf(LeadNotFoundError);
  });
});
