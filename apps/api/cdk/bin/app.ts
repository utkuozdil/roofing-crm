import { SERVICE_NAME, parseTargetEnv } from '@roofing-crm/shared';
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { CoreStack } from '../lib/core-stack';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

const targetEnv = parseTargetEnv(process.env.TARGET_ENV ?? app.node.tryGetContext('targetEnv'));
const region = 'us-east-2';
const account = process.env.CDK_DEFAULT_ACCOUNT;
const stackPrefix = `RoofingCrm-${targetEnv}`;

/**
 * Cost-allocation tags applied at stack scope so every taggable resource inherits them.
 * `project_name` matches the `service` dimension carried by `CostPredicted`, which is
 * what makes predicted and billed cost comparable for the same key.
 */
const tags: Record<string, string> = {
  project_name: SERVICE_NAME,
  environment: targetEnv,
  managed_by: 'cdk',
  phase: 'phase-0',
};

const core = new CoreStack(app, `${stackPrefix}-Core`, {
  description: 'Roofing CRM stateful core: leads table, operations topic, PagerDuty alerting',
  env: { account, region },
  tags,
  targetEnv,
});

const api = new ApiStack(app, `${stackPrefix}-Api`, {
  description: 'Roofing CRM tRPC Lambda behind an API Gateway HTTP API',
  env: { account, region },
  tags,
  targetEnv,
  table: core.table,
});

new WebStack(app, `${stackPrefix}-Web`, {
  description: 'Roofing CRM SPA on S3 + CloudFront, also fronting the tRPC API',
  env: { account, region },
  tags,
  targetEnv,
  siteDistPath: '../crm/dist',
  apiOriginDomain: `${api.httpApi.apiId}.execute-api.${region}.amazonaws.com`,
});

/**
 * `StackProps.tags` only tags the CloudFormation *stack*. Cost allocation needs the keys
 * on the resources themselves, so the same map is applied again as an aspect over the
 * whole app — that is what writes `Tags` into each taggable resource in the templates.
 */
for (const [key, value] of Object.entries(tags)) {
  cdk.Tags.of(app).add(key, value);
}
