import {
  DEFAULT_PROPERTY_FILTERS,
  DEFAULT_RADIUS_MILES,
  PERMIT_FILTER_MODES,
  POOL_FILTER_MODES,
  PROPERTY_TYPES,
  SEARCH_SORTS,
  SEMINOLE_COUNTY_CENTER,
} from '@roofing-crm/shared';
import { z } from 'zod';
import { propertySource } from '../data/property-source';
import { publicProcedure, router } from '../trpc';

const geoPoint = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * Every filter has a default, so a caller that sends only a centre still gets the
 * assignment's headline query: roofs older than 15 years near a point.
 */
const filters = z.object({
  minRoofAgeYears: z.number().min(0).max(120).default(DEFAULT_PROPERTY_FILTERS.minRoofAgeYears),
  includeUnknownRoofAge: z.boolean().default(DEFAULT_PROPERTY_FILTERS.includeUnknownRoofAge),
  permitStatus: z.enum(PERMIT_FILTER_MODES).default(DEFAULT_PROPERTY_FILTERS.permitStatus),
  minPermitOpenYears: z
    .number()
    .min(0)
    .max(40)
    .default(DEFAULT_PROPERTY_FILTERS.minPermitOpenYears),
  minYearsSinceLastSale: z
    .number()
    .min(0)
    .max(80)
    .default(DEFAULT_PROPERTY_FILTERS.minYearsSinceLastSale),
  outOfAreaOwnerOnly: z.boolean().default(DEFAULT_PROPERTY_FILTERS.outOfAreaOwnerOnly),
  poolStatus: z.enum(POOL_FILTER_MODES).default(DEFAULT_PROPERTY_FILTERS.poolStatus),
  /** A four-digit year, or 0 for "any". Capped at 2100 so a typo cannot become a valid year. */
  soldSinceYear: z
    .union([z.literal(0), z.number().int().min(1900).max(2100)])
    .default(DEFAULT_PROPERTY_FILTERS.soldSinceYear),
  minJustValue: z.number().min(0).max(50_000_000).default(DEFAULT_PROPERTY_FILTERS.minJustValue),
  propertyTypes: z
    .array(z.enum(PROPERTY_TYPES))
    .max(PROPERTY_TYPES.length)
    // A factory, so the default can never be a shared array a caller mutates.
    .default(() => []),
});

const searchInput = z.object({
  center: geoPoint.default(SEMINOLE_COUNTY_CENTER),
  /** Capped at 25 miles: beyond that the query leaves the county the CRM is scoped to. */
  radiusMiles: z.number().min(0.1).max(25).default(DEFAULT_RADIUS_MILES),
  filters: filters.default(DEFAULT_PROPERTY_FILTERS),
  sort: z.enum(SEARCH_SORTS).default('distance'),
  limit: z.number().int().min(1).max(500).default(200),
});

export const propertiesRouter = router({
  /**
   * Radius search. The geohash-then-haversine split lives in the data source; this
   * procedure only validates input and reports the search diagnostics back so the UI can
   * show how many buckets and candidates a query touched.
   */
  search: publicProcedure.input(searchInput.optional()).query(async ({ input, ctx }) => {
    const query = searchInput.parse(input ?? {});
    const result = await propertySource.search(query);

    ctx.logger.info('Property radius search', {
      radiusMiles: query.radiusMiles,
      sort: query.sort,
      cellsScanned: result.cellsScanned,
      candidatesScanned: result.candidatesScanned,
      totalInRadius: result.totalInRadius,
      totalMatched: result.totalMatched,
      unknownRoofAgeInRadius: result.unknownRoofAgeInRadius,
      includeUnknownRoofAge: query.filters.includeUnknownRoofAge,
    });

    return result;
  }),

  get: publicProcedure
    .input(z.object({ parcelId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const property = await propertySource.getByParcelId(input.parcelId);
      if (!property) {
        ctx.logger.warn('Property not found', { parcelId: input.parcelId });
      }
      return property;
    }),

  /**
   * Provenance for the banner the UI shows above the map. The pipeline that will supply
   * real parcels is a separate deliverable, and the UI states plainly which source it is
   * reading rather than presenting synthetic rows as county records.
   */
  dataset: publicProcedure.query(async () => ({
    provider: 'fixture' as const,
    county: 'Seminole County, FL',
    rowCount: await propertySource.size(),
    note: 'Seeded fixture dataset behind the PropertyDataSource interface. The Oracle ingestion pipeline replaces this source without any UI change.',
  })),
});
