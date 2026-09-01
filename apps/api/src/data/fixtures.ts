/**
 * Seeded stand-in for the Oracle property dataset.
 *
 * The ingestion pipeline that produces real Seminole County parcels, permits, and BBB
 * enrichment is built separately and is not available yet. Rather than block the UI on
 * it, this module synthesises a realistic county-shaped dataset behind the same
 * `PropertyRecord` contract from `@roofing-crm/shared`. Every consumer — router, tests,
 * SPA — reads the contract, never this file, so replacing it with the real source is a
 * one-line change in `property-source.ts`.
 *
 * Generation is deterministic: a fixed seed through a counter-based PRNG. The same parcel
 * id always carries the same owner, permits, and coordinates, which is what lets the
 * Playwright suite assert on a specific property.
 */

import {
  SEMINOLE_PLACES,
  classifyRoofingPermit,
  clampToCounty,
  computeGeohash5,
  type PermitRecord,
  type PermitStatus,
  type PropertyRecord,
  type PropertyType,
} from '@roofing-crm/shared';

/** Raw fixture row: every ingested field plus `geohash5`. Roof age is derived per query. */
export type PropertyFixture = Omit<PropertyRecord, 'roof_age_years'> & {
  permits: PermitRecord[];
};

/** Fixed so the dataset — and therefore every test assertion against it — never drifts. */
const SEED = 0x5ee1_0f1e;

const PROPERTIES_PER_PLACE = 24;

/** Properties scatter within this many degrees of their place centroid (~1.2 miles). */
const SCATTER_DEGREES = 0.018;

/**
 * Field-level missing rates measured against the real ingested dataset (181,218 parcels).
 *
 * The fixture reproduces them so the UI is exercised against the county's actual sparsity
 * rather than against tidy synthetic rows. Without this, the address fallback and the
 * unknown-roof-age filter would look like dead code locally and then fire on one row in
 * eleven the day real data lands.
 *
 * `latitude`, `longitude`, and the three valuation fields had zero misses and are always
 * populated here.
 */
export const MEASURED_MISSING_RATES = {
  owner_name: 0.008,
  primary_address: 0.091,
  year_built: 0.106,
  last_sale_amount: 0.028,
  last_sale_date: 0.133,
  total_living_area: 0.145,
  total_bedrooms: 0.146,
} as const;

/**
 * An unaddressed parcel is usually unbuilt land, so the two gaps correlate rather than
 * being independent draws. These two rates compose to the measured 9.1% overall.
 */
const ADDRESS_MISSING_RATE_VACANT = 0.58;
const ADDRESS_MISSING_RATE_BUILT = 0.033;

/**
 * `total_living_area` is missing more often (14.5%) than `year_built` (10.6%), so a
 * minority of built parcels have a build year but no measured area. This is the extra
 * draw that produces them.
 */
const LIVING_AREA_MISSING_RATE_BUILT = 0.044;

