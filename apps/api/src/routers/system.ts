import { AWS_REGION, SERVICE_NAME } from '@roofing-crm/shared';
import { z } from 'zod';
import { probeTable } from '../lib/table';
import { publicProcedure, router } from '../trpc';

export const systemRouter = router({
  /** Liveness: answers without touching any downstream dependency. */
  health: publicProcedure.query(() => ({
    status: 'ok' as const,
    service: SERVICE_NAME,
    region: AWS_REGION,
    phase: 'phase-0' as const,
    checkedAt: new Date().toISOString(),
  })),

  /** Readiness: confirms the Lambda can actually reach DynamoDB with its own IAM role. */
  readiness: publicProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }): Promise<{ ready: boolean; dependencies: { dynamodb: string } }> => {
      try {
        await probeTable();
        return { ready: true, dependencies: { dynamodb: 'reachable' } };
      } catch (error) {
        ctx.logger.error('DynamoDB readiness probe failed', { error });
        return { ready: false, dependencies: { dynamodb: 'unreachable' } };
      }
    }),
});
