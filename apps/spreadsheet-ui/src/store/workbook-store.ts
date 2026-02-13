import { create } from "zustand";
import { CellSnapshot, WorkbookSummary } from "@/types/spreadsheet";

interface WorkbookStoreState {
  workbook: WorkbookSummary | null;
  activeSheet: string;
  selectedAddress: string;
  eventSeq: number;
  cellsByAddress: Record<string, CellSnapshot>;
  setWorkbook: (workbook: WorkbookSummary) => void;
  setCells: (cells: CellSnapshot[]) => void;
  setSelectedAddress: (address: string) => void;
  setEventSeq: (seq: number) => void;
}

export const useWorkbookStore = create<WorkbookStoreState>((set) => ({
  workbook: null,
  activeSheet: "Sheet1",
  selectedAddress: "A1",
  eventSeq: 0,
  cellsByAddress: {},
  setWorkbook: (workbook) =>
    set(() => ({
      workbook,
      activeSheet: workbook.sheets[0] ?? "Sheet1",
    })),
  setCells: (cells) =>
    set(() => ({
      cellsByAddress: Object.fromEntries(
        cells.map((cell) => [cell.address, cell]),
      ),
    })),
  setSelectedAddress: (selectedAddress) => set(() => ({ selectedAddress })),
  setEventSeq: (eventSeq) => set(() => ({ eventSeq })),
}));
