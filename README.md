# Roofing CRM & Lead Identification UI

## Phase 0 — infrastructure scaffolding

Phase 0 provisions the deployment surface and the observability contract. There is **no
business logic yet**: the map, radius search, lead scoring, and RAG agent all arrive in
later phases. The Phase 0 exit criterion is a publicly reachable HTTPS URL.

**Live URL:** https://d3jfjqgra0c58a.cloudfront.net

The CloudFront distribution serves both the SPA and the API from one origin, so the
browser never makes a cross-origin call and there is no API URL to inject at build time:

| Path       | Origin                  |
| ---------- | ----------------------- |
| `/trpc/*`  | API Gateway HTTP API    |
| everything | S3 (SPA, with fallback) |

### Layout

```
apps/crm             Vite + React SPA
apps/api             tRPC router, Lambda handlers, and the CDK app
packages/api-client  AppRouter type + preconfigured httpBatchLink client
packages/shared      service identity, metric names, DynamoDB key builders
packages/tsconfig    base / react / node compiler presets
```

`packages/shared` owns the single-table key patterns, so a key can never drift between
the Lambda that writes it and the CDK that provisions the table.

### Stacks

Deployed to account `795366345505`, region `us-east-2`, bootstrap qualifier `hnb659fds`.

- **Core** — DynamoDB single table (on-demand, `PK`/`SK`, `GSI1` for lead recency), the
  operations SNS topic, the stubbed PagerDuty routing-key secret, and the alert notifier
  Lambda with its DLQ and alarm.
- **Api** — the tRPC Lambda behind an API Gateway HTTP API.
- **Web** — the S3 site bucket, CloudFront with Origin Access Control, and the SPA
  rewrite function.

### Commands

```sh
just setup       # pnpm install --frozen-lockfile
just format      # prettier --check
just lint        # eslint
just type-check  # tsc --noEmit across the workspace
just test        # vitest (unit + CDK assertions)
just build       # vite build, then cdk synth --strict
just deploy      # build, then cdk deploy --all
just destroy     # tear the environment down
```

### Observability contract

Every Lambda is a `NodejsFunction` with esbuild, `sourceMap: true`,
`NODE_OPTIONS=--enable-source-maps`, X-Ray `tracing: ACTIVE`, and Powertools Logger,
Tracer, and Metrics. Metrics are PascalCase with a `service` dimension and are emitted
only through Powertools — never `putMetricData`. `observability/metrics.json` is the
manifest to register with Lexicon and the Main Dashboard.

Each async Lambda has an SQS DLQ carrying exactly one self-resolving alarm
(`ApproximateNumberOfMessagesVisible`, `Maximum`, `> 0`, one evaluation period,
missing data not breaching) wired to both `addAlarmAction` and `addOkAction` on the
single operations topic.

Every resource carries cost-allocation tags, and `project_name` equals the `service`
dimension on `CostPredicted`, so forecast cost and billed cost join on one key.

## Context

Roofing companies need a practical CRM for finding and qualifying residential and commercial roofing leads in their service area. The immediate requirement is a map-based CRM that helps sales teams explore local properties, surface roofs that are aging or have stalled open permits, and turn those signals into actionable outreach opportunities.

Data gathering and ingestion pipelines are covered by a separate user story and are **out of scope** for this work. This story assumes property, permit, and related enrichment data are already available for the UI and agent to consume.

## Description

Create a map-based roofing lead CRM that enables users to locate properties from their current GPS position or a pin drop on the map, set a search radius, and review candidate roofs that meet lead criteria—primarily roof age (for example, older than 15 years) and open roofing permits (especially permits that have remained open for many years).

The UI should present property and permit details, including contractor information and BBB rating scores where available. Users should also be able to query the platform in natural language through a RAG-backed agent to discover roofing opportunities (for example, “show me open roofing permits older than five years within five miles of [city xyz]”).

## Acceptance Criteria

- Default the map and search experience to a particular county, with support for exploring properties in the user’s selected area.
- Allow users to center property search on current GPS location and/or a pin dropped on the map.
- Allow users to set a configurable search radius around the selected location.
- Display properties within the radius that have roofs older than a configurable age threshold (default suggestion: 15 years).
- Display properties within the radius that have open roofing permits, with emphasis on permits that have remained open for an extended period.
- Show permit details in the UI, including permit status, age/open duration, contractor name, and BBB rating score when available.
- Present a browsable list of matching roofing lead candidates derived from the map/radius filters.
- Support creating and managing CRM lead records from identified properties and permits.
- Provide a RAG-backed agent that answers natural-language queries about roofing opportunities using available property and permit data.
- Keep data gathering, ingestion, and source-system integration out of scope; consume pre-existing/available datasets.
- Show (disabled) sections on the CRM that would expand the product beyond the initial lead-identification workflow.

## Demo Transcript

- Open the CRM centered on a particular county.
- Drop a pin (or use GPS) and set a search radius.
- Show roofs older than the age threshold (e.g., 15 years) within the radius.
- Highlight properties with open roofing permits, prioritizing long-open permits.
- Open a selected property/permit and review contractor details and BBB rating where available.
- Convert one or more matches into CRM lead records.
- Ask the RAG agent a natural-language query for roofing opportunities in the area and show relevant results.
- Demonstrate filtering leads by roof age, permit status/open duration, and location radius.
- Show disabled/placeholder sections for future CRM expansions beyond lead identification.

