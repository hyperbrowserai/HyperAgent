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
- Wizard can toggle export payload embedding (`include_file_base64`) before execution
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
