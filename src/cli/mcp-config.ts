import fs from "node:fs";
import { MCPServerConfig } from "@/types/config";
import { formatUnknownError } from "@/utils";

const MAX_MCP_CONFIG_FILE_CHARS = 1_000_000;
const MAX_MCP_SERVER_ENTRIES = 100;
const MAX_MCP_SERVER_ID_CHARS = 128;
const MAX_MCP_COMMAND_CHARS = 2_048;
const MAX_MCP_SSE_URL_CHARS = 4_000;
const MAX_MCP_ARGS_PER_SERVER = 100;
const MAX_MCP_ARG_CHARS = 4_000;
const MAX_MCP_TOOL_LIST_ENTRIES = 200;
const MAX_MCP_TOOL_NAME_CHARS = 256;
const MAX_MCP_RECORD_ENTRIES = 200;
const MAX_MCP_RECORD_KEY_CHARS = 256;
const MAX_MCP_RECORD_VALUE_CHARS = 4_000;
const MAX_MCP_OVERLAP_ERROR_ITEMS = 10;
const MAX_MCP_CONFIG_DIAGNOSTIC_CHARS = 200;
const UNSAFE_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

function hasUnsupportedControlChars(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return (
      (code >= 0 && code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    );
  });
}

function hasAnyControlChars(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127;
  });
}

function formatMCPConfigDiagnostic(value: unknown): string {
  const normalized =
    typeof value === "string" ? value : formatUnknownError(value);
  if (normalized.length <= MAX_MCP_CONFIG_DIAGNOSTIC_CHARS) {
    return normalized;
  }
  const omitted = normalized.length - MAX_MCP_CONFIG_DIAGNOSTIC_CHARS;
  return `${normalized.slice(0, MAX_MCP_CONFIG_DIAGNOSTIC_CHARS)}... [truncated ${omitted} chars]`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function normalizeOptionalArgs(value: unknown, index: number): string[] | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `MCP server entry at index ${index} must provide "args" as an array of strings.`
    );
  }
  if (!value.every((entry) => typeof entry === "string")) {
    throw new Error(
      `MCP server entry at index ${index} must provide "args" as an array of strings.`
    );
  }
  if (value.length > MAX_MCP_ARGS_PER_SERVER) {
    throw new Error(
      `MCP server entry at index ${index} must provide no more than ${MAX_MCP_ARGS_PER_SERVER} "args" entries.`
    );
  }
  const normalized = (value as string[]).map((entry) => entry.trim());
  if (
    normalized.some(
      (entry) =>
        entry.length === 0 ||
        entry.length > MAX_MCP_ARG_CHARS ||
        hasAnyControlChars(entry)
    )
  ) {
    throw new Error(
      `MCP server entry at index ${index} must provide "args" as an array of non-empty strings.`
    );
  }
  return normalized;
}

function normalizeOptionalStringRecord(
  field: "env" | "sseHeaders",
  value: unknown,
  index: number
): Record<string, string> | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(
      `MCP server entry at index ${index} must provide "${field}" as an object of string key/value pairs.`
    );
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_MCP_RECORD_ENTRIES) {
    throw new Error(
      `MCP server entry at index ${index} must provide no more than ${MAX_MCP_RECORD_ENTRIES} "${field}" entries.`
    );
  }

  const normalized: Record<string, string> = Object.create(null);
  const seenKeys = new Set<string>();
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    const normalizedKey = key.toLowerCase();
    const isUnsafeKey = UNSAFE_RECORD_KEYS.has(normalizedKey);
    if (
      key.length === 0 ||
      typeof rawValue !== "string" ||
      isUnsafeKey ||
      hasAnyControlChars(key) ||
      hasAnyControlChars(rawValue)
    ) {
      throw new Error(
        `MCP server entry at index ${index} must provide "${field}" as an object of string key/value pairs.`
      );
    }
    if (
      field === "sseHeaders" &&
      !HTTP_HEADER_NAME_PATTERN.test(key)
    ) {
      throw new Error(
        `MCP server entry at index ${index} must provide "${field}" as an object of string key/value pairs.`
      );
    }
    const normalizedValue =
      field === "sseHeaders" ? rawValue.trim() : rawValue;
    if (
      key.length > MAX_MCP_RECORD_KEY_CHARS ||
      normalizedValue.length > MAX_MCP_RECORD_VALUE_CHARS
    ) {
      throw new Error(
        `MCP server entry at index ${index} must provide "${field}" as an object of string key/value pairs.`
      );
    }
    if (field === "sseHeaders" && normalizedValue.length === 0) {
      throw new Error(
        `MCP server entry at index ${index} must provide "${field}" as an object of string key/value pairs.`
      );
    }
    const duplicateLookupKey = field === "sseHeaders" ? normalizedKey : key;
    if (seenKeys.has(duplicateLookupKey)) {
      throw new Error(
        `MCP server entry at index ${index} has duplicate "${field}" key "${key}" after trimming.`
      );
    }
    seenKeys.add(duplicateLookupKey);
    normalized[key] = normalizedValue;
  }
  return normalized;
}

