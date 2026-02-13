import {
  AgentOpsPreviewResponse,
  AgentOpsResponse,
  AgentOperationPlanPreview,
  AgentOperationPreview,
  AgentSchemaInfo,
  AgentPresetInfo,
  AgentPresetResponse,
  AgentScenarioInfo,
  AgentScenarioResponse,
  AgentWizardSchemaInfo,
  AgentWizardRunResponse,
  CellSnapshot,
  ChartSpec,
  WorkbookEvent,
  WorkbookSummary,
} from "@/types/spreadsheet";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_SPREADSHEET_API_URL ?? "http://localhost:8787";

interface JsonError {
  error?: {
    code: string;
    message: string;
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const maybeError = (await response.json().catch(() => null)) as JsonError | null;
    const message =
      maybeError?.error?.message ??
      `Request failed with status ${response.status}.`;
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function createWorkbook(
  name?: string,
): Promise<WorkbookSummary> {
  const response = await fetch(`${API_BASE_URL}/v1/workbooks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await parseJsonResponse<{ workbook: WorkbookSummary }>(response);
  return data.workbook;
}

export async function importWorkbook(file: File): Promise<WorkbookSummary> {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch(`${API_BASE_URL}/v1/workbooks/import`, {
    method: "POST",
    body: form,
  });
  const data = await parseJsonResponse<{ workbook: WorkbookSummary }>(response);
  return data.workbook;
}

export async function getWorkbook(workbookId: string): Promise<WorkbookSummary> {
  const response = await fetch(`${API_BASE_URL}/v1/workbooks/${workbookId}`);
  const data = await parseJsonResponse<{ workbook: WorkbookSummary }>(response);
  return data.workbook;
}

export async function createSheet(
  workbookId: string,
  sheet: string,
): Promise<{ sheet: string; created: boolean; sheets: string[] }> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/sheets`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheet, actor: "ui" }),
    },
  );
  return parseJsonResponse<{ sheet: string; created: boolean; sheets: string[] }>(
    response,
  );
}

export async function getCells(
  workbookId: string,
  sheet: string,
): Promise<CellSnapshot[]> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/cells/get`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sheet,
        range: {
          start_row: 1,
          end_row: 50,
          start_col: 1,
          end_col: 12,
        },
      }),
    },
  );
  const data = await parseJsonResponse<{ cells: CellSnapshot[] }>(response);
  return data.cells;
}

export async function setCellBatch(
  workbookId: string,
  sheet: string,
  cells: Array<{
    row: number;
    col: number;
    value?: string;
    formula?: string;
  }>,
): Promise<void> {
  await parseJsonResponse(
    await fetch(`${API_BASE_URL}/v1/workbooks/${workbookId}/cells/set-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sheet,
        actor: "ui",
        cells,
      }),
    }),
  );
}

interface AgentOpsRequest {
  request_id?: string;
  actor?: string;
  stop_on_error?: boolean;
  expected_operations_signature?: string;
  operations: Array<Record<string, unknown>>;
}

export async function runAgentOps(
  workbookId: string,
  payload: AgentOpsRequest,
): Promise<AgentOpsResponse> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return parseJsonResponse<AgentOpsResponse>(response);
}

export async function previewAgentOps(
  workbookId: string,
  operations: AgentOperationPreview[],
): Promise<AgentOpsPreviewResponse> {
  if (operations.length === 0) {
    throw new Error("Operation list cannot be empty.");
  }
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/preview`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations }),
    },
  );
  return parseJsonResponse<AgentOpsPreviewResponse>(response);
}

interface AgentPresetRequest {
  request_id?: string;
  actor?: string;
  stop_on_error?: boolean;
  include_file_base64?: boolean;
  expected_operations_signature?: string;
}

export async function runAgentPreset(
  workbookId: string,
  preset: string,
  payload: AgentPresetRequest,
): Promise<AgentPresetResponse> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/presets/${preset}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return parseJsonResponse<AgentPresetResponse>(response);
}

export async function getAgentPresets(
  workbookId: string,
): Promise<AgentPresetInfo[]> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/presets`,
  );
  const data = await parseJsonResponse<{ presets: AgentPresetInfo[] }>(response);
  return data.presets;
}

export async function getAgentSchema(
  workbookId: string,
): Promise<AgentSchemaInfo> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/schema`,
  );
  return parseJsonResponse<AgentSchemaInfo>(response);
}

export async function getAgentScenarios(
  workbookId: string,
): Promise<AgentScenarioInfo[]> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/scenarios`,
  );
  const data = await parseJsonResponse<{ scenarios: AgentScenarioInfo[] }>(
    response,
  );
  return data.scenarios;
}

