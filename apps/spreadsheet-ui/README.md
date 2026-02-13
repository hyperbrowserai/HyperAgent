# Spreadsheet UI (Next.js + React)

Frontend for the DuckDB-backed spreadsheet core.

## Features

- Excel-like grid interaction
- Formula bar editing
- Workbook import/export controls
- Realtime server stream sync via SSE
- Live chart preview with metadata sync endpoint

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
