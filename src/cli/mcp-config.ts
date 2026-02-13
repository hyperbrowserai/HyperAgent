import fs from "node:fs";
import { MCPServerConfig } from "@/types/config";
import { formatUnknownError } from "@/utils";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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
    const normalizedEntry = { ...entry } as Record<string, unknown>;

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

    const connectionType =
      entry.connectionType === "sse" ? "sse" : "stdio";
    normalizedEntry.connectionType = connectionType;
    if (connectionType === "sse") {
      const sseUrl = isNonEmptyString(entry.sseUrl) ? entry.sseUrl.trim() : "";
      if (sseUrl.length === 0) {
        throw new Error(
          `MCP server entry at index ${i} must include a non-empty "sseUrl" for SSE connections.`
        );
      }
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
