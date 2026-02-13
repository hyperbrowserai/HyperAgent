# Spreadsheet Core (Rust + DuckDB)

Embedded DuckDB backend for an Excel-like spreadsheet experience with:

- Workbook/sheet/cell APIs
- Formula recalculation (`SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, direct refs, arithmetic refs)
- XLSX import/export
- Chart metadata endpoints
- Real-time SSE event stream for UI synchronization

## Run

```bash
cargo run
```

Server defaults to `http://localhost:8787`.

### Useful environment variables

- `PORT` — API port (default `8787`)
- `SPREADSHEET_DATA_DIR` — location for workbook DuckDB files (default `./data`)

## Key Endpoints

- `GET /v1/agent/wizard/schema`
- `GET /v1/agent/wizard/presets`
- `GET /v1/agent/wizard/presets/{preset}/operations`
- `GET /v1/agent/wizard/scenarios`
- `GET /v1/agent/wizard/scenarios/{scenario}/operations`
- `POST /v1/agent/wizard/run`
- `POST /v1/agent/wizard/run-json`
- `POST /v1/workbooks`
- `POST /v1/workbooks/import`
- `GET /v1/workbooks/{id}`
- `GET /v1/workbooks/{id}/sheets`
- `POST /v1/workbooks/{id}/sheets`
- `POST /v1/workbooks/{id}/cells/set-batch`
- `POST /v1/workbooks/{id}/agent/ops` (recommended for AI agents)
- `POST /v1/workbooks/{id}/agent/ops/preview`
- `GET /v1/workbooks/{id}/agent/ops/cache`
- `GET /v1/workbooks/{id}/agent/ops/cache/entries`
- `POST /v1/workbooks/{id}/agent/ops/cache/clear`
- `POST /v1/workbooks/{id}/agent/ops/cache/replay`
- `POST /v1/workbooks/{id}/agent/ops/cache/remove`
- `GET /v1/workbooks/{id}/agent/schema`
- `GET /v1/workbooks/{id}/agent/presets`
- `GET /v1/workbooks/{id}/agent/presets/{preset}/operations`
- `POST /v1/workbooks/{id}/agent/presets/{preset}`
- `GET /v1/workbooks/{id}/agent/scenarios`
- `GET /v1/workbooks/{id}/agent/scenarios/{scenario}/operations`
- `POST /v1/workbooks/{id}/agent/scenarios/{scenario}`
- `POST /v1/workbooks/{id}/cells/get`
- `POST /v1/workbooks/{id}/formulas/recalculate`
- `POST /v1/workbooks/{id}/charts/upsert`
- `POST /v1/workbooks/{id}/export`
- `GET /v1/workbooks/{id}/events`
- `GET /v1/openapi`

> Note: `/v1/workbooks/{id}/duckdb/query` currently returns a guarded `400` response in this build to avoid a known upstream panic in the underlying DuckDB Rust wrapper for ad-hoc SQL execution paths.

### AI Agent multi-operation endpoint

`POST /v1/workbooks/{id}/agent/ops` executes a list of typed operations in order and returns per-operation results.

Request options:
- `request_id` (optional): caller correlation ID echoed in response. Reusing same `request_id` returns cached response for idempotency.
- `actor` (optional): appears in emitted workbook events.
- `stop_on_error` (optional, default `false`): stop processing remaining operations after first failure.
- `expected_operations_signature` (optional): verify operation payload integrity before execution. Must be a 64-character hexadecimal string (case-insensitive).
- `operations` must be a non-empty array.

Response includes:
- `operations_signature` — sha256 signature over submitted operations.
- `served_from_cache` — indicates whether response was reused from request-id idempotency cache.
- Signature-related validation error codes:
  - `INVALID_SIGNATURE_FORMAT`
  - `OPERATION_SIGNATURE_MISMATCH`
  - `EMPTY_OPERATION_LIST`
  - `REQUEST_ID_CONFLICT` (same `request_id` reused with a different operation signature)
- Cache-management validation error codes:
  - `INVALID_REQUEST_ID`
  - `CACHE_ENTRY_NOT_FOUND`

Schema discovery endpoints (`/v1/workbooks/{id}/agent/schema`, `/v1/agent/wizard/schema`) expose these under `signature_error_codes`.
The in-memory request-id idempotency cache keeps up to **256** recent `agent/ops` responses per workbook (oldest entries evict first).

Plan-preview helper:
- `POST /v1/workbooks/{id}/agent/ops/preview` returns `{ operations_signature, operations }` without executing.

Cache helpers:
- `GET /v1/workbooks/{id}/agent/ops/cache`
- `GET /v1/workbooks/{id}/agent/ops/cache/entries?offset=0&limit=20` (newest-first paged request-id summaries, max `limit=200`)
- `POST /v1/workbooks/{id}/agent/ops/cache/clear`
- `POST /v1/workbooks/{id}/agent/ops/cache/replay` with `{ "request_id": "..." }` (returns cached `agent/ops` response)
- `POST /v1/workbooks/{id}/agent/ops/cache/remove` with `{ "request_id": "..." }`

Supported `op_type` values:
- `get_workbook`
- `list_sheets`
- `create_sheet`
- `set_cells`
- `get_cells`
- `recalculate`
- `upsert_chart`
- `export_workbook` (`include_file_base64` optional, default `true`)

### AI Agent preset endpoint

`POST /v1/workbooks/{id}/agent/presets/{preset}` runs a built-in workflow with minimal payload.

Supported `preset` values:
- `seed_sales_demo` — fills demo regional sales, recalculates formulas, syncs chart metadata.
- `export_snapshot` — recalculates and exports workbook (can include base64 file payload).

Preview helper:
- `GET /v1/workbooks/{id}/agent/presets/{preset}/operations` (optional query: `include_file_base64=true|false`)
- Preview responses include `operations_signature` (sha256) for optimistic signature checks.
- Run payload supports `expected_operations_signature` to guard against stale preview execution.

### AI Agent scenario endpoint

`POST /v1/workbooks/{id}/agent/scenarios/{scenario}` runs a higher-level built-in workflow composed from presets.

Supported `scenario` values:
- `seed_then_export` — executes `seed_sales_demo`, then `export_snapshot`.
- `refresh_and_export` — executes `export_snapshot`.

Preview helper:
- `GET /v1/workbooks/{id}/agent/scenarios/{scenario}/operations` (optional query: `include_file_base64=true|false`)
- Preview responses include `operations_signature` (sha256) for optimistic signature checks.
- Run payload supports `expected_operations_signature` to guard against stale preview execution.

### AI Agent wizard endpoint

`POST /v1/agent/wizard/run` creates a workbook, optionally imports an `.xlsx`, then runs a selected scenario.
`POST /v1/agent/wizard/run-json` provides the same flow for AI clients that prefer JSON payloads (with optional `file_base64`).

Discovery helpers:
- `GET /v1/agent/wizard/schema`
- `GET /v1/agent/wizard/presets`
- `GET /v1/agent/wizard/presets/{preset}/operations` (optional query: `include_file_base64=true|false`)
- `GET /v1/agent/wizard/scenarios`
- `GET /v1/agent/wizard/scenarios/{scenario}/operations` (optional query: `include_file_base64=true|false`)

Multipart fields:
- `scenario` (required)
- `file` (optional `.xlsx`)
- `workbook_name` (optional)
- `request_id` (optional)
- `actor` (optional)
- `stop_on_error` (optional boolean)
- `include_file_base64` (optional boolean)
- `expected_operations_signature` (optional string from scenario preview endpoint)

### Example: run an agent operation batch

```bash
curl -X POST "http://localhost:8787/v1/workbooks/<WORKBOOK_ID>/agent/ops" \
  -H "content-type: application/json" \
  -d '{
    "request_id": "ops-demo-1",
    "actor": "demo-agent",
    "stop_on_error": true,
    "operations": [
      {
        "op_type": "create_sheet",
        "sheet": "Data"
      },
      {
        "op_type": "set_cells",
        "sheet": "Data",
        "cells": [
          { "row": 1, "col": 1, "value": "Region" },
          { "row": 1, "col": 2, "value": "Revenue" },
          { "row": 2, "col": 1, "value": "North" },
          { "row": 2, "col": 2, "value": 120 }
        ]
      },
      {
        "op_type": "export_workbook",
        "include_file_base64": false
      }
    ]
  }'
```

### Example: preview/sign an ops plan, then execute

```bash
PREVIEW=$(curl -s -X POST "http://localhost:8787/v1/workbooks/<WORKBOOK_ID>/agent/ops/preview" \
  -H "content-type: application/json" \
  -d '{
    "operations": [
      { "op_type": "recalculate" },
      { "op_type": "export_workbook", "include_file_base64": false }
    ]
  }')

SIG=$(echo "$PREVIEW" | jq -r '.operations_signature')
OPS=$(echo "$PREVIEW" | jq '.operations')

curl -X POST "http://localhost:8787/v1/workbooks/<WORKBOOK_ID>/agent/ops" \
  -H "content-type: application/json" \
  -d "{
    \"request_id\": \"ops-signed-1\",
    \"expected_operations_signature\": \"$SIG\",
    \"operations\": $OPS
  }"
```

### Example: discover and run built-in presets

```bash
curl "http://localhost:8787/v1/workbooks/<WORKBOOK_ID>/agent/presets"

curl -X POST "http://localhost:8787/v1/workbooks/<WORKBOOK_ID>/agent/presets/seed_sales_demo" \
  -H "content-type: application/json" \
  -d '{ "request_id": "preset-seed-1", "actor": "demo-agent", "stop_on_error": true }'
```

### Example: run wizard (import + scenario)

```bash
curl -X POST "http://localhost:8787/v1/agent/wizard/run" \
  -F "scenario=seed_then_export" \
  -F "file=@./a.xlsx" \
  -F "request_id=wizard-1" \
  -F "include_file_base64=false"
```

### Example: run wizard JSON endpoint

```bash
curl -X POST "http://localhost:8787/v1/agent/wizard/run-json" \
  -H "content-type: application/json" \
  -d '{
    "scenario": "refresh_and_export",
    "request_id": "wizard-json-1",
    "include_file_base64": false
  }'
```

## Testing

```bash
cargo test
```
