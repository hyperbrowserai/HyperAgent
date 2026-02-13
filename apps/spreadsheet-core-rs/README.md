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

- `POST /v1/workbooks`
- `POST /v1/workbooks/import`
- `GET /v1/workbooks/{id}`
- `GET /v1/workbooks/{id}/sheets`
- `POST /v1/workbooks/{id}/cells/set-batch`
- `POST /v1/workbooks/{id}/agent/ops` (recommended for AI agents)
- `POST /v1/workbooks/{id}/cells/get`
- `POST /v1/workbooks/{id}/formulas/recalculate`
- `POST /v1/workbooks/{id}/charts/upsert`
- `POST /v1/workbooks/{id}/export`
- `GET /v1/workbooks/{id}/events`
- `GET /v1/openapi`

> Note: `/v1/workbooks/{id}/duckdb/query` currently returns a guarded `400` response in this build to avoid a known upstream panic in the underlying DuckDB Rust wrapper for ad-hoc SQL execution paths.

### AI Agent multi-operation endpoint

`POST /v1/workbooks/{id}/agent/ops` executes a list of typed operations in order and returns per-operation results.

Supported `op_type` values:
- `get_workbook`
- `list_sheets`
- `set_cells`
- `get_cells`
- `recalculate`
- `upsert_chart`

## Testing

```bash
cargo test
```
