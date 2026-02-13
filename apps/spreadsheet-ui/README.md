# Spreadsheet UI (Next.js + React)

Frontend for the DuckDB-backed spreadsheet core.

## Features

- Excel-like grid interaction
- Formula bar editing
- Workbook import/export controls
- Export action surfaces backend compatibility-report counts and latest-export detail lists (preserved/transformed/unsupported)
- Realtime server stream sync via SSE
- Live chart preview with metadata sync endpoint
- Dynamic sheet tabs + add-sheet controls
- Agent batch execution + built-in preset runner
- Built-in scenario runner (seed/export orchestration)
- Wizard flow: optional XLSX upload + scenario execution in one action
- Wizard metadata discovery (schema/presets/scenarios) with scenario operation preview
- Wizard schema panel displays discovered run/import response fields for import metric awareness
- Wizard preset operation preview (global/workbook-scoped discovery)
- Wizard can toggle export payload embedding (`include_file_base64`) before execution
- Wizard can run selected scenario either on a new workbook flow or current workbook context
- Wizard supports running previewed operation plans via `agent/ops` and inspecting raw JSON payloads
- Import summaries (wizard + direct workbook import) show sheet/cell/formula counts, including cached vs uncached formula-cell coverage when formulas are present
- Latest import/export summaries auto-refresh from workbook SSE events (including agent-driven imports/exports)
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
- Agent integration panel displays discovered workbook import/export endpoint metadata from schema
- Agent integration panel displays discovered formula capability metadata from schema (supported/unsupported function behavior), including an explicit supported-function list/count
- Agent integration panel now expands workbook import response fields as dotted key paths with inline descriptions (e.g., `import.formula_cells_imported: ...`)
- Agent integration panel now expands export header schema fields with inline descriptions (e.g., `x-export-meta: ...`)
- Agent integration panel now also shows discovered workbook import/export event payload field shapes from schema
- Agent integration panel now includes a full workbook event-shape catalog (`workbook.created`, `sheet.added`, `cells.updated`, `formula.recalculated`, `chart.updated`, `workbook.imported`, `workbook.exported`) from schema metadata
- Agent integration panel shows live idempotency cache stats (`scoped/total/max` entries plus oldest/newest `cached_at`) with a clear-cache control, scoped by active age/prefix filters when provided
- Cache stats scope follows active prefix + age filters for consistent cache triage context
- Clear-cache action stays globally available under scoped filters (even when scoped entry count is zero)
- Clear-cache notices explicitly indicate global-scope clearing when filters are active
- Age-scoped cache stats/entries/prefix views surface backend cutoff timestamps for precise stale-window visibility
- Scoped cutoff timestamps also show relative-age labels for quick recency checks
- Stale preview/remove notices include scoped cutoff timestamp + relative age context
- Agent integration panel lists paged cached request IDs/signature prefixes plus per-entry operation/result counts with prefix + age filtering, newer/older pagination, and inspect/replay/rerun/copy/copy-ops/single-entry remove controls
- Cache entries pager shows scoped totals and global totals when filters narrow results
- Prefix suggestion row shows scoped/global prefix totals and active prefix scope echo when filters narrow suggestions
- Prefix suggestion row supports optional minimum-match filtering (`min prefix count`) for high-signal cache triage
- Prefix suggestion row supports optional minimum-timespan filtering (`min span (s)`) to focus on long-lived request-id families
- Prefix suggestion row supports optional maximum-timespan filtering (`max span (s)`) to focus on bursty/short-lived request-id families
- Prefix suggestion row enforces valid span ranges (`min span <= max span`) before querying
- Prefix suggestion row supports selectable sort mode (`count`, `recent`, `alpha`, or `span`) for cache triage priorities
- Prefix suggestion row supports configurable suggestion limit (`prefix limit`) for denser/sparser cache hinting
- Prefix suggestion row includes pager controls (`Newer`/`Older`) backed by server offset pagination
- Prefix suggestion summary shows prefix coverage plus entry coverage (`page/scoped/global`) for each suggestion page
- Prefix cache controls include one-click `Reset prefix scope` to clear prefix/min-count/min-span/max-span/sort/limit state
- Prefix suggestion row now shows an explicit empty-scope hint when active prefix/age filters yield zero suggestions
- Cache age-filter control validates positive integer seconds inline
- Prefix preview/remove actions are blocked while age-filter input is invalid
- Cache entries/prefix suggestion queries pause while age-filter input is invalid
- Prefix suggestion queries also pause while min-prefix-count input is invalid
- Prefix suggestion queries also pause while min-span input is invalid
- Prefix suggestion queries also pause while max-span input is invalid
- Prefix suggestion queries also pause while prefix-limit input is invalid
- Cache entries list and prefix suggestions are hidden while age-filter input is invalid
- Stale preview/remove actions are blocked while stale-age input is invalid
- Prefix/stale sample-limit inputs now enforce positive integer validation before preview/remove actions
- Stale preview/remove actions optionally inherit active prefix filter scope
- Stale preview panel and notices show scoped vs global stale-match counts when prefix filters narrow scope
- Stale/prefix preview panels reset when cache filter scopes change to avoid stale context
- Stale/prefix preview panels also reset when sample-limit inputs change
- Cache list and detail inspector show when each request-id entry was cached (`cached_at`)
- Cache timestamps also display relative age labels (e.g., `2m ago`) for quick freshness checks
- Cache prefix filter offers backend-derived suggestions with entry counts plus oldest/newest cached request-id metadata, relative freshness labels, and optional span hints; Shift+click a prefix chip to inspect its newest cached request id directly, or Alt+click to preview scoped prefix removal
- Prefix suggestion row now includes inline shortcut hints (`Shift+click inspect`, `Alt+click preview`)
- Cache detail inspector supports copy actions for full detail JSON and operations-only payload
- Cache detail inspector includes a one-click `Use prefix` action to apply the selected request-id prefix as the active cache filter
- Cache detail inspector also includes `Use + preview` to immediately open scoped prefix-removal preview from the selected request id
- Prefix-filtered cache view supports one-click bulk removal of matching cached request IDs
- Prefix-filtered cache view includes a preview action that shows matched counts/sample IDs before bulk removal
- Prefix preview/removal actions now inherit active age filter scope for stale-only cleanup
- Prefix preview/removal feedback now includes applied cutoff timestamp when age scope is active
- Prefix preview/removal feedback shows scoped vs global match counts when filters narrow scope
- Prefix-removal preview supports configurable sample-size limits
- Prefix-removal preview sample IDs are clickable to open cache detail inspector directly
- Stale-cache controls support age-threshold preview/removal (`max_age_seconds`) backed by server-side `cached_at` cutoff
- Stale-cache preview/removal responses include cutoff timestamp and sample IDs for safe cleanup workflows (with independent stale sample-limit input)
- Cache preview/removal sample limits are normalized to backend-safe `1..100` bounds
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
