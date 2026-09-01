import { router } from '../trpc';
import { leadsRouter } from './leads';
import { systemRouter } from './system';

export const appRouter = router({
  system: systemRouter,
  leads: leadsRouter,
});

export type AppRouter = typeof appRouter;
