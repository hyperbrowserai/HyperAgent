use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkbookSummary {
  pub id: Uuid,
  pub name: String,
  pub created_at: DateTime<Utc>,
  pub sheets: Vec<String>,
  pub charts: Vec<ChartSpec>,
  pub compatibility_warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartSpec {
  pub id: String,
  pub sheet: String,
  pub chart_type: ChartType,
  pub title: String,
  pub categories_range: String,
  pub values_range: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartType {
  Line,
  Bar,
  Pie,
  Area,
  Scatter,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkbookRequest {
  pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkbookResponse {
  pub workbook: WorkbookSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetCellsRequest {
  pub sheet: String,
  pub actor: Option<String>,
  pub cells: Vec<CellMutation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSheetRequest {
  pub sheet: String,
  pub actor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSheetResponse {
  pub sheet: String,
  pub created: bool,
  pub sheets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellMutation {
  pub row: u32,
  pub col: u32,
  pub value: Option<Value>,
  pub formula: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetCellsResponse {
  pub updated: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetCellsRequest {
  pub sheet: String,
  pub range: CellRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellRange {
  pub start_row: u32,
  pub end_row: u32,
  pub start_col: u32,
  pub end_col: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellSnapshot {
  pub row: u32,
  pub col: u32,
  pub address: String,
  pub raw_value: Option<String>,
  pub formula: Option<String>,
  pub evaluated_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetCellsResponse {
  pub sheet: String,
  pub cells: Vec<CellSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecalculateResponse {
  pub updated_cells: usize,
  pub unsupported_formulas: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertChartRequest {
  pub actor: Option<String>,
  pub chart: ChartSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryRequest {
  pub sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsRequest {
  pub request_id: Option<String>,
  pub actor: Option<String>,
  pub stop_on_error: Option<bool>,
  pub expected_operations_signature: Option<String>,
  pub operations: Vec<AgentOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsPreviewRequest {
  pub operations: Vec<AgentOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsPreviewResponse {
  pub operations_signature: String,
  pub operations: Vec<AgentOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsCacheStatsResponse {
  pub entries: usize,
  pub max_entries: usize,
  pub request_id_prefix: Option<String>,
  pub max_age_seconds: Option<i64>,
  pub cutoff_timestamp: Option<DateTime<Utc>>,
  pub oldest_request_id: Option<String>,
  pub newest_request_id: Option<String>,
  pub oldest_cached_at: Option<DateTime<Utc>>,
  pub newest_cached_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClearAgentOpsCacheResponse {
  pub cleared_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveAgentOpsCacheEntryRequest {
  pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveAgentOpsCacheEntryResponse {
  pub request_id: String,
  pub removed: bool,
  pub remaining_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveAgentOpsCacheEntriesByPrefixRequest {
  pub request_id_prefix: String,
  pub max_age_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveAgentOpsCacheEntriesByPrefixResponse {
  pub request_id_prefix: String,
  pub max_age_seconds: Option<i64>,
  pub cutoff_timestamp: Option<DateTime<Utc>>,
  pub removed_entries: usize,
  pub remaining_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewRemoveAgentOpsCacheEntriesByPrefixResponse {
  pub request_id_prefix: String,
  pub max_age_seconds: Option<i64>,
  pub cutoff_timestamp: Option<DateTime<Utc>>,
  pub matched_entries: usize,
  pub sample_limit: usize,
  pub sample_request_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewRemoveAgentOpsCacheEntriesByPrefixRequest {
  pub request_id_prefix: String,
  pub max_age_seconds: Option<i64>,
  pub sample_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveStaleAgentOpsCacheEntriesRequest {
  pub request_id_prefix: Option<String>,
  pub max_age_seconds: i64,
  pub dry_run: Option<bool>,
  pub sample_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveStaleAgentOpsCacheEntriesResponse {
  pub request_id_prefix: Option<String>,
  pub max_age_seconds: i64,
  pub dry_run: bool,
  pub cutoff_timestamp: DateTime<Utc>,
  pub matched_entries: usize,
  pub removed_entries: usize,
  pub remaining_entries: usize,
  pub sample_limit: usize,
  pub sample_request_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayAgentOpsCacheEntryRequest {
  pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayAgentOpsCacheEntryResponse {
  pub cached_at: DateTime<Utc>,
  pub cached_response: AgentOpsResponse,
  pub operations: Vec<AgentOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReexecuteAgentOpsCacheEntryRequest {
  pub request_id: String,
  pub new_request_id: Option<String>,
  pub actor: Option<String>,
  pub stop_on_error: Option<bool>,
  pub expected_operations_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReexecuteAgentOpsCacheEntryResponse {
  pub source_request_id: String,
  pub generated_request_id: bool,
  pub operations_signature: String,
  pub operations_count: usize,
  pub operations: Vec<AgentOperation>,
  pub response: AgentOpsResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsCacheEntryDetailResponse {
  pub request_id: String,
  pub cached_at: DateTime<Utc>,
  pub operation_count: usize,
  pub result_count: usize,
  pub cached_response: AgentOpsResponse,
  pub operations: Vec<AgentOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsCacheEntry {
  pub request_id: String,
  pub cached_at: DateTime<Utc>,
  pub operations_signature: Option<String>,
  pub operation_count: usize,
  pub result_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsCacheEntriesResponse {
  pub total_entries: usize,
  pub returned_entries: usize,
  pub request_id_prefix: Option<String>,
  pub max_age_seconds: Option<i64>,
  pub cutoff_timestamp: Option<DateTime<Utc>>,
  pub offset: usize,
  pub limit: usize,
  pub has_more: bool,
  pub entries: Vec<AgentOpsCacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsCachePrefix {
  pub prefix: String,
  pub entry_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsCachePrefixesResponse {
  pub total_prefixes: usize,
  pub returned_prefixes: usize,
  pub max_age_seconds: Option<i64>,
  pub cutoff_timestamp: Option<DateTime<Utc>>,
  pub limit: usize,
  pub prefixes: Vec<AgentOpsCachePrefix>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPresetRunRequest {
  pub request_id: Option<String>,
  pub actor: Option<String>,
  pub stop_on_error: Option<bool>,
  pub include_file_base64: Option<bool>,
  pub expected_operations_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentScenarioRunRequest {
  pub request_id: Option<String>,
  pub actor: Option<String>,
  pub stop_on_error: Option<bool>,
  pub include_file_base64: Option<bool>,
  pub expected_operations_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentWizardImportResult {
  pub sheets_imported: usize,
  pub cells_imported: usize,
  pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentWizardRunResponse {
  pub workbook: WorkbookSummary,
  pub scenario: String,
  pub operations_signature: String,
  pub request_id: Option<String>,
  pub results: Vec<AgentOperationResult>,
  pub import: Option<AgentWizardImportResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentWizardRunJsonRequest {
  pub scenario: String,
  pub request_id: Option<String>,
  pub actor: Option<String>,
  pub stop_on_error: Option<bool>,
  pub include_file_base64: Option<bool>,
  pub expected_operations_signature: Option<String>,
  pub workbook_name: Option<String>,
  pub file_name: Option<String>,
  pub file_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op_type", rename_all = "snake_case")]
pub enum AgentOperation {
  GetWorkbook,
  ListSheets,
  CreateSheet {
    sheet: String,
  },
  SetCells {
    sheet: String,
    cells: Vec<CellMutation>,
  },
  GetCells {
    sheet: String,
    range: CellRange,
  },
  Recalculate,
  UpsertChart {
    chart: ChartSpec,
  },
  ExportWorkbook {
    include_file_base64: Option<bool>,
  },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOperationResult {
  pub op_index: usize,
  pub op_type: String,
  pub ok: bool,
  pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOpsResponse {
  pub request_id: Option<String>,
  pub operations_signature: Option<String>,
  pub served_from_cache: bool,
  pub results: Vec<AgentOperationResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResponse {
  pub file_name: String,
  pub compatibility_report: CompatibilityReport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatibilityReport {
  pub preserved: Vec<String>,
  pub transformed: Vec<String>,
  pub unsupported: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkbookEvent {
  pub seq: u64,
  pub event_type: String,
  pub workbook_id: Uuid,
  pub timestamp: DateTime<Utc>,
  pub actor: String,
  pub payload: Value,
}
