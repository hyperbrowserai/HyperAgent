import fs from "node:fs";
import { MCPServerConfig } from "@/types/config";
import { formatUnknownError } from "@/utils";

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
  return value as string[];
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

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (key.length === 0 || typeof rawValue !== "string") {
      throw new Error(
        `MCP server entry at index ${index} must provide "${field}" as an object of string key/value pairs.`
      );
    }
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      throw new Error(
        `MCP server entry at index ${index} has duplicate "${field}" key "${key}" after trimming.`
      );
    }
    normalized[key] = rawValue;
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

  return Array.from(new Set(normalized));
}

function normalizeServersPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isRecord(payload) && Array.isArray(payload.servers)) {
    return payload.servers;
  }
  throw new Error(
    'MCP config must be a JSON array or an object with a "servers" array.'
  );
}

export function parseMCPServersConfig(rawConfig: string): MCPServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
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
      const overlap = includeTools.filter((tool) => excludeTools.includes(tool));
      if (overlap.length > 0) {
        throw new Error(
          `MCP server entry at index ${i} has tools present in both includeTools and excludeTools: ${overlap.join(", ")}.`
        );
      }
    }

    const normalizedId = isNonEmptyString(entry.id) ? entry.id.trim() : "";
    if (normalizedId.length > 0) {
      if (seenIds.has(normalizedId)) {
        throw new Error(
          `MCP server entry at index ${i} reuses duplicate id "${normalizedId}".`
        );
      }
      seenIds.add(normalizedId);
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
    const connectionType = rawConnectionType === "sse" ? "sse" : "stdio";
    normalizedEntry.connectionType = connectionType;
    if (connectionType === "sse") {
      const sseUrl = normalizeSSEUrl(entry.sseUrl, i);
      normalizedEntry.sseUrl = sseUrl;
      normalizedServers.push(normalizedEntry as MCPServerConfig);
      continue;
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
  let fileContent: string;
  try {
    fileContent = await fs.promises.readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to read MCP config file "${filePath}": ${formatUnknownError(error)}`
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
