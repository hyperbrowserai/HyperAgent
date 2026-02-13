# Spreadsheet UI (Next.js + React)

Frontend for the DuckDB-backed spreadsheet core.

## Features

- Excel-like grid interaction
- Formula bar editing
- Workbook import/export controls
- Realtime server stream sync via SSE
- Live chart preview with metadata sync endpoint
- Dynamic sheet tabs + add-sheet controls
- Agent batch execution + built-in preset runner
- Built-in scenario runner (seed/export orchestration)
- Wizard flow: optional XLSX upload + scenario execution in one action
- Wizard metadata discovery (schema/presets/scenarios) with scenario operation preview
- Wizard preset operation preview (global/workbook-scoped discovery)
- Wizard can toggle export payload embedding (`include_file_base64`) before execution
- Wizard can run selected scenario either on a new workbook flow or current workbook context
- Wizard supports running previewed operation plans via `agent/ops` and inspecting raw JSON payloads
- Wizard includes one-click copy of preset/scenario operation JSON for agent prompt/tool handoff
- Copied plan payloads include `operations_signature` for backend signature validation
- Wizard can copy signature-ready run payloads for preset/scenario endpoint calls
- Wizard can copy signature-ready `agent/ops` payloads directly from preset/scenario previews
- Run-payload copy actions fetch fresh signatures from preview endpoints before writing payloads
- Wizard preset preview supports direct run (preset endpoint) and run-as-ops execution on active workbook
- Run-as-ops actions re-sign plans with `/agent/ops/preview` immediately before execution
- Wizard preview panels indicate whether operation plans are global or workbook-scoped
- Wizard execution can pass preview signatures (`operations_signature`) to guard against stale plan drift
- Signature mismatch responses trigger automatic preview refresh to reduce stale-plan retries
- Agent integration panel surfaces discovered `agent/ops/preview` endpoint metadata
- Top-level preset/scenario run buttons also prefetch signatures before execution
- Selected preset/scenario controls and wizard runs also fetch fresh signatures before execution
- Formula-bar apply and agent demo flow also execute through signed `agent/ops` plans
- Preview panels show signature sync status (`in-sync` / `stale`) against latest execution
- Agent details panel can copy the most recent executed plan as a re-signed `agent/ops` payload
- Event stream viewer with per-event-type filtering

## Run

```bash
yarn dev
```

The app runs on `http://localhost:3000`.

By default it targets backend `http://localhost:8787`.

Optional override:

```bash
NEXT_PUBLIC_SPREADSHEET_API_URL=http://localhost:8787 yarn dev
```

## Build & Lint

```bash
yarn lint
yarn build
```
