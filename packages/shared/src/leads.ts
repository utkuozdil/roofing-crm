/**
 * The CRM lead record. A lead is always created from a property, so it snapshots the
 * property fields a salesperson needs in a list view — a stale snapshot is preferable to
 * a lead row that cannot render until the property store is queried again.
 *
 * Location and permit facts are snapshotted too so the pipeline can filter by roof age,
 * permit status / open duration, and radius without a second property fetch in the UI.
 */

import { haversineMiles, type GeoPoint } from './geo';
import { isUnresolvedPermitStatus } from './permits';
import { type PermitFilterMode, type PermitRecord } from './property';

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
  latitude: number | null;
  longitude: number | null;
  permitCount: number;
  unresolvedPermitCount: number;
  unresolvedRoofingCount: number;
  /** Longest unresolved-permit open duration, years. Null when none are unresolved. */
  longestOpenYears: number | null;
  /** Why this property qualified, captured at creation time. */
  source: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadPipelineFilters {
  minRoofAgeYears: number;
  permitStatus: PermitFilterMode;
  minPermitOpenYears: number;
  /** 0 means no radius constraint — the pipeline shows every saved lead. */
  radiusMiles: number;
}

export const DEFAULT_LEAD_PIPELINE_FILTERS: LeadPipelineFilters = {
  minRoofAgeYears: 0,
  permitStatus: 'any',
  minPermitOpenYears: 0,
  radiusMiles: 0,
};

export function leadFilterFactsFromProperty(property: {
  latitude: number;
  longitude: number;
  permits: readonly PermitRecord[];
}): Pick<
  LeadRecord,
  | 'latitude'
  | 'longitude'
  | 'permitCount'
  | 'unresolvedPermitCount'
  | 'unresolvedRoofingCount'
  | 'longestOpenYears'
> {
  const unresolved = property.permits.filter((permit) => isUnresolvedPermitStatus(permit.status));
  const roofing = unresolved.filter((permit) => permit.is_roofing);
  const longest = unresolved.reduce<number | null>((max, permit) => {
    if (permit.open_years === null) return max;
    return max === null ? permit.open_years : Math.max(max, permit.open_years);
  }, null);

  return {
    latitude: property.latitude,
    longitude: property.longitude,
    permitCount: property.permits.length,
    unresolvedPermitCount: unresolved.length,
    unresolvedRoofingCount: roofing.length,
    longestOpenYears: longest,
  };
}

export function matchesLeadFilters(
  lead: LeadRecord,
  filters: LeadPipelineFilters,
  center: GeoPoint,
): boolean {
  if (filters.minRoofAgeYears > 0) {
    if (lead.roofAgeYears === null || lead.roofAgeYears < filters.minRoofAgeYears) return false;
  }

  if (filters.permitStatus === 'none' && lead.permitCount > 0) return false;
  if (filters.permitStatus === 'unresolved' && lead.unresolvedPermitCount === 0) return false;
  if (filters.permitStatus === 'roofing_unresolved' && lead.unresolvedRoofingCount === 0) {
    return false;
  }

  if (filters.minPermitOpenYears > 0) {
    if (lead.longestOpenYears === null || lead.longestOpenYears < filters.minPermitOpenYears) {
      return false;
    }
  }

  if (filters.radiusMiles > 0) {
    if (lead.latitude === null || lead.longitude === null) return false;
    if (
      haversineMiles(center, { latitude: lead.latitude, longitude: lead.longitude }) >
      filters.radiusMiles
    ) {
      return false;
    }
  }

  return true;
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
