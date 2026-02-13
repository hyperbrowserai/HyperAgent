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
