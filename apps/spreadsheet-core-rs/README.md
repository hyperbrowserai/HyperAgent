# Spreadsheet Core (Rust + DuckDB)

Embedded DuckDB backend for an Excel-like spreadsheet experience with:

- Workbook/sheet/cell APIs
- Formula recalculation (`SUM`, `AVERAGE`, `MIN`, `MAX`, `STDEV`, `STDEVP`, `STDEV.P`, `STDEV.S`, `VAR`, `VARP`, `VAR.P`, `VAR.S`, `COUNT`, `MEDIAN`, `COUNTA`, `COUNTBLANK`, `COUNTIF`, `COUNTIFS`, `RANK`/`RANK.EQ`, `LARGE`, `SMALL`, `PERCENTILE`, `PERCENTILE.INC`, `PERCENTILE.EXC`, `QUARTILE`, `QUARTILE.INC`, `QUARTILE.EXC`, `MODE.SNGL`, `GEOMEAN`, `HARMEAN`, `TRIMMEAN`, `DEVSQ`, `AVEDEV`, `AVERAGEA`, `STDEVA`, `STDEVPA`, `VARA`, `VARPA`, `COVARIANCE.P`, `COVARIANCE.S`, `COVAR`, `CORREL`, `PEARSON`, `SLOPE`, `INTERCEPT`, `RSQ`, `FORECAST.LINEAR`, `FORECAST`, `STEYX`, `PERCENTRANK`, `PERCENTRANK.INC`, `PERCENTRANK.EXC`, `PRODUCT`, `SUMSQ`, `SUMPRODUCT`, `SUMXMY2`, `SUMX2MY2`, `SUMX2PY2`, `SKEW`, `SKEW.P`, `KURT`, `FISHER`, `FISHERINV`, `SUMIF`, `SUMIFS`, `MINIFS`, `MAXIFS`, `AVERAGEIF`, `AVERAGEIFS`, direct refs, arithmetic refs, `IF`, `IFERROR`, `CHOOSE`, `TRUE`, `FALSE`, `AND`/`OR`/`XOR`/`NOT`, `CONCAT`/`CONCATENATE`, `LEN`, `PI`, `ABS`, `FACT`, `FACTDOUBLE`, `COMBIN`, `COMBINA`, `PERMUT`, `PERMUTATIONA`, `MULTINOMIAL`, `GCD`, `LCM`, `LN`, `EXP`, `LOG`, `LOG10`, `SIN`/`COS`/`TAN`, `SINH`/`COSH`/`TANH`, `ASIN`/`ACOS`/`ATAN`/`ATAN2`, `DEGREES`/`RADIANS`, `ROUND`/`ROUNDUP`/`ROUNDDOWN`, `CEILING`/`FLOOR`, `SQRT`, `POWER`, `MOD`, `QUOTIENT`, `MROUND`, `SIGN`, `INT`, `EVEN`, `ODD`, `TRUNC`, `EXACT`, `LEFT`/`RIGHT`/`MID`, `REPT`, `REPLACE`, `SUBSTITUTE`, `VALUE`, `N`, `T`, `CHAR`, `CODE`, `UNICHAR`, `UNICODE`, `SEARCH`, `FIND`, `UPPER`/`LOWER`/`TRIM`, `ISBLANK`/`ISNUMBER`/`ISTEXT`/`ISEVEN`/`ISODD`, `TODAY`, `NOW`, `RAND`, `RANDBETWEEN`, `DATE`, `YEAR`/`MONTH`/`DAY`, `WEEKDAY`, `WEEKNUM`, `ROW`/`COLUMN`/`ROWS`/`COLUMNS`, `HOUR`/`MINUTE`/`SECOND`, `VLOOKUP` exact-match mode, `HLOOKUP` exact-match mode, `XLOOKUP` exact-match mode, `MATCH` exact-match mode, `INDEX`)
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
- `GET /v1/workbooks/{id}/agent/ops/cache?request_id_prefix=scenario-&max_age_seconds=3600` (includes scoped `entries`, global `unscoped_entries`, oldest/newest request ids, and `oldest_cached_at` / `newest_cached_at`; optional **non-blank** prefix + age scope; returns `cutoff_timestamp` when age-scoped)
- `GET /v1/workbooks/{id}/agent/ops/cache/entries`
- `GET /v1/workbooks/{id}/agent/ops/cache/entries/{request_id}`
- `GET /v1/workbooks/{id}/agent/ops/cache/prefixes`
- `POST /v1/workbooks/{id}/agent/ops/cache/clear`
- `POST /v1/workbooks/{id}/agent/ops/cache/replay`
- `POST /v1/workbooks/{id}/agent/ops/cache/reexecute`
- `POST /v1/workbooks/{id}/agent/ops/cache/remove`
- `POST /v1/workbooks/{id}/agent/ops/cache/remove-by-prefix`
- `POST /v1/workbooks/{id}/agent/ops/cache/remove-by-prefix/preview`
- `POST /v1/workbooks/{id}/agent/ops/cache/remove-stale`
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

`POST /v1/workbooks/import` returns:
- `workbook`
- `import.sheets_imported`
- `import.cells_imported`
- `import.formula_cells_imported`
- `import.formula_cells_with_cached_values`
- `import.formula_cells_without_cached_values`
- `import.warnings`

> Note: `/v1/workbooks/{id}/duckdb/query` currently returns a guarded `400` response in this build to avoid a known upstream panic in the underlying DuckDB Rust wrapper for ad-hoc SQL execution paths.

