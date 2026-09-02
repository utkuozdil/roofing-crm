import { LEAD_STATUSES } from '@roofing-crm/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  LeadNotFoundError,
  createLead,
  deleteLead,
  getLead,
  listLeads,
  updateLead,
} from '../lib/table';
import { publicProcedure, router } from '../trpc';

const listInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
});

const createInput = z.object({
  parcelId: z.string().min(1).max(64),
  ownerName: z.string().min(1).max(200),
  primaryAddress: z.string().min(1).max(300),
  roofAgeYears: z.number().int().min(0).max(200).nullable().default(null),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  permitCount: z.number().int().min(0).default(0),
  unresolvedPermitCount: z.number().int().min(0).default(0),
  unresolvedRoofingCount: z.number().int().min(0).default(0),
  longestOpenYears: z.number().min(0).max(80).nullable().default(null),
  /** Why the property qualified. Defaulted so a one-click "create lead" is still valid. */
  source: z.string().max(200).default('Map radius search'),
  notes: z.string().max(2000).default(''),
  status: z.enum(LEAD_STATUSES).default('new'),
});

const updateStatusInput = z.object({
  leadId: z.string().min(1),
  status: z.enum(LEAD_STATUSES),
});

const updateInput = z.object({
  leadId: z.string().min(1),
  status: z.enum(LEAD_STATUSES).optional(),
  notes: z.string().max(2000).optional(),
});

/** A mutation against a lead that no longer exists is a 404, not a server fault. */
function rethrowAsTrpcError(error: unknown): never {
  if (error instanceof LeadNotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: error.message, cause: error });
  }
  throw error;
}

export const leadsRouter = router({
  list: publicProcedure.input(listInput.optional()).query(async ({ input, ctx }) => {
    const limit = input?.limit ?? 50;
    ctx.logger.info('Listing leads', { limit });
    // Table only. Filter facts are written at create time. Do not load the
    // county snapshot here — that is what made the pipeline wait on a cold Lambda.
    return listLeads(limit);
  }),

  get: publicProcedure
    .input(z.object({ leadId: z.string().min(1) }))
    .query(async ({ input }) => getLead(input.leadId)),

  create: publicProcedure.input(createInput).mutation(async ({ input, ctx }) => {
    const lead = await createLead(input);
    ctx.logger.info('Lead created', { leadId: lead.leadId, parcelId: lead.parcelId });
    return lead;
  }),

  /** Narrow mutation for the pipeline dropdown, kept separate from the general update. */
  updateStatus: publicProcedure.input(updateStatusInput).mutation(async ({ input, ctx }) => {
    try {
      const lead = await updateLead(input);
      ctx.logger.info('Lead status updated', { leadId: lead.leadId, status: lead.status });
      return lead;
    } catch (error) {
      rethrowAsTrpcError(error);
    }
  }),

  update: publicProcedure.input(updateInput).mutation(async ({ input, ctx }) => {
    try {
      const lead = await updateLead(input);
      ctx.logger.info('Lead updated', { leadId: lead.leadId });
      return lead;
    } catch (error) {
      rethrowAsTrpcError(error);
    }
  }),

  delete: publicProcedure
    .input(z.object({ leadId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await deleteLead(input.leadId);
        ctx.logger.info('Lead deleted', { leadId: input.leadId });
        return { leadId: input.leadId, deleted: true as const };
      } catch (error) {
        rethrowAsTrpcError(error);
      }
    }),
});
