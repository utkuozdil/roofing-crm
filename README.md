# Roofing CRM & Lead Identification UI

## Phase 6 — the map-based CRM

**Live URL:** https://d3jfjqgra0c58a.cloudfront.net

The map, radius search, lead filters, property detail, and lead CRUD are all implemented
and live. The RAG agent is mounted but not wired, and the property dataset is a seeded
fixture standing in for the ingestion pipeline — both are called out in
[Stubbed](#what-is-stubbed).

The CloudFront distribution serves both the SPA and the API from one origin, so the
browser never makes a cross-origin call and there is no API URL to inject at build time:

| Path       | Origin                  |
| ---------- | ----------------------- |
| `/trpc/*`  | API Gateway HTTP API    |
| everything | S3 (SPA, with fallback) |

### Layout

```
apps/crm             Vite + React SPA — map, filters, detail panel, lead pipeline
apps/api             tRPC router, property data source, Lambda handlers, and the CDK app
e2e                  Playwright suite that drives the deployed UI headlessly
packages/api-client  AppRouter type + preconfigured httpBatchLink client
packages/shared      property/permit/lead contract, geo maths, county gazetteer, table keys
packages/tsconfig    base / react / node compiler presets
```

`packages/shared` owns the single-table key patterns, so a key can never drift between
the Lambda that writes it and the CDK that provisions the table. It also owns the
property record contract, so the API, the fixture data source, and the UI cannot disagree
about a field name.

### Designed for a headless driver

The single hardest constraint on this UI is that it is evaluated by a headless browser,
which cannot reliably drag a map. So **no capability in this product is gesture-only**:

| Capability    | Map interaction   | Equivalent DOM control                                 |
| ------------- | ----------------- | ------------------------------------------------------ |
| Search centre | Click to drop pin | Text input accepting address, city, ZIP, or `lat,lon`  |
| Search centre | —                 | "Use my location" button (degrades when denied)        |
| Radius        | —                 | `<input type="range">` **and** `<input type="number">` |
| Pan / zoom    | —                 | Six buttons                                            |
| Open property | Click a pin       | Address button in the candidate table                  |

The map itself is a single SVG over static raster tiles rather than a mapping library.
Tiles are plain `<image>` elements, so an unreachable or blocked tile host leaves the
county outline, radius circle, and every result pin rendering normally. Result pins are
focusable `role="button"` circles with accessible names.

Interactive elements carry stable `data-testid` attributes. The results panel also
publishes the query its rows answer (`data-radius-miles`, `data-roof-age`,
`data-permit-status`, `data-searching`), because search is debounced and "no spinner" is
not proof a filter has taken effect.

### Radius search

Two-phase, implemented this way over fixtures because it is how it must work over real
data:

1. Compute every geohash-5 cell that can contain a point inside the radius and read only
   those buckets. The candidate set is bounded by area, not by dataset size.
2. Measure exact haversine distance on the candidates, discarding the bounding-box
   corners that fall outside the true circle.

A test asserts phase one agrees exactly with a brute-force sweep of the whole dataset at
five radii, because a prefix phase that dropped an in-radius point would silently hide
leads. The UI surfaces the cell and candidate counts per query.

### Roof age derivation

A signed-off roofing permit resets the roof clock; otherwise the roof is assumed original
to the structure. Two statuses deliberately do not reset it: an **unresolved** permit,
because the work was never certified complete — which is exactly the lead signal — and a
**voided** permit, because the work never happened.

The source has no explicit close date; a permit's resolution date is its terminal
inspection's Result Date. So `closed_date` can be absent even on resolved work, and
`permitDuration` reports that as `unrecorded` rather than a zero-day turnaround the county
never recorded.

### Missing data, and what the filters do about it

Field nullability is taken from measurements against the 181,218 ingested parcels rather
than guessed, and the fixture generator reproduces those rates
(`MEASURED_MISSING_RATES`) so the UI is exercised against the county's real sparsity.
Coordinates and the three valuation fields are always present; the gaps that matter:

| Gap                                          | Rate  | Treatment                                                                                            |
| -------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `primary_address`                            | 9.1%  | Titled `Parcel <id>` with the nearest municipality derived from its coordinates. Never filtered out. |
| `year_built`, and therefore `roof_age_years` | 10.6% | **Excluded by default** when a roof-age threshold is set. See below.                                 |
| `owner_name`                                 | 0.8%  | Rendered as "Owner not on record".                                                                   |

**The unknown-roof-age decision is explicit.** A roofing crew asking for roofs older than
15 years is asking for roofs, and a parcel with no building does not qualify — so
`includeUnknownRoofAge` defaults to `false`. Because that silently removes a tenth of the
county, the exclusion is not left implicit: the results header states how many in-radius
parcels were dropped and why, the "Include unknown roof age" checkbox reverses it, and the
detail panel explains per-parcel why a roof age could not be derived.

### Roofing permit classification

`is_roofing` is derived rather than waiting on the permit harvest, using the county's own
vocabulary from the Oracle repo's `docs/seminole-sources.yaml` (read, never modified):

- The nine roofing application-type codes out of 109 (`R100`, `EZRO`, `C110`, `C202`,
  `R200`, `R300`, `A998`, `C998`, `R800`), matched first.
- The `PermitType` column, which is a separate vocabulary (`RR`, `BPRF`).
- A narrow label match as a last resort, looking for roof _replacement_ wording so a roof
  deck or roof-mounted mechanical permit is not misread as reroofing.

Every classification reports `matched_on`, so a surprising result is auditable. The
vocabulary drifts over time — `EZRO` returned 211 rows for 2022-10 and none for 2026-08 —
so all nine codes classify regardless of whether they are currently in use.

Permit status maps to the county's seven observed values; anything outside them is
quarantined as `unknown` rather than bucketed, matching the source's `_unmapped:
alert_and_quarantine` rule. An application number is **not** unique — the natural key is
`(AppNo, StructureSequence, PermitTypeSequence)`, which `permitNaturalKey` builds.

`packages/shared/src/geo.test.ts` pins the ten coordinates on which this TypeScript
`encodeGeohash` was verified to agree exactly with the pipeline's Python encoder, so a
change to either that would make the prefix pass skip partitions fails a test.

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
just e2e-setup   # download the Chromium the e2e suite drives
just e2e         # Playwright against the deployed URL (override E2E_BASE_URL)
just build       # vite build, then cdk synth --strict
just deploy      # build, then cdk deploy --all
just destroy     # tear the environment down
```

`just test` is unit and CDK assertions only — it never launches a browser or touches AWS.
`just e2e` runs against a deployed URL on purpose: what needs proving is that CloudFront
and its tRPC origin work together, which a local dev server would not exercise.

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

# Deployed environment

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

`GSI1` gives newest-first lead listing. Create, read, update, and delete all go through
this one partition.

Both mutating paths (`updateLead`, `deleteLead`) are guarded on `attribute_exists(PK)`. A
bare `UpdateItem` creates the item when it is missing, so without the guard "update a
lead that was just deleted" would silently resurrect it as a keys-only ghost row; with it,
the API returns a real `NOT_FOUND`.

Lead mutations are **not** applied optimistically in the UI. An optimistic row looks
committed the instant it is clicked, which hides in-flight work — a reload landing on a
pending request discards it with no way to tell a saved change from a lost one. Instead
each row shows its own save state and the table only ever displays what the API confirmed.

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

## What is stubbed

Two things are deliberately not real, and the UI says so on screen rather than only here.

**The property dataset.** The Oracle ingestion pipeline that produces real Seminole County
parcels, permits, and BBB enrichment is a concurrent deliverable and was not available.
Rather than block on it or invent an API that does not exist, the record contract lives in
`packages/shared` as the single source of truth, and a seeded 360-row fixture dataset sits
behind a `PropertyDataSource` interface in `apps/api/src/data/`. Generation is deterministic
from a fixed seed, so a given parcel id always carries the same owner, permits, and
coordinates. Replacing it is one constructor call in `property-source.ts`; no UI change.
The Platform status view and the API's `properties.dataset` procedure both report
`provider: fixture` so synthetic rows are never presented as county records.

Two things about the fixture are now measured rather than invented: field nullability
matches the real ingested rates, and permit codes and statuses come from the county's
published vocabulary. No permits are ingested yet, so permit _rows_ remain synthetic even
though the codes they carry are real.

**The RAG agent.** `RagChatMount` is the seam the retrieval engine attaches to — a laid-out
panel with the controls it needs, held disabled and labelled "Not yet wired", showing the
live centre, radius, and filter set it will be handed. No LLM layer is built.

Also not implemented:

- Authentication. Both the API and the CRM are currently public.
- A custom domain. `ApiStack` carries a shared-account domain map, but this standalone
  account has no hosted zone, so CloudFront supplies the stable public hostname instead.
- Registering the metrics in the shared Lexicon and dashboard repositories — those live in
  another GitHub organisation that is not reachable from this workspace, so
  `observability/metrics.json` is staged here for that registration.
- The PagerDuty routing key is a Secrets Manager-generated placeholder, and paging is
  gated off outside `prod`. An operator replaces the `routingKey` value to arm it.
