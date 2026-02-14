# Spreadsheet Core (Rust + DuckDB)

Embedded DuckDB backend for an Excel-like spreadsheet experience with:

- Workbook/sheet/cell APIs
- Formula recalculation (`SUM`, `SUMA`, `AVERAGE`, `MIN`, `MAX`, `MINA`, `MAXA`, `STDEV`, `STDEVP`, `STDEV.P`, `STDEV.S`, `VAR`, `VARP`, `VAR.P`, `VAR.S`, `COUNT`, `MEDIAN`, `COUNTA`, `COUNTBLANK`, `COUNTIF`, `COUNTIFS`, `RANK`/`RANK.EQ`, `LARGE`, `SMALL`, `PERCENTILE`, `PERCENTILE.INC`, `PERCENTILE.EXC`, `QUARTILE`, `QUARTILE.INC`, `QUARTILE.EXC`, `MODE.SNGL`, `GEOMEAN`, `HARMEAN`, `TRIMMEAN`, `DEVSQ`, `AVEDEV`, `AVERAGEA`, `STDEVA`, `STDEVPA`, `VARA`, `VARPA`, `COVARIANCE.P`, `COVARIANCE.S`, `COVAR`, `CORREL`, `PEARSON`, `SLOPE`, `INTERCEPT`, `RSQ`, `FORECAST.LINEAR`, `FORECAST`, `STEYX`, `PERCENTRANK`, `PERCENTRANK.INC`, `PERCENTRANK.EXC`, `PRODUCT`, `SUMSQ`, `SUMPRODUCT`, `SUMXMY2`, `SUMX2MY2`, `SUMX2PY2`, `SERIESSUM`, `SKEW`, `SKEW.P`, `KURT`, `FISHER`, `FISHERINV`, `SUMIF`, `SUMIFS`, `MINIFS`, `MAXIFS`, `AVERAGEIF`, `AVERAGEIFS`, direct refs, arithmetic refs, `IF`, `IFS`, `IFERROR`, `IFNA`, `NA`, `CHOOSE`, `SWITCH`, `TRUE`, `FALSE`, `AND`/`OR`/`XOR`/`NOT`, `CONCAT`/`CONCATENATE`, `TEXTJOIN`, `LEN`, `PI`, `ABS`, `FACT`, `FACTDOUBLE`, `COMBIN`, `COMBINA`, `PERMUT`, `PERMUTATIONA`, `MULTINOMIAL`, `GCD`, `LCM`, `LN`, `EXP`, `LOG`, `LOG10`, `DOLLARDE`, `DOLLARFR`, `EFFECT`, `NOMINAL`, `NPV`, `PV`, `FV`, `PMT`, `IRR`, `MIRR`, `NPER`, `RATE`, `IPMT`, `PPMT`, `SLN`, `SYD`, `DB`, `DDB`, `RRI`, `PDURATION`, `FVSCHEDULE`, `ISPMT`, `CUMIPMT`, `CUMPRINC`, `XNPV`, `XIRR`, `SIN`/`COS`/`TAN`/`COT`/`SEC`/`CSC`, `SINH`/`COSH`/`TANH`/`COTH`/`SECH`/`CSCH`, `ASINH`/`ACOSH`/`ATANH`/`ACOTH`/`ASECH`/`ACSCH`, `ASIN`/`ACOS`/`ATAN`/`ATAN2`/`ACOT`/`ASEC`/`ACSC`, `DEGREES`/`RADIANS`, `ROUND`/`ROUNDUP`/`ROUNDDOWN`, `CEILING`/`CEILING.MATH`, `FLOOR`/`FLOOR.MATH`, `SQRT`, `POWER`, `MOD`, `QUOTIENT`, `MROUND`, `SIGN`, `INT`, `EVEN`, `ODD`, `TRUNC`, `EXACT`, `LEFT`/`RIGHT`/`MID`, `REPT`, `REPLACE`, `SUBSTITUTE`, `VALUE`, `N`, `T`, `BASE`, `DECIMAL`, `DEC2BIN`, `BIN2DEC`, `DEC2HEX`, `HEX2DEC`, `DEC2OCT`, `OCT2DEC`, `BIN2HEX`, `HEX2BIN`, `BIN2OCT`, `OCT2BIN`, `DELTA`, `GESTEP`, `BITAND`, `BITOR`, `BITXOR`, `BITLSHIFT`, `BITRSHIFT`, `CHAR`, `CODE`, `UNICHAR`, `UNICODE`, `ROMAN`, `ARABIC`, `SEARCH`, `FIND`, `UPPER`/`LOWER`/`TRIM`/`PROPER`/`CLEAN`, `ISBLANK`/`ISNUMBER`/`ISTEXT`/`ISEVEN`/`ISODD`, `TODAY`, `NOW`, `RAND`, `RANDBETWEEN`, `DATE`, `TIME`, `EDATE`, `EOMONTH`, `DAYS`, `DAYS360`, `YEARFRAC`, `DATEVALUE`, `TIMEVALUE`, `DATEDIF`, `NETWORKDAYS`, `WORKDAY`, `NETWORKDAYS.INTL`, `WORKDAY.INTL`, `YEAR`/`MONTH`/`DAY`, `WEEKDAY`, `WEEKNUM`, `ISOWEEKNUM`, `ROW`/`COLUMN`/`ROWS`/`COLUMNS`, `HOUR`/`MINUTE`/`SECOND`, `VLOOKUP` exact-match mode, `HLOOKUP` exact-match mode, `XLOOKUP` exact-match mode, `MATCH` exact-match mode, `INDEX`)
- XLSX import/export
- Chart metadata endpoints
- Read-only DuckDB query endpoint for tabular inspection
- Real-time SSE event stream for UI synchronization

