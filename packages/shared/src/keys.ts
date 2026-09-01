/**
 * Single-table DynamoDB key vocabulary.
 *
 * Access patterns provisioned in Phase 0:
 *   PK=LEAD#<leadId>  SK=META   — the lead record itself
 *   GSI1PK=LEAD       GSI1SK=<createdAt>  — every lead, newest-first by creation time
 *
 * `SYSTEM#HEALTH` is a reserved partition used only by the API readiness probe.
 */

export const GSI1_NAME = 'GSI1';

/** Constant GSI1 partition so a single query can scan all leads ordered by `createdAt`. */
export const LEAD_GSI1PK = 'LEAD';

export interface TableKey {
  PK: string;
  SK: string;
}

export interface LeadKey extends TableKey {
  GSI1PK: typeof LEAD_GSI1PK;
  GSI1SK: string;
}

export function leadKey(leadId: string, createdAt: string): LeadKey {
  return {
    PK: `LEAD#${leadId}`,
    SK: 'META',
    GSI1PK: LEAD_GSI1PK,
    GSI1SK: createdAt,
  };
}

export const HEALTH_PROBE_KEY: TableKey = {
  PK: 'SYSTEM#HEALTH',
  SK: 'META',
};
