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
  getOpenApiSpec,
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
  removeStaleAgentOpsCacheEntries,
  runDuckdbQuery,
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
  AgentWizardImportResult,
  DuckdbQueryResponse,
  ExportCompatibilityReport,
  AgentOperationPreview,
  AgentOperationResult,
  WorkbookEvent,
} from "@/types/spreadsheet";

const ChartPreview = dynamic(
  () => import("@/components/chart-preview").then((module) => module.ChartPreview),
  {
    ssr: false,
  },
);

const CACHE_ENTRIES_PREVIEW_LIMIT = 6;
const CACHE_PREVIEW_MAX_SAMPLE_LIMIT = 100;
const CACHE_PREFIX_SUGGESTIONS_DEFAULT_LIMIT = "12";
const CACHE_PREFIX_SUGGESTIONS_DEFAULT_SORT: "count" | "recent" | "alpha" | "span" =
  "count";

interface LatestImportSummary {
  sheetsImported: number;
  cellsImported: number;
  formulaCellsImported: number;
  formulaCellsWithCachedValues: number;
  formulaCellsWithoutCachedValues: number;
  formulaCellsNormalized: number;
  warnings: string[];
}

function formatLatestImportSummary(summary: LatestImportSummary): string {
  if (summary.formulaCellsImported <= 0) {
    return `${summary.sheetsImported} sheets, ${summary.cellsImported} cells`;
  }
  const normalizedSegment = summary.formulaCellsNormalized > 0
    ? `, ${summary.formulaCellsNormalized} normalized`
    : "";
  return `${summary.sheetsImported} sheets, ${summary.cellsImported} cells, ${summary.formulaCellsImported} formulas (${summary.formulaCellsWithCachedValues} cached, ${summary.formulaCellsWithoutCachedValues} uncached${normalizedSegment})`;
}

function parsePositiveIntegerInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return undefined;
  }
  const parsedValue = Number.parseInt(normalized, 10);
  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    return undefined;
  }
  return parsedValue;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseCommaSeparatedList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return parseStringArray(value);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function collectSchemaEndpointMetadata(
  schema: unknown,
  endpointOpenApiPathsByKey?: Record<string, string>,
): Array<{ key: string; endpoint: string; openApiPath: string }> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }
  return Object.entries(schema as Record<string, unknown>)
    .flatMap(([key, value]) => {
      if (key !== "endpoint" && !key.endsWith("_endpoint")) {
        return [];
      }
      if (typeof value !== "string") {
        return [];
      }
      const endpoint = value.trim();
      if (!endpoint) {
        return [];
      }
      const openApiPath = endpointOpenApiPathsByKey?.[key]
        ?? endpoint.split("?").shift()
        ?? endpoint;
      return [{ key, endpoint, openApiPath }];
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeEndpointMethodList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const methods = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(methods)).sort();
}

function normalizeEndpointMethodsByKey(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, string[]>
  >((accumulator, [key, methods]) => {
    const normalizedMethods = normalizeEndpointMethodList(methods);
    if (normalizedMethods.length > 0) {
      accumulator[key] = normalizedMethods;
    }
    return accumulator;
  }, {});
}

function normalizeEndpointPathsByKey(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, string>
  >((accumulator, [key, path]) => {
    if (typeof path !== "string") {
      return accumulator;
    }
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return accumulator;
    }
    accumulator[key] = normalizedPath;
    return accumulator;
  }, {});
}

function normalizeEndpointOperationsByKey(
  value: unknown,
): Record<string, { path?: string; methods?: string[]; summary?: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, { path?: string; methods?: string[]; summary?: string }>
  >((accumulator, [key, operation]) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      return accumulator;
    }
    const operationValue = operation as {
      path?: unknown;
      methods?: unknown;
      summary?: unknown;
    };
    const normalizedPath = typeof operationValue.path === "string"
      ? operationValue.path.trim()
      : "";
    const normalizedMethods = normalizeEndpointMethodList(operationValue.methods);
    const normalizedSummary = typeof operationValue.summary === "string"
      ? operationValue.summary.trim()
      : "";
    if (!normalizedPath && normalizedMethods.length === 0 && !normalizedSummary) {
      return accumulator;
    }
    accumulator[key] = {
      path: normalizedPath || undefined,
      methods: normalizedMethods.length > 0 ? normalizedMethods : undefined,
      summary: normalizedSummary || undefined,
    };
    return accumulator;
  }, {});
}

function normalizeEndpointSummariesByKey(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, string>
  >((accumulator, [key, summary]) => {
    if (typeof summary !== "string") {
      return accumulator;
    }
    const normalizedSummary = summary.trim();
    if (!normalizedSummary) {
      return accumulator;
    }
    accumulator[key] = normalizedSummary;
    return accumulator;
  }, {});
}

function areMethodListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function collectOpenApiSummariesByPath(spec: unknown): Record<string, string> {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return {};
  }
  const paths = (spec as { paths?: unknown }).paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    return {};
  }
  return Object.entries(paths as Record<string, unknown>).reduce<Record<string, string>>(
    (accumulator, [path, methods]) => {
      if (!methods || typeof methods !== "object" || Array.isArray(methods)) {
        return accumulator;
      }
      const summaries = Object.entries(methods as Record<string, unknown>)
        .flatMap(([method, metadata]) => {
          if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
            return [];
          }
          const summary = (metadata as { summary?: unknown }).summary;
          if (typeof summary !== "string" || !summary.trim()) {
            return [];
          }
          return [{
            method: method.trim().toUpperCase(),
            summary: summary.trim(),
          }];
        })
        .sort((left, right) => left.method.localeCompare(right.method));
      if (summaries.length === 0) {
        return accumulator;
      }
      const renderedSummary = summaries.length === 1
        ? summaries[0].summary
        : summaries.map((entry) => `${entry.method}: ${entry.summary}`).join(" | ");
      accumulator[path] = renderedSummary;
      return accumulator;
    },
    {},
  );
}

function collectOpenApiMethodsByPath(
  spec: unknown,
): Record<string, string[]> {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return {};
  }
  const paths = (spec as { paths?: unknown }).paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    return {};
  }
  return Object.entries(paths as Record<string, unknown>).reduce<
    Record<string, string[]>
  >((accumulator, [path, methods]) => {
    if (!methods || typeof methods !== "object" || Array.isArray(methods)) {
      return accumulator;
    }
    const methodNames = Object.keys(methods)
      .map((method) => method.trim().toUpperCase())
      .filter((method) => method.length > 0)
      .sort();
    if (methodNames.length > 0) {
      accumulator[path] = Array.from(new Set(methodNames));
    }
    return accumulator;
  }, {});
}

function filterEndpointCatalogEntries<
  T extends { key: string; endpoint: string; openApiPath: string; summary: string | null },
>(
  entries: T[],
  rawFilterValue: string,
): T[] {
  const normalizedFilterValue = rawFilterValue.trim().toLowerCase();
  if (!normalizedFilterValue) {
    return entries;
  }
  return entries.filter((entry) =>
    [
      entry.key,
      entry.endpoint,
      entry.openApiPath,
      entry.summary ?? "",
    ].some((value) => value.toLowerCase().includes(normalizedFilterValue))
  );
}

function flattenSchemaShapeEntries(
  value: unknown,
  parentKey?: string,
): Array<{ key: string; description: string | null }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (!parentKey) {
      return [];
    }
    return [{
      key: parentKey,
      description:
        typeof value === "string" ? value : value === undefined ? null : String(value),
    }];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return parentKey ? [{ key: parentKey, description: null }] : [];
  }
  return entries.flatMap(([entryKey, entryValue]) =>
    flattenSchemaShapeEntries(
      entryValue,
      parentKey ? `${parentKey}.${entryKey}` : entryKey,
    ),
  );
}

function buildEndpointCatalogCoverageStats(
  entries: Array<{
    methodSource: string;
    summarySource: string;
    openApiPathSource: string;
    hasMethodMismatch: boolean;
    hasSummaryMismatch: boolean;
    hasPathMismatch: boolean;
  }>,
): {
  total: number;
  methodOperationBacked: number;
  summaryOperationBacked: number;
  pathOperationBacked: number;
  operationFallback: number;
  methodMismatches: number;
  summaryMismatches: number;
  pathMismatches: number;
} {
  return entries.reduce(
    (accumulator, entry) => ({
      total: accumulator.total + 1,
      methodOperationBacked:
        accumulator.methodOperationBacked + (entry.methodSource === "operation" ? 1 : 0),
      summaryOperationBacked:
        accumulator.summaryOperationBacked + (entry.summarySource === "operation" ? 1 : 0),
      pathOperationBacked:
        accumulator.pathOperationBacked + (entry.openApiPathSource === "operation" ? 1 : 0),
      operationFallback:
        accumulator.operationFallback
        + (
          entry.methodSource !== "operation"
            || entry.summarySource !== "operation"
            || entry.openApiPathSource !== "operation"
            ? 1
            : 0
        ),
      methodMismatches: accumulator.methodMismatches + (entry.hasMethodMismatch ? 1 : 0),
      summaryMismatches: accumulator.summaryMismatches + (entry.hasSummaryMismatch ? 1 : 0),
      pathMismatches: accumulator.pathMismatches + (entry.hasPathMismatch ? 1 : 0),
    }),
    {
      total: 0,
      methodOperationBacked: 0,
      summaryOperationBacked: 0,
      pathOperationBacked: 0,
      operationFallback: 0,
      methodMismatches: 0,
      summaryMismatches: 0,
      pathMismatches: 0,
    },
  );
}

function formatSchemaShapeEntries(
  entries: Array<{ key: string; description: string | null }>,
): string {
  return entries
    .map((entry) =>
      entry.description ? `${entry.key}: ${entry.description}` : entry.key
    )
    .join(", ");
}

function parseCompatibilityReport(
  value: unknown,
): ExportCompatibilityReport | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const report = value as Partial<ExportCompatibilityReport>;
  const preserved = parseStringArray(report.preserved);
  const transformed = parseStringArray(report.transformed);
  const unsupported = parseStringArray(report.unsupported);
  if (
    preserved.length === 0
    && transformed.length === 0
    && unsupported.length === 0
  ) {
    return null;
  }
  return {
    preserved,
    transformed,
    unsupported,
  };
}

function toLatestImportSummary(
  importSummary: AgentWizardImportResult,
): LatestImportSummary {
  return {
    sheetsImported: importSummary.sheets_imported,
    cellsImported: importSummary.cells_imported,
    formulaCellsImported: importSummary.formula_cells_imported,
    formulaCellsWithCachedValues: importSummary.formula_cells_with_cached_values,
    formulaCellsWithoutCachedValues:
      importSummary.formula_cells_without_cached_values,
    formulaCellsNormalized: importSummary.formula_cells_normalized,
    warnings: importSummary.warnings,
  };
}

function parseImportSummaryFromEvent(event: WorkbookEvent): LatestImportSummary | null {
  if (event.event_type !== "workbook.imported") {
    return null;
  }
  const sheetsImported = event.payload.sheets_imported;
  const cellsImported = event.payload.cells_imported;
  const formulaCellsImported = event.payload.formula_cells_imported;
  const formulaCellsWithCachedValues =
    event.payload.formula_cells_with_cached_values;
  const formulaCellsWithoutCachedValues =
    event.payload.formula_cells_without_cached_values;
  const formulaCellsNormalized = event.payload.formula_cells_normalized;
  if (
    typeof sheetsImported !== "number"
    || typeof cellsImported !== "number"
    || typeof formulaCellsImported !== "number"
    || typeof formulaCellsWithCachedValues !== "number"
    || typeof formulaCellsWithoutCachedValues !== "number"
    || typeof formulaCellsNormalized !== "number"
  ) {
    return null;
  }
  return {
    sheetsImported,
    cellsImported,
    formulaCellsImported,
    formulaCellsWithCachedValues,
    formulaCellsWithoutCachedValues,
    formulaCellsNormalized,
    warnings: parseStringArray(event.payload.warnings),
  };
}

function parseExportSummaryFromEvent(event: WorkbookEvent): {
  fileName: string;
  exportedAt: string;
  compatibilityReport: ExportCompatibilityReport | null;
} | null {
  if (event.event_type !== "workbook.exported") {
    return null;
  }
  const fileName = event.payload.file_name;
  if (typeof fileName !== "string" || !fileName.trim()) {
    return null;
  }
  return {
    fileName,
    exportedAt: event.timestamp,
    compatibilityReport: parseCompatibilityReport(event.payload.compatibility_report),
  };
}

function parseDuckdbQueryResponseFromOperationData(
  value: unknown,
): DuckdbQueryResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  if (
    !Array.isArray(payload.rows)
    || typeof payload.row_count !== "number"
    || typeof payload.row_limit !== "number"
    || typeof payload.truncated !== "boolean"
  ) {
    return null;
  }
  const columns = parseStringArray(payload.columns);
  const rows: Array<Array<string | null>> = [];
  for (const rowValue of payload.rows) {
    if (!Array.isArray(rowValue)) {
      return null;
    }
    rows.push(
      rowValue.map((entry) => {
        if (typeof entry === "string" || entry === null) {
          return entry;
        }
        return String(entry);
      }),
    );
  }
  return {
    columns,
    rows,
    row_count: payload.row_count,
    row_limit: payload.row_limit,
    truncated: payload.truncated,
  };
}

