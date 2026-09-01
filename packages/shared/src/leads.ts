/**
 * The CRM lead record. A lead is always created from a property, so it snapshots the
 * property fields a salesperson needs in a list view — a stale snapshot is preferable to
 * a lead row that cannot render until the property store is queried again.
 */

export const LEAD_STATUSES = ['new', 'contacted', 'appointment', 'quoted', 'won', 'lost'] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const DEFAULT_LEAD_STATUS: LeadStatus = 'new';

export interface LeadRecord {
  leadId: string;
  parcelId: string;
  status: LeadStatus;
  /** Snapshot of the originating property, so the pipeline list renders standalone. */
  ownerName: string;
  primaryAddress: string;
  roofAgeYears: number | null;
  /** Why this property qualified, captured at creation time. */
  source: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  appointment: 'Appointment set',
  quoted: 'Quoted',
  won: 'Won',
  lost: 'Lost',
};
