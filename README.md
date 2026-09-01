# Roofing CRM — Seminole County, FL

A map for a roofing sales team to find work in Seminole County, Florida.

| | |
| --- | --- |
| **Live site** | https://d3jfjqgra0c58a.cloudfront.net |
| **Data source** | [Seminole pipeline](https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-seminole-fl) |
| **County** | Seminole County, FL (already selected) |

## What it does

1. Pick a centre and a radius.
2. See nearby properties that look like leads — older roofs, open permits, or both.
3. Open a property for owner, permits, contractor, and BBB rating (when we have one).
4. Save it as a lead and manage it in the pipeline.
5. Ask the RAG agent a question about roofing opportunities in the area.

## Features

| Feature | What you can do |
| --- | --- |
| Map & radius search | Set a centre and distance; browse pins and a candidate list side by side |
| Lead filters | Narrow by roof age, permit status, and how long a permit has been open |
| Ask the RAG agent | Type a question; see a briefing of retrieved properties, then the map and list match |
| Property detail | See owner, value, permits, contractor, and BBB; save as a lead |
| Lead pipeline | Filter saved leads by roof age, permit, and radius; update status, add notes, remove a lead |
| Coming later | Placeholders for the rest of a roofing CRM (not built) |

### Map & radius search

| Control | Options |
| --- | --- |
| Centre | City or ZIP, coordinates, pin on the map, phone location |
| Radius | Slider or number, 0.5–25 miles (orange circle on the map) |
| Move the map | North / west / east / south |
| Zoom | + / − or scroll wheel |
| Select a property | Click a list row or a pin — they stay in sync |

### Lead filters

| Filter | Default / options |
| --- | --- |
| Roof age | 15 years and older (raise or lower) |
| Permit status | Any history, no history, open, unresolved (still open) |
| Open duration | How many years a permit has been open |
| More | Extra filters and sort order |

### Ask the RAG agent

Type a question (or click an example). The agent:

1. Turns the question into the same filters as the panel (place, roof age, open roofing, and so on).
2. Retrieves the parcels that match — those rows are the only evidence it may use.
3. Ranks them by meaning (permit wording, contractor, BBB) after the filters have already decided who is allowed.
4. Writes a short briefing that names retrieved properties. It cannot invent a parcel.

The map, filters, and candidate list move with the answer. Cited addresses appear under the briefing.

The same question, on the same published snapshot, reuses the question embedding. A new county publish drops that cache so yesterday’s open permits are not ranked as today’s.

Examples on the page:

- Houses near Lake Mary with roofs over 20 years old
- Open roofing permits stuck for more than 3 years in Oviedo

### Property detail

Shown on every candidate:

- Address
- Owner
- Roof age
- Value

Shown when you open one:

- Permits (type of work, dates, how long open, contractor)
- BBB rating on the contractor, when we have one
- Save as a lead

### Lead pipeline

A separate view for leads saved from the map:

- Filter by roof age, permit status, how long a permit has been open, and distance from a city, ZIP, or pin
- Update status
- Add notes
- Remove a lead

### Coming later (not built)

Listed in the app as placeholders so the rest of a roofing CRM is visible:

- Estimates & proposals
- Crew scheduling & routing
- Contractor & BBB directory
- Storm event overlays
- Outreach campaigns
- Documents & photos
- Invoicing & payments
- Reporting & analytics
- Team & territories
- Integrations
- Settings & permissions