## Out of Scope

- Property, permit, ownership, or enrichment data collection and ingestion pipelines (separate story).
- Live BBB API integration beyond displaying scores already present in available data.
- Actual outbound messaging to property owners (can be mocked or deferred).

## Reference

- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills)

---

# Phase 0 — Deployed Infrastructure

Phase 0 stands up the deployment substrate the acceptance criteria will be built on, and
proves the full request path works end to end against real AWS. None of the lead-identification
features above are implemented yet — see [Deferred](#deferred-to-later-phases).

## Live environment (`dev`, account `795366345505`, `us-east-2`)

|                         |                                                               |
| ----------------------- | ------------------------------------------------------------- |
| CRM UI                  | <https://d3jfjqgra0c58a.cloudfront.net>                       |
| tRPC API via CloudFront | `https://d3jfjqgra0c58a.cloudfront.net/trpc`                  |
| tRPC API direct         | `https://gnimgpcvq0.execute-api.us-east-2.amazonaws.com/trpc` |

## Architecture

```
CloudFront distribution
├── default behaviour  → S3 (private, Origin Access Control)   static SPA
└── /trpc/*            → API Gateway HTTP API → Lambda (tRPC)  → DynamoDB
```

The SPA and the API share one CloudFront hostname, so the browser calls `/trpc` as a
relative path. There is no CORS preflight and no API URL baked into the bundle.

Three stacks, deployed in dependency order:

- **`RoofingCrm-dev-Core`** — DynamoDB single table (`PK`/`SK`, `GSI1`, on-demand),
  SNS operations topic, PagerDuty routing-key secret, and the async alert notifier
  with its SQS dead-letter queue and DLQ-depth alarm.
- **`RoofingCrm-dev-Api`** — the tRPC `NodejsFunction` behind an API Gateway HTTP API
  on route `ANY /trpc/{proxy+}`.
- **`RoofingCrm-dev-Web`** — private S3 bucket, CloudFront distribution, and the
  bucket deployment that uploads `apps/crm/dist` and invalidates the cache.

### Single-table design

|      | PK              | SK     | GSI1PK | GSI1SK        |
| ---- | --------------- | ------ | ------ | ------------- |
| Lead | `LEAD#<leadId>` | `META` | `LEAD` | `<createdAt>` |

`GSI1` gives newest-first lead listing. Phase 0 ships the table and the read path only;
lead writes arrive with the CRM record feature.

### Observability

Every Lambda is created through the `ObservableFunction` construct, so the contract cannot
be forgotten on a new function: X-Ray active tracing, esbuild source maps wired to
`NODE_OPTIONS=--enable-source-maps`, a 90-day log group, and the Powertools service and
namespace variables. Metrics are emitted as EMF to the `RoofingCrm` namespace and
catalogued in [`observability/metrics.json`](observability/metrics.json).

The `AsyncObservableFunction` construct adds the failure plumbing an asynchronously
invoked Lambda owes: an SQS dead-letter queue plus exactly one self-resolving CloudWatch
alarm on queue depth, fanned out through the single SNS operations topic. The tRPC Lambda
is invoked synchronously by API Gateway, so it has no DLQ — API Gateway surfaces its
failures to the caller directly.

Cost-allocation tags (`project_name`, `environment`, `managed_by`, `phase`) are applied as
a CDK aspect over the whole app, which writes them onto every taggable resource rather
than only onto the CloudFormation stacks.

## Working locally

Requires Node 22, pnpm 11, and `just`.

```sh
just setup       # install workspace dependencies
just test        # vitest across all packages
just type-check
just lint
just build       # build the SPA, then synth every stack
```

`just dev` serves the SPA and proxies `/trpc` to `VITE_API_PROXY_TARGET`, which reproduces
the same-origin layout CloudFront provides in production:

```sh
VITE_API_PROXY_TARGET=https://gnimgpcvq0.execute-api.us-east-2.amazonaws.com pnpm dev
```

## Deploying

CDK is the only IaC in this repository.

```sh
just deploy    # cdk deploy --all
just destroy   # tear the environment down
```

The SPA must be built before synth because `WebStack` reads `apps/crm/dist` as an asset at
synth time; `just build` and `just deploy` both handle that ordering. Creating the
CloudFront distribution from cold takes roughly 30 minutes.

## Deferred to later phases

Phase 0 is infrastructure only. Not yet implemented:

- Map, radius search, GPS/pin-drop centring, and the aged-roof and open-permit filters.
- Permit, contractor, and BBB detail views.
- Lead CRUD — the table and its GSI read path exist, but no write or qualification logic.
- The RAG-backed natural-language agent.
- Authentication. Both the API and the CRM are currently public.
- A custom domain. `ApiStack` carries a shared-account domain map, but this standalone
  account has no hosted zone, so CloudFront supplies the stable public hostname instead.
- Registering the metrics in the shared Lexicon and dashboard repositories — those live in
  another GitHub organisation that is not reachable from this workspace, so
  `observability/metrics.json` is staged here for that registration.
- The PagerDuty routing key is a Secrets Manager-generated placeholder, and paging is
  gated off outside `prod`. An operator replaces the `routingKey` value to arm it.