`POST /v1/workbooks/{id}/export` responds with the XLSX file body and an `x-export-meta` header containing JSON compatibility-report metadata (`preserved`, `transformed`, `unsupported`).

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
  - `INVALID_NEW_REQUEST_ID`
  - `INVALID_MAX_AGE_SECONDS`
  - `INVALID_MIN_ENTRY_COUNT`
  - `INVALID_MIN_SPAN_SECONDS`
  - `INVALID_MAX_SPAN_SECONDS`
  - `INVALID_SPAN_RANGE`
  - `INVALID_PREFIX_SORT_BY`
  - `INVALID_REQUEST_ID_PREFIX`
  - `CACHE_ENTRY_NOT_FOUND`

Schema discovery endpoints (`/v1/workbooks/{id}/agent/schema`, `/v1/agent/wizard/schema`) expose these under `signature_error_codes`.
The in-memory request-id idempotency cache keeps up to **256** recent `agent/ops` responses per workbook (oldest entries evict first).
`/v1/workbooks/{id}/agent/schema` also advertises workbook import/export endpoint metadata (including `x-export-meta` header shape, import formula-metric response fields, formula capability metadata with both summary strings and structured lists, and a workbook event-shape catalog for `workbook.created`, `sheet.added`, `cells.updated`, `formula.recalculated`, `chart.updated`, `workbook.imported`, and `workbook.exported`) for agent discoverability.
`/v1/agent/wizard/schema` includes run/import response-shape metadata plus formula capability metadata (summary + structured lists) so agent callers can discover wizard import metric fields and supported formula families without trial calls.

Plan-preview helper:
- `POST /v1/workbooks/{id}/agent/ops/preview` returns `{ operations_signature, operations }` without executing.

Cache helpers:
- `GET /v1/workbooks/{id}/agent/ops/cache`
- `GET /v1/workbooks/{id}/agent/ops/cache/entries?request_id_prefix=demo&max_age_seconds=3600&offset=0&limit=20` (newest-first paged request-id summaries, optional **non-blank** prefix filter, optional age filter for stale-only browsing, `limit` clamped to `1..200`, includes `total_entries`, `unscoped_total_entries`, operation/result counts, `cached_at`, and scoped `cutoff_timestamp`)
- `GET /v1/workbooks/{id}/agent/ops/cache/entries/{request_id}` (full cached detail: response + operations + counts + `cached_at`)
- `GET /v1/workbooks/{id}/agent/ops/cache/prefixes?request_id_prefix=scenario-&min_entry_count=2&min_span_seconds=60&max_span_seconds=86400&sort_by=recent&offset=0&limit=8&max_age_seconds=3600` (prefix suggestions with counts for filter UX; optional **non-blank** request-id prefix + age filters, optional `min_entry_count > 0`, optional `min_span_seconds > 0`, optional `max_span_seconds > 0` (and when both span bounds are supplied, `min_span_seconds <= max_span_seconds`), optional `sort_by` (`count`, `recent`, `alpha`, or `span`), optional `offset` pagination, `limit` clamped to `1..100`, includes `total_prefixes`, `unscoped_total_prefixes`, `unscoped_total_entries`, `scoped_total_entries`, `returned_entry_count`, echoed `request_id_prefix`, applied `min_entry_count`, echoed `min_span_seconds`, echoed `max_span_seconds`, applied `sort_by`, scoped `cutoff_timestamp`, paging metadata (`offset`, `has_more`), and per-prefix oldest/newest request-id + timestamp metadata plus timespan (`oldest_request_id`, `oldest_cached_at`, `newest_request_id`, `newest_cached_at`, `span_seconds`))
- `POST /v1/workbooks/{id}/agent/ops/cache/clear`
- `POST /v1/workbooks/{id}/agent/ops/cache/replay` with `{ "request_id": "..." }` (returns `{ cached_response, operations }` where `operations` are the original cached ops payload)
- `POST /v1/workbooks/{id}/agent/ops/cache/reexecute` with `{ "request_id": "...", "new_request_id": "..." }` (reexecutes cached operations as fresh `agent/ops`)
- `POST /v1/workbooks/{id}/agent/ops/cache/remove` with `{ "request_id": "..." }`
- `POST /v1/workbooks/{id}/agent/ops/cache/remove-by-prefix` with `{ "request_id_prefix": "scenario-", "max_age_seconds": 3600 }` (`max_age_seconds` optional for stale-only prefix cleanup; response includes scoped `removed_entries`, global `unscoped_matched_entries`, and `cutoff_timestamp` when age filter is applied)
- `POST /v1/workbooks/{id}/agent/ops/cache/remove-by-prefix/preview` with `{ "request_id_prefix": "scenario-", "max_age_seconds": 3600, "sample_limit": 10 }` (optional sample_limit clamped to `1..100`; optional age filter; reports scoped `matched_entries`, global `unscoped_matched_entries`, sample IDs, and scoped `cutoff_timestamp`)
- `POST /v1/workbooks/{id}/agent/ops/cache/remove-stale` with `{ "request_id_prefix": "scenario-", "max_age_seconds": 3600, "dry_run": true, "sample_limit": 10 }` (`request_id_prefix` optional for scoped stale cleanup; response includes both scoped `matched_entries` and global `unscoped_matched_entries`; `dry_run` previews stale matches based on `cached_at` cutoff and returns sample IDs; sample_limit clamped to `1..100`)

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
