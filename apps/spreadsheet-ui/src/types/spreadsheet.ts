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
  results: AgentOperationResult[];
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
  warnings: string[];
}

export interface AgentWizardRunResponse {
  workbook: WorkbookSummary;
  scenario: string;
  operations_signature: string;
  request_id?: string;
  results: AgentOperationResult[];
  import: AgentWizardImportResult | null;
}

export interface AgentWizardSchemaInfo {
  endpoint: string;
  json_endpoint?: string;
  presets_endpoint?: string;
  preset_operations_endpoint?: string;
  scenarios_endpoint?: string;
  scenario_operations_endpoint?: string;
  request_multipart_fields?: string[];
  request_json_fields?: Record<string, string>;
  operations_preview_response_shape?: Record<string, string>;
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
