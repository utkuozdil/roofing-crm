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
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';

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
  const model = wrapLanguageModel({
    model: bedrock(config.modelId),
    middleware: jsonSchemaAsToolMiddleware,
  });
  cached = { key, model };
  return model;
}

/**
 * Sends the response schema as a forced tool rather than as Bedrock's `output_config.format`.
 *
 * Bedrock validates Converse requests against its own copy of the Anthropic Messages schema,
 * and that copy rejects `output_config.format` for Claude Haiku 4.5 with
 * `Extra inputs are not permitted`. The AI SDK decides which of the two encodings to use from a
 * capability table that says this model supports the newer one, and its Bedrock-specific
 * exception list does not yet name it — so left alone, every question fails with a 400.
 *
 * The tool encoding is the older, universally accepted route to the same thing, and it is what
 * the SDK itself falls back to for the models on that exception list. Presenting the schema as a
 * single required tool keeps this a one-shot structured extraction: there is no tool *loop* here,
 * no second round trip, and `generateObject` still validates the result against the Zod schema.
 *
 * Safe to remove once the provider's exception list names this model, at which point the SDK
 * would pick the tool encoding by itself. Until then `model.test.ts` pins the transformation, so
 * the workaround cannot be quietly broken by an edit here.
 */
const jsonResponseToolName = 'json';

export const jsonSchemaAsToolMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const schema =
      params.responseFormat?.type === 'json' ? params.responseFormat.schema : undefined;
    if (schema === undefined) return params;

    return {
      ...params,
      responseFormat: { type: 'text' },
      toolChoice: { type: 'tool', toolName: jsonResponseToolName },
      tools: [
        {
          type: 'function',
          name: jsonResponseToolName,
          description: 'Respond with a JSON object matching the schema.',
          inputSchema: schema,
        },
      ],
    };
  },
  /** Unwraps the tool call back into the text `generateObject` expects to parse. */
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    const call = result.content.find(
      (part) => part.type === 'tool-call' && part.toolName === jsonResponseToolName,
    );
    if (call === undefined || call.type !== 'tool-call') return result;

    return {
      ...result,
      content: [{ type: 'text', text: call.input }],
    };
  },
};