function extractRequestIdPrefix(requestId: string): string | null {
  const delimiterIndex = requestId.indexOf("-");
  if (delimiterIndex <= 0) {
    return null;
  }
  return requestId.slice(0, delimiterIndex + 1);
}

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
  const [isCopyingWizardEndpointCatalog, setIsCopyingWizardEndpointCatalog] =
    useState(false);
  const [isCopyingAgentEndpointCatalog, setIsCopyingAgentEndpointCatalog] =
    useState(false);
  const [isRunningWizard, setIsRunningWizard] = useState(false);
  const [isCreatingSheet, setIsCreatingSheet] = useState(false);
  const [newSheetName, setNewSheetName] = useState("Sheet2");
  const [wizardScenario, setWizardScenario] = useState("seed_then_export");
  const [wizardPresetPreview, setWizardPresetPreview] = useState("export_snapshot");
  const [wizardIncludeFileBase64, setWizardIncludeFileBase64] = useState(false);
  const [wizardWorkbookName, setWizardWorkbookName] = useState("Wizard Workbook");
  const [wizardEndpointCatalogFilter, setWizardEndpointCatalogFilter] = useState("");
  const [wizardFile, setWizardFile] = useState<File | null>(null);
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [uiError, setUiError] = useState<string | null>(null);
  const [uiErrorCode, setUiErrorCode] = useState<string | null>(null);
  const [uiNotice, setUiNotice] = useState<string | null>(null);
  const [duckdbQuerySql, setDuckdbQuerySql] = useState(
    "SELECT sheet, row_index, col_index, raw_value, formula, evaluated_value FROM cells ORDER BY row_index, col_index",
  );
  const [duckdbQueryRowLimit, setDuckdbQueryRowLimit] = useState("200");
  const [isRunningDuckdbQuery, setIsRunningDuckdbQuery] = useState(false);
  const [isRunningDuckdbOpsQuery, setIsRunningDuckdbOpsQuery] = useState(false);
  const [duckdbQueryResult, setDuckdbQueryResult] = useState<DuckdbQueryResponse | null>(
    null,
  );
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
  const [cachePrefixSuggestionsOffset, setCachePrefixSuggestionsOffset] = useState(0);
  const [cacheRequestIdPrefix, setCacheRequestIdPrefix] = useState("");
  const [agentEndpointCatalogFilter, setAgentEndpointCatalogFilter] = useState("");
  const [cacheEntriesMaxAgeSeconds, setCacheEntriesMaxAgeSeconds] = useState("");
  const [cachePrefixSuggestionLimit, setCachePrefixSuggestionLimit] = useState(
    CACHE_PREFIX_SUGGESTIONS_DEFAULT_LIMIT,
  );
  const [cachePrefixMinEntryCount, setCachePrefixMinEntryCount] = useState("");
  const [cachePrefixMinSpanSeconds, setCachePrefixMinSpanSeconds] = useState("");
  const [cachePrefixMaxSpanSeconds, setCachePrefixMaxSpanSeconds] = useState("");
  const [cachePrefixSortBy, setCachePrefixSortBy] = useState<
    "count" | "recent" | "alpha" | "span"
  >(
    CACHE_PREFIX_SUGGESTIONS_DEFAULT_SORT,
  );
  const [cacheRemovePreviewSampleLimit, setCacheRemovePreviewSampleLimit] = useState("10");
  const [cacheStalePreviewSampleLimit, setCacheStalePreviewSampleLimit] = useState("10");
  const [cacheStaleMaxAgeSeconds, setCacheStaleMaxAgeSeconds] = useState("3600");
  const [isPreviewingStaleCache, setIsPreviewingStaleCache] = useState(false);
  const [isRemovingStaleCache, setIsRemovingStaleCache] = useState(false);
  const [cacheStaleRemovalPreview, setCacheStaleRemovalPreview] = useState<{
    requestIdPrefix: string | null;
    maxAgeSeconds: number;
    cutoffTimestamp: string;
    matchedEntries: number;
    unscopedMatchedEntries: number;
    sampleLimit: number;
    sampleRequestIds: string[];
  } | null>(null);
  const [cacheRerunRequestId, setCacheRerunRequestId] = useState("");
  const [cachePrefixRemovalPreview, setCachePrefixRemovalPreview] = useState<{
    requestIdPrefix: string;
    maxAgeSeconds: number | null;
    cutoffTimestamp: string | null;
    matchedEntries: number;
    unscopedMatchedEntries: number;
    sampleLimit: number;
    sampleRequestIds: string[];
  } | null>(null);
  const [selectedCacheEntryDetail, setSelectedCacheEntryDetail] = useState<
    AgentOpsCacheEntryDetailResponse | null
  >(null);
  const [lastAgentOps, setLastAgentOps] = useState<AgentOperationResult[]>([]);
  const [lastWizardImportSummary, setLastWizardImportSummary] = useState<
    LatestImportSummary | null
  >(null);
  const [lastExportSummary, setLastExportSummary] = useState<{
    fileName: string;
    exportedAt: string;
    compatibilityReport: ExportCompatibilityReport | null;
  } | null>(null);
  const normalizedCacheEntriesMaxAgeSeconds = parsePositiveIntegerInput(
    cacheEntriesMaxAgeSeconds,
  );
  const normalizedDuckdbQueryRowLimit = parsePositiveIntegerInput(
    duckdbQueryRowLimit,
  );
  const effectiveDuckdbQueryRowLimit =
    typeof normalizedDuckdbQueryRowLimit === "number"
      ? Math.min(normalizedDuckdbQueryRowLimit, 1_000)
      : undefined;
  const isDuckdbQueryRowLimitCapped =
    typeof normalizedDuckdbQueryRowLimit === "number"
    && normalizedDuckdbQueryRowLimit > 1_000;
  const hasInvalidDuckdbQueryRowLimitInput =
    duckdbQueryRowLimit.trim().length > 0
    && typeof normalizedDuckdbQueryRowLimit !== "number";
  const hasInvalidCacheEntriesMaxAgeInput =
    cacheEntriesMaxAgeSeconds.trim().length > 0
    && typeof normalizedCacheEntriesMaxAgeSeconds !== "number";
  const normalizedCachePrefixMinEntryCount = parsePositiveIntegerInput(
    cachePrefixMinEntryCount,
  );
  const hasInvalidCachePrefixMinEntryCountInput =
    cachePrefixMinEntryCount.trim().length > 0
    && typeof normalizedCachePrefixMinEntryCount !== "number";
  const normalizedCachePrefixMinSpanSeconds = parsePositiveIntegerInput(
    cachePrefixMinSpanSeconds,
  );
  const hasInvalidCachePrefixMinSpanSecondsInput =
    cachePrefixMinSpanSeconds.trim().length > 0
    && typeof normalizedCachePrefixMinSpanSeconds !== "number";
  const normalizedCachePrefixMaxSpanSeconds = parsePositiveIntegerInput(
    cachePrefixMaxSpanSeconds,
  );
  const hasInvalidCachePrefixMaxSpanSecondsInput =
    cachePrefixMaxSpanSeconds.trim().length > 0
    && typeof normalizedCachePrefixMaxSpanSeconds !== "number";
  const hasInvalidCachePrefixSpanRangeInput =
    typeof normalizedCachePrefixMinSpanSeconds === "number"
    && typeof normalizedCachePrefixMaxSpanSeconds === "number"
    && normalizedCachePrefixMinSpanSeconds > normalizedCachePrefixMaxSpanSeconds;
  const normalizedCachePrefixSuggestionLimit = parsePositiveIntegerInput(
    cachePrefixSuggestionLimit,
  );
  const hasInvalidCachePrefixSuggestionLimitInput =
    cachePrefixSuggestionLimit.trim().length > 0
    && typeof normalizedCachePrefixSuggestionLimit !== "number";
  const normalizedCacheRemovePreviewSampleLimit = parsePositiveIntegerInput(
    cacheRemovePreviewSampleLimit,
  );
  const hasInvalidCacheRemovePreviewSampleLimitInput =
    cacheRemovePreviewSampleLimit.trim().length > 0
    && typeof normalizedCacheRemovePreviewSampleLimit !== "number";
  const isCacheRemovePreviewSampleLimitCapped =
    typeof normalizedCacheRemovePreviewSampleLimit === "number"
    && normalizedCacheRemovePreviewSampleLimit > CACHE_PREVIEW_MAX_SAMPLE_LIMIT;
  const normalizedCacheStalePreviewSampleLimit = parsePositiveIntegerInput(
    cacheStalePreviewSampleLimit,
  );
  const hasInvalidCacheStalePreviewSampleLimitInput =
    cacheStalePreviewSampleLimit.trim().length > 0
    && typeof normalizedCacheStalePreviewSampleLimit !== "number";
  const isCacheStalePreviewSampleLimitCapped =
    typeof normalizedCacheStalePreviewSampleLimit === "number"
    && normalizedCacheStalePreviewSampleLimit > CACHE_PREVIEW_MAX_SAMPLE_LIMIT;
  const normalizedCacheStaleMaxAgeSeconds = parsePositiveIntegerInput(
    cacheStaleMaxAgeSeconds,
  );
  const hasInvalidCacheStaleMaxAgeInput =
    cacheStaleMaxAgeSeconds.trim().length > 0
    && typeof normalizedCacheStaleMaxAgeSeconds !== "number";

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
      setDuckdbQueryResult(null);
    },
    onError: (error) => {
      applyUiError(error, "Failed to create workbook.");
    },
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => importWorkbook(file),
    onSuccess: (response) => {
      const importedWorkbook = response.workbook;
      const importSummary = toLatestImportSummary(response.import);
      clearUiError();
      setWorkbook(importedWorkbook);
      setNotice(
        `Imported workbook ${importedWorkbook.name} (${formatLatestImportSummary(importSummary)}).`,
      );
      setLastAgentRequestId(null);
      setLastPreset(null);
      setLastScenario(null);
      setLastOperationsSignature(null);
      setLastServedFromCache(null);
      setLastExecutedOperations([]);
      setLastAgentOps([]);
      setLastWizardImportSummary(importSummary);
      setDuckdbQueryResult(null);
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
  const hasLoadedSchemaMetadata = Boolean(agentSchemaQuery.data || wizardSchemaQuery.data);
  const openApiSpecQuery = useQuery({
    queryKey: ["openapi-spec"],
    queryFn: getOpenApiSpec,
    enabled: hasLoadedSchemaMetadata,
    staleTime: 5 * 60 * 1000,
  });

  const agentOpsCacheQuery = useQuery({
    queryKey: [
      "agent-ops-cache",
      workbook?.id,
      cacheRequestIdPrefix,
      normalizedCacheEntriesMaxAgeSeconds,
    ],
    enabled: Boolean(workbook?.id),
    queryFn: () =>
      getAgentOpsCacheStats(
        workbook!.id,
        normalizedCacheEntriesMaxAgeSeconds,
        cacheRequestIdPrefix,
      ),
  });

  const agentOpsCacheEntriesQuery = useQuery({
    queryKey: [
      "agent-ops-cache-entries",
      workbook?.id,
      cacheRequestIdPrefix,
      cacheEntriesMaxAgeSeconds,
      cacheEntriesOffset,
      CACHE_ENTRIES_PREVIEW_LIMIT,
    ],
    enabled: Boolean(workbook?.id) && !hasInvalidCacheEntriesMaxAgeInput,
    queryFn: () =>
      getAgentOpsCacheEntries(
        workbook!.id,
        CACHE_ENTRIES_PREVIEW_LIMIT,
        cacheEntriesOffset,
        cacheRequestIdPrefix,
        normalizedCacheEntriesMaxAgeSeconds,
      ),
  });

  const agentOpsCachePrefixesQuery = useQuery({
    queryKey: [
      "agent-ops-cache-prefixes",
      workbook?.id,
      cacheRequestIdPrefix,
      normalizedCacheEntriesMaxAgeSeconds,
      normalizedCachePrefixSuggestionLimit,
      normalizedCachePrefixMinEntryCount,
      normalizedCachePrefixMinSpanSeconds,
      normalizedCachePrefixMaxSpanSeconds,
      cachePrefixSortBy,
      cachePrefixSuggestionsOffset,
    ],
    enabled: Boolean(workbook?.id)
      && !hasInvalidCacheEntriesMaxAgeInput
      && !hasInvalidCachePrefixMinEntryCountInput
      && !hasInvalidCachePrefixMinSpanSecondsInput
      && !hasInvalidCachePrefixMaxSpanSecondsInput
      && !hasInvalidCachePrefixSpanRangeInput
      && !hasInvalidCachePrefixSuggestionLimitInput,
    queryFn: () =>
      getAgentOpsCachePrefixes(
        workbook!.id,
        normalizedCachePrefixSuggestionLimit ?? 12,
        cachePrefixSuggestionsOffset,
        cacheRequestIdPrefix,
        normalizedCacheEntriesMaxAgeSeconds,
        normalizedCachePrefixMinEntryCount,
        normalizedCachePrefixMinSpanSeconds,
        normalizedCachePrefixMaxSpanSeconds,
        cachePrefixSortBy,
      ),
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
    setCachePrefixSuggestionsOffset(0);
    setSelectedCacheEntryDetail(null);
    setCacheRerunRequestId("");
    setCacheEntriesMaxAgeSeconds("");
    setCachePrefixSuggestionLimit(CACHE_PREFIX_SUGGESTIONS_DEFAULT_LIMIT);
    setCachePrefixMinEntryCount("");
    setCachePrefixMinSpanSeconds("");
    setCachePrefixMaxSpanSeconds("");
    setCachePrefixSortBy(CACHE_PREFIX_SUGGESTIONS_DEFAULT_SORT);
    setCachePrefixRemovalPreview(null);
    setCacheRemovePreviewSampleLimit("10");
    setCacheStalePreviewSampleLimit("10");
    setCacheStaleMaxAgeSeconds("3600");
    setCacheStaleRemovalPreview(null);
    setLastExportSummary(null);
  }, [workbook?.id]);

  useEffect(() => {
    setCacheEntriesOffset(0);
    setCachePrefixSuggestionsOffset(0);
    setCachePrefixRemovalPreview(null);
    setCacheStaleRemovalPreview(null);
  }, [
    cacheRequestIdPrefix,
    cacheEntriesMaxAgeSeconds,
    cachePrefixMinEntryCount,
    cachePrefixMinSpanSeconds,
    cachePrefixMaxSpanSeconds,
    cachePrefixSortBy,
    cachePrefixSuggestionLimit,
  ]);

  useEffect(() => {
    setCacheStaleRemovalPreview(null);
  }, [cacheStaleMaxAgeSeconds]);

  useEffect(() => {
    setCachePrefixRemovalPreview(null);
  }, [cacheRemovePreviewSampleLimit]);

  useEffect(() => {
    setCacheStaleRemovalPreview(null);
  }, [cacheStalePreviewSampleLimit]);

  useEffect(() => {
    if (
      !hasInvalidCacheEntriesMaxAgeInput
      &&
      cacheEntriesOffset > 0
      && agentOpsCacheEntriesQuery.data
      && agentOpsCacheEntriesQuery.data.entries.length === 0
    ) {
      setCacheEntriesOffset((previousOffset) =>
        Math.max(0, previousOffset - CACHE_ENTRIES_PREVIEW_LIMIT),
      );
    }
  }, [
    agentOpsCacheEntriesQuery.data,
    cacheEntriesOffset,
    hasInvalidCacheEntriesMaxAgeInput,
  ]);

  useEffect(() => {
    if (
      !hasInvalidCacheEntriesMaxAgeInput
      && !hasInvalidCachePrefixMinEntryCountInput
      && !hasInvalidCachePrefixMinSpanSecondsInput
      && !hasInvalidCachePrefixMaxSpanSecondsInput
      && !hasInvalidCachePrefixSpanRangeInput
      && !hasInvalidCachePrefixSuggestionLimitInput
      && cachePrefixSuggestionsOffset > 0
      && agentOpsCachePrefixesQuery.data
      && agentOpsCachePrefixesQuery.data.prefixes.length === 0
    ) {
      const fallbackStep = agentOpsCachePrefixesQuery.data.limit || 1;
      setCachePrefixSuggestionsOffset((previousOffset) =>
        Math.max(0, previousOffset - fallbackStep),
      );
    }
  }, [
    agentOpsCachePrefixesQuery.data,
    cachePrefixSuggestionsOffset,
    hasInvalidCacheEntriesMaxAgeInput,
    hasInvalidCachePrefixMinEntryCountInput,
    hasInvalidCachePrefixMinSpanSecondsInput,
    hasInvalidCachePrefixMaxSpanSecondsInput,
    hasInvalidCachePrefixSpanRangeInput,
    hasInvalidCachePrefixSuggestionLimitInput,
  ]);

  useEffect(() => {
    if (!workbook?.id) {
      return;
    }
    const unsubscribe = subscribeToWorkbookEvents(workbook.id, (event) => {
      appendEvent(event);
      const importSummary = parseImportSummaryFromEvent(event);
      if (importSummary) {
        setLastWizardImportSummary(importSummary);
      }
      const exportSummary = parseExportSummaryFromEvent(event);
      if (exportSummary) {
        setLastExportSummary(exportSummary);
      }
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
  const wizardRunResponseFields = useMemo(
    () => flattenSchemaShapeEntries(wizardSchemaQuery.data?.run_response_shape),
    [wizardSchemaQuery.data?.run_response_shape],
  );
  const wizardAgentOpsResponseFields = useMemo(
    () => flattenSchemaShapeEntries(wizardSchemaQuery.data?.agent_ops_response_shape),
    [wizardSchemaQuery.data?.agent_ops_response_shape],
  );
  const wizardImportResponseFields = useMemo(
    () => flattenSchemaShapeEntries(wizardSchemaQuery.data?.import_response_shape),
    [wizardSchemaQuery.data?.import_response_shape],
  );
  const wizardOperationsPreviewResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.operations_preview_response_shape,
      ),
    [wizardSchemaQuery.data?.operations_preview_response_shape],
  );
  const wizardFormulaCapabilityFields = useMemo(
    () => flattenSchemaShapeEntries(wizardSchemaQuery.data?.formula_capabilities),
    [wizardSchemaQuery.data?.formula_capabilities],
  );
  const wizardAgentOpsPreviewRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_preview_request_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_preview_request_shape],
  );
  const wizardAgentOpsRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_request_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_request_shape],
  );
  const wizardAgentOpsPreviewResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_preview_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_preview_response_shape],
  );
  const wizardDuckdbQueryRequestFields = useMemo(
    () => flattenSchemaShapeEntries(wizardSchemaQuery.data?.duckdb_query_request_shape),
    [wizardSchemaQuery.data?.duckdb_query_request_shape],
  );
  const wizardDuckdbQueryResponseFields = useMemo(
    () => flattenSchemaShapeEntries(wizardSchemaQuery.data?.duckdb_query_response_shape),
    [wizardSchemaQuery.data?.duckdb_query_response_shape],
  );
  const wizardOpsResultErrorFields = useMemo(
    () => flattenSchemaShapeEntries(wizardSchemaQuery.data?.agent_ops_result_error_shape),
    [wizardSchemaQuery.data?.agent_ops_result_error_shape],
  );
  const wizardCacheStatsResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_stats_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_stats_response_shape],
  );
  const wizardCacheStatsQueryFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_stats_query_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_stats_query_shape],
  );
  const wizardCacheEntriesQueryFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_entries_query_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_entries_query_shape],
  );
  const wizardCachePrefixesQueryFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_prefixes_query_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_prefixes_query_shape],
  );
  const wizardCacheEntriesResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_entries_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_entries_response_shape],
  );
  const wizardCachePrefixesResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_prefixes_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_prefixes_response_shape],
  );
  const wizardCacheEntryDetailResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_entry_detail_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_entry_detail_response_shape],
  );
  const wizardCacheClearResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_clear_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_clear_response_shape],
  );
  const wizardCacheReplayRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_replay_request_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_replay_request_shape],
  );
  const wizardCacheReplayResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_replay_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_replay_response_shape],
  );
  const wizardCacheReexecuteRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_reexecute_request_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_reexecute_request_shape],
  );
  const wizardCacheReexecuteResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_reexecute_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_reexecute_response_shape],
  );
  const wizardCacheRemoveRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_remove_request_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_remove_request_shape],
  );
  const wizardCacheRemoveResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_remove_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_remove_response_shape],
  );
  const wizardCacheRemoveByPrefixRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_request_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_request_shape],
  );
  const wizardCacheRemoveByPrefixResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_response_shape],
  );
  const wizardCacheRemoveByPrefixPreviewRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_request_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_request_shape],
  );
  const wizardCacheRemoveByPrefixPreviewResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_response_shape],
  );
  const wizardCacheRemoveStaleRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_remove_stale_request_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_remove_stale_request_shape],
  );
  const wizardCacheRemoveStaleResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        wizardSchemaQuery.data?.agent_ops_cache_remove_stale_response_shape,
      ),
    [wizardSchemaQuery.data?.agent_ops_cache_remove_stale_response_shape],
  );
  const wizardDuckdbValidationErrorCodes = useMemo(
    () =>
      parseCommaSeparatedList(wizardSchemaQuery.data?.duckdb_query_validation_error_codes),
    [wizardSchemaQuery.data?.duckdb_query_validation_error_codes],
  );
  const wizardCacheValidationErrorCodes = useMemo(
    () =>
      parseCommaSeparatedList(wizardSchemaQuery.data?.cache_validation_error_codes),
    [wizardSchemaQuery.data?.cache_validation_error_codes],
  );
  const wizardSupportedFormulaFunctions = useMemo(
    () => {
      const capabilities = wizardSchemaQuery.data?.formula_capabilities;
      return parseCommaSeparatedList(
        capabilities?.supported_function_list ?? capabilities?.supported_functions,
      );
    },
    [wizardSchemaQuery.data?.formula_capabilities],
  );
  const wizardUnsupportedFormulaBehaviors = useMemo(
    () => {
      const capabilities = wizardSchemaQuery.data?.formula_capabilities;
      return parseCommaSeparatedList(
        capabilities?.unsupported_behavior_list
          ?? capabilities?.unsupported_behaviors,
      );
    },
    [wizardSchemaQuery.data?.formula_capabilities],
  );
  const wizardEndpointMethodsByKey = useMemo(
    () => normalizeEndpointMethodsByKey(wizardSchemaQuery.data?.endpoint_http_methods),
    [wizardSchemaQuery.data?.endpoint_http_methods],
  );
  const wizardEndpointOperationsByKey = useMemo(
    () => normalizeEndpointOperationsByKey(wizardSchemaQuery.data?.endpoint_openapi_operations),
    [wizardSchemaQuery.data?.endpoint_openapi_operations],
  );
  const wizardEndpointOpenApiPathsByKey = useMemo(
    () => normalizeEndpointPathsByKey(wizardSchemaQuery.data?.endpoint_openapi_paths),
    [wizardSchemaQuery.data?.endpoint_openapi_paths],
  );
  const wizardEndpointSummariesByKey = useMemo(
    () => normalizeEndpointSummariesByKey(wizardSchemaQuery.data?.endpoint_summaries),
    [wizardSchemaQuery.data?.endpoint_summaries],
  );
  const wizardSchemaEndpoints = useMemo(
    () => collectSchemaEndpointMetadata(wizardSchemaQuery.data, wizardEndpointOpenApiPathsByKey),
    [wizardEndpointOpenApiPathsByKey, wizardSchemaQuery.data],
  );
  const openApiMethodsByPath = useMemo(
    () => collectOpenApiMethodsByPath(openApiSpecQuery.data),
    [openApiSpecQuery.data],
  );
  const openApiSummariesByPath = useMemo(
    () => collectOpenApiSummariesByPath(openApiSpecQuery.data),
    [openApiSpecQuery.data],
  );
  const wizardSchemaEndpointsWithMethods = useMemo(
    () =>
      wizardSchemaEndpoints.map((entry) => {
        const derivedOpenApiPath = entry.endpoint.split("?").shift() ?? entry.endpoint;
        const schemaOperation = wizardEndpointOperationsByKey[entry.key];
        const schemaOpenApiPath =
          schemaOperation?.path ?? wizardEndpointOpenApiPathsByKey[entry.key] ?? null;
        const schemaMethods =
          schemaOperation?.methods ?? wizardEndpointMethodsByKey[entry.key] ?? [];
        const openApiMethods = openApiMethodsByPath[entry.openApiPath] ?? [];
        const schemaSummary =
          schemaOperation?.summary ?? wizardEndpointSummariesByKey[entry.key] ?? null;
        const openApiSummary = openApiSummariesByPath[entry.openApiPath] ?? null;
        return {
          ...entry,
          derivedOpenApiPath,
          openApiPath: schemaOpenApiPath ?? derivedOpenApiPath,
          openApiPathSource: schemaOperation?.path
            ? "operation"
            : schemaOpenApiPath
              ? "schema"
              : "derived",
          hasPathMismatch:
            Boolean(schemaOpenApiPath) && schemaOpenApiPath !== derivedOpenApiPath,
          methods: schemaMethods.length > 0 ? schemaMethods : openApiMethods,
          schemaMethods,
          openApiMethods,
          openApiSummary,
          summary: schemaSummary ?? openApiSummary,
          summarySource: schemaOperation?.summary
            ? "operation"
            : schemaSummary
              ? "schema"
              : openApiSummary
                ? "openapi"
                : "missing",
          methodSource:
            schemaMethods.length > 0
              ? schemaOperation?.methods
                ? "operation"
                : "schema"
              : openApiMethods.length > 0
                ? "openapi"
                : "missing",
          hasSummaryMismatch:
            Boolean(schemaSummary)
            && Boolean(openApiSummary)
            && schemaSummary !== openApiSummary,
          hasMethodMismatch:
            schemaMethods.length > 0
            && openApiMethods.length > 0
            && !areMethodListsEqual(schemaMethods, openApiMethods),
        };
      }),
    [
      openApiMethodsByPath,
      openApiSummariesByPath,
      wizardEndpointOperationsByKey,
      wizardEndpointOpenApiPathsByKey,
      wizardEndpointMethodsByKey,
      wizardEndpointSummariesByKey,
      wizardSchemaEndpoints,
    ],
  );
  const wizardUnmappedSchemaEndpointKeys = useMemo(
    () =>
      wizardSchemaEndpointsWithMethods
        .filter((entry) => entry.methods.length === 0)
        .map((entry) => entry.key),
    [wizardSchemaEndpointsWithMethods],
  );
  const wizardMethodMismatchEndpointKeys = useMemo(
    () =>
      wizardSchemaEndpointsWithMethods
        .filter((entry) => entry.hasMethodMismatch)
        .map((entry) => entry.key),
    [wizardSchemaEndpointsWithMethods],
  );
  const wizardOperationMetadataFallbackKeys = useMemo(
    () =>
      wizardSchemaEndpointsWithMethods
        .filter((entry) =>
          entry.methodSource !== "operation"
          || entry.summarySource !== "operation"
          || entry.openApiPathSource !== "operation"
        )
        .map((entry) => entry.key),
    [wizardSchemaEndpointsWithMethods],
  );
  const wizardPathMismatchEndpointKeys = useMemo(
    () =>
      wizardSchemaEndpointsWithMethods
        .filter((entry) => entry.hasPathMismatch)
        .map((entry) => entry.key),
    [wizardSchemaEndpointsWithMethods],
  );
  const wizardSummaryMismatchEndpointKeys = useMemo(
    () =>
      wizardSchemaEndpointsWithMethods
        .filter((entry) => entry.hasSummaryMismatch)
        .map((entry) => entry.key),
    [wizardSchemaEndpointsWithMethods],
  );
  const wizardEndpointCoverageStats = useMemo(
    () => buildEndpointCatalogCoverageStats(wizardSchemaEndpointsWithMethods),
    [wizardSchemaEndpointsWithMethods],
  );
  const wizardVisibleSchemaEndpointsWithMethods = useMemo(
    () =>
      filterEndpointCatalogEntries(
        wizardSchemaEndpointsWithMethods,
        wizardEndpointCatalogFilter,
      ),
    [wizardEndpointCatalogFilter, wizardSchemaEndpointsWithMethods],
  );
  const isWizardEndpointCatalogFilterActive = wizardEndpointCatalogFilter.trim().length > 0;
  const wizardEndpointCatalogPayload = useMemo(
    () =>
      ({
        coverage: wizardEndpointCoverageStats,
        endpoints: wizardSchemaEndpointsWithMethods.map((entry) => ({
          key: entry.key,
          endpoint: entry.endpoint,
          openapi_path: entry.openApiPath,
          derived_openapi_path: entry.derivedOpenApiPath,
          methods: entry.methods,
          summary: entry.summary,
          sources: {
            path: entry.openApiPathSource,
            methods: entry.methodSource,
            summary: entry.summarySource,
          },
          operation_metadata: {
            path: entry.openApiPathSource === "operation" ? entry.openApiPath : null,
            methods: entry.schemaMethods,
            summary: entry.summarySource === "operation" ? entry.summary : null,
          },
          openapi_metadata: {
            path: entry.openApiPathSource === "derived" ? null : entry.openApiPath,
            methods: entry.openApiMethods,
            summary: entry.openApiSummary,
          },
          mismatches: {
            path: entry.hasPathMismatch,
            methods: entry.hasMethodMismatch,
            summary: entry.hasSummaryMismatch,
          },
        })),
      }),
    [wizardEndpointCoverageStats, wizardSchemaEndpointsWithMethods],
  );
  const agentWorkbookImportResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(agentSchemaQuery.data?.workbook_import_response_shape),
    [agentSchemaQuery.data?.workbook_import_response_shape],
  );
  const agentWorkbookExportHeaderFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.workbook_export_response_headers_shape,
      ),
    [agentSchemaQuery.data?.workbook_export_response_headers_shape],
  );
  const agentDuckdbQueryRequestFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.duckdb_query_request_shape),
    [agentSchemaQuery.data?.duckdb_query_request_shape],
  );
  const agentDuckdbQueryResponseFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.duckdb_query_response_shape),
    [agentSchemaQuery.data?.duckdb_query_response_shape],
  );
  const agentOpsRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_request_shape
          ?? agentSchemaQuery.data?.request_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_request_shape, agentSchemaQuery.data?.request_shape],
  );
  const agentOpsPreviewRequestFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.agent_ops_preview_request_shape),
    [agentSchemaQuery.data?.agent_ops_preview_request_shape],
  );
  const agentOpsPreviewResponseFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.agent_ops_preview_response_shape),
    [agentSchemaQuery.data?.agent_ops_preview_response_shape],
  );
  const agentOpsResponseFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.agent_ops_response_shape),
    [agentSchemaQuery.data?.agent_ops_response_shape],
  );
  const agentOpsResultErrorFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.agent_ops_result_error_shape),
    [agentSchemaQuery.data?.agent_ops_result_error_shape],
  );
  const agentCacheRemoveRequestFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.agent_ops_cache_remove_request_shape),
    [agentSchemaQuery.data?.agent_ops_cache_remove_request_shape],
  );
  const agentCacheReplayRequestFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.agent_ops_cache_replay_request_shape),
    [agentSchemaQuery.data?.agent_ops_cache_replay_request_shape],
  );
  const agentCacheReplayResponseFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.agent_ops_cache_replay_response_shape),
    [agentSchemaQuery.data?.agent_ops_cache_replay_response_shape],
  );
  const agentCacheReexecuteRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_reexecute_request_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_reexecute_request_shape],
  );
  const agentCacheReexecuteResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_reexecute_response_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_reexecute_response_shape],
  );
  const agentCacheRemoveResponseFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.agent_ops_cache_remove_response_shape),
    [agentSchemaQuery.data?.agent_ops_cache_remove_response_shape],
  );
  const agentCacheRemoveByPrefixRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_request_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_request_shape],
  );
  const agentCacheRemoveByPrefixResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_response_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_response_shape],
  );
  const agentCacheRemoveByPrefixPreviewRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_request_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_request_shape],
  );
  const agentCacheRemoveByPrefixPreviewResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_response_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_response_shape],
  );
  const agentCacheRemoveStaleRequestFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_remove_stale_request_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_remove_stale_request_shape],
  );
  const agentCacheRemoveStaleResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_remove_stale_response_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_remove_stale_response_shape],
  );
  const agentCacheStatsQueryFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_stats_query_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_stats_query_shape],
  );
  const agentCacheEntriesQueryFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_entries_query_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_entries_query_shape],
  );
  const agentCachePrefixesQueryFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_prefixes_query_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_prefixes_query_shape],
  );
  const agentCacheStatsResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_stats_response_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_stats_response_shape],
  );
  const agentCacheEntriesResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_entries_response_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_entries_response_shape],
  );
  const agentCachePrefixesResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_prefixes_response_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_prefixes_response_shape],
  );
  const agentCacheEntryDetailResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_entry_detail_response_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_entry_detail_response_shape],
  );
  const agentCacheClearResponseFields = useMemo(
    () =>
      flattenSchemaShapeEntries(
        agentSchemaQuery.data?.agent_ops_cache_clear_response_shape,
      ),
    [agentSchemaQuery.data?.agent_ops_cache_clear_response_shape],
  );
  const agentFormulaCapabilityFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.formula_capabilities),
    [agentSchemaQuery.data?.formula_capabilities],
  );
  const agentSupportedFormulaFunctions = useMemo(
    () => {
      const capabilities = agentSchemaQuery.data?.formula_capabilities;
      return parseCommaSeparatedList(
        capabilities?.supported_function_list ?? capabilities?.supported_functions,
      );
    },
    [agentSchemaQuery.data?.formula_capabilities],
  );
  const agentUnsupportedFormulaBehaviors = useMemo(
    () => {
      const capabilities = agentSchemaQuery.data?.formula_capabilities;
      return parseCommaSeparatedList(
        capabilities?.unsupported_behavior_list
          ?? capabilities?.unsupported_behaviors,
      );
    },
    [agentSchemaQuery.data?.formula_capabilities],
  );
  const agentEndpointMethodsByKey = useMemo(
    () => normalizeEndpointMethodsByKey(agentSchemaQuery.data?.endpoint_http_methods),
    [agentSchemaQuery.data?.endpoint_http_methods],
  );
  const agentEndpointOperationsByKey = useMemo(
    () => normalizeEndpointOperationsByKey(agentSchemaQuery.data?.endpoint_openapi_operations),
    [agentSchemaQuery.data?.endpoint_openapi_operations],
  );
  const agentEndpointOpenApiPathsByKey = useMemo(
    () => normalizeEndpointPathsByKey(agentSchemaQuery.data?.endpoint_openapi_paths),
    [agentSchemaQuery.data?.endpoint_openapi_paths],
  );
  const agentEndpointSummariesByKey = useMemo(
    () => normalizeEndpointSummariesByKey(agentSchemaQuery.data?.endpoint_summaries),
    [agentSchemaQuery.data?.endpoint_summaries],
  );
  const agentSchemaEndpoints = useMemo(
    () => collectSchemaEndpointMetadata(agentSchemaQuery.data, agentEndpointOpenApiPathsByKey),
    [agentEndpointOpenApiPathsByKey, agentSchemaQuery.data],
  );
  const agentSchemaEndpointsWithMethods = useMemo(
    () =>
      agentSchemaEndpoints.map((entry) => {
        const derivedOpenApiPath = entry.endpoint.split("?").shift() ?? entry.endpoint;
        const schemaOperation = agentEndpointOperationsByKey[entry.key];
        const schemaOpenApiPath =
          schemaOperation?.path ?? agentEndpointOpenApiPathsByKey[entry.key] ?? null;
        const schemaMethods =
          schemaOperation?.methods ?? agentEndpointMethodsByKey[entry.key] ?? [];
        const openApiMethods = openApiMethodsByPath[entry.openApiPath] ?? [];
        const schemaSummary =
          schemaOperation?.summary ?? agentEndpointSummariesByKey[entry.key] ?? null;
        const openApiSummary = openApiSummariesByPath[entry.openApiPath] ?? null;
        return {
          ...entry,
          derivedOpenApiPath,
          openApiPath: schemaOpenApiPath ?? derivedOpenApiPath,
          openApiPathSource: schemaOperation?.path
            ? "operation"
            : schemaOpenApiPath
              ? "schema"
              : "derived",
          hasPathMismatch:
            Boolean(schemaOpenApiPath) && schemaOpenApiPath !== derivedOpenApiPath,
          methods: schemaMethods.length > 0 ? schemaMethods : openApiMethods,
          schemaMethods,
          openApiMethods,
          openApiSummary,
          summary: schemaSummary ?? openApiSummary,
          summarySource: schemaOperation?.summary
            ? "operation"
            : schemaSummary
              ? "schema"
              : openApiSummary
                ? "openapi"
                : "missing",
          methodSource:
            schemaMethods.length > 0
              ? schemaOperation?.methods
                ? "operation"
                : "schema"
              : openApiMethods.length > 0
                ? "openapi"
                : "missing",
          hasSummaryMismatch:
            Boolean(schemaSummary)
            && Boolean(openApiSummary)
            && schemaSummary !== openApiSummary,
          hasMethodMismatch:
            schemaMethods.length > 0
            && openApiMethods.length > 0
            && !areMethodListsEqual(schemaMethods, openApiMethods),
        };
      }),
    [
      agentEndpointMethodsByKey,
      agentEndpointOperationsByKey,
      agentEndpointOpenApiPathsByKey,
      agentEndpointSummariesByKey,
      agentSchemaEndpoints,
      openApiMethodsByPath,
      openApiSummariesByPath,
    ],
  );
  const agentUnmappedSchemaEndpointKeys = useMemo(
    () =>
      agentSchemaEndpointsWithMethods
        .filter((entry) => entry.methods.length === 0)
        .map((entry) => entry.key),
    [agentSchemaEndpointsWithMethods],
  );
  const agentMethodMismatchEndpointKeys = useMemo(
    () =>
      agentSchemaEndpointsWithMethods
        .filter((entry) => entry.hasMethodMismatch)
        .map((entry) => entry.key),
    [agentSchemaEndpointsWithMethods],
  );
  const agentOperationMetadataFallbackKeys = useMemo(
    () =>
      agentSchemaEndpointsWithMethods
        .filter((entry) =>
          entry.methodSource !== "operation"
          || entry.summarySource !== "operation"
          || entry.openApiPathSource !== "operation"
        )
        .map((entry) => entry.key),
    [agentSchemaEndpointsWithMethods],
  );
  const agentPathMismatchEndpointKeys = useMemo(
    () =>
      agentSchemaEndpointsWithMethods
        .filter((entry) => entry.hasPathMismatch)
        .map((entry) => entry.key),
    [agentSchemaEndpointsWithMethods],
  );
  const agentSummaryMismatchEndpointKeys = useMemo(
    () =>
      agentSchemaEndpointsWithMethods
        .filter((entry) => entry.hasSummaryMismatch)
        .map((entry) => entry.key),
    [agentSchemaEndpointsWithMethods],
  );
  const agentEndpointCoverageStats = useMemo(
    () => buildEndpointCatalogCoverageStats(agentSchemaEndpointsWithMethods),
    [agentSchemaEndpointsWithMethods],
  );
  const agentVisibleSchemaEndpointsWithMethods = useMemo(
    () =>
      filterEndpointCatalogEntries(
        agentSchemaEndpointsWithMethods,
        agentEndpointCatalogFilter,
      ),
    [agentEndpointCatalogFilter, agentSchemaEndpointsWithMethods],
  );
  const isAgentEndpointCatalogFilterActive = agentEndpointCatalogFilter.trim().length > 0;
  const agentEndpointCatalogPayload = useMemo(
    () =>
      ({
        coverage: agentEndpointCoverageStats,
        endpoints: agentSchemaEndpointsWithMethods.map((entry) => ({
          key: entry.key,
          endpoint: entry.endpoint,
          openapi_path: entry.openApiPath,
          derived_openapi_path: entry.derivedOpenApiPath,
          methods: entry.methods,
          summary: entry.summary,
          sources: {
            path: entry.openApiPathSource,
            methods: entry.methodSource,
            summary: entry.summarySource,
          },
          operation_metadata: {
            path: entry.openApiPathSource === "operation" ? entry.openApiPath : null,
            methods: entry.schemaMethods,
            summary: entry.summarySource === "operation" ? entry.summary : null,
          },
          openapi_metadata: {
            path: entry.openApiPathSource === "derived" ? null : entry.openApiPath,
            methods: entry.openApiMethods,
            summary: entry.openApiSummary,
          },
          mismatches: {
            path: entry.hasPathMismatch,
            methods: entry.hasMethodMismatch,
            summary: entry.hasSummaryMismatch,
          },
        })),
      }),
    [agentEndpointCoverageStats, agentSchemaEndpointsWithMethods],
  );
  const agentWorkbookImportEventFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.workbook_import_event_shape),
    [agentSchemaQuery.data?.workbook_import_event_shape],
  );
  const agentWorkbookExportEventFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.workbook_export_event_shape),
    [agentSchemaQuery.data?.workbook_export_event_shape],
  );
  const agentWorkbookEventShapeFields = useMemo(
    () => flattenSchemaShapeEntries(agentSchemaQuery.data?.workbook_event_shapes),
    [agentSchemaQuery.data?.workbook_event_shapes],
  );
  const wizardScenarioOps = wizardScenarioOpsQuery.data?.operations ?? [];
  const wizardScenarioOpsSignature =
    wizardScenarioOpsQuery.data?.operations_signature ?? null;
  const wizardPresetOps = wizardPresetOpsQuery.data?.operations ?? [];
  const wizardPresetOpsSignature =
    wizardPresetOpsQuery.data?.operations_signature ?? null;
  const wizardPreviewSource = workbook ? "workbook-scoped" : "global";
  const cacheEntriesData = hasInvalidCacheEntriesMaxAgeInput
    ? null
    : agentOpsCacheEntriesQuery.data;
  const cachePrefixSuggestionsData =
    hasInvalidCacheEntriesMaxAgeInput
    || hasInvalidCachePrefixMinEntryCountInput
    || hasInvalidCachePrefixMinSpanSecondsInput
    || hasInvalidCachePrefixMaxSpanSecondsInput
    || hasInvalidCachePrefixSpanRangeInput
    || hasInvalidCachePrefixSuggestionLimitInput
      ? null
      : agentOpsCachePrefixesQuery.data;
  const cachePrefixSuggestions =
    hasInvalidCacheEntriesMaxAgeInput
    || hasInvalidCachePrefixMinEntryCountInput
    || hasInvalidCachePrefixMinSpanSecondsInput
    || hasInvalidCachePrefixMaxSpanSecondsInput
    || hasInvalidCachePrefixSpanRangeInput
    || hasInvalidCachePrefixSuggestionLimitInput
    ? []
    : (agentOpsCachePrefixesQuery.data?.prefixes ?? []);
  const hasActiveCacheScopeFilters =
    cacheRequestIdPrefix.trim().length > 0
    || typeof normalizedCacheEntriesMaxAgeSeconds === "number"
    || (typeof normalizedCachePrefixMinEntryCount === "number"
      && normalizedCachePrefixMinEntryCount > 1)
    || typeof normalizedCachePrefixMinSpanSeconds === "number"
    || typeof normalizedCachePrefixMaxSpanSeconds === "number";
  const selectedCacheEntryPrefix = selectedCacheEntryDetail
    ? extractRequestIdPrefix(selectedCacheEntryDetail.request_id)
    : null;
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

  function formatIsoTimestamp(value: string): string {
    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
      return value;
    }
    return parsedDate.toLocaleString();
  }

  function formatRelativeAge(value: string): string {
    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
      return "unknown";
    }
    const deltaSeconds = Math.max(
      0,
      Math.floor((Date.now() - parsedDate.getTime()) / 1000),
    );
    if (deltaSeconds < 60) {
      return `${deltaSeconds}s ago`;
    }
    const deltaMinutes = Math.floor(deltaSeconds / 60);
    if (deltaMinutes < 60) {
      return `${deltaMinutes}m ago`;
    }
    const deltaHours = Math.floor(deltaMinutes / 60);
    if (deltaHours < 24) {
      return `${deltaHours}h ago`;
    }
    const deltaDays = Math.floor(deltaHours / 24);
    return `${deltaDays}d ago`;
  }

  function formatDurationSeconds(durationSeconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(durationSeconds));
    if (safeSeconds < 60) {
      return `${safeSeconds}s`;
    }
    const minutes = Math.floor(safeSeconds / 60);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

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

  function resetCachePrefixSuggestionControls(): void {
    setCacheRequestIdPrefix("");
    setCachePrefixMinEntryCount("");
    setCachePrefixMinSpanSeconds("");
    setCachePrefixMaxSpanSeconds("");
    setCachePrefixSortBy(CACHE_PREFIX_SUGGESTIONS_DEFAULT_SORT);
    setCachePrefixSuggestionLimit(CACHE_PREFIX_SUGGESTIONS_DEFAULT_LIMIT);
    setCachePrefixSuggestionsOffset(0);
    setCachePrefixRemovalPreview(null);
    setCacheStaleRemovalPreview(null);
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

  async function refreshAgentOpsCacheQueries(workbookId: string): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["agent-ops-cache", workbookId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["agent-ops-cache-entries", workbookId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["agent-ops-cache-prefixes", workbookId],
      }),
    ]);
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
      const exportedWorkbook = await exportWorkbook(workbook.id);
      const fileName = exportedWorkbook.file_name ?? `${workbook.name}.xlsx`;
      const fileUrl = URL.createObjectURL(exportedWorkbook.blob);
      const anchor = document.createElement("a");
      anchor.href = fileUrl;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(fileUrl);
      setLastExportSummary({
        fileName,
        exportedAt: new Date().toISOString(),
        compatibilityReport: exportedWorkbook.compatibility_report,
      });
      const compatibilitySummary = exportedWorkbook.compatibility_report
        ? ` (preserved ${exportedWorkbook.compatibility_report.preserved.length}, transformed ${exportedWorkbook.compatibility_report.transformed.length}, unsupported ${exportedWorkbook.compatibility_report.unsupported.length})`
        : "";
      setNotice(`Exported ${anchor.download}${compatibilitySummary}.`);
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
      const escapedActiveSheet = activeSheet.replaceAll("'", "''");
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
          op_type: "duckdb_query",
          sql: `SELECT row_index, col_index, raw_value, formula, evaluated_value FROM cells WHERE sheet='${escapedActiveSheet}' ORDER BY row_index, col_index`,
          row_limit: 20,
        },
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
      const duckdbQueryRowCount = response.results
        .find((result) => result.op_type === "duckdb_query" && result.ok)
        ?.data
        .row_count;
      if (typeof duckdbQueryRowCount === "number") {
        setNotice(
          `Agent demo flow completed. DuckDB query sampled ${duckdbQueryRowCount} row${
            duckdbQueryRowCount === 1 ? "" : "s"
          }.`,
        );
      }
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

  async function handleCopyEndpoint(endpoint: string, label: string) {
    try {
      await navigator.clipboard.writeText(endpoint);
      clearUiError();
      setNotice(`Copied ${label} endpoint ${endpoint}.`);
    } catch (error) {
      applyUiError(error, `Failed to copy ${label} endpoint.`);
    }
  }

  async function handleCopyWizardEndpointCatalog() {
    if (wizardEndpointCatalogPayload.endpoints.length === 0) {
      return;
    }
    setIsCopyingWizardEndpointCatalog(true);
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            schema: "wizard",
            endpoint_count: wizardEndpointCatalogPayload.endpoints.length,
            ...wizardEndpointCatalogPayload,
          },
          null,
          2,
        ),
      );
      clearUiError();
      setNotice(
        `Copied wizard endpoint catalog metadata (${wizardEndpointCatalogPayload.endpoints.length} endpoints).`,
      );
    } catch (error) {
      applyUiError(error, "Failed to copy wizard endpoint catalog metadata.");
    } finally {
      setIsCopyingWizardEndpointCatalog(false);
    }
  }

  async function handleCopyAgentEndpointCatalog() {
    if (agentEndpointCatalogPayload.endpoints.length === 0) {
      return;
    }
    setIsCopyingAgentEndpointCatalog(true);
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            schema: "agent",
            endpoint_count: agentEndpointCatalogPayload.endpoints.length,
            ...agentEndpointCatalogPayload,
          },
          null,
          2,
        ),
      );
      clearUiError();
      setNotice(
        `Copied agent endpoint catalog metadata (${agentEndpointCatalogPayload.endpoints.length} endpoints).`,
      );
    } catch (error) {
      applyUiError(error, "Failed to copy agent endpoint catalog metadata.");
    } finally {
      setIsCopyingAgentEndpointCatalog(false);
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
      setLastAgentRequestId(
        response.cached_response.request_id ?? lastAgentRequestId,
      );
      setLastOperationsSignature(
        response.cached_response.operations_signature ?? null,
      );
      setLastServedFromCache(response.cached_response.served_from_cache ?? null);
      setLastAgentOps(response.cached_response.results);
      setNotice(
        response.cached_response.served_from_cache
          ? `Replay served from idempotency cache (cached at ${formatIsoTimestamp(response.cached_at)} · ${formatRelativeAge(response.cached_at)}).`
          : `Replay executed fresh (cache miss; source cached at ${formatIsoTimestamp(response.cached_at)} · ${formatRelativeAge(response.cached_at)}).`,
      );
      await refreshAgentOpsCacheQueries(workbook.id);
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
      setNotice(
        hasActiveCacheScopeFilters
          ? `Cleared ${response.cleared_entries} cached request entries across all scopes.`
          : `Cleared ${response.cleared_entries} cached request entries.`,
      );
      await refreshAgentOpsCacheQueries(workbook.id);
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
      setNotice(
        `Replayed cached response for request_id ${requestId} (cached at ${formatIsoTimestamp(response.cached_at)} · ${formatRelativeAge(response.cached_at)}).`,
      );
      await refreshAgentOpsCacheQueries(workbook.id);
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
        refreshAgentOpsCacheQueries(workbook.id),
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
      await refreshAgentOpsCacheQueries(workbook.id);
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
    if (hasInvalidCacheEntriesMaxAgeInput) {
      setUiError("older-than filter must be a positive integer (seconds).");
      setUiErrorCode("INVALID_MAX_AGE_SECONDS");
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
        normalizedCacheEntriesMaxAgeSeconds,
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
        }${
          response.unscoped_matched_entries !== response.removed_entries
            ? ` (global matches ${response.unscoped_matched_entries})`
            : ""
        } for prefix ${response.request_id_prefix}${
          typeof response.max_age_seconds === "number"
            ? ` (older than ${response.max_age_seconds}s)`
            : ""
        }${
          response.cutoff_timestamp
            ? ` cutoff ${formatIsoTimestamp(response.cutoff_timestamp)} (${formatRelativeAge(response.cutoff_timestamp)})`
            : ""
        }.`,
      );
      await refreshAgentOpsCacheQueries(workbook.id);
    } catch (error) {
      applyUiError(error, "Failed to remove cache entries by prefix.");
    } finally {
      setIsRemovingCacheByPrefix(false);
    }
  }

  async function handlePreviewRemoveCacheEntriesByPrefix(prefixOverride?: string) {
    if (!workbook) {
      return;
    }
    if (hasInvalidCacheRemovePreviewSampleLimitInput) {
      setUiError("prefix preview sample limit must be a positive integer.");
      setUiErrorCode("INVALID_SAMPLE_LIMIT");
      return;
    }
    if (hasInvalidCacheEntriesMaxAgeInput) {
      setUiError("older-than filter must be a positive integer (seconds).");
      setUiErrorCode("INVALID_MAX_AGE_SECONDS");
      return;
    }
    const normalizedPrefix = (prefixOverride ?? cacheRequestIdPrefix).trim();
    if (!normalizedPrefix) {
      return;
    }
    const normalizedSampleLimit =
      typeof normalizedCacheRemovePreviewSampleLimit === "number"
        ? Math.min(normalizedCacheRemovePreviewSampleLimit, CACHE_PREVIEW_MAX_SAMPLE_LIMIT)
        : undefined;
    setIsPreviewingCacheByPrefix(true);
    try {
      clearUiError();
      const preview = await previewRemoveAgentOpsCacheEntriesByPrefix(
        workbook.id,
        normalizedPrefix,
        normalizedSampleLimit,
        normalizedCacheEntriesMaxAgeSeconds,
      );
      setCachePrefixRemovalPreview({
        requestIdPrefix: preview.request_id_prefix,
        maxAgeSeconds: preview.max_age_seconds,
        cutoffTimestamp: preview.cutoff_timestamp,
        matchedEntries: preview.matched_entries,
        unscopedMatchedEntries: preview.unscoped_matched_entries,
        sampleLimit: preview.sample_limit,
        sampleRequestIds: preview.sample_request_ids,
      });
      setNotice(
        `Previewed ${preview.matched_entries} cache entr${
          preview.matched_entries === 1 ? "y" : "ies"
        }${
          preview.unscoped_matched_entries !== preview.matched_entries
            ? ` (global matches ${preview.unscoped_matched_entries})`
            : ""
        } for prefix ${preview.request_id_prefix}${
          typeof preview.max_age_seconds === "number"
            ? ` (older than ${preview.max_age_seconds}s)`
            : ""
        }${
          preview.cutoff_timestamp
            ? ` cutoff ${formatIsoTimestamp(preview.cutoff_timestamp)} (${formatRelativeAge(preview.cutoff_timestamp)})`
            : ""
        }.`,
      );
    } catch (error) {
      applyUiError(error, "Failed to preview cache removal by prefix.");
    } finally {
      setIsPreviewingCacheByPrefix(false);
    }
  }

  function parseStaleMaxAgeSecondsInput(): number | null {
    if (typeof normalizedCacheStaleMaxAgeSeconds !== "number") {
      setUiError("max_age_seconds must be a positive integer.");
      setUiErrorCode("INVALID_MAX_AGE_SECONDS");
      return null;
    }
    return normalizedCacheStaleMaxAgeSeconds;
  }

  async function handlePreviewRemoveStaleCacheEntries() {
    if (!workbook) {
      return;
    }
    if (hasInvalidCacheStalePreviewSampleLimitInput) {
      setUiError("stale preview sample limit must be a positive integer.");
      setUiErrorCode("INVALID_SAMPLE_LIMIT");
      return;
    }
    const maxAgeSeconds = parseStaleMaxAgeSecondsInput();
    if (maxAgeSeconds === null) {
      return;
    }
    const normalizedPrefix = cacheRequestIdPrefix.trim() || undefined;
    const normalizedSampleLimit =
      typeof normalizedCacheStalePreviewSampleLimit === "number"
        ? Math.min(normalizedCacheStalePreviewSampleLimit, CACHE_PREVIEW_MAX_SAMPLE_LIMIT)
        : undefined;
    setIsPreviewingStaleCache(true);
    try {
      clearUiError();
      const preview = await removeStaleAgentOpsCacheEntries(workbook.id, {
        request_id_prefix: normalizedPrefix,
        max_age_seconds: maxAgeSeconds,
        dry_run: true,
        sample_limit: normalizedSampleLimit,
      });
      setCacheStaleRemovalPreview({
        requestIdPrefix: preview.request_id_prefix,
        maxAgeSeconds: preview.max_age_seconds,
        cutoffTimestamp: preview.cutoff_timestamp,
        matchedEntries: preview.matched_entries,
        unscopedMatchedEntries: preview.unscoped_matched_entries,
        sampleLimit: preview.sample_limit,
        sampleRequestIds: preview.sample_request_ids,
      });
      setNotice(
        `Previewed ${preview.matched_entries} stale cache entr${
          preview.matched_entries === 1 ? "y" : "ies"
        }${
          preview.unscoped_matched_entries !== preview.matched_entries
            ? ` (global ${preview.unscoped_matched_entries})`
            : ""
        } older than ${preview.max_age_seconds}s${
          preview.request_id_prefix
            ? ` for prefix ${preview.request_id_prefix}`
            : ""
        }${
          preview.cutoff_timestamp
            ? ` cutoff ${formatIsoTimestamp(preview.cutoff_timestamp)} (${formatRelativeAge(preview.cutoff_timestamp)})`
            : ""
        }.`,
      );
    } catch (error) {
      applyUiError(error, "Failed to preview stale cache removal.");
    } finally {
      setIsPreviewingStaleCache(false);
    }
  }

  async function handleRemoveStaleCacheEntries() {
    if (!workbook) {
      return;
    }
    if (hasInvalidCacheStalePreviewSampleLimitInput) {
      setUiError("stale preview sample limit must be a positive integer.");
      setUiErrorCode("INVALID_SAMPLE_LIMIT");
      return;
    }
    const maxAgeSeconds = parseStaleMaxAgeSecondsInput();
    if (maxAgeSeconds === null) {
      return;
    }
    const normalizedPrefix = cacheRequestIdPrefix.trim() || undefined;
    const normalizedSampleLimit =
      typeof normalizedCacheStalePreviewSampleLimit === "number"
        ? Math.min(normalizedCacheStalePreviewSampleLimit, CACHE_PREVIEW_MAX_SAMPLE_LIMIT)
        : undefined;
    setIsRemovingStaleCache(true);
    try {
      clearUiError();
      const response = await removeStaleAgentOpsCacheEntries(workbook.id, {
        request_id_prefix: normalizedPrefix,
        max_age_seconds: maxAgeSeconds,
        dry_run: false,
        sample_limit: normalizedSampleLimit,
      });
      if (response.removed_entries > 0) {
        setSelectedCacheEntryDetail(null);
      }
      setCacheEntriesOffset(0);
      setCachePrefixRemovalPreview(null);
      setCacheStaleRemovalPreview(null);
      setNotice(
        `Removed ${response.removed_entries} stale cache entr${
          response.removed_entries === 1 ? "y" : "ies"
        }${
          response.unscoped_matched_entries !== response.matched_entries
            ? ` (global stale matches ${response.unscoped_matched_entries})`
            : ""
        } older than ${response.max_age_seconds}s${
          response.request_id_prefix
            ? ` for prefix ${response.request_id_prefix}`
            : ""
        }${
          response.cutoff_timestamp
            ? ` cutoff ${formatIsoTimestamp(response.cutoff_timestamp)} (${formatRelativeAge(response.cutoff_timestamp)})`
            : ""
        }.`,
      );
      await refreshAgentOpsCacheQueries(workbook.id);
    } catch (error) {
      applyUiError(error, "Failed to remove stale cache entries.");
    } finally {
      setIsRemovingStaleCache(false);
    }
  }

  async function handleRunDuckdbQuery() {
    if (!workbook) {
      return;
    }
    const normalizedSql = duckdbQuerySql.trim();
    if (!normalizedSql) {
      setUiError("DuckDB query SQL cannot be blank.");
      setUiErrorCode("INVALID_QUERY_SQL");
      return;
    }
    if (hasInvalidDuckdbQueryRowLimitInput) {
      setUiError("DuckDB row limit must be a positive integer.");
      setUiErrorCode("INVALID_QUERY_ROW_LIMIT");
      return;
    }
    setIsRunningDuckdbQuery(true);
    try {
      clearUiError();
      const response = await runDuckdbQuery(
        workbook.id,
        normalizedSql,
        effectiveDuckdbQueryRowLimit,
      );
      setDuckdbQueryResult(response);
      setNotice(
        `DuckDB query returned ${response.row_count} row${
          response.row_count === 1 ? "" : "s"
        }${
          response.truncated
            ? ` (truncated to ${response.row_limit})`
            : ""
        }.`,
      );
    } catch (error) {
      applyUiError(error, "Failed to execute DuckDB query.");
    } finally {
      setIsRunningDuckdbQuery(false);
    }
  }

  async function handleRunDuckdbQueryViaAgentOps() {
    if (!workbook) {
      return;
    }
    const normalizedSql = duckdbQuerySql.trim();
    if (!normalizedSql) {
      setUiError("DuckDB query SQL cannot be blank.");
      setUiErrorCode("INVALID_QUERY_SQL");
      return;
    }
    if (hasInvalidDuckdbQueryRowLimitInput) {
      setUiError("DuckDB row limit must be a positive integer.");
      setUiErrorCode("INVALID_QUERY_ROW_LIMIT");
      return;
    }

    setIsRunningDuckdbOpsQuery(true);
    try {
      clearUiError();
      const operations: AgentOperationPreview[] = [
        {
          op_type: "duckdb_query",
          sql: normalizedSql,
          row_limit: effectiveDuckdbQueryRowLimit,
        },
      ];
      const signedPlan = await signOperationsForExecution(operations);
      const response = await runAgentOps(workbook.id, {
        request_id: `duckdb-ops-query-${Date.now()}`,
        actor: "ui-duckdb-query",
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

      const queryResult = response.results.find(
        (result) => result.op_type === "duckdb_query",
      );
      if (!queryResult) {
        setDuckdbQueryResult(null);
        setNotice("DuckDB agent/ops query completed without a duckdb_query result entry.");
        await refreshWorkbookRunQueries(workbook.id, activeSheet);
        return;
      }
      if (!queryResult.ok) {
        setDuckdbQueryResult(null);
        const errorMessage =
          typeof queryResult.data.error_message === "string"
            ? queryResult.data.error_message
            : "DuckDB agent/ops query failed.";
        setUiError(errorMessage);
        setUiErrorCode(
          typeof queryResult.data.error_code === "string"
            ? queryResult.data.error_code
            : null,
        );
        await refreshWorkbookRunQueries(workbook.id, activeSheet);
        return;
      }

      const parsedQueryResponse = parseDuckdbQueryResponseFromOperationData(
        queryResult.data,
      );
      if (!parsedQueryResponse) {
        setDuckdbQueryResult(null);
        setNotice(
          "DuckDB agent/ops query completed, but result payload could not be parsed.",
        );
        await refreshWorkbookRunQueries(workbook.id, activeSheet);
        return;
      }
      setDuckdbQueryResult(parsedQueryResponse);
      setNotice(
        `DuckDB agent/ops query returned ${parsedQueryResponse.row_count} row${
          parsedQueryResponse.row_count === 1 ? "" : "s"
        }${
          parsedQueryResponse.truncated
            ? ` (truncated to ${parsedQueryResponse.row_limit})`
            : ""
        }.`,
      );
      await refreshWorkbookRunQueries(workbook.id, activeSheet);
    } catch (error) {
      if (
        error instanceof Error &&
        (await handleSignatureMismatchRecovery(error))
      ) {
        return;
      }
      applyUiError(error, "Failed to execute DuckDB query via agent/ops.");
    } finally {
      setIsRunningDuckdbOpsQuery(false);
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
      const latestImportSummary = response.import
        ? toLatestImportSummary(response.import)
        : null;
      setLastWizardImportSummary(latestImportSummary);
      setDuckdbQueryResult(null);
      setNotice(
        latestImportSummary
          ? `Wizard scenario ${response.scenario} completed for ${response.workbook.name} (${formatLatestImportSummary(latestImportSummary)}).`
          : `Wizard scenario ${response.scenario} completed for ${response.workbook.name} (${response.results.length} operation result${response.results.length === 1 ? "" : "s"}).`,
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
                DuckDB Query (read-only)
              </p>
              <span className="text-[11px] text-slate-500">
                SELECT/WITH only · response values returned as string/null
              </span>
            </div>
            <textarea
              value={duckdbQuerySql}
              onChange={(event) => setDuckdbQuerySql(event.target.value)}
              className="mb-2 h-20 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-cyan-400"
              spellCheck={false}
              placeholder="SELECT sheet, row_index, col_index, raw_value, formula, evaluated_value FROM cells ORDER BY row_index, col_index"
            />
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] text-slate-400">
                row limit
                <input
                  value={duckdbQueryRowLimit}
                  onChange={(event) => setDuckdbQueryRowLimit(event.target.value)}
                  className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-cyan-400"
                  placeholder="200"
                />
              </label>
              <button
                onClick={handleRunDuckdbQuery}
                disabled={
                  !workbook
                  || isRunningDuckdbQuery
                  || isRunningDuckdbOpsQuery
                  || hasInvalidDuckdbQueryRowLimitInput
                }
                className="rounded bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-40"
              >
                {isRunningDuckdbQuery ? "Running query..." : "Run Query"}
              </button>
              <button
                onClick={handleRunDuckdbQueryViaAgentOps}
                disabled={
                  !workbook
                  || isRunningDuckdbOpsQuery
                  || isRunningDuckdbQuery
                  || hasInvalidDuckdbQueryRowLimitInput
                }
                className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              >
                {isRunningDuckdbOpsQuery
                  ? "Running via agent/ops..."
                  : "Run via agent/ops"}
              </button>
              <button
                onClick={() => setDuckdbQueryResult(null)}
                disabled={!duckdbQueryResult}
                className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
              >
                Clear Result
              </button>
            </div>
            {hasInvalidDuckdbQueryRowLimitInput ? (
              <p className="mb-2 text-[10px] text-rose-300">
                row limit must be a positive integer.
              </p>
            ) : null}
            {isDuckdbQueryRowLimitCapped ? (
              <p className="mb-2 text-[10px] text-amber-300">
                row limit will be capped to 1000.
              </p>
            ) : null}
            {duckdbQueryResult ? (
              <div className="rounded border border-slate-800 bg-slate-900/70 p-2">
                <p className="mb-2 text-[11px] text-slate-500">
                  rows: {duckdbQueryResult.row_count} / limit {duckdbQueryResult.row_limit}
                  {duckdbQueryResult.truncated ? " (truncated)" : ""}
                </p>
                {duckdbQueryResult.columns.length > 0 ? (
                  <div className="max-h-44 overflow-auto rounded border border-slate-800">
                    <table className="min-w-full border-collapse text-[11px]">
                      <thead className="bg-slate-900/90 text-slate-400">
                        <tr>
                          {duckdbQueryResult.columns.map((columnName, columnIndex) => (
                            <th
                              key={`duckdb-column-${columnIndex}-${columnName}`}
                              className="border-b border-slate-800 px-2 py-1 text-left font-medium"
                            >
                              {columnName}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {duckdbQueryResult.rows.map((rowValues, rowIndex) => (
                          <tr
                            key={`duckdb-row-${rowIndex}`}
                            className="border-b border-slate-900/60 text-slate-200"
                          >
                            {rowValues.map((value, columnIndex) => (
                              <td
                                key={`duckdb-cell-${rowIndex}-${columnIndex}`}
                                className="px-2 py-1 font-mono"
                              >
                                {value ?? "∅"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500">
                    Query returned no columns.
                  </p>
                )}
              </div>
            ) : null}
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
            {wizardSchemaQuery.data?.health_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                health endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.health_endpoint}
                </span>
                <button
                  onClick={() => {
                    void handleCopyEndpoint(
                      wizardSchemaQuery.data?.health_endpoint ?? "",
                      "wizard health",
                    );
                  }}
                  className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                >
                  copy
                </button>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.openapi_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                openapi endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.openapi_endpoint}
                </span>
                <button
                  onClick={() => {
                    void handleCopyEndpoint(
                      wizardSchemaQuery.data?.openapi_endpoint ?? "",
                      "wizard openapi",
                    );
                  }}
                  className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                >
                  copy
                </button>
              </p>
            ) : null}
            {wizardSchemaEndpointsWithMethods.length > 0 ? (
              <details className="mb-2 rounded border border-slate-800 bg-slate-950/60 p-2">
                <summary className="cursor-pointer text-[11px] text-slate-400">
                  discovered endpoint catalog ({wizardVisibleSchemaEndpointsWithMethods.length}
                  {isWizardEndpointCatalogFilterActive
                    ? ` of ${wizardSchemaEndpointsWithMethods.length}`
                    : ""}
                  )
                </summary>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <label className="flex items-center gap-2 text-[11px] text-slate-400">
                    filter:
                    <input
                      type="text"
                      value={wizardEndpointCatalogFilter}
                      onChange={(event) => {
                        setWizardEndpointCatalogFilter(event.target.value);
                      }}
                      placeholder="key, endpoint, path, summary"
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500 sm:w-72"
                    />
                  </label>
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <span className="text-[10px] text-slate-500">
                      showing {wizardVisibleSchemaEndpointsWithMethods.length}
                      /{wizardSchemaEndpointsWithMethods.length}
                    </span>
                    <button
                      onClick={handleCopyWizardEndpointCatalog}
                      disabled={isCopyingWizardEndpointCatalog}
                      className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                    >
                      {isCopyingWizardEndpointCatalog
                        ? "Copying..."
                        : "Copy endpoint catalog JSON"}
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-slate-400">
                  coverage: operation methods{" "}
                  <span className="font-mono text-slate-300">
                    {wizardEndpointCoverageStats.methodOperationBacked}
                  </span>
                  /{wizardEndpointCoverageStats.total}, operation summaries{" "}
                  <span className="font-mono text-slate-300">
                    {wizardEndpointCoverageStats.summaryOperationBacked}
                  </span>
                  /{wizardEndpointCoverageStats.total}, operation paths{" "}
                  <span className="font-mono text-slate-300">
                    {wizardEndpointCoverageStats.pathOperationBacked}
                  </span>
                  /{wizardEndpointCoverageStats.total}
                </p>
                {wizardUnmappedSchemaEndpointKeys.length > 0 ? (
                  <p className="mt-2 text-[11px] text-amber-300">
                    openapi method mapping missing for:{" "}
                    <span className="font-mono">
                      {wizardUnmappedSchemaEndpointKeys.join(", ")}
                    </span>
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] text-emerald-300">
                    openapi method mapping available for all discovered endpoints.
                  </p>
                )}
                {openApiSpecQuery.isError ? (
                  <p className="mt-1 text-[11px] text-rose-300">
                    openapi sync check unavailable: failed to load /v1/openapi.
                  </p>
                ) : null}
                {wizardMethodMismatchEndpointKeys.length > 0 ? (
                  <p className="mt-1 text-[11px] text-rose-300">
                    schema/openapi method mismatch for:{" "}
                    <span className="font-mono">
                      {wizardMethodMismatchEndpointKeys.join(", ")}
                    </span>
                  </p>
                ) : null}
                {wizardOperationMetadataFallbackKeys.length > 0 ? (
                  <p className="mt-1 text-[11px] text-amber-300">
                    operation metadata fallback used for:{" "}
                    <span className="font-mono">
                      {wizardOperationMetadataFallbackKeys.join(", ")}
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-emerald-300">
                    operation metadata available for all discovered endpoints.
                  </p>
                )}
                {wizardPathMismatchEndpointKeys.length > 0 ? (
                  <p className="mt-1 text-[11px] text-rose-300">
                    schema/derived openapi path mismatch for:{" "}
                    <span className="font-mono">
                      {wizardPathMismatchEndpointKeys.join(", ")}
                    </span>
                  </p>
                ) : null}
                {wizardSummaryMismatchEndpointKeys.length > 0 ? (
                  <p className="mt-1 text-[11px] text-rose-300">
                    schema/openapi summary mismatch for:{" "}
                    <span className="font-mono">
                      {wizardSummaryMismatchEndpointKeys.join(", ")}
                    </span>
                  </p>
                ) : null}
                <div className="mt-2 space-y-1">
                  {wizardVisibleSchemaEndpointsWithMethods.length > 0 ? (
                    wizardVisibleSchemaEndpointsWithMethods.map((entry) => (
                      <div
                        key={`wizard-endpoint-catalog-${entry.key}`}
                        className="text-[11px] text-slate-500"
                      >
                        <p>
                          {entry.methods.length > 0 ? (
                            <span className="mr-1.5 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-slate-300">
                              {entry.methods.join("|")}
                            </span>
                          ) : null}
                          {entry.key}:{" "}
                          <span className="font-mono text-slate-300">{entry.endpoint}</span>
                          <span className="ml-2 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-slate-300">
                            {entry.methodSource}
                          </span>
                          <span className="ml-1 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-slate-300">
                            {entry.summarySource}
                          </span>
                          <span className="ml-1 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-slate-300">
                            {entry.openApiPathSource}
                          </span>
                          {entry.hasMethodMismatch ? (
                            <span className="ml-1 rounded border border-rose-500/40 bg-rose-500/10 px-1 py-0.5 text-[10px] text-rose-200">
                              method mismatch
                            </span>
                          ) : null}
                          {entry.hasPathMismatch ? (
                            <span className="ml-1 rounded border border-rose-500/40 bg-rose-500/10 px-1 py-0.5 text-[10px] text-rose-200">
                              path mismatch
                            </span>
                          ) : null}
                          {entry.hasSummaryMismatch ? (
                            <span className="ml-1 rounded border border-rose-500/40 bg-rose-500/10 px-1 py-0.5 text-[10px] text-rose-200">
                              summary mismatch
                            </span>
                          ) : null}
                          <button
                            onClick={() => {
                              void handleCopyEndpoint(entry.endpoint, `wizard ${entry.key}`);
                            }}
                            className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                          >
                            copy
                          </button>
                        </p>
                        {entry.summary ? (
                          <p className="ml-1 text-[10px] text-slate-400">
                            summary: {entry.summary}
                          </p>
                        ) : null}
                        {entry.hasMethodMismatch ? (
                          <p className="ml-1 text-[10px] text-rose-300">
                            methods (schema vs openapi):{" "}
                            <span className="font-mono">
                              {(entry.schemaMethods.length > 0
                                ? entry.schemaMethods
                                : ["∅"]).join("|")}
                            </span>{" "}
                            vs{" "}
                            <span className="font-mono">
                              {(entry.openApiMethods.length > 0
                                ? entry.openApiMethods
                                : ["∅"]).join("|")}
                            </span>
                          </p>
                        ) : null}
                        {entry.hasSummaryMismatch ? (
                          <p className="ml-1 text-[10px] text-rose-300">
                            summary (schema vs openapi):{" "}
                            <span className="font-mono">
                              {entry.summary ?? "∅"}
                            </span>{" "}
                            vs{" "}
                            <span className="font-mono">
                              {entry.openApiSummary ?? "∅"}
                            </span>
                          </p>
                        ) : null}
                        <p className="ml-1 text-[10px] text-slate-500">
                          openapi path:{" "}
                          <span className="font-mono text-slate-400">{entry.openApiPath}</span>
                          <button
                            onClick={() => {
                              void handleCopyEndpoint(
                                entry.openApiPath,
                                `wizard ${entry.key} openapi path`,
                              );
                            }}
                            className="ml-2 rounded border border-slate-700 px-1 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                          >
                            copy path
                          </button>
                        </p>
                        {entry.hasPathMismatch ? (
                          <p className="ml-1 text-[10px] text-rose-300">
                            path (schema vs derived):{" "}
                            <span className="font-mono">{entry.openApiPath}</span> vs{" "}
                            <span className="font-mono">{entry.derivedOpenApiPath}</span>
                          </p>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <p className="text-[11px] text-slate-500">
                      no endpoints match the current filter.
                    </p>
                  )}
                </div>
              </details>
            ) : null}
            {wizardSchemaQuery.data?.signature_error_codes?.length ? (
              <p className="mb-2 text-[11px] text-slate-500">
                signature codes:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.signature_error_codes.join(", ")}
                </span>
              </p>
            ) : null}
            {wizardRunResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                run response fields:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardRunResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardAgentOpsResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                agent ops response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardAgentOpsResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardImportResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                import response fields:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardImportResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardOperationsPreviewResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                scenario operations preview shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardOperationsPreviewResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                agent ops execute endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_endpoint}
                </span>
                <button
                  onClick={() => {
                    void handleCopyEndpoint(
                      wizardSchemaQuery.data?.agent_ops_endpoint ?? "",
                      "wizard agent ops execute",
                    );
                  }}
                  className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                >
                  copy
                </button>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_preview_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                agent ops preview endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_preview_endpoint}
                </span>
                <button
                  onClick={() => {
                    void handleCopyEndpoint(
                      wizardSchemaQuery.data?.agent_ops_preview_endpoint ?? "",
                      "wizard agent ops preview",
                    );
                  }}
                  className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                >
                  copy
                </button>
              </p>
            ) : null}
            {wizardAgentOpsRequestFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                agent ops execute request shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardAgentOpsRequestFields)}
                </span>
              </p>
            ) : null}
            {wizardAgentOpsPreviewRequestFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                agent ops preview request shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardAgentOpsPreviewRequestFields)}
                </span>
              </p>
            ) : null}
            {wizardAgentOpsPreviewResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                agent ops preview response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardAgentOpsPreviewResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardFormulaCapabilityFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                formula capabilities:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardFormulaCapabilityFields)}
                </span>
              </p>
            ) : null}
            {wizardSupportedFormulaFunctions.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                supported formula functions ({wizardSupportedFormulaFunctions.length}):{" "}
                <span className="font-mono text-slate-300">
                  {wizardSupportedFormulaFunctions.join(", ")}
                </span>
              </p>
            ) : null}
            {wizardUnsupportedFormulaBehaviors.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                unsupported formula behaviors:{" "}
                <span className="font-mono text-slate-300">
                  {wizardUnsupportedFormulaBehaviors.join(" | ")}
                </span>
              </p>
            ) : null}
            {wizardDuckdbQueryRequestFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard duckdb query request shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardDuckdbQueryRequestFields)}
                </span>
              </p>
            ) : null}
            {wizardDuckdbQueryResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard duckdb query response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardDuckdbQueryResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardDuckdbValidationErrorCodes.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard duckdb validation codes:{" "}
                <span className="font-mono text-slate-300">
                  {wizardDuckdbValidationErrorCodes.join(", ")}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_stats_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache stats endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_stats_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_entries_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache entries endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_entries_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_prefixes_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache prefixes endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_prefixes_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_entry_detail_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache entry-detail endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_entry_detail_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_clear_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache clear endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_clear_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_replay_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache replay endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_replay_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_reexecute_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache reexecute endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_reexecute_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_remove_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_remove_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove-by-prefix endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_remove_by_prefix_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_remove_by_prefix_preview_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove-by-prefix preview endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_remove_by_prefix_preview_endpoint}
                </span>
              </p>
            ) : null}
            {wizardSchemaQuery.data?.agent_ops_cache_remove_stale_endpoint ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove-stale endpoint:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_cache_remove_stale_endpoint}
                </span>
              </p>
            ) : null}
            {wizardCacheReplayRequestFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache replay request shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheReplayRequestFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheReplayResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache replay response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheReplayResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheReexecuteRequestFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache reexecute request shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheReexecuteRequestFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheReexecuteResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache reexecute response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheReexecuteResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheStatsQueryFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache stats query shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheStatsQueryFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheEntriesQueryFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache entries query shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheEntriesQueryFields)}
                </span>
              </p>
            ) : null}
            {wizardCachePrefixesQueryFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache prefixes query shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCachePrefixesQueryFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheStatsResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache stats response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheStatsResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheEntriesResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache entries response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheEntriesResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardCachePrefixesResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache prefixes response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCachePrefixesResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheEntryDetailResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache entry-detail response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheEntryDetailResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheClearResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache clear response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheClearResponseFields)}
                </span>
              </p>
            ) : null}
            {typeof wizardSchemaQuery.data?.agent_ops_idempotency_cache_max_entries === "number" ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache max entries:{" "}
                <span className="font-mono text-slate-300">
                  {wizardSchemaQuery.data.agent_ops_idempotency_cache_max_entries}
                </span>
              </p>
            ) : null}
            {wizardCacheRemoveRequestFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove request shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheRemoveRequestFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheRemoveResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheRemoveResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheRemoveByPrefixRequestFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove-by-prefix request shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheRemoveByPrefixRequestFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheRemoveByPrefixResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove-by-prefix response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheRemoveByPrefixResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheRemoveByPrefixPreviewRequestFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove-by-prefix preview request shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(
                    wizardCacheRemoveByPrefixPreviewRequestFields,
                  )}
                </span>
              </p>
            ) : null}
            {wizardCacheRemoveByPrefixPreviewResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove-by-prefix preview response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(
                    wizardCacheRemoveByPrefixPreviewResponseFields,
                  )}
                </span>
              </p>
            ) : null}
            {wizardCacheRemoveStaleRequestFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove-stale request shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheRemoveStaleRequestFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheRemoveStaleResponseFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache remove-stale response shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardCacheRemoveStaleResponseFields)}
                </span>
              </p>
            ) : null}
            {wizardCacheValidationErrorCodes.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard cache validation codes:{" "}
                <span className="font-mono text-slate-300">
                  {wizardCacheValidationErrorCodes.join(", ")}
                </span>
              </p>
            ) : null}
            {wizardOpsResultErrorFields.length > 0 ? (
              <p className="mb-2 text-[11px] text-slate-500">
                wizard operation error shape:{" "}
                <span className="font-mono text-slate-300">
                  {formatSchemaShapeEntries(wizardOpsResultErrorFields)}
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
            {agentSchemaQuery.data?.health_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                health endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.health_endpoint}
                </span>
                <button
                  onClick={() => {
                    void handleCopyEndpoint(
                      agentSchemaQuery.data?.health_endpoint ?? "",
                      "agent health",
                    );
                  }}
                  className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                >
                  copy
                </button>
              </p>
            ) : null}
            {agentSchemaQuery.data?.openapi_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                openapi endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.openapi_endpoint}
                </span>
                <button
                  onClick={() => {
                    void handleCopyEndpoint(
                      agentSchemaQuery.data?.openapi_endpoint ?? "",
                      "agent openapi",
                    );
                  }}
                  className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                >
                  copy
                </button>
              </p>
            ) : null}
            {agentSchemaEndpointsWithMethods.length > 0 ? (
              <details className="mb-2 rounded border border-slate-800 bg-slate-950/60 p-2">
                <summary className="cursor-pointer text-xs text-slate-400">
                  discovered endpoint catalog ({agentVisibleSchemaEndpointsWithMethods.length}
                  {isAgentEndpointCatalogFilterActive
                    ? ` of ${agentSchemaEndpointsWithMethods.length}`
                    : ""}
                  )
                </summary>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <label className="flex items-center gap-2 text-xs text-slate-400">
                    filter:
                    <input
                      type="text"
                      value={agentEndpointCatalogFilter}
                      onChange={(event) => {
                        setAgentEndpointCatalogFilter(event.target.value);
                      }}
                      placeholder="key, endpoint, path, summary"
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500 sm:w-72"
                    />
                  </label>
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <span className="text-[10px] text-slate-500">
                      showing {agentVisibleSchemaEndpointsWithMethods.length}
                      /{agentSchemaEndpointsWithMethods.length}
                    </span>
                    <button
                      onClick={handleCopyAgentEndpointCatalog}
                      disabled={isCopyingAgentEndpointCatalog}
                      className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                    >
                      {isCopyingAgentEndpointCatalog
                        ? "Copying..."
                        : "Copy endpoint catalog JSON"}
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  coverage: operation methods{" "}
                  <span className="font-mono text-slate-300">
                    {agentEndpointCoverageStats.methodOperationBacked}
                  </span>
                  /{agentEndpointCoverageStats.total}, operation summaries{" "}
                  <span className="font-mono text-slate-300">
                    {agentEndpointCoverageStats.summaryOperationBacked}
                  </span>
                  /{agentEndpointCoverageStats.total}, operation paths{" "}
                  <span className="font-mono text-slate-300">
                    {agentEndpointCoverageStats.pathOperationBacked}
                  </span>
                  /{agentEndpointCoverageStats.total}
                </p>
                {agentUnmappedSchemaEndpointKeys.length > 0 ? (
                  <p className="mt-2 text-xs text-amber-300">
                    openapi method mapping missing for:{" "}
                    <span className="font-mono">
                      {agentUnmappedSchemaEndpointKeys.join(", ")}
                    </span>
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-emerald-300">
                    openapi method mapping available for all discovered endpoints.
                  </p>
                )}
                {openApiSpecQuery.isError ? (
                  <p className="mt-1 text-xs text-rose-300">
                    openapi sync check unavailable: failed to load /v1/openapi.
                  </p>
                ) : null}
                {agentMethodMismatchEndpointKeys.length > 0 ? (
                  <p className="mt-1 text-xs text-rose-300">
                    schema/openapi method mismatch for:{" "}
                    <span className="font-mono">
                      {agentMethodMismatchEndpointKeys.join(", ")}
                    </span>
                  </p>
                ) : null}
                {agentOperationMetadataFallbackKeys.length > 0 ? (
                  <p className="mt-1 text-xs text-amber-300">
                    operation metadata fallback used for:{" "}
                    <span className="font-mono">
                      {agentOperationMetadataFallbackKeys.join(", ")}
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-emerald-300">
                    operation metadata available for all discovered endpoints.
                  </p>
                )}
                {agentPathMismatchEndpointKeys.length > 0 ? (
                  <p className="mt-1 text-xs text-rose-300">
                    schema/derived openapi path mismatch for:{" "}
                    <span className="font-mono">
                      {agentPathMismatchEndpointKeys.join(", ")}
                    </span>
                  </p>
                ) : null}
                {agentSummaryMismatchEndpointKeys.length > 0 ? (
                  <p className="mt-1 text-xs text-rose-300">
                    schema/openapi summary mismatch for:{" "}
                    <span className="font-mono">
                      {agentSummaryMismatchEndpointKeys.join(", ")}
                    </span>
                  </p>
                ) : null}
                <div className="mt-2 space-y-1">
                  {agentVisibleSchemaEndpointsWithMethods.length > 0 ? (
                    agentVisibleSchemaEndpointsWithMethods.map((entry) => (
                      <div
                        key={`agent-endpoint-catalog-${entry.key}`}
                        className="text-xs text-slate-400"
                      >
                        <p>
                          {entry.methods.length > 0 ? (
                            <span className="mr-1.5 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-slate-300">
                              {entry.methods.join("|")}
                            </span>
                          ) : null}
                          {entry.key}:{" "}
                          <span className="font-mono text-slate-200">{entry.endpoint}</span>
                          <span className="ml-2 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-slate-300">
                            {entry.methodSource}
                          </span>
                          <span className="ml-1 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-slate-300">
                            {entry.summarySource}
                          </span>
                          <span className="ml-1 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-slate-300">
                            {entry.openApiPathSource}
                          </span>
                          {entry.hasMethodMismatch ? (
                            <span className="ml-1 rounded border border-rose-500/40 bg-rose-500/10 px-1 py-0.5 text-[10px] text-rose-200">
                              method mismatch
                            </span>
                          ) : null}
                          {entry.hasPathMismatch ? (
                            <span className="ml-1 rounded border border-rose-500/40 bg-rose-500/10 px-1 py-0.5 text-[10px] text-rose-200">
                              path mismatch
                            </span>
                          ) : null}
                          {entry.hasSummaryMismatch ? (
                            <span className="ml-1 rounded border border-rose-500/40 bg-rose-500/10 px-1 py-0.5 text-[10px] text-rose-200">
                              summary mismatch
                            </span>
                          ) : null}
                          <button
                            onClick={() => {
                              void handleCopyEndpoint(entry.endpoint, `agent ${entry.key}`);
                            }}
                            className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                          >
                            copy
                          </button>
                        </p>
                        {entry.summary ? (
                          <p className="ml-1 text-[10px] text-slate-400">
                            summary: {entry.summary}
                          </p>
                        ) : null}
                        {entry.hasMethodMismatch ? (
                          <p className="ml-1 text-[10px] text-rose-300">
                            methods (schema vs openapi):{" "}
                            <span className="font-mono">
                              {(entry.schemaMethods.length > 0
                                ? entry.schemaMethods
                                : ["∅"]).join("|")}
                            </span>{" "}
                            vs{" "}
                            <span className="font-mono">
                              {(entry.openApiMethods.length > 0
                                ? entry.openApiMethods
                                : ["∅"]).join("|")}
                            </span>
                          </p>
                        ) : null}
                        {entry.hasSummaryMismatch ? (
                          <p className="ml-1 text-[10px] text-rose-300">
                            summary (schema vs openapi):{" "}
                            <span className="font-mono">
                              {entry.summary ?? "∅"}
                            </span>{" "}
                            vs{" "}
                            <span className="font-mono">
                              {entry.openApiSummary ?? "∅"}
                            </span>
                          </p>
                        ) : null}
                        <p className="ml-1 text-[10px] text-slate-500">
                          openapi path:{" "}
                          <span className="font-mono text-slate-400">{entry.openApiPath}</span>
                          <button
                            onClick={() => {
                              void handleCopyEndpoint(
                                entry.openApiPath,
                                `agent ${entry.key} openapi path`,
                              );
                            }}
                            className="ml-2 rounded border border-slate-700 px-1 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                          >
                            copy path
                          </button>
                        </p>
                        {entry.hasPathMismatch ? (
                          <p className="ml-1 text-[10px] text-rose-300">
                            path (schema vs derived):{" "}
                            <span className="font-mono">{entry.openApiPath}</span> vs{" "}
                            <span className="font-mono">{entry.derivedOpenApiPath}</span>
                          </p>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-500">
                      no endpoints match the current filter.
                    </p>
                  )}
                </div>
              </details>
            ) : null}
            {agentOpsRequestFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                ops request shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentOpsRequestFields)}
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
            {agentSchemaQuery.data?.agent_ops_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                ops execute endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_endpoint}
                </span>
                <button
                  onClick={() => {
                    void handleCopyEndpoint(
                      agentSchemaQuery.data?.agent_ops_endpoint ?? "",
                      "agent ops execute",
                    );
                  }}
                  className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                >
                  copy
                </button>
              </p>
            ) : null}
            {agentSchemaQuery.data?.agent_ops_preview_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                ops preview endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_preview_endpoint}
                </span>
                <button
                  onClick={() => {
                    void handleCopyEndpoint(
                      agentSchemaQuery.data?.agent_ops_preview_endpoint ?? "",
                      "agent ops preview",
                    );
                  }}
                  className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                >
                  copy
                </button>
              </p>
            ) : null}
            {agentOpsPreviewRequestFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                ops preview request shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentOpsPreviewRequestFields)}
                </span>
              </p>
            ) : null}
            {agentOpsPreviewResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                ops preview response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentOpsPreviewResponseFields)}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.workbook_import_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                workbook import endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.workbook_import_endpoint}
                </span>
              </p>
            ) : null}
            {agentFormulaCapabilityFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                formula capabilities:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentFormulaCapabilityFields)}
                </span>
              </p>
            ) : null}
            {agentSupportedFormulaFunctions.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                supported formula functions ({agentSupportedFormulaFunctions.length}):{" "}
                <span className="font-mono text-slate-200">
                  {agentSupportedFormulaFunctions.join(", ")}
                </span>
              </p>
            ) : null}
            {agentUnsupportedFormulaBehaviors.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                unsupported formula behaviors:{" "}
                <span className="font-mono text-slate-200">
                  {agentUnsupportedFormulaBehaviors.join(" | ")}
                </span>
              </p>
            ) : null}
            {agentWorkbookImportResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                workbook import response fields:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentWorkbookImportResponseFields)}
                </span>
              </p>
            ) : null}
            {agentWorkbookImportEventFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                workbook import event fields:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentWorkbookImportEventFields)}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.workbook_export_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                workbook export endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.workbook_export_endpoint}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.duckdb_query_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                duckdb query endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.duckdb_query_endpoint}
                </span>
              </p>
            ) : null}
            {agentDuckdbQueryRequestFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                duckdb query request fields:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentDuckdbQueryRequestFields)}
                </span>
              </p>
            ) : null}
            {agentDuckdbQueryResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                duckdb query response fields:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentDuckdbQueryResponseFields)}
                </span>
              </p>
            ) : null}
            {agentSchemaQuery.data?.duckdb_query_validation_error_codes?.length ? (
              <p className="mb-2 text-xs text-slate-400">
                duckdb query validation codes:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.duckdb_query_validation_error_codes.join(", ")}
                </span>
              </p>
            ) : null}
            {agentOpsResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                agent ops response fields:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentOpsResponseFields)}
                </span>
              </p>
            ) : null}
            {agentOpsResultErrorFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                agent ops result error fields:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentOpsResultErrorFields)}
                </span>
              </p>
            ) : null}
            {agentWorkbookExportHeaderFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                export headers:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentWorkbookExportHeaderFields)}
                </span>
              </p>
            ) : null}
            {agentWorkbookExportEventFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                workbook export event fields:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentWorkbookExportEventFields)}
                </span>
              </p>
            ) : null}
            {agentWorkbookEventShapeFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                workbook event shape catalog:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentWorkbookEventShapeFields)}
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
            {agentCacheStatsQueryFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache stats query shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheStatsQueryFields)}
                </span>
              </p>
            ) : null}
            {agentCacheEntriesQueryFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache entries query shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheEntriesQueryFields)}
                </span>
              </p>
            ) : null}
            {agentCachePrefixesQueryFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache prefixes query shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCachePrefixesQueryFields)}
                </span>
              </p>
            ) : null}
            {agentCacheStatsResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache stats response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheStatsResponseFields)}
                </span>
              </p>
            ) : null}
            {agentCacheEntriesResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache entries response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheEntriesResponseFields)}
                </span>
              </p>
            ) : null}
            {agentCachePrefixesResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache prefixes response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCachePrefixesResponseFields)}
                </span>
              </p>
            ) : null}
            {agentCacheEntryDetailResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache entry detail response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheEntryDetailResponseFields)}
                </span>
              </p>
            ) : null}
            {agentCacheClearResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache clear response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheClearResponseFields)}
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
            {agentCacheReplayRequestFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache replay request shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheReplayRequestFields)}
                </span>
              </p>
            ) : null}
            {agentCacheReplayResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache replay response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheReplayResponseFields)}
                </span>
              </p>
            ) : null}
            {agentCacheReexecuteRequestFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache reexecute request shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheReexecuteRequestFields)}
                </span>
              </p>
            ) : null}
            {agentCacheReexecuteResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache reexecute response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheReexecuteResponseFields)}
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
            {agentSchemaQuery.data?.agent_ops_cache_remove_stale_endpoint ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove-stale endpoint:{" "}
                <span className="font-mono text-slate-200">
                  {agentSchemaQuery.data.agent_ops_cache_remove_stale_endpoint}
                </span>
              </p>
            ) : null}
            {agentCacheRemoveRequestFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove request shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheRemoveRequestFields)}
                </span>
              </p>
            ) : null}
            {agentCacheRemoveResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheRemoveResponseFields)}
                </span>
              </p>
            ) : null}
            {agentCacheRemoveByPrefixRequestFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove-by-prefix request shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheRemoveByPrefixRequestFields)}
                </span>
              </p>
            ) : null}
            {agentCacheRemoveByPrefixResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove-by-prefix response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheRemoveByPrefixResponseFields)}
                </span>
              </p>
            ) : null}
            {agentCacheRemoveByPrefixPreviewRequestFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove-by-prefix preview request shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheRemoveByPrefixPreviewRequestFields)}
                </span>
              </p>
            ) : null}
            {agentCacheRemoveByPrefixPreviewResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove-by-prefix preview response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheRemoveByPrefixPreviewResponseFields)}
                </span>
              </p>
            ) : null}
            {agentCacheRemoveStaleRequestFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove-stale request shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheRemoveStaleRequestFields)}
                </span>
              </p>
            ) : null}
            {agentCacheRemoveStaleResponseFields.length > 0 ? (
              <p className="mb-2 text-xs text-slate-400">
                cache remove-stale response shape:{" "}
                <span className="font-mono text-slate-200">
                  {formatSchemaShapeEntries(agentCacheRemoveStaleResponseFields)}
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
                      {agentOpsCacheQuery.data.unscoped_entries}/
                      {agentOpsCacheQuery.data.max_entries}
                    </span>
                    <span className="ml-1 text-slate-500">(scoped/total/max)</span>
                    {typeof agentOpsCacheQuery.data.max_age_seconds === "number" ? (
                      <span className="ml-1 text-slate-500">
                        (older than {agentOpsCacheQuery.data.max_age_seconds}s)
                      </span>
                    ) : null}
                    {agentOpsCacheQuery.data.cutoff_timestamp ? (
                      <span className="ml-1 text-slate-500">
                        cutoff {formatIsoTimestamp(agentOpsCacheQuery.data.cutoff_timestamp)} (
                        {formatRelativeAge(agentOpsCacheQuery.data.cutoff_timestamp)})
                      </span>
                    ) : null}
                    {agentOpsCacheQuery.data.request_id_prefix ? (
                      <span className="ml-1 text-slate-500">
                        prefix {agentOpsCacheQuery.data.request_id_prefix}
                      </span>
                    ) : null}
                  </span>
                  <button
                    onClick={handleClearAgentOpsCache}
                    disabled={
                      isClearingOpsCache
                      || (!hasActiveCacheScopeFilters && agentOpsCacheQuery.data.entries === 0)
                    }
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
                <p className="mt-1 text-[11px] text-slate-500">
                  oldest cached_at:{" "}
                  <span className="font-mono text-slate-300">
                    {agentOpsCacheQuery.data.oldest_cached_at
                      ? `${formatIsoTimestamp(agentOpsCacheQuery.data.oldest_cached_at)} (${formatRelativeAge(agentOpsCacheQuery.data.oldest_cached_at)})`
                      : "-"}
                  </span>{" "}
                  · newest cached_at:{" "}
                  <span className="font-mono text-slate-300">
                    {agentOpsCacheQuery.data.newest_cached_at
                      ? `${formatIsoTimestamp(agentOpsCacheQuery.data.newest_cached_at)} (${formatRelativeAge(agentOpsCacheQuery.data.newest_cached_at)})`
                      : "-"}
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
                    <label className="ml-2 text-[10px] text-slate-500">
                      older than (sec)
                    </label>
                    <input
                      value={cacheEntriesMaxAgeSeconds}
                      onChange={(event) =>
                        setCacheEntriesMaxAgeSeconds(event.target.value)
                      }
                      placeholder="optional"
                      inputMode="numeric"
                      className={`h-6 w-20 rounded bg-slate-950 px-2 text-[11px] text-slate-200 outline-none placeholder:text-slate-500 ${
                        hasInvalidCacheEntriesMaxAgeInput
                          ? "border border-rose-500/80 focus:border-rose-400"
                          : "border border-slate-700 focus:border-indigo-500"
                      }`}
                    />
                    <button
                      onClick={() => setCacheEntriesMaxAgeSeconds("")}
                      disabled={!cacheEntriesMaxAgeSeconds}
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Clear age
                    </button>
                    <label className="text-[10px] text-slate-500">
                      prefix limit
                    </label>
                    <input
                      value={cachePrefixSuggestionLimit}
                      onChange={(event) =>
                        setCachePrefixSuggestionLimit(event.target.value)
                      }
                      placeholder={CACHE_PREFIX_SUGGESTIONS_DEFAULT_LIMIT}
                      inputMode="numeric"
                      className={`h-6 w-16 rounded bg-slate-950 px-2 text-[11px] text-slate-200 outline-none placeholder:text-slate-500 ${
                        hasInvalidCachePrefixSuggestionLimitInput
                          ? "border border-rose-500/80 focus:border-rose-400"
                          : "border border-slate-700 focus:border-indigo-500"
                      }`}
                    />
                    <button
                      onClick={() =>
                        setCachePrefixSuggestionLimit(
                          CACHE_PREFIX_SUGGESTIONS_DEFAULT_LIMIT,
                        )
                      }
                      disabled={
                        cachePrefixSuggestionLimit.trim()
                        === CACHE_PREFIX_SUGGESTIONS_DEFAULT_LIMIT
                      }
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Reset limit
                    </button>
                    <label className="text-[10px] text-slate-500">
                      min prefix count
                    </label>
                    <input
                      value={cachePrefixMinEntryCount}
                      onChange={(event) =>
                        setCachePrefixMinEntryCount(event.target.value)
                      }
                      placeholder="optional"
                      inputMode="numeric"
                      className={`h-6 w-20 rounded bg-slate-950 px-2 text-[11px] text-slate-200 outline-none placeholder:text-slate-500 ${
                        hasInvalidCachePrefixMinEntryCountInput
                          ? "border border-rose-500/80 focus:border-rose-400"
                          : "border border-slate-700 focus:border-indigo-500"
                      }`}
                    />
                    <button
                      onClick={() => setCachePrefixMinEntryCount("")}
                      disabled={!cachePrefixMinEntryCount}
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Clear min
                    </button>
                    <label className="text-[10px] text-slate-500">
                      min span (s)
                    </label>
                    <input
                      value={cachePrefixMinSpanSeconds}
                      onChange={(event) =>
                        setCachePrefixMinSpanSeconds(event.target.value)
                      }
                      placeholder="optional"
                      inputMode="numeric"
                      className={`h-6 w-20 rounded bg-slate-950 px-2 text-[11px] text-slate-200 outline-none placeholder:text-slate-500 ${
                        hasInvalidCachePrefixMinSpanSecondsInput
                          ? "border border-rose-500/80 focus:border-rose-400"
                          : "border border-slate-700 focus:border-indigo-500"
                      }`}
                    />
                    <button
                      onClick={() => setCachePrefixMinSpanSeconds("")}
                      disabled={!cachePrefixMinSpanSeconds}
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Clear span
                    </button>
                    <label className="text-[10px] text-slate-500">
                      max span (s)
                    </label>
                    <input
                      value={cachePrefixMaxSpanSeconds}
                      onChange={(event) =>
                        setCachePrefixMaxSpanSeconds(event.target.value)
                      }
                      placeholder="optional"
                      inputMode="numeric"
                      className={`h-6 w-20 rounded bg-slate-950 px-2 text-[11px] text-slate-200 outline-none placeholder:text-slate-500 ${
                        hasInvalidCachePrefixMaxSpanSecondsInput
                          ? "border border-rose-500/80 focus:border-rose-400"
                          : "border border-slate-700 focus:border-indigo-500"
                      }`}
                    />
                    <button
                      onClick={() => setCachePrefixMaxSpanSeconds("")}
                      disabled={!cachePrefixMaxSpanSeconds}
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Clear max
                    </button>
                    <label className="text-[10px] text-slate-500">
                      prefix sort
                    </label>
                    <select
                      value={cachePrefixSortBy}
                      onChange={(event) =>
                        setCachePrefixSortBy(
                          event.target.value as
                            | "count"
                            | "recent"
                            | "alpha"
                            | "span",
                        )
                      }
                      className="h-6 rounded border border-slate-700 bg-slate-950 px-2 text-[11px] text-slate-200 outline-none focus:border-indigo-500"
                    >
                      <option value="count">count</option>
                      <option value="recent">recent</option>
                      <option value="alpha">alpha</option>
                      <option value="span">span</option>
                    </select>
                    <button
                      onClick={resetCachePrefixSuggestionControls}
                      disabled={
                        cacheRequestIdPrefix.trim().length === 0
                        && cachePrefixMinEntryCount.trim().length === 0
                        && cachePrefixMinSpanSeconds.trim().length === 0
                        && cachePrefixMaxSpanSeconds.trim().length === 0
                        && cachePrefixSortBy === CACHE_PREFIX_SUGGESTIONS_DEFAULT_SORT
                        && cachePrefixSuggestionLimit.trim()
                        === CACHE_PREFIX_SUGGESTIONS_DEFAULT_LIMIT
                      }
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Reset prefix scope
                    </button>
                    <button
                      onClick={() => {
                        void handlePreviewRemoveCacheEntriesByPrefix();
                      }}
                      disabled={
                        isPreviewingCacheByPrefix
                        || !cacheRequestIdPrefix.trim()
                        || hasInvalidCacheRemovePreviewSampleLimitInput
                        || hasInvalidCacheEntriesMaxAgeInput
                      }
                      className="rounded border border-amber-700/70 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
                    >
                      {isPreviewingCacheByPrefix ? "Previewing..." : "Preview remove"}
                    </button>
                    <label className="text-[10px] text-slate-500">
                      sample limit
                    </label>
                    <input
                      value={cacheRemovePreviewSampleLimit}
                      onChange={(event) =>
                        setCacheRemovePreviewSampleLimit(event.target.value)
                      }
                      inputMode="numeric"
                      className={`h-6 w-14 rounded bg-slate-950 px-2 text-[11px] text-slate-200 outline-none ${
                        hasInvalidCacheRemovePreviewSampleLimitInput
                          ? "border border-rose-500/80 focus:border-rose-400"
                          : "border border-slate-700 focus:border-amber-500"
                      }`}
                    />
                    <button
                      onClick={handleRemoveCacheEntriesByPrefix}
                      disabled={
                        isRemovingCacheByPrefix
                        || !cacheRequestIdPrefix.trim()
                        || hasInvalidCacheEntriesMaxAgeInput
                        || (cacheEntriesData?.total_entries ?? 0) === 0
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
                    <label className="ml-2 text-[10px] text-slate-500">
                      stale age (sec)
                    </label>
                    <input
                      value={cacheStaleMaxAgeSeconds}
                      onChange={(event) =>
                        setCacheStaleMaxAgeSeconds(event.target.value)
                      }
                      inputMode="numeric"
                      className={`h-6 w-20 rounded bg-slate-950 px-2 text-[11px] text-slate-200 outline-none ${
                        hasInvalidCacheStaleMaxAgeInput
                          ? "border border-rose-500/80 focus:border-rose-400"
                          : "border border-slate-700 focus:border-amber-500"
                      }`}
                    />
                    <label className="text-[10px] text-slate-500">
                      stale sample
                    </label>
                    <input
                      value={cacheStalePreviewSampleLimit}
                      onChange={(event) =>
                        setCacheStalePreviewSampleLimit(event.target.value)
                      }
                      inputMode="numeric"
                      className={`h-6 w-14 rounded bg-slate-950 px-2 text-[11px] text-slate-200 outline-none ${
                        hasInvalidCacheStalePreviewSampleLimitInput
                          ? "border border-rose-500/80 focus:border-rose-400"
                          : "border border-slate-700 focus:border-amber-500"
                      }`}
                    />
                    <button
                      onClick={handlePreviewRemoveStaleCacheEntries}
                      disabled={
                        isPreviewingStaleCache
                        || isRemovingStaleCache
                        || hasInvalidCacheStalePreviewSampleLimitInput
                        || hasInvalidCacheStaleMaxAgeInput
                      }
                      className="rounded border border-amber-700/70 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
                    >
                      {isPreviewingStaleCache ? "Previewing stale..." : "Preview stale"}
                    </button>
                    <button
                      onClick={handleRemoveStaleCacheEntries}
                      disabled={
                        isRemovingStaleCache
                        || isPreviewingStaleCache
                        || hasInvalidCacheStalePreviewSampleLimitInput
                        || hasInvalidCacheStaleMaxAgeInput
                        || (cacheEntriesData?.total_entries ?? 0) === 0
                      }
                      className="rounded border border-rose-700/70 px-1.5 py-0.5 text-[10px] text-rose-200 hover:bg-rose-900/40 disabled:opacity-50"
                    >
                      {isRemovingStaleCache ? "Removing stale..." : "Remove stale"}
                    </button>
                  </div>
                  <p className="mb-2 text-[10px] text-slate-500">
                    rerun request_id is optional; values are trimmed before submit (blank
                    after trim auto-generates). Reusing a request_id with a different
                    operation signature returns{" "}
                    <span className="font-mono text-slate-300">REQUEST_ID_CONFLICT</span>.
                  </p>
                  {hasInvalidCacheEntriesMaxAgeInput ? (
                    <p className="mb-2 text-[10px] text-rose-300">
                      older-than filter must be a positive integer (seconds). Cache
                      entries/prefix queries are paused until corrected.
                    </p>
                  ) : null}
                  {hasInvalidCachePrefixMinEntryCountInput ? (
                    <p className="mb-2 text-[10px] text-rose-300">
                      min prefix count must be a positive integer. Prefix queries are
                      paused until corrected.
                    </p>
                  ) : null}
                  {hasInvalidCachePrefixMinSpanSecondsInput ? (
                    <p className="mb-2 text-[10px] text-rose-300">
                      min span must be a positive integer (seconds). Prefix queries are
                      paused until corrected.
                    </p>
                  ) : null}
                  {hasInvalidCachePrefixMaxSpanSecondsInput ? (
                    <p className="mb-2 text-[10px] text-rose-300">
                      max span must be a positive integer (seconds). Prefix queries are
                      paused until corrected.
                    </p>
                  ) : null}
                  {hasInvalidCachePrefixSpanRangeInput ? (
                    <p className="mb-2 text-[10px] text-rose-300">
                      max span must be greater than or equal to min span. Prefix
                      queries are paused until corrected.
                    </p>
                  ) : null}
                  {hasInvalidCachePrefixSuggestionLimitInput ? (
                    <p className="mb-2 text-[10px] text-rose-300">
                      prefix limit must be a positive integer. Prefix queries are
                      paused until corrected.
                    </p>
                  ) : null}
                  {hasInvalidCacheRemovePreviewSampleLimitInput ? (
                    <p className="mb-2 text-[10px] text-rose-300">
                      prefix preview sample limit must be a positive integer.
                    </p>
                  ) : null}
                  {isCacheRemovePreviewSampleLimitCapped ? (
                    <p className="mb-2 text-[10px] text-amber-300">
                      prefix preview sample limit will be capped to{" "}
                      {CACHE_PREVIEW_MAX_SAMPLE_LIMIT}.
                    </p>
                  ) : null}
                  {hasInvalidCacheStaleMaxAgeInput ? (
                    <p className="mb-2 text-[10px] text-rose-300">
                      stale age filter must be a positive integer (seconds).
                    </p>
                  ) : null}
                  {hasInvalidCacheStalePreviewSampleLimitInput ? (
                    <p className="mb-2 text-[10px] text-rose-300">
                      stale sample limit must be a positive integer.
                    </p>
                  ) : null}
                  {isCacheStalePreviewSampleLimitCapped ? (
                    <p className="mb-2 text-[10px] text-amber-300">
                      stale sample limit will be capped to {CACHE_PREVIEW_MAX_SAMPLE_LIMIT}.
                    </p>
                  ) : null}
                  {cachePrefixRemovalPreview ? (
                    <div className="mb-2 rounded border border-amber-800/60 bg-amber-900/10 p-2 text-[10px] text-amber-100">
                      <p>
                        preview prefix{" "}
                        <span className="font-mono">
                          {cachePrefixRemovalPreview.requestIdPrefix}
                        </span>{" "}
                        {typeof cachePrefixRemovalPreview.maxAgeSeconds === "number" ? (
                          <>
                            older than{" "}
                            <span className="font-mono">
                              {cachePrefixRemovalPreview.maxAgeSeconds}s
                            </span>{" "}
                          </>
                        ) : null}
                        {cachePrefixRemovalPreview.cutoffTimestamp ? (
                          <>
                            cutoff{" "}
                            <span className="font-mono">
                              {formatIsoTimestamp(cachePrefixRemovalPreview.cutoffTimestamp)}
                            </span>{" "}
                            <span className="text-amber-200/80">
                              ({formatRelativeAge(cachePrefixRemovalPreview.cutoffTimestamp)})
                            </span>{" "}
                          </>
                        ) : null}
                        {" "}
                        matches{" "}
                        <span className="font-mono">
                          {cachePrefixRemovalPreview.matchedEntries}
                        </span>{" "}
                        {cachePrefixRemovalPreview.unscopedMatchedEntries
                        !== cachePrefixRemovalPreview.matchedEntries ? (
                          <>
                            (global{" "}
                            <span className="font-mono">
                              {cachePrefixRemovalPreview.unscopedMatchedEntries}
                            </span>
                            ){" "}
                          </>
                        ) : null}
                        entr
                        {cachePrefixRemovalPreview.matchedEntries === 1 ? "y" : "ies"}
                        {" "}(
                        sample limit{" "}
                        <span className="font-mono">
                          {cachePrefixRemovalPreview.sampleLimit}
                        </span>
                        ).
                      </p>
                      {cachePrefixRemovalPreview.sampleRequestIds.length > 0 ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-amber-200/90">
                          <span>sample:</span>
                          {cachePrefixRemovalPreview.sampleRequestIds.map((requestId) => (
                            <button
                              key={requestId}
                              onClick={() => handleInspectCacheRequestId(requestId)}
                              disabled={inspectingCacheRequestId === requestId}
                              className="rounded border border-amber-700/70 px-1.5 py-0.5 font-mono text-[10px] hover:bg-amber-900/30 disabled:opacity-50"
                            >
                              {inspectingCacheRequestId === requestId
                                ? "Inspecting..."
                                : requestId}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {cacheStaleRemovalPreview ? (
                    <div className="mb-2 rounded border border-rose-800/60 bg-rose-900/10 p-2 text-[10px] text-rose-100">
                      <p>
                        stale preview ({cacheStaleRemovalPreview.maxAgeSeconds}s) cutoff{" "}
                        <span className="font-mono">
                          {formatIsoTimestamp(cacheStaleRemovalPreview.cutoffTimestamp)}
                        </span>{" "}
                        <span className="text-rose-200/80">
                          ({formatRelativeAge(cacheStaleRemovalPreview.cutoffTimestamp)})
                        </span>{" "}
                        {cacheStaleRemovalPreview.requestIdPrefix ? (
                          <>
                            prefix{" "}
                            <span className="font-mono">
                              {cacheStaleRemovalPreview.requestIdPrefix}
                            </span>{" "}
                          </>
                        ) : null}
                        matched{" "}
                        <span className="font-mono">
                          {cacheStaleRemovalPreview.matchedEntries}
                        </span>{" "}
                        {cacheStaleRemovalPreview.unscopedMatchedEntries
                        !== cacheStaleRemovalPreview.matchedEntries ? (
                          <>
                            (global{" "}
                            <span className="font-mono">
                              {cacheStaleRemovalPreview.unscopedMatchedEntries}
                            </span>
                            ){" "}
                          </>
                        ) : null}
                        entr
                        {cacheStaleRemovalPreview.matchedEntries === 1 ? "y" : "ies"} (
                        sample limit{" "}
                        <span className="font-mono">
                          {cacheStaleRemovalPreview.sampleLimit}
                        </span>
                        ).
                      </p>
                      {cacheStaleRemovalPreview.sampleRequestIds.length > 0 ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-rose-200/90">
                          <span>sample:</span>
                          {cacheStaleRemovalPreview.sampleRequestIds.map((requestId) => (
                            <button
                              key={requestId}
                              onClick={() => handleInspectCacheRequestId(requestId)}
                              disabled={inspectingCacheRequestId === requestId}
                              className="rounded border border-rose-700/70 px-1.5 py-0.5 font-mono text-[10px] hover:bg-rose-900/30 disabled:opacity-50"
                            >
                              {inspectingCacheRequestId === requestId
                                ? "Inspecting..."
                                : requestId}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {cachePrefixSuggestions.length > 0 ? (
                    <div className="mb-2 flex flex-wrap items-center gap-1">
                      <span className="text-[10px] text-slate-500">suggestions:</span>
                      {cachePrefixSuggestionsData
                        && cachePrefixSuggestionsData.total_prefixes
                          !== cachePrefixSuggestionsData.unscoped_total_prefixes ? (
                          <span className="text-[10px] text-slate-500">
                            (
                            {cachePrefixSuggestionsData.total_prefixes}/
                            {cachePrefixSuggestionsData.unscoped_total_prefixes}
                            {" "}scoped/global)
                          </span>
                        ) : null}
                      {cachePrefixSuggestionsData ? (
                        <span className="text-[10px] text-slate-500">
                          (entries {cachePrefixSuggestionsData.returned_entry_count}/
                          {cachePrefixSuggestionsData.scoped_total_entries}/
                          {cachePrefixSuggestionsData.unscoped_total_entries}
                          {" "}page/scoped/global)
                        </span>
                      ) : null}
                      {cachePrefixSuggestionsData?.request_id_prefix ? (
                        <span className="text-[10px] text-slate-500">
                          (prefix {cachePrefixSuggestionsData.request_id_prefix})
                        </span>
                      ) : null}
                      {cachePrefixSuggestionsData
                        && cachePrefixSuggestionsData.min_entry_count > 1 ? (
                          <span className="text-[10px] text-slate-500">
                            (min count {cachePrefixSuggestionsData.min_entry_count})
                          </span>
                        ) : null}
                      {typeof cachePrefixSuggestionsData?.min_span_seconds === "number" ? (
                        <span className="text-[10px] text-slate-500">
                          (min span {cachePrefixSuggestionsData.min_span_seconds}s)
                        </span>
                      ) : null}
                      {typeof cachePrefixSuggestionsData?.max_span_seconds === "number" ? (
                        <span className="text-[10px] text-slate-500">
                          (max span {cachePrefixSuggestionsData.max_span_seconds}s)
                        </span>
                      ) : null}
                      {cachePrefixSuggestionsData ? (
                        <span className="text-[10px] text-slate-500">
                          (sort {cachePrefixSuggestionsData.sort_by})
                        </span>
                      ) : null}
                      {cachePrefixSuggestionsData ? (
                        <span className="text-[10px] text-slate-500">
                          (limit {cachePrefixSuggestionsData.limit})
                        </span>
                      ) : null}
                      {typeof cachePrefixSuggestionsData?.max_age_seconds === "number" ? (
                        <span className="text-[10px] text-slate-500">
                          (older than {cachePrefixSuggestionsData.max_age_seconds}s)
                        </span>
                      ) : null}
                      {cachePrefixSuggestionsData?.cutoff_timestamp ? (
                        <span className="text-[10px] text-slate-500">
                          cutoff{" "}
                          {formatIsoTimestamp(cachePrefixSuggestionsData.cutoff_timestamp)} (
                          {formatRelativeAge(cachePrefixSuggestionsData.cutoff_timestamp)})
                        </span>
                      ) : null}
                      {cachePrefixSuggestions.map((suggestion) => (
                        <button
                          key={suggestion.prefix}
                          onClick={(event) => {
                            setCacheRequestIdPrefix(suggestion.prefix);
                            if (event.shiftKey) {
                              void handleInspectCacheRequestId(
                                suggestion.newest_request_id,
                              );
                            }
                            if (event.altKey) {
                              void handlePreviewRemoveCacheEntriesByPrefix(
                                suggestion.prefix,
                              );
                            }
                          }}
                          title={`latest: ${suggestion.newest_request_id}${
                            suggestion.newest_cached_at
                              ? ` @ ${formatIsoTimestamp(suggestion.newest_cached_at)} (${formatRelativeAge(suggestion.newest_cached_at)})`
                              : ""
                          } · oldest: ${suggestion.oldest_request_id}${
                            suggestion.oldest_cached_at
                              ? ` @ ${formatIsoTimestamp(suggestion.oldest_cached_at)} (${formatRelativeAge(suggestion.oldest_cached_at)})`
                              : ""
                          }${
                            typeof suggestion.span_seconds === "number"
                              ? ` · span ${formatDurationSeconds(suggestion.span_seconds)}`
                              : ""
                          } (Shift+click inspect, Alt+click preview remove)`}
                          className={`rounded border px-1.5 py-0.5 text-[10px] ${
                            cacheRequestIdPrefix.trim() === suggestion.prefix
                              ? "border-indigo-500/80 bg-indigo-500/20 text-indigo-200"
                              : "border-slate-700 text-slate-300 hover:bg-slate-800"
                          }`}
                        >
                          {suggestion.prefix}
                          <span className="ml-1 text-slate-400">
                            {suggestion.entry_count}
                          </span>
                          {suggestion.newest_cached_at ? (
                            <span className="ml-1 text-slate-500">
                              {formatRelativeAge(suggestion.newest_cached_at)}
                            </span>
                          ) : null}
                          {typeof suggestion.span_seconds === "number"
                          && suggestion.span_seconds > 0 ? (
                            <span className="ml-1 text-slate-500">
                              Δ{formatDurationSeconds(suggestion.span_seconds)}
                            </span>
                          ) : null}
                        </button>
                      ))}
                      <span className="text-[10px] text-slate-500">
                        (tips: Shift+click inspect, Alt+click preview)
                      </span>
                    </div>
                  ) : cachePrefixSuggestionsData && hasActiveCacheScopeFilters ? (
                    <div className="mb-2 text-[10px] text-slate-500">
                      No prefix suggestions match the current scope
                      {cacheRequestIdPrefix.trim() ? (
                        <> (prefix {cacheRequestIdPrefix.trim()})</>
                      ) : null}
                      {typeof normalizedCacheEntriesMaxAgeSeconds === "number" ? (
                        <> (older than {normalizedCacheEntriesMaxAgeSeconds}s)</>
                      ) : null}
                      {typeof normalizedCachePrefixMinEntryCount === "number"
                      && normalizedCachePrefixMinEntryCount > 1 ? (
                        <> (min count {normalizedCachePrefixMinEntryCount})</>
                      ) : null}
                      {typeof normalizedCachePrefixMinSpanSeconds === "number" ? (
                        <> (min span {normalizedCachePrefixMinSpanSeconds}s)</>
                      ) : null}
                      {typeof normalizedCachePrefixMaxSpanSeconds === "number" ? (
                        <> (max span {normalizedCachePrefixMaxSpanSeconds}s)</>
                      ) : null}
                      <> (sort {cachePrefixSortBy})</>
                      {typeof normalizedCachePrefixSuggestionLimit === "number" ? (
                        <> (limit {normalizedCachePrefixSuggestionLimit})</>
                      ) : null}
                      .
                    </div>
                  ) : null}
                  {cachePrefixSuggestionsData ? (
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[10px] text-slate-500">
                        showing{" "}
                        <span className="font-mono text-slate-300">
                          {cachePrefixSuggestionsData.returned_prefixes === 0
                            ? 0
                            : cachePrefixSuggestionsData.offset + 1}
                        </span>
                        –
                        <span className="font-mono text-slate-300">
                          {cachePrefixSuggestionsData.offset
                            + cachePrefixSuggestionsData.returned_prefixes}
                        </span>{" "}
                        of{" "}
                        <span className="font-mono text-slate-300">
                          {cachePrefixSuggestionsData.total_prefixes}
                        </span>{" "}
                        scoped prefixes · entries{" "}
                        <span className="font-mono text-slate-300">
                          {cachePrefixSuggestionsData.returned_entry_count}
                        </span>
                        /
                        <span className="font-mono text-slate-300">
                          {cachePrefixSuggestionsData.scoped_total_entries}
                        </span>
                        /
                        <span className="font-mono text-slate-300">
                          {cachePrefixSuggestionsData.unscoped_total_entries}
                        </span>
                      </p>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() =>
                            setCachePrefixSuggestionsOffset((previousOffset) =>
                              Math.max(0, previousOffset - cachePrefixSuggestionsData.limit),
                            )
                          }
                          disabled={cachePrefixSuggestionsData.offset === 0}
                          className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                        >
                          Newer
                        </button>
                        <button
                          onClick={() =>
                            setCachePrefixSuggestionsOffset(
                              cachePrefixSuggestionsOffset + cachePrefixSuggestionsData.limit,
                            )
                          }
                          disabled={!cachePrefixSuggestionsData.has_more}
                          className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                        >
                          Older
                        </button>
                      </div>
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
                        disabled={!cacheEntriesData?.has_more}
                        className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                      >
                        Older
                      </button>
                    </div>
                  </div>
                  {cacheEntriesData ? (
                    <p className="mt-1 text-[10px] text-slate-500">
                      showing{" "}
                      <span className="font-mono text-slate-300">
                        {cacheEntriesData.returned_entries === 0
                          ? 0
                          : cacheEntriesData.offset + 1}
                      </span>
                      –
                      <span className="font-mono text-slate-300">
                        {cacheEntriesData.offset + cacheEntriesData.returned_entries}
                      </span>{" "}
                      of{" "}
                      <span className="font-mono text-slate-300">
                        {cacheEntriesData.total_entries}
                      </span>
                      {cacheEntriesData.total_entries !== cacheEntriesData.unscoped_total_entries ? (
                        <>
                          {" "}
                          (global{" "}
                          <span className="font-mono text-slate-300">
                            {cacheEntriesData.unscoped_total_entries}
                          </span>
                          )
                        </>
                      ) : null}
                      {cacheEntriesData.request_id_prefix ? (
                        <>
                          {" "}
                          filtered by{" "}
                          <span className="font-mono text-indigo-300">
                            {cacheEntriesData.request_id_prefix}
                          </span>
                        </>
                      ) : null}
                      {typeof cacheEntriesData.max_age_seconds === "number" ? (
                        <>
                          {" "}
                          older than{" "}
                          <span className="font-mono text-amber-300">
                            {cacheEntriesData.max_age_seconds}s
                          </span>
                        </>
                      ) : null}
                      {cacheEntriesData.cutoff_timestamp ? (
                        <>
                          {" "}
                          cutoff{" "}
                          <span className="font-mono text-amber-300">
                            {formatIsoTimestamp(cacheEntriesData.cutoff_timestamp)}
                          </span>
                          <span className="text-slate-400">
                            {" "}({formatRelativeAge(cacheEntriesData.cutoff_timestamp)})
                          </span>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  {agentOpsCacheEntriesQuery.isLoading ? (
                    <p className="mt-1 text-[11px] text-slate-500">Loading cache entries…</p>
                  ) : null}
                  {cacheEntriesData?.entries?.length ? (
                    <ul className="mt-1 space-y-1">
                      {cacheEntriesData.entries.map((entry) => (
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
                              cached:
                              <span className="ml-1 font-mono text-slate-300">
                                {formatIsoTimestamp(entry.cached_at)}
                              </span>
                              <span className="ml-1 text-slate-400">
                                ({formatRelativeAge(entry.cached_at)})
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
                            onClick={() => {
                              if (!selectedCacheEntryPrefix) {
                                return;
                              }
                              clearUiError();
                              setCacheRequestIdPrefix(selectedCacheEntryPrefix);
                              setNotice(
                                `Applied prefix filter ${selectedCacheEntryPrefix} from ${selectedCacheEntryDetail.request_id}.`,
                              );
                            }}
                            disabled={!selectedCacheEntryPrefix}
                            className="rounded border border-cyan-700/70 px-1.5 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-900/40 disabled:opacity-50"
                          >
                            Use prefix
                          </button>
                          <button
                            onClick={() => {
                              if (!selectedCacheEntryPrefix) {
                                return;
                              }
                              clearUiError();
                              setCacheRequestIdPrefix(selectedCacheEntryPrefix);
                              void handlePreviewRemoveCacheEntriesByPrefix(
                                selectedCacheEntryPrefix,
                              );
                            }}
                            disabled={!selectedCacheEntryPrefix}
                            className="rounded border border-amber-700/70 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
                          >
                            Use + preview
                          </button>
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
                        </span>{" "}
                        · cached:{" "}
                        <span className="font-mono text-slate-300">
                          {formatIsoTimestamp(selectedCacheEntryDetail.cached_at)}
                        </span>{" "}
                        <span className="text-slate-400">
                          ({formatRelativeAge(selectedCacheEntryDetail.cached_at)})
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
                latest import:{" "}
                <span className="font-mono text-slate-200">
                  {lastWizardImportSummary.sheetsImported} sheets /{" "}
                  {lastWizardImportSummary.cellsImported} cells /{" "}
                  {lastWizardImportSummary.formulaCellsImported} formulas
                  {lastWizardImportSummary.formulaCellsImported > 0 ? (
                    <>
                      {" "}
                      ({lastWizardImportSummary.formulaCellsWithCachedValues} cached,{" "}
                      {lastWizardImportSummary.formulaCellsWithoutCachedValues} uncached
                      {lastWizardImportSummary.formulaCellsNormalized > 0
                        ? `, ${lastWizardImportSummary.formulaCellsNormalized} normalized`
                        : ""}
                      )
                    </>
                  ) : null}
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
            {lastExportSummary && (
              <div className="mb-2 text-xs text-slate-400">
                latest export:{" "}
                <span className="font-mono text-slate-200">
                  {lastExportSummary.fileName}
                </span>{" "}
                <span className="text-slate-500">
                  at {formatIsoTimestamp(lastExportSummary.exportedAt)} (
                  {formatRelativeAge(lastExportSummary.exportedAt)})
                </span>
                {lastExportSummary.compatibilityReport ? (
                  <div className="mt-1 grid gap-1 rounded border border-slate-700 bg-slate-950/40 p-2 text-[11px]">
                    <p className="text-slate-300">
                      preserved ({lastExportSummary.compatibilityReport.preserved.length}):
                    </p>
                    <ul className="list-disc pl-4 text-emerald-200">
                      {lastExportSummary.compatibilityReport.preserved.map((entry) => (
                        <li key={`preserved-${entry}`}>{entry}</li>
                      ))}
                    </ul>
                    <p className="text-slate-300">
                      transformed ({lastExportSummary.compatibilityReport.transformed.length}):
                    </p>
                    <ul className="list-disc pl-4 text-amber-200">
                      {lastExportSummary.compatibilityReport.transformed.map((entry) => (
                        <li key={`transformed-${entry}`}>{entry}</li>
                      ))}
                    </ul>
                    <p className="text-slate-300">
                      unsupported ({lastExportSummary.compatibilityReport.unsupported.length}):
                    </p>
                    <ul className="list-disc pl-4 text-rose-200">
                      {lastExportSummary.compatibilityReport.unsupported.map((entry) => (
                        <li key={`unsupported-${entry}`}>{entry}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-slate-500">
                    compatibility report metadata was not included in this export response.
                  </p>
                )}
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
                          {!result.ok ? (
                            <div className="mb-1 flex flex-wrap items-center gap-1">
                              {typeof result.data.error_code === "string" ? (
                                <span className="rounded border border-rose-400/40 bg-rose-500/20 px-1.5 py-0.5 font-mono text-[10px] text-rose-100">
                                  {result.data.error_code}
                                </span>
                              ) : null}
                              {typeof result.data.error_message === "string" ? (
                                <span className="text-[11px] text-rose-200">
                                  {result.data.error_message}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
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
