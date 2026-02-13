use crate::{
  error::ApiError,
  models::{
    AgentOperation, AgentOperationResult, AgentOpsCacheEntriesResponse,
    AgentOpsCacheEntry, AgentOpsCacheEntryDetailResponse,
    AgentOpsCachePrefix, AgentOpsCachePrefixesResponse,
    AgentOpsCacheStatsResponse, AgentOpsRequest, AgentOpsResponse,
    AgentOpsPreviewRequest, AgentOpsPreviewResponse,
    AgentPresetRunRequest, AgentScenarioRunRequest,
    RemoveAgentOpsCacheEntryRequest, RemoveAgentOpsCacheEntryResponse,
    RemoveAgentOpsCacheEntriesByPrefixRequest,
    RemoveAgentOpsCacheEntriesByPrefixResponse,
    RemoveStaleAgentOpsCacheEntriesRequest,
    RemoveStaleAgentOpsCacheEntriesResponse,
    PreviewRemoveAgentOpsCacheEntriesByPrefixRequest,
    PreviewRemoveAgentOpsCacheEntriesByPrefixResponse,
    ReexecuteAgentOpsCacheEntryRequest, ReexecuteAgentOpsCacheEntryResponse,
    ReplayAgentOpsCacheEntryRequest, ReplayAgentOpsCacheEntryResponse,
    AgentWizardImportResult, AgentWizardRunJsonRequest, AgentWizardRunResponse,
    ClearAgentOpsCacheResponse,
    CellMutation, CreateSheetRequest, CreateSheetResponse, CreateWorkbookRequest,
    CreateWorkbookResponse, ExportResponse, GetCellsRequest,
    GetCellsResponse, QueryRequest, RecalculateResponse, SetCellsRequest,
    SetCellsResponse, UpsertChartRequest,
  },
  state::{AppState, AGENT_OPS_CACHE_MAX_ENTRIES},
  store::{get_cells, recalculate_formulas, set_cells},
  xlsx::{export_xlsx, import_xlsx},
};
use axum::{
  extract::{Multipart, Path, Query, State},
  http::{header, HeaderMap, HeaderValue, StatusCode},
  response::{
    sse::{Event, KeepAlive, Sse},
    IntoResponse,
  },
  routing::{get, post},
  Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

const FORMULA_SUPPORTED_FUNCTION_LIST: &[&str] = &[
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTIF",
  "COUNTIFS",
  "SUMIF",
  "SUMIFS",
  "AVERAGEIF",
  "AVERAGEIFS",
  "direct references",
  "arithmetic expressions",
  "IF",
  "IFERROR",
  "CHOOSE",
  "AND",
  "OR",
  "NOT",
  "CONCAT",
  "CONCATENATE",
  "LEN",
  "LEFT",
  "RIGHT",
  "UPPER",
  "LOWER",
  "TRIM",
  "ISBLANK",
  "ISNUMBER",
  "ISTEXT",
  "TODAY",
  "DATE",
  "YEAR",
  "MONTH",
  "DAY",
  "VLOOKUP exact-match mode",
  "HLOOKUP exact-match mode",
  "XLOOKUP exact-match mode",
  "MATCH exact-match mode",
  "INDEX",
];
const FORMULA_UNSUPPORTED_BEHAVIOR_LIST: &[&str] = &[
  "VLOOKUP/HLOOKUP with range_lookup TRUE/1 remain unsupported.",
  "XLOOKUP non-exact match_mode/search_mode variants remain unsupported.",
  "MATCH non-exact match_type variants remain unsupported.",
  "Unsupported formulas are surfaced via unsupported_formulas.",
];
const FORMULA_FALLBACK_BEHAVIOR: &str = "unsupported formulas are preserved and reported by formula.recalculated payloads";

fn formula_supported_functions_summary() -> String {
  FORMULA_SUPPORTED_FUNCTION_LIST.join(", ")
}

fn formula_unsupported_behaviors_summary() -> String {
  FORMULA_UNSUPPORTED_BEHAVIOR_LIST.join(" ")
}

pub fn create_router(state: AppState) -> Router {
  Router::new()
    .route("/health", get(health))
    .route("/v1/openapi", get(openapi))
    .route("/v1/agent/wizard/schema", get(get_agent_wizard_schema))
    .route("/v1/agent/wizard/presets", get(list_wizard_presets))
    .route(
      "/v1/agent/wizard/presets/{preset}/operations",
      get(get_wizard_preset_operations),
    )
    .route("/v1/agent/wizard/scenarios", get(list_wizard_scenarios))
    .route(
      "/v1/agent/wizard/scenarios/{scenario}/operations",
      get(get_wizard_scenario_operations),
    )
    .route("/v1/agent/wizard/run", post(run_agent_wizard))
    .route("/v1/agent/wizard/run-json", post(run_agent_wizard_json))
    .route("/v1/workbooks", post(create_workbook))
    .route("/v1/workbooks/import", post(import_workbook))
    .route("/v1/workbooks/{id}", get(get_workbook))
    .route(
      "/v1/workbooks/{id}/sheets",
      get(get_sheets).post(create_sheet),
    )
    .route("/v1/workbooks/{id}/cells/set-batch", post(set_cells_batch))
    .route("/v1/workbooks/{id}/agent/ops", post(agent_ops))
    .route("/v1/workbooks/{id}/agent/ops/preview", post(agent_ops_preview))
    .route(
      "/v1/workbooks/{id}/agent/ops/cache",
      get(agent_ops_cache_stats),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/entries",
      get(agent_ops_cache_entries),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/entries/{request_id}",
      get(agent_ops_cache_entry_detail),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/prefixes",
      get(agent_ops_cache_prefixes),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/clear",
      post(clear_agent_ops_cache),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/replay",
      post(replay_agent_ops_cache_entry),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/reexecute",
      post(reexecute_agent_ops_cache_entry),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/remove",
      post(remove_agent_ops_cache_entry),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/remove-by-prefix",
      post(remove_agent_ops_cache_entries_by_prefix),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/remove-by-prefix/preview",
      post(preview_remove_agent_ops_cache_entries_by_prefix),
    )
    .route(
      "/v1/workbooks/{id}/agent/ops/cache/remove-stale",
      post(remove_stale_agent_ops_cache_entries),
    )
    .route("/v1/workbooks/{id}/agent/schema", get(get_agent_schema))
    .route("/v1/workbooks/{id}/agent/presets", get(list_agent_presets))
    .route(
      "/v1/workbooks/{id}/agent/presets/{preset}/operations",
      get(get_agent_preset_operations),
    )
    .route("/v1/workbooks/{id}/agent/scenarios", get(list_agent_scenarios))
    .route(
      "/v1/workbooks/{id}/agent/scenarios/{scenario}/operations",
      get(get_agent_scenario_operations),
    )
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

fn operations_signature(
  operations: &[AgentOperation],
) -> Result<String, ApiError> {
  let bytes = serde_json::to_vec(operations).map_err(ApiError::internal)?;
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  Ok(format!("{:x}", hasher.finalize()))
}

fn validate_expected_operations_signature(
  expected_signature: Option<&str>,
  actual_signature: &str,
) -> Result<(), ApiError> {
  let Some(expected) = expected_signature.map(str::trim) else {
    return Ok(());
  };
  if expected.is_empty() {
    return Ok(());
  }
  if expected.len() != 64 || !expected.chars().all(|ch| ch.is_ascii_hexdigit()) {
    return Err(ApiError::bad_request_with_code(
      "INVALID_SIGNATURE_FORMAT",
      "Expected operations signature must be a 64-character hexadecimal string."
        .to_string(),
    ));
  }
  let normalized_expected = expected.to_ascii_lowercase();
  if normalized_expected == actual_signature {
    return Ok(());
  }
  Err(ApiError::bad_request_with_code(
    "OPERATION_SIGNATURE_MISMATCH",
    format!(
      "Operation signature mismatch. expected={normalized_expected} actual={actual_signature}",
    ),
  ))
}

fn ensure_non_empty_operations(
  operations: &[AgentOperation],
) -> Result<(), ApiError> {
  if operations.is_empty() {
    return Err(ApiError::bad_request_with_code(
      "EMPTY_OPERATION_LIST",
      "Operation list cannot be empty.".to_string(),
    ));
  }
  Ok(())
}

fn validate_request_id_signature_consistency(
  cached_signature: Option<&str>,
  incoming_signature: &str,
) -> Result<(), ApiError> {
  let Some(cached_signature) = cached_signature else {
    return Ok(());
  };
  if cached_signature == incoming_signature {
    return Ok(());
  }
  Err(ApiError::bad_request_with_code(
    "REQUEST_ID_CONFLICT",
    format!(
      "request_id already exists with a different operations signature. cached={cached_signature} incoming={incoming_signature}",
    ),
  ))
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
        "formula_cells_imported": import_result.formula_cells_imported,
        "formula_cells_with_cached_values": import_result.formula_cells_with_cached_values,
        "formula_cells_without_cached_values": import_result.formula_cells_without_cached_values,
        "warnings": import_result.warnings,
      }),
    )
    .await?;

  Ok(AgentWizardImportResult {
    sheets_imported: import_result.sheets_imported,
    cells_imported: import_result.cells_imported,
    formula_cells_imported: import_result.formula_cells_imported,
    formula_cells_with_cached_values: import_result.formula_cells_with_cached_values,
    formula_cells_without_cached_values: import_result.formula_cells_without_cached_values,
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
      "formula_cells_imported": import_result.formula_cells_imported,
      "formula_cells_with_cached_values": import_result.formula_cells_with_cached_values,
      "formula_cells_without_cached_values": import_result.formula_cells_without_cached_values,
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
  let mut expected_operations_signature: Option<String> = None;
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
      "expected_operations_signature" => {
        expected_operations_signature =
          Some(field.text().await.map_err(ApiError::internal)?);
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
  let operation_signature = operations_signature(&operations)?;
  validate_expected_operations_signature(
    expected_operations_signature.as_deref(),
    operation_signature.as_str(),
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
    operations_signature: operation_signature,
    request_id,
    results,
    import: import_result,
  }))
}

async fn run_agent_wizard_json(
  State(state): State<AppState>,
  Json(payload): Json<AgentWizardRunJsonRequest>,
) -> Result<Json<AgentWizardRunResponse>, ApiError> {
  let scenario = payload.scenario.trim();
  if scenario.is_empty() {
    return Err(ApiError::BadRequest(
      "Field 'scenario' is required.".to_string(),
    ));
  }
  let include_file_base64 = payload.include_file_base64.unwrap_or(false);
  let stop_on_error = payload.stop_on_error.unwrap_or(true);
  let actor = payload.actor.unwrap_or_else(|| "wizard".to_string());
  let workbook_name = payload
    .workbook_name
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .or(payload.file_name.clone());

  let workbook = state.create_workbook(workbook_name).await?;
  let import_result = match payload.file_base64 {
    Some(encoded_file) => {
      let bytes = BASE64_STANDARD
        .decode(encoded_file)
        .map_err(|error| {
          ApiError::BadRequest(format!(
            "Field 'file_base64' is not valid base64: {error}",
          ))
        })?;
      Some(
        import_bytes_into_workbook(&state, workbook.id, &bytes, actor.as_str())
          .await?,
      )
    }
    None => None,
  };
  let operations = build_scenario_operations(
    scenario,
    Some(include_file_base64),
  )?;
  let operation_signature = operations_signature(&operations)?;
  validate_expected_operations_signature(
    payload.expected_operations_signature.as_deref(),
    operation_signature.as_str(),
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
    scenario: scenario.to_string(),
    operations_signature: operation_signature,
    request_id: payload.request_id,
    results,
    import: import_result,
  }))
}

async fn get_agent_wizard_schema() -> Json<serde_json::Value> {
  Json(json!({
    "endpoint": "/v1/agent/wizard/run",
    "json_endpoint": "/v1/agent/wizard/run-json",
    "presets_endpoint": "/v1/agent/wizard/presets",
    "preset_operations_endpoint": "/v1/agent/wizard/presets/{preset}/operations?include_file_base64=false",
    "scenarios_endpoint": "/v1/agent/wizard/scenarios",
    "request_multipart_fields": [
      "scenario (required)",
      "file (optional .xlsx)",
      "workbook_name (optional)",
      "request_id (optional)",
      "actor (optional)",
      "stop_on_error (optional boolean)",
      "include_file_base64 (optional boolean)",
      "expected_operations_signature (optional string from scenario preview endpoint)"
    ],
    "request_json_fields": {
      "scenario": "required string",
      "request_id": "optional string",
      "actor": "optional string",
      "stop_on_error": "optional boolean",
      "include_file_base64": "optional boolean",
      "expected_operations_signature": "optional string from scenario preview endpoint",
      "workbook_name": "optional string",
      "file_name": "optional string",
      "file_base64": "optional base64-encoded xlsx payload"
    },
    "operations_preview_response_shape": {
      "operations_signature": "sha256 signature over generated operations",
      "operations": "array of operation objects"
    },
    "run_response_shape": {
      "workbook": "workbook summary",
      "scenario": "scenario name",
      "operations_signature": "sha256 signature over executed operation plan",
      "request_id": "optional request id",
      "results": "array of operation execution results",
      "import": "optional import summary object (see import_response_shape)"
    },
    "import_response_shape": {
      "sheets_imported": "number of imported sheets",
      "cells_imported": "number of imported cells",
      "formula_cells_imported": "number of imported cells carrying formulas",
      "formula_cells_with_cached_values": "formula cells with cached scalar values",
      "formula_cells_without_cached_values": "formula cells without cached scalar values",
      "warnings": "array of compatibility warning strings"
    },
    "formula_capabilities": {
      "supported_functions": formula_supported_functions_summary(),
      "supported_function_list": FORMULA_SUPPORTED_FUNCTION_LIST,
      "unsupported_behaviors": formula_unsupported_behaviors_summary(),
      "unsupported_behavior_list": FORMULA_UNSUPPORTED_BEHAVIOR_LIST,
      "fallback_behavior": FORMULA_FALLBACK_BEHAVIOR
    },
    "scenario_operations_endpoint": "/v1/agent/wizard/scenarios/{scenario}/operations?include_file_base64=false",
    "scenarios": scenario_catalog(),
    "presets": preset_catalog()
  }))
}

async fn list_wizard_presets() -> Json<serde_json::Value> {
  Json(json!({
    "presets": preset_catalog()
  }))
}

async fn get_wizard_preset_operations(
  Path(preset): Path<String>,
  Query(query): Query<ScenarioOperationsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
  let operations = build_preset_operations(
    preset.as_str(),
    query.include_file_base64,
  )?;
  let operation_signature = operations_signature(&operations)?;
  Ok(Json(json!({
    "preset": preset,
    "operations_signature": operation_signature,
    "operations": operations
  })))
}

