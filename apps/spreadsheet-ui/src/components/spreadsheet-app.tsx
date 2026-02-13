"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  createSheet,
  createWorkbook,
  exportWorkbook,
  getAgentSchema,
  getAgentPresets,
  getAgentScenarioOperations,
  getAgentScenarios,
  getWizardPresets,
  getWizardScenarioOperations,
  getWizardSchema,
  getWizardScenarios,
  getCells,
  getWorkbook,
  importWorkbook,
  runAgentOps,
  runAgentPreset,
  runAgentScenario,
  runAgentWizard,
  subscribeToWorkbookEvents,
  upsertChart,
} from "@/lib/spreadsheet-api";
import { buildAddress, indexToColumn, TOTAL_COLS, TOTAL_ROWS } from "@/lib/cell-address";
import { useWorkbookStore } from "@/store/workbook-store";
import { AgentOperationResult } from "@/types/spreadsheet";

const ChartPreview = dynamic(
  () => import("@/components/chart-preview").then((module) => module.ChartPreview),
  {
    ssr: false,
  },
);

export function SpreadsheetApp() {
  const queryClient = useQueryClient();
  const {
    workbook,
    activeSheet,
    selectedAddress,
    eventSeq,
    eventLog,
    cellsByAddress,
    setWorkbook,
    setActiveSheet,
    setCells,
    setSelectedAddress,
    appendEvent,
  } = useWorkbookStore();
  const [formulaInput, setFormulaInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningAgentFlow, setIsRunningAgentFlow] = useState(false);
  const [isRunningPreset, setIsRunningPreset] = useState(false);
  const [isRunningScenario, setIsRunningScenario] = useState(false);
  const [isRunningSelectedScenario, setIsRunningSelectedScenario] = useState(false);
  const [isRunningPreviewOps, setIsRunningPreviewOps] = useState(false);
  const [isRunningWizard, setIsRunningWizard] = useState(false);
  const [isCreatingSheet, setIsCreatingSheet] = useState(false);
  const [newSheetName, setNewSheetName] = useState("Sheet2");
  const [wizardScenario, setWizardScenario] = useState("seed_then_export");
  const [wizardIncludeFileBase64, setWizardIncludeFileBase64] = useState(false);
  const [wizardWorkbookName, setWizardWorkbookName] = useState("Wizard Workbook");
  const [wizardFile, setWizardFile] = useState<File | null>(null);
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [uiError, setUiError] = useState<string | null>(null);
  const [lastAgentRequestId, setLastAgentRequestId] = useState<string | null>(null);
  const [lastPreset, setLastPreset] = useState<string | null>(null);
  const [lastScenario, setLastScenario] = useState<string | null>(null);
  const [lastAgentOps, setLastAgentOps] = useState<AgentOperationResult[]>([]);
  const [lastWizardImportSummary, setLastWizardImportSummary] = useState<{
    sheetsImported: number;
    cellsImported: number;
    warnings: string[];
  } | null>(null);

  const createWorkbookMutation = useMutation({
    mutationFn: () => createWorkbook("Agent Workbook"),
    onSuccess: (createdWorkbook) => {
      setUiError(null);
      setWorkbook(createdWorkbook);
    },
    onError: (error) => {
      setUiError(error.message);
    },
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => importWorkbook(file),
    onSuccess: (importedWorkbook) => {
      setUiError(null);
      setWorkbook(importedWorkbook);
      queryClient.invalidateQueries({ queryKey: ["cells", importedWorkbook.id] });
    },
    onError: (error) => {
      setUiError(error.message);
    },
  });

  const cellsQuery = useQuery({
    queryKey: ["cells", workbook?.id, activeSheet],
    enabled: Boolean(workbook?.id),
    queryFn: () => getCells(workbook!.id, activeSheet),
  });

  const workbookQuery = useQuery({
    queryKey: ["workbook", workbook?.id],
    enabled: Boolean(workbook?.id),
    queryFn: () => getWorkbook(workbook!.id),
  });

  const presetsQuery = useQuery({
    queryKey: ["agent-presets", workbook?.id],
    enabled: Boolean(workbook?.id),
    queryFn: () => getAgentPresets(workbook!.id),
  });

  const agentSchemaQuery = useQuery({
    queryKey: ["agent-schema", workbook?.id],
    enabled: Boolean(workbook?.id),
    queryFn: () => getAgentSchema(workbook!.id),
  });

  const scenariosQuery = useQuery({
    queryKey: ["agent-scenarios", workbook?.id],
    enabled: Boolean(workbook?.id),
    queryFn: () => getAgentScenarios(workbook!.id),
  });

  const wizardScenariosQuery = useQuery({
    queryKey: ["wizard-scenarios"],
    queryFn: getWizardScenarios,
  });

  const wizardPresetsQuery = useQuery({
    queryKey: ["wizard-presets"],
    queryFn: getWizardPresets,
  });

  const wizardSchemaQuery = useQuery({
    queryKey: ["wizard-schema"],
    queryFn: getWizardSchema,
  });

  const wizardScenarioOpsQuery = useQuery({
    queryKey: ["wizard-scenario-ops", workbook?.id, wizardScenario, wizardIncludeFileBase64],
    enabled: wizardScenario.length > 0,
    queryFn: () =>
      workbook?.id
        ? getAgentScenarioOperations(
            workbook.id,
            wizardScenario,
            wizardIncludeFileBase64,
          )
        : getWizardScenarioOperations(wizardScenario, wizardIncludeFileBase64),
  });

  useEffect(() => {
    if (!workbook && !createWorkbookMutation.isPending) {
      createWorkbookMutation.mutate();
    }
  }, [workbook, createWorkbookMutation]);

  useEffect(() => {
    if (workbookQuery.data) {
      setWorkbook(workbookQuery.data);
    }
  }, [workbookQuery.data, setWorkbook]);

  useEffect(() => {
    if (cellsQuery.data) {
      setCells(cellsQuery.data);
    }
  }, [cellsQuery.data, setCells]);

  useEffect(() => {
    if (!workbook?.id) {
      return;
    }
    const unsubscribe = subscribeToWorkbookEvents(workbook.id, (event) => {
      appendEvent(event);
      queryClient.invalidateQueries({ queryKey: ["cells", workbook.id, activeSheet] });
      queryClient.invalidateQueries({ queryKey: ["workbook", workbook.id] });
      queryClient.invalidateQueries({ queryKey: ["agent-presets", workbook.id] });
      queryClient.invalidateQueries({ queryKey: ["agent-scenarios", workbook.id] });
      queryClient.invalidateQueries({ queryKey: ["agent-schema", workbook.id] });
    });
    return unsubscribe;
  }, [workbook?.id, activeSheet, queryClient, appendEvent]);

  useEffect(() => {
    const selectedCell = cellsByAddress[selectedAddress];
    if (selectedCell?.formula) {
      setFormulaInput(selectedCell.formula);
      return;
    }
    setFormulaInput(
      selectedCell?.raw_value ?? selectedCell?.evaluated_value ?? "",
    );
  }, [cellsByAddress, selectedAddress]);

  useEffect(() => {
    if (!wizardScenariosQuery.data?.length) {
      return;
    }
    const hasSelectedScenario = wizardScenariosQuery.data.some(
      (scenarioInfo) => scenarioInfo.scenario === wizardScenario,
    );
    if (hasSelectedScenario) {
      return;
    }
    setWizardScenario(wizardScenariosQuery.data[0].scenario);
  }, [wizardScenario, wizardScenariosQuery.data]);

  const chartData = useMemo(() => {
    return Array.from({ length: 10 }, (_, index) => {
      const row = index + 1;
      const category =
        cellsByAddress[buildAddress(row, 1)]?.evaluated_value ??
        cellsByAddress[buildAddress(row, 1)]?.raw_value ??
        `R${row}`;
      const valueText =
        cellsByAddress[buildAddress(row, 2)]?.evaluated_value ??
        cellsByAddress[buildAddress(row, 2)]?.raw_value ??
        "0";
      return {
        category,
        value: Number(valueText) || 0,
      };
    });
  }, [cellsByAddress]);

  const eventTypeOptions = useMemo(() => {
    const unique = Array.from(new Set(eventLog.map((event) => event.event_type)));
    return ["all", ...unique];
  }, [eventLog]);

  const filteredEvents = useMemo(() => {
    if (eventFilter === "all") {
      return eventLog;
    }
    return eventLog.filter((event) => event.event_type === eventFilter);
  }, [eventFilter, eventLog]);
  const wizardScenarioOps = wizardScenarioOpsQuery.data ?? [];

  const statusText =
    createWorkbookMutation.isPending || importMutation.isPending
      ? "Initializing workbook..."
      : cellsQuery.isFetching || workbookQuery.isFetching
        ? "Syncing updates..."
        : "Ready";

  async function handleSaveFormula() {
    if (!workbook) {
      return;
    }
    const row = Number(selectedAddress.match(/\d+/)?.[0] ?? 1);
    const columnLabel = selectedAddress.match(/[A-Z]+/)?.[0] ?? "A";
    const col = [...columnLabel].reduce(
      (sum, char) => sum * 26 + (char.charCodeAt(0) - 64),
      0,
    );

    setIsSaving(true);
    try {
      setUiError(null);
      const isFormula = formulaInput.trim().startsWith("=");
      const response = await runAgentOps(workbook.id, {
        request_id: `formula-${Date.now()}`,
        actor: "ui-formula-bar",
        stop_on_error: true,
        operations: [
          {
            op_type: "set_cells",
            sheet: activeSheet,
            cells: [
              {
                row,
                col,
                ...(isFormula
                  ? { formula: formulaInput.trim() }
                  : { value: formulaInput }),
              },
            ],
          },
          {
            op_type: "get_cells",
            sheet: activeSheet,
            range: {
              start_row: row,
              end_row: row,
              start_col: col,
              end_col: col,
            },
          },
        ],
      });
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastPreset(null);
      setLastScenario(null);
      setLastWizardImportSummary(null);
      await queryClient.invalidateQueries({
        queryKey: ["cells", workbook.id, activeSheet],
      });
    } catch (error) {
      setUiError(
        error instanceof Error ? error.message : "Failed to apply cell update.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleExport() {
    if (!workbook) {
      return;
    }
    try {
      setUiError(null);
      const blob = await exportWorkbook(workbook.id);
      const fileUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = fileUrl;
      anchor.download = `${workbook.name}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(fileUrl);
    } catch (error) {
      setUiError(
        error instanceof Error ? error.message : "Failed to export workbook.",
      );
    }
  }

  async function handleChartSync() {
    if (!workbook) {
      return;
    }
    try {
      setUiError(null);
      await upsertChart(workbook.id, {
        id: "chart-default",
        sheet: activeSheet,
        chart_type: "bar",
        title: "Column B by Column A",
        categories_range: `${activeSheet}!$A$1:$A$10`,
        values_range: `${activeSheet}!$B$1:$B$10`,
      });
    } catch (error) {
      setUiError(
        error instanceof Error ? error.message : "Failed to sync chart metadata.",
      );
    }
  }

  async function handleAgentDemoFlow() {
    if (!workbook) {
      return;
    }
    setIsRunningAgentFlow(true);
    try {
      setUiError(null);
      const response = await runAgentOps(workbook.id, {
        request_id: `agent-demo-${Date.now()}`,
        actor: "ui-agent-demo",
        stop_on_error: true,
        operations: [
          {
            op_type: "set_cells",
            sheet: activeSheet,
            cells: [
              { row: 1, col: 1, value: "North" },
              { row: 2, col: 1, value: "South" },
              { row: 3, col: 1, value: "West" },
              { row: 1, col: 2, value: 120 },
              { row: 2, col: 2, value: 90 },
              { row: 3, col: 2, value: 75 },
              { row: 4, col: 2, formula: "=SUM(B1:B3)" },
            ],
          },
          { op_type: "recalculate" },
          {
            op_type: "upsert_chart",
            chart: {
              id: "chart-agent-demo",
              sheet: activeSheet,
              chart_type: "bar",
              title: "Regional Totals",
              categories_range: `${activeSheet}!$A$1:$A$3`,
              values_range: `${activeSheet}!$B$1:$B$3`,
            },
          },
          { op_type: "export_workbook", include_file_base64: false },
        ],
      });
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await queryClient.invalidateQueries({
        queryKey: ["cells", workbook.id, activeSheet],
      });
    } catch (error) {
      setUiError(
        error instanceof Error ? error.message : "Failed to run agent demo flow.",
      );
    } finally {
      setIsRunningAgentFlow(false);
    }
  }

  async function handlePresetRun(preset: string) {
    if (!workbook) {
      return;
    }
    setIsRunningPreset(true);
    try {
      setUiError(null);
      const response = await runAgentPreset(workbook.id, preset, {
        request_id: `preset-${preset}-${Date.now()}`,
        actor: "ui-preset",
        stop_on_error: true,
        include_file_base64: preset === "export_snapshot" ? false : undefined,
      });
      setLastPreset(response.preset);
      setLastScenario(null);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await queryClient.invalidateQueries({
        queryKey: ["cells", workbook.id, activeSheet],
      });
    } catch (error) {
      setUiError(
        error instanceof Error ? error.message : `Failed to run preset ${preset}.`,
      );
    } finally {
      setIsRunningPreset(false);
    }
  }

  async function handleScenarioRun(scenario: string) {
    if (!workbook) {
      return;
    }
    setIsRunningScenario(true);
    try {
      setUiError(null);
      const response = await runAgentScenario(workbook.id, scenario, {
        request_id: `scenario-${scenario}-${Date.now()}`,
        actor: "ui-scenario",
        stop_on_error: true,
        include_file_base64: false,
      });
      setLastScenario(response.scenario);
      setLastPreset(null);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await queryClient.invalidateQueries({
        queryKey: ["cells", workbook.id, activeSheet],
      });
    } catch (error) {
      setUiError(
        error instanceof Error
          ? error.message
          : `Failed to run scenario ${scenario}.`,
      );
    } finally {
      setIsRunningScenario(false);
    }
  }

  async function handleRunSelectedScenarioOnCurrentWorkbook() {
    if (!workbook) {
      return;
    }
    setIsRunningSelectedScenario(true);
    try {
      setUiError(null);
      const response = await runAgentScenario(workbook.id, wizardScenario, {
        request_id: `scenario-selected-${wizardScenario}-${Date.now()}`,
        actor: "ui-scenario-selected",
        stop_on_error: true,
        include_file_base64: wizardIncludeFileBase64,
      });
      setLastScenario(response.scenario);
      setLastPreset(null);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await queryClient.invalidateQueries({
        queryKey: ["cells", workbook.id, activeSheet],
      });
    } catch (error) {
      setUiError(
        error instanceof Error
          ? error.message
          : `Failed to run selected scenario ${wizardScenario}.`,
      );
    } finally {
      setIsRunningSelectedScenario(false);
    }
  }

  async function handleRunPreviewOperationsOnCurrentWorkbook() {
    if (!workbook || wizardScenarioOps.length === 0) {
      return;
    }
    setIsRunningPreviewOps(true);
    try {
      setUiError(null);
      const response = await runAgentOps(workbook.id, {
        request_id: `scenario-preview-ops-${wizardScenario}-${Date.now()}`,
        actor: "ui-scenario-preview-ops",
        stop_on_error: true,
        operations: wizardScenarioOps,
      });
      setLastScenario(wizardScenario);
      setLastPreset(null);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await queryClient.invalidateQueries({
        queryKey: ["cells", workbook.id, activeSheet],
      });
    } catch (error) {
      setUiError(
        error instanceof Error
          ? error.message
          : `Failed to run preview operations for ${wizardScenario}.`,
      );
    } finally {
      setIsRunningPreviewOps(false);
    }
  }

  async function handleWizardRun() {
    if (!wizardScenario) {
      return;
    }
    setIsRunningWizard(true);
    try {
      setUiError(null);
      const response = await runAgentWizard({
        scenario: wizardScenario,
        request_id: `wizard-${wizardScenario}-${Date.now()}`,
        actor: "ui-wizard",
        stop_on_error: true,
        include_file_base64: wizardIncludeFileBase64,
        workbook_name: wizardWorkbookName,
        file: wizardFile,
      });
      setWorkbook(response.workbook);
      setActiveSheet(response.workbook.sheets[0] ?? "Sheet1");
      setLastScenario(response.scenario);
      setLastPreset(null);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(
        response.import
          ? {
              sheetsImported: response.import.sheets_imported,
              cellsImported: response.import.cells_imported,
              warnings: response.import.warnings,
            }
          : null,
      );

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workbook", response.workbook.id] }),
        queryClient.invalidateQueries({ queryKey: ["cells", response.workbook.id, response.workbook.sheets[0] ?? "Sheet1"] }),
        queryClient.invalidateQueries({ queryKey: ["agent-presets", response.workbook.id] }),
        queryClient.invalidateQueries({ queryKey: ["agent-scenarios", response.workbook.id] }),
        queryClient.invalidateQueries({ queryKey: ["agent-schema", response.workbook.id] }),
      ]);
    } catch (error) {
      setUiError(
        error instanceof Error ? error.message : "Failed to run wizard flow.",
      );
    } finally {
      setIsRunningWizard(false);
    }
  }

  async function handleCreateSheet() {
    if (!workbook) {
      return;
    }
    const trimmed = newSheetName.trim();
    if (!trimmed) {
      return;
    }
    setIsCreatingSheet(true);
    try {
      setUiError(null);
      await createSheet(workbook.id, trimmed);
      setActiveSheet(trimmed);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workbook", workbook.id] }),
        queryClient.invalidateQueries({ queryKey: ["cells", workbook.id, trimmed] }),
      ]);
    } catch (error) {
      setUiError(
        error instanceof Error ? error.message : "Failed to create sheet.",
      );
    } finally {
      setIsCreatingSheet(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4">
        <header className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                DuckDB Spreadsheet Studio
              </h1>
              <p className="text-sm text-slate-400">
                Live workbook stream + formula recalculation + chart sync
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => createWorkbookMutation.mutate()}
                className="rounded-md bg-indigo-500 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-400"
              >
                New Workbook
              </button>
              <label className="cursor-pointer rounded-md bg-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-600">
                Import .xlsx
                <input
                  type="file"
                  accept=".xlsx"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      importMutation.mutate(file);
                    }
                  }}
                />
              </label>
              <button
                onClick={handleExport}
                className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-400"
              >
                Export .xlsx
              </button>
              {(presetsQuery.data ?? []).map((presetInfo, index) => (
                <button
                  key={presetInfo.preset}
                  onClick={() => handlePresetRun(presetInfo.preset)}
                  disabled={!workbook || isRunningPreset}
                  title={`${presetInfo.description} (ops: ${presetInfo.operations.join(", ")})`}
                  className={`rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-40 ${
                    index % 2 === 0
                      ? "bg-amber-500 hover:bg-amber-400"
                      : "bg-cyan-500 hover:bg-cyan-400"
                  }`}
                >
                  {isRunningPreset
                    ? "Running preset..."
                    : `Preset: ${presetInfo.preset}`}
                </button>
              ))}
              <button
                onClick={handleAgentDemoFlow}
                disabled={!workbook || isRunningAgentFlow}
                className="rounded-md bg-fuchsia-500 px-3 py-2 text-sm font-medium text-white hover:bg-fuchsia-400 disabled:opacity-40"
              >
                {isRunningAgentFlow ? "Running agent..." : "Run Agent Demo Flow"}
              </button>
              {(scenariosQuery.data ?? []).map((scenarioInfo) => (
                <button
                  key={scenarioInfo.scenario}
                  onClick={() => handleScenarioRun(scenarioInfo.scenario)}
                  disabled={!workbook || isRunningScenario}
                  title={`${scenarioInfo.description} (presets: ${scenarioInfo.presets.join(", ")})`}
                  className="rounded-md bg-violet-500 px-3 py-2 text-sm font-medium text-white hover:bg-violet-400 disabled:opacity-40"
                >
                  {isRunningScenario
                    ? "Running scenario..."
                    : `Scenario: ${scenarioInfo.scenario}`}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-slate-300 md:grid-cols-4">
            <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
              Workbook: <span className="font-semibold">{workbook?.name ?? "-"}</span>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
              Sheet: <span className="font-semibold">{activeSheet}</span>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
              Status: <span className="font-semibold">{statusText}</span>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
              Stream Seq: <span className="font-semibold">{eventSeq}</span>
            </div>
          </div>
          {workbook?.compatibility_warnings?.length ? (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-100">
              <p className="mb-1 font-semibold">Compatibility warnings</p>
              <ul className="list-disc space-y-1 pl-4">
                {workbook.compatibility_warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {uiError ? (
            <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-100">
              <div className="flex items-center justify-between gap-2">
                <span>{uiError}</span>
                <button
                  onClick={() => setUiError(null)}
                  className="rounded border border-rose-300/30 px-2 py-0.5 text-[11px] hover:bg-rose-500/20"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(workbook?.sheets ?? []).map((sheet) => (
              <button
                key={sheet}
                onClick={() => setActiveSheet(sheet)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                  sheet === activeSheet
                    ? "border-indigo-300 bg-indigo-500/25 text-indigo-100"
                    : "border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {sheet}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <input
                value={newSheetName}
                onChange={(event) => setNewSheetName(event.target.value)}
                className="w-28 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-400"
                placeholder="New sheet name"
              />
              <button
                onClick={handleCreateSheet}
                disabled={!workbook || isCreatingSheet}
                className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-600 disabled:opacity-40"
              >
                {isCreatingSheet ? "Adding..." : "Add Sheet"}
              </button>
            </div>
          </div>
          <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/60 p-2">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-300">
                Agent Wizard (new workbook run)
              </p>
              <span className="text-[11px] text-slate-500">
                Optional import + scenario execution
              </span>
            </div>
            {wizardSchemaQuery.data ? (
              <div className="mb-2 text-[11px] text-slate-500">
                endpoints:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.endpoint}
                  {wizardSchemaQuery.data.json_endpoint
                    ? ` · ${wizardSchemaQuery.data.json_endpoint}`
                    : ""}
                </span>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={wizardScenario}
                onChange={(event) => setWizardScenario(event.target.value)}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
              >
                {(wizardScenariosQuery.data ?? []).map((scenarioInfo) => (
                  <option key={scenarioInfo.scenario} value={scenarioInfo.scenario}>
                    {scenarioInfo.scenario}
                  </option>
                ))}
              </select>
              <input
                value={wizardWorkbookName}
                onChange={(event) => setWizardWorkbookName(event.target.value)}
                className="w-40 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
                placeholder="Workbook name"
              />
              <label className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={wizardIncludeFileBase64}
                  onChange={(event) =>
                    setWizardIncludeFileBase64(event.target.checked)
                  }
                  className="h-3.5 w-3.5 accent-teal-400"
                />
                include export file in response
              </label>
              <label className="cursor-pointer rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-800">
                {wizardFile ? wizardFile.name : "Attach .xlsx (optional)"}
                <input
                  type="file"
                  accept=".xlsx"
                  className="hidden"
                  onChange={(event) => {
                    setWizardFile(event.target.files?.[0] ?? null);
                  }}
                />
              </label>
              {wizardFile ? (
                <button
                  onClick={() => setWizardFile(null)}
                  className="rounded border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Clear file
                </button>
              ) : null}
              <button
                onClick={handleWizardRun}
                disabled={
                  isRunningWizard ||
                  (wizardScenariosQuery.data ?? []).length === 0
                }
                className="rounded bg-teal-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-400 disabled:opacity-40"
              >
                {isRunningWizard ? "Running wizard..." : "Run Wizard"}
              </button>
              <button
                onClick={handleRunSelectedScenarioOnCurrentWorkbook}
                disabled={
                  !workbook ||
                  isRunningSelectedScenario ||
                  (wizardScenariosQuery.data ?? []).length === 0
                }
                className="rounded bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-400 disabled:opacity-40"
              >
                {isRunningSelectedScenario
                  ? "Running in workbook..."
                  : "Run in Current Workbook"}
              </button>
              <button
                onClick={handleRunPreviewOperationsOnCurrentWorkbook}
                disabled={
                  !workbook ||
                  wizardScenarioOps.length === 0 ||
                  isRunningPreviewOps
                }
                className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              >
                {isRunningPreviewOps
                  ? "Running preview ops..."
                  : "Run Preview via agent/ops"}
              </button>
            </div>
            {(wizardPresetsQuery.data ?? []).length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {(wizardPresetsQuery.data ?? []).map((presetInfo) => (
                  <span
                    key={presetInfo.preset}
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300"
                    title={presetInfo.description}
                  >
                    preset: {presetInfo.preset}
                  </span>
                ))}
              </div>
            ) : null}
            {wizardScenarioOps.length > 0 ? (
              <div className="mt-2">
                <p className="mb-1 text-[11px] text-slate-500">
                  scenario operation preview
                </p>
                <div className="flex flex-wrap gap-1">
                  {wizardScenarioOps.map((operation, index) => (
                    <span
                      key={`${operation.op_type}-${index}`}
                      className="rounded border border-indigo-500/30 bg-indigo-500/15 px-2 py-0.5 text-[11px] text-indigo-100"
                    >
                      {index + 1}. {operation.op_type}
                    </span>
                  ))}
                </div>
                <details className="mt-2 rounded border border-slate-800 bg-slate-900 p-2">
                  <summary className="cursor-pointer text-[11px] text-slate-400">
                    Show operation JSON payload
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-slate-300">
                    {JSON.stringify(wizardScenarioOps, null, 2)}
                  </pre>
                </details>
              </div>
            ) : null}
          </div>
        </header>

        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="rounded bg-slate-800 px-2 py-1 font-mono">
              {selectedAddress}
            </span>
            <input
              value={formulaInput}
              onChange={(event) => setFormulaInput(event.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-400"
              placeholder="Type value or formula (=SUM(A1:B2))"
            />
            <button
              disabled={isSaving || !workbook}
              onClick={handleSaveFormula}
              className="rounded-md bg-indigo-500 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-40"
            >
              {isSaving ? "Saving..." : "Apply"}
            </button>
          </div>
          <div className="overflow-auto rounded-lg border border-slate-800">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-800 text-slate-200">
                  <th className="sticky left-0 border-b border-slate-700 px-2 py-1 text-left">
                    #
                  </th>
                  {Array.from({ length: TOTAL_COLS }, (_, index) => (
                    <th
                      key={index}
                      className="min-w-28 border-b border-l border-slate-700 px-2 py-1 text-left"
                    >
                      {indexToColumn(index + 1)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: TOTAL_ROWS }, (_, rowIndex) => {
                  const row = rowIndex + 1;
                  return (
                    <tr key={row} className="odd:bg-slate-900 even:bg-slate-900/60">
                      <th className="sticky left-0 border-t border-slate-800 bg-slate-800 px-2 py-1 text-left text-slate-300">
                        {row}
                      </th>
                      {Array.from({ length: TOTAL_COLS }, (_, colIndex) => {
                        const col = colIndex + 1;
                        const address = buildAddress(row, col);
                        const cell = cellsByAddress[address];
                        const displayValue =
                          cell?.evaluated_value ?? cell?.raw_value ?? cell?.formula ?? "";
                        const isSelected = selectedAddress === address;
                        return (
                          <td
                            key={address}
                            onClick={() => setSelectedAddress(address)}
                            className={`cursor-pointer border-t border-l border-slate-800 px-2 py-1 font-mono text-xs transition ${
                              isSelected
                                ? "bg-indigo-500/30 text-indigo-100 ring-1 ring-inset ring-indigo-300"
                                : "text-slate-200 hover:bg-slate-800/40"
                            }`}
                          >
                            {displayValue}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {(agentSchemaQuery.data || lastAgentOps.length > 0) && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-200">
                Agent Integration Details
              </h2>
              {agentSchemaQuery.data ? (
                <span className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-300">
                  endpoint: {agentSchemaQuery.data.endpoint}
                </span>
              ) : null}
            </div>
            {agentSchemaQuery.data ? (
              <p className="mb-2 text-xs text-slate-400">
                Supported ops:{" "}
                <span className="font-mono text-slate-200">
                  {Object.keys(agentSchemaQuery.data.operation_payloads).join(", ")}
                </span>
              </p>
            ) : null}
            {lastPreset && (
              <p className="mb-2 text-xs text-slate-400">
                preset: <span className="font-mono text-slate-200">{lastPreset}</span>
              </p>
            )}
            {lastScenario && (
              <p className="mb-2 text-xs text-slate-400">
                scenario:{" "}
                <span className="font-mono text-slate-200">{lastScenario}</span>
              </p>
            )}
            {lastWizardImportSummary && (
              <div className="mb-2 text-xs text-slate-400">
                wizard import:{" "}
                <span className="font-mono text-slate-200">
                  {lastWizardImportSummary.sheetsImported} sheets /{" "}
                  {lastWizardImportSummary.cellsImported} cells
                </span>
                {lastWizardImportSummary.warnings.length > 0 ? (
                  <ul className="mt-1 list-disc pl-4 text-amber-200">
                    {lastWizardImportSummary.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
            {lastAgentRequestId && (
              <p className="mb-2 text-xs text-slate-400">
                request_id:{" "}
                <span className="font-mono text-slate-200">{lastAgentRequestId}</span>
              </p>
            )}
            {lastAgentOps.length ? (
              <div className="overflow-auto rounded-lg border border-slate-800 bg-slate-950">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-900 text-slate-300">
                      <th className="px-2 py-2 text-left">#</th>
                      <th className="px-2 py-2 text-left">Operation</th>
                      <th className="px-2 py-2 text-left">Status</th>
                      <th className="px-2 py-2 text-left">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lastAgentOps.map((result) => (
                      <tr key={`${result.op_index}-${result.op_type}`} className="border-t border-slate-800">
                        <td className="px-2 py-2 font-mono text-slate-400">{result.op_index}</td>
                        <td className="px-2 py-2 text-slate-200">{result.op_type}</td>
                        <td className="px-2 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 ${
                              result.ok
                                ? "bg-emerald-500/20 text-emerald-200"
                                : "bg-rose-500/20 text-rose-200"
                            }`}
                          >
                            {result.ok ? "ok" : "error"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-slate-400">
                          <pre className="whitespace-pre-wrap break-all">
                            {JSON.stringify(result.data)}
                          </pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-500">
                Run an agent operation batch or preset to inspect execution details.
              </p>
            )}
          </section>
        )}

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-200">
                Live Chart Preview (A1:A10 vs B1:B10)
              </h2>
              <button
                onClick={handleChartSync}
                className="rounded-md bg-fuchsia-500 px-3 py-2 text-xs font-medium text-white hover:bg-fuchsia-400"
              >
                Sync Chart Metadata
              </button>
            </div>
            <div className="h-72 rounded-lg border border-slate-800 bg-slate-950 p-3">
              <ChartPreview data={chartData} />
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-200">
                Realtime Event Stream
              </h2>
              <div className="flex items-center gap-2 text-xs">
                <label htmlFor="event-filter" className="text-slate-400">
                  Filter
                </label>
                <select
                  id="event-filter"
                  value={eventFilter}
                  onChange={(event) => setEventFilter(event.target.value)}
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                >
                  {eventTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950">
              {filteredEvents.length === 0 ? (
                <p className="px-3 py-4 text-xs text-slate-500">
                  {eventLog.length === 0
                    ? "Waiting for workbook events..."
                    : "No events match current filter."}
                </p>
              ) : (
                <ul className="divide-y divide-slate-800 text-xs">
                  {filteredEvents.map((event) => (
                    <li key={`${event.seq}-${event.timestamp}`} className="px-3 py-2">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="rounded-full border border-indigo-400/40 bg-indigo-500/15 px-2 py-0.5 font-medium text-indigo-200">
                          {event.event_type}
                        </span>
                        <span className="font-mono text-slate-400">
                          #{event.seq}
                        </span>
                      </div>
                      <p className="text-slate-400">
                        actor: {event.actor} ·{" "}
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </p>
                      <pre className="mt-1 overflow-hidden text-ellipsis whitespace-pre-wrap text-[11px] text-slate-300">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
