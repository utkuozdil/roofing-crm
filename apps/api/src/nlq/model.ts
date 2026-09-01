/**
 * Model configuration for the natural-language query parser.
 *
 * Presence of `NLQ_MODEL_ID` is the single switch that decides whether the feature is
 * available. Nothing else in the request path reads the environment, so "is the chat
 * enabled?" has exactly one answer and the UI can ask for it before the operator types.
 *
 * Credentials are the Lambda execution role's — the function is granted `bedrock:InvokeModel`
 * rather than holding a key.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { AWS_REGION } from '@roofing-crm/shared';
import type { LanguageModel } from 'ai';

export interface NlqModelConfig {
  modelId: string;
  region: string;
}

/** Null when no model is configured, which is the feature's disabled state. */
export function readNlqModelConfig(env: NodeJS.ProcessEnv = process.env): NlqModelConfig | null {
  const modelId = env.NLQ_MODEL_ID?.trim();
  if (!modelId) return null;
  return { modelId, region: env.NLQ_MODEL_REGION?.trim() || env.AWS_REGION?.trim() || AWS_REGION };
}

/**
 * Built lazily and cached for the container's life: the provider signs requests itself, so
 * constructing it per invocation would re-resolve credentials on every question.
 */
let cached: { key: string; model: LanguageModel } | undefined;

export function nlqModel(config: NlqModelConfig): LanguageModel {
  const key = `${config.region}/${config.modelId}`;
  if (cached?.key === key) return cached.model;

  const bedrock = createAmazonBedrock({
    region: config.region,
    /**
     * The provider's own default reads only `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.
     * The standard chain covers that (which is how Lambda supplies the execution role) and
     * also a local profile or SSO session, so this file runs unchanged in both places.
     */
    credentialProvider: fromNodeProviderChain(),
  });
  const model = bedrock(config.modelId);
  cached = { key, model };
  return model;
}
