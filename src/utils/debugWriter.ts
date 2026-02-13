/**
 * Debug writer utility for aiAction debugging
 * Creates a debug folder structure similar to the agent task debugging
 */

import fs from "fs";
import path from "path";
import { formatUnknownError } from "./format-unknown-error";

interface FoundElementDebugData {
  elementId: string;
  method: string;
  arguments: unknown[];
  xpath?: string;
}

export interface DebugData {
  instruction: string;
  url: string;
  timestamp: string;
  domElementCount: number;
  domTree: string;
  screenshot?: Buffer;
  foundElement?: FoundElementDebugData;
  availableElements?: Array<{
    id: string;
    role: string;
    label: string;
  }>;
  llmResponse?: {
    rawText: string;
    parsed: unknown;
  };
  error?: {
    message: string;
    stack?: string;
  };
  success: boolean;
  frameDebugInfo?: Array<{
    frameIndex: number;
    frameUrl: string;
    totalNodes: number;
    treeElementCount: number;
    interactiveCount: number;
    sampleNodes?: Array<{
      role?: string;
      name?: string;
      nodeId?: string;
      ignored?: boolean;
      childIds?: number;
    }>;
  }>;
}

let actionCounter = 0;
let sessionId: string | null = null;

function stringifyDebugJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(
      value,
      (_key, candidate: unknown) => {
        if (typeof candidate === "bigint") {
          return `${candidate.toString()}n`;
        }
        if (typeof candidate === "object" && candidate !== null) {
          if (seen.has(candidate)) {
            return "[Circular]";
          }
          seen.add(candidate);
        }
        return candidate;
      },
      2
    );
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // fall through to fallback serialization
  }
  return JSON.stringify(
    {
      __nonSerializable: formatUnknownError(value),
    },
    null,
    2
  );
}

function writeDebugFileSafe(filePath: string, content: string | Buffer): void {
  try {
    fs.writeFileSync(filePath, content);
  } catch (error) {
    console.warn(
      `[debugWriter] Failed to write "${filePath}": ${formatUnknownError(error)}`
    );
  }
}

/**
 * Initialize a new debug session
 */
export function initDebugSession(): string {
  sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  actionCounter = 0;
  return sessionId;
}

/**
 * Get current session ID (create one if doesn't exist)
 */
function getSessionId(): string {
  if (!sessionId) {
    sessionId = initDebugSession();
  }
  return sessionId;
}

/**
 * Write debug data for an aiAction call
 */
export async function writeAiActionDebug(
  debugData: DebugData,
  baseDir: string = "debug/aiAction"
): Promise<string> {
  const session = getSessionId();
  const actionNum = actionCounter++;
  const debugDir = path.join(baseDir, session, `action-${actionNum}`);

  // Create debug directory
  try {
    fs.mkdirSync(debugDir, { recursive: true });
  } catch (error) {
    throw new Error(
      `[debugWriter] Failed to create debug directory "${debugDir}": ${formatUnknownError(error)}`
    );
  }

  // Write instruction and metadata
  const metadata = {
    actionNumber: actionNum,
    timestamp: debugData.timestamp,
    instruction: debugData.instruction,
    url: debugData.url,
    domElementCount: debugData.domElementCount,
    success: debugData.success,
  };
  writeDebugFileSafe(
    path.join(debugDir, "metadata.json"),
    stringifyDebugJson(metadata)
  );

  // Write DOM tree
  writeDebugFileSafe(path.join(debugDir, "dom-tree.txt"), debugData.domTree);

  // Write screenshot if available
  if (debugData.screenshot) {
    writeDebugFileSafe(path.join(debugDir, "screenshot.png"), debugData.screenshot);
  }

  // Write found element info
  if (debugData.foundElement) {
    writeDebugFileSafe(
      path.join(debugDir, "found-element.json"),
      stringifyDebugJson(debugData.foundElement)
    );
  }

  // Write LLM response if available
  if (debugData.llmResponse) {
    writeDebugFileSafe(
      path.join(debugDir, "llm-response.json"),
      stringifyDebugJson(debugData.llmResponse)
    );
    // Also write just the raw text for easy viewing
    writeDebugFileSafe(
      path.join(debugDir, "llm-response.txt"),
      debugData.llmResponse.rawText
    );
  }

  // Write available elements if provided (for debugging failures)
  if (debugData.availableElements) {
    const elementsText = debugData.availableElements
      .map((e) => `[${e.id}] ${e.role}: "${e.label}"`)
      .join("\n");
    writeDebugFileSafe(path.join(debugDir, "available-elements.txt"), elementsText);
    writeDebugFileSafe(
      path.join(debugDir, "available-elements.json"),
      stringifyDebugJson(debugData.availableElements)
    );
  }

  // Write error if present
  if (debugData.error) {
    writeDebugFileSafe(
      path.join(debugDir, "error.json"),
      stringifyDebugJson(debugData.error)
    );
  }

  // Write frame debug info if available
  if (debugData.frameDebugInfo && debugData.frameDebugInfo.length > 0) {
    writeDebugFileSafe(
      path.join(debugDir, "frame-debug-info.json"),
      stringifyDebugJson(debugData.frameDebugInfo)
    );

    // Also write a human-readable summary
    const frameSummary = debugData.frameDebugInfo
      .map((frame) => {
        const lines = [
          `Frame ${frame.frameIndex}: ${frame.frameUrl}`,
          `  Total Nodes: ${frame.totalNodes}`,
          `  Tree Elements: ${frame.treeElementCount}`,
          `  Interactive Elements: ${frame.interactiveCount}`,
        ];

        if (frame.sampleNodes && frame.sampleNodes.length > 0) {
          lines.push(`  Sample Nodes (${frame.sampleNodes.length}):`);
          frame.sampleNodes.forEach((node, idx) => {
            const ignored = node.ignored ? " [IGNORED]" : "";
            const role = node.role || "unknown";
            const name = node.name ? ` "${node.name}"` : "";
            const childCount = node.childIds
              ? ` (${node.childIds} children)`
              : "";
            lines.push(`    ${idx + 1}. ${role}${name}${childCount}${ignored}`);
          });
        }

        return lines.join("\n");
      })
      .join("\n\n");

    writeDebugFileSafe(path.join(debugDir, "frame-debug-summary.txt"), frameSummary);
  }

  return debugDir;
}

/**
 * Reset the action counter (useful for testing or new sessions)
 */
export function resetDebugSession(): void {
  actionCounter = 0;
  sessionId = null;
}
