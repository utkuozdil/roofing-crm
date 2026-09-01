import { router } from '../trpc';
import { leadsRouter } from './leads';
import { nlqRouter } from './nlq';
import { propertiesRouter } from './properties';
import { systemRouter } from './system';

export const appRouter = router({
  system: systemRouter,
  properties: propertiesRouter,
  leads: leadsRouter,
  nlq: nlqRouter,
});

export type AppRouter = typeof appRouter;