function normalizeSSEUrl(value: unknown, index: number): string {
  const raw = isNonEmptyString(value) ? value.trim() : "";
  if (raw.length === 0) {
    throw new Error(
      `MCP server entry at index ${index} must include a non-empty "sseUrl" for SSE connections.`
    );
  }
  if (hasAnyControlChars(raw)) {
    throw new Error(
      `MCP server entry at index ${index} has invalid "sseUrl" value "${formatMCPConfigDiagnostic(raw)}".`
    );
  }
  if (raw.length > MAX_MCP_SSE_URL_CHARS) {
    throw new Error(
      `MCP server entry at index ${index} has invalid "sseUrl" value "${formatMCPConfigDiagnostic(raw)}".`
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `MCP server entry at index ${index} has invalid "sseUrl" value "${formatMCPConfigDiagnostic(raw)}".`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `MCP server entry at index ${index} has unsupported sseUrl protocol "${url.protocol}". Use http:// or https://.`
    );
  }
  return url.toString();
}

function normalizeOptionalStringArray(
  field: "includeTools" | "excludeTools",
  value: unknown,
  index: number
): string[] | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `MCP server entry at index ${index} must provide "${field}" as an array of non-empty strings.`
    );
  }
  if (value.length > MAX_MCP_TOOL_LIST_ENTRIES) {
    throw new Error(
      `MCP server entry at index ${index} must provide no more than ${MAX_MCP_TOOL_LIST_ENTRIES} "${field}" entries.`
    );
  }
  const trimmedValues = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (trimmedValues.length !== value.length) {
    throw new Error(
      `MCP server entry at index ${index} must provide "${field}" as an array of non-empty strings.`
    );
  }
  if (trimmedValues.some((entry) => hasAnyControlChars(entry))) {
    throw new Error(
      `MCP server entry at index ${index} must provide "${field}" as an array of non-empty strings.`
    );
  }
  const normalized = trimmedValues.map((entry) => entry.replace(/\s+/g, " "));
  if (
    normalized.some(
      (entry) =>
        entry.length > MAX_MCP_TOOL_NAME_CHARS ||
        hasAnyControlChars(entry)
    )
  ) {
    throw new Error(
      `MCP server entry at index ${index} must provide "${field}" as an array of non-empty strings.`
    );
  }

  const seen = new Set<string>();
  for (const toolName of normalized) {
    const normalizedKey = toolName.toLowerCase();
    if (seen.has(normalizedKey)) {
      throw new Error(
        `MCP server entry at index ${index} contains duplicate "${field}" value "${toolName}" after trimming.`
      );
    }
    seen.add(normalizedKey);
  }

  return normalized;
}

function normalizeServersPayload(payload: unknown): unknown[] {
  const ensureNonEmpty = (servers: unknown[]): unknown[] => {
    if (servers.length === 0) {
      throw new Error(
        "MCP config must include at least one server entry."
      );
    }
    if (servers.length > MAX_MCP_SERVER_ENTRIES) {
      throw new Error(
        `MCP config must include no more than ${MAX_MCP_SERVER_ENTRIES} server entries.`
      );
    }
    return servers;
  };

  if (Array.isArray(payload)) {
    return ensureNonEmpty(payload);
  }
  if (isRecord(payload) && Array.isArray(payload.servers)) {
    return ensureNonEmpty(payload.servers);
  }
  throw new Error(
    'MCP config must be a JSON array or an object with a "servers" array.'
  );
}

