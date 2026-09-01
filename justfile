set dotenv-load := false

CDK_DIR := "apps/api"

# Pinned so `synth` and `deploy` always resolve the same bootstrap roles.
export CDK_BOOTSTRAP_QUALIFIER := env_var_or_default("CDK_BOOTSTRAP_QUALIFIER", "hnb659fds")
export AWS_REGION := env_var_or_default("AWS_REGION", "us-east-2")
export TARGET_ENV := env_var_or_default("TARGET_ENV", "dev")

default:
    @just --list

# Install workspace dependencies
setup:
    pnpm install --frozen-lockfile

# Check code formatting
format:
    pnpm exec prettier --check .

# Run linting
lint:
    pnpm exec eslint .

# Run type checking
type-check:
    pnpm turbo run typecheck

# Run tests
test:
    pnpm turbo run test

# Install the browser the end-to-end suite drives
e2e-setup:
    cd e2e && pnpm exec playwright install chromium

# Drive the deployed UI headlessly. Override E2E_BASE_URL to target another deployment.
e2e:
    cd e2e && pnpm exec playwright test

# Build the SPA, then synthesize every CDK stack
build:
    pnpm turbo run build
    cd {{ CDK_DIR }} && pnpm exec cdk synth --strict \
      --context "@aws-cdk/core:bootstrapQualifier=$CDK_BOOTSTRAP_QUALIFIER"

# Deploy every CDK stack
deploy: build
    cd {{ CDK_DIR }} && pnpm exec cdk deploy --all --require-approval never \
      --context "@aws-cdk/core:bootstrapQualifier=$CDK_BOOTSTRAP_QUALIFIER"

# Tear the environment down completely
destroy:
    cd {{ CDK_DIR }} && pnpm exec cdk destroy --all --force \
      --context "@aws-cdk/core:bootstrapQualifier=$CDK_BOOTSTRAP_QUALIFIER"
