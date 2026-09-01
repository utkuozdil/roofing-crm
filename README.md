# Roofing CRM — Seminole County, FL

Map CRM for finding roofing leads from the published Seminole County snapshot.

**Live:** https://d3jfjqgra0c58a.cloudfront.net

The SPA and API share that hostname (`/trpc` is the API). Ingestion lives in the [Oracle pipeline](https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-seminole-fl); this repo only reads `publish/`.

## What it does

- County-default map: typed centre, GPS, or pin; radius, roof age, permit status
- Candidate list, property/permit detail (contractor + BBB when present), lead create/manage
- Natural-language questions that set the same filters the form uses
- Disabled placeholders for later CRM surfaces

`unknown` permit status means unharvested, not closed. Unresolved filters only match a confirmed-open status.

## Layout

```
apps/crm             Vite + React SPA
apps/api             tRPC + CDK
e2e                  Playwright against the deployed URL
packages/api-client  typed tRPC client
packages/shared      property/permit/lead contract and county gazetteer
```

No map capability is gesture-only: radius is a slider and a number, pan/zoom are buttons, a list click equals a pin click.

## Commands

```sh
just setup
just test
just type-check
just e2e          # needs E2E_BASE_URL or the live CloudFront URL
just deploy       # build SPA, then cdk deploy --all
```

Local SPA with the deployed API:

```sh
VITE_API_PROXY_TARGET=https://gnimgpcvq0.execute-api.us-east-2.amazonaws.com pnpm dev
```

Account `795366345505`, region `us-east-2`. Stacks: Core (DynamoDB + alerts), Api, Web.