## Compatibility matrix (v1)

| Tier | Status | Coverage |
| --- | --- | --- |
| Tier A | Strong support | Workbook/sheet/cell CRUD, bulk cell APIs, formula recalculation for major arithmetic/statistical/logical/text/date/financial/engineering families, SSE change stream, XLSX import/export with compatibility telemetry. |
| Tier B | Best effort | Formula normalization on import (`_xlfn.` / `_xlws.` / `_xlpm.`, implicit `@`, unary `+`), unsupported formula preservation with surfaced `unsupported_formulas`, chart metadata persistence, offset-range XLSX imports. |
| Tier C | Not guaranteed | VBA/macros, pivot charts/tables, external workbook links, full-fidelity rendering for every Excel-specific edge feature. |

Compatibility telemetry is available via:
- import response fields (`formula_cells_imported`, `formula_cells_with_cached_values`, `formula_cells_without_cached_values`, `formula_cells_normalized`, `warnings`),
- `workbook.imported` event payloads with mirrored import metrics + warnings,
- export `x-export-meta` compatibility report (`preserved`, `transformed`, `unsupported`).

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
- `POST /v1/workbooks/{id}/duckdb/query`
- `POST /v1/workbooks/{id}/export`
- `GET /v1/workbooks/{id}/events`
- `GET /v1/openapi`

`POST /v1/workbooks/{id}/cells/set-batch` notes:
- Formula inputs are trimmed before storage and normalized to start with `=`.
- Blank/whitespace-only formula inputs are rejected with `INVALID_FORMULA`.

`POST /v1/workbooks/import` returns:
- `workbook`
- `import.sheets_imported`
- `import.cells_imported`
- `import.formula_cells_imported`
- `import.formula_cells_with_cached_values`
- `import.formula_cells_without_cached_values`
- `import.formula_cells_normalized`
- `import.warnings`

Import behavior notes:
- Formula tokens are normalized for engine compatibility (`_xlfn.` / `_xlws.` / `_xlpm.` prefixes are stripped and formulas are stored with a leading `=`), while preserving quoted string literals.
- Excel implicit-intersection operators (`@`) are normalized in import-time formula tokens when used as prefix operators (for example `=@SUM(...)` becomes `=SUM(...)`), while preserving structured-reference and quoted-string usage.
- Unary leading `+` operators are normalized in import-time formula tokens for compatibility with modern Excel export patterns (for example `=+SUM(...)` becomes `=SUM(...)`).
- Import warnings include normalization telemetry when formula tokens are transformed for compatibility (`N formula(s) were normalized during import ...`).
- Cell coordinates are imported using worksheet range offsets, so sheets with first used cells outside `A1` preserve their original row/column placement.
- Unsupported formulas are preserved as formula text and returned via `/v1/workbooks/{id}/formulas/recalculate` `unsupported_formulas` for explicit compatibility surfacing.

