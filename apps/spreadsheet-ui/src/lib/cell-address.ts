export const TOTAL_ROWS = 30;
export const TOTAL_COLS = 12;

export function indexToColumn(col: number): string {
  if (col <= 0) {
    return "A";
  }

  let value = col;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function buildAddress(row: number, col: number): string {
  return `${indexToColumn(col)}${row}`;
}
