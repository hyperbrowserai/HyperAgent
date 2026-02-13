use crate::{
  error::ApiError,
  models::{
    AgentOperation, AgentOperationResult, AgentOpsRequest, AgentOpsResponse,
    AgentPresetRunRequest, AgentScenarioRunRequest,
    AgentWizardImportResult, AgentWizardRunResponse,
    CellMutation, CreateSheetRequest, CreateSheetResponse, CreateWorkbookRequest,
    CreateWorkbookResponse, ExportResponse, GetCellsRequest,
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
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures_util::StreamExt;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

pub fn create_router(state: AppState) -> Router {
  Router::new()
    .route("/health", get(health))
    .route("/v1/openapi", get(openapi))
    .route("/v1/agent/wizard/run", post(run_agent_wizard))
    .route("/v1/workbooks", post(create_workbook))
    .route("/v1/workbooks/import", post(import_workbook))
    .route("/v1/workbooks/{id}", get(get_workbook))
    .route(
      "/v1/workbooks/{id}/sheets",
      get(get_sheets).post(create_sheet),
    )
    .route("/v1/workbooks/{id}/cells/set-batch", post(set_cells_batch))
    .route("/v1/workbooks/{id}/agent/ops", post(agent_ops))
    .route("/v1/workbooks/{id}/agent/schema", get(get_agent_schema))
    .route("/v1/workbooks/{id}/agent/presets", get(list_agent_presets))
    .route("/v1/workbooks/{id}/agent/scenarios", get(list_agent_scenarios))
    .route(
      "/v1/workbooks/{id}/agent/presets/{preset}",
      post(run_agent_preset),
    )
    .route(
      "/v1/workbooks/{id}/agent/scenarios/{scenario}",
      post(run_agent_scenario),
    )
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

fn parse_optional_bool(
  raw: Option<String>,
  field: &str,
) -> Result<Option<bool>, ApiError> {
  match raw {
    Some(value) => {
      let normalized = value.trim().to_lowercase();
      match normalized.as_str() {
        "true" | "1" | "yes" => Ok(Some(true)),
        "false" | "0" | "no" => Ok(Some(false)),
        _ => Err(ApiError::BadRequest(format!(
          "Field '{field}' must be a boolean-like value (true/false/1/0/yes/no).",
        ))),
      }
    }
    None => Ok(None),
  }
}

async fn import_bytes_into_workbook(
  state: &AppState,
  workbook_id: Uuid,
  bytes: &[u8],
  actor: &str,
) -> Result<AgentWizardImportResult, ApiError> {
  let db_path = state.db_path(workbook_id).await?;
  let import_result = import_xlsx(&db_path, bytes)?;
  for sheet_name in &import_result.sheet_names {
    let _ = state.register_sheet_if_missing(workbook_id, sheet_name).await?;
  }
  for warning in &import_result.warnings {
    state.add_warning(workbook_id, warning.clone()).await?;
  }
  state
    .emit_event(
      workbook_id,
      "workbook.imported",
      actor,
      json!({
        "sheets_imported": import_result.sheets_imported,
        "cells_imported": import_result.cells_imported,
        "warnings": import_result.warnings,
      }),
    )
    .await?;

  Ok(AgentWizardImportResult {
    sheets_imported: import_result.sheets_imported,
    cells_imported: import_result.cells_imported,
    warnings: import_result.warnings,
  })
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
  let import_result =
    import_bytes_into_workbook(&state, workbook.id, &bytes, "import").await?;

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

async fn run_agent_wizard(
  State(state): State<AppState>,
  mut multipart: Multipart,
) -> Result<Json<AgentWizardRunResponse>, ApiError> {
  let mut scenario: Option<String> = None;
  let mut request_id: Option<String> = None;
  let mut actor: Option<String> = None;
  let mut stop_on_error_raw: Option<String> = None;
  let mut include_file_base64_raw: Option<String> = None;
  let mut workbook_name: Option<String> = None;
  let mut maybe_file_name: Option<String> = None;
  let mut maybe_file_bytes: Option<Vec<u8>> = None;

  while let Some(field) = multipart.next_field().await.map_err(ApiError::internal)? {
    let name = field.name().unwrap_or_default().to_string();
    match name.as_str() {
      "file" => {
        let file_name = field.file_name().map(|value| value.to_string());
        let bytes = field.bytes().await.map_err(ApiError::internal)?;
        if !bytes.is_empty() {
          maybe_file_name = file_name;
          maybe_file_bytes = Some(bytes.to_vec());
        }
      }
      "scenario" => {
        scenario = Some(field.text().await.map_err(ApiError::internal)?);
      }
      "request_id" => {
        request_id = Some(field.text().await.map_err(ApiError::internal)?);
      }
      "actor" => {
        actor = Some(field.text().await.map_err(ApiError::internal)?);
      }
      "stop_on_error" => {
        stop_on_error_raw = Some(field.text().await.map_err(ApiError::internal)?);
      }
      "include_file_base64" => {
        include_file_base64_raw = Some(field.text().await.map_err(ApiError::internal)?);
      }
      "workbook_name" => {
        workbook_name = Some(field.text().await.map_err(ApiError::internal)?);
      }
      _ => {}
    }
  }

  let scenario = scenario
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .ok_or_else(|| ApiError::BadRequest("Field 'scenario' is required.".to_string()))?;
  let stop_on_error = parse_optional_bool(stop_on_error_raw, "stop_on_error")?
    .unwrap_or(true);
  let include_file_base64 =
    parse_optional_bool(include_file_base64_raw, "include_file_base64")?
      .unwrap_or(false);
  let actor = actor.unwrap_or_else(|| "wizard".to_string());
  let workbook_name = workbook_name
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .or(maybe_file_name);

  let workbook = state.create_workbook(workbook_name).await?;
  let import_result = match maybe_file_bytes {
    Some(bytes) => Some(
      import_bytes_into_workbook(&state, workbook.id, &bytes, actor.as_str())
        .await?,
    ),
    None => None,
  };
  let operations = build_scenario_operations(
    scenario.as_str(),
    Some(include_file_base64),
  )?;

  let results = execute_agent_operations(
    &state,
    workbook.id,
    actor.as_str(),
    stop_on_error,
    operations,
  )
  .await;
  let refreshed = state.get_workbook(workbook.id).await?;

  Ok(Json(AgentWizardRunResponse {
    workbook: refreshed,
    scenario,
    request_id,
    results,
    import: import_result,
  }))
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

fn normalize_sheet_name(name: &str) -> Result<String, ApiError> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err(ApiError::BadRequest(
      "Sheet name cannot be empty.".to_string(),
    ));
  }
  if trimmed.len() > 31 {
    return Err(ApiError::BadRequest(
      "Sheet name cannot exceed 31 characters.".to_string(),
    ));
  }
  if trimmed.contains(['[', ']', '*', '?', '/', '\\']) {
    return Err(ApiError::BadRequest(
      "Sheet name contains invalid characters.".to_string(),
    ));
  }
  Ok(trimmed.to_string())
}

async fn create_sheet(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<CreateSheetRequest>,
) -> Result<Json<CreateSheetResponse>, ApiError> {
  let actor = payload.actor.unwrap_or_else(|| "api".to_string());
  let sheet_name = normalize_sheet_name(payload.sheet.as_str())?;
  let created = state
    .register_sheet_if_missing(workbook_id, sheet_name.as_str())
    .await?;
  if created {
    state
      .emit_event(
        workbook_id,
        "sheet.added",
        actor.as_str(),
        json!({
          "sheet": sheet_name
        }),
      )
      .await?;
  }

  let sheets = state.list_sheets(workbook_id).await?;
  Ok(Json(CreateSheetResponse {
    sheet: sheet_name,
    created,
    sheets,
  }))
}

async fn apply_set_cells(
  state: &AppState,
  workbook_id: Uuid,
  sheet: &str,
  cells: &[CellMutation],
  actor: &str,
) -> Result<(usize, String), ApiError> {
  let normalized_sheet = normalize_sheet_name(sheet)?;
  let created = state
    .register_sheet_if_missing(workbook_id, normalized_sheet.as_str())
    .await?;
  if created {
    state
      .emit_event(
        workbook_id,
        "sheet.added",
        actor,
        json!({
          "sheet": normalized_sheet.as_str()
        }),
      )
      .await?;
  }
  let db_path = state.db_path(workbook_id).await?;
  let updated = set_cells(&db_path, normalized_sheet.as_str(), cells)?;
  let (recalculated, unsupported_formulas) = recalculate_formulas(&db_path)?;

  state
    .emit_event(
      workbook_id,
      "cells.updated",
      actor,
      json!({
        "sheet": normalized_sheet.as_str(),
        "updated": updated
      }),
    )
    .await?;

  if recalculated > 0 || !unsupported_formulas.is_empty() {
    state
      .emit_event(
        workbook_id,
        "formula.recalculated",
        actor,
        json!({
          "updated_cells": recalculated,
          "unsupported_formulas": unsupported_formulas
        }),
      )
      .await?;
  }

  Ok((updated, normalized_sheet))
}

async fn apply_recalculate(
  state: &AppState,
  workbook_id: Uuid,
  actor: &str,
) -> Result<(usize, Vec<String>), ApiError> {
  let db_path = state.db_path(workbook_id).await?;
  let (updated_cells, unsupported_formulas) = recalculate_formulas(&db_path)?;
  state
    .emit_event(
      workbook_id,
      "formula.recalculated",
      actor,
      json!({
        "updated_cells": updated_cells,
        "unsupported_formulas": unsupported_formulas
      }),
    )
    .await?;
  Ok((updated_cells, unsupported_formulas))
}

async fn build_export_artifacts(
  state: &AppState,
  workbook_id: Uuid,
) -> Result<(Vec<u8>, ExportResponse, String), ApiError> {
  let summary = state.get_workbook(workbook_id).await?;
  let db_path = state.db_path(workbook_id).await?;
  let (bytes, compatibility_report) = export_xlsx(&db_path, &summary)?;
  let response_payload = ExportResponse {
    file_name: format!("{}.xlsx", summary.name),
    compatibility_report,
  };
  let report_json = serde_json::to_string(&response_payload).map_err(ApiError::internal)?;
  Ok((bytes, response_payload, report_json))
}

async fn set_cells_batch(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<SetCellsRequest>,
) -> Result<Json<SetCellsResponse>, ApiError> {
  let actor = payload.actor.unwrap_or_else(|| "api".to_string());
  let (updated, _sheet) = apply_set_cells(
    &state,
    workbook_id,
    payload.sheet.as_str(),
    &payload.cells,
    actor.as_str(),
  )
  .await?;
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
  let (updated_cells, unsupported_formulas) =
    apply_recalculate(&state, workbook_id, "api").await?;
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
  let created = state
    .register_sheet_if_missing(workbook_id, payload.chart.sheet.as_str())
    .await?;
  let actor = payload.actor.unwrap_or_else(|| "api".to_string());
  if created {
    state
      .emit_event(
        workbook_id,
        "sheet.added",
        actor.as_str(),
        json!({ "sheet": payload.chart.sheet.as_str() }),
      )
      .await?;
  }
  state.upsert_chart(workbook_id, payload.chart.clone()).await?;
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

fn preset_catalog() -> Vec<serde_json::Value> {
  vec![
    json!({
      "preset": "seed_sales_demo",
      "description": "Populate sample regional sales data, recalculate formulas, and upsert a bar chart metadata definition.",
      "operations": ["set_cells", "recalculate", "upsert_chart"]
    }),
    json!({
      "preset": "export_snapshot",
      "description": "Recalculate workbook values and export an .xlsx snapshot.",
      "operations": ["recalculate", "export_workbook"]
    }),
  ]
}

fn build_preset_operations(
  preset: &str,
  include_file_base64: Option<bool>,
) -> Result<Vec<AgentOperation>, ApiError> {
  match preset {
    "seed_sales_demo" => Ok(vec![
      AgentOperation::SetCells {
        sheet: "Sheet1".to_string(),
        cells: vec![
          CellMutation {
            row: 1,
            col: 1,
            value: Some(json!("North")),
            formula: None,
          },
          CellMutation {
            row: 2,
            col: 1,
            value: Some(json!("South")),
            formula: None,
          },
          CellMutation {
            row: 3,
            col: 1,
            value: Some(json!("West")),
            formula: None,
          },
          CellMutation {
            row: 1,
            col: 2,
            value: Some(json!(120)),
            formula: None,
          },
          CellMutation {
            row: 2,
            col: 2,
            value: Some(json!(90)),
            formula: None,
          },
          CellMutation {
            row: 3,
            col: 2,
            value: Some(json!(75)),
            formula: None,
          },
          CellMutation {
            row: 4,
            col: 2,
            value: None,
            formula: Some("=SUM(B1:B3)".to_string()),
          },
        ],
      },
      AgentOperation::Recalculate,
      AgentOperation::UpsertChart {
        chart: crate::models::ChartSpec {
          id: "chart-sales-demo".to_string(),
          sheet: "Sheet1".to_string(),
          chart_type: crate::models::ChartType::Bar,
          title: "Regional Totals".to_string(),
          categories_range: "Sheet1!$A$1:$A$3".to_string(),
          values_range: "Sheet1!$B$1:$B$3".to_string(),
        },
      },
    ]),
    "export_snapshot" => Ok(vec![
      AgentOperation::Recalculate,
      AgentOperation::ExportWorkbook {
        include_file_base64,
      },
    ]),
    _ => Err(ApiError::BadRequest(format!(
      "Unknown preset '{preset}'. Supported presets: seed_sales_demo, export_snapshot."
    ))),
  }
}

fn scenario_catalog() -> Vec<serde_json::Value> {
  vec![
    json!({
      "scenario": "seed_then_export",
      "description": "Run seed_sales_demo preset and then export_snapshot in a single request.",
      "presets": ["seed_sales_demo", "export_snapshot"]
    }),
    json!({
      "scenario": "refresh_and_export",
      "description": "Recalculate workbook and export snapshot without seeding data.",
      "presets": ["export_snapshot"]
    }),
  ]
}

fn build_scenario_operations(
  scenario: &str,
  include_file_base64: Option<bool>,
) -> Result<Vec<AgentOperation>, ApiError> {
  match scenario {
    "seed_then_export" => {
      let mut operations = build_preset_operations("seed_sales_demo", None)?;
      operations.extend(build_preset_operations(
        "export_snapshot",
        include_file_base64,
      )?);
      Ok(operations)
    }
    "refresh_and_export" => build_preset_operations(
      "export_snapshot",
      include_file_base64,
    ),
    _ => Err(ApiError::BadRequest(format!(
      "Unknown scenario '{scenario}'. Supported scenarios: seed_then_export, refresh_and_export."
    ))),
  }
}

async fn list_agent_presets(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
  state.get_workbook(workbook_id).await?;
  Ok(Json(json!({
    "presets": preset_catalog()
  })))
}

async fn list_agent_scenarios(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
  state.get_workbook(workbook_id).await?;
  Ok(Json(json!({
    "scenarios": scenario_catalog()
  })))
}

async fn get_agent_schema(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
  state.get_workbook(workbook_id).await?;
  Ok(Json(json!({
    "endpoint": "/v1/workbooks/{id}/agent/ops",
    "request_shape": {
      "request_id": "optional string",
      "actor": "optional string",
      "stop_on_error": "optional boolean (default false)",
      "operations": [
        {
          "op_type": "get_workbook | list_sheets | create_sheet | set_cells | get_cells | recalculate | upsert_chart | export_workbook",
          "payload": "operation-specific object"
        }
      ]
    },
    "operation_payloads": {
      "create_sheet": { "sheet": "string" },
      "set_cells": {
        "sheet": "string",
        "cells": [{ "row": 1, "col": 1, "value": "scalar or null", "formula": "optional string" }]
      },
      "get_cells": {
        "sheet": "string",
        "range": { "start_row": 1, "end_row": 50, "start_col": 1, "end_col": 12 }
      },
      "upsert_chart": {
        "chart": {
          "id": "string",
          "sheet": "string",
          "chart_type": "line|bar|pie|area|scatter",
          "title": "string",
          "categories_range": "Sheet1!$A$1:$A$10",
          "values_range": "Sheet1!$B$1:$B$10"
        }
      },
      "export_workbook": {
        "include_file_base64": "optional boolean (default true)"
      }
    },
    "preset_endpoint": "/v1/workbooks/{id}/agent/presets/{preset}",
    "presets": preset_catalog(),
    "scenario_endpoint": "/v1/workbooks/{id}/agent/scenarios/{scenario}",
    "scenarios": scenario_catalog(),
    "wizard_endpoint": "/v1/agent/wizard/run",
    "wizard_request_multipart_fields": [
      "scenario (required)",
      "file (optional .xlsx)",
      "workbook_name (optional)",
      "request_id (optional)",
      "actor (optional)",
      "stop_on_error (optional boolean)",
      "include_file_base64 (optional boolean)"
    ]
  })))
}

async fn execute_agent_operations(
  state: &AppState,
  workbook_id: Uuid,
  actor: &str,
  stop_on_error: bool,
  operations: Vec<AgentOperation>,
) -> Vec<AgentOperationResult> {
  let mut results = Vec::new();

  for (op_index, operation) in operations.into_iter().enumerate() {
    let (op_type, outcome): (String, Result<serde_json::Value, ApiError>) = match operation {
      AgentOperation::GetWorkbook => (
        "get_workbook".to_string(),
        state
          .get_workbook(workbook_id)
          .await
          .map(|workbook| json!({ "workbook": workbook })),
      ),
      AgentOperation::ListSheets => (
        "list_sheets".to_string(),
        state
          .list_sheets(workbook_id)
          .await
          .map(|sheets| json!({ "sheets": sheets })),
      ),
      AgentOperation::CreateSheet { sheet } => (
        "create_sheet".to_string(),
        async {
          let sheet_name = normalize_sheet_name(sheet.as_str())?;
          let created = state
            .register_sheet_if_missing(workbook_id, sheet_name.as_str())
            .await?;
          if created {
            state
              .emit_event(
                workbook_id,
                "sheet.added",
                actor,
                json!({ "sheet": sheet_name.as_str() }),
              )
              .await?;
          }
          let sheets = state.list_sheets(workbook_id).await?;
          Ok::<serde_json::Value, ApiError>(json!({
            "sheet": sheet_name,
            "created": created,
            "sheets": sheets
          }))
        }
        .await,
      ),
      AgentOperation::SetCells { sheet, cells } => (
        "set_cells".to_string(),
        apply_set_cells(state, workbook_id, sheet.as_str(), &cells, actor)
          .await
          .map(|(updated, normalized_sheet)| {
            json!({ "sheet": normalized_sheet, "updated": updated })
          }),
      ),
      AgentOperation::GetCells { sheet, range } => {
        let outcome = match state.db_path(workbook_id).await {
          Ok(db_path) => {
            get_cells(&db_path, sheet.as_str(), &range)
              .map(|cells| json!({ "sheet": sheet, "cells": cells }))
          }
          Err(error) => Err(error),
        };
        ("get_cells".to_string(), outcome)
      }
      AgentOperation::Recalculate => (
        "recalculate".to_string(),
        apply_recalculate(state, workbook_id, actor)
          .await
          .map(|(updated_cells, unsupported_formulas)| {
            json!({
              "updated_cells": updated_cells,
              "unsupported_formulas": unsupported_formulas
            })
          }),
      ),
      AgentOperation::UpsertChart { chart } => {
        let result = async {
          let created = state
            .register_sheet_if_missing(workbook_id, chart.sheet.as_str())
            .await?;
          if created {
            state
              .emit_event(
                workbook_id,
                "sheet.added",
                actor,
                json!({ "sheet": chart.sheet.as_str() }),
              )
              .await?;
          }
          state.upsert_chart(workbook_id, chart.clone()).await?;
          state
            .emit_event(
              workbook_id,
              "chart.updated",
              actor,
              json!({ "chart_id": chart.id }),
            )
            .await?;
          Ok::<serde_json::Value, ApiError>(json!({ "chart_id": chart.id }))
        }
        .await;
        ("upsert_chart".to_string(), result)
      }
      AgentOperation::ExportWorkbook { include_file_base64 } => {
        let should_include_file = include_file_base64.unwrap_or(true);
        let result = async {
          let (bytes, export_payload, _report_json) =
            build_export_artifacts(state, workbook_id).await?;
          state
            .emit_event(
              workbook_id,
              "workbook.exported",
              actor,
              json!({
                "file_name": export_payload.file_name,
                "compatibility_report": export_payload.compatibility_report
              }),
            )
            .await?;
          Ok::<serde_json::Value, ApiError>(json!({
            "file_name": export_payload.file_name,
            "compatibility_report": export_payload.compatibility_report,
            "file_base64": if should_include_file {
              serde_json::Value::String(BASE64_STANDARD.encode(bytes))
            } else {
              serde_json::Value::Null
            }
          }))
        }
        .await;
        ("export_workbook".to_string(), result)
      }
    };

    match outcome {
      Ok(data) => results.push(AgentOperationResult {
        op_index,
        op_type,
        ok: true,
        data,
      }),
      Err(error) => results.push(AgentOperationResult {
        op_index,
        op_type,
        ok: false,
        data: json!({
          "error": format!("{error:?}")
        }),
      }),
    }

    if stop_on_error && results.last().map(|entry| !entry.ok).unwrap_or(false) {
      break;
    }
  }

  results
}

async fn agent_ops(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<AgentOpsRequest>,
) -> Result<Json<AgentOpsResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let request_id = payload.request_id.clone();
  let actor = payload.actor.unwrap_or_else(|| "agent".to_string());
  let stop_on_error = payload.stop_on_error.unwrap_or(false);
  let results = execute_agent_operations(
    &state,
    workbook_id,
    actor.as_str(),
    stop_on_error,
    payload.operations,
  )
  .await;

  Ok(Json(AgentOpsResponse { request_id, results }))
}

async fn run_agent_preset(
  State(state): State<AppState>,
  Path((workbook_id, preset)): Path<(Uuid, String)>,
  Json(payload): Json<AgentPresetRunRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let operations =
    build_preset_operations(preset.as_str(), payload.include_file_base64)?;
  let request_id = payload.request_id.clone();
  let actor = payload
    .actor
    .unwrap_or_else(|| format!("preset:{preset}"));
  let stop_on_error = payload.stop_on_error.unwrap_or(true);

  let results = execute_agent_operations(
    &state,
    workbook_id,
    actor.as_str(),
    stop_on_error,
    operations,
  )
  .await;

  Ok(Json(json!({
    "preset": preset,
    "request_id": request_id,
    "results": results
  })))
}

async fn run_agent_scenario(
  State(state): State<AppState>,
  Path((workbook_id, scenario)): Path<(Uuid, String)>,
  Json(payload): Json<AgentScenarioRunRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let operations =
    build_scenario_operations(scenario.as_str(), payload.include_file_base64)?;
  let request_id = payload.request_id.clone();
  let actor = payload
    .actor
    .unwrap_or_else(|| format!("scenario:{scenario}"));
  let stop_on_error = payload.stop_on_error.unwrap_or(true);

  let results = execute_agent_operations(
    &state,
    workbook_id,
    actor.as_str(),
    stop_on_error,
    operations,
  )
  .await;

  Ok(Json(json!({
    "scenario": scenario,
    "request_id": request_id,
    "results": results
  })))
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
  let (bytes, response_payload, report_json) =
    build_export_artifacts(&state, workbook_id).await?;

  state
    .emit_event(
      workbook_id,
      "workbook.exported",
      "export",
      json!({
        "file_name": response_payload.file_name,
        "compatibility_report": response_payload.compatibility_report
      }),
    )
    .await?;
  let mut headers = HeaderMap::new();
  headers.insert(
    header::CONTENT_TYPE,
    HeaderValue::from_static(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
  );
  headers.insert(
    header::CONTENT_DISPOSITION,
    HeaderValue::from_str(&format!("attachment; filename=\"{}\"", response_payload.file_name))
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
      "/v1/agent/wizard/run": {"post": {"summary": "Wizard endpoint: optional import + scenario execution + optional export payload"}},
      "/v1/workbooks": {"post": {"summary": "Create workbook"}},
      "/v1/workbooks/import": {"post": {"summary": "Import .xlsx"}},
      "/v1/workbooks/{id}": {"get": {"summary": "Get workbook"}},
      "/v1/workbooks/{id}/sheets": {"get": {"summary": "List sheets"}, "post": {"summary": "Create sheet"}},
      "/v1/workbooks/{id}/cells/set-batch": {"post": {"summary": "Batch set cells"}},
      "/v1/workbooks/{id}/agent/ops": {"post": {"summary": "AI-friendly multi-operation endpoint (supports create_sheet/export_workbook ops)"}},
      "/v1/workbooks/{id}/agent/schema": {"get": {"summary": "Get operation schema for AI agent callers"}},
      "/v1/workbooks/{id}/agent/presets": {"get": {"summary": "List available built-in agent presets"}},
      "/v1/workbooks/{id}/agent/presets/{preset}": {"post": {"summary": "Run built-in AI operation preset (seed_sales_demo/export_snapshot)"}},
      "/v1/workbooks/{id}/agent/scenarios": {"get": {"summary": "List available built-in agent scenarios"}},
      "/v1/workbooks/{id}/agent/scenarios/{scenario}": {"post": {"summary": "Run built-in AI scenario (seed_then_export/refresh_and_export)"}},
      "/v1/workbooks/{id}/cells/get": {"post": {"summary": "Get range cells"}},
      "/v1/workbooks/{id}/formulas/recalculate": {"post": {"summary": "Recalculate formulas"}},
      "/v1/workbooks/{id}/charts/upsert": {"post": {"summary": "Upsert chart metadata"}},
      "/v1/workbooks/{id}/duckdb/query": {"post": {"summary": "Reserved (currently guarded for stability)"}},
      "/v1/workbooks/{id}/export": {"post": {"summary": "Export workbook as .xlsx"}},
      "/v1/workbooks/{id}/events": {"get": {"summary": "SSE change stream"}}
    }
  }))
}

#[cfg(test)]
mod tests {
  use super::{build_preset_operations, build_scenario_operations, normalize_sheet_name};

  #[test]
  fn should_validate_sheet_name_rules() {
    assert!(normalize_sheet_name("Sheet 1").is_ok());
    assert!(normalize_sheet_name("").is_err());
    assert!(normalize_sheet_name("   ").is_err());
    assert!(normalize_sheet_name("Bad/Name").is_err());
    assert!(normalize_sheet_name("ThisSheetNameIsWayTooLongForExcelRules").is_err());
  }

  #[test]
  fn should_build_known_presets() {
    let demo = build_preset_operations("seed_sales_demo", None)
      .expect("seed_sales_demo should be supported");
    let export = build_preset_operations("export_snapshot", Some(false))
      .expect("export_snapshot should be supported");
    assert!(!demo.is_empty());
    assert!(!export.is_empty());
    assert!(build_preset_operations("missing_preset", None).is_err());
  }

  #[test]
  fn should_build_known_scenarios() {
    let seed_then_export = build_scenario_operations("seed_then_export", Some(false))
      .expect("seed_then_export should be supported");
    let refresh_then_export = build_scenario_operations("refresh_and_export", Some(false))
      .expect("refresh_and_export should be supported");
    assert!(seed_then_export.len() > refresh_then_export.len());
    assert!(!refresh_then_export.is_empty());
    assert!(build_scenario_operations("unknown_scenario", None).is_err());
  }
}