async fn list_wizard_scenarios() -> Json<serde_json::Value> {
  Json(json!({
    "scenarios": scenario_catalog()
  }))
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ScenarioOperationsQuery {
  include_file_base64: Option<bool>,
}

async fn get_wizard_scenario_operations(
  Path(scenario): Path<String>,
  Query(query): Query<ScenarioOperationsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
  let operations = build_scenario_operations(
    scenario.as_str(),
    query.include_file_base64,
  )?;
  let operation_signature = operations_signature(&operations)?;
  Ok(Json(json!({
    "scenario": scenario,
    "operations_signature": operation_signature,
    "operations": operations
  })))
}

async fn get_agent_scenario_operations(
  State(state): State<AppState>,
  Path((workbook_id, scenario)): Path<(Uuid, String)>,
  Query(query): Query<ScenarioOperationsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let operations = build_scenario_operations(
    scenario.as_str(),
    query.include_file_base64,
  )?;
  let operation_signature = operations_signature(&operations)?;
  Ok(Json(json!({
    "workbook_id": workbook_id,
    "scenario": scenario,
    "operations_signature": operation_signature,
    "operations": operations
  })))
}

async fn get_agent_preset_operations(
  State(state): State<AppState>,
  Path((workbook_id, preset)): Path<(Uuid, String)>,
  Query(query): Query<ScenarioOperationsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let operations = build_preset_operations(
    preset.as_str(),
    query.include_file_base64,
  )?;
  let operation_signature = operations_signature(&operations)?;
  Ok(Json(json!({
    "workbook_id": workbook_id,
    "preset": preset,
    "operations_signature": operation_signature,
    "operations": operations
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
  let report_json = serde_json::to_string(&response_payload.compatibility_report)
    .map_err(ApiError::internal)?;
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
      "request_id": "optional string (if repeated, returns cached response for idempotency)",
      "actor": "optional string",
      "stop_on_error": "optional boolean (default false)",
      "expected_operations_signature": "optional string for payload integrity checks",
      "operations (non-empty array)": [
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
    "formula_capabilities": {
      "supported_functions": formula_supported_functions_summary(),
      "supported_function_list": FORMULA_SUPPORTED_FUNCTION_LIST,
      "unsupported_behaviors": formula_unsupported_behaviors_summary(),
      "unsupported_behavior_list": FORMULA_UNSUPPORTED_BEHAVIOR_LIST,
      "fallback_behavior": FORMULA_FALLBACK_BEHAVIOR
    },
    "agent_ops_response_shape": {
      "request_id": "optional string",
      "operations_signature": "sha256 signature over submitted operations",
      "served_from_cache": "boolean; true when response reused by request_id idempotency cache",
      "results": "array of operation results"
    },
    "workbook_import_endpoint": "/v1/workbooks/import",
    "workbook_import_response_shape": {
      "workbook": "imported workbook summary",
      "import": {
        "sheets_imported": "number of imported sheets",
        "cells_imported": "number of imported cells",
        "formula_cells_imported": "number of imported cells carrying formulas",
        "formula_cells_with_cached_values": "formula cells with cached scalar values",
        "formula_cells_without_cached_values": "formula cells without cached scalar values",
        "warnings": "array of compatibility warning strings"
      }
    },
    "workbook_export_endpoint": "/v1/workbooks/{id}/export",
    "workbook_export_response_headers_shape": {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": "attachment filename for exported workbook",
      "x-export-meta": "json compatibility report with preserved/transformed/unsupported arrays"
    },
    "workbook_import_event_shape": {
      "event_type": "workbook.imported",
      "payload": {
        "sheets_imported": "number of imported sheets",
        "cells_imported": "number of imported cells",
        "formula_cells_imported": "number of imported cells carrying formulas",
        "formula_cells_with_cached_values": "formula cells with cached scalar values",
        "formula_cells_without_cached_values": "formula cells without cached scalar values",
        "warnings": "array of compatibility warning strings"
      }
    },
    "workbook_export_event_shape": {
      "event_type": "workbook.exported",
      "payload": {
        "file_name": "exported workbook filename",
        "compatibility_report": "compatibility report object matching x-export-meta schema"
      }
    },
    "workbook_event_shapes": {
      "workbook.created": {
        "payload": {
          "name": "workbook name"
        }
      },
      "workbook.imported": {
        "payload": {
          "sheets_imported": "number of imported sheets",
          "cells_imported": "number of imported cells",
          "formula_cells_imported": "number of imported cells carrying formulas",
          "formula_cells_with_cached_values": "formula cells with cached scalar values",
          "formula_cells_without_cached_values": "formula cells without cached scalar values",
          "warnings": "array of compatibility warning strings"
        }
      },
      "sheet.added": {
        "payload": {
          "sheet": "sheet name"
        }
      },
      "cells.updated": {
        "payload": {
          "sheet": "sheet name",
          "updated": "number of updated cells in mutation batch"
        }
      },
      "formula.recalculated": {
        "payload": {
          "updated_cells": "number of recalculated cells",
          "unsupported_formulas": "array of unsupported formula strings"
        }
      },
      "chart.updated": {
        "payload": {
          "chart_id": "chart identifier"
        }
      },
      "workbook.exported": {
        "payload": {
          "file_name": "exported workbook filename",
          "compatibility_report": "compatibility report object matching x-export-meta schema"
        }
      }
    },
    "agent_ops_preview_endpoint": "/v1/workbooks/{id}/agent/ops/preview",
    "agent_ops_cache_stats_endpoint": "/v1/workbooks/{id}/agent/ops/cache?request_id_prefix=scenario-&max_age_seconds=3600",
    "agent_ops_cache_entries_endpoint": "/v1/workbooks/{id}/agent/ops/cache/entries?request_id_prefix=demo&offset=0&limit=20",
    "agent_ops_cache_entry_detail_endpoint": "/v1/workbooks/{id}/agent/ops/cache/entries/{request_id}",
    "agent_ops_cache_prefixes_endpoint": "/v1/workbooks/{id}/agent/ops/cache/prefixes?request_id_prefix=scenario-&min_entry_count=2&min_span_seconds=60&max_span_seconds=86400&sort_by=recent&offset=0&limit=8&max_age_seconds=3600",
    "agent_ops_cache_stats_query_shape": {
      "request_id_prefix": "optional non-blank string filter (prefix match)",
      "max_age_seconds": "optional number > 0 (filter stats to entries older than or equal to this age)"
    },
    "agent_ops_cache_entries_query_shape": {
      "request_id_prefix": "optional non-blank string filter (prefix match)",
      "max_age_seconds": "optional number > 0 (filter to entries older than or equal to this age)",
      "offset": "optional number, default 0",
      "limit": "optional number, default 20, min 1, max 200"
    },
    "agent_ops_cache_prefixes_query_shape": {
      "request_id_prefix": "optional non-blank string filter (prefix match)",
      "min_entry_count": "optional number > 0 (filter out prefixes with fewer matches, default 1)",
      "min_span_seconds": "optional number > 0 (filter out prefixes with narrower time spans)",
      "max_span_seconds": "optional number > 0 (filter out prefixes with wider time spans; when combined with min_span_seconds must be >= min_span_seconds)",
      "sort_by": "optional string enum: count|recent|alpha|span (default count)",
      "max_age_seconds": "optional number > 0 (filter prefixes to entries older than or equal to this age)",
      "offset": "optional number, default 0",
      "limit": "optional number, default 8, min 1, max 100"
    },
    "agent_ops_cache_clear_endpoint": "/v1/workbooks/{id}/agent/ops/cache/clear",
    "agent_ops_cache_replay_endpoint": "/v1/workbooks/{id}/agent/ops/cache/replay",
    "agent_ops_cache_reexecute_endpoint": "/v1/workbooks/{id}/agent/ops/cache/reexecute",
    "agent_ops_cache_remove_endpoint": "/v1/workbooks/{id}/agent/ops/cache/remove",
    "agent_ops_cache_remove_by_prefix_endpoint": "/v1/workbooks/{id}/agent/ops/cache/remove-by-prefix",
    "agent_ops_cache_remove_by_prefix_preview_endpoint": "/v1/workbooks/{id}/agent/ops/cache/remove-by-prefix/preview",
    "agent_ops_cache_remove_stale_endpoint": "/v1/workbooks/{id}/agent/ops/cache/remove-stale",
    "agent_ops_preview_request_shape": {
      "operations": "non-empty array of operation objects"
    },
    "agent_ops_preview_response_shape": {
      "operations_signature": "sha256 signature over submitted operations",
      "operations": "echoed operation array"
    },
    "agent_ops_cache_stats_response_shape": {
      "entries": "current cache entries",
      "unscoped_entries": "total cache entries without prefix/age filters",
      "max_entries": "maximum cache size",
      "request_id_prefix": "echoed filter prefix when provided",
      "max_age_seconds": "echoed age filter when provided",
      "cutoff_timestamp": "optional iso timestamp used for max_age_seconds filtering",
      "oldest_request_id": "optional oldest cached request id",
      "newest_request_id": "optional newest cached request id",
      "oldest_cached_at": "optional iso timestamp of oldest cached entry",
      "newest_cached_at": "optional iso timestamp of newest cached entry"
    },
    "agent_ops_cache_entries_response_shape": {
      "total_entries": "total cache entries available",
      "unscoped_total_entries": "total cache entries without prefix/age filters",
      "returned_entries": "number of entries returned in this response",
      "request_id_prefix": "echoed filter prefix when provided",
      "max_age_seconds": "echoed age filter when provided",
      "cutoff_timestamp": "optional iso timestamp used for max_age_seconds filtering",
      "offset": "start index in newest-first order",
      "limit": "applied limit (default 20, min 1, max 200)",
      "has_more": "true when another page exists after this response",
      "entries": [{
        "request_id": "string",
        "cached_at": "iso timestamp when entry was cached",
        "operations_signature": "optional string",
        "operation_count": "number of cached operations in this request",
        "result_count": "number of cached operation results"
      }]
    },
    "agent_ops_cache_prefixes_response_shape": {
      "total_prefixes": "total distinct prefix suggestions available",
      "unscoped_total_prefixes": "total distinct prefixes without prefix/age filters",
      "unscoped_total_entries": "total cache entries without prefix/age filters",
      "scoped_total_entries": "total cache entries represented by scoped prefixes before pagination",
      "returned_prefixes": "number of prefixes returned",
      "returned_entry_count": "total cache entries represented by returned prefixes in this page",
      "request_id_prefix": "echoed filter prefix when provided",
      "min_entry_count": "applied minimum entry count filter (default 1)",
      "min_span_seconds": "echoed minimum span filter when provided",
      "max_span_seconds": "echoed maximum span filter when provided",
      "sort_by": "applied sort mode: count|recent|alpha|span",
      "max_age_seconds": "echoed age filter when provided",
      "cutoff_timestamp": "optional iso timestamp used for max_age_seconds filtering",
      "offset": "start index in sorted prefix list",
      "limit": "applied limit (default 8, min 1, max 100)",
      "has_more": "true when another page exists after this response",
      "prefixes": [{
        "prefix": "string",
        "entry_count": "number of matching cache entries",
        "newest_request_id": "newest request_id observed for this prefix within active scope",
        "newest_cached_at": "optional iso timestamp for newest request_id within active scope",
        "oldest_request_id": "oldest request_id observed for this prefix within active scope",
        "oldest_cached_at": "optional iso timestamp for oldest request_id within active scope",
        "span_seconds": "optional number of seconds between oldest and newest cached timestamps"
      }]
    },
    "agent_ops_cache_entry_detail_response_shape": {
      "request_id": "string",
      "cached_at": "iso timestamp when entry was cached",
      "operation_count": "number of cached operations in this request",
      "result_count": "number of cached operation results",
      "cached_response": "cached agent_ops response payload",
      "operations": "cached operation array for this request id"
    },
    "agent_ops_cache_clear_response_shape": {
      "cleared_entries": "number of removed cache entries"
    },
    "agent_ops_cache_replay_request_shape": {
      "request_id": "string (required)"
    },
    "agent_ops_cache_replay_response_shape": {
      "cached_at": "iso timestamp when source cache entry was created",
      "cached_response": {
        "request_id": "optional string",
        "operations_signature": "sha256 signature over cached operations",
        "served_from_cache": "always true when replay succeeds",
        "results": "array of cached operation results"
      },
      "operations": "cached operation array for request replay portability"
    },
    "agent_ops_cache_reexecute_request_shape": {
      "request_id": "string (required source cache entry id)",
      "new_request_id": "optional string for target execution request id",
      "actor": "optional string",
      "stop_on_error": "optional boolean (default true)",
      "expected_operations_signature": "optional string guard for cached operations payload"
    },
    "agent_ops_cache_reexecute_response_shape": {
      "source_request_id": "string",
      "generated_request_id": "true if server generated request id",
      "operations_signature": "sha256 signature over replayed operations",
      "operations_count": "number of operations reexecuted",
      "operations": "reexecuted operations array",
      "response": "agent ops response from reexecution"
    },
    "agent_ops_cache_remove_request_shape": {
      "request_id": "string (required)"
    },
    "agent_ops_cache_remove_response_shape": {
      "request_id": "string",
      "removed": "boolean",
      "remaining_entries": "entries left in cache after removal"
    },
    "agent_ops_cache_remove_by_prefix_request_shape": {
      "request_id_prefix": "string (required)",
      "max_age_seconds": "optional number > 0 (remove only entries older than or equal to this age)"
    },
    "agent_ops_cache_remove_by_prefix_response_shape": {
      "request_id_prefix": "string",
      "max_age_seconds": "echoed age filter when provided",
      "cutoff_timestamp": "optional iso timestamp used for max_age_seconds filtering",
      "unscoped_matched_entries": "number of age-scoped cache entries before prefix filtering",
      "removed_entries": "number of removed cache entries matching prefix",
      "remaining_entries": "entries left in cache after removal"
    },
    "agent_ops_cache_remove_by_prefix_preview_request_shape": {
      "request_id_prefix": "string (required)",
      "max_age_seconds": "optional number > 0 (preview only entries older than or equal to this age)",
      "sample_limit": "optional number (default 20, min 1, max 100)"
    },
    "agent_ops_cache_remove_by_prefix_preview_response_shape": {
      "request_id_prefix": "string",
      "max_age_seconds": "echoed age filter when provided",
      "cutoff_timestamp": "optional iso timestamp used for max_age_seconds filtering",
      "matched_entries": "number of cache entries matching prefix",
      "unscoped_matched_entries": "number of age-scoped cache entries before prefix filtering",
      "sample_limit": "max sample request ids returned",
      "sample_request_ids": "newest-first sample matching request ids"
    },
    "agent_ops_cache_remove_stale_request_shape": {
      "request_id_prefix": "optional string filter (prefix match)",
      "max_age_seconds": "number > 0 (required)",
      "dry_run": "optional boolean (default false)",
      "sample_limit": "optional number (default 20, min 1, max 100)"
    },
    "agent_ops_cache_remove_stale_response_shape": {
      "request_id_prefix": "echoed filter prefix when provided",
      "max_age_seconds": "requested max age threshold",
      "dry_run": "boolean",
      "cutoff_timestamp": "iso timestamp used for stale matching",
      "matched_entries": "number of stale cache entries matching cutoff",
      "unscoped_matched_entries": "number of stale cache entries matching cutoff without prefix filter",
      "removed_entries": "number of entries removed (0 for dry_run)",
      "remaining_entries": "entries left in cache after operation",
      "sample_limit": "applied sample size",
      "sample_request_ids": "newest-first sample stale request ids"
    },
    "cache_validation_error_codes": [
      "INVALID_REQUEST_ID",
      "INVALID_NEW_REQUEST_ID",
      "INVALID_MAX_AGE_SECONDS",
      "INVALID_MIN_ENTRY_COUNT",
      "INVALID_MIN_SPAN_SECONDS",
      "INVALID_MAX_SPAN_SECONDS",
      "INVALID_SPAN_RANGE",
      "INVALID_PREFIX_SORT_BY",
      "INVALID_REQUEST_ID_PREFIX",
      "CACHE_ENTRY_NOT_FOUND"
    ],
    "agent_ops_idempotency_cache_max_entries": AGENT_OPS_CACHE_MAX_ENTRIES,
    "preset_endpoint": "/v1/workbooks/{id}/agent/presets/{preset}",
    "preset_run_request_shape": {
      "request_id": "optional string",
      "actor": "optional string",
      "stop_on_error": "optional boolean (default true)",
      "include_file_base64": "optional boolean",
      "expected_operations_signature": "optional string from preset preview endpoint"
    },
    "preset_operations_endpoint": "/v1/workbooks/{id}/agent/presets/{preset}/operations?include_file_base64=false",
    "presets": preset_catalog(),
    "scenario_endpoint": "/v1/workbooks/{id}/agent/scenarios/{scenario}",
    "scenario_run_request_shape": {
      "request_id": "optional string",
      "actor": "optional string",
      "stop_on_error": "optional boolean (default true)",
      "include_file_base64": "optional boolean",
      "expected_operations_signature": "optional string from scenario preview endpoint"
    },
    "scenario_operations_endpoint": "/v1/workbooks/{id}/agent/scenarios/{scenario}/operations?include_file_base64=false",
    "operations_preview_response_shape": {
      "operations_signature": "sha256 signature over generated operations",
      "operations": "array of operation objects"
    },
    "signature_error_codes": [
      "INVALID_SIGNATURE_FORMAT",
      "OPERATION_SIGNATURE_MISMATCH",
      "EMPTY_OPERATION_LIST",
      "REQUEST_ID_CONFLICT"
    ],
    "scenarios": scenario_catalog(),
    "wizard_endpoint": "/v1/agent/wizard/run",
    "wizard_json_endpoint": "/v1/agent/wizard/run-json",
    "wizard_request_multipart_fields": [
      "scenario (required)",
      "file (optional .xlsx)",
      "workbook_name (optional)",
      "request_id (optional)",
      "actor (optional)",
      "stop_on_error (optional boolean)",
      "include_file_base64 (optional boolean)",
      "expected_operations_signature (optional string from scenario preview endpoint)"
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
  let operations = payload.operations;
  ensure_non_empty_operations(&operations)?;
  let operation_signature = operations_signature(&operations)?;
  validate_expected_operations_signature(
    payload.expected_operations_signature.as_deref(),
    operation_signature.as_str(),
  )?;
  if let Some(existing_request_id) = request_id.as_deref() {
    if let Some(mut cached_response) = state
      .get_cached_agent_ops_response(workbook_id, existing_request_id)
      .await?
    {
      validate_request_id_signature_consistency(
        cached_response.operations_signature.as_deref(),
        operation_signature.as_str(),
      )?;
      cached_response.served_from_cache = true;
      return Ok(Json(cached_response));
    }
  }
  let actor = payload.actor.unwrap_or_else(|| "agent".to_string());
  let stop_on_error = payload.stop_on_error.unwrap_or(false);
  let results = execute_agent_operations(
    &state,
    workbook_id,
    actor.as_str(),
    stop_on_error,
    operations.clone(),
  )
  .await;

  let response = AgentOpsResponse {
    request_id,
    operations_signature: Some(operation_signature),
    served_from_cache: false,
    results,
  };
  if let Some(existing_request_id) = response.request_id.as_ref() {
    state
      .cache_agent_ops_response(
        workbook_id,
        existing_request_id.clone(),
        operations,
        response.clone(),
      )
      .await?;
  }
  Ok(Json(response))
}

async fn agent_ops_preview(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<AgentOpsPreviewRequest>,
) -> Result<Json<AgentOpsPreviewResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  ensure_non_empty_operations(&payload.operations)?;
  let operation_signature = operations_signature(&payload.operations)?;
  Ok(Json(AgentOpsPreviewResponse {
    operations_signature: operation_signature,
    operations: payload.operations,
  }))
}

#[derive(Debug, Clone, serde::Deserialize)]
struct AgentOpsCacheStatsQuery {
  request_id_prefix: Option<String>,
  max_age_seconds: Option<i64>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct AgentOpsCacheEntriesQuery {
  request_id_prefix: Option<String>,
  max_age_seconds: Option<i64>,
  offset: Option<usize>,
  limit: Option<usize>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct AgentOpsCachePrefixesQuery {
  request_id_prefix: Option<String>,
  min_entry_count: Option<usize>,
  min_span_seconds: Option<i64>,
  max_span_seconds: Option<i64>,
  sort_by: Option<String>,
  max_age_seconds: Option<i64>,
  offset: Option<usize>,
  limit: Option<usize>,
}

const DEFAULT_AGENT_OPS_CACHE_ENTRIES_LIMIT: usize = 20;
const MAX_AGENT_OPS_CACHE_ENTRIES_LIMIT: usize = 200;
const DEFAULT_AGENT_OPS_CACHE_PREFIXES_LIMIT: usize = 8;
const MAX_AGENT_OPS_CACHE_PREFIXES_LIMIT: usize = 100;

async fn agent_ops_cache_stats(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Query(query): Query<AgentOpsCacheStatsQuery>,
) -> Result<Json<AgentOpsCacheStatsResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let normalized_prefix =
    normalize_optional_request_id_prefix(query.request_id_prefix.as_deref());
  if query.request_id_prefix.is_some() && normalized_prefix.is_none() {
    return Err(ApiError::bad_request_with_code(
      "INVALID_REQUEST_ID_PREFIX",
      "request_id_prefix must not be blank when provided.",
    ));
  }
  let cutoff_timestamp = max_age_cutoff_timestamp(query.max_age_seconds)?;
  let (
    entries,
    unscoped_entries,
    oldest_request_id,
    newest_request_id,
    oldest_cached_at,
    newest_cached_at,
  ) = state
    .agent_ops_cache_stats(
      workbook_id,
      normalized_prefix.as_deref(),
      cutoff_timestamp,
    )
    .await?;
  Ok(Json(AgentOpsCacheStatsResponse {
    entries,
    unscoped_entries,
    max_entries: AGENT_OPS_CACHE_MAX_ENTRIES,
    request_id_prefix: normalized_prefix,
    max_age_seconds: query.max_age_seconds,
    cutoff_timestamp,
    oldest_request_id,
    newest_request_id,
    oldest_cached_at,
    newest_cached_at,
  }))
}

async fn agent_ops_cache_entries(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Query(query): Query<AgentOpsCacheEntriesQuery>,
) -> Result<Json<AgentOpsCacheEntriesResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let normalized_prefix =
    normalize_optional_request_id_prefix(query.request_id_prefix.as_deref());
  if query.request_id_prefix.is_some() && normalized_prefix.is_none() {
    return Err(ApiError::bad_request_with_code(
      "INVALID_REQUEST_ID_PREFIX",
      "request_id_prefix must not be blank when provided.",
    ));
  }
  let offset = query.offset.unwrap_or(0);
  let cutoff_timestamp = max_age_cutoff_timestamp(query.max_age_seconds)?;
  let limit = query
    .limit
    .unwrap_or(DEFAULT_AGENT_OPS_CACHE_ENTRIES_LIMIT)
    .max(1)
    .min(MAX_AGENT_OPS_CACHE_ENTRIES_LIMIT);
  let (total_entries, unscoped_total_entries, entries) = state
    .agent_ops_cache_entries(
      workbook_id,
      normalized_prefix.as_deref(),
      cutoff_timestamp,
      offset,
      limit,
    )
    .await?;
  let mapped_entries = entries
    .into_iter()
    .map(
      |(
        request_id,
        operations_signature,
        operation_count,
        result_count,
        cached_at,
      )| AgentOpsCacheEntry {
        request_id,
        cached_at,
        operations_signature,
        operation_count,
        result_count,
      },
    )
    .collect::<Vec<_>>();
  let has_more = offset + mapped_entries.len() < total_entries;
  Ok(Json(AgentOpsCacheEntriesResponse {
    total_entries,
    unscoped_total_entries,
    returned_entries: mapped_entries.len(),
    request_id_prefix: normalized_prefix,
    max_age_seconds: query.max_age_seconds,
    cutoff_timestamp,
    offset,
    limit,
    has_more,
    entries: mapped_entries,
  }))
}

async fn agent_ops_cache_entry_detail(
  State(state): State<AppState>,
  Path((workbook_id, request_id)): Path<(Uuid, String)>,
) -> Result<Json<AgentOpsCacheEntryDetailResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let normalized_request_id = request_id.trim();
  if normalized_request_id.is_empty() {
    return Err(ApiError::bad_request_with_code(
      "INVALID_REQUEST_ID",
      "request_id is required to fetch cache entry detail.",
    ));
  }
  let (cached_response, operations, cached_at) = state
    .get_cached_agent_ops_replay_data(workbook_id, normalized_request_id)
    .await?
    .ok_or_else(|| {
      ApiError::bad_request_with_code(
        "CACHE_ENTRY_NOT_FOUND",
        format!("No cache entry found for request_id '{normalized_request_id}'."),
      )
    })?;
  Ok(Json(AgentOpsCacheEntryDetailResponse {
    request_id: normalized_request_id.to_string(),
    cached_at,
    operation_count: operations.len(),
    result_count: cached_response.results.len(),
    cached_response,
    operations,
  }))
}

async fn agent_ops_cache_prefixes(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Query(query): Query<AgentOpsCachePrefixesQuery>,
) -> Result<Json<AgentOpsCachePrefixesResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let normalized_prefix =
    normalize_optional_request_id_prefix(query.request_id_prefix.as_deref());
  if query.request_id_prefix.is_some() && normalized_prefix.is_none() {
    return Err(ApiError::bad_request_with_code(
      "INVALID_REQUEST_ID_PREFIX",
      "request_id_prefix must not be blank when provided.",
    ));
  }
  let cutoff_timestamp = max_age_cutoff_timestamp(query.max_age_seconds)?;
  let min_entry_count = query.min_entry_count.unwrap_or(1);
  if min_entry_count == 0 {
    return Err(ApiError::bad_request_with_code(
      "INVALID_MIN_ENTRY_COUNT",
      "min_entry_count must be greater than zero when provided.",
    ));
  }
  if query.min_span_seconds.is_some_and(|value| value <= 0) {
    return Err(ApiError::bad_request_with_code(
      "INVALID_MIN_SPAN_SECONDS",
      "min_span_seconds must be greater than zero when provided.",
    ));
  }
  if query.max_span_seconds.is_some_and(|value| value <= 0) {
    return Err(ApiError::bad_request_with_code(
      "INVALID_MAX_SPAN_SECONDS",
      "max_span_seconds must be greater than zero when provided.",
    ));
  }
  if let (Some(minimum_span), Some(maximum_span)) =
    (query.min_span_seconds, query.max_span_seconds)
  {
    if minimum_span > maximum_span {
      return Err(ApiError::bad_request_with_code(
        "INVALID_SPAN_RANGE",
        "min_span_seconds must be less than or equal to max_span_seconds when both are provided.",
      ));
    }
  }
  let sort_by = normalize_prefix_sort_by(query.sort_by.as_deref())?;
  let offset = query.offset.unwrap_or(0);
  let limit = query
    .limit
    .unwrap_or(DEFAULT_AGENT_OPS_CACHE_PREFIXES_LIMIT)
    .max(1)
    .min(MAX_AGENT_OPS_CACHE_PREFIXES_LIMIT);
  let (
    total_prefixes,
    unscoped_total_prefixes,
    unscoped_total_entries,
    scoped_total_entries,
    prefixes,
  ) = state
    .agent_ops_cache_prefixes(
      workbook_id,
      normalized_prefix.as_deref(),
      cutoff_timestamp,
      min_entry_count,
      query.min_span_seconds,
      query.max_span_seconds,
      sort_by.as_str(),
      offset,
      limit,
    )
    .await?;
  let mapped_prefixes = prefixes
    .into_iter()
    .map(
      |(
        prefix,
        entry_count,
        newest_request_id,
        newest_cached_at,
        oldest_request_id,
        oldest_cached_at,
      )| {
        let span_seconds = match (&oldest_cached_at, &newest_cached_at) {
          (Some(oldest), Some(newest)) => {
            Some(newest.signed_duration_since(*oldest).num_seconds().max(0))
          }
          _ => None,
        };
        AgentOpsCachePrefix {
          prefix,
          entry_count,
          newest_request_id,
          newest_cached_at,
          oldest_request_id,
          oldest_cached_at,
          span_seconds,
        }
      },
    )
    .collect::<Vec<_>>();
  let returned_entry_count = mapped_prefixes
    .iter()
    .map(|prefix| prefix.entry_count)
    .sum::<usize>();
  let has_more = offset + mapped_prefixes.len() < total_prefixes;
  Ok(Json(AgentOpsCachePrefixesResponse {
    total_prefixes,
    unscoped_total_prefixes,
    unscoped_total_entries,
    scoped_total_entries,
    returned_prefixes: mapped_prefixes.len(),
    returned_entry_count,
    request_id_prefix: normalized_prefix,
    min_entry_count,
    min_span_seconds: query.min_span_seconds,
    max_span_seconds: query.max_span_seconds,
    sort_by,
    max_age_seconds: query.max_age_seconds,
    cutoff_timestamp,
    offset,
    limit,
    has_more,
    prefixes: mapped_prefixes,
  }))
}

async fn clear_agent_ops_cache(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
) -> Result<Json<ClearAgentOpsCacheResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let cleared_entries = state.clear_agent_ops_cache(workbook_id).await?;
  Ok(Json(ClearAgentOpsCacheResponse { cleared_entries }))
}

async fn replay_agent_ops_cache_entry(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<ReplayAgentOpsCacheEntryRequest>,
) -> Result<Json<ReplayAgentOpsCacheEntryResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let request_id = payload.request_id.trim();
  if request_id.is_empty() {
    return Err(ApiError::bad_request_with_code(
      "INVALID_REQUEST_ID",
      "request_id is required to replay a cache entry.",
    ));
  }
  let (mut cached_response, operations, cached_at) = state
    .get_cached_agent_ops_replay_data(workbook_id, request_id)
    .await?
    .ok_or_else(|| {
      ApiError::bad_request_with_code(
        "CACHE_ENTRY_NOT_FOUND",
        format!("No cache entry found for request_id '{request_id}'."),
      )
    })?;
  cached_response.served_from_cache = true;
  Ok(Json(ReplayAgentOpsCacheEntryResponse {
    cached_at,
    cached_response,
    operations,
  }))
}

async fn reexecute_agent_ops_cache_entry(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<ReexecuteAgentOpsCacheEntryRequest>,
) -> Result<Json<ReexecuteAgentOpsCacheEntryResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let source_request_id = payload.request_id.trim();
  if source_request_id.is_empty() {
    return Err(ApiError::bad_request_with_code(
      "INVALID_REQUEST_ID",
      "request_id is required to reexecute a cache entry.",
    ));
  }
  let (_, operations, _) = state
    .get_cached_agent_ops_replay_data(workbook_id, source_request_id)
    .await?
    .ok_or_else(|| {
      ApiError::bad_request_with_code(
        "CACHE_ENTRY_NOT_FOUND",
        format!("No cache entry found for request_id '{source_request_id}'."),
      )
    })?;

  let operation_signature = operations_signature(&operations)?;
  validate_expected_operations_signature(
    payload.expected_operations_signature.as_deref(),
    operation_signature.as_str(),
  )?;

  let actor = payload
    .actor
    .unwrap_or_else(|| format!("cache-reexecute:{source_request_id}"));
  let stop_on_error = payload.stop_on_error.unwrap_or(true);
  let (request_id, generated_request_id) = match payload.new_request_id {
    Some(value) => {
      let normalized = value.trim();
      if normalized.is_empty() {
        return Err(ApiError::bad_request_with_code(
          "INVALID_NEW_REQUEST_ID",
          "new_request_id must be non-empty when provided.",
        ));
      }
      (normalized.to_string(), false)
    }
    None => (
      format!("{source_request_id}-rerun-{}", Utc::now().timestamp_millis()),
      true,
    ),
  };

  if let Some(mut cached_response) = state
    .get_cached_agent_ops_response(workbook_id, request_id.as_str())
    .await?
  {
    validate_request_id_signature_consistency(
      cached_response.operations_signature.as_deref(),
      operation_signature.as_str(),
    )?;
    cached_response.served_from_cache = true;
    return Ok(Json(ReexecuteAgentOpsCacheEntryResponse {
      source_request_id: source_request_id.to_string(),
      generated_request_id,
      operations_signature: operation_signature,
      operations_count: operations.len(),
      operations,
      response: cached_response,
    }));
  }

  let results = execute_agent_operations(
    &state,
    workbook_id,
    actor.as_str(),
    stop_on_error,
    operations.clone(),
  )
  .await;
  let response = AgentOpsResponse {
    request_id: Some(request_id.clone()),
    operations_signature: Some(operation_signature.clone()),
    served_from_cache: false,
    results,
  };
  state
    .cache_agent_ops_response(workbook_id, request_id, operations.clone(), response.clone())
    .await?;

  Ok(Json(ReexecuteAgentOpsCacheEntryResponse {
    source_request_id: source_request_id.to_string(),
    generated_request_id,
    operations_signature: operation_signature,
    operations_count: operations.len(),
    operations,
    response,
  }))
}

async fn remove_agent_ops_cache_entry(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<RemoveAgentOpsCacheEntryRequest>,
) -> Result<Json<RemoveAgentOpsCacheEntryResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let request_id = payload.request_id.trim();
  if request_id.is_empty() {
    return Err(ApiError::bad_request_with_code(
      "INVALID_REQUEST_ID",
      "request_id is required to remove a cache entry.",
    ));
  }
  let (removed, remaining_entries) = state
    .remove_agent_ops_cache_entry(workbook_id, request_id)
    .await?;
  Ok(Json(RemoveAgentOpsCacheEntryResponse {
    request_id: request_id.to_string(),
    removed,
    remaining_entries,
  }))
}

