use crate::{
  error::ApiError,
  models::{
    CreateWorkbookRequest, CreateWorkbookResponse, ExportResponse, GetCellsRequest,
    GetCellsResponse, QueryRequest, RecalculateResponse, SetCellsRequest,
    SetCellsResponse, UpsertChartRequest,
  },
  state::AppState,
  store::{get_cells, recalculate_formulas, set_cells},
  xlsx::{export_xlsx, import_xlsx},
};
use axum::{
  extract::{Multipart, Path, State},
  http::{header, HeaderMap, HeaderValue, StatusCode},
  response::{
    sse::{Event, KeepAlive, Sse},
    IntoResponse,
  },
  routing::{get, post},
  Json, Router,
};
use futures_util::StreamExt;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

pub fn create_router(state: AppState) -> Router {
  Router::new()
    .route("/health", get(health))
    .route("/v1/openapi", get(openapi))
    .route("/v1/workbooks", post(create_workbook))
    .route("/v1/workbooks/import", post(import_workbook))
    .route("/v1/workbooks/{id}", get(get_workbook))
    .route("/v1/workbooks/{id}/sheets", get(get_sheets))
    .route("/v1/workbooks/{id}/cells/set-batch", post(set_cells_batch))
    .route("/v1/workbooks/{id}/cells/get", post(get_cells_range))
    .route(
      "/v1/workbooks/{id}/formulas/recalculate",
      post(recalculate_workbook),
    )
    .route("/v1/workbooks/{id}/charts/upsert", post(upsert_chart))
    .route("/v1/workbooks/{id}/duckdb/query", post(duckdb_query))
    .route("/v1/workbooks/{id}/export", post(export_workbook))
    .route("/v1/workbooks/{id}/events", get(workbook_events))
    .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
  Json(json!({
    "status": "ok",
    "service": "spreadsheet-core-rs"
  }))
}

async fn create_workbook(
  State(state): State<AppState>,
  Json(payload): Json<CreateWorkbookRequest>,
) -> Result<Json<CreateWorkbookResponse>, ApiError> {
  let workbook = state.create_workbook(payload.name).await?;
  state
    .emit_event(
      workbook.id,
      "workbook.created",
      "system",
      json!({ "name": workbook.name }),
    )
    .await?;
  Ok(Json(CreateWorkbookResponse { workbook }))
}

