/**
 * CRM navigation.
 *
 * `PLACEHOLDER_SECTIONS` is an acceptance criterion: the story is lead identification only,
 * and the rest of a roofing CRM has to be visible but disabled so that scope is obvious.
 */

export type ViewId = 'map' | 'leads';

export interface NavSection {
  id: ViewId;
  label: string;
  description: string;
}

export const LIVE_SECTIONS: readonly NavSection[] = [
  {
    id: 'map',
    label: 'Map & radius search',
    description: 'Radius search over Seminole County with roof-age and permit filters',
  },
  {
    id: 'leads',
    label: 'Lead pipeline',
    description: 'Leads created from properties on the map',
  },
];

export interface PlaceholderSection {
  slug: string;
  label: string;
  description: string;
}

export const PLACEHOLDER_SECTIONS: readonly PlaceholderSection[] = [
  {
    slug: 'estimates',
    label: 'Estimates & proposals',
    description: 'Measure-to-quote with material takeoff and e-signature',
  },
  {
    slug: 'scheduling',
    label: 'Crew scheduling & routing',
    description: 'Assign crews to won jobs and sequence a day of stops',
  },
  {
    slug: 'contractors',
    label: 'Contractor & BBB directory',
    description: 'Reputation history for every contractor seen on a county permit',
  },
  {
    slug: 'storm-events',
    label: 'Storm event overlays',
    description: 'Hail and wind swaths layered over the parcel map',
  },
  {
    slug: 'campaigns',
    label: 'Outreach campaigns',
    description: 'Door-knock lists, direct mail, and call sequences per territory',
  },
  {
    slug: 'documents',
    label: 'Documents & photos',
    description: 'Inspection photos, insurance scopes, and signed contracts per lead',
  },
  {
    slug: 'invoicing',
    label: 'Invoicing & payments',
    description: 'Draw schedules, deposits, and supplier invoice reconciliation',
  },
  {
    slug: 'reporting',
    label: 'Reporting & analytics',
    description: 'Funnel conversion by territory, roof age band, and lead source',
  },
  {
    slug: 'territories',
    label: 'Team & territories',
    description: 'Sales rep assignment and territory ownership rules',
  },
  {
    slug: 'integrations',
    label: 'Integrations',
    description: 'CRM, supplier, and insurance carrier connections',
  },
  {
    slug: 'settings',
    label: 'Settings & permissions',
    description: 'Roles, audit trail, and per-tenant configuration',
  },
];