/** mulberry32: small, fast, and reproducible across Node versions. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const STREETS_BY_PLACE: Record<string, readonly string[]> = {
  Sanford: ['PARK AVE', 'SANFORD AVE', 'PALMETTO AVE', 'MAGNOLIA AVE', 'CELERY AVE', 'ELM AVE'],
  'Sanford South': ['MELLONVILLE AVE', 'AIRPORT BLVD', 'S FRENCH AVE', 'RIDGEWOOD AVE'],
  'Lake Mary': ['LAKE MARY BLVD', 'COUNTRY CLUB RD', 'GREENWOOD BLVD', 'EMMA OAKS TRL'],
  Heathrow: ['HEATHROW BLVD', 'BRIDGEWATER DR', 'CROWN COLONY CT', 'VISTANA DR'],
  Longwood: ['CHURCH AVE', 'GRANT ST', 'HIGHLAND ST', 'RONALD REAGAN BLVD'],
  'Wekiva Springs': ['SABAL PALM DR', 'SPRINGS LANDING BLVD', 'WEKIVA COVE RD'],
  'Altamonte Springs': ['MAITLAND AVE', 'PALM SPRINGS DR', 'BOSTON AVE', 'LAKE ORIENTA DR'],
  'Altamonte Springs West': ['MONTGOMERY RD', 'DOUGLAS AVE', 'BEAR LAKE RD'],
  Casselberry: ['LAKE TRIPLET DR', 'WINTER PARK DR', 'SUNSET DR', 'SEMORAN BLVD'],
  'Fern Park': ['LAKE AVE', 'BEVERLY DR', 'PINECREST DR'],
  'Winter Springs': ['TUSKAWILLA RD', 'NORTHERN WAY', 'SHEPARD RD', 'TROTWOOD BLVD'],
  Oviedo: ['MITCHELL HAMMOCK RD', 'BROADWAY ST', 'LOCKWOOD BLVD', 'ALAFAYA TRL'],
  Chuluota: ['LAKE MILLS RD', 'CURRYVILLE RD', 'OSCEOLA RD', '1ST ST'],
  Geneva: ['WHITCOMB DR', 'MAIN ST', 'COCHRAN RD', 'OSCEOLA RD'],
  Goldenrod: ['ALOMA AVE', 'PALMETTO ST', 'HALL RD'],
};

const SURNAMES = [
  'ALVAREZ',
  'BENNETT',
  'CARDOSO',
  'DELGADO',
  'ELLISON',
  'FAIRCHILD',
  'GRANTHAM',
  'HOLLOWAY',
  'IVERSON',
  'JORDAN',
  'KOWALSKI',
  'LARSEN',
  'MCPHERSON',
  'NGUYEN',
  'OKONKWO',
  'PATTERSON',
  'QUINTANA',
  'RAMSEY',
  'STOKES',
  'THIBODEAUX',
  'UNDERWOOD',
  'VALDEZ',
  'WHITTAKER',
  'YEAGER',
];

const GIVEN_NAMES = [
  'ANDREW',
  'BEATRICE',
  'CARLOS',
  'DIANE',
  'EDUARDO',
  'FRANCES',
  'GORDON',
  'HELENA',
  'ISAAC',
  'JOANNE',
  'KEVIN',
  'LUCIA',
  'MARCUS',
  'NADIA',
  'OSCAR',
  'PRISCILLA',
];

/** Entity owners are common in this county and are a useful out-of-area signal. */
const ENTITY_OWNERS = [
  'BLUEHERON HOLDINGS LLC',
  'SEMINOLE RESIDENTIAL TRUST',
  'ST JOHNS PROPERTY PARTNERS LP',
  'MIDLAND SFR VENTURES II LLC',
  'LAKESHORE FAMILY TRUST',
  'ORLANDO RENTAL GROUP LLC',
];

const OUT_OF_AREA_MAILING = [
  'NEW YORK, NY 10011',
  'BROOKLYN, NY 11215',
  'ATLANTA, GA 30309',
  'CHICAGO, IL 60614',
  'BOSTON, MA 02116',
  'CHARLOTTE, NC 28202',
  'HOUSTON, TX 77002',
  'LOS ANGELES, CA 90024',
  'TORONTO, ON M5V 2T6',
  'MIAMI, FL 33131',
  'NAPLES, FL 34102',
];

/**
 * `vacant` is weighted to the measured 10.6% of parcels with no `year_built` — that gap is
 * one population, not scattered noise: land with no building on it.
 */
const PROPERTY_TYPE_WEIGHTS: readonly [PropertyType, number][] = [
  ['single_family', 0.62],
  ['townhouse', 0.08],
  ['condo', 0.07],
  ['multi_family', 0.05],
  ['mobile_home', 0.04],
  ['commercial', 0.034],
  ['vacant', 0.106],
];

interface Contractor {
  name: string;
  license: string | null;
  bbb_rating: string | null;
  bbb_score: number | null;
  bbb_accredited: boolean | null;
}

/**
 * Contractors with `bbb_rating: null` are deliberate: the real BBB enrichment will not
 * match every contractor, and the UI has to render that gap explicitly rather than
 * quietly omitting the contractor.
 */
const CONTRACTORS: readonly Contractor[] = [
  {
    name: 'Central Florida Roofing Co',
    license: 'CCC1330218',
    bbb_rating: 'A+',
    bbb_score: 4.6,
    bbb_accredited: true,
  },
  {
    name: 'Sanford Roofing & Sheet Metal',
    license: 'CCC1327744',
    bbb_rating: 'A',
    bbb_score: 4.2,
    bbb_accredited: true,
  },
  {
    name: 'Apex Shingle Systems',
    license: 'CCC1331902',
    bbb_rating: 'A+',
    bbb_score: 4.8,
    bbb_accredited: true,
  },
  {
    name: 'Tuskawilla Roofing Contractors',
    license: 'CCC1329410',
    bbb_rating: 'A-',
    bbb_score: 4.0,
    bbb_accredited: true,
  },
  {
    name: 'Lake Mary Exteriors LLC',
    license: 'CCC1332077',
    bbb_rating: 'B+',
    bbb_score: 3.8,
    bbb_accredited: false,
  },
  {
    name: 'Oviedo Home Improvement Group',
    license: 'CBC1259033',
    bbb_rating: 'B',
    bbb_score: 3.4,
    bbb_accredited: false,
  },
  {
    name: 'Gulf Coast Storm Restoration',
    license: 'CCC1326688',
    bbb_rating: 'C',
    bbb_score: 2.9,
    bbb_accredited: false,
  },
  {
    name: 'Statewide Roof Solutions',
    license: 'CCC1334512',
    bbb_rating: null,
    bbb_score: null,
    bbb_accredited: null,
  },
  {
    name: 'JRD Construction Services',
    license: 'CGC1521804',
    bbb_rating: null,
    bbb_score: null,
    bbb_accredited: null,
  },
  {
    name: 'Owner / Builder',
    license: null,
    bbb_rating: null,
    bbb_score: null,
    bbb_accredited: null,
  },
];