`POST /v1/workbooks/{id}/duckdb/query` supports scoped read-only SQL inspection with response shape:
- `columns`: selected column names in query order
- `rows`: row-array payload (`string | null` values)
- `row_count`: rows returned after truncation
- `row_limit`: applied row limit (default `200`, max `1000`)
- `truncated`: true when additional rows were available beyond `row_limit`

Query guardrails:
- `sql` must be a single read-only `SELECT` or `WITH` statement (semicolons and mutating keywords are rejected with `INVALID_QUERY_SQL`).
- `row_limit`, when provided, must be > 0 (`INVALID_QUERY_ROW_LIMIT`), and is clamped to a maximum of `1000`.

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
- Failed operation result entries include structured error fields:
  - `error` (`CODE: message` string),
  - `error_code` (stable machine-readable code),
  - `error_message` (human-readable details).
- Signature-related validation error codes:
  - `INVALID_SIGNATURE_FORMAT`
  - `OPERATION_SIGNATURE_MISMATCH`
  - `EMPTY_OPERATION_LIST`
  - `REQUEST_ID_CONFLICT` (same `request_id` reused with a different operation signature)
- `expected_operations_signature` (from `/v1/workbooks/{id}/agent/ops/preview`) trims surrounding whitespace before validation; blank/whitespace-only values are treated as "not provided" for backward compatibility.
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

Schema discovery endpoints (`/v1/workbooks/{id}/agent/schema`, `/v1/agent/wizard/schema`) expose these under `signature_error_codes`, `cache_validation_error_codes`, `formula_capabilities.validation_error_codes`, and `agent_ops_result_error_shape`.
`/v1/openapi` mirrors these workflows with machine-readable path summaries for wizard discovery/run endpoints, agent cache lifecycle endpoints, DuckDB query execution, and workbook event streaming.
The in-memory request-id idempotency cache keeps up to **256** recent `agent/ops` responses per workbook (oldest entries evict first).
`/v1/workbooks/{id}/agent/schema` also advertises `openapi_endpoint`, `agent_ops_request_shape`, workbook import/export and DuckDB-query endpoint metadata (including `x-export-meta` header shape, import formula-metric response fields, DuckDB query request/response schema + validation codes, formula capability metadata with both summary strings and structured lists, and a workbook event-shape catalog for `workbook.created`, `sheet.added`, `cells.updated`, `formula.recalculated`, `chart.updated`, `workbook.imported`, and `workbook.exported`) for agent discoverability.
`/v1/agent/wizard/schema` includes `openapi_endpoint`, run/import response-shape metadata plus formula capability metadata (summary + structured lists + validation error codes), signature error codes, generic `agent/ops` execute + preview endpoint metadata, `agent_ops_request_shape` + preview request/response shape metadata, top-level `agent_ops_response_shape` metadata, cache endpoint metadata across stats/list/detail/prefix/clear/replay/reexecute/cleanup workflows, cache query/request/response shape contracts (including entries/prefixes age/paging filters), cache validation error codes, structured operation-error payload shape (`agent_ops_result_error_shape`), and DuckDB query request/response schema + validation codes so agent callers can discover wizard import metric fields and supported execution contracts without trial calls.

Plan-preview helper:
- `POST /v1/workbooks/{id}/agent/ops/preview` returns `{ operations_signature, operations }` without executing.

