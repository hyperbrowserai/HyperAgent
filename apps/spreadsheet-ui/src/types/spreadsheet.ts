export interface WorkbookSummary {
  id: string;
  name: string;
  created_at: string;
  sheets: string[];
  charts: ChartSpec[];
  compatibility_warnings: string[];
}

export interface ChartSpec {
  id: string;
  sheet: string;
  chart_type: "line" | "bar" | "pie" | "area" | "scatter";
  title: string;
  categories_range: string;
  values_range: string;
}

export interface CellSnapshot {
  row: number;
  col: number;
  address: string;
  raw_value: string | null;
  formula: string | null;
  evaluated_value: string | null;
}

export interface WorkbookEvent {
  seq: number;
  event_type: string;
  workbook_id: string;
  timestamp: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface AgentOperationResult {
  op_index: number;
  op_type: string;
  ok: boolean;
  data: Record<string, unknown>;
}

export interface AgentOpsResponse {
  request_id?: string;
  operations_signature?: string;
  served_from_cache?: boolean;
  results: AgentOperationResult[];
}

export interface AgentOpsPreviewResponse {
  operations_signature: string;
  operations: AgentOperationPreview[];
}

export interface AgentOpsCacheStatsResponse {
  entries: number;
  unscoped_entries: number;
  max_entries: number;
  request_id_prefix: string | null;
  max_age_seconds: number | null;
  cutoff_timestamp: string | null;
  oldest_request_id: string | null;
  newest_request_id: string | null;
  oldest_cached_at: string | null;
  newest_cached_at: string | null;
}

export interface AgentOpsCacheEntry {
  request_id: string;
  cached_at: string;
  operations_signature: string | null;
  operation_count: number;
  result_count: number;
}

export interface AgentOpsCachePrefix {
  prefix: string;
  entry_count: number;
  newest_request_id: string;
  newest_cached_at: string | null;
  oldest_request_id: string;
  oldest_cached_at: string | null;
  span_seconds: number | null;
}

export interface AgentOpsCachePrefixesResponse {
  total_prefixes: number;
  unscoped_total_prefixes: number;
  unscoped_total_entries: number;
  scoped_total_entries: number;
  returned_prefixes: number;
  returned_entry_count: number;
  request_id_prefix: string | null;
  min_entry_count: number;
  min_span_seconds: number | null;
  max_span_seconds: number | null;
  sort_by: "count" | "recent" | "alpha" | "span";
  max_age_seconds: number | null;
  cutoff_timestamp: string | null;
  offset: number;
  limit: number;
  has_more: boolean;
  prefixes: AgentOpsCachePrefix[];
}

export interface AgentOpsCacheEntriesResponse {
  total_entries: number;
  unscoped_total_entries: number;
  returned_entries: number;
  request_id_prefix: string | null;
  max_age_seconds: number | null;
  cutoff_timestamp: string | null;
  offset: number;
  limit: number;
  has_more: boolean;
  entries: AgentOpsCacheEntry[];
}

export interface RemoveAgentOpsCacheEntryResponse {
  request_id: string;
  removed: boolean;
  remaining_entries: number;
}

export interface RemoveAgentOpsCacheEntriesByPrefixResponse {
  request_id_prefix: string;
  max_age_seconds: number | null;
  cutoff_timestamp: string | null;
  unscoped_matched_entries: number;
  removed_entries: number;
  remaining_entries: number;
}

export interface PreviewRemoveAgentOpsCacheEntriesByPrefixResponse {
  request_id_prefix: string;
  max_age_seconds: number | null;
  cutoff_timestamp: string | null;
  matched_entries: number;
  unscoped_matched_entries: number;
  sample_limit: number;
  sample_request_ids: string[];
}

export interface RemoveStaleAgentOpsCacheEntriesResponse {
  request_id_prefix: string | null;
  max_age_seconds: number;
  dry_run: boolean;
  cutoff_timestamp: string;
  matched_entries: number;
  unscoped_matched_entries: number;
  removed_entries: number;
  remaining_entries: number;
  sample_limit: number;
  sample_request_ids: string[];
}

export interface ReplayAgentOpsCacheEntryResponse {
  cached_at: string;
  cached_response: AgentOpsResponse;
  operations: AgentOperationPreview[];
}

export interface ReexecuteAgentOpsCacheEntryResponse {
  source_request_id: string;
  generated_request_id: boolean;
  operations_signature: string;
  operations_count: number;
  operations: AgentOperationPreview[];
  response: AgentOpsResponse;
}

export interface AgentOpsCacheEntryDetailResponse {
  request_id: string;
  cached_at: string;
  operation_count: number;
  result_count: number;
  cached_response: AgentOpsResponse;
  operations: AgentOperationPreview[];
}

export interface ClearAgentOpsCacheResponse {
  cleared_entries: number;
}

export interface AgentPresetResponse {
  preset: string;
  operations_signature?: string;
  request_id?: string;
  results: AgentOperationResult[];
}

export interface AgentPresetInfo {
  preset: string;
  description: string;
  operations: string[];
}

export interface AgentSchemaInfo {
  endpoint: string;
  workbook_import_endpoint?: string;
  workbook_export_endpoint?: string;
  workbook_import_response_shape?: Record<string, unknown>;
  workbook_export_response_headers_shape?: Record<string, string>;
  agent_ops_preview_endpoint?: string;
  agent_ops_cache_stats_endpoint?: string;
  agent_ops_cache_entries_endpoint?: string;
  agent_ops_cache_entry_detail_endpoint?: string;
  agent_ops_cache_prefixes_endpoint?: string;
  agent_ops_cache_clear_endpoint?: string;
  agent_ops_cache_replay_endpoint?: string;
  agent_ops_cache_reexecute_endpoint?: string;
  agent_ops_cache_remove_endpoint?: string;
  agent_ops_cache_remove_by_prefix_endpoint?: string;
  agent_ops_cache_remove_by_prefix_preview_endpoint?: string;
  agent_ops_cache_remove_stale_endpoint?: string;
  agent_ops_idempotency_cache_max_entries?: number;
  agent_ops_preview_request_shape?: Record<string, string>;
  agent_ops_preview_response_shape?: Record<string, string>;
  signature_error_codes?: string[];
  cache_validation_error_codes?: string[];
  operation_payloads: Record<string, unknown>;
  presets: AgentPresetInfo[];
}

export interface AgentScenarioInfo {
  scenario: string;
  description: string;
  presets: string[];
}

export interface AgentScenarioResponse {
  scenario: string;
  operations_signature?: string;
  request_id?: string;
  results: AgentOperationResult[];
}

export interface AgentWizardImportResult {
  sheets_imported: number;
  cells_imported: number;
  formula_cells_imported: number;
  formula_cells_with_cached_values: number;
  formula_cells_without_cached_values: number;
  warnings: string[];
}

export interface ImportWorkbookResponse {
  workbook: WorkbookSummary;
  import: AgentWizardImportResult;
}

export interface AgentWizardRunResponse {
  workbook: WorkbookSummary;
  scenario: string;
  operations_signature: string;
  request_id?: string;
  results: AgentOperationResult[];
  import: AgentWizardImportResult | null;
}

export interface ExportCompatibilityReport {
  preserved: string[];
  transformed: string[];
  unsupported: string[];
}

export interface ExportWorkbookResponse {
  blob: Blob;
  file_name: string | null;
  compatibility_report: ExportCompatibilityReport | null;
}

export interface AgentWizardSchemaInfo {
  endpoint: string;
  json_endpoint?: string;
  presets_endpoint?: string;
  preset_operations_endpoint?: string;
  scenarios_endpoint?: string;
  scenario_operations_endpoint?: string;
  signature_error_codes?: string[];
  request_multipart_fields?: string[];
  request_json_fields?: Record<string, string>;
  operations_preview_response_shape?: Record<string, string>;
  run_response_shape?: Record<string, string>;
  import_response_shape?: Record<string, string>;
  presets: AgentPresetInfo[];
  scenarios: AgentScenarioInfo[];
}

export interface AgentOperationPreview {
  op_type: string;
  [key: string]: unknown;
}

export interface AgentOperationPlanPreview {
  operations_signature: string;
  operations: AgentOperationPreview[];
}
