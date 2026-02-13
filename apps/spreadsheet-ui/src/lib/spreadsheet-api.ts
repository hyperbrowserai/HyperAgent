import {
  AgentOpsResponse,
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
