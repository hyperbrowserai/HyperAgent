interface RawModeCapableInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

export function setRawModeIfSupported(
  enabled: boolean,
  input: RawModeCapableInput = process.stdin as RawModeCapableInput
): void {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return;
  }
  input.setRawMode(enabled);
}
