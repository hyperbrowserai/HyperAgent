import {
  AgentOpsCacheEntryDetailResponse,
  AgentOpsCacheEntriesResponse,
  AgentOpsCachePrefixesResponse,
  AgentOpsPreviewResponse,
  AgentOpsCacheStatsResponse,
  ClearAgentOpsCacheResponse,
  ReplayAgentOpsCacheEntryResponse,
  ReexecuteAgentOpsCacheEntryResponse,
  RemoveAgentOpsCacheEntriesByPrefixResponse,
  PreviewRemoveAgentOpsCacheEntriesByPrefixResponse,
  RemoveStaleAgentOpsCacheEntriesResponse,
  RemoveAgentOpsCacheEntryResponse,
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

export class SpreadsheetApiError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "SpreadsheetApiError";
    this.status = status;
    this.code = code;
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const maybeError = (await response.json().catch(() => null)) as JsonError | null;
    const code = maybeError?.error?.code;
    const message =
      maybeError?.error?.message ??
      `Request failed with status ${response.status}.`;
    throw new SpreadsheetApiError(message, response.status, code);
  }
  return (await response.json()) as T;
}

function normalizePositiveInteger(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  if (normalized <= 0) {
    return undefined;
  }
  return normalized;
}

function normalizeSampleLimit(value?: number): number | undefined {
  const normalized = normalizePositiveInteger(value);
  if (typeof normalized !== "number") {
    return undefined;
  }
  return Math.min(normalized, 100);
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

export async function getAgentOpsCacheStats(
  workbookId: string,
  maxAgeSeconds?: number,
  requestIdPrefix?: string,
): Promise<AgentOpsCacheStatsResponse> {
  const params = new URLSearchParams();
  const normalizedPrefix = requestIdPrefix?.trim();
  if (normalizedPrefix) {
    params.set("request_id_prefix", normalizedPrefix);
  }
  const normalizedMaxAgeSeconds = normalizePositiveInteger(maxAgeSeconds);
  if (typeof normalizedMaxAgeSeconds === "number") {
    params.set("max_age_seconds", String(normalizedMaxAgeSeconds));
  }
  const suffix = params.toString();
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache${suffix ? `?${suffix}` : ""}`,
  );
  return parseJsonResponse<AgentOpsCacheStatsResponse>(response);
}

export async function getAgentOpsCacheEntries(
  workbookId: string,
  limit: number = 20,
  offset: number = 0,
  requestIdPrefix?: string,
  maxAgeSeconds?: number,
): Promise<AgentOpsCacheEntriesResponse> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const safeOffset = Math.max(0, offset);
  const params = new URLSearchParams({
    offset: String(safeOffset),
    limit: String(safeLimit),
  });
  const normalizedPrefix = requestIdPrefix?.trim();
  if (normalizedPrefix) {
    params.set("request_id_prefix", normalizedPrefix);
  }
  const normalizedMaxAgeSeconds = normalizePositiveInteger(maxAgeSeconds);
  if (typeof normalizedMaxAgeSeconds === "number") {
    params.set("max_age_seconds", String(normalizedMaxAgeSeconds));
  }
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/entries?${params.toString()}`,
  );
  return parseJsonResponse<AgentOpsCacheEntriesResponse>(response);
}

export async function getAgentOpsCacheEntryDetail(
  workbookId: string,
  requestId: string,
): Promise<AgentOpsCacheEntryDetailResponse> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/entries/${encodeURIComponent(requestId)}`,
  );
  return parseJsonResponse<AgentOpsCacheEntryDetailResponse>(response);
}

export async function getAgentOpsCachePrefixes(
  workbookId: string,
  limit: number = 8,
  requestIdPrefix?: string,
  maxAgeSeconds?: number,
  minEntryCount?: number,
): Promise<AgentOpsCachePrefixesResponse> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const params = new URLSearchParams({
    limit: String(safeLimit),
  });
  const normalizedPrefix = requestIdPrefix?.trim();
  if (normalizedPrefix) {
    params.set("request_id_prefix", normalizedPrefix);
  }
  const normalizedMaxAgeSeconds = normalizePositiveInteger(maxAgeSeconds);
  if (typeof normalizedMaxAgeSeconds === "number") {
    params.set("max_age_seconds", String(normalizedMaxAgeSeconds));
  }
  const normalizedMinEntryCount = normalizePositiveInteger(minEntryCount);
  if (typeof normalizedMinEntryCount === "number") {
    params.set("min_entry_count", String(normalizedMinEntryCount));
  }
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/prefixes?${params.toString()}`,
  );
  return parseJsonResponse<AgentOpsCachePrefixesResponse>(response);
}

