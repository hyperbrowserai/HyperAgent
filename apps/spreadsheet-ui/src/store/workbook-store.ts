import { create } from "zustand";
import { CellSnapshot, WorkbookEvent, WorkbookSummary } from "@/types/spreadsheet";

interface WorkbookStoreState {
  workbook: WorkbookSummary | null;
  activeSheet: string;
  selectedAddress: string;
  eventSeq: number;
  eventLog: WorkbookEvent[];
  cellsByAddress: Record<string, CellSnapshot>;
  setWorkbook: (workbook: WorkbookSummary) => void;
  setCells: (cells: CellSnapshot[]) => void;
  setSelectedAddress: (address: string) => void;
  setEventSeq: (seq: number) => void;
  appendEvent: (event: WorkbookEvent) => void;
}

export const useWorkbookStore = create<WorkbookStoreState>((set) => ({
  workbook: null,
  activeSheet: "Sheet1",
  selectedAddress: "A1",
  eventSeq: 0,
  eventLog: [],
  cellsByAddress: {},
  setWorkbook: (workbook) =>
    set(() => ({
      workbook,
      activeSheet: workbook.sheets[0] ?? "Sheet1",
      eventLog: [],
      eventSeq: 0,
    })),
  setCells: (cells) =>
    set(() => ({
      cellsByAddress: Object.fromEntries(
        cells.map((cell) => [cell.address, cell]),
      ),
    })),
  setSelectedAddress: (selectedAddress) => set(() => ({ selectedAddress })),
  setEventSeq: (eventSeq) => set(() => ({ eventSeq })),
  appendEvent: (event) =>
    set((state) => ({
      eventSeq: event.seq,
      eventLog: [event, ...state.eventLog].slice(0, 40),
    })),
}));
