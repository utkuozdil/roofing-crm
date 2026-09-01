/**
 * Identity of this service across every observability and cost-attribution surface.
 *
 * `SERVICE_NAME` is deliberately reused verbatim as:
 *   - the Powertools `serviceName` (which becomes the `service` metric dimension)
 *   - the `POWERTOOLS_SERVICE_NAME` Lambda environment variable
 *   - the `project_name` cost-allocation tag on every CDK resource
 *
 * Keeping those three in sync is what makes `CostPredicted` joinable against the
 * AWS Cost Explorer breakdown for the same `project_name`.
 */
export const SERVICE_NAME = 'roofing-crm';

/** CloudWatch custom-metric namespace. PascalCase form of {@link SERVICE_NAME}. */
export const METRICS_NAMESPACE = 'RoofingCrm';

export const AWS_REGION = 'us-east-2';

/**
 * Delivery phase of the deployed build. Surfaced by the API health probe and used as the
 * `phase` cost-allocation tag, so a CloudFront response and a billing line item can be
 * traced back to the same increment.
 */
export const SERVICE_PHASE = 'phase-6';

export type TargetEnv = 'dev' | 'prod';

export function parseTargetEnv(value: string | undefined): TargetEnv {
  return value === 'prod' ? 'prod' : 'dev';
}