async fn import_workbook(
  State(state): State<AppState>,
  mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, ApiError> {
  let mut maybe_file_name: Option<String> = None;
  let mut maybe_bytes: Option<Vec<u8>> = None;

  while let Some(field) = multipart.next_field().await.map_err(ApiError::internal)? {
    let file_name = field.file_name().map(|value| value.to_string());
    let bytes = field.bytes().await.map_err(ApiError::internal)?;
    if !bytes.is_empty() {
      maybe_file_name = file_name;
      maybe_bytes = Some(bytes.to_vec());
      break;
    }
  }

  let bytes = maybe_bytes
    .ok_or_else(|| ApiError::BadRequest("No XLSX file was provided.".to_string()))?;
  let workbook = state.create_workbook(maybe_file_name.clone()).await?;
  let db_path = state.db_path(workbook.id).await?;
  let import_result = import_xlsx(&db_path, &bytes)?;

  for sheet_name in &import_result.sheet_names {
    state.register_sheet_if_missing(workbook.id, sheet_name).await?;
  }
  for warning in &import_result.warnings {
    state.add_warning(workbook.id, warning.clone()).await?;
  }

  state
    .emit_event(
      workbook.id,
      "workbook.imported",
      "import",
      json!({
        "sheets_imported": import_result.sheets_imported,
        "cells_imported": import_result.cells_imported,
        "warnings": import_result.warnings,
      }),
    )
    .await?;

  let refreshed = state.get_workbook(workbook.id).await?;
  Ok(Json(json!({
    "workbook": refreshed,
    "import": {
      "sheets_imported": import_result.sheets_imported,
      "cells_imported": import_result.cells_imported,
      "warnings": import_result.warnings
    }
  })))
}

async fn get_workbook(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
  let workbook = state.get_workbook(workbook_id).await?;
  Ok(Json(json!({ "workbook": workbook })))
}

async fn get_sheets(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
  let sheets = state.list_sheets(workbook_id).await?;
  Ok(Json(json!({ "sheets": sheets })))
}

async fn set_cells_batch(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<SetCellsRequest>,
) -> Result<Json<SetCellsResponse>, ApiError> {
  state
    .register_sheet_if_missing(workbook_id, payload.sheet.as_str())
    .await?;
  let db_path = state.db_path(workbook_id).await?;
  let updated = set_cells(&db_path, payload.sheet.as_str(), &payload.cells)?;
  let (recalculated, unsupported_formulas) = recalculate_formulas(&db_path)?;

  let actor = payload.actor.unwrap_or_else(|| "api".to_string());
  state
    .emit_event(
      workbook_id,
      "cells.updated",
      actor.as_str(),
      json!({
        "sheet": payload.sheet,
        "updated": updated
      }),
    )
    .await?;
  if recalculated > 0 || !unsupported_formulas.is_empty() {
    state
      .emit_event(
        workbook_id,
        "formula.recalculated",
        actor.as_str(),
        json!({
          "updated_cells": recalculated,
          "unsupported_formulas": unsupported_formulas
        }),
      )
      .await?;
  }

  Ok(Json(SetCellsResponse { updated }))
}

async fn get_cells_range(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<GetCellsRequest>,
) -> Result<Json<GetCellsResponse>, ApiError> {
  let db_path = state.db_path(workbook_id).await?;
  let cells = get_cells(&db_path, payload.sheet.as_str(), &payload.range)?;
  Ok(Json(GetCellsResponse {
    sheet: payload.sheet,
    cells,
  }))
}

async fn recalculate_workbook(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
) -> Result<Json<RecalculateResponse>, ApiError> {
  let db_path = state.db_path(workbook_id).await?;
  let (updated_cells, unsupported_formulas) = recalculate_formulas(&db_path)?;
  state
    .emit_event(
      workbook_id,
      "formula.recalculated",
      "api",
      json!({
        "updated_cells": updated_cells,
        "unsupported_formulas": unsupported_formulas
      }),
    )
    .await?;
  Ok(Json(RecalculateResponse {
    updated_cells,
    unsupported_formulas,
  }))
}

async fn upsert_chart(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<UpsertChartRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
  state
    .register_sheet_if_missing(workbook_id, payload.chart.sheet.as_str())
    .await?;
  state.upsert_chart(workbook_id, payload.chart.clone()).await?;
  let actor = payload.actor.unwrap_or_else(|| "api".to_string());
  state
    .emit_event(
      workbook_id,
      "chart.updated",
      actor.as_str(),
      json!({ "chart_id": payload.chart.id }),
    )
    .await?;
  Ok(Json(json!({ "status": "ok" })))
}

async fn duckdb_query(
  State(_state): State<AppState>,
  Path(_workbook_id): Path<Uuid>,
  Json(payload): Json<QueryRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
  Err(ApiError::BadRequest(format!(
    "Ad-hoc SQL is temporarily disabled in this build to ensure stability. Received query: {}. Use /cells/get and /cells/set-batch endpoints for agent-safe operations.",
    payload.sql
  )))
}

async fn export_workbook(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
  let summary = state.get_workbook(workbook_id).await?;
  let db_path = state.db_path(workbook_id).await?;
  let (bytes, compatibility_report) = export_xlsx(&db_path, &summary)?;

  state
    .emit_event(
      workbook_id,
      "workbook.exported",
      "export",
      json!({
        "file_name": format!("{}.xlsx", summary.name),
        "compatibility_report": compatibility_report
      }),
    )
    .await?;

  let response_payload = ExportResponse {
    file_name: format!("{}.xlsx", summary.name),
    compatibility_report,
  };
  let report_json = serde_json::to_string(&response_payload).map_err(ApiError::internal)?;
  let mut headers = HeaderMap::new();
  headers.insert(
    header::CONTENT_TYPE,
    HeaderValue::from_static(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
  );
  headers.insert(
    header::CONTENT_DISPOSITION,
    HeaderValue::from_str(&format!("attachment; filename=\"{}.xlsx\"", summary.name))
      .map_err(ApiError::internal)?,
  );
  headers.insert(
    "x-export-meta",
    HeaderValue::from_str(&report_json).map_err(ApiError::internal)?,
  );

  Ok((StatusCode::OK, headers, bytes))
}

async fn workbook_events(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
) -> Result<Sse<impl futures_util::stream::Stream<Item = Result<Event, std::convert::Infallible>>>, ApiError>
{
  let receiver = state.subscribe(workbook_id).await?;
  let stream = BroadcastStream::new(receiver).filter_map(|event| async move {
    match event {
      Ok(payload) => {
        let data = serde_json::to_string(&payload).unwrap_or_default();
        Some(Ok(Event::default().event(payload.event_type).data(data)))
      }
      Err(_) => None,
    }
  });

  Ok(
    Sse::new(stream)
      .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(10))),
  )
}

async fn openapi() -> Json<serde_json::Value> {
  Json(json!({
    "openapi": "3.1.0",
    "info": {
      "title": "DuckDB Spreadsheet API",
      "version": "1.0.0"
    },
    "paths": {
      "/v1/workbooks": {"post": {"summary": "Create workbook"}},
      "/v1/workbooks/import": {"post": {"summary": "Import .xlsx"}},
      "/v1/workbooks/{id}": {"get": {"summary": "Get workbook"}},
      "/v1/workbooks/{id}/sheets": {"get": {"summary": "List sheets"}},
      "/v1/workbooks/{id}/cells/set-batch": {"post": {"summary": "Batch set cells"}},
      "/v1/workbooks/{id}/cells/get": {"post": {"summary": "Get range cells"}},
      "/v1/workbooks/{id}/formulas/recalculate": {"post": {"summary": "Recalculate formulas"}},
      "/v1/workbooks/{id}/charts/upsert": {"post": {"summary": "Upsert chart metadata"}},
      "/v1/workbooks/{id}/duckdb/query": {"post": {"summary": "Run read-only SQL query"}},
      "/v1/workbooks/{id}/export": {"post": {"summary": "Export workbook as .xlsx"}},
      "/v1/workbooks/{id}/events": {"get": {"summary": "SSE change stream"}}
    }
  }))
}
