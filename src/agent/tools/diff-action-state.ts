import crypto from "crypto";
import { DOMState } from "@/context-providers/dom/types";
import { AgentActionDefinition } from "@hyperbrowser/agent/types";

function calculateDOMHash(domStateString: string): string {
  return crypto.createHash("sha1").update(domStateString).digest("hex");
}

export function hasDOMStateChanged(
  previousDomState: DOMState,
  currentDomState: DOMState,
  actionParams: Record<string, unknown>,
  actionDomChangeHandler?: NonNullable<AgentActionDefinition["hasDomChanged"]>
): boolean {
  // Check if the number of interactive elements has changed
  if (previousDomState.elements.size !== currentDomState.elements.size) {
    return true;
  }

  // Check if the overall DOM structure hash has changed
  const previousHash = calculateDOMHash(previousDomState.domState);
  const currentHash = calculateDOMHash(currentDomState.domState);
  return (
    previousHash !== currentHash &&
    (actionDomChangeHandler?.(
      currentDomState,
      previousDomState,
      actionParams
    ) ??
      true)
  );
}
