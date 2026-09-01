import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GSI1_NAME, HEALTH_PROBE_KEY, LEAD_GSI1PK } from '@roofing-crm/shared';
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
  items: Record<string, unknown>[];
  nextCursor: string | null;
}

/** Reads the newest leads from GSI1. Exercises the index and its IAM grant. */
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
    items: response.Items ?? [],
    nextCursor: response.LastEvaluatedKey ? JSON.stringify(response.LastEvaluatedKey) : null,
  };
}