export function parseMCPServersConfig(rawConfig: string): MCPServerConfig[] {
  let parsed: unknown;
  const normalizedConfig = rawConfig.replace(/^\uFEFF/, "").trim();
  if (normalizedConfig.length === 0) {
    throw new Error("Invalid MCP config JSON: config is empty.");
  }
  if (normalizedConfig.includes("\u0000")) {
    throw new Error(
      "Invalid MCP config JSON: config appears to be binary or contains null bytes."
    );
  }
  if (hasUnsupportedControlChars(normalizedConfig)) {
    throw new Error(
      "Invalid MCP config JSON: config contains unsupported control characters."
    );
  }
  if (normalizedConfig.length > MAX_MCP_CONFIG_FILE_CHARS) {
    throw new Error(
      `Invalid MCP config JSON: config exceeds ${MAX_MCP_CONFIG_FILE_CHARS} characters.`
    );
  }
  try {
    parsed = JSON.parse(normalizedConfig);
  } catch (error) {
    throw new Error(
      `Invalid MCP config JSON: ${formatUnknownError(error)}`
    );
  }

  const servers = normalizeServersPayload(parsed);
  const seenIds = new Set<string>();
  const normalizedServers: MCPServerConfig[] = [];
  for (let i = 0; i < servers.length; i += 1) {
    const entry = servers[i];
    if (!isRecord(entry)) {
      throw new Error(`MCP server entry at index ${i} must be an object.`);
    }
    if (
      Object.prototype.hasOwnProperty.call(entry, "id") &&
      typeof entry.id !== "string"
    ) {
      throw new Error(
        `MCP server entry at index ${i} must provide "id" as a string when specified.`
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(entry, "connectionType") &&
      typeof entry.connectionType !== "string"
    ) {
      throw new Error(
        `MCP server entry at index ${i} must provide "connectionType" as a string when specified.`
      );
    }
    const normalizedEntry = { ...entry } as Record<string, unknown>;
    const args = normalizeOptionalArgs(entry.args, i);
    const env = normalizeOptionalStringRecord("env", entry.env, i);
    const sseHeaders = normalizeOptionalStringRecord(
      "sseHeaders",
      entry.sseHeaders,
      i
    );
    const includeTools = normalizeOptionalStringArray(
      "includeTools",
      entry.includeTools,
      i
    );
    const excludeTools = normalizeOptionalStringArray(
      "excludeTools",
      entry.excludeTools,
      i
    );
    if (includeTools) {
      normalizedEntry.includeTools = includeTools;
    }
    if (excludeTools) {
      normalizedEntry.excludeTools = excludeTools;
    }
    if (args) {
      normalizedEntry.args = args;
    }
    if (env) {
      normalizedEntry.env = env;
    }
    if (sseHeaders) {
      normalizedEntry.sseHeaders = sseHeaders;
    }
    if (includeTools && excludeTools) {
      const excludeLookup = new Set(excludeTools.map((tool) => tool.toLowerCase()));
      const overlap = includeTools.filter((tool) =>
        excludeLookup.has(tool.toLowerCase())
      );
      if (overlap.length > 0) {
        const overlapPreview = overlap.slice(0, MAX_MCP_OVERLAP_ERROR_ITEMS);
        const omittedCount = overlap.length - overlapPreview.length;
        const overlapSummary =
          omittedCount > 0
            ? `${overlapPreview.join(", ")}, ... (+${omittedCount} more)`
            : overlapPreview.join(", ");
        throw new Error(
          `MCP server entry at index ${i} has tools present in both includeTools and excludeTools: ${overlapSummary}.`
        );
      }
    }

    const normalizedId = isNonEmptyString(entry.id) ? entry.id.trim() : "";
    if (normalizedId.length > 0) {
      if (hasAnyControlChars(normalizedId)) {
        throw new Error(
          `MCP server entry at index ${i} must provide "id" as a string when specified.`
        );
      }
      if (normalizedId.length > MAX_MCP_SERVER_ID_CHARS) {
        throw new Error(
          `MCP server entry at index ${i} must provide "id" as a string when specified.`
        );
      }
      const normalizedIdLookup = normalizedId.toLowerCase();
      if (seenIds.has(normalizedIdLookup)) {
        throw new Error(
          `MCP server entry at index ${i} reuses duplicate id "${normalizedId}".`
        );
      }
      seenIds.add(normalizedIdLookup);
      normalizedEntry.id = normalizedId;
    } else {
      delete normalizedEntry.id;
    }

    const rawConnectionType = isNonEmptyString(entry.connectionType)
      ? entry.connectionType.trim().toLowerCase()
      : undefined;
    if (
      typeof rawConnectionType === "string" &&
      hasAnyControlChars(rawConnectionType)
    ) {
      throw new Error(
        `MCP server entry at index ${i} has unsupported connectionType "${formatMCPConfigDiagnostic(
          entry.connectionType
        )}". Supported values are "stdio" and "sse".`
      );
    }
    if (
      rawConnectionType &&
      rawConnectionType !== "stdio" &&
      rawConnectionType !== "sse"
    ) {
      throw new Error(
        `MCP server entry at index ${i} has unsupported connectionType "${formatMCPConfigDiagnostic(
          entry.connectionType
        )}". Supported values are "stdio" and "sse".`
      );
    }
    const hasCommand = isNonEmptyString(entry.command);
    const hasSseUrl = isNonEmptyString(entry.sseUrl);
    if (!rawConnectionType && hasCommand && hasSseUrl) {
      throw new Error(
        `MCP server entry at index ${i} is ambiguous: provide either "command" (stdio) or "sseUrl" (sse), or set explicit "connectionType".`
      );
    }
    const inferredConnectionType =
      !rawConnectionType && hasSseUrl && !hasCommand ? "sse" : "stdio";
    const connectionType = rawConnectionType === "sse"
      ? "sse"
      : rawConnectionType === "stdio"
        ? "stdio"
        : inferredConnectionType;
    normalizedEntry.connectionType = connectionType;
    if (connectionType === "sse") {
      if (hasCommand || args || env) {
        throw new Error(
          `MCP server entry at index ${i} configured as sse cannot define stdio fields ("command", "args", or "env").`
        );
      }
      const sseUrl = normalizeSSEUrl(entry.sseUrl, i);
      normalizedEntry.sseUrl = sseUrl;
      normalizedServers.push(normalizedEntry as MCPServerConfig);
      continue;
    }

    if (hasSseUrl || sseHeaders) {
      throw new Error(
        `MCP server entry at index ${i} configured as stdio cannot define sse fields ("sseUrl" or "sseHeaders").`
      );
    }

    const command = isNonEmptyString(entry.command) ? entry.command.trim() : "";
    if (command.length === 0) {
      throw new Error(
        `MCP server entry at index ${i} must include a non-empty "command" for stdio connections.`
      );
    }
    if (hasAnyControlChars(command)) {
      throw new Error(
        `MCP server entry at index ${i} must include a non-empty "command" for stdio connections.`
      );
    }
    if (command.length > MAX_MCP_COMMAND_CHARS) {
      throw new Error(
        `MCP server entry at index ${i} must include a non-empty "command" for stdio connections.`
      );
    }
    normalizedEntry.command = command;
    normalizedServers.push(normalizedEntry as MCPServerConfig);
  }
  return normalizedServers;
}

export async function loadMCPServersFromFile(
  filePath: string
): Promise<MCPServerConfig[]> {
  let fileStats: fs.Stats | undefined;
  try {
    fileStats = await fs.promises.stat(filePath);
  } catch {
    // Fall through to readFile for missing/inaccessible path diagnostics.
  }

  if (fileStats && !fileStats.isFile()) {
    throw new Error(
      `Failed to read MCP config file "${filePath}": path is not a regular file.`
    );
  }
  if (fileStats && fileStats.size > MAX_MCP_CONFIG_FILE_CHARS) {
    throw new Error(
      `Invalid MCP config file "${filePath}": config exceeds ${MAX_MCP_CONFIG_FILE_CHARS} characters.`
    );
  }

  let fileContent: string;
  try {
    fileContent = await fs.promises.readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to read MCP config file "${filePath}": ${formatUnknownError(error)}`
    );
  }

  if (fileContent.length > MAX_MCP_CONFIG_FILE_CHARS) {
    throw new Error(
      `Invalid MCP config file "${filePath}": config exceeds ${MAX_MCP_CONFIG_FILE_CHARS} characters.`
    );
  }

  try {
    return parseMCPServersConfig(fileContent);
  } catch (error) {
    throw new Error(
      `Invalid MCP config file "${filePath}": ${formatUnknownError(error)}`
    );
  }
}