export async function clearAgentOpsCache(
  workbookId: string,
): Promise<ClearAgentOpsCacheResponse> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/clear`,
    {
      method: "POST",
    },
  );
  return parseJsonResponse<ClearAgentOpsCacheResponse>(response);
}

export async function replayAgentOpsCacheEntry(
  workbookId: string,
  requestId: string,
): Promise<ReplayAgentOpsCacheEntryResponse> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/replay`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: requestId }),
    },
  );
  return parseJsonResponse<ReplayAgentOpsCacheEntryResponse>(response);
}

interface ReexecuteAgentOpsCacheEntryRequest {
  request_id: string;
  new_request_id?: string;
  actor?: string;
  stop_on_error?: boolean;
  expected_operations_signature?: string;
}

export async function reexecuteAgentOpsCacheEntry(
  workbookId: string,
  payload: ReexecuteAgentOpsCacheEntryRequest,
): Promise<ReexecuteAgentOpsCacheEntryResponse> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/reexecute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return parseJsonResponse<ReexecuteAgentOpsCacheEntryResponse>(response);
}

export async function removeAgentOpsCacheEntry(
  workbookId: string,
  requestId: string,
): Promise<RemoveAgentOpsCacheEntryResponse> {
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/remove`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: requestId }),
    },
  );
  return parseJsonResponse<RemoveAgentOpsCacheEntryResponse>(response);
}

export async function removeAgentOpsCacheEntriesByPrefix(
  workbookId: string,
  requestIdPrefix: string,
  maxAgeSeconds?: number,
): Promise<RemoveAgentOpsCacheEntriesByPrefixResponse> {
  const normalizedMaxAgeSeconds = normalizePositiveInteger(maxAgeSeconds);
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/remove-by-prefix`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id_prefix: requestIdPrefix,
        max_age_seconds: normalizedMaxAgeSeconds,
      }),
    },
  );
  return parseJsonResponse<RemoveAgentOpsCacheEntriesByPrefixResponse>(response);
}

export async function previewRemoveAgentOpsCacheEntriesByPrefix(
  workbookId: string,
  requestIdPrefix: string,
  sampleLimit?: number,
  maxAgeSeconds?: number,
): Promise<PreviewRemoveAgentOpsCacheEntriesByPrefixResponse> {
  const safeSampleLimit = normalizeSampleLimit(sampleLimit);
  const normalizedMaxAgeSeconds = normalizePositiveInteger(maxAgeSeconds);
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/remove-by-prefix/preview`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id_prefix: requestIdPrefix,
        max_age_seconds: normalizedMaxAgeSeconds,
        sample_limit: safeSampleLimit,
      }),
    },
  );
  return parseJsonResponse<PreviewRemoveAgentOpsCacheEntriesByPrefixResponse>(response);
}

interface RemoveStaleAgentOpsCacheEntriesRequest {
  request_id_prefix?: string;
  max_age_seconds: number;
  dry_run?: boolean;
  sample_limit?: number;
}

export async function removeStaleAgentOpsCacheEntries(
  workbookId: string,
  payload: RemoveStaleAgentOpsCacheEntriesRequest,
): Promise<RemoveStaleAgentOpsCacheEntriesResponse> {
  const normalizedPrefix = payload.request_id_prefix?.trim();
  const safeSampleLimit = normalizeSampleLimit(payload.sample_limit);
  const safeMaxAgeSeconds =
    normalizePositiveInteger(payload.max_age_seconds) ?? 1;
  const response = await fetch(
    `${API_BASE_URL}/v1/workbooks/${workbookId}/agent/ops/cache/remove-stale`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        request_id_prefix: normalizedPrefix || undefined,
        max_age_seconds: safeMaxAgeSeconds,
        sample_limit: safeSampleLimit,
      }),
    },
  );
  return parseJsonResponse<RemoveStaleAgentOpsCacheEntriesResponse>(response);
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