export async function getAgentScenarioOperations(
  workbookId: string,
  scenario: string,
  includeFileBase64: boolean,
): Promise<AgentOperationPlanPreview> {
  const query = new URLSearchParams({
    include_file_base64: String(includeFileBase64),
  });
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/scenarios/${scenario}/operations?${query.toString()}`,
  );
  const data = await parseJsonResponse<{
    operations_signature: string;
    operations: AgentOperationPreview[];
  }>(
    response,
  );
  return data;
}

export async function getWizardScenarios(): Promise<AgentScenarioInfo[]> {
  const response = await fetch(`${API_BASE_URL}/v1/agent/wizard/scenarios`);
  const data = await parseJsonResponse<{ scenarios: AgentScenarioInfo[] }>(
    response,
  );
  return data.scenarios;
}

export async function getWizardPresets(): Promise<AgentPresetInfo[]> {
  const response = await fetch(`${API_BASE_URL}/v1/agent/wizard/presets`);
  const data = await parseJsonResponse<{ presets: AgentPresetInfo[] }>(
    response,
  );
  return data.presets;
}

export async function getWizardPresetOperations(
  preset: string,
  includeFileBase64: boolean,
): Promise<AgentOperationPlanPreview> {
  const query = new URLSearchParams({
    include_file_base64: String(includeFileBase64),
  });
  const response = await fetch(
    `${API_BASE_URL}/v1/agent/wizard/presets/${preset}/operations?${query.toString()}`,
  );
  const data = await parseJsonResponse<{
    operations_signature: string;
    operations: AgentOperationPreview[];
  }>(
    response,
  );
  return data;
}

export async function getAgentPresetOperations(
  workbookId: string,
  preset: string,
  includeFileBase64: boolean,
): Promise<AgentOperationPlanPreview> {
  const query = new URLSearchParams({
    include_file_base64: String(includeFileBase64),
  });
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/presets/${preset}/operations?${query.toString()}`,
  );
  const data = await parseJsonResponse<{
    operations_signature: string;
    operations: AgentOperationPreview[];
  }>(
    response,
  );
  return data;
}

export async function getWizardSchema(): Promise<AgentWizardSchemaInfo> {
  const response = await fetch(`${API_BASE_URL}/v1/agent/wizard/schema`);
  return parseJsonResponse<AgentWizardSchemaInfo>(response);
}

export async function getWizardScenarioOperations(
  scenario: string,
  includeFileBase64: boolean,
): Promise<AgentOperationPlanPreview> {
  const query = new URLSearchParams({
    include_file_base64: String(includeFileBase64),
  });
  const response = await fetch(
    `${API_BASE_URL}/v1/agent/wizard/scenarios/${scenario}/operations?${query.toString()}`,
  );
  const data = await parseJsonResponse<{
    operations_signature: string;
    operations: AgentOperationPreview[];
  }>(
    response,
  );
  return data;
}

interface AgentScenarioRequest {
  request_id?: string;
  actor?: string;
  stop_on_error?: boolean;
  include_file_base64?: boolean;
  expected_operations_signature?: string;
}

export async function runAgentScenario(
  workbookId: string,
  scenario: string,
  payload: AgentScenarioRequest,
): Promise<AgentScenarioResponse> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/scenarios/${scenario}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return parseJsonResponse<AgentScenarioResponse>(response);
}

interface AgentWizardRequest {
  scenario: string;
  request_id?: string;
  actor?: string;
  stop_on_error?: boolean;
  include_file_base64?: boolean;
  expected_operations_signature?: string;
  workbook_name?: string;
  file?: File | null;
}

export async function runAgentWizard(
  payload: AgentWizardRequest,
): Promise<AgentWizardRunResponse> {
  if (!payload.file) {
    const response = await fetch(`${API_BASE_URL}/v1/agent/wizard/run-json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario: payload.scenario,
        request_id: payload.request_id,
        actor: payload.actor,
        stop_on_error: payload.stop_on_error,
        include_file_base64: payload.include_file_base64,
        expected_operations_signature: payload.expected_operations_signature,
        workbook_name: payload.workbook_name,
      }),
    });
    return parseJsonResponse<AgentWizardRunResponse>(response);
  }

  const formData = new FormData();
  formData.append("scenario", payload.scenario);
  if (payload.request_id) {
    formData.append("request_id", payload.request_id);
  }
  if (payload.actor) {
    formData.append("actor", payload.actor);
  }
  if (payload.workbook_name) {
    formData.append("workbook_name", payload.workbook_name);
  }
  if (typeof payload.stop_on_error === "boolean") {
    formData.append("stop_on_error", String(payload.stop_on_error));
  }
  if (typeof payload.include_file_base64 === "boolean") {
    formData.append("include_file_base64", String(payload.include_file_base64));
  }
  if (payload.expected_operations_signature) {
    formData.append(
      "expected_operations_signature",
      payload.expected_operations_signature,
    );
  }
  formData.append("file", payload.file);

  const response = await fetch(`${API_BASE_URL}/v1/agent/wizard/run`, {
    method: "POST",
    body: formData,
  });
  return parseJsonResponse<AgentWizardRunResponse>(response);
}

export async function upsertChart(
  workbookId: string,
  chart: ChartSpec,
): Promise<void> {
  await parseJsonResponse(
    await fetch(`${API_BASE_URL}/v1/workbooks/${workbookId}/charts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "ui", chart }),
    }),
  );
}

export async function exportWorkbook(workbookId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/v1/workbooks/${workbookId}/export`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Export failed with status ${response.status}.`);
  }
  return response.blob();
}

export function subscribeToWorkbookEvents(
  workbookId: string,
  onEvent: (event: WorkbookEvent) => void,
): () => void {
  const eventSource = new EventSource(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/events`,
  );

  eventSource.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data) as WorkbookEvent;
      onEvent(parsed);
    } catch {
      // no-op for malformed event payloads
    }
  };

  eventSource.onerror = () => {
    // Browser will auto-reconnect for EventSource.
  };

  return () => eventSource.close();
}
