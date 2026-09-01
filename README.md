# Roofing CRM & Lead Identification UI

## Phase 6 — the map-based CRM

**Live URL:** https://d3jfjqgra0c58a.cloudfront.net

The map, radius search, lead filters, property detail, lead CRUD, and the
natural-language query panel are all implemented and live, serving the **181,218 real
Seminole County parcels** published by the ingestion pipeline. What remains deliberately
absent is called out in [Stubbed](#what-is-stubbed) — most importantly, the published
snapshot carries no permit history, and the UI refuses permit questions rather than
answering them from parcels alone.

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
| Search centre | —                 | "Use my location" button (GPS; degrades when denied)   |
| Radius        | —                 | `<input type="range">` **and** `<input type="number">` |
| Pan / zoom    | —                 | Six buttons                                            |
| Open property | Click a pin       | Address button in the candidate table                  |

**GPS is written for the case where it fails.** A headless browser refuses geolocation, an
insecure origin exposes no API at all, and a real user may simply decline. Each of those
resolves to a stated status line — the deployed site reports "Location permission was denied.
The map kept its previous centre" under Playwright — and leaves the existing centre alone. A
fix outside Seminole County is reported rather than used, because centring there would return
nothing and read as a failed search instead of a device that is somewhere else. Nothing in
the product is reachable only through GPS.

The map itself is a single SVG over static raster tiles rather than a mapping library.
Tiles are plain `<image>` elements, so an unreachable or blocked tile host leaves the
county outline, radius circle, and every result pin rendering normally. Result pins are
focusable `role="button"` circles with accessible names.

Interactive elements carry stable `data-testid` attributes. The results panel also
publishes the query its rows answer (`data-radius-miles`, `data-roof-age`,
`data-permit-status`, `data-searching`), because search is debounced and "no spinner" is
not proof a filter has taken effect.

### Radius search

Two-phase, which is what keeps it fast over 181,218 parcels:

1. Compute every geohash-5 cell that can contain a point inside the radius and read only
   those buckets. The candidate set is bounded by area, not by dataset size.
2. Measure exact haversine distance on the candidates, discarding the bounding-box
   corners that fall outside the true circle.

A 3-mile search reads 9 of the county's 56 partitions and measures 48,011 candidates
instead of all 181,218; a 1-mile search reads 2 and measures 10,769. A test asserts phase
one agrees exactly with a brute-force sweep of the whole dataset at five radii, because a
prefix phase that dropped an in-radius point would silently hide leads. The UI surfaces
the cell and candidate counts per query.

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

These are the county's own gaps, served straight from the published snapshot; the test
fixture reproduces the same rates (`MEASURED_MISSING_RATES`) so unit tests exercise them
too. Coordinates and the three valuation fields are always present; the gaps that matter:

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

### The property dataset

The CRM reads the ingestion pipeline's **published** interface and nothing else: the
partitioned Parquet under `publish/` in the pipeline's data bucket, located through
`publish/current.json` so a new snapshot is picked up without a redeploy and without a
snapshot id hard-coded here. No pipeline internals, no second copy of the pipeline, and
IAM enforces it — `s3:GetObject` is granted on `publish/*` only, and `s3:ListBucket`
carries a matching prefix condition.

| Snapshot `recon-verify-1788271882` |                                          |
| ---------------------------------- | ---------------------------------------- |
| Parcels                            | 181,218                                  |
| Objects read                       | 56, one per geohash-5 partition, 40.7 MB |
| Coordinate coverage                | 100%                                     |
| Permit history                     | not published                            |

Parsed with `hyparquet` and **transposed into columns as each partition arrives** —
`Int32Array`/`Float64Array` for numerics, dictionary-coded strings for low-cardinality
text, packed bit flags for booleans. Holding 181,218 rows as plain objects costs 785 MB of
heap, which fits in no reasonable Lambda; the columnar snapshot settles at ~129 MB, and the
row-shaped `PropertyDetail` is materialised only for the rows actually rendered. The
approach is taken from the pipeline repo's `parcel-store.ts` rather than rediscovered.

Filters run as column-wise predicates over the typed arrays, so a 25-mile county-wide
search never allocates 181,218 objects. `apps/api/src/data/published-source.test.ts` asserts
the column predicate agrees with the shared `matchesFilters` row predicate, because two
implementations of one filter set is exactly where a quiet disagreement would live.

The 2048 MB Lambda is bought for CPU, not bytes: decompressing and transposing the snapshot
is CPU-bound and Lambda scales vCPU with memory.

The seeded 360-row fixture is kept as a test source. `properties.dataset` reports which one
is serving — `published-parquet` or `fixture` — and the Platform status view shows it, so
synthetic rows can never pose as county records.

### Natural-language query

One model call, `generateObject` against a Zod schema, on
`us.anthropic.claude-haiku-4-5-20251001-v1:0` through Bedrock with the Lambda's execution
role — no API key to configure, rotate, or leak. The model's only job is to fill in a filter
set from one sentence. It never sees a property row, so it has nothing to be confidently
wrong about, and it never produces a count.

Everything after the parse is deterministic. A grounding layer resolves places against the
county gazetteer (a name it cannot resolve is refused, not guessed at), derives the radius
and location mode from the question text, and rejects anything out of scope. The count is
then measured by running the grounded filters through the same `PropertyDataSource.search`
the SPA is about to call — so "22,817 matches" is the cardinality of the filter set, checked
by the predicate the rows are checked by.

The panel returns a query, an interpretation, and a count — never rows. The SPA applies that
query to the same state its own controls write to, so the map, the filter inputs, and the
results list move together, and a filter the chat set stays adjustable by hand. There is no
second result set that can drift out of agreement with the first.

Repeated questions are cached per container, keyed on the question text and the date — not on
the map position, because "here" is resolved after the parse, so keying on coordinates would
miss on every pixel of map movement while changing no answer. `maxOutputTokens` is 400: the
draft is about twenty short fields, and a larger ceiling would only let a confused generation
run on while the operator waits.

`e2e/nlq.spec.ts` asserts the link between the interpretation and the rows rather than the
prose: both panels publish the filters they claim, the suite checks they agree, and checks
the rendered rows satisfy them. That is only possible because the parse is structured.

### Measured against the deployed site

Every number here is from the live API over the published snapshot, not from the fixture.
Counts are `properties.search` totals for the query the panel echoed back.

| Question                                                                        | Interpreted as                                                          | Matches |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------- |
| Show me houses with roofs older than 20 years within 5 miles of Sanford         | 5 mi of Sanford 32771, roof ≥ 20 yrs, residential                       | 22,817  |
| Which homes near Oviedo have a pool and an old roof?                            | 5 mi of Oviedo 32765, roof ≥ 20 yrs, has pool, residential              | 12,078  |
| Find absentee owners in Winter Springs with roofs over 25 years old             | 5 mi of Winter Springs 32708, roof ≥ 25 yrs, owner mails outside county | 4,256   |
| Properties in Lake Mary worth more than $400,000 that have not sold in 10 years | 5 mi of Lake Mary 32746, no sale in 10 yrs, just value ≥ $400,000       | 9,024   |
| Roofing permits open more than 3 years in Altamonte Springs                     | refused — the published dataset carries no permit history               | —       |
| What is the weather in Miami?                                                   | refused — not a property search                                         | —       |
| Show me parcels in Orange County                                                | refused — outside Seminole County                                       | —       |

County-wide, 181,218 parcels are reachable within the 25-mile cap; 19,239 have no derivable
roof age, and the default 15-year threshold matches 143,051.

Latency, measured end to end from a laptop against `us-east-2`:

| Path                        | Cold                                      | Warm                            |
| --------------------------- | ----------------------------------------- | ------------------------------- |
| Search                      | ~4.1 s (3.0 s of it loading the snapshot) | 9–270 ms server-side, avg 86 ms |
| Chat, new question          | ~5.2 s                                    | 1.2–2.0 s                       |
| Chat, question asked before | —                                         | ~0.2 s (cached)                 |

Cold means a container that has not yet read the snapshot: 838 ms fetching 56 objects, 495 ms
parsing and transposing, ~700 ms Node init. Peak Lambda memory is 443 MB of the 2048 MB
provisioned, ~129 MB of which is the snapshot itself.

### Stacks

Deployed to account `795366345505`, region `us-east-2`, bootstrap qualifier `hnb659fds`.

- **Core** — DynamoDB single table (on-demand, `PK`/`SK`, `GSI1` for lead recency), the
  operations SNS topic, the stubbed PagerDuty routing-key secret, and the alert notifier
  Lambda with its DLQ and alarm.
- **Api** — the tRPC Lambda behind an API Gateway HTTP API, with read access to the
  pipeline's `publish/` prefix and `bedrock:InvokeModel` on the pinned model.
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

**Permit history is not in the published dataset.** The snapshot is one row per parcel;
the permit harvest is a separate pipeline deliverable and has not been published. The
assignment's second lead criterion — roofing permits left open for years — therefore cannot
be answered from this data, and the product says so in three places rather than degrading
quietly:

- The permit filter and permit-age input are disabled with the reason on the control, and
  `permit_age` is not offered as a sort.
- `properties.search` returns any filter it could not evaluate in `unsupportedFilters`, so
  a dropped clause is reported rather than assumed.
- A natural-language permit question is **refused**, not answered. Dropping the permit
  clause would turn "roofing permits open more than 3 years in Altamonte Springs" into
  "parcels near Altamonte Springs" and return thousands of rows to a question nobody asked.
  The model is also told the dataset has no permits, so its own refusal wording cannot
  promise a capability this deployment lacks.

A parcel's detail panel distinguishes "no permits on record for this parcel" from "permit
history is not part of the published dataset" — the second is a fact about the dataset, and
stating the first instead would be a claim about the parcel that nothing supports.

Permit _classification_ is built and unit-tested against the county's real vocabulary, so
the harvest can be wired in without touching the UI: `PropertyDataSource.permitsAvailable`
flips to `true` and every control above re-enables itself.

Also not implemented:

- Authentication. Both the API and the CRM are currently public.
- A custom domain. `ApiStack` carries a shared-account domain map, but this standalone
  account has no hosted zone, so CloudFront supplies the stable public hostname instead.
- Registering the metrics in the shared Lexicon and dashboard repositories — those live in
  another GitHub organisation that is not reachable from this workspace, so
  `observability/metrics.json` is staged here for that registration.
- The PagerDuty routing key is a Secrets Manager-generated placeholder, and paging is
  gated off outside `prod`. An operator replaces the `routingKey` value to arm it.