Cache helpers:
- `GET /v1/workbooks/{id}/agent/ops/cache`
- `GET /v1/workbooks/{id}/agent/ops/cache/entries?request_id_prefix=demo&max_age_seconds=3600&offset=0&limit=20` (newest-first paged request-id summaries, optional **non-blank** prefix filter, optional age filter for stale-only browsing, `limit` clamped to `1..200`, includes `total_entries`, `unscoped_total_entries`, operation/result counts, `cached_at`, and scoped `cutoff_timestamp`)
- `GET /v1/workbooks/{id}/agent/ops/cache/entries/{request_id}` (full cached detail: response + operations + counts + `cached_at`)
- `GET /v1/workbooks/{id}/agent/ops/cache/prefixes?request_id_prefix=scenario-&min_entry_count=2&min_span_seconds=60&max_span_seconds=86400&sort_by=recent&offset=0&limit=8&max_age_seconds=3600` (prefix suggestions with counts for filter UX; optional **non-blank** request-id prefix + age filters, optional `min_entry_count > 0`, optional `min_span_seconds > 0`, optional `max_span_seconds > 0` (and when both span bounds are supplied, `min_span_seconds <= max_span_seconds`), optional `sort_by` (`count`, `recent`, `alpha`, or `span`), optional `offset` pagination, `limit` clamped to `1..100`, includes `total_prefixes`, `unscoped_total_prefixes`, `unscoped_total_entries`, `scoped_total_entries`, `returned_entry_count`, echoed `request_id_prefix`, applied `min_entry_count`, echoed `min_span_seconds`, echoed `max_span_seconds`, applied `sort_by`, scoped `cutoff_timestamp`, paging metadata (`offset`, `has_more`), and per-prefix oldest/newest request-id + timestamp metadata plus timespan (`oldest_request_id`, `oldest_cached_at`, `newest_request_id`, `newest_cached_at`, `span_seconds`))
- `POST /v1/workbooks/{id}/agent/ops/cache/clear`
- `POST /v1/workbooks/{id}/agent/ops/cache/replay` with `{ "request_id": "..." }` (returns `{ cached_response, operations }` where `operations` are the original cached ops payload)
- `POST /v1/workbooks/{id}/agent/ops/cache/reexecute` with `{ "request_id": "...", "new_request_id": "...", "expected_operations_signature": "..." }` (reexecutes cached operations as fresh `agent/ops`; response includes `generated_request_id=true` when `new_request_id` is omitted and auto-generated by the server; provided `new_request_id` values are whitespace-trimmed and must remain non-empty after trimming; conflicting existing `new_request_id` signatures return `REQUEST_ID_CONFLICT`)
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
- `duckdb_query` (`sql` required read-only `SELECT`/`WITH`; optional `row_limit`)
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
        "op_type": "duckdb_query",
        "sql": "SELECT row_index, col_index, raw_value FROM cells WHERE sheet = '\''Data'\'' ORDER BY row_index, col_index",
        "row_limit": 50
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
      {
        "op_type": "duckdb_query",
        "sql": "SELECT sheet, COUNT(*) AS populated_cells FROM cells GROUP BY sheet ORDER BY sheet",
        "row_limit": 20
      },
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

Generate file-based XLSX compatibility fixtures (stored under `fixtures/`):

```bash
cargo run --bin generate_xlsx_fixtures
```

The fixture generator is deterministic (fixed workbook document metadata) and covered by `cargo test --bin generate_xlsx_fixtures`.
Use `cargo run --bin generate_xlsx_fixtures -- --output-dir /tmp/fixtures` to write fixture files to a custom directory.
Use `cargo run --bin generate_xlsx_fixtures -- --verify-committed` to verify committed fixture files match deterministic generator output (both file membership and byte content).
Use `cargo test xlsx::tests::should_keep_committed_file_fixture_corpus_in_sync_with_generator -- --nocapture` to verify committed fixture binaries match generated output.
Use `cargo test xlsx::tests::should_import_every_committed_fixture_corpus_workbook -- --nocapture` for corpus-wide import smoke coverage.
Use `cargo test xlsx::tests::should_roundtrip_every_committed_fixture_corpus_workbook -- --nocapture` for corpus-wide import/export/re-import smoke coverage.
Use `cargo test api::tests::should_import_every_committed_fixture_corpus_via_api_helper -- --nocapture` for corpus-wide API import + event telemetry smoke coverage.
Use `cargo test api::tests::should_export_every_committed_fixture_corpus_after_api_import -- --nocapture` for corpus-wide API export header/body/event smoke coverage.
Use `cargo test api::tests::should_roundtrip_every_committed_fixture_corpus_via_api_helpers -- --nocapture` for corpus-wide API import/export/re-import smoke coverage.

Fixture corpus inventory:

