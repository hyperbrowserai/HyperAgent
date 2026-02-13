"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  clearAgentOpsCache,
  createSheet,
  createWorkbook,
  exportWorkbook,
  getAgentOpsCacheEntryDetail,
  getAgentOpsCacheEntries,
  getAgentOpsCachePrefixes,
  getAgentOpsCacheStats,
  getAgentPresetOperations,
  getAgentSchema,
  getAgentPresets,
  getAgentScenarioOperations,
  getAgentScenarios,
  getWizardPresets,
  getWizardPresetOperations,
  getWizardScenarioOperations,
  getWizardSchema,
  getWizardScenarios,
  getCells,
  getWorkbook,
  importWorkbook,
  previewAgentOps,
  previewRemoveAgentOpsCacheEntriesByPrefix,
  replayAgentOpsCacheEntry,
  reexecuteAgentOpsCacheEntry,
  removeAgentOpsCacheEntry,
  removeAgentOpsCacheEntriesByPrefix,
  runAgentOps,
  runAgentPreset,
  runAgentScenario,
  runAgentWizard,
  SpreadsheetApiError,
  subscribeToWorkbookEvents,
  upsertChart,
} from "@/lib/spreadsheet-api";
import { buildAddress, indexToColumn, TOTAL_COLS, TOTAL_ROWS } from "@/lib/cell-address";
import { useWorkbookStore } from "@/store/workbook-store";
import {
  AgentOpsCacheEntryDetailResponse,
  AgentOperationPreview,
  AgentOperationResult,
} from "@/types/spreadsheet";

const ChartPreview = dynamic(
  () => import("@/components/chart-preview").then((module) => module.ChartPreview),
  {
    ssr: false,
  },
);

