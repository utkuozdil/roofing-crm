import type { TargetEnv } from '@roofing-crm/shared';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export interface ObservableFunctionProps {
  /** Path to the TypeScript entry point; esbuild bundles it via `NodejsFunction`. */
  entry: string;
  description: string;
  /** Becomes `POWERTOOLS_SERVICE_NAME` and therefore the `service` metric dimension. */
  serviceName: string;
  metricsNamespace: string;
  targetEnv: TargetEnv;
  environment?: Record<string, string>;
  memorySize?: number;
  timeout?: cdk.Duration;
  deadLetterQueue?: sqs.IQueue;
}

/**
 * The only Lambda primitive this repository uses.
 *
 * It exists so the observability contract cannot be forgotten on a new function:
 * X-Ray active tracing, esbuild source maps wired to `--enable-source-maps`, a
 * 90-day log group, and the Powertools service/namespace variables are all applied
 * here rather than at each call site.
 *
 * The architecture is deliberately left at x86_64 to match the `us-east-2` x86
 * price constants that back the `CostPredicted` metric.
 */
export class ObservableFunction extends nodejs.NodejsFunction {
  constructor(scope: Construct, id: string, props: ObservableFunctionProps) {
    super(scope, id, {
      entry: props.entry,
      handler: 'handler',
      description: props.description,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: props.memorySize ?? 512,
      timeout: props.timeout ?? cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueueEnabled: props.deadLetterQueue !== undefined,
      deadLetterQueue: props.deadLetterQueue,
      logGroup: new logs.LogGroup(scope, `${id}Logs`, {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: props.serviceName,
        POWERTOOLS_METRICS_NAMESPACE: props.metricsNamespace,
        POWERTOOLS_LOG_LEVEL: props.targetEnv === 'prod' ? 'INFO' : 'DEBUG',
        POWERTOOLS_LOGGER_LOG_EVENT: String(props.targetEnv !== 'prod'),
        TARGET_ENV: props.targetEnv,
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: nodejs.OutputFormat.CJS,
      },
    });
  }
}