async fn remove_agent_ops_cache_entries_by_prefix(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<RemoveAgentOpsCacheEntriesByPrefixRequest>,
) -> Result<Json<RemoveAgentOpsCacheEntriesByPrefixResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let request_id_prefix = normalize_required_request_id_prefix(
    payload.request_id_prefix.as_str(),
    "request_id_prefix is required to remove cache entries by prefix.",
  )?;
  let cutoff_timestamp = max_age_cutoff_timestamp(payload.max_age_seconds)?;
  let (removed_entries, unscoped_matched_entries, remaining_entries) = state
    .remove_agent_ops_cache_entries_by_prefix(
      workbook_id,
      request_id_prefix.as_str(),
      cutoff_timestamp,
    )
    .await?;
  Ok(Json(RemoveAgentOpsCacheEntriesByPrefixResponse {
    request_id_prefix,
    max_age_seconds: payload.max_age_seconds,
    cutoff_timestamp,
    unscoped_matched_entries,
    removed_entries,
    remaining_entries,
  }))
}

const DEFAULT_REMOVE_BY_PREFIX_PREVIEW_SAMPLE_LIMIT: usize = 20;
const MAX_REMOVE_BY_PREFIX_PREVIEW_SAMPLE_LIMIT: usize = 100;
const DEFAULT_REMOVE_STALE_PREVIEW_SAMPLE_LIMIT: usize = 20;
const MAX_REMOVE_STALE_PREVIEW_SAMPLE_LIMIT: usize = 100;

