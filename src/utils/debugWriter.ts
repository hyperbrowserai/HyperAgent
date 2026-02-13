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

const MAX_DEBUG_TEXT_CHARS = 200_000;
const MAX_DEBUG_ELEMENTS = 500;
const MAX_DEBUG_FRAME_ITEMS = 100;
const MAX_DEBUG_WRITER_DIAGNOSTIC_CHARS = 500;

function sanitizeDebugWriterDiagnostic(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10) {
      return char;
    }
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDebugWriterDiagnostic(value: unknown): string {
  const normalized = sanitizeDebugWriterDiagnostic(formatUnknownError(value));
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_DEBUG_WRITER_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  const omitted = fallback.length - MAX_DEBUG_WRITER_DIAGNOSTIC_CHARS;
  return `${fallback.slice(
    0,
    MAX_DEBUG_WRITER_DIAGNOSTIC_CHARS
  )}... [truncated ${omitted} chars]`;
}

function safeReadRecordField(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeDebugText(
  value: unknown,
  fallback: string,
  maxChars: number = MAX_DEBUG_TEXT_CHARS
): string {
  const raw =
    typeof value === "string"
      ? value
      : value == null
        ? fallback
        : formatUnknownError(value);
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return fallback;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const omitted = normalized.length - maxChars;
  return `${normalized.slice(0, maxChars)}\n... [truncated ${omitted} chars]`;
}

function normalizeDebugData(input: DebugData): DebugData {
  const normalizedInstruction = normalizeDebugText(
    safeReadRecordField(input, "instruction"),
    "unknown instruction"
  );
  const normalizedUrl = normalizeDebugText(
    safeReadRecordField(input, "url"),
    "about:blank"
  );
  const normalizedTimestamp = normalizeDebugText(
    safeReadRecordField(input, "timestamp"),
    new Date().toISOString()
  );
  const domElementCountValue = safeReadRecordField(input, "domElementCount");
  const normalizedDomElementCount =
    typeof domElementCountValue === "number" &&
    Number.isFinite(domElementCountValue) &&
    domElementCountValue >= 0
      ? Math.floor(domElementCountValue)
      : 0;
  const normalizedDomTree = normalizeDebugText(
    safeReadRecordField(input, "domTree"),
    ""
  );
  const success = safeReadRecordField(input, "success") === true;

  const screenshot = safeReadRecordField(input, "screenshot");
  const normalizedScreenshot = Buffer.isBuffer(screenshot) ? screenshot : undefined;

  const foundElementRaw = safeReadRecordField(input, "foundElement");
  let foundElement: FoundElementDebugData | undefined;
  if (foundElementRaw && typeof foundElementRaw === "object") {
    const args = safeReadRecordField(foundElementRaw, "arguments");
    foundElement = {
      elementId: normalizeDebugText(
        safeReadRecordField(foundElementRaw, "elementId"),
        "unknown-element",
        500
      ),
      method: normalizeDebugText(
        safeReadRecordField(foundElementRaw, "method"),
        "unknown-method",
        200
      ),
      arguments: Array.isArray(args) ? Array.from(args).slice(0, 50) : [],
      xpath:
        typeof safeReadRecordField(foundElementRaw, "xpath") === "string"
          ? normalizeDebugText(safeReadRecordField(foundElementRaw, "xpath"), "")
          : undefined,
    };
  }

  const llmResponseRaw = safeReadRecordField(input, "llmResponse");
  const llmResponse =
    llmResponseRaw && typeof llmResponseRaw === "object"
      ? {
          rawText: normalizeDebugText(
            safeReadRecordField(llmResponseRaw, "rawText"),
            ""
          ),
          parsed: safeReadRecordField(llmResponseRaw, "parsed"),
        }
      : undefined;

  let availableElements: DebugData["availableElements"];
  const availableElementsRaw = safeReadRecordField(input, "availableElements");
  if (Array.isArray(availableElementsRaw)) {
    availableElements = availableElementsRaw.slice(0, MAX_DEBUG_ELEMENTS).map((entry) => ({
      id: normalizeDebugText(safeReadRecordField(entry, "id"), "unknown-id", 200),
      role: normalizeDebugText(
        safeReadRecordField(entry, "role"),
        "unknown-role",
        100
      ),
      label: normalizeDebugText(
        safeReadRecordField(entry, "label"),
        "",
        5_000
      ),
    }));
  }

  const errorRaw = safeReadRecordField(input, "error");
  const error =
    errorRaw && typeof errorRaw === "object"
      ? {
          message: normalizeDebugText(
            safeReadRecordField(errorRaw, "message"),
            "unknown error",
            10_000
          ),
          stack:
            typeof safeReadRecordField(errorRaw, "stack") === "string"
              ? normalizeDebugText(safeReadRecordField(errorRaw, "stack"), "", 20_000)
              : undefined,
        }
      : undefined;

  let frameDebugInfo: DebugData["frameDebugInfo"];
  const frameInfoRaw = safeReadRecordField(input, "frameDebugInfo");
  if (Array.isArray(frameInfoRaw)) {
    frameDebugInfo = frameInfoRaw.slice(0, MAX_DEBUG_FRAME_ITEMS).map((frame) => ({
      frameIndex:
        typeof safeReadRecordField(frame, "frameIndex") === "number"
          ? (safeReadRecordField(frame, "frameIndex") as number)
          : -1,
      frameUrl: normalizeDebugText(safeReadRecordField(frame, "frameUrl"), "unknown"),
      totalNodes:
        typeof safeReadRecordField(frame, "totalNodes") === "number"
          ? (safeReadRecordField(frame, "totalNodes") as number)
          : 0,
      treeElementCount:
        typeof safeReadRecordField(frame, "treeElementCount") === "number"
          ? (safeReadRecordField(frame, "treeElementCount") as number)
          : 0,
      interactiveCount:
        typeof safeReadRecordField(frame, "interactiveCount") === "number"
          ? (safeReadRecordField(frame, "interactiveCount") as number)
          : 0,
      sampleNodes: Array.isArray(safeReadRecordField(frame, "sampleNodes"))
        ? (safeReadRecordField(frame, "sampleNodes") as unknown[]).slice(0, 100).map((node) => ({
            role:
              typeof safeReadRecordField(node, "role") === "string"
                ? (safeReadRecordField(node, "role") as string)
                : undefined,
            name:
              typeof safeReadRecordField(node, "name") === "string"
                ? (safeReadRecordField(node, "name") as string)
                : undefined,
            nodeId:
              typeof safeReadRecordField(node, "nodeId") === "string"
                ? (safeReadRecordField(node, "nodeId") as string)
                : undefined,
            ignored: safeReadRecordField(node, "ignored") === true,
            childIds:
              typeof safeReadRecordField(node, "childIds") === "number"
                ? (safeReadRecordField(node, "childIds") as number)
                : undefined,
          }))
        : undefined,
    }));
  }

  return {
    instruction: normalizedInstruction,
    url: normalizedUrl,
    timestamp: normalizedTimestamp,
    domElementCount: normalizedDomElementCount,
    domTree: normalizedDomTree,
    screenshot: normalizedScreenshot,
    foundElement,
    availableElements,
    llmResponse,
    error,
    success,
    frameDebugInfo,
  };
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
      __nonSerializable: formatDebugWriterDiagnostic(value),
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
      `[debugWriter] Failed to write "${filePath}": ${formatDebugWriterDiagnostic(
        error
      )}`
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
  const normalizedDebugData = normalizeDebugData(debugData);
  const session = getSessionId();
  const actionNum = actionCounter;
  const debugDir = path.join(baseDir, session, `action-${actionNum}`);

  // Create debug directory
  try {
    fs.mkdirSync(debugDir, { recursive: true });
  } catch (error) {
    throw new Error(
      `[debugWriter] Failed to create debug directory "${debugDir}": ${formatDebugWriterDiagnostic(
        error
      )}`
    );
  }
  actionCounter += 1;

  // Write instruction and metadata
  const metadata = {
    actionNumber: actionNum,
    timestamp: normalizedDebugData.timestamp,
    instruction: normalizedDebugData.instruction,
    url: normalizedDebugData.url,
    domElementCount: normalizedDebugData.domElementCount,
    success: normalizedDebugData.success,
  };
  writeDebugFileSafe(
    path.join(debugDir, "metadata.json"),
    stringifyDebugJson(metadata)
  );

  // Write DOM tree
  writeDebugFileSafe(path.join(debugDir, "dom-tree.txt"), normalizedDebugData.domTree);

  // Write screenshot if available
  if (normalizedDebugData.screenshot) {
    writeDebugFileSafe(path.join(debugDir, "screenshot.png"), normalizedDebugData.screenshot);
  }

  // Write found element info
  if (normalizedDebugData.foundElement) {
    writeDebugFileSafe(
      path.join(debugDir, "found-element.json"),
      stringifyDebugJson(normalizedDebugData.foundElement)
    );
  }

  // Write LLM response if available
  if (normalizedDebugData.llmResponse) {
    writeDebugFileSafe(
      path.join(debugDir, "llm-response.json"),
      stringifyDebugJson(normalizedDebugData.llmResponse)
    );
    // Also write just the raw text for easy viewing
    writeDebugFileSafe(
      path.join(debugDir, "llm-response.txt"),
      normalizedDebugData.llmResponse.rawText
    );
  }

  // Write available elements if provided (for debugging failures)
  if (normalizedDebugData.availableElements) {
    const elementsText = normalizedDebugData.availableElements
      .map((e) => `[${e.id}] ${e.role}: "${e.label}"`)
      .join("\n");
    writeDebugFileSafe(path.join(debugDir, "available-elements.txt"), elementsText);
    writeDebugFileSafe(
      path.join(debugDir, "available-elements.json"),
      stringifyDebugJson(normalizedDebugData.availableElements)
    );
  }

  // Write error if present
  if (normalizedDebugData.error) {
    writeDebugFileSafe(
      path.join(debugDir, "error.json"),
      stringifyDebugJson(normalizedDebugData.error)
    );
  }

  // Write frame debug info if available
  if (normalizedDebugData.frameDebugInfo && normalizedDebugData.frameDebugInfo.length > 0) {
    writeDebugFileSafe(
      path.join(debugDir, "frame-debug-info.json"),
      stringifyDebugJson(normalizedDebugData.frameDebugInfo)
    );

    // Also write a human-readable summary
    const frameSummary = normalizedDebugData.frameDebugInfo
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
