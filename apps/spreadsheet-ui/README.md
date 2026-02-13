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
- Formula and demo signed runs participate in signature-mismatch recovery refresh flow
- Preview panels show signature sync status (`in-sync` / `stale`) against latest execution
- Agent details panel can copy the most recent executed plan as a re-signed `agent/ops` payload
- Agent details panel surfaces `served_from_cache` when `agent/ops` responses are replayed by request id
- Agent details panel provides one-click replay of the latest `request_id` to validate idempotent cached responses
- Latest `request_id` replay now calls dedicated cache replay API (does not require local operation plan state)
- Cache replay responses hydrate both operation results and cached operation plan for follow-up copy/replay workflows
- API client error handling preserves backend error codes in thrown messages (e.g. `OPERATION_SIGNATURE_MISMATCH: ...`)
- Signature-related validation codes (`OPERATION_SIGNATURE_MISMATCH`, `INVALID_SIGNATURE_FORMAT`, `EMPTY_OPERATION_LIST`, `REQUEST_ID_CONFLICT`) map to recovery messaging in UI actions
- Signature recovery uses structured API error codes (not substring-only matching)
- Error banner displays backend error code badges when available for faster debugging
- Wizard and agent integration panels display discovered signature error-code lists from schema endpoints
- Agent integration panel displays discovered request-id idempotency cache size metadata
- Agent integration panel displays discovered cache stats/clear endpoint metadata from schema
- Agent integration panel shows live idempotency cache stats (entries/oldest/newest plus oldest/newest `cached_at`) with a clear-cache control
- Agent integration panel lists paged cached request IDs/signature prefixes plus per-entry operation/result counts with prefix filtering, newer/older pagination, and inspect/replay/rerun/copy/copy-ops/single-entry remove controls
- Cache list and detail inspector show when each request-id entry was cached (`cached_at`)
- Cache timestamps also display relative age labels (e.g., `2m ago`) for quick freshness checks
- Cache prefix filter offers one-click backend-derived suggestions with entry counts
- Cache detail inspector supports copy actions for full detail JSON and operations-only payload
- Prefix-filtered cache view supports one-click bulk removal of matching cached request IDs
- Prefix-filtered cache view includes a preview action that shows matched counts/sample IDs before bulk removal
- Prefix-removal preview supports configurable sample-size limits
- Prefix-removal preview sample IDs are clickable to open cache detail inspector directly
- Stale-cache controls support age-threshold preview/removal (`max_age_seconds`) backed by server-side `cached_at` cutoff
- Stale-cache preview/removal responses include cutoff timestamp and sample IDs for safe cleanup workflows
- Cache controls include optional rerun `request_id` override used by per-entry rerun action
- Success/info notice banner surfaces non-error outcomes (workbook import/create, cache clear, replay cache hit/miss)
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
