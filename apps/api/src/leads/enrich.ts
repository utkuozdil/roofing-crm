/**
 * Fills location and permit facts on a stored lead from the live property snapshot.
 *
 * Older leads were written before those fields existed. The pipeline still has to filter
 * them, so list-time enrichment is how a row created last week gets a radius and an
 * open-permit filter today.
 */

import { leadFilterFactsFromProperty, type LeadRecord } from '@roofing-crm/shared';
import { propertySource } from '../data/property-source';

export async function enrichLead(lead: LeadRecord): Promise<LeadRecord> {
  const property = await propertySource.getByParcelId(lead.parcelId);
  if (!property) return lead;
  return {
    ...lead,
    roofAgeYears: property.roof_age_years ?? lead.roofAgeYears,
    ...leadFilterFactsFromProperty(property),
  };
}

export async function enrichLeads(leads: readonly LeadRecord[]): Promise<LeadRecord[]> {
  return Promise.all(leads.map((lead) => enrichLead(lead)));
}
