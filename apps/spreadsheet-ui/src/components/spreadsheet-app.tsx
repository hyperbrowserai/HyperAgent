"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  createWorkbook,
  exportWorkbook,
  getCells,
  importWorkbook,
  setCellBatch,
  subscribeToWorkbookEvents,
  upsertChart,
} from "@/lib/spreadsheet-api";
import { buildAddress, indexToColumn, TOTAL_COLS, TOTAL_ROWS } from "@/lib/cell-address";
import { useWorkbookStore } from "@/store/workbook-store";

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
    cellsByAddress,
    setWorkbook,
    setCells,
    setSelectedAddress,
    setEventSeq,
  } = useWorkbookStore();
  const [formulaInput, setFormulaInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const createWorkbookMutation = useMutation({
    mutationFn: () => createWorkbook("Agent Workbook"),
    onSuccess: (createdWorkbook) => {
      setWorkbook(createdWorkbook);
    },
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => importWorkbook(file),
    onSuccess: (importedWorkbook) => {
      setWorkbook(importedWorkbook);
      queryClient.invalidateQueries({ queryKey: ["cells", importedWorkbook.id] });
    },
  });

  const cellsQuery = useQuery({
    queryKey: ["cells", workbook?.id, activeSheet],
    enabled: Boolean(workbook?.id),
    queryFn: () => getCells(workbook!.id, activeSheet),
  });

  useEffect(() => {
    if (!workbook && !createWorkbookMutation.isPending) {
      createWorkbookMutation.mutate();
    }
  }, [workbook, createWorkbookMutation]);

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
      setEventSeq(event.seq);
      queryClient.invalidateQueries({ queryKey: ["cells", workbook.id, activeSheet] });
    });
    return unsubscribe;
  }, [workbook?.id, activeSheet, queryClient, setEventSeq]);

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

  const statusText =
    createWorkbookMutation.isPending || importMutation.isPending
      ? "Initializing workbook..."
      : cellsQuery.isFetching
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
      const isFormula = formulaInput.trim().startsWith("=");
      await setCellBatch(workbook.id, activeSheet, [
        {
          row,
          col,
          ...(isFormula
            ? { formula: formulaInput.trim() }
            : { value: formulaInput }),
        },
      ]);
      await queryClient.invalidateQueries({
        queryKey: ["cells", workbook.id, activeSheet],
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleExport() {
    if (!workbook) {
      return;
    }
    const blob = await exportWorkbook(workbook.id);
    const fileUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = fileUrl;
    anchor.download = `${workbook.name}.xlsx`;
    anchor.click();
    URL.revokeObjectURL(fileUrl);
  }

  async function handleChartSync() {
    if (!workbook) {
      return;
    }
    await upsertChart(workbook.id, {
      id: "chart-default",
      sheet: activeSheet,
      chart_type: "bar",
      title: "Column B by Column A",
      categories_range: `${activeSheet}!$A$1:$A$10`,
      values_range: `${activeSheet}!$B$1:$B$10`,
    });
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
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-slate-300 md:grid-cols-3">
            <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
              Workbook: <span className="font-semibold">{workbook?.name ?? "-"}</span>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
              Sheet: <span className="font-semibold">{activeSheet}</span>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
              Status: <span className="font-semibold">{statusText}</span>
            </div>
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

        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
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
        </section>
      </div>
    </div>
  );
}
