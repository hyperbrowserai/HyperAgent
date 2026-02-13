import fs from "node:fs";
import { MCPServerConfig } from "@/types/config";
import { formatUnknownError } from "@/utils";

const MAX_MCP_CONFIG_FILE_CHARS = 1_000_000;
const UNSAFE_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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
  const normalized = (value as string[]).map((entry) => entry.trim());
  if (normalized.some((entry) => entry.length === 0)) {
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

  const normalized: Record<string, string> = Object.create(null);
  const seenKeys = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    const normalizedKey = key.toLowerCase();
    const isUnsafeKey = UNSAFE_RECORD_KEYS.has(normalizedKey);
    if (key.length === 0 || typeof rawValue !== "string" || isUnsafeKey) {
      throw new Error(
        `MCP server entry at index ${index} must provide "${field}" as an object of string key/value pairs.`
      );
    }
    const normalizedValue =
      field === "sseHeaders" ? rawValue.trim() : rawValue;
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
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `MCP server entry at index ${index} has invalid "sseUrl" value "${raw}".`
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
  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (normalized.length !== value.length) {
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
  if (normalizedConfig.includes("\u0000")) {
    throw new Error(
      "Invalid MCP config JSON: config appears to be binary or contains null bytes."
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
        throw new Error(
          `MCP server entry at index ${i} has tools present in both includeTools and excludeTools: ${overlap.join(", ")}.`
        );
      }
    }

    const normalizedId = isNonEmptyString(entry.id) ? entry.id.trim() : "";
    if (normalizedId.length > 0) {
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
      rawConnectionType &&
      rawConnectionType !== "stdio" &&
      rawConnectionType !== "sse"
    ) {
      throw new Error(
        `MCP server entry at index ${i} has unsupported connectionType "${entry.connectionType}". Supported values are "stdio" and "sse".`
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
