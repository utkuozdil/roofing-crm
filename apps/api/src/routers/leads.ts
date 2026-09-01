import { z } from 'zod';
import { listLeads } from '../lib/table';
import { publicProcedure, router } from '../trpc';

const listInput = z.object({
  limit: z.number().int().min(1).max(100).default(25),
});

export const leadsRouter = router({
  /**
   * Phase 0 read path. It exists to prove the GSI1 access pattern and the Lambda's
   * table grant are wired; lead creation and qualification arrive in a later phase.
   */
  list: publicProcedure.input(listInput).query(async ({ input, ctx }) => {
    ctx.logger.info('Listing leads', { limit: input.limit });
    return listLeads(input.limit);
  }),
});
