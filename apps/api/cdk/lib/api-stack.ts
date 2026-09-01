import { METRICS_NAMESPACE, SERVICE_NAME, type TargetEnv } from '@roofing-crm/shared';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { ObservableFunction } from './constructs/observable-function';

/**
 * Shared API domains, keyed by AWS account, per the `build-frontend-backends`
 * CDK rule. Account `795366345505` is a standalone assignment account and has no
 * entry, so the HTTP API keeps its execute-api endpoint and CloudFront supplies the
 * stable public hostname instead.
 */
const DOMAIN_CONFIG: Record<string, { domainName: string }> = {
  '014948052063': { domainName: 'api.springoakscapital.com' },
  '951132547414': { domainName: 'api-dev.ai.springoakscapital.com' },
};

/** Frozen once deployed: the base path is part of the API contract. */
export const API_BASE_PATH = SERVICE_NAME;

/**
 * Model that translates a natural-language question into the app's structured filters.
 *
 * A first-party Bedrock model reached through the execution role, so the feature has no API
 * key to configure, rotate, or leak — the same reason the PagerDuty routing key is a secret
 * ARN rather than an environment variable.
 *
 * Nova Pro rather than Claude: Anthropic models on Bedrock are AWS Marketplace subscriptions,
 * which this account cannot complete, and a model the deploy cannot invoke is not a model.
 * The `us.` prefix selects the cross-region inference profile, which is the only on-demand
 * route Nova Pro offers.
 */
export const NLQ_MODEL_ID = 'us.amazon.nova-pro-v1:0';

/** CloudFront routes this path prefix to the HTTP API, so the SPA calls the API same-origin. */
export const TRPC_ROUTE_PREFIX = '/trpc';

export interface ApiStackProps extends cdk.StackProps {
  targetEnv: TargetEnv;
  table: dynamodb.ITableV2;
}

export class ApiStack extends cdk.Stack {
  readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const trpcHandler = new ObservableFunction(this, 'TrpcHandler', {
      entry: 'src/handler.ts',
      description: `${SERVICE_NAME} tRPC API`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: props.table.tableName,
        NLQ_MODEL_ID,
      },
    });

    props.table.grantReadWriteData(trpcHandler);

    /**
     * Invoke on the inference profile *and* on the foundation models it fans out to: a
     * cross-region profile calls the model in whichever region it routes to, so a policy
     * naming only the profile fails at request time rather than at deploy time.
     */
    trpcHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${NLQ_MODEL_ID.replace(/^us\./, '')}`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${NLQ_MODEL_ID}`,
        ],
      }),
    );

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${SERVICE_NAME}-${props.targetEnv}-api`,
      description: `${SERVICE_NAME} tRPC HTTP API`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    this.httpApi.addRoutes({
      path: `${TRPC_ROUTE_PREFIX}/{proxy+}`,
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration('TrpcIntegration', trpcHandler),
    });

    const domainConfig = DOMAIN_CONFIG[cdk.Stack.of(this).account];
    const defaultStage = this.httpApi.defaultStage;
    if (domainConfig && defaultStage) {
      new apigwv2.ApiMapping(this, 'ApiMapping', {
        api: this.httpApi,
        domainName: apigwv2.DomainName.fromDomainNameAttributes(this, 'Domain', {
          name: domainConfig.domainName,
          regionalDomainName: domainConfig.domainName,
          regionalHostedZoneId: '',
        }),
        stage: defaultStage,
        apiMappingKey: API_BASE_PATH,
      });
    }

    new cdk.CfnOutput(this, 'HttpApiId', { value: this.httpApi.apiId });
    new cdk.CfnOutput(this, 'HttpApiEndpoint', {
      value: domainConfig
        ? `https://${domainConfig.domainName}/${API_BASE_PATH}`
        : `${this.httpApi.apiEndpoint}${TRPC_ROUTE_PREFIX}`,
      description: 'Direct tRPC endpoint. Prefer the CloudFront /trpc path for browser traffic.',
    });
  }
}