/**
 * Permit kinds drawn from the county's real application-type vocabulary, so `is_roofing` is
 * decided by the classifier reading these codes rather than by a boolean the fixture
 * asserts. `A980` and `A979` are the trap cases: solar work that is not roofing, sitting
 * next to `R300`, solar PV *shingles*, which is.
 */
interface PermitKind {
  applicationTypeCode: string;
  permitTypeCode: string;
  type: string;
  description: string;
  baseValuation: number;
}

const PERMIT_KINDS: readonly PermitKind[] = [
  {
    applicationTypeCode: 'R100',
    permitTypeCode: 'RR REROOF',
    type: 'Reroof residential',
    description: 'Residential reroof — architectural shingle',
    baseValuation: 17_500,
  },
  {
    applicationTypeCode: 'EZRO',
    permitTypeCode: 'RR REROOF',
    type: 'EZ reroof residential',
    description: 'Residential reroof — concrete tile, expedited review',
    baseValuation: 34_000,
  },
  {
    applicationTypeCode: 'A998',
    permitTypeCode: 'BPRF BLDG PERMIT/ROOF',
    type: 'Siding / roof over',
    description: 'Roof-over with new underlayment and metal panel',
    baseValuation: 21_400,
  },
  {
    applicationTypeCode: 'R200',
    permitTypeCode: 'RR REROOF',
    type: 'Hurricane / res reroof',
    description: 'Storm-damage residential reroof',
    baseValuation: 26_800,
  },
  {
    applicationTypeCode: 'R300',
    permitTypeCode: 'RR REROOF',
    type: 'Reroof — solar PV shingles',
    description: 'Reroof with integrated photovoltaic shingles',
    baseValuation: 48_000,
  },
  {
    applicationTypeCode: 'C110',
    permitTypeCode: 'BPC BLDG PMT COMMERCIAL',
    type: 'Reroof commercial',
    description: 'Commercial low-slope reroof, modified bitumen',
    baseValuation: 96_000,
  },
  {
    applicationTypeCode: 'A980',
    permitTypeCode: 'ESOL ELECTRIC SOLAR',
    type: 'Electric solar wiring',
    description: 'Roof-mounted photovoltaic array, electrical only',
    baseValuation: 24_000,
  },
  {
    applicationTypeCode: 'A971',
    permitTypeCode: 'MEC2 MECHANICAL ALL OTHER',
    type: 'Mechanical — residential',
    description: 'Air handler and condenser replacement',
    baseValuation: 9_400,
  },
  {
    applicationTypeCode: 'A329',
    permitTypeCode: 'PE POOL ENCLOSURES',
    type: 'Pool enclosure / bond',
    description: 'Screen enclosure over existing pool deck',
    baseValuation: 13_000,
  },
  {
    applicationTypeCode: 'A997',
    permitTypeCode: 'BPNA BLDG PMT NEW / ALTERATION R',
    type: 'Window / door replacement',
    description: 'Impact-rated window replacement, whole house',
    baseValuation: 21_000,
  },
  {
    applicationTypeCode: 'A979',
    permitTypeCode: 'PLMS PLUMBING MISCELLANEOUS',
    type: 'Solar — pool / water heater supply',
    description: 'Solar pool heater supply piping',
    baseValuation: 7_600,
  },
];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function pickWeighted<T>(random: () => number, weights: readonly [T, number][]): T {
  const roll = random();
  let cumulative = 0;
  for (const [value, weight] of weights) {
    cumulative += weight;
    if (roll < cumulative) return value;
  }
  return weights[weights.length - 1]![0];
}

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function isoDate(random: () => number, minYear: number, maxYear: number): string {
  const year = randomInt(random, minYear, maxYear);
  const month = randomInt(random, 1, 12);
  const day = randomInt(random, 1, 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Seminole County parcel ids look like `06-21-30-5AC-0000-0010`. */
function parcelId(random: () => number, sequence: number): string {
  const township = String(randomInt(random, 1, 36)).padStart(2, '0');
  const range = String(randomInt(random, 19, 22)).padStart(2, '0');
  const section = String(randomInt(random, 29, 32)).padStart(2, '0');
  const subdivision = `${randomInt(random, 5, 9)}${pick(random, ['AC', 'BE', 'CG', 'DH', 'PA'])}`;
  const block = String(randomInt(random, 0, 12) * 100).padStart(4, '0');
  const lot = String(sequence * 10).padStart(4, '0');
  return `${township}-${range}-${section}-${subdivision}-${block}-${lot}`;
}

/**
 * Distribution over the canonical status vocabulary. Roughly a third stay unresolved, and
 * a slice of those are stale by years — that stalled-permit population is the primary lead
 * signal the CRM exists to surface. `void` is rare but present, because a voided reroof
 * must not reset a roof's age and that path needs to be reachable.
 */
const PERMIT_STATUS_WEIGHTS: readonly [PermitStatus, number][] = [
  ['active', 0.2],
  ['blocked', 0.07],
  ['pre_issuance', 0.06],
  ['complete', 0.42],
  ['closed', 0.21],
  ['void', 0.04],
];

/**
 * Share of resolved permits with no `closed_date`. The source has no explicit close date —
 * resolution is the terminal inspection's Result Date — so a resolved permit whose final
 * inspection was not captured has no measurable duration.
 */
const RESOLVED_WITHOUT_CLOSE_DATE_RATE = 0.12;

function buildPermits(random: () => number, yearBuilt: number | null): PermitRecord[] {
  // Just over half of parcels have permit history, which mirrors what a county portal
  // actually returns for a residential neighbourhood.
  if (random() > 0.55) return [];

  const count = random() < 0.72 ? 1 : random() < 0.9 ? 2 : 3;
  const permits: PermitRecord[] = [];
  const earliest = Math.max(1998, (yearBuilt ?? 1998) + 1);

  // An application number covers every structure and permit type filed under it, so the
  // same AppNo repeats across rows. Reusing it here keeps consumers honest about the
  // `(AppNo, StructureSequence, PermitTypeSequence)` natural key.
  const applicationNumber = `${String(randomInt(random, 18, 24))}-${String(randomInt(random, 10_000, 19_999))}`;
  const structureSequence = randomInt(random, 1, 2);

  for (let index = 0; index < count; index += 1) {
    const kind = pick(random, PERMIT_KINDS);
    const contractor = pick(random, CONTRACTORS);
    const issued = isoDate(random, Math.min(earliest, 2022), 2024);
    const status = pickWeighted(random, PERMIT_STATUS_WEIGHTS);
    const resolved = status === 'complete' || status === 'closed';

    permits.push({
      permit_number: applicationNumber,
      structure_sequence: structureSequence,
      permit_type_sequence: index + 1,
      application_type_code: kind.applicationTypeCode,
      permit_type_code: kind.permitTypeCode,
      permit_type: kind.type,
      description: kind.description,
      status,
      issued_date: issued,
      closed_date:
        resolved && random() > RESOLVED_WITHOUT_CLOSE_DATE_RATE
          ? isoDate(random, Number(issued.slice(0, 4)), Number(issued.slice(0, 4)) + 1)
          : null,
      contractor_name: contractor.name,
      contractor_license: contractor.license,
      bbb_rating: contractor.bbb_rating,
      bbb_score: contractor.bbb_score,
      bbb_accredited: contractor.bbb_accredited,
      valuation: Math.round((kind.baseValuation * (0.75 + random() * 0.6)) / 100) * 100,
      is_roofing: classifyRoofingPermit({
        application_type_code: kind.applicationTypeCode,
        permit_type_code: kind.permitTypeCode,
        permit_type: kind.type,
        description: kind.description,
      }).is_roofing,
    });
  }

  return permits.sort((a, b) => b.issued_date.localeCompare(a.issued_date));
}

function buildProperty(
  random: () => number,
  place: (typeof SEMINOLE_PLACES)[number],
  sequence: number,
): PropertyFixture {
  const streets = STREETS_BY_PLACE[place.name] ?? ['MAIN ST'];
  const street = pick(random, streets);
  const houseNumber = randomInt(random, 100, 4999);
  const cityLabel = place.name.replace(/ (South|West)$/, '');
  const propertyType = pickWeighted(random, PROPERTY_TYPE_WEIGHTS);

  const isVacant = propertyType === 'vacant';
  const yearBuilt = isVacant ? null : randomInt(random, 1954, 2022);
  const livingArea =
    isVacant || random() < LIVING_AREA_MISSING_RATE_BUILT
      ? null
      : propertyType === 'commercial'
        ? randomInt(random, 3200, 24000)
        : randomInt(random, 840, 4200);

  const justValue =
    livingArea === null
      ? randomInt(random, 28_000, 140_000)
      : Math.round((livingArea * randomInt(random, 145, 265)) / 1000) * 1000;
  const assessedValue = Math.round((justValue * (0.72 + random() * 0.2)) / 1000) * 1000;
  const taxableValue = Math.max(0, assessedValue - (random() < 0.7 ? 50_000 : 0));

  const isEntity = random() < 0.14;
  const ownerName =
    random() < MEASURED_MISSING_RATES.owner_name
      ? null
      : isEntity
        ? pick(random, ENTITY_OWNERS)
        : `${pick(random, SURNAMES)} ${pick(random, GIVEN_NAMES)}`;

  // Entity owners skew heavily absentee; individual owners rarely are.
  const outOfArea = isEntity ? random() < 0.72 : random() < 0.11;

  const permits = buildPermits(random, yearBuilt);

  // Sale date is missing more often than sale amount, so these are separate draws rather
  // than one "has a recorded sale" flag.
  const hasSaleDate = random() >= MEASURED_MISSING_RATES.last_sale_date;
  const hasSaleAmount = random() >= MEASURED_MISSING_RATES.last_sale_amount;

  // Unaddressed parcels are overwhelmingly unbuilt land, and they are legitimate records —
  // never filtered out, just titled by parcel id instead.
  const hasAddress =
    random() >= (isVacant ? ADDRESS_MISSING_RATE_VACANT : ADDRESS_MISSING_RATE_BUILT);

  // Places on the county line (Goldenrod, Fern Park) would otherwise scatter parcels into
  // neighbouring Orange County, which the CRM is not scoped to.
  const { latitude, longitude } = clampToCounty({
    latitude: place.latitude + (random() - 0.5) * 2 * SCATTER_DEGREES,
    longitude: place.longitude + (random() - 0.5) * 2 * SCATTER_DEGREES,
  });

  return {
    parcel_id: parcelId(random, sequence),
    owner_name: ownerName,
    primary_address: hasAddress
      ? `${houseNumber} ${street}, ${cityLabel.toUpperCase()}, FL ${place.zip}`
      : null,
    mailing_city_state_zip: outOfArea
      ? pick(random, OUT_OF_AREA_MAILING)
      : `${cityLabel.toUpperCase()}, FL ${place.zip}`,
    property_type: propertyType,
    year_built: yearBuilt,
    last_sale_date: hasSaleDate ? isoDate(random, Math.max(yearBuilt ?? 1990, 1990), 2025) : null,
    last_sale_amount: hasSaleAmount
      ? Math.round((justValue * (0.45 + random() * 0.75)) / 500) * 500
      : null,
    total_just_value: justValue,
    assessed_value: assessedValue,
    taxable_value: taxableValue,
    total_living_area: livingArea,
    total_bedrooms: livingArea === null ? null : randomInt(random, 2, 5),
    total_bathrooms: livingArea === null ? null : randomInt(random, 1, 4),
    has_pool: !isVacant && random() < 0.28,
    latitude,
    longitude,
    geohash5: computeGeohash5({ latitude, longitude }),
    permits,
  };
}

let cached: readonly PropertyFixture[] | null = null;

/** The fixture dataset. Built once per process and identical on every process. */
export function loadPropertyFixtures(): readonly PropertyFixture[] {
  if (cached) return cached;

  const random = createRandom(SEED);
  const properties: PropertyFixture[] = [];
  const seen = new Set<string>();

  for (const place of SEMINOLE_PLACES) {
    for (let index = 0; index < PROPERTIES_PER_PLACE; index += 1) {
      const property = buildProperty(random, place, properties.length + 1);
      // Parcel id is the primary key of the real dataset, so a collision here would
      // make `properties.get` ambiguous. Sequence-derived lots make this unreachable,
      // but the guard keeps that guarantee honest if the generator changes.
      if (seen.has(property.parcel_id)) continue;
      seen.add(property.parcel_id);
      properties.push(property);
    }
  }

  cached = properties;
  return cached;
}
