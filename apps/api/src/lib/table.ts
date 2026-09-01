import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_LEAD_STATUS,
  GSI1_NAME,
  HEALTH_PROBE_KEY,
  LEAD_GSI1PK,
  type LeadRecord,
  type LeadStatus,
  leadKey,
} from '@roofing-crm/shared';
import { tracer } from '../observability';

export const TABLE_NAME = process.env.TABLE_NAME ?? '';

const documentClient = DynamoDBDocumentClient.from(
  tracer.captureAWSv3Client(new DynamoDBClient({})),
);

/**
 * Cheapest possible proof that the table exists and the Lambda's IAM grant works.
 * A miss on the sentinel key is a successful probe — DynamoDB answered.
 */
export async function probeTable(): Promise<boolean> {
  await documentClient.send(new GetCommand({ TableName: TABLE_NAME, Key: HEALTH_PROBE_KEY }));
  return true;
}

export interface LeadPage {
  items: LeadRecord[];
  nextCursor: string | null;
}

/**
 * Projects a stored item onto the lead contract.
 *
 * Fields are copied explicitly rather than spread with the table keys removed, so a new
 * internal attribute on the item can never leak into a response by accident, and adding a
 * field to `LeadRecord` is a compile error here until it is mapped.
 */
function toLead(item: Record<string, unknown>): LeadRecord {
  const stored = item as Partial<LeadRecord>;
  return {
    leadId: stored.leadId ?? '',
    parcelId: stored.parcelId ?? '',
    status: stored.status ?? DEFAULT_LEAD_STATUS,
    ownerName: stored.ownerName ?? '',
    primaryAddress: stored.primaryAddress ?? '',
    roofAgeYears: stored.roofAgeYears ?? null,
    source: stored.source ?? '',
    notes: stored.notes ?? '',
    createdAt: stored.createdAt ?? '',
    updatedAt: stored.updatedAt ?? '',
  };
}

/** Reads the newest leads from GSI1. */
export async function listLeads(limit: number): Promise<LeadPage> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: GSI1_NAME,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': LEAD_GSI1PK },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );

  return {
    items: (response.Items ?? []).map(toLead),
    nextCursor: response.LastEvaluatedKey ? JSON.stringify(response.LastEvaluatedKey) : null,
  };
}

export async function getLead(leadId: string): Promise<LeadRecord | null> {
  const response = await documentClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `LEAD#${leadId}`, SK: 'META' } }),
  );
  return response.Item ? toLead(response.Item) : null;
}

export interface CreateLeadInput {
  parcelId: string;
  ownerName: string;
  primaryAddress: string;
  roofAgeYears: number | null;
  source: string;
  notes: string;
  status?: LeadStatus;
}

export async function createLead(input: CreateLeadInput): Promise<LeadRecord> {
  const leadId = randomUUID();
  const createdAt = new Date().toISOString();

  const lead: LeadRecord = {
    leadId,
    parcelId: input.parcelId,
    status: input.status ?? DEFAULT_LEAD_STATUS,
    ownerName: input.ownerName,
    primaryAddress: input.primaryAddress,
    roofAgeYears: input.roofAgeYears,
    source: input.source,
    notes: input.notes,
    createdAt,
    updatedAt: createdAt,
  };

  await documentClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...leadKey(leadId, createdAt), ...lead },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  return lead;
}

/**
 * Thrown when a mutation targets a lead id that is not in the table. The router maps this
 * to a tRPC `NOT_FOUND` so a stale UI gets a real 404 rather than a 500.
 */
export class LeadNotFoundError extends Error {
  constructor(readonly leadId: string) {
    super(`Lead ${leadId} does not exist`);
    this.name = 'LeadNotFoundError';
  }
}

export interface UpdateLeadInput {
  leadId: string;
  status?: LeadStatus;
  notes?: string;
}

/**
 * Partial update guarded on item existence, so "update a deleted lead" fails loudly
 * instead of silently resurrecting it as a new item — which is what a bare `UpdateItem`
 * would do.
 */
export async function updateLead(input: UpdateLeadInput): Promise<LeadRecord> {
  const assignments: string[] = ['#updatedAt = :updatedAt'];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };

  if (input.status !== undefined) {
    assignments.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = input.status;
  }
  if (input.notes !== undefined) {
    assignments.push('#notes = :notes');
    names['#notes'] = 'notes';
    values[':notes'] = input.notes;
  }

  try {
    const response = await documentClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `LEAD#${input.leadId}`, SK: 'META' },
        UpdateExpression: `SET ${assignments.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return toLead(response.Attributes ?? {});
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new LeadNotFoundError(input.leadId);
    }
    throw error;
  }
}

export async function deleteLead(leadId: string): Promise<void> {
  try {
    await documentClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `LEAD#${leadId}`, SK: 'META' },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new LeadNotFoundError(leadId);
    }
    throw error;
  }
}