fn normalize_sample_limit(
  sample_limit: Option<usize>,
  default_limit: usize,
  max_limit: usize,
) -> usize {
  sample_limit
    .unwrap_or(default_limit)
    .max(1)
    .min(max_limit)
}

fn normalize_optional_request_id_prefix(prefix: Option<&str>) -> Option<String> {
  prefix
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

fn normalize_required_request_id_prefix(
  prefix: &str,
  context_message: &str,
) -> Result<String, ApiError> {
  let normalized = prefix.trim();
  if normalized.is_empty() {
    return Err(ApiError::bad_request_with_code(
      "INVALID_REQUEST_ID_PREFIX",
      context_message,
    ));
  }
  Ok(normalized.to_string())
}

fn normalize_prefix_sort_by(sort_by: Option<&str>) -> Result<String, ApiError> {
  match sort_by.map(str::trim).filter(|value| !value.is_empty()) {
    None => Ok("count".to_string()),
    Some(value) if value.eq_ignore_ascii_case("count") => {
      Ok("count".to_string())
    }
    Some(value) if value.eq_ignore_ascii_case("recent") => {
      Ok("recent".to_string())
    }
    Some(value) if value.eq_ignore_ascii_case("alpha") => {
      Ok("alpha".to_string())
    }
    Some(value) if value.eq_ignore_ascii_case("span") => {
      Ok("span".to_string())
    }
    Some(_) => Err(ApiError::bad_request_with_code(
      "INVALID_PREFIX_SORT_BY",
      "sort_by must be one of: count, recent, alpha, span.",
    )),
  }
}

fn max_age_cutoff_timestamp(
  max_age_seconds: Option<i64>,
) -> Result<Option<chrono::DateTime<Utc>>, ApiError> {
  if max_age_seconds.is_some_and(|value| value <= 0) {
    return Err(ApiError::bad_request_with_code(
      "INVALID_MAX_AGE_SECONDS",
      "max_age_seconds must be greater than 0.",
    ));
  }
  Ok(max_age_seconds
    .map(|value| Utc::now() - ChronoDuration::seconds(value)))
}

async fn preview_remove_agent_ops_cache_entries_by_prefix(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<PreviewRemoveAgentOpsCacheEntriesByPrefixRequest>,
) -> Result<Json<PreviewRemoveAgentOpsCacheEntriesByPrefixResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let request_id_prefix = normalize_required_request_id_prefix(
    payload.request_id_prefix.as_str(),
    "request_id_prefix is required to preview cache removal by prefix.",
  )?;
  let sample_limit = normalize_sample_limit(
    payload.sample_limit,
    DEFAULT_REMOVE_BY_PREFIX_PREVIEW_SAMPLE_LIMIT,
    MAX_REMOVE_BY_PREFIX_PREVIEW_SAMPLE_LIMIT,
  );
  let cutoff_timestamp = max_age_cutoff_timestamp(payload.max_age_seconds)?;
  let (matched_entries, _, entries) = state
    .agent_ops_cache_entries(
      workbook_id,
      Some(request_id_prefix.as_str()),
      cutoff_timestamp,
      0,
      sample_limit,
    )
    .await?;
  let (unscoped_matched_entries, _, _) = state
    .agent_ops_cache_entries(workbook_id, None, cutoff_timestamp, 0, 0)
    .await?;
  let sample_request_ids = entries
    .into_iter()
    .map(|entry| entry.0)
    .collect::<Vec<_>>();
  Ok(Json(PreviewRemoveAgentOpsCacheEntriesByPrefixResponse {
    request_id_prefix,
    max_age_seconds: payload.max_age_seconds,
    cutoff_timestamp,
    matched_entries,
    unscoped_matched_entries,
    sample_limit,
    sample_request_ids,
  }))
}

async fn remove_stale_agent_ops_cache_entries(
  State(state): State<AppState>,
  Path(workbook_id): Path<Uuid>,
  Json(payload): Json<RemoveStaleAgentOpsCacheEntriesRequest>,
) -> Result<Json<RemoveStaleAgentOpsCacheEntriesResponse>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let normalized_prefix =
    normalize_optional_request_id_prefix(payload.request_id_prefix.as_deref());
  if payload.request_id_prefix.is_some() && normalized_prefix.is_none() {
    return Err(ApiError::bad_request_with_code(
      "INVALID_REQUEST_ID_PREFIX",
      "request_id_prefix must not be blank when provided.",
    ));
  }
  let dry_run = payload.dry_run.unwrap_or(false);
  let sample_limit = normalize_sample_limit(
    payload.sample_limit,
    DEFAULT_REMOVE_STALE_PREVIEW_SAMPLE_LIMIT,
    MAX_REMOVE_STALE_PREVIEW_SAMPLE_LIMIT,
  );
  let cutoff_timestamp = max_age_cutoff_timestamp(Some(payload.max_age_seconds))?
    .expect("required max_age_seconds should always produce cutoff");
  let (
    matched_entries,
    unscoped_matched_entries,
    removed_entries,
    remaining_entries,
    sample_request_ids,
  ) = state
    .remove_stale_agent_ops_cache_entries(
      workbook_id,
      normalized_prefix.as_deref(),
      cutoff_timestamp,
      dry_run,
      sample_limit,
    )
    .await?;

  Ok(Json(RemoveStaleAgentOpsCacheEntriesResponse {
    request_id_prefix: normalized_prefix,
    max_age_seconds: payload.max_age_seconds,
    dry_run,
    cutoff_timestamp,
    matched_entries,
    unscoped_matched_entries,
    removed_entries,
    remaining_entries,
    sample_limit,
    sample_request_ids,
  }))
}