const CACHE_ENTRIES_PREVIEW_LIMIT = 6;

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
  const [isRunningSelectedPreset, setIsRunningSelectedPreset] = useState(false);
  const [isRunningPresetPreviewOps, setIsRunningPresetPreviewOps] = useState(false);
  const [isCopyingPresetOpsRunPayload, setIsCopyingPresetOpsRunPayload] = useState(false);
  const [isCopyingScenarioOpsRunPayload, setIsCopyingScenarioOpsRunPayload] = useState(false);
  const [isCopyingPresetRunPayload, setIsCopyingPresetRunPayload] = useState(false);
  const [isCopyingScenarioRunPayload, setIsCopyingScenarioRunPayload] = useState(false);
  const [isCopyingPresetOps, setIsCopyingPresetOps] = useState(false);
  const [isCopyingPreviewOps, setIsCopyingPreviewOps] = useState(false);
  const [isRunningWizard, setIsRunningWizard] = useState(false);
  const [isCreatingSheet, setIsCreatingSheet] = useState(false);
  const [newSheetName, setNewSheetName] = useState("Sheet2");
  const [wizardScenario, setWizardScenario] = useState("seed_then_export");
  const [wizardPresetPreview, setWizardPresetPreview] = useState("export_snapshot");
  const [wizardIncludeFileBase64, setWizardIncludeFileBase64] = useState(false);
  const [wizardWorkbookName, setWizardWorkbookName] = useState("Wizard Workbook");
  const [wizardFile, setWizardFile] = useState<File | null>(null);
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [uiError, setUiError] = useState<string | null>(null);
  const [uiErrorCode, setUiErrorCode] = useState<string | null>(null);
  const [uiNotice, setUiNotice] = useState<string | null>(null);
  const [lastAgentRequestId, setLastAgentRequestId] = useState<string | null>(null);
  const [lastPreset, setLastPreset] = useState<string | null>(null);
  const [lastScenario, setLastScenario] = useState<string | null>(null);
  const [lastOperationsSignature, setLastOperationsSignature] = useState<string | null>(null);
  const [lastServedFromCache, setLastServedFromCache] = useState<boolean | null>(null);
  const [lastExecutedOperations, setLastExecutedOperations] = useState<
    AgentOperationPreview[]
  >([]);
  const [isCopyingLastExecutionPayload, setIsCopyingLastExecutionPayload] =
    useState(false);
  const [isReplayingLastRequest, setIsReplayingLastRequest] = useState(false);
  const [replayingCacheRequestId, setReplayingCacheRequestId] = useState<string | null>(null);
  const [reexecutingCacheRequestId, setReexecutingCacheRequestId] = useState<string | null>(
    null,
  );
  const [inspectingCacheRequestId, setInspectingCacheRequestId] = useState<string | null>(null);
  const [isClearingOpsCache, setIsClearingOpsCache] = useState(false);
  const [copyingCacheRequestId, setCopyingCacheRequestId] = useState<string | null>(null);
  const [copyingCacheOpsPayloadRequestId, setCopyingCacheOpsPayloadRequestId] = useState<
    string | null
  >(null);
  const [isCopyingCacheDetailJson, setIsCopyingCacheDetailJson] = useState(false);
  const [isCopyingCacheDetailOperations, setIsCopyingCacheDetailOperations] =
    useState(false);
  const [isPreviewingCacheByPrefix, setIsPreviewingCacheByPrefix] = useState(false);
  const [isRemovingCacheByPrefix, setIsRemovingCacheByPrefix] = useState(false);
  const [removingCacheRequestId, setRemovingCacheRequestId] = useState<string | null>(null);
  const [cacheEntriesOffset, setCacheEntriesOffset] = useState(0);
  const [cacheRequestIdPrefix, setCacheRequestIdPrefix] = useState("");
  const [cacheRerunRequestId, setCacheRerunRequestId] = useState("");
  const [cachePrefixRemovalPreview, setCachePrefixRemovalPreview] = useState<{
    requestIdPrefix: string;
    matchedEntries: number;
    sampleRequestIds: string[];
  } | null>(null);
  const [selectedCacheEntryDetail, setSelectedCacheEntryDetail] = useState<
    AgentOpsCacheEntryDetailResponse | null
  >(null);
  const [lastAgentOps, setLastAgentOps] = useState<AgentOperationResult[]>([]);
  const [lastWizardImportSummary, setLastWizardImportSummary] = useState<{
    sheetsImported: number;
    cellsImported: number;
    warnings: string[];
  } | null>(null);

  const createWorkbookMutation = useMutation({
    mutationFn: () => createWorkbook("Agent Workbook"),
    onSuccess: (createdWorkbook) => {
      clearUiError();
      setWorkbook(createdWorkbook);
      setNotice(`Created workbook ${createdWorkbook.name}.`);
      setLastAgentRequestId(null);
      setLastPreset(null);
      setLastScenario(null);
      setLastOperationsSignature(null);
      setLastServedFromCache(null);
      setLastExecutedOperations([]);
      setLastAgentOps([]);
      setLastWizardImportSummary(null);
    },
    onError: (error) => {
      applyUiError(error, "Failed to create workbook.");
    },
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => importWorkbook(file),
    onSuccess: (importedWorkbook) => {
      clearUiError();
      setWorkbook(importedWorkbook);
      setNotice(`Imported workbook ${importedWorkbook.name}.`);
      setLastAgentRequestId(null);
      setLastPreset(null);
      setLastScenario(null);
      setLastOperationsSignature(null);
      setLastServedFromCache(null);
      setLastExecutedOperations([]);
      setLastAgentOps([]);
      setLastWizardImportSummary(null);
      queryClient.invalidateQueries({ queryKey: ["cells", importedWorkbook.id] });
    },
    onError: (error) => {
      applyUiError(error, "Failed to import workbook.");
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

  const agentOpsCacheQuery = useQuery({
    queryKey: ["agent-ops-cache", workbook?.id],
    enabled: Boolean(workbook?.id),
    queryFn: () => getAgentOpsCacheStats(workbook!.id),
  });

  const agentOpsCacheEntriesQuery = useQuery({
    queryKey: [
      "agent-ops-cache-entries",
      workbook?.id,
      cacheRequestIdPrefix,
      cacheEntriesOffset,
      CACHE_ENTRIES_PREVIEW_LIMIT,
    ],
    enabled: Boolean(workbook?.id),
    queryFn: () =>
      getAgentOpsCacheEntries(
        workbook!.id,
        CACHE_ENTRIES_PREVIEW_LIMIT,
        cacheEntriesOffset,
        cacheRequestIdPrefix,
      ),
  });

  const agentOpsCachePrefixesQuery = useQuery({
    queryKey: ["agent-ops-cache-prefixes", workbook?.id],
    enabled: Boolean(workbook?.id),
    queryFn: () => getAgentOpsCachePrefixes(workbook!.id, 12),
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

  const wizardPresetOpsQuery = useQuery({
    queryKey: ["wizard-preset-ops", workbook?.id, wizardPresetPreview, wizardIncludeFileBase64],
    enabled: wizardPresetPreview.length > 0,
    queryFn: () =>
      workbook?.id
        ? getAgentPresetOperations(
            workbook.id,
            wizardPresetPreview,
            wizardIncludeFileBase64,
          )
        : getWizardPresetOperations(wizardPresetPreview, wizardIncludeFileBase64),
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
    setCacheEntriesOffset(0);
    setSelectedCacheEntryDetail(null);
    setCacheRerunRequestId("");
    setCachePrefixRemovalPreview(null);
  }, [workbook?.id]);

  useEffect(() => {
    setCacheEntriesOffset(0);
    setCachePrefixRemovalPreview(null);
  }, [cacheRequestIdPrefix]);

  useEffect(() => {
    if (
      cacheEntriesOffset > 0
      && agentOpsCacheEntriesQuery.data
      && agentOpsCacheEntriesQuery.data.entries.length === 0
    ) {
      setCacheEntriesOffset((previousOffset) =>
        Math.max(0, previousOffset - CACHE_ENTRIES_PREVIEW_LIMIT),
      );
    }
  }, [agentOpsCacheEntriesQuery.data, cacheEntriesOffset]);

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
      queryClient.invalidateQueries({ queryKey: ["agent-ops-cache", workbook.id] });
      queryClient.invalidateQueries({
        queryKey: ["agent-ops-cache-entries", workbook.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["agent-ops-cache-prefixes", workbook.id],
      });
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

  useEffect(() => {
    if (!wizardPresetsQuery.data?.length) {
      return;
    }
    const hasSelectedPreset = wizardPresetsQuery.data.some(
      (presetInfo) => presetInfo.preset === wizardPresetPreview,
    );
    if (hasSelectedPreset) {
      return;
    }
    setWizardPresetPreview(wizardPresetsQuery.data[0].preset);
  }, [wizardPresetPreview, wizardPresetsQuery.data]);

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
  const wizardScenarioOps = wizardScenarioOpsQuery.data?.operations ?? [];
  const wizardScenarioOpsSignature =
    wizardScenarioOpsQuery.data?.operations_signature ?? null;
  const wizardPresetOps = wizardPresetOpsQuery.data?.operations ?? [];
  const wizardPresetOpsSignature =
    wizardPresetOpsQuery.data?.operations_signature ?? null;
  const wizardPreviewSource = workbook ? "workbook-scoped" : "global";
  const cachePrefixSuggestions = agentOpsCachePrefixesQuery.data?.prefixes ?? [];
  const scenarioSignatureStatus =
    lastScenario === wizardScenario &&
    lastOperationsSignature &&
    wizardScenarioOpsSignature
      ? lastOperationsSignature === wizardScenarioOpsSignature
        ? "in-sync"
        : "stale"
      : null;
  const presetSignatureStatus =
    lastPreset === wizardPresetPreview &&
    lastOperationsSignature &&
    wizardPresetOpsSignature
      ? lastOperationsSignature === wizardPresetOpsSignature
        ? "in-sync"
        : "stale"
      : null;

  const statusText =
    createWorkbookMutation.isPending || importMutation.isPending
      ? "Initializing workbook..."
      : cellsQuery.isFetching || workbookQuery.isFetching
        ? "Syncing updates..."
        : "Ready";

  function applyUiError(error: unknown, fallback: string): void {
    setUiNotice(null);
    if (error instanceof SpreadsheetApiError) {
      setUiError(error.message);
      setUiErrorCode(error.code ?? null);
      return;
    }
    if (error instanceof Error) {
      setUiError(error.message);
      setUiErrorCode(null);
      return;
    }
    setUiError(fallback);
    setUiErrorCode(null);
  }

  function clearUiError(): void {
    setUiError(null);
    setUiErrorCode(null);
    setUiNotice(null);
  }

  function setNotice(message: string | null): void {
    setUiNotice(message);
  }

  async function handleSignatureMismatchRecovery(error: unknown): Promise<boolean> {
    if (error instanceof SpreadsheetApiError) {
      if (error.code === "EMPTY_OPERATION_LIST") {
        setUiError("No operations were provided. Refresh previews and retry.");
        setUiErrorCode(error.code);
        return true;
      }
      if (error.code === "INVALID_SIGNATURE_FORMAT") {
        setUiError(
          `${error.message} Refresh previews to regenerate a valid signature and retry.`,
        );
        setUiErrorCode(error.code);
        return true;
      }
      if (error.code === "REQUEST_ID_CONFLICT") {
        setUiError(
          `${error.message} Use a new request_id or replay the original operation plan.`,
        );
        setUiErrorCode(error.code);
        return true;
      }
      if (error.code !== "OPERATION_SIGNATURE_MISMATCH") {
        return false;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["wizard-scenario-ops"] }),
        queryClient.invalidateQueries({ queryKey: ["wizard-preset-ops"] }),
      ]);
      setUiError(`${error.message} Refreshed operation previews. Please retry.`);
      setUiErrorCode(error.code);
      return true;
    }
    const maybeMessage = error instanceof Error ? error.message : null;
    const message = maybeMessage ?? "";
    if (!message.includes("Operation signature mismatch")) {
      return false;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["wizard-scenario-ops"] }),
      queryClient.invalidateQueries({ queryKey: ["wizard-preset-ops"] }),
    ]);
    setUiError(`${message} Refreshed operation previews. Please retry.`);
    setUiErrorCode(null);
    return true;
  }

  async function signOperationsForExecution(
    operations: AgentOperationPreview[],
  ): Promise<{ operationsSignature: string; operations: AgentOperationPreview[] }> {
    if (!workbook) {
      throw new Error("A workbook is required to sign operations.");
    }
    const preview = await previewAgentOps(workbook.id, operations);
    return {
      operationsSignature: preview.operations_signature,
      operations: preview.operations,
    };
  }

  async function refreshWorkbookRunQueries(
    workbookId: string,
    sheetName: string,
    includeAgentOpsCache: boolean = true,
  ): Promise<void> {
    const tasks: Array<Promise<unknown>> = [
      queryClient.invalidateQueries({
        queryKey: ["cells", workbookId, sheetName],
      }),
    ];
    if (includeAgentOpsCache) {
      tasks.push(
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache", workbookId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-entries", workbookId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-prefixes", workbookId],
        }),
      );
    }
    await Promise.all(tasks);
  }

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
      clearUiError();
      const isFormula = formulaInput.trim().startsWith("=");
      const operations: AgentOperationPreview[] = [
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
      ];
      const signedPlan = await signOperationsForExecution(operations);
      const response = await runAgentOps(workbook.id, {
        request_id: `formula-${Date.now()}`,
        actor: "ui-formula-bar",
        stop_on_error: true,
        expected_operations_signature: signedPlan.operationsSignature,
        operations: signedPlan.operations,
      });
      setLastExecutedOperations(signedPlan.operations);
      setLastAgentRequestId(response.request_id ?? null);
      setLastOperationsSignature(response.operations_signature ?? null);
      setLastServedFromCache(response.served_from_cache ?? null);
      setLastAgentOps(response.results);
      setLastPreset(null);
      setLastScenario(null);
      setLastWizardImportSummary(null);
      await refreshWorkbookRunQueries(workbook.id, activeSheet);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, "Failed to apply cell update.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleExport() {
    if (!workbook) {
      return;
    }
    try {
      clearUiError();
      const blob = await exportWorkbook(workbook.id);
      const fileUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = fileUrl;
      anchor.download = `${workbook.name}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(fileUrl);
    } catch (error) {
      applyUiError(error, "Failed to export workbook.");
    }
  }

  async function handleChartSync() {
    if (!workbook) {
      return;
    }
    try {
      clearUiError();
      await upsertChart(workbook.id, {
        id: "chart-default",
        sheet: activeSheet,
        chart_type: "bar",
        title: "Column B by Column A",
        categories_range: `${activeSheet}!$A$1:$A$10`,
        values_range: `${activeSheet}!$B$1:$B$10`,
      });
    } catch (error) {
      applyUiError(error, "Failed to sync chart metadata.");
    }
  }

  async function handleAgentDemoFlow() {
    if (!workbook) {
      return;
    }
    setIsRunningAgentFlow(true);
    try {
      clearUiError();
      const operations: AgentOperationPreview[] = [
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
      ];
      const signedPlan = await signOperationsForExecution(operations);
      const response = await runAgentOps(workbook.id, {
        request_id: `agent-demo-${Date.now()}`,
        actor: "ui-agent-demo",
        stop_on_error: true,
        expected_operations_signature: signedPlan.operationsSignature,
        operations: signedPlan.operations,
      });
      setLastExecutedOperations(signedPlan.operations);
      setLastAgentRequestId(response.request_id ?? null);
      setLastOperationsSignature(response.operations_signature ?? null);
      setLastServedFromCache(response.served_from_cache ?? null);
      setLastAgentOps(response.results);
      setLastPreset(null);
      setLastScenario(null);
      setLastWizardImportSummary(null);
      await refreshWorkbookRunQueries(workbook.id, activeSheet);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, "Failed to run agent demo flow.");
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
      clearUiError();
      const includeFileBase64 =
        preset === "export_snapshot" ? false : wizardIncludeFileBase64;
      const presetPlan = await getAgentPresetOperations(
        workbook.id,
        preset,
        includeFileBase64,
      );
      const response = await runAgentPreset(workbook.id, preset, {
        request_id: `preset-${preset}-${Date.now()}`,
        actor: "ui-preset",
        stop_on_error: true,
        include_file_base64: includeFileBase64,
        expected_operations_signature: presetPlan.operations_signature,
      });
      setLastPreset(response.preset);
      setLastScenario(null);
      setLastOperationsSignature(response.operations_signature ?? null);
      setLastServedFromCache(null);
      setLastExecutedOperations(presetPlan.operations);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await refreshWorkbookRunQueries(workbook.id, activeSheet);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, `Failed to run preset ${preset}.`);
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
      clearUiError();
      const scenarioPlan = await getAgentScenarioOperations(
        workbook.id,
        scenario,
        false,
      );
      const response = await runAgentScenario(workbook.id, scenario, {
        request_id: `scenario-${scenario}-${Date.now()}`,
        actor: "ui-scenario",
        stop_on_error: true,
        include_file_base64: false,
        expected_operations_signature: scenarioPlan.operations_signature,
      });
      setLastScenario(response.scenario);
      setLastPreset(null);
      setLastOperationsSignature(response.operations_signature ?? null);
      setLastServedFromCache(null);
      setLastExecutedOperations(scenarioPlan.operations);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await refreshWorkbookRunQueries(workbook.id, activeSheet);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, `Failed to run scenario ${scenario}.`);
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
      clearUiError();
      const scenarioPlan = await getAgentScenarioOperations(
        workbook.id,
        wizardScenario,
        wizardIncludeFileBase64,
      );
      const response = await runAgentScenario(workbook.id, wizardScenario, {
        request_id: `scenario-selected-${wizardScenario}-${Date.now()}`,
        actor: "ui-scenario-selected",
        stop_on_error: true,
        include_file_base64: wizardIncludeFileBase64,
        expected_operations_signature: scenarioPlan.operations_signature,
      });
      setLastScenario(response.scenario);
      setLastPreset(null);
      setLastOperationsSignature(response.operations_signature ?? null);
      setLastServedFromCache(null);
      setLastExecutedOperations(scenarioPlan.operations);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await refreshWorkbookRunQueries(workbook.id, activeSheet);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, `Failed to run selected scenario ${wizardScenario}.`);
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
      clearUiError();
      const signedPlan = await signOperationsForExecution(wizardScenarioOps);
      const response = await runAgentOps(workbook.id, {
        request_id: `scenario-preview-ops-${wizardScenario}-${Date.now()}`,
        actor: "ui-scenario-preview-ops",
        stop_on_error: true,
        expected_operations_signature: signedPlan.operationsSignature,
        operations: signedPlan.operations,
      });
      setLastScenario(wizardScenario);
      setLastPreset(null);
      setLastOperationsSignature(response.operations_signature ?? null);
      setLastServedFromCache(response.served_from_cache ?? null);
      setLastExecutedOperations(signedPlan.operations);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await refreshWorkbookRunQueries(workbook.id, activeSheet);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, `Failed to run preview operations for ${wizardScenario}.`);
    } finally {
      setIsRunningPreviewOps(false);
    }
  }

  async function handleRunSelectedPresetOnCurrentWorkbook() {
    if (!workbook || !wizardPresetPreview) {
      return;
    }
    setIsRunningSelectedPreset(true);
    try {
      clearUiError();
      const presetPlan = await getAgentPresetOperations(
        workbook.id,
        wizardPresetPreview,
        wizardIncludeFileBase64,
      );
      const response = await runAgentPreset(workbook.id, wizardPresetPreview, {
        request_id: `preset-selected-${wizardPresetPreview}-${Date.now()}`,
        actor: "ui-preset-selected",
        stop_on_error: true,
        include_file_base64: wizardIncludeFileBase64,
        expected_operations_signature: presetPlan.operations_signature,
      });
      setLastPreset(response.preset);
      setLastScenario(null);
      setLastOperationsSignature(response.operations_signature ?? null);
      setLastServedFromCache(null);
      setLastExecutedOperations(presetPlan.operations);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await refreshWorkbookRunQueries(workbook.id, activeSheet);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, `Failed to run selected preset ${wizardPresetPreview}.`);
    } finally {
      setIsRunningSelectedPreset(false);
    }
  }

  async function handleRunPresetPreviewOperationsOnCurrentWorkbook() {
    if (!workbook || wizardPresetOps.length === 0) {
      return;
    }
    setIsRunningPresetPreviewOps(true);
    try {
      clearUiError();
      const signedPlan = await signOperationsForExecution(wizardPresetOps);
      const response = await runAgentOps(workbook.id, {
        request_id: `preset-preview-ops-${wizardPresetPreview}-${Date.now()}`,
        actor: "ui-preset-preview-ops",
        stop_on_error: true,
        expected_operations_signature: signedPlan.operationsSignature,
        operations: signedPlan.operations,
      });
      setLastPreset(wizardPresetPreview);
      setLastScenario(null);
      setLastOperationsSignature(response.operations_signature ?? null);
      setLastServedFromCache(response.served_from_cache ?? null);
      setLastExecutedOperations(signedPlan.operations);
      setLastAgentRequestId(response.request_id ?? null);
      setLastAgentOps(response.results);
      setLastWizardImportSummary(null);
      await refreshWorkbookRunQueries(workbook.id, activeSheet);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(
        error,
        `Failed to run preset preview operations for ${wizardPresetPreview}.`,
      );
    } finally {
      setIsRunningPresetPreviewOps(false);
    }
  }

  async function handleCopyPreviewOperations() {
    if (wizardScenarioOps.length === 0) {
      return;
    }
    setIsCopyingPreviewOps(true);
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            operations_signature: wizardScenarioOpsSignature,
            operations: wizardScenarioOps,
          },
          null,
          2,
        ),
      );
      clearUiError();
    } catch (error) {
      applyUiError(error, "Failed to copy preview operations to clipboard.");
    } finally {
      setIsCopyingPreviewOps(false);
    }
  }

  async function handleCopyPresetOperations() {
    if (wizardPresetOps.length === 0) {
      return;
    }
    setIsCopyingPresetOps(true);
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            operations_signature: wizardPresetOpsSignature,
            operations: wizardPresetOps,
          },
          null,
          2,
        ),
      );
      clearUiError();
    } catch (error) {
      applyUiError(error, "Failed to copy preset operations to clipboard.");
    } finally {
      setIsCopyingPresetOps(false);
    }
  }

  async function handleCopyPresetRunPayload() {
    if (!wizardPresetPreview) {
      return;
    }
    setIsCopyingPresetRunPayload(true);
    try {
      const plan = workbook
        ? await getAgentPresetOperations(
            workbook.id,
            wizardPresetPreview,
            wizardIncludeFileBase64,
          )
        : await getWizardPresetOperations(
            wizardPresetPreview,
            wizardIncludeFileBase64,
          );
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            request_id: "replace-with-request-id",
            actor: "agent",
            stop_on_error: true,
            include_file_base64: wizardIncludeFileBase64,
            expected_operations_signature: plan.operations_signature,
          },
          null,
          2,
        ),
      );
      clearUiError();
    } catch (error) {
      applyUiError(error, "Failed to copy preset run payload to clipboard.");
    } finally {
      setIsCopyingPresetRunPayload(false);
    }
  }

  async function handleCopyScenarioRunPayload() {
    if (!wizardScenario) {
      return;
    }
    setIsCopyingScenarioRunPayload(true);
    try {
      const plan = workbook
        ? await getAgentScenarioOperations(
            workbook.id,
            wizardScenario,
            wizardIncludeFileBase64,
          )
        : await getWizardScenarioOperations(
            wizardScenario,
            wizardIncludeFileBase64,
          );
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            request_id: "replace-with-request-id",
            actor: "agent",
            stop_on_error: true,
            include_file_base64: wizardIncludeFileBase64,
            expected_operations_signature: plan.operations_signature,
          },
          null,
          2,
        ),
      );
      clearUiError();
    } catch (error) {
      applyUiError(error, "Failed to copy scenario run payload to clipboard.");
    } finally {
      setIsCopyingScenarioRunPayload(false);
    }
  }

  async function handleCopyPresetOpsRunPayload() {
    if (wizardPresetOps.length === 0) {
      return;
    }
    setIsCopyingPresetOpsRunPayload(true);
    try {
      let operationSignature = wizardPresetOpsSignature;
      if (workbook) {
        const preview = await previewAgentOps(workbook.id, wizardPresetOps);
        operationSignature = preview.operations_signature;
      }
      if (!operationSignature) {
        throw new Error("Operation signature unavailable for payload copy.");
      }
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            request_id: "replace-with-request-id",
            actor: "agent",
            stop_on_error: true,
            expected_operations_signature: operationSignature,
            operations: wizardPresetOps,
          },
          null,
          2,
        ),
      );
      clearUiError();
    } catch (error) {
      applyUiError(error, "Failed to copy agent/ops payload for preset preview.");
    } finally {
      setIsCopyingPresetOpsRunPayload(false);
    }
  }

  async function handleCopyScenarioOpsRunPayload() {
    if (wizardScenarioOps.length === 0) {
      return;
    }
    setIsCopyingScenarioOpsRunPayload(true);
    try {
      let operationSignature = wizardScenarioOpsSignature;
      if (workbook) {
        const preview = await previewAgentOps(workbook.id, wizardScenarioOps);
        operationSignature = preview.operations_signature;
      }
      if (!operationSignature) {
        throw new Error("Operation signature unavailable for payload copy.");
      }
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            request_id: "replace-with-request-id",
            actor: "agent",
            stop_on_error: true,
            expected_operations_signature: operationSignature,
            operations: wizardScenarioOps,
          },
          null,
          2,
        ),
      );
      clearUiError();
    } catch (error) {
      applyUiError(error, "Failed to copy agent/ops payload for scenario preview.");
    } finally {
      setIsCopyingScenarioOpsRunPayload(false);
    }
  }

  async function handleCopyLastExecutionOpsPayload() {
    if (!workbook || lastExecutedOperations.length === 0) {
      return;
    }
    setIsCopyingLastExecutionPayload(true);
    try {
      const preview = await previewAgentOps(workbook.id, lastExecutedOperations);
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            request_id: "replace-with-request-id",
            actor: "agent",
            stop_on_error: true,
            expected_operations_signature: preview.operations_signature,
            operations: preview.operations,
          },
          null,
          2,
        ),
      );
      clearUiError();
    } catch (error) {
      applyUiError(error, "Failed to copy payload from last execution plan.");
    } finally {
      setIsCopyingLastExecutionPayload(false);
    }
  }

  async function handleReplayLastRequestId() {
    if (!workbook || !lastAgentRequestId) {
      return;
    }
    setIsReplayingLastRequest(true);
    try {
      clearUiError();
      const response = await replayAgentOpsCacheEntry(
        workbook.id,
        lastAgentRequestId,
      );
      setLastExecutedOperations(response.operations);
      setLastOperationsSignature(
        response.cached_response.operations_signature ?? null,
      );
      setLastServedFromCache(response.cached_response.served_from_cache ?? null);
      setLastAgentOps(response.cached_response.results);
      setNotice(
        response.cached_response.served_from_cache
          ? "Replay served from idempotency cache."
          : "Replay executed fresh (cache miss).",
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-entries", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-prefixes", workbook.id],
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, "Failed to replay last request.");
    } finally {
      setIsReplayingLastRequest(false);
    }
  }

  async function handleClearAgentOpsCache() {
    if (!workbook) {
      return;
    }
    setIsClearingOpsCache(true);
    try {
      clearUiError();
      const response = await clearAgentOpsCache(workbook.id);
      setCacheEntriesOffset(0);
      setSelectedCacheEntryDetail(null);
      setNotice(`Cleared ${response.cleared_entries} cached request entries.`);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-entries", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-prefixes", workbook.id],
        }),
      ]);
    } catch (error) {
      applyUiError(error, "Failed to clear agent ops idempotency cache.");
    } finally {
      setIsClearingOpsCache(false);
    }
  }

  async function handleCopyCacheRequestId(requestId: string) {
    setCopyingCacheRequestId(requestId);
    try {
      clearUiError();
      await navigator.clipboard.writeText(requestId);
      setNotice(`Copied request_id ${requestId} to clipboard.`);
    } catch (error) {
      applyUiError(error, "Failed to copy cache request id.");
    } finally {
      setCopyingCacheRequestId(null);
    }
  }

  async function handleCopyCacheEntryAsOpsPayload(requestId: string) {
    if (!workbook) {
      return;
    }
    setCopyingCacheOpsPayloadRequestId(requestId);
    try {
      clearUiError();
      const replay = await replayAgentOpsCacheEntry(workbook.id, requestId);
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            request_id: replay.cached_response.request_id ?? requestId,
            expected_operations_signature:
              replay.cached_response.operations_signature ?? undefined,
            operations: replay.operations,
          },
          null,
          2,
        ),
      );
      setNotice(`Copied agent/ops payload for cached request_id ${requestId}.`);
    } catch (error) {
      applyUiError(error, "Failed to copy cache entry as agent/ops payload.");
    } finally {
      setCopyingCacheOpsPayloadRequestId(null);
    }
  }

  async function handleInspectCacheRequestId(requestId: string) {
    if (!workbook) {
      return;
    }
    setInspectingCacheRequestId(requestId);
    try {
      clearUiError();
      const detail = await getAgentOpsCacheEntryDetail(workbook.id, requestId);
      setSelectedCacheEntryDetail(detail);
    } catch (error) {
      applyUiError(error, "Failed to inspect cached request id.");
    } finally {
      setInspectingCacheRequestId(null);
    }
  }

  async function handleCopySelectedCacheDetail() {
    if (!selectedCacheEntryDetail) {
      return;
    }
    setIsCopyingCacheDetailJson(true);
    try {
      clearUiError();
      await navigator.clipboard.writeText(
        JSON.stringify(selectedCacheEntryDetail, null, 2),
      );
      setNotice(
        `Copied cache detail for request_id ${selectedCacheEntryDetail.request_id}.`,
      );
    } catch (error) {
      applyUiError(error, "Failed to copy cache detail JSON.");
    } finally {
      setIsCopyingCacheDetailJson(false);
    }
  }

  async function handleCopySelectedCacheOperations() {
    if (!selectedCacheEntryDetail) {
      return;
    }
    setIsCopyingCacheDetailOperations(true);
    try {
      clearUiError();
      await navigator.clipboard.writeText(
        JSON.stringify(selectedCacheEntryDetail.operations, null, 2),
      );
      setNotice(
        `Copied operations array for ${selectedCacheEntryDetail.request_id}.`,
      );
    } catch (error) {
      applyUiError(error, "Failed to copy cached operations JSON.");
    } finally {
      setIsCopyingCacheDetailOperations(false);
    }
  }

  async function handleReplayCacheRequestId(requestId: string) {
    if (!workbook) {
      return;
    }
    setReplayingCacheRequestId(requestId);
    try {
      clearUiError();
      const response = await replayAgentOpsCacheEntry(workbook.id, requestId);
      setLastExecutedOperations(response.operations);
      setLastAgentRequestId(response.cached_response.request_id ?? requestId);
      setLastOperationsSignature(
        response.cached_response.operations_signature ?? null,
      );
      setLastServedFromCache(response.cached_response.served_from_cache ?? true);
      setLastAgentOps(response.cached_response.results);
      setNotice(`Replayed cached response for request_id ${requestId}.`);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-entries", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-prefixes", workbook.id],
        }),
      ]);
    } catch (error) {
      applyUiError(error, "Failed to replay cached request id.");
    } finally {
      setReplayingCacheRequestId(null);
    }
  }

  async function handleReexecuteCacheRequestId(requestId: string) {
    if (!workbook) {
      return;
    }
    setReexecutingCacheRequestId(requestId);
    try {
      clearUiError();
      const normalizedNewRequestId = cacheRerunRequestId.trim();
      const reexecute = await reexecuteAgentOpsCacheEntry(workbook.id, {
        request_id: requestId,
        new_request_id: normalizedNewRequestId || undefined,
        actor: "ui-cache-reexecute",
        stop_on_error: true,
      });
      setLastExecutedOperations(reexecute.operations);
      setLastAgentRequestId(reexecute.response.request_id ?? null);
      setLastOperationsSignature(reexecute.operations_signature);
      setLastServedFromCache(reexecute.response.served_from_cache ?? null);
      setLastAgentOps(reexecute.response.results);
      setNotice(
        `Reexecuted ${requestId} as ${reexecute.response.request_id ?? "new request"}${
          reexecute.generated_request_id ? " (auto-generated)" : ""
        }.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-entries", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-prefixes", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["cells", workbook.id, activeSheet],
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, "Failed to reexecute cached request id.");
    } finally {
      setReexecutingCacheRequestId(null);
    }
  }

  async function handleRemoveCacheRequestId(requestId: string) {
    if (!workbook) {
      return;
    }
    setRemovingCacheRequestId(requestId);
    try {
      clearUiError();
      const response = await removeAgentOpsCacheEntry(workbook.id, requestId);
      if (response.removed && selectedCacheEntryDetail?.request_id === requestId) {
        setSelectedCacheEntryDetail(null);
      }
      setNotice(
        response.removed
          ? `Removed cache entry ${response.request_id}.`
          : `No cache entry found for ${response.request_id}.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-entries", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-prefixes", workbook.id],
        }),
      ]);
    } catch (error) {
      applyUiError(error, "Failed to remove cache request id.");
    } finally {
      setRemovingCacheRequestId(null);
    }
  }

  async function handleRemoveCacheEntriesByPrefix() {
    if (!workbook) {
      return;
    }
    const normalizedPrefix = cacheRequestIdPrefix.trim();
    if (!normalizedPrefix) {
      return;
    }
    setIsRemovingCacheByPrefix(true);
    try {
      clearUiError();
      const response = await removeAgentOpsCacheEntriesByPrefix(
        workbook.id,
        normalizedPrefix,
      );
      if (
        response.removed_entries > 0
        && selectedCacheEntryDetail?.request_id.startsWith(normalizedPrefix)
      ) {
        setSelectedCacheEntryDetail(null);
      }
      setCachePrefixRemovalPreview(null);
      setCacheEntriesOffset(0);
      setNotice(
        `Removed ${response.removed_entries} cache entr${
          response.removed_entries === 1 ? "y" : "ies"
        } for prefix ${response.request_id_prefix}.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-entries", workbook.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-ops-cache-prefixes", workbook.id],
        }),
      ]);
    } catch (error) {
      applyUiError(error, "Failed to remove cache entries by prefix.");
    } finally {
      setIsRemovingCacheByPrefix(false);
    }
  }

  async function handlePreviewRemoveCacheEntriesByPrefix() {
    if (!workbook) {
      return;
    }
    const normalizedPrefix = cacheRequestIdPrefix.trim();
    if (!normalizedPrefix) {
      return;
    }
    setIsPreviewingCacheByPrefix(true);
    try {
      clearUiError();
      const preview = await previewRemoveAgentOpsCacheEntriesByPrefix(
        workbook.id,
        normalizedPrefix,
      );
      setCachePrefixRemovalPreview({
        requestIdPrefix: preview.request_id_prefix,
        matchedEntries: preview.matched_entries,
        sampleRequestIds: preview.sample_request_ids,
      });
      setNotice(
        `Previewed ${preview.matched_entries} cache entr${
          preview.matched_entries === 1 ? "y" : "ies"
        } for prefix ${preview.request_id_prefix}.`,
      );
    } catch (error) {
      applyUiError(error, "Failed to preview cache removal by prefix.");
    } finally {
      setIsPreviewingCacheByPrefix(false);
    }
  }

  async function handleWizardRun() {
    if (!wizardScenario) {
      return;
    }
    setIsRunningWizard(true);
    try {
      clearUiError();
      const scenarioPlan = await getWizardScenarioOperations(
        wizardScenario,
        wizardIncludeFileBase64,
      );
      const response = await runAgentWizard({
        scenario: wizardScenario,
        request_id: `wizard-${wizardScenario}-${Date.now()}`,
        actor: "ui-wizard",
        stop_on_error: true,
        include_file_base64: wizardIncludeFileBase64,
        expected_operations_signature: scenarioPlan.operations_signature,
        workbook_name: wizardWorkbookName,
        file: wizardFile,
      });
      setWorkbook(response.workbook);
      setActiveSheet(response.workbook.sheets[0] ?? "Sheet1");
      setLastScenario(response.scenario);
      setLastPreset(null);
      setLastOperationsSignature(response.operations_signature ?? null);
      setLastServedFromCache(null);
      setLastExecutedOperations(scenarioPlan.operations);
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
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, "Failed to run wizard flow.");
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
      clearUiError();
      await createSheet(workbook.id, trimmed);
      setActiveSheet(trimmed);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workbook", workbook.id] }),
        queryClient.invalidateQueries({ queryKey: ["cells", workbook.id, trimmed] }),
      ]);
    } catch (error) {
      applyUiError(error, "Failed to create sheet.");
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
                <div className="flex items-center gap-2">
                  {uiErrorCode ? (
                    <span className="rounded border border-rose-300/40 bg-rose-500/20 px-1.5 py-0.5 font-mono text-[10px] text-rose-100">
                      {uiErrorCode}
                    </span>
                  ) : null}
                  <span>{uiError}</span>
                </div>
                <button
                  onClick={clearUiError}
                  className="rounded border border-rose-300/30 px-2 py-0.5 text-[11px] hover:bg-rose-500/20"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          {uiNotice ? (
            <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-100">
              <div className="flex items-center justify-between gap-2">
                <span>{uiNotice}</span>
                <button
                  onClick={() => setNotice(null)}
                  className="rounded border border-emerald-300/30 px-2 py-0.5 text-[11px] hover:bg-emerald-500/20"
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
                <span className="ml-2 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] text-slate-300">
                  preview source: {wizardPreviewSource}
                </span>
              </div>
            ) : null}
            {wizardSchemaQuery.data?.signature_error_codes?.length ? (
              <p className="mb-2 text-[11px] text-slate-500">
                signature codes:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.signature_error_codes.join(", ")}
                </span>
              </p>
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
            {(wizardPresetsQuery.data ?? []).length > 0 ? (
              <div className="mt-2 rounded border border-slate-800 bg-slate-900 p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                  <p className="text-[11px] text-slate-500">preset operation preview</p>
                  <select
                    value={wizardPresetPreview}
                    onChange={(event) => setWizardPresetPreview(event.target.value)}
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-200"
                  >
                    {(wizardPresetsQuery.data ?? []).map((presetInfo) => (
                      <option key={presetInfo.preset} value={presetInfo.preset}>
                        {presetInfo.preset}
                      </option>
                    ))}
                  </select>
                  </div>
                  <button
                    onClick={handleCopyPresetOperations}
                    disabled={isCopyingPresetOps || wizardPresetOps.length === 0}
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {isCopyingPresetOps ? "Copying..." : "Copy Plan JSON"}
                  </button>
                  <button
                    onClick={handleCopyPresetRunPayload}
                    disabled={
                      isCopyingPresetRunPayload || !wizardPresetPreview
                    }
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {isCopyingPresetRunPayload
                      ? "Copying..."
                      : "Copy Run Payload"}
                  </button>
                  <button
                    onClick={handleCopyPresetOpsRunPayload}
                    disabled={
                      isCopyingPresetOpsRunPayload || wizardPresetOps.length === 0
                    }
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {isCopyingPresetOpsRunPayload
                      ? "Copying..."
                      : "Copy agent/ops Payload"}
                  </button>
                </div>
                {wizardPresetOpsSignature ? (
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span>
                      signature:{" "}
                      <span className="font-mono text-slate-300">
                        {wizardPresetOpsSignature}
                      </span>
                    </span>
                    {presetSignatureStatus ? (
                      <span
                        className={`rounded border px-1.5 py-0.5 ${
                          presetSignatureStatus === "in-sync"
                            ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                            : "border-amber-500/40 bg-amber-500/15 text-amber-200"
                        }`}
                      >
                        {presetSignatureStatus}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {wizardPresetOpsQuery.isFetching ? (
                  <p className="text-[11px] text-slate-500">Loading preset operations…</p>
                ) : wizardPresetOps.length > 0 ? (
                  <div>
                    <div className="flex flex-wrap gap-1">
                      {wizardPresetOps.map((operation, index) => (
                        <span
                          key={`${operation.op_type}-preset-${index}`}
                          className="rounded border border-cyan-500/30 bg-cyan-500/15 px-2 py-0.5 text-[11px] text-cyan-100"
                        >
                          {index + 1}. {operation.op_type}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        onClick={handleRunSelectedPresetOnCurrentWorkbook}
                        disabled={!workbook || isRunningSelectedPreset}
                        className="rounded bg-cyan-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-cyan-400 disabled:opacity-40"
                      >
                        {isRunningSelectedPreset
                          ? "Running preset..."
                          : "Run Preset in Current Workbook"}
                      </button>
                      <button
                        onClick={handleRunPresetPreviewOperationsOnCurrentWorkbook}
                        disabled={
                          !workbook ||
                          wizardPresetOps.length === 0 ||
                          isRunningPresetPreviewOps
                        }
                        className="rounded bg-cyan-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-cyan-600 disabled:opacity-40"
                      >
                        {isRunningPresetPreviewOps
                          ? "Running preset ops..."
                          : "Run Preset Preview via agent/ops"}
                      </button>
                    </div>
                    <details className="mt-2 rounded border border-slate-800 bg-slate-950 p-2">
                      <summary className="cursor-pointer text-[11px] text-slate-400">
                        Show preset operation JSON payload
                      </summary>
                      <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-slate-300">
                        {JSON.stringify(
                          {
                            operations_signature: wizardPresetOpsSignature,
                            operations: wizardPresetOps,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500">
                    No preset operations available for preview.
                  </p>
                )}
              </div>
            ) : null}
            {wizardScenarioOpsQuery.isFetching ? (
              <p className="mt-2 text-[11px] text-slate-500">Loading scenario operations…</p>
            ) : null}
            {wizardScenarioOps.length > 0 ? (
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-slate-500">
                    scenario operation preview
                  </p>
                  <button
                    onClick={handleCopyPreviewOperations}
                    disabled={isCopyingPreviewOps}
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {isCopyingPreviewOps ? "Copying..." : "Copy Plan JSON"}
                  </button>
                  <button
                    onClick={handleCopyScenarioRunPayload}
                    disabled={
                      isCopyingScenarioRunPayload || !wizardScenario
                    }
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {isCopyingScenarioRunPayload
                      ? "Copying..."
                      : "Copy Run Payload"}
                  </button>
                  <button
                    onClick={handleCopyScenarioOpsRunPayload}
                    disabled={
                      isCopyingScenarioOpsRunPayload || wizardScenarioOps.length === 0
                    }
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {isCopyingScenarioOpsRunPayload
                      ? "Copying..."
                      : "Copy agent/ops Payload"}
                  </button>
                </div>
                {wizardScenarioOpsSignature ? (
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span>
                      signature:{" "}
                      <span className="font-mono text-slate-300">
                        {wizardScenarioOpsSignature}
                      </span>
                    </span>
                    {scenarioSignatureStatus ? (
                      <span
                        className={`rounded border px-1.5 py-0.5 ${
                          scenarioSignatureStatus === "in-sync"
                            ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                            : "border-amber-500/40 bg-amber-500/15 text-amber-200"
                        }`}
                      >
                        {scenarioSignatureStatus}
                      </span>
                    ) : null}
                  </div>
                ) : null}
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
                    {JSON.stringify(
                      {
                        operations_signature: wizardScenarioOpsSignature,
                        operations: wizardScenarioOps,
                      },
                      null,
                      2,
                    )}
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
            {agentSchemaQuery.data?.signature_error_codes?.length ? (
              <p className="mb-2 text-xs text-slate-400">
                signature codes:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.signature_error_codes.join(", ")}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_preview_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                ops preview endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_preview_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_stats_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache stats endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_stats_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_entries_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache entries endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_entries_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_entry_detail_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache entry detail endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_entry_detail_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_prefixes_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache prefixes endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_prefixes_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_clear_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache clear endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_clear_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_replay_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache replay endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_replay_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_reexecute_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache reexecute endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_reexecute_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_remove_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_remove_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove-by-prefix endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_remove_by_prefix_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove-by-prefix preview endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_remove_by_prefix_preview_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.cache_validation_error_codes?.length ? (
              <p className="mb-2 text-xs text-slate-400">
                cache validation codes:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.cache_validation_error_codes.join(", ")}
                </span>
              </p>
            ) : null}
            {typeof agentSchemaQuery.data?.agent_ops_idempotency_cache_max_entries === "number" ? (
              <p className="mb-2 text-xs text-slate-400">
                idempotency cache entries/workbook:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_idempotency_cache_max_entries}
                </span>
              </p>
            ) : null}
            {workbook && agentOpsCacheQuery.data ? (
              <div className="mb-2 rounded border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-400">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    cache usage:{" "}
                    <span className="font-mono text-slate-200">
                      {agentOpsCacheQuery.data.entries}/
                      {agentOpsCacheQuery.data.max_entries}
                    </span>
                  </span>
                  <button
                    onClick={handleClearAgentOpsCache}
                    disabled={isClearingOpsCache || agentOpsCacheQuery.data.entries === 0}
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {isClearingOpsCache ? "Clearing..." : "Clear cache"}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  oldest:{" "}
                  <span className="font-mono text-slate-300">
                    {agentOpsCacheQuery.data.oldest_request_id ?? "-"}
                  </span>{" "}
                  · newest:{" "}
                  <span className="font-mono text-slate-300">
                    {agentOpsCacheQuery.data.newest_request_id ?? "-"}
                  </span>
                </p>
                <div className="mt-2 rounded border border-slate-800/80 bg-slate-900/40 p-2">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <label className="text-[10px] text-slate-500">
                      request_id prefix
                    </label>
                    <input
                      value={cacheRequestIdPrefix}
                      onChange={(event) =>
                        setCacheRequestIdPrefix(event.target.value)
                      }
                      placeholder="e.g. scenario-"
                      className="h-6 rounded border border-slate-700 bg-slate-950 px-2 text-[11px] text-slate-200 outline-none placeholder:text-slate-500 focus:border-indigo-500"
                    />
                    <button
                      onClick={() => setCacheRequestIdPrefix("")}
                      disabled={!cacheRequestIdPrefix}
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Clear
                    </button>
                    <button
                      onClick={handlePreviewRemoveCacheEntriesByPrefix}
                      disabled={
                        isPreviewingCacheByPrefix || !cacheRequestIdPrefix.trim()
                      }
                      className="rounded border border-amber-700/70 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
                    >
                      {isPreviewingCacheByPrefix ? "Previewing..." : "Preview remove"}
                    </button>
                    <button
                      onClick={handleRemoveCacheEntriesByPrefix}
                      disabled={
                        isRemovingCacheByPrefix
                        || !cacheRequestIdPrefix.trim()
                        || (agentOpsCacheEntriesQuery.data?.total_entries ?? 0) === 0
                      }
                      className="rounded border border-rose-700/70 px-1.5 py-0.5 text-[10px] text-rose-200 hover:bg-rose-900/40 disabled:opacity-50"
                    >
                      {isRemovingCacheByPrefix ? "Removing..." : "Remove filtered"}
                    </button>
                    <label className="ml-2 text-[10px] text-slate-500">
                      rerun request_id
                    </label>
                    <input
                      value={cacheRerunRequestId}
                      onChange={(event) =>
                        setCacheRerunRequestId(event.target.value)
                      }
                      placeholder="optional fixed id"
                      className="h-6 rounded border border-slate-700 bg-slate-950 px-2 text-[11px] text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-500"
                    />
                    <button
                      onClick={() => setCacheRerunRequestId("")}
                      disabled={!cacheRerunRequestId}
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Clear rerun id
                    </button>
                  </div>
                  {cachePrefixRemovalPreview ? (
                    <div className="mb-2 rounded border border-amber-800/60 bg-amber-900/10 p-2 text-[10px] text-amber-100">
                      <p>
                        preview prefix{" "}
                        <span className="font-mono">
                          {cachePrefixRemovalPreview.requestIdPrefix}
                        </span>{" "}
                        matches{" "}
                        <span className="font-mono">
                          {cachePrefixRemovalPreview.matchedEntries}
                        </span>{" "}
                        entr
                        {cachePrefixRemovalPreview.matchedEntries === 1 ? "y" : "ies"}.
                      </p>
                      {cachePrefixRemovalPreview.sampleRequestIds.length > 0 ? (
                        <p className="mt-1 text-amber-200/90">
                          sample:{" "}
                          <span className="font-mono">
                            {cachePrefixRemovalPreview.sampleRequestIds.join(", ")}
                          </span>
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {cachePrefixSuggestions.length > 0 ? (
                    <div className="mb-2 flex flex-wrap items-center gap-1">
                      <span className="text-[10px] text-slate-500">suggestions:</span>
                      {cachePrefixSuggestions.map((suggestion) => (
                        <button
                          key={suggestion.prefix}
                          onClick={() => setCacheRequestIdPrefix(suggestion.prefix)}
                          className={`rounded border px-1.5 py-0.5 text-[10px] ${
                            cacheRequestIdPrefix === suggestion.prefix
                              ? "border-indigo-500/80 bg-indigo-500/20 text-indigo-200"
                              : "border-slate-700 text-slate-300 hover:bg-slate-800"
                          }`}
                        >
                          {suggestion.prefix}
                          <span className="ml-1 text-slate-400">
                            {suggestion.entry_count}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] text-slate-500">
                      recent request IDs (newest first):
                    </p>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() =>
                          setCacheEntriesOffset((previousOffset) =>
                            Math.max(
                              0,
                              previousOffset - CACHE_ENTRIES_PREVIEW_LIMIT,
                            ),
                          )
                        }
                        disabled={cacheEntriesOffset === 0}
                        className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                      >
                        Newer
                      </button>
                      <button
                        onClick={() =>
                          setCacheEntriesOffset(
                            cacheEntriesOffset + CACHE_ENTRIES_PREVIEW_LIMIT,
                          )
                        }
                        disabled={!agentOpsCacheEntriesQuery.data?.has_more}
                        className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                      >
                        Older
                      </button>
                    </div>
                  </div>
                  {agentOpsCacheEntriesQuery.data ? (
                    <p className="mt-1 text-[10px] text-slate-500">
                      showing{" "}
                      <span className="font-mono text-slate-300">
                        {agentOpsCacheEntriesQuery.data.returned_entries === 0
                          ? 0
                          : agentOpsCacheEntriesQuery.data.offset + 1}
                      </span>
                      –
                      <span className="font-mono text-slate-300">
                        {agentOpsCacheEntriesQuery.data.offset
                          + agentOpsCacheEntriesQuery.data.returned_entries}
                      </span>{" "}
                      of{" "}
                      <span className="font-mono text-slate-300">
                        {agentOpsCacheEntriesQuery.data.total_entries}
                      </span>
                      {agentOpsCacheEntriesQuery.data.request_id_prefix ? (
                        <>
                          {" "}
                          filtered by{" "}
                          <span className="font-mono text-indigo-300">
                            {agentOpsCacheEntriesQuery.data.request_id_prefix}
                          </span>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  {agentOpsCacheEntriesQuery.isLoading ? (
                    <p className="mt-1 text-[11px] text-slate-500">Loading cache entries…</p>
                  ) : null}
                  {agentOpsCacheEntriesQuery.data?.entries?.length ? (
                    <ul className="mt-1 space-y-1">
                      {agentOpsCacheEntriesQuery.data.entries.map((entry) => (
                        <li
                          key={entry.request_id}
                          className="flex items-center justify-between gap-2 text-[11px] text-slate-400"
                        >
                          <div className="min-w-0">
                            <span className="font-mono text-slate-200">
                              {entry.request_id}
                            </span>
                            <span className="ml-2 text-slate-500">
                              sig:
                              <span className="ml-1 font-mono text-slate-300">
                                {entry.operations_signature?.slice(0, 12) ?? "-"}
                              </span>
                            </span>
                            <span className="ml-2 text-slate-500">
                              ops:
                              <span className="ml-1 font-mono text-slate-300">
                                {entry.operation_count}
                              </span>
                            </span>
                            <span className="ml-2 text-slate-500">
                              results:
                              <span className="ml-1 font-mono text-slate-300">
                                {entry.result_count}
                              </span>
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleInspectCacheRequestId(entry.request_id)}
                              disabled={
                                inspectingCacheRequestId === entry.request_id
                                || reexecutingCacheRequestId === entry.request_id
                                || replayingCacheRequestId === entry.request_id
                                || removingCacheRequestId === entry.request_id
                                || copyingCacheRequestId === entry.request_id
                                || copyingCacheOpsPayloadRequestId === entry.request_id
                              }
                              className="rounded border border-cyan-700/70 px-1.5 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-900/40 disabled:opacity-50"
                            >
                              {inspectingCacheRequestId === entry.request_id
                                ? "Inspecting..."
                                : "Inspect"}
                            </button>
                            <button
                              onClick={() => handleReplayCacheRequestId(entry.request_id)}
                              disabled={
                                replayingCacheRequestId === entry.request_id
                                || reexecutingCacheRequestId === entry.request_id
                                || inspectingCacheRequestId === entry.request_id
                                || removingCacheRequestId === entry.request_id
                                || copyingCacheRequestId === entry.request_id
                                || copyingCacheOpsPayloadRequestId === entry.request_id
                              }
                              className="rounded border border-emerald-700/70 px-1.5 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-50"
                            >
                              {replayingCacheRequestId === entry.request_id
                                ? "Replaying..."
                                : "Replay"}
                            </button>
                            <button
                              onClick={() => handleReexecuteCacheRequestId(entry.request_id)}
                              disabled={
                                reexecutingCacheRequestId === entry.request_id
                                || replayingCacheRequestId === entry.request_id
                                || inspectingCacheRequestId === entry.request_id
                                || removingCacheRequestId === entry.request_id
                                || copyingCacheRequestId === entry.request_id
                                || copyingCacheOpsPayloadRequestId === entry.request_id
                              }
                              className="rounded border border-amber-700/70 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
                            >
                              {reexecutingCacheRequestId === entry.request_id
                                ? "Rerunning..."
                                : "Rerun"}
                            </button>
                            <button
                              onClick={() =>
                                handleCopyCacheEntryAsOpsPayload(entry.request_id)
                              }
                              disabled={
                                copyingCacheOpsPayloadRequestId === entry.request_id
                                || reexecutingCacheRequestId === entry.request_id
                                || inspectingCacheRequestId === entry.request_id
                                || replayingCacheRequestId === entry.request_id
                                || removingCacheRequestId === entry.request_id
                                || copyingCacheRequestId === entry.request_id
                              }
                              className="rounded border border-indigo-700/70 px-1.5 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-900/40 disabled:opacity-50"
                            >
                              {copyingCacheOpsPayloadRequestId === entry.request_id
                                ? "Payload..."
                                : "Copy Ops"}
                            </button>
                            <button
                              onClick={() => handleCopyCacheRequestId(entry.request_id)}
                              disabled={
                                copyingCacheRequestId === entry.request_id
                                || removingCacheRequestId === entry.request_id
                                || replayingCacheRequestId === entry.request_id
                                || reexecutingCacheRequestId === entry.request_id
                                || inspectingCacheRequestId === entry.request_id
                                || copyingCacheOpsPayloadRequestId === entry.request_id
                              }
                              className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                            >
                              {copyingCacheRequestId === entry.request_id
                                ? "Copying..."
                                : "Copy"}
                            </button>
                            <button
                              onClick={() => handleRemoveCacheRequestId(entry.request_id)}
                              disabled={
                                removingCacheRequestId === entry.request_id
                                || copyingCacheRequestId === entry.request_id
                                || replayingCacheRequestId === entry.request_id
                                || reexecutingCacheRequestId === entry.request_id
                                || inspectingCacheRequestId === entry.request_id
                                || copyingCacheOpsPayloadRequestId === entry.request_id
                              }
                              className="rounded border border-rose-700/70 px-1.5 py-0.5 text-[10px] text-rose-200 hover:bg-rose-900/40 disabled:opacity-50"
                            >
                              {removingCacheRequestId === entry.request_id
                                ? "Removing..."
                                : "Remove"}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : agentOpsCacheEntriesQuery.isLoading ? null : (
                    <p className="mt-1 text-[11px] text-slate-500">
                      No cached request IDs yet.
                    </p>
                  )}
                  {selectedCacheEntryDetail ? (
                    <div className="mt-2 rounded border border-slate-800 bg-slate-950/70 p-2">
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="text-slate-300">
                          selected detail:{" "}
                          <span className="font-mono text-slate-100">
                            {selectedCacheEntryDetail.request_id}
                          </span>
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={handleCopySelectedCacheOperations}
                            disabled={isCopyingCacheDetailOperations}
                            className="rounded border border-indigo-700/70 px-1.5 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-900/40 disabled:opacity-50"
                          >
                            {isCopyingCacheDetailOperations
                              ? "Copying..."
                              : "Copy operations"}
                          </button>
                          <button
                            onClick={handleCopySelectedCacheDetail}
                            disabled={isCopyingCacheDetailJson}
                            className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                          >
                            {isCopyingCacheDetailJson
                              ? "Copying..."
                              : "Copy detail JSON"}
                          </button>
                        </div>
                      </div>
                      <p className="text-[10px] text-slate-500">
                        ops:{" "}
                        <span className="font-mono text-slate-300">
                          {selectedCacheEntryDetail.operation_count}
                        </span>{" "}
                        · results:{" "}
                        <span className="font-mono text-slate-300">
                          {selectedCacheEntryDetail.result_count}
                        </span>
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {selectedCacheEntryDetail.operations.map((operation, index) => (
                          <span
                            key={`${operation.op_type}-${index}`}
                            className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300"
                          >
                            {operation.op_type}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
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
            {lastOperationsSignature && (
              <p className="mb-2 text-xs text-slate-400">
                operations_signature:{" "}
                <span className="font-mono text-slate-200">
                  {lastOperationsSignature}
                </span>
              </p>
            )}
            {lastServedFromCache !== null ? (
              <p className="mb-2 text-xs text-slate-400">
                served_from_cache:{" "}
                <span
                  className={`rounded px-1.5 py-0.5 font-mono ${
                    lastServedFromCache
                      ? "bg-amber-500/20 text-amber-200"
                      : "bg-emerald-500/20 text-emerald-200"
                  }`}
                >
                  {String(lastServedFromCache)}
                </span>
              </p>
            ) : null}
            {lastExecutedOperations.length > 0 || lastAgentRequestId ? (
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-400">
                {lastExecutedOperations.length > 0 ? (
                  <span>
                    last execution plan ops:{" "}
                    <span className="font-mono text-slate-200">
                      {lastExecutedOperations.length}
                    </span>
                  </span>
                ) : (
                  <span className="text-slate-500">
                    last execution plan not available locally.
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleReplayLastRequestId}
                    disabled={
                      isReplayingLastRequest ||
                      !workbook ||
                      !lastAgentRequestId
                    }
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {isReplayingLastRequest
                      ? "Replaying..."
                      : "Replay Last request_id"}
                  </button>
                  <button
                    onClick={handleCopyLastExecutionOpsPayload}
                    disabled={
                      isCopyingLastExecutionPayload
                      || !workbook
                      || lastExecutedOperations.length === 0
                    }
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {isCopyingLastExecutionPayload
                      ? "Copying..."
                      : "Copy Last Plan as agent/ops"}
                  </button>
                </div>
              </div>
            ) : null}
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