| File | Scenario |
| --- | --- |
| `compat_baseline.xlsx` | Canonical workbook import/export baseline with formulas + mixed value types. |
| `compat_formula_matrix.xlsx` | Supported formula matrix for engineering/financial/statistical function roundtrip checks. |
| `compat_default_cached_formula.xlsx` | Formula import metric scenario showing default cached scalar values from generated formulas (`formula_cells_with_cached_values`). |
| `compat_error_cached_formula.xlsx` | Formula import metric scenario proving formula-only cells without cached scalar values (`formula_cells_without_cached_values`). |
| `compat_formula_only_normalized.xlsx` | Formula-only compatibility normalization scenario with no cached scalar value (`formula_cells_normalized` + `formula_cells_without_cached_values`). |
| `compat_formula_only_sheet.xlsx` | Single-cell sheet containing only a formula (no cached scalar) to guard formula-only worksheet imports. |
| `compat_formula_only_offset_normalized.xlsx` | Offset formula-only cell (`D7`) with normalization + no cached scalar to guard coordinate + telemetry handling. |
| `compat_formula_only_dual.xlsx` | Dual formula-only cells (one normalized) to guard mixed formula-only import metrics (`formula_cells_without_cached_values` + `formula_cells_normalized`). |
| `compat_normalization_single.xlsx` | Single-formula normalization telemetry scenario (`_xlfn.` + implicit `@` + unary `+`). |
| `compat_normalization.xlsx` | Comprehensive normalization scenario with quoted literal preservation. |
| `compat_offset_range.xlsx` | Non-`A1` used-range coordinate preservation scenario. |
| `compat_unsupported_formula.xlsx` | Unsupported modern formula preservation scenario (`LET` with `_xlpm` params). |
| `compat_mixed_literal_prefix.xlsx` | Literal prefix text preservation while normalizing executable function tokens. |
| `compat_prefix_operator.xlsx` | Prefix operator (`+@`) normalization on executable functions. |

Performance baseline probe (manual, ignored by default):

```bash
cargo test store::tests::benchmark_medium_range_set_cells_updates -- --ignored --nocapture
cargo test store::tests::benchmark_large_range_recalculation -- --ignored --nocapture
```

This emits a `large_range_recalc_benchmark` JSON line with row count plus `upsert_ms`, `recalc_ms`, `total_ms`, and `updated_cells`.
It also emits a `medium_range_set_cells_benchmark` JSON line with `rows`, `elapsed_ms`, and `persisted_cells`.
Automated regression guards:
- `store::tests::should_set_medium_range_cells_within_update_budget` validates 250-row batch updates stay under a 5-second update budget.
- `store::tests::should_recalculate_large_range_aggregates_consistently` validates a 500-row aggregate recalc stays under a 2-second recalc budget.

Sample baseline captured in this repository (Linux CI-sized VM, debug test profile):

| benchmark | rows | elapsed_ms | persisted_cells |
| --- | ---: | ---: | ---: |
| medium_range_set_cells_benchmark | 500 | 4846 | 500 |

| rows | upsert_ms | recalc_ms | total_ms | updated_cells |
| ---: | ---: | ---: | ---: | ---: |
| 3000 | 30416 | 63 | 30479 | 1 |

XLSX compatibility regression coverage includes:
- supported formula roundtrip fixtures (engineering + financial families),
- unsupported formula preservation fixtures (normalized text retained + surfaced via `unsupported_formulas`),
- non-`A1` used-range import fixtures (coordinate offset preservation),
- formula-token normalization fixtures (`_xlfn.`/`_xlws.`/`_xlpm.`, implicit `@`, unary `+`, and quoted-literal edge cases),
- comprehensive normalization roundtrip fixtures validating telemetry + canonical replay after export/re-import,
- file-based fixture corpus regression coverage (`fixtures/compat_baseline.xlsx`, `fixtures/compat_formula_matrix.xlsx`, `fixtures/compat_default_cached_formula.xlsx`, `fixtures/compat_error_cached_formula.xlsx`, `fixtures/compat_formula_only_normalized.xlsx`, `fixtures/compat_formula_only_sheet.xlsx`, `fixtures/compat_formula_only_offset_normalized.xlsx`, `fixtures/compat_formula_only_dual.xlsx`, `fixtures/compat_normalization_single.xlsx`, `fixtures/compat_normalization.xlsx`, `fixtures/compat_offset_range.xlsx`, `fixtures/compat_unsupported_formula.xlsx`, `fixtures/compat_mixed_literal_prefix.xlsx`, `fixtures/compat_prefix_operator.xlsx`) to validate import behavior against generated workbook artifacts,
- generator-sync regression coverage to ensure committed fixture binaries stay byte-identical with deterministic generated output.