async fn run_agent_preset(
  State(state): State<AppState>,
  Path((workbook_id, preset)): Path<(Uuid, String)>,
  Json(payload): Json<AgentPresetRunRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
  state.get_workbook(workbook_id).await?;
  let operations =
    build_preset_operations(preset.as_str(), payload.include_file_base64)?;
  let operation_signature = operations_signature(&operations)?;
  validate_expected_operations_signature(
    payload.expected_operations_signature.as_deref(),
    operation_signature.as_str(),
  )?;
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
    "operations_signature": operation_signature,
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
  let operation_signature = operations_signature(&operations)?;
  validate_expected_operations_signature(
    payload.expected_operations_signature.as_deref(),
    operation_signature.as_str(),
  )?;
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
    "operations_signature": operation_signature,
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
      "/v1/agent/wizard/schema": {"get": {"summary": "Get schema for wizard orchestration endpoint"}},
      "/v1/agent/wizard/presets": {"get": {"summary": "List wizard presets without requiring workbook context"}},
      "/v1/agent/wizard/presets/{preset}/operations": {"get": {"summary": "Preview operation sequence generated by a wizard preset"}},
      "/v1/agent/wizard/scenarios": {"get": {"summary": "List wizard scenarios without requiring workbook context"}},
      "/v1/agent/wizard/scenarios/{scenario}/operations": {"get": {"summary": "Preview operation sequence generated by a wizard scenario"}},
      "/v1/agent/wizard/run": {"post": {"summary": "Wizard endpoint: optional import + scenario execution + optional export payload"}},
      "/v1/agent/wizard/run-json": {"post": {"summary": "JSON wizard endpoint with optional base64 import payload for agent callers"}},
      "/v1/workbooks": {"post": {"summary": "Create workbook"}},
      "/v1/workbooks/import": {"post": {"summary": "Import .xlsx"}},
      "/v1/workbooks/{id}": {"get": {"summary": "Get workbook"}},
      "/v1/workbooks/{id}/sheets": {"get": {"summary": "List sheets"}, "post": {"summary": "Create sheet"}},
      "/v1/workbooks/{id}/cells/set-batch": {"post": {"summary": "Batch set cells"}},
      "/v1/workbooks/{id}/agent/ops": {"post": {"summary": "AI-friendly multi-operation endpoint (supports create_sheet/export_workbook ops)"}},
      "/v1/workbooks/{id}/agent/ops/preview": {"post": {"summary": "Preview and sign a provided agent operation plan without execution"}},
      "/v1/workbooks/{id}/agent/ops/cache": {"get": {"summary": "Inspect request-id idempotency cache status for agent ops"}},
      "/v1/workbooks/{id}/agent/ops/cache/entries": {"get": {"summary": "List recent request-id idempotency cache entries for agent ops"}},
      "/v1/workbooks/{id}/agent/ops/cache/entries/{request_id}": {"get": {"summary": "Get detailed payload for a single cached request-id entry"}},
      "/v1/workbooks/{id}/agent/ops/cache/prefixes": {"get": {"summary": "List request-id prefix suggestions from cached entries"}},
      "/v1/workbooks/{id}/agent/ops/cache/clear": {"post": {"summary": "Clear request-id idempotency cache for agent ops"}},
      "/v1/workbooks/{id}/agent/ops/cache/replay": {"post": {"summary": "Replay a cached request-id response for agent ops"}},
      "/v1/workbooks/{id}/agent/ops/cache/reexecute": {"post": {"summary": "Reexecute cached operations as a fresh agent ops request"}},
      "/v1/workbooks/{id}/agent/ops/cache/remove": {"post": {"summary": "Remove a single request-id idempotency cache entry for agent ops"}},
      "/v1/workbooks/{id}/agent/ops/cache/remove-by-prefix": {"post": {"summary": "Remove all cached request-id entries matching a prefix"}},
      "/v1/workbooks/{id}/agent/ops/cache/remove-by-prefix/preview": {"post": {"summary": "Preview affected cache entries for prefix removal"}},
      "/v1/workbooks/{id}/agent/ops/cache/remove-stale": {"post": {"summary": "Remove or preview stale cache entries older than max_age_seconds"}},
      "/v1/workbooks/{id}/agent/schema": {"get": {"summary": "Get operation schema for AI agent callers"}},
      "/v1/workbooks/{id}/agent/presets": {"get": {"summary": "List available built-in agent presets"}},
      "/v1/workbooks/{id}/agent/presets/{preset}/operations": {"get": {"summary": "Preview generated operations for a built-in preset"}},
      "/v1/workbooks/{id}/agent/presets/{preset}": {"post": {"summary": "Run built-in AI operation preset (seed_sales_demo/export_snapshot)"}},
      "/v1/workbooks/{id}/agent/scenarios": {"get": {"summary": "List available built-in agent scenarios"}},
      "/v1/workbooks/{id}/agent/scenarios/{scenario}/operations": {"get": {"summary": "Preview generated operations for a built-in scenario"}},
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
  use axum::{extract::Path, extract::Query, extract::State, Json};
  use rust_xlsxwriter::{Formula, Workbook};
  use std::time::Duration;
  use tempfile::tempdir;
  use tokio::time::timeout;

  use super::{
    agent_ops, agent_ops_cache_entries, agent_ops_cache_entry_detail,
    agent_ops_cache_prefixes,
    agent_ops_cache_stats,
    clear_agent_ops_cache, get_agent_schema, get_agent_wizard_schema,
    FORMULA_SUPPORTED_FUNCTION_LIST, FORMULA_UNSUPPORTED_BEHAVIOR_LIST,
    formula_supported_functions_summary, formula_unsupported_behaviors_summary,
    remove_agent_ops_cache_entry,
    remove_agent_ops_cache_entries_by_prefix,
    remove_stale_agent_ops_cache_entries,
    preview_remove_agent_ops_cache_entries_by_prefix,
    replay_agent_ops_cache_entry, reexecute_agent_ops_cache_entry,
    build_export_artifacts, build_preset_operations, build_scenario_operations,
    ensure_non_empty_operations,
    import_bytes_into_workbook,
    normalize_sheet_name, operations_signature, parse_optional_bool,
    validate_expected_operations_signature,
    validate_request_id_signature_consistency, AgentOpsCacheEntriesQuery,
    AgentOpsCachePrefixesQuery, AgentOpsCacheStatsQuery,
    MAX_AGENT_OPS_CACHE_ENTRIES_LIMIT,
  };
  use crate::{
    models::{
      AgentOperation, AgentOpsRequest, RemoveAgentOpsCacheEntryRequest,
      RemoveAgentOpsCacheEntriesByPrefixRequest,
      PreviewRemoveAgentOpsCacheEntriesByPrefixRequest,
      RemoveStaleAgentOpsCacheEntriesRequest,
      ReexecuteAgentOpsCacheEntryRequest,
      ReplayAgentOpsCacheEntryRequest,
    },
    state::{AppState, AGENT_OPS_CACHE_MAX_ENTRIES},
  };

  fn workbook_import_fixture_bytes() -> Vec<u8> {
    let mut workbook = Workbook::new();
    let inputs_sheet = workbook.add_worksheet();
    inputs_sheet.set_name("Inputs").expect("sheet should be renamed");
    inputs_sheet
      .write_string(0, 0, "Region")
      .expect("header should write");
    inputs_sheet
      .write_string(1, 0, "North")
      .expect("text should write");
    inputs_sheet
      .write_string(2, 0, "South")
      .expect("text should write");
    inputs_sheet
      .write_string(0, 1, "Sales")
      .expect("header should write");
    inputs_sheet
      .write_number(1, 1, 120.0)
      .expect("number should write");
    inputs_sheet
      .write_number(2, 1, 80.0)
      .expect("number should write");
    inputs_sheet
      .write_string(0, 2, "Total")
      .expect("header should write");
    inputs_sheet
      .write_formula(1, 2, Formula::new("=SUM(B2:B3)"))
      .expect("formula should write");
    inputs_sheet
      .write_string(0, 3, "Active")
      .expect("header should write");
    inputs_sheet
      .write_boolean(1, 3, true)
      .expect("boolean should write");

    let notes_sheet = workbook.add_worksheet();
    notes_sheet.set_name("Notes").expect("sheet should be renamed");
    notes_sheet
      .write_string(0, 0, "Generated from fixture workbook")
      .expect("notes text should write");

    workbook
      .save_to_buffer()
      .expect("fixture workbook should serialize")
  }

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
  fn should_apply_include_file_flag_to_export_preset() {
    let operations = build_preset_operations("export_snapshot", Some(false))
      .expect("export_snapshot should be supported");
    let export_op = operations
      .iter()
      .find(|operation| {
        matches!(operation, crate::models::AgentOperation::ExportWorkbook { .. })
      })
      .expect("export operation should exist");

    match export_op {
      crate::models::AgentOperation::ExportWorkbook {
        include_file_base64,
      } => assert_eq!(*include_file_base64, Some(false)),
      _ => panic!("expected export operation variant"),
    }
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

  #[test]
  fn should_apply_include_file_flag_to_export_in_scenarios() {
    let operations = build_scenario_operations("refresh_and_export", Some(false))
      .expect("refresh_and_export should be supported");
    let export_op = operations
      .iter()
      .find(|operation| {
        matches!(operation, crate::models::AgentOperation::ExportWorkbook { .. })
      })
      .expect("export operation should exist");

    match export_op {
      crate::models::AgentOperation::ExportWorkbook {
        include_file_base64,
      } => assert_eq!(*include_file_base64, Some(false)),
      _ => panic!("expected export operation variant"),
    }
  }

  #[test]
  fn should_parse_optional_boolean_fields() {
    assert_eq!(
      parse_optional_bool(Some("true".to_string()), "flag")
        .expect("true should parse"),
      Some(true),
    );
    assert_eq!(
      parse_optional_bool(Some("0".to_string()), "flag")
        .expect("0 should parse"),
      Some(false),
    );
    assert_eq!(
      parse_optional_bool(None, "flag").expect("none should parse"),
      None,
    );
    assert!(
      parse_optional_bool(Some("not-a-bool".to_string()), "flag").is_err(),
      "invalid bool-like value should fail",
    );
  }

  #[tokio::test]
  async fn should_import_fixture_bytes_into_existing_workbook() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("import-helper-fixture".to_string()))
      .await
      .expect("workbook should be created");
    let mut events = state
      .subscribe(workbook.id)
      .await
      .expect("event subscription should work");

    let import_result = import_bytes_into_workbook(
      &state,
      workbook.id,
      &workbook_import_fixture_bytes(),
      "fixture-import",
    )
    .await
    .expect("fixture import should succeed");

    assert_eq!(import_result.sheets_imported, 2);
    assert_eq!(import_result.cells_imported, 11);
    assert_eq!(
      import_result.formula_cells_imported,
      import_result.formula_cells_with_cached_values
        + import_result.formula_cells_without_cached_values,
    );
    assert!(
      import_result.formula_cells_imported > 0,
      "fixture should include formula cells",
    );

    let refreshed = state
      .get_workbook(workbook.id)
      .await
      .expect("workbook should be readable after import");
    assert!(
      refreshed.sheets.iter().any(|sheet| sheet == "Inputs"),
      "import should register input sheet",
    );
    assert!(
      refreshed.sheets.iter().any(|sheet| sheet == "Notes"),
      "import should register notes sheet",
    );
    assert!(
      !refreshed.compatibility_warnings.is_empty(),
      "import should add compatibility warnings",
    );

    let emitted_event = timeout(Duration::from_secs(1), events.recv())
      .await
      .expect("import event should arrive")
      .expect("event payload should decode");
    assert_eq!(emitted_event.event_type, "workbook.imported");
    assert_eq!(emitted_event.actor, "fixture-import");
    assert_eq!(
      emitted_event
        .payload
        .get("formula_cells_imported")
        .and_then(serde_json::Value::as_u64),
      Some(import_result.formula_cells_imported as u64),
    );
    assert_eq!(
      emitted_event
        .payload
        .get("formula_cells_with_cached_values")
        .and_then(serde_json::Value::as_u64),
      Some(import_result.formula_cells_with_cached_values as u64),
    );
    assert_eq!(
      emitted_event
        .payload
        .get("formula_cells_without_cached_values")
        .and_then(serde_json::Value::as_u64),
      Some(import_result.formula_cells_without_cached_values as u64),
    );
  }

  #[tokio::test]
  async fn should_encode_compatibility_report_only_in_export_meta_payload() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("export-meta-schema".to_string()))
      .await
      .expect("workbook should be created");

    let (_, export_response, report_json) = build_export_artifacts(&state, workbook.id)
      .await
      .expect("export artifacts should build");
    let report_value: serde_json::Value =
      serde_json::from_str(report_json.as_str()).expect("export report json should parse");
    assert!(
      report_value.get("preserved").is_some(),
      "export meta should include compatibility report arrays",
    );
    assert!(
      report_value.get("file_name").is_none(),
      "export meta should not include top-level file_name envelope",
    );
    assert!(
      !export_response.file_name.is_empty(),
      "export response should still carry file name separately",
    );
  }

  #[test]
  fn should_generate_stable_operation_signatures() {
    let operations = build_scenario_operations("refresh_and_export", Some(false))
      .expect("scenario operations should build");
    let signature_a =
      operations_signature(&operations).expect("signature should build");
    let signature_b =
      operations_signature(&operations).expect("signature should be stable");
    assert_eq!(signature_a, signature_b);
    assert!(!signature_a.is_empty());
  }

  #[test]
  fn should_validate_expected_operation_signatures() {
    let operations = build_preset_operations("export_snapshot", Some(false))
      .expect("preset operations should build");
    let signature =
      operations_signature(&operations).expect("signature should build");
    assert!(
      validate_expected_operations_signature(Some(signature.as_str()), signature.as_str())
        .is_ok(),
      "matching signature should validate",
    );
    let uppercase_signature = signature.to_ascii_uppercase();
    assert!(
      validate_expected_operations_signature(
        Some(uppercase_signature.as_str()),
        signature.as_str(),
      )
      .is_ok(),
      "signature validation should be case-insensitive for hex digests",
    );
    assert!(
      validate_expected_operations_signature(Some("mismatch"), signature.as_str())
        .is_err(),
      "mismatching signature should fail",
    );
    let invalid_format_error =
      validate_expected_operations_signature(Some("xyz"), signature.as_str())
        .expect_err("invalid signature format should fail");
    match invalid_format_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_SIGNATURE_FORMAT");
      }
      _ => panic!("expected bad request with custom error code"),
    }

    let mismatch_error =
      validate_expected_operations_signature(Some("a".repeat(64).as_str()), signature.as_str())
        .expect_err("mismatch should fail");
    match mismatch_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "OPERATION_SIGNATURE_MISMATCH");
      }
      _ => panic!("expected bad request with custom error code"),
    }
  }

  #[test]
  fn should_allow_blank_expected_signature_values() {
    let operations = build_preset_operations("export_snapshot", Some(false))
      .expect("preset operations should build");
    let signature =
      operations_signature(&operations).expect("signature should build");
    assert!(
      validate_expected_operations_signature(Some("   "), signature.as_str())
        .is_ok(),
      "blank signature should be treated as omitted",
    );
  }

  #[test]
  fn should_change_signature_when_operations_change() {
    let without_file = build_scenario_operations("refresh_and_export", Some(false))
      .expect("scenario should build");
    let with_file = build_scenario_operations("refresh_and_export", Some(true))
      .expect("scenario should build");
    let without_file_signature = operations_signature(&without_file)
      .expect("signature should build");
    let with_file_signature =
      operations_signature(&with_file).expect("signature should build");
    assert_ne!(
      without_file_signature, with_file_signature,
      "signature should change when operation payload changes",
    );
  }

  #[test]
  fn should_reject_empty_operation_lists() {
    let empty_error = ensure_non_empty_operations(&[])
      .expect_err("empty operation arrays should fail validation");
    match empty_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "EMPTY_OPERATION_LIST");
      }
      _ => panic!("expected bad request with custom error code"),
    }

    let operations = build_preset_operations("export_snapshot", Some(false))
      .expect("preset operations should build");
    assert!(
      ensure_non_empty_operations(&operations).is_ok(),
      "non-empty operation arrays should pass validation",
    );
  }

  #[test]
  fn should_reject_request_id_signature_conflicts() {
    assert!(
      validate_request_id_signature_consistency(Some("abc"), "abc").is_ok(),
      "matching cached and incoming signatures should pass",
    );
    assert!(
      validate_request_id_signature_consistency(None, "abc").is_ok(),
      "missing cached signature should be tolerated",
    );
    let conflict_error =
      validate_request_id_signature_consistency(Some("abc"), "def")
        .expect_err("signature mismatch should fail");
    match conflict_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "REQUEST_ID_CONFLICT");
      }
      _ => panic!("expected bad request with custom error code"),
    }
  }

  #[tokio::test]
  async fn should_round_trip_cache_stats_and_clear_via_handlers() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache".to_string()))
      .await
      .expect("workbook should be created");

    let first_response = agent_ops(
      State(state.clone()),
      Path(workbook.id),
      Json(AgentOpsRequest {
        request_id: Some("handler-req-1".to_string()),
        actor: Some("test".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
        operations: vec![AgentOperation::Recalculate],
      }),
    )
    .await
    .expect("agent ops should succeed")
    .0;
    assert!(
      !first_response.served_from_cache,
      "first request should not be cache hit",
    );

    let replay_response = agent_ops(
      State(state.clone()),
      Path(workbook.id),
      Json(AgentOpsRequest {
        request_id: Some("handler-req-1".to_string()),
        actor: Some("test".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
        operations: vec![AgentOperation::Recalculate],
      }),
    )
    .await
    .expect("agent ops replay should succeed")
    .0;
    assert!(
      replay_response.served_from_cache,
      "replay should be served from cache",
    );

    let stats = agent_ops_cache_stats(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheStatsQuery {
        request_id_prefix: None,
        max_age_seconds: None,
      }),
    )
    .await
    .expect("stats should load")
    .0;
    assert_eq!(stats.entries, 1);
    assert_eq!(stats.unscoped_entries, 1);
    assert_eq!(stats.request_id_prefix, None);
    assert_eq!(stats.max_age_seconds, None);
    assert!(stats.cutoff_timestamp.is_none());
    assert_eq!(stats.oldest_request_id.as_deref(), Some("handler-req-1"));
    assert_eq!(stats.newest_request_id.as_deref(), Some("handler-req-1"));
    assert!(stats.oldest_cached_at.is_some());
    assert!(stats.newest_cached_at.is_some());

    let prefix_scoped_stats = agent_ops_cache_stats(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheStatsQuery {
        request_id_prefix: Some("handler-".to_string()),
        max_age_seconds: None,
      }),
    )
    .await
    .expect("prefix-scoped stats should load")
    .0;
    assert_eq!(
      prefix_scoped_stats.request_id_prefix.as_deref(),
      Some("handler-"),
    );
    assert_eq!(prefix_scoped_stats.entries, 1);
    assert_eq!(prefix_scoped_stats.unscoped_entries, 1);

    let scoped_stats = agent_ops_cache_stats(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheStatsQuery {
        request_id_prefix: None,
        max_age_seconds: Some(86_400),
      }),
    )
    .await
    .expect("age-scoped stats should load")
    .0;
    assert_eq!(scoped_stats.request_id_prefix, None);
    assert_eq!(scoped_stats.max_age_seconds, Some(86_400));
    assert!(scoped_stats.cutoff_timestamp.is_some());
    assert_eq!(scoped_stats.entries, 0);
    assert_eq!(scoped_stats.unscoped_entries, 1);

    let cleared = clear_agent_ops_cache(
      State(state.clone()),
      Path(workbook.id),
    )
    .await
    .expect("cache clear should succeed")
    .0;
    assert_eq!(cleared.cleared_entries, 1);

    let stats_after_clear = agent_ops_cache_stats(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheStatsQuery {
        request_id_prefix: None,
        max_age_seconds: None,
      }),
    )
    .await
    .expect("stats should load")
    .0;
    assert_eq!(stats_after_clear.entries, 0);
    assert_eq!(stats_after_clear.unscoped_entries, 0);
    assert!(stats_after_clear.cutoff_timestamp.is_none());
    assert!(stats_after_clear.oldest_request_id.is_none());
    assert!(stats_after_clear.newest_request_id.is_none());
    assert!(stats_after_clear.oldest_cached_at.is_none());
    assert!(stats_after_clear.newest_cached_at.is_none());

    let invalid_stats_error = agent_ops_cache_stats(
      State(state),
      Path(workbook.id),
      Query(AgentOpsCacheStatsQuery {
        request_id_prefix: None,
        max_age_seconds: Some(0),
      }),
    )
    .await
    .expect_err("non-positive max age should fail for stats");
    match invalid_stats_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_MAX_AGE_SECONDS");
      }
      _ => panic!("expected invalid max age to use custom error code"),
    }
  }

  #[tokio::test]
  async fn should_list_cache_entries_from_newest_with_limit() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-entries".to_string()))
      .await
      .expect("workbook should be created");

    for index in 1..=3 {
      let request_id = format!("handler-entries-{index}");
      let _ = agent_ops(
        State(state.clone()),
        Path(workbook.id),
        Json(AgentOpsRequest {
          request_id: Some(request_id),
          actor: Some("test".to_string()),
          stop_on_error: Some(true),
          expected_operations_signature: None,
          operations: vec![AgentOperation::Recalculate],
        }),
      )
      .await
      .expect("agent ops should succeed");
    }

    let entries_response = agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheEntriesQuery {
        request_id_prefix: None,
        max_age_seconds: None,
        offset: Some(0),
        limit: Some(2),
      }),
    )
    .await
    .expect("entries should load")
    .0;

    assert_eq!(entries_response.total_entries, 3);
    assert_eq!(entries_response.unscoped_total_entries, 3);
    assert_eq!(entries_response.returned_entries, 2);
    assert_eq!(entries_response.request_id_prefix, None);
    assert!(entries_response.cutoff_timestamp.is_none());
    assert_eq!(entries_response.offset, 0);
    assert_eq!(entries_response.limit, 2);
    assert!(entries_response.has_more);
    assert_eq!(entries_response.entries[0].request_id, "handler-entries-3");
    assert_eq!(entries_response.entries[1].request_id, "handler-entries-2");
    assert_eq!(entries_response.entries[0].operation_count, 1);
    assert_eq!(entries_response.entries[0].result_count, 1);

    let capped_response = agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheEntriesQuery {
        request_id_prefix: None,
        max_age_seconds: None,
        offset: Some(2),
        limit: Some(9_999),
      }),
    )
    .await
    .expect("entries should load")
    .0;
    assert_eq!(capped_response.total_entries, 3);
    assert_eq!(capped_response.unscoped_total_entries, 3);
    assert_eq!(capped_response.returned_entries, 1);
    assert_eq!(capped_response.offset, 2);
    assert_eq!(capped_response.limit, MAX_AGENT_OPS_CACHE_ENTRIES_LIMIT);
    assert!(!capped_response.has_more);
    assert_eq!(capped_response.entries[0].request_id, "handler-entries-1");

    let min_clamped_response = agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheEntriesQuery {
        request_id_prefix: None,
        max_age_seconds: None,
        offset: Some(0),
        limit: Some(0),
      }),
    )
    .await
    .expect("zero limit should clamp to one")
    .0;
    assert_eq!(min_clamped_response.limit, 1);
    assert_eq!(min_clamped_response.returned_entries, 1);
    assert_eq!(min_clamped_response.entries[0].request_id, "handler-entries-3");

    let filtered_response = agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheEntriesQuery {
        request_id_prefix: Some("handler-entries-2".to_string()),
        max_age_seconds: None,
        offset: Some(0),
        limit: Some(5),
      }),
    )
    .await
    .expect("filtered entries should load")
    .0;
    assert_eq!(filtered_response.total_entries, 1);
    assert_eq!(filtered_response.unscoped_total_entries, 3);
    assert_eq!(filtered_response.returned_entries, 1);
    assert_eq!(
      filtered_response.request_id_prefix.as_deref(),
      Some("handler-entries-2"),
    );
    assert!(!filtered_response.has_more);
    assert_eq!(
      filtered_response.entries[0].request_id,
      "handler-entries-2",
    );

    let age_filtered_response = agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheEntriesQuery {
        request_id_prefix: None,
        max_age_seconds: Some(86_400),
        offset: Some(0),
        limit: Some(10),
      }),
    )
    .await
    .expect("age-filtered entries should load")
    .0;
    assert_eq!(age_filtered_response.max_age_seconds, Some(86_400));
    assert!(age_filtered_response.cutoff_timestamp.is_some());
    assert_eq!(age_filtered_response.total_entries, 0);
    assert_eq!(age_filtered_response.unscoped_total_entries, 3);
    assert!(age_filtered_response.entries.is_empty());
  }

  #[tokio::test]
  async fn should_reject_non_positive_max_age_when_listing_cache_entries() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-entries-invalid-max-age".to_string()))
      .await
      .expect("workbook should be created");

    let error = agent_ops_cache_entries(
      State(state),
      Path(workbook.id),
      Query(AgentOpsCacheEntriesQuery {
        request_id_prefix: None,
        max_age_seconds: Some(0),
        offset: Some(0),
        limit: Some(20),
      }),
    )
    .await
    .expect_err("non-positive max age should fail");

    match error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_MAX_AGE_SECONDS");
      }
      _ => panic!("expected invalid max age to use custom error code"),
    }
  }

  #[tokio::test]
  async fn should_reject_blank_prefix_when_querying_cache_views() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-query-prefix-invalid".to_string()))
      .await
      .expect("workbook should be created");

    let stats_error = agent_ops_cache_stats(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheStatsQuery {
        request_id_prefix: Some("   ".to_string()),
        max_age_seconds: None,
      }),
    )
    .await
    .expect_err("blank prefix should fail for stats query");
    match stats_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_REQUEST_ID_PREFIX");
      }
      _ => panic!("expected blank stats prefix to use custom error code"),
    }

    let entries_error = agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCacheEntriesQuery {
        request_id_prefix: Some("   ".to_string()),
        max_age_seconds: None,
        offset: Some(0),
        limit: Some(20),
      }),
    )
    .await
    .expect_err("blank prefix should fail for entries query");
    match entries_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_REQUEST_ID_PREFIX");
      }
      _ => panic!("expected blank entries prefix to use custom error code"),
    }

    let prefixes_error = agent_ops_cache_prefixes(
      State(state),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: Some("   ".to_string()),
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect_err("blank prefix should fail for prefixes query");
    match prefixes_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_REQUEST_ID_PREFIX");
      }
      _ => panic!("expected blank prefixes prefix to use custom error code"),
    }
  }

  #[tokio::test]
  async fn should_list_cache_prefixes_via_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-prefixes".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["scenario-a", "scenario-b", "preset-a"] {
      let _ = agent_ops(
        State(state.clone()),
        Path(workbook.id),
        Json(AgentOpsRequest {
          request_id: Some(request_id.to_string()),
          actor: Some("test".to_string()),
          stop_on_error: Some(true),
          expected_operations_signature: None,
          operations: vec![AgentOperation::Recalculate],
        }),
      )
      .await
      .expect("agent ops should succeed");
    }

    let prefixes = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect("prefixes should load")
    .0;

    assert_eq!(prefixes.total_prefixes, 2);
    assert_eq!(prefixes.unscoped_total_prefixes, 2);
    assert_eq!(prefixes.unscoped_total_entries, 3);
    assert_eq!(prefixes.scoped_total_entries, 3);
    assert_eq!(prefixes.returned_prefixes, 2);
    assert_eq!(prefixes.returned_entry_count, 3);
    assert_eq!(prefixes.request_id_prefix, None);
    assert_eq!(prefixes.min_entry_count, 1);
    assert_eq!(prefixes.min_span_seconds, None);
    assert_eq!(prefixes.max_span_seconds, None);
    assert_eq!(prefixes.sort_by, "count");
    assert_eq!(prefixes.max_age_seconds, None);
    assert!(prefixes.cutoff_timestamp.is_none());
    assert_eq!(prefixes.offset, 0);
    assert!(!prefixes.has_more);
    assert_eq!(prefixes.prefixes[0].prefix, "scenario-");
    assert_eq!(prefixes.prefixes[0].entry_count, 2);
    assert_eq!(prefixes.prefixes[0].newest_request_id, "scenario-b");
    assert!(prefixes.prefixes[0].newest_cached_at.is_some());
    assert_eq!(prefixes.prefixes[0].oldest_request_id, "scenario-a");
    assert!(prefixes.prefixes[0].oldest_cached_at.is_some());
    assert!(prefixes.prefixes[0].span_seconds.is_some());
    assert_eq!(prefixes.prefixes[1].prefix, "preset-");
    assert_eq!(prefixes.prefixes[1].entry_count, 1);
    assert_eq!(prefixes.prefixes[1].newest_request_id, "preset-a");
    assert!(prefixes.prefixes[1].newest_cached_at.is_some());
    assert_eq!(prefixes.prefixes[1].oldest_request_id, "preset-a");
    assert!(prefixes.prefixes[1].oldest_cached_at.is_some());
    assert_eq!(prefixes.prefixes[1].span_seconds, Some(0));

    let paged_prefixes = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: Some("count".to_string()),
        max_age_seconds: None,
        offset: Some(1),
        limit: Some(1),
      }),
    )
    .await
    .expect("paged prefixes should load")
    .0;
    assert_eq!(paged_prefixes.offset, 1);
    assert_eq!(paged_prefixes.limit, 1);
    assert!(!paged_prefixes.has_more);
    assert_eq!(paged_prefixes.unscoped_total_entries, 3);
    assert_eq!(paged_prefixes.scoped_total_entries, 3);
    assert_eq!(paged_prefixes.returned_prefixes, 1);
    assert_eq!(paged_prefixes.returned_entry_count, 1);
    assert_eq!(paged_prefixes.prefixes[0].prefix, "preset-");

    let min_clamped_prefixes = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(0),
      }),
    )
    .await
    .expect("zero prefix limit should clamp to one")
    .0;
    assert_eq!(min_clamped_prefixes.limit, 1);
    assert_eq!(min_clamped_prefixes.returned_prefixes, 1);
    assert_eq!(min_clamped_prefixes.prefixes[0].prefix, "scenario-");

    let age_filtered = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: Some(86_400),
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect("age-filtered prefixes should load")
    .0;
    assert_eq!(age_filtered.max_age_seconds, Some(86_400));
    assert_eq!(age_filtered.min_entry_count, 1);
    assert_eq!(age_filtered.min_span_seconds, None);
    assert_eq!(age_filtered.max_span_seconds, None);
    assert_eq!(age_filtered.sort_by, "count");
    assert!(age_filtered.cutoff_timestamp.is_some());
    assert_eq!(age_filtered.total_prefixes, 0);
    assert_eq!(age_filtered.unscoped_total_prefixes, 2);
    assert_eq!(age_filtered.unscoped_total_entries, 3);
    assert_eq!(age_filtered.scoped_total_entries, 0);
    assert_eq!(age_filtered.request_id_prefix, None);
    assert_eq!(age_filtered.offset, 0);
    assert!(!age_filtered.has_more);
    assert!(age_filtered.prefixes.is_empty());

    let prefix_filtered = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: Some("scenario-".to_string()),
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect("prefix-filtered prefixes should load")
    .0;
    assert_eq!(prefix_filtered.total_prefixes, 1);
    assert_eq!(prefix_filtered.unscoped_total_prefixes, 2);
    assert_eq!(prefix_filtered.unscoped_total_entries, 3);
    assert_eq!(prefix_filtered.scoped_total_entries, 2);
    assert_eq!(
      prefix_filtered.request_id_prefix.as_deref(),
      Some("scenario-"),
    );
    assert_eq!(prefix_filtered.min_entry_count, 1);
    assert_eq!(prefix_filtered.min_span_seconds, None);
    assert_eq!(prefix_filtered.max_span_seconds, None);
    assert_eq!(prefix_filtered.sort_by, "count");
    assert_eq!(prefix_filtered.offset, 0);
    assert!(!prefix_filtered.has_more);
    assert_eq!(prefix_filtered.prefixes.len(), 1);
    assert_eq!(prefix_filtered.prefixes[0].prefix, "scenario-");
    assert_eq!(prefix_filtered.prefixes[0].entry_count, 2);
    assert_eq!(prefix_filtered.prefixes[0].newest_request_id, "scenario-b");
    assert!(prefix_filtered.prefixes[0].newest_cached_at.is_some());
    assert_eq!(prefix_filtered.prefixes[0].oldest_request_id, "scenario-a");
    assert!(prefix_filtered.prefixes[0].oldest_cached_at.is_some());
    assert!(prefix_filtered.prefixes[0].span_seconds.is_some());

    let min_filtered = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: Some(2),
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect("min-entry-count filtered prefixes should load")
    .0;
    assert_eq!(min_filtered.min_entry_count, 2);
    assert_eq!(min_filtered.min_span_seconds, None);
    assert_eq!(min_filtered.max_span_seconds, None);
    assert_eq!(min_filtered.sort_by, "count");
    assert_eq!(min_filtered.total_prefixes, 1);
    assert_eq!(min_filtered.unscoped_total_prefixes, 2);
    assert_eq!(min_filtered.unscoped_total_entries, 3);
    assert_eq!(min_filtered.scoped_total_entries, 2);
    assert_eq!(min_filtered.returned_prefixes, 1);
    assert_eq!(min_filtered.returned_entry_count, 2);
    assert_eq!(min_filtered.offset, 0);
    assert!(!min_filtered.has_more);
    assert_eq!(min_filtered.prefixes[0].prefix, "scenario-");
    assert_eq!(min_filtered.prefixes[0].entry_count, 2);

    let span_filtered = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: Some(1),
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect("min-span filtered prefixes should load")
    .0;
    assert_eq!(span_filtered.min_span_seconds, Some(1));
    assert_eq!(span_filtered.max_span_seconds, None);
    assert_eq!(span_filtered.total_prefixes, 0);
    assert!(span_filtered.prefixes.is_empty());

    let max_span_filtered = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: Some(1),
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect("max-span filtered prefixes should load")
    .0;
    assert_eq!(max_span_filtered.max_span_seconds, Some(1));
    assert_eq!(max_span_filtered.total_prefixes, 2);
    assert_eq!(max_span_filtered.prefixes.len(), 2);

    let invalid_error = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: Some(0),
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect_err("non-positive max age should fail");
    match invalid_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_MAX_AGE_SECONDS");
      }
      _ => panic!("expected invalid max age to use custom error code"),
    }

    let invalid_min_error = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: Some(0),
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect_err("non-positive min entry count should fail");
    match invalid_min_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_MIN_ENTRY_COUNT");
      }
      _ => panic!("expected invalid min entry count to use custom error code"),
    }

    let invalid_min_span_error = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: Some(0),
        max_span_seconds: None,
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect_err("non-positive min span should fail");
    match invalid_min_span_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_MIN_SPAN_SECONDS");
      }
      _ => panic!("expected invalid min span to use custom error code"),
    }

    let invalid_max_span_error = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: Some(0),
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect_err("non-positive max span should fail");
    match invalid_max_span_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_MAX_SPAN_SECONDS");
      }
      _ => panic!("expected invalid max span to use custom error code"),
    }

    let invalid_span_range_error = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: Some(10),
        max_span_seconds: Some(1),
        sort_by: None,
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect_err("min span greater than max span should fail");
    match invalid_span_range_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_SPAN_RANGE");
      }
      _ => panic!("expected invalid span range to use custom error code"),
    }

    let recent_sorted = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: Some("recent".to_string()),
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect("recent-sorted prefixes should load")
    .0;
    assert_eq!(recent_sorted.sort_by, "recent");
    assert_eq!(recent_sorted.min_span_seconds, None);
    assert_eq!(recent_sorted.max_span_seconds, None);
    assert_eq!(recent_sorted.prefixes[0].prefix, "preset-");
    assert_eq!(recent_sorted.prefixes[1].prefix, "scenario-");

    let alpha_sorted = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: Some("alpha".to_string()),
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect("alpha-sorted prefixes should load")
    .0;
    assert_eq!(alpha_sorted.sort_by, "alpha");
    assert_eq!(alpha_sorted.min_span_seconds, None);
    assert_eq!(alpha_sorted.max_span_seconds, None);
    assert_eq!(alpha_sorted.prefixes[0].prefix, "preset-");
    assert_eq!(alpha_sorted.prefixes[1].prefix, "scenario-");

    let span_sorted = agent_ops_cache_prefixes(
      State(state.clone()),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: Some("span".to_string()),
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect("span-sorted prefixes should load")
    .0;
    assert_eq!(span_sorted.sort_by, "span");
    assert_eq!(span_sorted.min_span_seconds, None);
    assert_eq!(span_sorted.max_span_seconds, None);
    assert_eq!(span_sorted.prefixes[0].prefix, "scenario-");
    assert_eq!(span_sorted.prefixes[1].prefix, "preset-");

    let invalid_sort_error = agent_ops_cache_prefixes(
      State(state),
      Path(workbook.id),
      Query(AgentOpsCachePrefixesQuery {
        request_id_prefix: None,
        min_entry_count: None,
        min_span_seconds: None,
        max_span_seconds: None,
        sort_by: Some("mystery".to_string()),
        max_age_seconds: None,
        offset: None,
        limit: Some(10),
      }),
    )
    .await
    .expect_err("unknown sort_by should fail");
    match invalid_sort_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_PREFIX_SORT_BY");
      }
      _ => panic!("expected invalid sort to use custom error code"),
    }
  }

  #[tokio::test]
  async fn should_return_cache_entry_detail_via_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-detail".to_string()))
      .await
      .expect("workbook should be created");

    let _ = agent_ops(
      State(state.clone()),
      Path(workbook.id),
      Json(AgentOpsRequest {
        request_id: Some("detail-1".to_string()),
        actor: Some("test".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
        operations: vec![AgentOperation::Recalculate],
      }),
    )
    .await
    .expect("agent ops should succeed");

    let detail = agent_ops_cache_entry_detail(
      State(state),
      Path((workbook.id, "detail-1".to_string())),
    )
    .await
    .expect("cache detail should load")
    .0;

    assert_eq!(detail.request_id, "detail-1");
    assert_eq!(detail.operation_count, 1);
    assert_eq!(detail.result_count, 1);
    assert!(detail.cached_response.request_id.is_some());
    assert_eq!(detail.operations.len(), 1);
  }

  #[tokio::test]
  async fn should_reject_missing_cache_entry_detail_via_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-detail-missing".to_string()))
      .await
      .expect("workbook should be created");

    let error = agent_ops_cache_entry_detail(
      State(state),
      Path((workbook.id, "missing-detail".to_string())),
    )
    .await
    .expect_err("missing detail should fail");

    match error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "CACHE_ENTRY_NOT_FOUND");
      }
      _ => panic!("expected missing detail to use cache entry not found code"),
    }
  }

  #[tokio::test]
  async fn should_remove_single_cache_entry_via_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-remove".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["remove-me", "keep-me"] {
      let _ = agent_ops(
        State(state.clone()),
        Path(workbook.id),
        Json(AgentOpsRequest {
          request_id: Some(request_id.to_string()),
          actor: Some("test".to_string()),
          stop_on_error: Some(true),
          expected_operations_signature: None,
          operations: vec![AgentOperation::Recalculate],
        }),
      )
      .await
      .expect("agent ops should succeed");
    }

    let remove_response = remove_agent_ops_cache_entry(
      State(state.clone()),
      Path(workbook.id),
      Json(RemoveAgentOpsCacheEntryRequest {
        request_id: "remove-me".to_string(),
      }),
    )
    .await
    .expect("remove should succeed")
    .0;
    assert!(remove_response.removed);
    assert_eq!(remove_response.remaining_entries, 1);

    let remaining_entries = agent_ops_cache_entries(
      State(state),
      Path(workbook.id),
      Query(AgentOpsCacheEntriesQuery {
        request_id_prefix: None,
        max_age_seconds: None,
        offset: Some(0),
        limit: Some(10),
      }),
    )
    .await
    .expect("entries should load")
    .0;
    assert_eq!(remaining_entries.total_entries, 1);
    assert_eq!(remaining_entries.entries[0].request_id, "keep-me");
  }

  #[tokio::test]
  async fn should_remove_cache_entries_by_prefix_via_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-remove-prefix".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["scenario-a", "scenario-b", "preset-a"] {
      let _ = agent_ops(
        State(state.clone()),
        Path(workbook.id),
        Json(AgentOpsRequest {
          request_id: Some(request_id.to_string()),
          actor: Some("test".to_string()),
          stop_on_error: Some(true),
          expected_operations_signature: None,
          operations: vec![AgentOperation::Recalculate],
        }),
      )
      .await
      .expect("agent ops should succeed");
    }

    let age_filtered_remove = remove_agent_ops_cache_entries_by_prefix(
      State(state.clone()),
      Path(workbook.id),
      Json(RemoveAgentOpsCacheEntriesByPrefixRequest {
        request_id_prefix: "scenario-".to_string(),
        max_age_seconds: Some(86_400),
      }),
    )
    .await
    .expect("age-filtered prefix remove should succeed")
    .0;
    assert_eq!(age_filtered_remove.max_age_seconds, Some(86_400));
    assert!(age_filtered_remove.cutoff_timestamp.is_some());
    assert_eq!(age_filtered_remove.unscoped_matched_entries, 0);
    assert_eq!(age_filtered_remove.removed_entries, 0);
    assert_eq!(age_filtered_remove.remaining_entries, 3);

    let remove_response = remove_agent_ops_cache_entries_by_prefix(
      State(state.clone()),
      Path(workbook.id),
      Json(RemoveAgentOpsCacheEntriesByPrefixRequest {
        request_id_prefix: "scenario-".to_string(),
        max_age_seconds: None,
      }),
    )
    .await
    .expect("prefix remove should succeed")
    .0;
    assert_eq!(remove_response.request_id_prefix, "scenario-");
    assert_eq!(remove_response.max_age_seconds, None);
    assert!(remove_response.cutoff_timestamp.is_none());
    assert_eq!(remove_response.unscoped_matched_entries, 3);
    assert_eq!(remove_response.removed_entries, 2);
    assert_eq!(remove_response.remaining_entries, 1);

    let remaining_entries = agent_ops_cache_entries(
      State(state),
      Path(workbook.id),
      Query(AgentOpsCacheEntriesQuery {
        request_id_prefix: None,
        max_age_seconds: None,
        offset: Some(0),
        limit: Some(10),
      }),
    )
    .await
    .expect("entries should load")
    .0;
    assert_eq!(remaining_entries.total_entries, 1);
    assert_eq!(remaining_entries.entries[0].request_id, "preset-a");
  }

  #[tokio::test]
  async fn should_preview_cache_entries_by_prefix_via_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-remove-prefix-preview".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["scenario-a", "scenario-b", "preset-a"] {
      let _ = agent_ops(
        State(state.clone()),
        Path(workbook.id),
        Json(AgentOpsRequest {
          request_id: Some(request_id.to_string()),
          actor: Some("test".to_string()),
          stop_on_error: Some(true),
          expected_operations_signature: None,
          operations: vec![AgentOperation::Recalculate],
        }),
      )
      .await
      .expect("agent ops should succeed");
    }

    let preview = preview_remove_agent_ops_cache_entries_by_prefix(
      State(state.clone()),
      Path(workbook.id),
      Json(PreviewRemoveAgentOpsCacheEntriesByPrefixRequest {
        request_id_prefix: "scenario-".to_string(),
        max_age_seconds: None,
        sample_limit: Some(1),
      }),
    )
    .await
    .expect("prefix preview should succeed")
    .0;
    assert_eq!(preview.request_id_prefix, "scenario-");
    assert_eq!(preview.max_age_seconds, None);
    assert!(preview.cutoff_timestamp.is_none());
    assert_eq!(preview.matched_entries, 2);
    assert_eq!(preview.unscoped_matched_entries, 3);
    assert_eq!(preview.sample_limit, 1);
    assert_eq!(preview.sample_request_ids.len(), 1);
    assert_eq!(preview.sample_request_ids[0], "scenario-b");

    let age_filtered_preview = preview_remove_agent_ops_cache_entries_by_prefix(
      State(state.clone()),
      Path(workbook.id),
      Json(PreviewRemoveAgentOpsCacheEntriesByPrefixRequest {
        request_id_prefix: "scenario-".to_string(),
        max_age_seconds: Some(86_400),
        sample_limit: Some(10),
      }),
    )
    .await
    .expect("age-filtered preview should succeed")
    .0;
    assert_eq!(age_filtered_preview.max_age_seconds, Some(86_400));
    assert!(age_filtered_preview.cutoff_timestamp.is_some());
    assert_eq!(age_filtered_preview.matched_entries, 0);
    assert_eq!(age_filtered_preview.unscoped_matched_entries, 0);
    assert!(age_filtered_preview.sample_request_ids.is_empty());

    let clamped_preview = preview_remove_agent_ops_cache_entries_by_prefix(
      State(state.clone()),
      Path(workbook.id),
      Json(PreviewRemoveAgentOpsCacheEntriesByPrefixRequest {
        request_id_prefix: "scenario-".to_string(),
        max_age_seconds: None,
        sample_limit: Some(0),
      }),
    )
    .await
    .expect("zero sample limit should clamp to one")
    .0;
    assert_eq!(clamped_preview.unscoped_matched_entries, 3);
    assert_eq!(clamped_preview.sample_limit, 1);
    assert_eq!(clamped_preview.sample_request_ids.len(), 1);

    let invalid_age_error = preview_remove_agent_ops_cache_entries_by_prefix(
      State(state),
      Path(workbook.id),
      Json(PreviewRemoveAgentOpsCacheEntriesByPrefixRequest {
        request_id_prefix: "scenario-".to_string(),
        max_age_seconds: Some(0),
        sample_limit: None,
      }),
    )
    .await
    .expect_err("non-positive max age should fail for preview");
    match invalid_age_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_MAX_AGE_SECONDS");
      }
      _ => panic!("expected invalid max age preview to use custom error code"),
    }
  }

  #[tokio::test]
  async fn should_reject_blank_prefix_when_removing_cache_entries_by_prefix() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-remove-prefix-invalid".to_string()))
      .await
      .expect("workbook should be created");

    let error = remove_agent_ops_cache_entries_by_prefix(
      State(state),
      Path(workbook.id),
      Json(RemoveAgentOpsCacheEntriesByPrefixRequest {
        request_id_prefix: "   ".to_string(),
        max_age_seconds: None,
      }),
    )
    .await
    .expect_err("blank prefix should fail");

    match error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_REQUEST_ID_PREFIX");
      }
      _ => panic!("expected invalid prefix to use custom error code"),
    }
  }

  #[tokio::test]
  async fn should_reject_non_positive_max_age_when_removing_cache_entries_by_prefix() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-remove-prefix-invalid-age".to_string()))
      .await
      .expect("workbook should be created");

    let error = remove_agent_ops_cache_entries_by_prefix(
      State(state),
      Path(workbook.id),
      Json(RemoveAgentOpsCacheEntriesByPrefixRequest {
        request_id_prefix: "scenario-".to_string(),
        max_age_seconds: Some(0),
      }),
    )
    .await
    .expect_err("non-positive max age should fail");

    match error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_MAX_AGE_SECONDS");
      }
      _ => panic!("expected invalid max age to use custom error code"),
    }
  }

  #[tokio::test]
  async fn should_reject_blank_prefix_when_previewing_cache_entries_by_prefix() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-preview-prefix-invalid".to_string()))
      .await
      .expect("workbook should be created");

    let error = preview_remove_agent_ops_cache_entries_by_prefix(
      State(state),
      Path(workbook.id),
      Json(PreviewRemoveAgentOpsCacheEntriesByPrefixRequest {
        request_id_prefix: "   ".to_string(),
        max_age_seconds: None,
        sample_limit: None,
      }),
    )
    .await
    .expect_err("blank prefix should fail for preview");

    match error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_REQUEST_ID_PREFIX");
      }
      _ => panic!("expected invalid prefix preview to use custom error code"),
    }
  }

  #[tokio::test]
  async fn should_remove_stale_cache_entries_via_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-remove-stale".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["stale-a", "stale-b"] {
      let _ = agent_ops(
        State(state.clone()),
        Path(workbook.id),
        Json(AgentOpsRequest {
          request_id: Some(request_id.to_string()),
          actor: Some("test".to_string()),
          stop_on_error: Some(true),
          expected_operations_signature: None,
          operations: vec![AgentOperation::Recalculate],
        }),
      )
      .await
      .expect("agent ops should succeed");
    }
    tokio::time::sleep(Duration::from_millis(1_300)).await;

    let preview = remove_stale_agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Json(RemoveStaleAgentOpsCacheEntriesRequest {
        request_id_prefix: None,
        max_age_seconds: 1,
        dry_run: Some(true),
        sample_limit: Some(1),
      }),
    )
    .await
    .expect("stale preview should succeed")
    .0;
    assert!(preview.dry_run);
    assert_eq!(preview.request_id_prefix, None);
    assert_eq!(preview.matched_entries, 2);
    assert_eq!(preview.unscoped_matched_entries, 2);
    assert_eq!(preview.sample_limit, 1);
    assert_eq!(preview.sample_request_ids.len(), 1);

    let clamped_preview = remove_stale_agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Json(RemoveStaleAgentOpsCacheEntriesRequest {
        request_id_prefix: None,
        max_age_seconds: 1,
        dry_run: Some(true),
        sample_limit: Some(0),
      }),
    )
    .await
    .expect("zero sample limit should clamp to one")
    .0;
    assert_eq!(clamped_preview.unscoped_matched_entries, 2);
    assert_eq!(clamped_preview.sample_limit, 1);
    assert_eq!(clamped_preview.sample_request_ids.len(), 1);

    let prefix_scoped_preview = remove_stale_agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Json(RemoveStaleAgentOpsCacheEntriesRequest {
        request_id_prefix: Some("stale-a".to_string()),
        max_age_seconds: 1,
        dry_run: Some(true),
        sample_limit: Some(10),
      }),
    )
    .await
    .expect("prefix-scoped stale preview should succeed")
    .0;
    assert_eq!(
      prefix_scoped_preview.request_id_prefix.as_deref(),
      Some("stale-a"),
    );
    assert_eq!(prefix_scoped_preview.matched_entries, 1);
    assert_eq!(prefix_scoped_preview.unscoped_matched_entries, 2);

    let remove = remove_stale_agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Json(RemoveStaleAgentOpsCacheEntriesRequest {
        request_id_prefix: None,
        max_age_seconds: 0,
        dry_run: Some(false),
        sample_limit: None,
      }),
    )
    .await
    .expect_err("invalid max age should return validation error");
    match remove {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_MAX_AGE_SECONDS");
      }
      _ => panic!("expected invalid max age to use custom error code"),
    }

    let blank_prefix_error = remove_stale_agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Json(RemoveStaleAgentOpsCacheEntriesRequest {
        request_id_prefix: Some("   ".to_string()),
        max_age_seconds: 1,
        dry_run: Some(true),
        sample_limit: None,
      }),
    )
    .await
    .expect_err("blank stale prefix should fail");
    match blank_prefix_error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_REQUEST_ID_PREFIX");
      }
      _ => panic!("expected blank stale prefix to use custom error code"),
    }

    let remove_all = remove_stale_agent_ops_cache_entries(
      State(state.clone()),
      Path(workbook.id),
      Json(RemoveStaleAgentOpsCacheEntriesRequest {
        request_id_prefix: None,
        max_age_seconds: 1,
        dry_run: Some(false),
        sample_limit: Some(10),
      }),
    )
    .await
    .expect("stale remove should succeed")
    .0;
    assert_eq!(remove_all.request_id_prefix, None);
    assert_eq!(remove_all.matched_entries, 2);
    assert_eq!(remove_all.unscoped_matched_entries, 2);
    assert_eq!(remove_all.removed_entries, 2);
    assert_eq!(remove_all.remaining_entries, 0);
  }

  #[tokio::test]
  async fn should_reject_blank_request_id_when_removing_cache_entry() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-remove-invalid".to_string()))
      .await
      .expect("workbook should be created");

    let error = remove_agent_ops_cache_entry(
      State(state),
      Path(workbook.id),
      Json(RemoveAgentOpsCacheEntryRequest {
        request_id: "   ".to_string(),
      }),
    )
    .await
    .expect_err("blank request id should fail");

    match error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_REQUEST_ID");
      }
      _ => panic!("expected bad request with custom invalid request id code"),
    }
  }

  #[tokio::test]
  async fn should_replay_cached_entry_via_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-replay".to_string()))
      .await
      .expect("workbook should be created");

    let _ = agent_ops(
      State(state.clone()),
      Path(workbook.id),
      Json(AgentOpsRequest {
        request_id: Some("replay-me".to_string()),
        actor: Some("test".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
        operations: vec![AgentOperation::Recalculate],
      }),
    )
    .await
    .expect("initial request should succeed");

    let replay_response = replay_agent_ops_cache_entry(
      State(state),
      Path(workbook.id),
      Json(ReplayAgentOpsCacheEntryRequest {
        request_id: "replay-me".to_string(),
      }),
    )
    .await
    .expect("replay should succeed")
    .0;
    assert!(replay_response.cached_response.served_from_cache);
    assert_eq!(
      replay_response.cached_response.request_id.as_deref(),
      Some("replay-me"),
    );
    assert_eq!(replay_response.operations.len(), 1);
  }

  #[tokio::test]
  async fn should_reject_missing_cache_entry_replay() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-replay-missing".to_string()))
      .await
      .expect("workbook should be created");

    let error = replay_agent_ops_cache_entry(
      State(state),
      Path(workbook.id),
      Json(ReplayAgentOpsCacheEntryRequest {
        request_id: "missing-request-id".to_string(),
      }),
    )
    .await
    .expect_err("replay for unknown request id should fail");

    match error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "CACHE_ENTRY_NOT_FOUND");
      }
      _ => panic!("expected bad request with cache-entry-not-found code"),
    }
  }

  #[tokio::test]
  async fn should_reexecute_cached_entry_via_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-reexecute".to_string()))
      .await
      .expect("workbook should be created");

    let _ = agent_ops(
      State(state.clone()),
      Path(workbook.id),
      Json(AgentOpsRequest {
        request_id: Some("source-reexecute-1".to_string()),
        actor: Some("test".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
        operations: vec![AgentOperation::Recalculate],
      }),
    )
    .await
    .expect("initial request should succeed");

    let reexecute = reexecute_agent_ops_cache_entry(
      State(state.clone()),
      Path(workbook.id),
      Json(ReexecuteAgentOpsCacheEntryRequest {
        request_id: "source-reexecute-1".to_string(),
        new_request_id: Some("reexecute-1".to_string()),
        actor: Some("test-reexecute".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
      }),
    )
    .await
    .expect("reexecute should succeed")
    .0;
    assert_eq!(reexecute.source_request_id, "source-reexecute-1");
    assert!(!reexecute.generated_request_id);
    assert_eq!(reexecute.response.request_id.as_deref(), Some("reexecute-1"));
    assert!(!reexecute.response.served_from_cache);
    assert_eq!(reexecute.operations_count, 1);
    assert_eq!(reexecute.operations.len(), 1);

    let replayed_reexecute = reexecute_agent_ops_cache_entry(
      State(state),
      Path(workbook.id),
      Json(ReexecuteAgentOpsCacheEntryRequest {
        request_id: "source-reexecute-1".to_string(),
        new_request_id: Some("reexecute-1".to_string()),
        actor: Some("test-reexecute".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
      }),
    )
    .await
    .expect("reexecute replay should succeed")
    .0;
    assert!(replayed_reexecute.response.served_from_cache);
  }

  #[tokio::test]
  async fn should_reject_blank_new_request_id_when_reexecuting_cache_entry() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-cache-reexecute-invalid".to_string()))
      .await
      .expect("workbook should be created");

    let _ = agent_ops(
      State(state.clone()),
      Path(workbook.id),
      Json(AgentOpsRequest {
        request_id: Some("source-invalid-1".to_string()),
        actor: Some("test".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
        operations: vec![AgentOperation::Recalculate],
      }),
    )
    .await
    .expect("initial request should succeed");

    let error = reexecute_agent_ops_cache_entry(
      State(state),
      Path(workbook.id),
      Json(ReexecuteAgentOpsCacheEntryRequest {
        request_id: "source-invalid-1".to_string(),
        new_request_id: Some("   ".to_string()),
        actor: Some("test-reexecute".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
      }),
    )
    .await
    .expect_err("blank new request id should fail");

    match error {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "INVALID_NEW_REQUEST_ID");
      }
      _ => panic!("expected invalid new request id to use custom error code"),
    }
  }

  #[tokio::test]
  async fn should_return_request_id_conflict_from_agent_ops_handler() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("handler-conflict".to_string()))
      .await
      .expect("workbook should be created");

    let _ = agent_ops(
      State(state.clone()),
      Path(workbook.id),
      Json(AgentOpsRequest {
        request_id: Some("handler-conflict-1".to_string()),
        actor: Some("test".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
        operations: vec![AgentOperation::Recalculate],
      }),
    )
    .await
    .expect("initial request should succeed");

    let conflict = agent_ops(
      State(state),
      Path(workbook.id),
      Json(AgentOpsRequest {
        request_id: Some("handler-conflict-1".to_string()),
        actor: Some("test".to_string()),
        stop_on_error: Some(true),
        expected_operations_signature: None,
        operations: vec![AgentOperation::ExportWorkbook {
          include_file_base64: Some(false),
        }],
      }),
    )
    .await
    .expect_err("conflicting request should fail");
    match conflict {
      crate::error::ApiError::BadRequestWithCode { code, .. } => {
        assert_eq!(code, "REQUEST_ID_CONFLICT");
      }
      _ => panic!("expected conflict to be encoded as custom bad request"),
    }
  }

  #[tokio::test]
  async fn should_expose_cache_and_signature_metadata_in_agent_schema() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("schema-metadata".to_string()))
      .await
      .expect("workbook should be created");

    let schema = get_agent_schema(State(state), Path(workbook.id))
      .await
      .expect("schema should resolve")
      .0;

    assert_eq!(
      schema
        .get("agent_ops_cache_stats_endpoint")
        .and_then(serde_json::Value::as_str),
      Some(
        "/v1/workbooks/{id}/agent/ops/cache?request_id_prefix=scenario-&max_age_seconds=3600",
      ),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_clear_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/{id}/agent/ops/cache/clear"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_remove_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/{id}/agent/ops/cache/remove"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_remove_by_prefix_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/{id}/agent/ops/cache/remove-by-prefix"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_remove_by_prefix_preview_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/{id}/agent/ops/cache/remove-by-prefix/preview"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_replay_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/{id}/agent/ops/cache/replay"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_reexecute_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/{id}/agent/ops/cache/reexecute"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_remove_stale_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/{id}/agent/ops/cache/remove-stale"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_entries_endpoint")
        .and_then(serde_json::Value::as_str),
      Some(
        "/v1/workbooks/{id}/agent/ops/cache/entries?request_id_prefix=demo&offset=0&limit=20",
      ),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_entry_detail_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/{id}/agent/ops/cache/entries/{request_id}"),
    );
    assert_eq!(
      schema
        .get("workbook_import_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/import"),
    );
    assert_eq!(
      schema
        .get("workbook_export_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/workbooks/{id}/export"),
    );
    let supported_summary = formula_supported_functions_summary();
    let unsupported_summary = formula_unsupported_behaviors_summary();
    assert_eq!(
      schema
        .get("formula_capabilities")
        .and_then(|value| value.get("supported_functions"))
        .and_then(serde_json::Value::as_str),
      Some(supported_summary.as_str()),
    );
    assert_eq!(
      schema
        .get("formula_capabilities")
        .and_then(|value| value.get("unsupported_behaviors"))
        .and_then(serde_json::Value::as_str),
      Some(unsupported_summary.as_str()),
    );
    assert_eq!(
      schema
        .get("formula_capabilities")
        .and_then(|value| value.get("supported_function_list"))
        .and_then(serde_json::Value::as_array)
        .map(|entries| entries.len()),
      Some(FORMULA_SUPPORTED_FUNCTION_LIST.len()),
    );
    assert_eq!(
      schema
        .get("formula_capabilities")
        .and_then(|value| value.get("unsupported_behavior_list"))
        .and_then(serde_json::Value::as_array)
        .map(|entries| entries.len()),
      Some(FORMULA_UNSUPPORTED_BEHAVIOR_LIST.len()),
    );
    assert_eq!(
      schema
        .get("workbook_import_response_shape")
        .and_then(|value| value.get("import"))
        .and_then(|value| value.get("formula_cells_imported"))
        .and_then(serde_json::Value::as_str),
      Some("number of imported cells carrying formulas"),
    );
    assert_eq!(
      schema
        .get("workbook_import_response_shape")
        .and_then(|value| value.get("import"))
        .and_then(|value| value.get("formula_cells_with_cached_values"))
        .and_then(serde_json::Value::as_str),
      Some("formula cells with cached scalar values"),
    );
    assert_eq!(
      schema
        .get("workbook_import_response_shape")
        .and_then(|value| value.get("import"))
        .and_then(|value| value.get("formula_cells_without_cached_values"))
        .and_then(serde_json::Value::as_str),
      Some("formula cells without cached scalar values"),
    );
    assert_eq!(
      schema
        .get("workbook_export_response_headers_shape")
        .and_then(|value| value.get("x-export-meta"))
        .and_then(serde_json::Value::as_str),
      Some("json compatibility report with preserved/transformed/unsupported arrays"),
    );
    assert_eq!(
      schema
        .get("workbook_import_event_shape")
        .and_then(|value| value.get("event_type"))
        .and_then(serde_json::Value::as_str),
      Some("workbook.imported"),
    );
    assert_eq!(
      schema
        .get("workbook_import_event_shape")
        .and_then(|value| value.get("payload"))
        .and_then(|value| value.get("formula_cells_imported"))
        .and_then(serde_json::Value::as_str),
      Some("number of imported cells carrying formulas"),
    );
    assert_eq!(
      schema
        .get("workbook_export_event_shape")
        .and_then(|value| value.get("event_type"))
        .and_then(serde_json::Value::as_str),
      Some("workbook.exported"),
    );
    assert_eq!(
      schema
        .get("workbook_export_event_shape")
        .and_then(|value| value.get("payload"))
        .and_then(|value| value.get("compatibility_report"))
        .and_then(serde_json::Value::as_str),
      Some("compatibility report object matching x-export-meta schema"),
    );
    assert_eq!(
      schema
        .get("workbook_event_shapes")
        .and_then(|value| value.get("cells.updated"))
        .and_then(|value| value.get("payload"))
        .and_then(|value| value.get("updated"))
        .and_then(serde_json::Value::as_str),
      Some("number of updated cells in mutation batch"),
    );
    assert_eq!(
      schema
        .get("workbook_event_shapes")
        .and_then(|value| value.get("formula.recalculated"))
        .and_then(|value| value.get("payload"))
        .and_then(|value| value.get("unsupported_formulas"))
        .and_then(serde_json::Value::as_str),
      Some("array of unsupported formula strings"),
    );
    assert_eq!(
      schema
        .get("workbook_event_shapes")
        .and_then(|value| value.get("workbook.exported"))
        .and_then(|value| value.get("payload"))
        .and_then(|value| value.get("compatibility_report"))
        .and_then(serde_json::Value::as_str),
      Some("compatibility report object matching x-export-meta schema"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_endpoint")
        .and_then(serde_json::Value::as_str),
      Some(
        "/v1/workbooks/{id}/agent/ops/cache/prefixes?request_id_prefix=scenario-&min_entry_count=2&min_span_seconds=60&max_span_seconds=86400&sort_by=recent&offset=0&limit=8&max_age_seconds=3600",
      ),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_query_shape")
        .and_then(|value| value.get("offset"))
        .and_then(serde_json::Value::as_str),
      Some("optional number, default 0"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_query_shape")
        .and_then(|value| value.get("min_entry_count"))
        .and_then(serde_json::Value::as_str),
      Some("optional number > 0 (filter out prefixes with fewer matches, default 1)"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_query_shape")
        .and_then(|value| value.get("min_span_seconds"))
        .and_then(serde_json::Value::as_str),
      Some("optional number > 0 (filter out prefixes with narrower time spans)"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_query_shape")
        .and_then(|value| value.get("max_span_seconds"))
        .and_then(serde_json::Value::as_str),
      Some(
        "optional number > 0 (filter out prefixes with wider time spans; when combined with min_span_seconds must be >= min_span_seconds)",
      ),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_query_shape")
        .and_then(|value| value.get("sort_by"))
        .and_then(serde_json::Value::as_str),
      Some("optional string enum: count|recent|alpha|span (default count)"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_query_shape")
        .and_then(|value| value.get("request_id_prefix"))
        .and_then(serde_json::Value::as_str),
      Some("optional non-blank string filter (prefix match)"),
    );
    assert_eq!(
      schema
        .get("agent_ops_idempotency_cache_max_entries")
        .and_then(serde_json::Value::as_u64),
      Some(AGENT_OPS_CACHE_MAX_ENTRIES as u64),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_stats_query_shape")
        .and_then(|value| value.get("request_id_prefix"))
        .and_then(serde_json::Value::as_str),
      Some("optional non-blank string filter (prefix match)"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_stats_response_shape")
        .and_then(|value| value.get("unscoped_entries"))
        .and_then(serde_json::Value::as_str),
      Some("total cache entries without prefix/age filters"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_entries_response_shape")
        .and_then(|value| value.get("unscoped_total_entries"))
        .and_then(serde_json::Value::as_str),
      Some("total cache entries without prefix/age filters"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_entries_response_shape")
        .and_then(|value| value.get("cutoff_timestamp"))
        .and_then(serde_json::Value::as_str),
      Some("optional iso timestamp used for max_age_seconds filtering"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("unscoped_total_entries"))
        .and_then(serde_json::Value::as_str),
      Some("total cache entries without prefix/age filters"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("scoped_total_entries"))
        .and_then(serde_json::Value::as_str),
      Some("total cache entries represented by scoped prefixes before pagination"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("unscoped_total_prefixes"))
        .and_then(serde_json::Value::as_str),
      Some("total distinct prefixes without prefix/age filters"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("returned_entry_count"))
        .and_then(serde_json::Value::as_str),
      Some("total cache entries represented by returned prefixes in this page"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("request_id_prefix"))
        .and_then(serde_json::Value::as_str),
      Some("echoed filter prefix when provided"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("min_entry_count"))
        .and_then(serde_json::Value::as_str),
      Some("applied minimum entry count filter (default 1)"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("min_span_seconds"))
        .and_then(serde_json::Value::as_str),
      Some("echoed minimum span filter when provided"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("max_span_seconds"))
        .and_then(serde_json::Value::as_str),
      Some("echoed maximum span filter when provided"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("sort_by"))
        .and_then(serde_json::Value::as_str),
      Some("applied sort mode: count|recent|alpha|span"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("offset"))
        .and_then(serde_json::Value::as_str),
      Some("start index in sorted prefix list"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("has_more"))
        .and_then(serde_json::Value::as_str),
      Some("true when another page exists after this response"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_prefixes_response_shape")
        .and_then(|value| value.get("cutoff_timestamp"))
        .and_then(serde_json::Value::as_str),
      Some("optional iso timestamp used for max_age_seconds filtering"),
    );
    let newest_prefix_request_id_shape = schema
      .get("agent_ops_cache_prefixes_response_shape")
      .and_then(|value| value.get("prefixes"))
      .and_then(serde_json::Value::as_array)
      .and_then(|items| items.first())
      .and_then(|item| item.get("newest_request_id"))
      .and_then(serde_json::Value::as_str);
    assert_eq!(
      newest_prefix_request_id_shape,
      Some("newest request_id observed for this prefix within active scope"),
    );
    let newest_prefix_cached_at_shape = schema
      .get("agent_ops_cache_prefixes_response_shape")
      .and_then(|value| value.get("prefixes"))
      .and_then(serde_json::Value::as_array)
      .and_then(|items| items.first())
      .and_then(|item| item.get("newest_cached_at"))
      .and_then(serde_json::Value::as_str);
    assert_eq!(
      newest_prefix_cached_at_shape,
      Some("optional iso timestamp for newest request_id within active scope"),
    );
    let oldest_prefix_request_id_shape = schema
      .get("agent_ops_cache_prefixes_response_shape")
      .and_then(|value| value.get("prefixes"))
      .and_then(serde_json::Value::as_array)
      .and_then(|items| items.first())
      .and_then(|item| item.get("oldest_request_id"))
      .and_then(serde_json::Value::as_str);
    assert_eq!(
      oldest_prefix_request_id_shape,
      Some("oldest request_id observed for this prefix within active scope"),
    );
    let oldest_prefix_cached_at_shape = schema
      .get("agent_ops_cache_prefixes_response_shape")
      .and_then(|value| value.get("prefixes"))
      .and_then(serde_json::Value::as_array)
      .and_then(|items| items.first())
      .and_then(|item| item.get("oldest_cached_at"))
      .and_then(serde_json::Value::as_str);
    assert_eq!(
      oldest_prefix_cached_at_shape,
      Some("optional iso timestamp for oldest request_id within active scope"),
    );
    let prefix_span_seconds_shape = schema
      .get("agent_ops_cache_prefixes_response_shape")
      .and_then(|value| value.get("prefixes"))
      .and_then(serde_json::Value::as_array)
      .and_then(|items| items.first())
      .and_then(|item| item.get("span_seconds"))
      .and_then(serde_json::Value::as_str);
    assert_eq!(
      prefix_span_seconds_shape,
      Some("optional number of seconds between oldest and newest cached timestamps"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_remove_stale_request_shape")
        .and_then(|value| value.get("request_id_prefix"))
        .and_then(serde_json::Value::as_str),
      Some("optional string filter (prefix match)"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_remove_stale_response_shape")
        .and_then(|value| value.get("request_id_prefix"))
        .and_then(serde_json::Value::as_str),
      Some("echoed filter prefix when provided"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_remove_by_prefix_response_shape")
        .and_then(|value| value.get("unscoped_matched_entries"))
        .and_then(serde_json::Value::as_str),
      Some("number of age-scoped cache entries before prefix filtering"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_remove_by_prefix_preview_response_shape")
        .and_then(|value| value.get("unscoped_matched_entries"))
        .and_then(serde_json::Value::as_str),
      Some("number of age-scoped cache entries before prefix filtering"),
    );
    assert_eq!(
      schema
        .get("agent_ops_cache_remove_stale_response_shape")
        .and_then(|value| value.get("unscoped_matched_entries"))
        .and_then(serde_json::Value::as_str),
      Some("number of stale cache entries matching cutoff without prefix filter"),
    );

    let signature_error_codes = schema
      .get("signature_error_codes")
      .and_then(serde_json::Value::as_array)
      .expect("signature_error_codes should be an array")
      .iter()
      .filter_map(serde_json::Value::as_str)
      .collect::<Vec<_>>();
    assert!(
      signature_error_codes.contains(&"REQUEST_ID_CONFLICT"),
      "schema should advertise request-id conflict error code",
    );
    assert!(
      signature_error_codes.contains(&"OPERATION_SIGNATURE_MISMATCH"),
      "schema should advertise mismatch error code",
    );

    let cache_validation_error_codes = schema
      .get("cache_validation_error_codes")
      .and_then(serde_json::Value::as_array)
      .expect("cache_validation_error_codes should be an array")
      .iter()
      .filter_map(serde_json::Value::as_str)
      .collect::<Vec<_>>();
    assert!(
      cache_validation_error_codes.contains(&"CACHE_ENTRY_NOT_FOUND"),
      "schema should advertise missing-cache-entry error code",
    );
    assert!(
      cache_validation_error_codes.contains(&"INVALID_NEW_REQUEST_ID"),
      "schema should advertise invalid new request id error code",
    );
    assert!(
      cache_validation_error_codes.contains(&"INVALID_REQUEST_ID_PREFIX"),
      "schema should advertise invalid request-id-prefix error code",
    );
    assert!(
      cache_validation_error_codes.contains(&"INVALID_MAX_AGE_SECONDS"),
      "schema should advertise invalid max-age-seconds error code",
    );
    assert!(
      cache_validation_error_codes.contains(&"INVALID_MIN_ENTRY_COUNT"),
      "schema should advertise invalid min-entry-count error code",
    );
    assert!(
      cache_validation_error_codes.contains(&"INVALID_MIN_SPAN_SECONDS"),
      "schema should advertise invalid min-span-seconds error code",
    );
    assert!(
      cache_validation_error_codes.contains(&"INVALID_MAX_SPAN_SECONDS"),
      "schema should advertise invalid max-span-seconds error code",
    );
    assert!(
      cache_validation_error_codes.contains(&"INVALID_SPAN_RANGE"),
      "schema should advertise invalid span-range error code",
    );
    assert!(
      cache_validation_error_codes.contains(&"INVALID_PREFIX_SORT_BY"),
      "schema should advertise invalid prefix-sort error code",
    );
  }

  #[tokio::test]
  async fn should_expose_response_shapes_in_wizard_schema() {
    let schema = get_agent_wizard_schema().await.0;

    assert_eq!(
      schema
        .get("endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/agent/wizard/run"),
    );
    assert_eq!(
      schema
        .get("json_endpoint")
        .and_then(serde_json::Value::as_str),
      Some("/v1/agent/wizard/run-json"),
    );
    assert_eq!(
      schema
        .get("run_response_shape")
        .and_then(|value| value.get("import"))
        .and_then(serde_json::Value::as_str),
      Some("optional import summary object (see import_response_shape)"),
    );
    assert_eq!(
      schema
        .get("import_response_shape")
        .and_then(|value| value.get("formula_cells_imported"))
        .and_then(serde_json::Value::as_str),
      Some("number of imported cells carrying formulas"),
    );
    assert_eq!(
      schema
        .get("import_response_shape")
        .and_then(|value| value.get("formula_cells_with_cached_values"))
        .and_then(serde_json::Value::as_str),
      Some("formula cells with cached scalar values"),
    );
    assert_eq!(
      schema
        .get("import_response_shape")
        .and_then(|value| value.get("formula_cells_without_cached_values"))
        .and_then(serde_json::Value::as_str),
      Some("formula cells without cached scalar values"),
    );
    assert_eq!(
      schema
        .get("formula_capabilities")
        .and_then(|value| value.get("supported_functions"))
        .and_then(serde_json::Value::as_str),
      Some(formula_supported_functions_summary().as_str()),
    );
    assert_eq!(
      schema
        .get("formula_capabilities")
        .and_then(|value| value.get("supported_function_list"))
        .and_then(serde_json::Value::as_array)
        .map(|entries| entries.len()),
      Some(FORMULA_SUPPORTED_FUNCTION_LIST.len()),
    );
    assert_eq!(
      schema
        .get("formula_capabilities")
        .and_then(|value| value.get("unsupported_behavior_list"))
        .and_then(serde_json::Value::as_array)
        .map(|entries| entries.len()),
      Some(FORMULA_UNSUPPORTED_BEHAVIOR_LIST.len()),
    );
  }
}
