import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Tool } from "@modelcontextprotocol/sdk/types";
import { MCPServerConfig } from "@/types/config";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { formatUnknownError } from "@/utils";
import { v4 as uuidv4 } from "uuid";

interface ServerConnection {
  id: string;
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  tools: Map<string, Tool>;
  actions: AgentActionDefinition[];
}

type MCPToolResult = Awaited<ReturnType<Client["callTool"]>>;
type MCPToolDiscoveryOptions = Pick<
  MCPServerConfig,
  "includeTools" | "excludeTools"
>;
type NormalizedDiscoveredMCPTool = {
  tool: Tool;
  normalizedName: string;
};
const MAX_MCP_PAYLOAD_CHARS = 4000;
const MAX_MCP_TOOL_PARAMS_JSON_CHARS = 100_000;
const MAX_MCP_PARAM_DEPTH = 25;
const MAX_MCP_PARAM_STRING_CHARS = 20_000;
const MAX_MCP_PARAM_KEY_CHARS = 256;
const MAX_MCP_PARAM_COLLECTION_SIZE = 500;
const MAX_MCP_IDENTIFIER_DIAGNOSTIC_CHARS = 128;
const MAX_MCP_TOOL_NAME_CHARS = 256;
const MAX_MCP_SERVER_ID_CHARS = 256;
const MAX_MCP_AMBIGUOUS_SERVER_IDS = 5;
const MAX_MCP_TOOL_DIAGNOSTIC_ITEMS = 10;
const MAX_MCP_CONFIG_SERVER_ID_CHARS = 128;
const MAX_MCP_CONFIG_COMMAND_CHARS = 2_048;
const MAX_MCP_CONFIG_SSE_URL_CHARS = 4_000;
const MAX_MCP_CONFIG_ARGS_PER_SERVER = 100;
const MAX_MCP_CONFIG_ARG_CHARS = 4_000;
const MAX_MCP_CONFIG_RECORD_ENTRIES = 200;
const MAX_MCP_CONFIG_RECORD_KEY_CHARS = 256;
const MAX_MCP_CONFIG_RECORD_VALUE_CHARS = 4_000;
const MAX_MCP_DISCOVERED_TOOLS = 500;
const MAX_MCP_TOOL_DESCRIPTION_CHARS = 2_000;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const UNSAFE_MCP_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
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

function isMCPServerConfig(value: unknown): value is MCPServerConfig {
  try {
    return isPlainRecord(value);
  } catch {
    return false;
  }
}

function validateParamStringValue(value: string): string {
  if (hasUnsupportedControlChars(value)) {
    throw new Error(
      "MCP tool params cannot include unsupported control characters in string values"
    );
  }
  if (value.length > MAX_MCP_PARAM_STRING_CHARS) {
    throw new Error(
      `MCP tool params cannot include string values longer than ${MAX_MCP_PARAM_STRING_CHARS} characters`
    );
  }
  return value;
}

function formatMCPIdentifier(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value : formatUnknownError(value);
  const normalized = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return fallback;
  }
  if (normalized.length <= MAX_MCP_IDENTIFIER_DIAGNOSTIC_CHARS) {
    return normalized;
  }
  return `${normalized.slice(
    0,
    MAX_MCP_IDENTIFIER_DIAGNOSTIC_CHARS
  )}... [truncated]`;
}

function normalizeMCPExecutionToolName(toolName: unknown): string {
  if (typeof toolName !== "string") {
    throw new Error("MCP tool name must be a string");
  }
  const normalized = toolName.trim();
  if (normalized.length === 0) {
    throw new Error("MCP tool name must be a non-empty string");
  }
  if (hasAnyControlChars(normalized)) {
    throw new Error("MCP tool name contains unsupported control characters");
  }
  if (normalized.length > MAX_MCP_TOOL_NAME_CHARS) {
    throw new Error(
      `MCP tool name exceeds ${MAX_MCP_TOOL_NAME_CHARS} characters`
    );
  }
  return normalized;
}

function normalizeMCPExecutionServerId(
  serverId?: string
): string | undefined {
  if (typeof serverId === "undefined") {
    return undefined;
  }
  if (typeof serverId !== "string") {
    throw new Error("MCP serverId must be a string when provided");
  }
  const normalized = serverId.trim();
  if (normalized.length === 0) {
    throw new Error("MCP serverId must be a non-empty string when provided");
  }
  if (hasAnyControlChars(normalized)) {
    throw new Error("MCP serverId contains unsupported control characters");
  }
  if (normalized.length > MAX_MCP_SERVER_ID_CHARS) {
    throw new Error(
      `MCP serverId exceeds ${MAX_MCP_SERVER_ID_CHARS} characters`
    );
  }
  return normalized;
}

function normalizeMCPConnectionServerId(serverId?: string): string | undefined {
  if (typeof serverId === "undefined") {
    return undefined;
  }
  if (typeof serverId !== "string") {
    throw new Error("MCP server id must be a string when provided");
  }
  const normalized = serverId.trim();
  if (normalized.length === 0) {
    throw new Error("MCP server id must be a non-empty string when provided");
  }
  if (hasAnyControlChars(normalized)) {
    throw new Error("MCP server id contains unsupported control characters");
  }
  if (normalized.length > MAX_MCP_CONFIG_SERVER_ID_CHARS) {
    throw new Error(
      `MCP server id exceeds ${MAX_MCP_CONFIG_SERVER_ID_CHARS} characters`
    );
  }
  return normalized;
}

function normalizeMCPConnectionType(
  value?: MCPServerConfig["connectionType"]
): "stdio" | "sse" {
  if (typeof value === "undefined") {
    return "stdio";
  }
  if (typeof value !== "string") {
    throw new Error(
      'MCP connectionType must be either "stdio" or "sse" when provided'
    );
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || hasAnyControlChars(normalized)) {
    throw new Error(
      'MCP connectionType must be either "stdio" or "sse" when provided'
    );
  }
  if (normalized === "stdio" || normalized === "sse") {
    return normalized;
  }
  throw new Error(
    'MCP connectionType must be either "stdio" or "sse" when provided'
  );
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveMCPConnectionType(serverConfig: MCPServerConfig): "stdio" | "sse" {
  if (typeof serverConfig.connectionType !== "undefined") {
    return normalizeMCPConnectionType(serverConfig.connectionType);
  }
  const hasCommand = hasNonEmptyString(serverConfig.command);
  const hasSSEUrl = hasNonEmptyString(serverConfig.sseUrl);
  if (hasCommand && hasSSEUrl) {
    throw new Error(
      "MCP config mixes stdio and sse fields. Set connectionType and provide only matching fields."
    );
  }
  if (hasSSEUrl) {
    return "sse";
  }
  return "stdio";
}

function validateMCPConnectionFieldMix(
  options: {
    connectionType: "stdio" | "sse";
    command?: string;
    sseUrl?: string;
    args?: string[];
    env?: Record<string, string>;
    sseHeaders?: Record<string, string>;
  }
): void {
  const { connectionType, command, sseUrl, args, env, sseHeaders } = options;
  const stdioFields: string[] = [];
  if (hasNonEmptyString(command)) {
    stdioFields.push("command");
  }
  if (typeof args !== "undefined") {
    stdioFields.push("args");
  }
  if (typeof env !== "undefined") {
    stdioFields.push("env");
  }

  const sseFields: string[] = [];
  if (hasNonEmptyString(sseUrl)) {
    sseFields.push("sseUrl");
  }
  if (typeof sseHeaders !== "undefined") {
    sseFields.push("sseHeaders");
  }

  if (connectionType === "sse" && stdioFields.length > 0) {
    throw new Error(
      `MCP SSE connection cannot include stdio fields: ${stdioFields.join(", ")}`
    );
  }
  if (connectionType === "stdio" && sseFields.length > 0) {
    throw new Error(
      `MCP stdio connection cannot include sse fields: ${sseFields.join(", ")}`
    );
  }
}

function normalizeMCPConnectionCommand(command?: string): string {
  if (typeof command !== "string") {
    throw new Error("Command is required for stdio connection type");
  }
  const normalized = command.trim();
  if (normalized.length === 0) {
    throw new Error("Command is required for stdio connection type");
  }
  if (hasAnyControlChars(normalized)) {
    throw new Error("MCP command contains unsupported control characters");
  }
  if (normalized.length > MAX_MCP_CONFIG_COMMAND_CHARS) {
    throw new Error(
      `MCP command exceeds ${MAX_MCP_CONFIG_COMMAND_CHARS} characters`
    );
  }
  return normalized;
}

function normalizeMCPConnectionSSEUrl(sseUrl?: string): string {
  if (typeof sseUrl !== "string") {
    throw new Error("SSE URL is required for SSE connection type");
  }
  const normalized = sseUrl.trim();
  if (normalized.length === 0) {
    throw new Error("SSE URL is required for SSE connection type");
  }
  if (hasAnyControlChars(normalized)) {
    throw new Error("SSE URL contains unsupported control characters");
  }
  if (normalized.length > MAX_MCP_CONFIG_SSE_URL_CHARS) {
    throw new Error(
      `SSE URL exceeds ${MAX_MCP_CONFIG_SSE_URL_CHARS} characters`
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalized);
  } catch {
    throw new Error("Invalid SSE URL for SSE connection type");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("SSE URL must use http:// or https://");
  }
  return parsedUrl.toString();
}

function normalizeMCPConnectionArgs(args?: string[]): string[] | undefined {
  if (typeof args === "undefined") {
    return undefined;
  }
  if (!Array.isArray(args)) {
    throw new Error("MCP command args must be an array of non-empty strings");
  }
  let argCount = 0;
  try {
    argCount = args.length;
  } catch {
    throw new Error("MCP command args must be an array of non-empty strings");
  }
  if (argCount > MAX_MCP_CONFIG_ARGS_PER_SERVER) {
    throw new Error(
      `MCP command args cannot contain more than ${MAX_MCP_CONFIG_ARGS_PER_SERVER} entries`
    );
  }
  const normalizedArgs: string[] = [];
  for (let index = 0; index < argCount; index += 1) {
    let arg: unknown;
    try {
      arg = args[index];
    } catch {
      throw new Error("MCP command args must be an array of non-empty strings");
    }
    if (typeof arg !== "string") {
      throw new Error("MCP command args must be an array of non-empty strings");
    }
    const normalized = arg.trim();
    if (normalized.length === 0) {
      throw new Error("MCP command args must be an array of non-empty strings");
    }
    if (hasAnyControlChars(normalized)) {
      throw new Error("MCP command args contain unsupported control characters");
    }
    if (normalized.length > MAX_MCP_CONFIG_ARG_CHARS) {
      throw new Error(
        `MCP command args cannot include entries longer than ${MAX_MCP_CONFIG_ARG_CHARS} characters`
      );
    }
    normalizedArgs.push(normalized);
  }
  return normalizedArgs;
}

function normalizeMCPConnectionStringRecord(
  field: "env" | "sseHeaders",
  value: unknown
): Record<string, string> | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error(
      `MCP ${field} must be an object of string key/value pairs`
    );
  }
  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(value);
  } catch {
    throw new Error(
      `MCP ${field} must be an object of string key/value pairs`
    );
  }
  if (entries.length > MAX_MCP_CONFIG_RECORD_ENTRIES) {
    throw new Error(
      `MCP ${field} cannot include more than ${MAX_MCP_CONFIG_RECORD_ENTRIES} entries`
    );
  }
  const normalized: Record<string, string> = Object.create(null);
  const seenKeys = new Set<string>();
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    const lowerKey = key.toLowerCase();
    if (
      key.length === 0 ||
      key.length > MAX_MCP_CONFIG_RECORD_KEY_CHARS ||
      hasAnyControlChars(key) ||
      UNSAFE_MCP_RECORD_KEYS.has(lowerKey) ||
      typeof rawValue !== "string" ||
      hasAnyControlChars(rawValue)
    ) {
      throw new Error(
        `MCP ${field} must be an object of string key/value pairs`
      );
    }
    if (field === "sseHeaders" && !HTTP_HEADER_NAME_PATTERN.test(key)) {
      throw new Error(
        `MCP ${field} must be an object of string key/value pairs`
      );
    }
    const normalizedValue =
      field === "sseHeaders" ? rawValue.trim() : rawValue;
    if (
      normalizedValue.length > MAX_MCP_CONFIG_RECORD_VALUE_CHARS ||
      (field === "sseHeaders" && normalizedValue.length === 0)
    ) {
      throw new Error(
        `MCP ${field} must be an object of string key/value pairs`
      );
    }
    const duplicateLookup = field === "sseHeaders" ? lowerKey : key;
    if (seenKeys.has(duplicateLookup)) {
      throw new Error(`MCP ${field} contains duplicate key "${key}"`);
    }
    seenKeys.add(duplicateLookup);
    normalized[key] = normalizedValue;
  }
  return normalized;
}

function summarizeMCPServerIds(serverIds: string[]): string {
  const preview = serverIds
    .slice(0, MAX_MCP_AMBIGUOUS_SERVER_IDS)
    .map((id) => formatMCPIdentifier(id, "unknown-server"));
  const omitted = serverIds.length - preview.length;
  if (omitted > 0) {
    return `${preview.join(", ")}, ... (+${omitted} more)`;
  }
  return preview.join(", ");
}

function summarizeMCPToolNames(toolNames: string[]): string {
  const preview = toolNames
    .slice(0, MAX_MCP_TOOL_DIAGNOSTIC_ITEMS)
    .map((name) => formatMCPIdentifier(name, "unknown-tool"));
  const omitted = toolNames.length - preview.length;
  if (omitted > 0) {
    return `${preview.join(", ")}, ... (+${omitted} more)`;
  }
  return preview.join(", ");
}

function normalizeMCPToolFilterList(
  value: string[] | undefined,
  fieldName: "includeTools" | "excludeTools"
): Set<string> | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`MCP ${fieldName} must be an array of tool names`);
  }
  const normalizedValues = value.map((name) =>
    normalizeMCPExecutionToolName(name)
  );
  const seenNames = new Set<string>();
  const seenNamesLower = new Set<string>();
  for (const normalizedName of normalizedValues) {
    const lower = normalizedName.toLowerCase();
    if (seenNamesLower.has(lower)) {
      throw new Error(
        `MCP ${fieldName} contains duplicate tool name "${formatMCPIdentifier(
          normalizedName,
          "unknown-tool"
        )}" after normalization`
      );
    }
    seenNamesLower.add(lower);
    seenNames.add(normalizedName);
  }
  return seenNames;
}

function normalizeMCPToolFilterListValues(
  value: string[] | undefined,
  fieldName: "includeTools" | "excludeTools"
): string[] | undefined {
  const normalizedSet = normalizeMCPToolFilterList(value, fieldName);
  if (!normalizedSet) {
    return undefined;
  }
  return Array.from(normalizedSet);
}

function safeHasOwnProperty(value: Record<string, unknown>, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

export function normalizeDiscoveredMCPTools(
  tools: Tool[],
  options: MCPToolDiscoveryOptions
): NormalizedDiscoveredMCPTool[] {
  const includeSet = normalizeMCPToolFilterList(
    options.includeTools,
    "includeTools"
  );
  const excludeSet = normalizeMCPToolFilterList(
    options.excludeTools,
    "excludeTools"
  );
  const includeLookup = includeSet
    ? new Set(Array.from(includeSet).map((name) => name.toLowerCase()))
    : undefined;
  const excludeLookup = excludeSet
    ? new Set(Array.from(excludeSet).map((name) => name.toLowerCase()))
    : undefined;
  if (includeSet && excludeSet) {
    const overlap = Array.from(excludeSet).filter((name) =>
      includeLookup?.has(name.toLowerCase())
    );
    if (overlap.length > 0) {
      throw new Error(
        `MCP includeTools and excludeTools overlap on: ${summarizeMCPToolNames(
          overlap
        )}`
      );
    }
  }
  const seenToolNames = new Set<string>();
  const seenToolNamesByLookup = new Map<string, string>();
  const normalizedTools: NormalizedDiscoveredMCPTool[] = [];

  for (const tool of tools) {
    const normalizedName = normalizeMCPExecutionToolName(tool.name);
    const normalizedLookup = normalizedName.toLowerCase();
    if (seenToolNames.has(normalizedName)) {
      throw new Error(
        `MCP server returned duplicate tool name "${formatMCPIdentifier(
          normalizedName,
          "unknown-tool"
        )}"`
      );
    }
    const existingCaseVariant = seenToolNamesByLookup.get(normalizedLookup);
    if (existingCaseVariant && existingCaseVariant !== normalizedName) {
      throw new Error(
        `MCP server returned duplicate tool name "${formatMCPIdentifier(
          normalizedName,
          "unknown-tool"
        )}" after case normalization (conflicts with "${formatMCPIdentifier(
          existingCaseVariant,
          "unknown-tool"
        )}")`
      );
    }
    seenToolNames.add(normalizedName);
    seenToolNamesByLookup.set(normalizedLookup, normalizedName);

    if (includeLookup && !includeLookup.has(normalizedLookup)) {
      continue;
    }
    if (excludeLookup && excludeLookup.has(normalizedLookup)) {
      continue;
    }

    normalizedTools.push({
      tool,
      normalizedName,
    });
  }

  if (includeSet && normalizedTools.length === 0) {
    const includeNames = summarizeMCPToolNames(Array.from(includeSet));
    const availableNames =
      seenToolNames.size === 0
        ? "none"
        : summarizeMCPToolNames(Array.from(seenToolNames));
    throw new Error(
      `No MCP tools matched includeTools filter (${includeNames}). Available tools: ${availableNames}.`
    );
  }

  return normalizedTools;
}

export function normalizeMCPListToolsPayload(value: unknown): Tool[] {
  if (!isPlainRecord(value) || !safeHasOwnProperty(value, "tools")) {
    throw new Error("Invalid MCP listTools response: expected a tools array");
  }
  let toolsValue: unknown;
  try {
    toolsValue = value.tools;
  } catch {
    throw new Error(
      "Invalid MCP listTools response: unable to read tools array"
    );
  }
  if (!Array.isArray(toolsValue)) {
    throw new Error("Invalid MCP listTools response: expected a tools array");
  }
  if (toolsValue.length > MAX_MCP_DISCOVERED_TOOLS) {
    throw new Error(
      `Invalid MCP listTools response: received more than ${MAX_MCP_DISCOVERED_TOOLS} tools`
    );
  }
  if (
    toolsValue.some((tool) => typeof tool !== "object" || tool === null)
  ) {
    throw new Error(
      "Invalid MCP listTools response: each tool entry must be an object"
    );
  }
  return toolsValue as Tool[];
}

function safeGetMCPListToolsPayload(value: unknown): Tool[] {
  try {
    return normalizeMCPListToolsPayload(value);
  } catch (error) {
    const message = formatUnknownError(error);
    const prefix = "Invalid MCP listTools response:";
    if (message.startsWith(prefix)) {
      throw new Error(message);
    }
    throw new Error(`${prefix} ${message}`);
  }
}

function findConnectedServerId(
  servers: Map<string, ServerConnection>,
  requestedId: string
): string | undefined {
  if (servers.has(requestedId)) {
    return requestedId;
  }
  const requestedLookup = requestedId.toLowerCase();
  for (const existingId of servers.keys()) {
    if (existingId.toLowerCase() === requestedLookup) {
      return existingId;
    }
  }
  return undefined;
}

function resolveConnectedServerIdForManagement(
  servers: Map<string, ServerConnection>,
  requestedId: unknown
): string | undefined {
  if (typeof requestedId !== "string") {
    return undefined;
  }
  const normalized = requestedId.trim();
  if (normalized.length === 0 || hasAnyControlChars(normalized)) {
    return undefined;
  }
  try {
    return findConnectedServerId(servers, normalized);
  } catch {
    return undefined;
  }
}

function safeGetConnectedServerIds(
  servers: Map<string, ServerConnection>
): string[] {
  try {
    return Array.from(servers.keys());
  } catch {
    return [];
  }
}

function safeGetConnectedServerEntries(
  servers: Map<string, ServerConnection>
): Array<[string, ServerConnection]> {
  try {
    return Array.from(servers.entries());
  } catch {
    return [];
  }
}

function resolveMCPToolNameOnServer(
  tools: Map<string, Tool>,
  requestedToolName: string
): { toolName?: string; ambiguousMatches?: string[] } {
  let hasExactToolMatch = false;
  try {
    hasExactToolMatch = tools.has(requestedToolName);
  } catch (error) {
    throw new Error(
      `MCP tool registry lookup failed: ${formatMCPIdentifier(
        error,
        "unknown-error"
      )}`
    );
  }
  if (hasExactToolMatch) {
    return { toolName: requestedToolName };
  }
  const requestedLookup = requestedToolName.toLowerCase();
  let toolNames: string[];
  try {
    toolNames = Array.from(tools.keys());
  } catch (error) {
    throw new Error(
      `MCP tool registry lookup failed: ${formatMCPIdentifier(
        error,
        "unknown-error"
      )}`
    );
  }
  const caseInsensitiveMatches = toolNames.filter(
    (toolName) => toolName.toLowerCase() === requestedLookup
  );
  if (caseInsensitiveMatches.length === 1) {
    return { toolName: caseInsensitiveMatches[0] };
  }
  if (caseInsensitiveMatches.length > 1) {
    return { ambiguousMatches: caseInsensitiveMatches };
  }
  return {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const MCPToolActionParams = z.object({
  params: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .describe(
      "Parameters for the MCP tool. Provide either a JSON object directly or a JSON string."
    ),
});

type MCPToolActionInput = z.infer<typeof MCPToolActionParams>;

export function stringifyMCPPayload(value: unknown): string {
  const truncate = (content: string): string =>
    content.length <= MAX_MCP_PAYLOAD_CHARS
      ? content
      : `${content.slice(0, MAX_MCP_PAYLOAD_CHARS)}... [truncated]`;

  try {
    const serialized = JSON.stringify(value);
    return truncate(
      typeof serialized === "string"
        ? serialized
        : formatUnknownError(value)
    );
  } catch {
    return truncate(formatUnknownError(value));
  }
}

export function normalizeMCPToolDescription(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= MAX_MCP_TOOL_DESCRIPTION_CHARS) {
    return normalized;
  }
  const omitted = normalized.length - MAX_MCP_TOOL_DESCRIPTION_CHARS;
  return `${normalized.slice(
    0,
    MAX_MCP_TOOL_DESCRIPTION_CHARS
  )}... [truncated ${omitted} chars]`;
}

export function normalizeMCPToolParams(
  input: MCPToolActionInput["params"]
): Record<string, unknown> {
  const normalizeParamKey = (value: string): string => value.trim().toLowerCase();

  const sanitizeParamValue = (
    value: unknown,
    seen: WeakSet<object>,
    depth: number
  ): unknown => {
    if (depth > MAX_MCP_PARAM_DEPTH) {
      throw new Error(
        `MCP tool params exceed maximum nesting depth of ${MAX_MCP_PARAM_DEPTH}`
      );
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) {
        throw new Error("MCP tool params cannot include circular references");
      }
      if (value.length > MAX_MCP_PARAM_COLLECTION_SIZE) {
        throw new Error(
          `MCP tool params cannot include collections with more than ${MAX_MCP_PARAM_COLLECTION_SIZE} entries`
        );
      }
      seen.add(value);
      try {
        return value.map((entry) => sanitizeParamValue(entry, seen, depth + 1));
      } finally {
        seen.delete(value);
      }
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("MCP tool params cannot include non-finite number values");
    }
    if (typeof value === "bigint") {
      return `${value.toString()}n`;
    }
    if (typeof value === "symbol") {
      return value.toString();
    }
    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }
    if (typeof value === "string") {
      return validateParamStringValue(value);
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? value.toString() : value.toISOString();
    }
    if (value instanceof Set) {
      if (seen.has(value)) {
        throw new Error("MCP tool params cannot include circular references");
      }
      if (value.size > MAX_MCP_PARAM_COLLECTION_SIZE) {
        throw new Error(
          `MCP tool params cannot include collections with more than ${MAX_MCP_PARAM_COLLECTION_SIZE} entries`
        );
      }
      seen.add(value);
      try {
        return Array.from(value).map((entry) =>
          sanitizeParamValue(entry, seen, depth + 1)
        );
      } finally {
        seen.delete(value);
      }
    }
    if (value instanceof Map) {
      if (seen.has(value)) {
        throw new Error("MCP tool params cannot include circular references");
      }
      if (value.size > MAX_MCP_PARAM_COLLECTION_SIZE) {
        throw new Error(
          `MCP tool params cannot include collections with more than ${MAX_MCP_PARAM_COLLECTION_SIZE} entries`
        );
      }
      seen.add(value);
      try {
        const sanitizedMap: Record<string, unknown> = Object.create(null);
        const seenMapKeys = new Set<string>();
        for (const [rawKey, mapValue] of value.entries()) {
          const normalizedRawKey =
            typeof rawKey === "string" ? rawKey : formatUnknownError(rawKey);
          const trimmedMapKey = normalizedRawKey.trim();
          if (trimmedMapKey.length === 0) {
            throw new Error("MCP tool params cannot include empty keys");
          }
          if (trimmedMapKey.length > MAX_MCP_PARAM_KEY_CHARS) {
            throw new Error(
              `MCP tool params cannot include keys longer than ${MAX_MCP_PARAM_KEY_CHARS} characters`
            );
          }
          if (hasAnyControlChars(trimmedMapKey)) {
            throw new Error(
              "MCP tool params cannot include keys with control characters"
            );
          }
          const normalizedMapKey = trimmedMapKey.replace(/\s+/g, " ");
          if (seenMapKeys.has(normalizedMapKey)) {
            throw new Error(
              `MCP tool params cannot include duplicate key after trimming: "${normalizedMapKey}"`
            );
          }
          seenMapKeys.add(normalizedMapKey);
          sanitizedMap[normalizedMapKey] = sanitizeParamValue(
            mapValue,
            seen,
            depth + 1
          );
        }
        return sanitizedMap;
      } finally {
        seen.delete(value);
      }
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        throw new Error("MCP tool params cannot include circular references");
      }
      if (!isPlainRecord(value)) {
        return validateParamStringValue(formatUnknownError(value));
      }
      seen.add(value);
      try {
        const sanitized: Record<string, unknown> = Object.create(null);
        const entries = Object.entries(value);
        if (entries.length > MAX_MCP_PARAM_COLLECTION_SIZE) {
          throw new Error(
            `MCP tool params cannot include collections with more than ${MAX_MCP_PARAM_COLLECTION_SIZE} entries`
          );
        }
        const seenKeys = new Set<string>();
        for (const [key, paramValue] of entries) {
          const trimmedObjectKey = key.trim();
          if (trimmedObjectKey.length === 0) {
            throw new Error("MCP tool params cannot include empty keys");
          }
          if (trimmedObjectKey.length > MAX_MCP_PARAM_KEY_CHARS) {
            throw new Error(
              `MCP tool params cannot include keys longer than ${MAX_MCP_PARAM_KEY_CHARS} characters`
            );
          }
          if (hasAnyControlChars(trimmedObjectKey)) {
            throw new Error(
              "MCP tool params cannot include keys with control characters"
            );
          }
          const normalizedObjectKey = trimmedObjectKey.replace(/\s+/g, " ");
          const normalizedKey = normalizeParamKey(key);
          if (UNSAFE_OBJECT_KEYS.has(normalizedKey)) {
            throw new Error(`MCP tool params cannot include reserved key "${key}"`);
          }
          if (seenKeys.has(normalizedObjectKey)) {
            throw new Error(
              `MCP tool params cannot include duplicate key after trimming: "${normalizedObjectKey}"`
            );
          }
          seenKeys.add(normalizedObjectKey);
          sanitized[normalizedObjectKey] = sanitizeParamValue(
            paramValue,
            seen,
            depth + 1
          );
        }
        return sanitized;
      } finally {
        seen.delete(value);
      }
    }
    return value;
  };

  const sanitizeParamInput = (value: unknown): Record<string, unknown> => {
    const sanitized = sanitizeParamValue(value, new WeakSet<object>(), 0);
    if (
      typeof sanitized !== "object" ||
      sanitized === null ||
      Array.isArray(sanitized)
    ) {
      throw new Error("MCP tool params must be a JSON object at the root level");
    }
    return sanitized as Record<string, unknown>;
  };

  if (typeof input === "string") {
    const trimmedInput = input.trim();
    if (trimmedInput.length === 0) {
      throw new Error(
        "Invalid MCP tool params JSON string: input is empty"
      );
    }
    if (hasUnsupportedControlChars(trimmedInput)) {
      throw new Error(
        "Invalid MCP tool params JSON string: contains unsupported control characters"
      );
    }
    if (trimmedInput.length > MAX_MCP_TOOL_PARAMS_JSON_CHARS) {
      throw new Error(
        `Invalid MCP tool params JSON string: exceeds ${MAX_MCP_TOOL_PARAMS_JSON_CHARS} characters`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedInput);
    } catch (error) {
      const message = formatUnknownError(error);
      throw new Error(`Invalid MCP tool params JSON string: ${message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        "MCP tool params must parse to a JSON object, not an array or primitive"
      );
    }
    return sanitizeParamInput(parsed);
  }

  return sanitizeParamInput(input);
}

class MCPClient {
  private servers: Map<string, ServerConnection> = new Map();
  private debug: boolean;
  constructor(debug: boolean = false) {
    this.debug = debug;
  }

  /**
   * Connect to an MCP server and register its tools
   * @param serverConfig The server configuration
   * @returns List of action definitions provided by the server
   */
  async connectToServer(
    serverConfig: MCPServerConfig
  ): Promise<{ serverId: string; actions: AgentActionDefinition[] }> {
    let pendingTransport: StdioClientTransport | SSEClientTransport | undefined;
    let pendingServerId: string | undefined;
    try {
      if (!isMCPServerConfig(serverConfig)) {
        throw new Error("MCP server config must be an object");
      }
      // Generate or use provided server ID
      const normalizedConfigServerId = normalizeMCPConnectionServerId(
        serverConfig.id
      );
      const serverId = normalizedConfigServerId || uuidv4();
      const normalizedIncludeTools = normalizeMCPToolFilterListValues(
        serverConfig.includeTools,
        "includeTools"
      );
      const normalizedExcludeTools = normalizeMCPToolFilterListValues(
        serverConfig.excludeTools,
        "excludeTools"
      );
      pendingServerId = serverId;
      const existingServerId = findConnectedServerId(this.servers, serverId);
      if (existingServerId) {
        throw new Error(
          `MCP server with ID "${formatMCPIdentifier(
            serverId,
            "unknown-server"
          )}" is already connected`
        );
      }

      // Create transport for this server
      let transport;
      const connectionType = resolveMCPConnectionType(serverConfig);
      const args = normalizeMCPConnectionArgs(serverConfig.args);
      const env = normalizeMCPConnectionStringRecord("env", serverConfig.env);
      const sseHeaders = normalizeMCPConnectionStringRecord(
        "sseHeaders",
        serverConfig.sseHeaders
      );
      let normalizedCommand: string | undefined;
      let normalizedSSEUrl: string | undefined;
      validateMCPConnectionFieldMix({
        connectionType,
        command: serverConfig.command,
        sseUrl: serverConfig.sseUrl,
        args,
        env,
        sseHeaders,
      });

      if (connectionType === "sse") {
        const sseUrl = normalizeMCPConnectionSSEUrl(serverConfig.sseUrl);
        normalizedSSEUrl = sseUrl;

        if (this.debug) {
          console.log(
            `Establishing SSE connection to ${sseUrl}...`
          );
        }

        transport = new SSEClientTransport(
          new URL(sseUrl),
          sseHeaders
            ? {
                requestInit: {
                  headers: sseHeaders,
                },
              }
            : undefined
        );

        transport.onerror = (error: unknown) => {
          const message = formatUnknownError(error);
          console.error(`SSE error: ${message}`);
        };
      } else {
        const command = normalizeMCPConnectionCommand(serverConfig.command);
        normalizedCommand = command;

        transport = new StdioClientTransport({
          command,
          args,
          env: {
            ...((process.env ?? {}) as Record<string, string>),
            ...(env ?? {}),
          },
          // Pipe stdin/stdout, ignore stderr
          stderr: this.debug ? "inherit" : "ignore",
        });
      }
      pendingTransport = transport;

      const client = new Client({
        name: `hyperagent-mcp-client-${serverId}`,
        version: "1.0.0",
      });

      await client.connect(transport);

      const toolsResult = await client.listTools();
      const listedTools = safeGetMCPListToolsPayload(toolsResult);
      const toolsMap = new Map<string, Tool>();

      const discoveredTools = normalizeDiscoveredMCPTools(
        listedTools,
        {
          includeTools: normalizedIncludeTools,
          excludeTools: normalizedExcludeTools,
        }
      );

      // Create actions for each tool
      const actions = discoveredTools.map(({ tool, normalizedName }) => {
          const normalizedToolDescription = normalizeMCPToolDescription(
            tool.description
          );
          const descriptionPrefix =
            normalizedToolDescription.length > 0
              ? `${normalizedToolDescription} `
              : "";
          // Store tool reference for later use
          toolsMap.set(normalizedName, tool);

          // Create action definition
          return {
            type: normalizedName,
            actionParams: MCPToolActionParams.describe(
              `${descriptionPrefix}Tool input schema: ${stringifyMCPPayload(tool.inputSchema)}`
            ),
            run: async (
              ctx: ActionContext,
              action: MCPToolActionInput
            ): Promise<ActionOutput> => {
              if (!ctx.mcpClient) {
                throw new Error(
                  "MCP client not available. Please ensure an MCP server is connected."
                );
              }

              const params = normalizeMCPToolParams(action.params);
              const targetServerId = serverId;

              const result = await ctx.mcpClient.executeTool(
                normalizedName,
                params,
                targetServerId
              );

              return {
                success: true,
                message: `MCP tool ${normalizedName} execution successful: ${stringifyMCPPayload(result)}`,
              };
            },
          };
        });

      const normalizedServerConfig: MCPServerConfig = {
        id: serverId,
        connectionType,
      };
      if (normalizedCommand) {
        normalizedServerConfig.command = normalizedCommand;
      }
      if (args) {
        normalizedServerConfig.args = args;
      }
      if (env) {
        normalizedServerConfig.env = env;
      }
      if (normalizedSSEUrl) {
        normalizedServerConfig.sseUrl = normalizedSSEUrl;
      }
      if (sseHeaders) {
        normalizedServerConfig.sseHeaders = sseHeaders;
      }
      if (normalizedIncludeTools) {
        normalizedServerConfig.includeTools = normalizedIncludeTools;
      }
      if (normalizedExcludeTools) {
        normalizedServerConfig.excludeTools = normalizedExcludeTools;
      }

      // Store server connection
      this.servers.set(serverId, {
        id: serverId,
        config: normalizedServerConfig,
        client,
        transport,
        tools: toolsMap,
        actions,
      });
      if (this.debug) {
        console.log(`Connected to MCP server with ID: ${serverId}`);
        console.log("Added tools:", Array.from(toolsMap.keys()));
      }
      return { serverId, actions };
    } catch (error) {
      if (
        pendingTransport &&
        (!pendingServerId || !this.servers.has(pendingServerId))
      ) {
        try {
          await pendingTransport.close();
        } catch (cleanupError) {
          if (this.debug) {
            console.warn(
              `Failed to clean up MCP transport after connect failure: ${formatUnknownError(
                cleanupError
              )}`
            );
          }
        }
      }
      console.error(
        `Failed to connect to MCP server: ${formatUnknownError(error)}`
      );
      throw error;
    }
  }

  /**
   * Execute a tool on a specific server
   * @param toolName The name of the tool to execute
   * @param parameters The parameters to pass to the tool
   * @param serverId The ID of the server to use (optional)
   * @returns The result of the tool execution
   */
  async executeTool(
    toolName: string,
    parameters: Record<string, unknown> | string,
    serverId?: string
  ): Promise<MCPToolResult> {
    const normalizedParameters = normalizeMCPToolParams(parameters);
    const normalizedToolName = normalizeMCPExecutionToolName(toolName);
    const normalizedServerId = normalizeMCPExecutionServerId(serverId);
    const safeToolName = formatMCPIdentifier(normalizedToolName, "unknown-tool");
    const safeServerId = (): string =>
      formatMCPIdentifier(serverId, "unknown-server");
    let resolvedToolNameForServer: string | undefined;

    // If no server ID provided and only one server exists, use that one
    if (!normalizedServerId && this.servers.size === 1) {
      serverId = [...this.servers.keys()][0];
    }

    // If no server ID provided and multiple servers exist, try to find one with the tool
    if (!normalizedServerId && this.servers.size > 1) {
      const matchingServers: Array<{ serverId: string; toolName: string }> = [];
      for (const [id, server] of this.servers.entries()) {
        const resolvedTool = resolveMCPToolNameOnServer(
          server.tools,
          normalizedToolName
        );
        if (resolvedTool.ambiguousMatches) {
          throw new Error(
            `Tool "${safeToolName}" matches multiple tools on server "${formatMCPIdentifier(
              id,
              "unknown-server"
            )}" (${summarizeMCPToolNames(
              resolvedTool.ambiguousMatches
            )}). Use exact tool name.`
          );
        }
        if (resolvedTool.toolName) {
          matchingServers.push({
            serverId: id,
            toolName: resolvedTool.toolName,
          });
        }
      }
      if (matchingServers.length === 1) {
        serverId = matchingServers[0].serverId;
        resolvedToolNameForServer = matchingServers[0].toolName;
      }
      if (matchingServers.length > 1) {
        throw new Error(
          `Tool "${safeToolName}" is registered on multiple servers (${summarizeMCPServerIds(
            matchingServers.map((entry) => entry.serverId)
          )}). Provide serverId explicitly.`
        );
      }
    } else if (normalizedServerId) {
      serverId = findConnectedServerId(this.servers, normalizedServerId);
    }

    if (!serverId || !this.servers.has(serverId)) {
      throw new Error(`No valid server found for tool ${safeToolName}`);
    }

    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server with ID ${safeServerId()} not found`);
    }
    const resolvedTool = resolvedToolNameForServer
      ? { toolName: resolvedToolNameForServer }
      : resolveMCPToolNameOnServer(server.tools, normalizedToolName);
    if (resolvedTool.ambiguousMatches) {
      throw new Error(
        `Tool "${safeToolName}" matches multiple tools on server "${safeServerId()}" (${summarizeMCPToolNames(
          resolvedTool.ambiguousMatches
        )}). Use exact tool name.`
      );
    }
    const resolvedToolName = resolvedTool.toolName;
    if (!resolvedToolName) {
      throw new Error(
        `Tool "${safeToolName}" is not registered on server "${safeServerId()}"`
      );
    }
    const registeredTool = server.tools.get(resolvedToolName);
    if (!registeredTool) {
      throw new Error(
        `Tool "${safeToolName}" is not registered on server "${safeServerId()}"`
      );
    }

    try {
      const remoteToolName =
        typeof registeredTool.name === "string" &&
        registeredTool.name.length > 0
          ? registeredTool.name
          : normalizedToolName;
      const result = await server.client.callTool({
        name: remoteToolName,
        arguments: normalizedParameters,
      });

      return result;
    } catch (error) {
      const message = formatUnknownError(error);
      console.error(
        `Error executing tool ${safeToolName} on server ${safeServerId()}: ${message}`
      );
      throw new Error(
        `Error executing tool ${safeToolName} on server ${safeServerId()}: ${message}`
      );
    }
  }

  /**
   * Get all registered action definitions from all connected servers
   * @returns Array of action definitions
   */
  getAllActions(): AgentActionDefinition[] {
    const allActions: AgentActionDefinition[] = [];
    for (const [, server] of safeGetConnectedServerEntries(this.servers)) {
      allActions.push(...server.actions);
    }
    return allActions;
  }

  /**
   * Get the IDs of all connected servers
   * @returns Array of server IDs
   */
  getServerIds(): string[] {
    return safeGetConnectedServerIds(this.servers);
  }

  /**
   * Disconnect from a specific server
   * @param serverId The ID of the server to disconnect from
   */
  async disconnectServer(serverId: string): Promise<void> {
    const resolvedServerId = resolveConnectedServerIdForManagement(
      this.servers,
      serverId
    );
    if (!resolvedServerId) {
      return;
    }
    const server = this.servers.get(resolvedServerId);
    if (server) {
      let closeError: unknown;
      try {
        await server.transport.close();
      } catch (error) {
        closeError = error;
      } finally {
        this.servers.delete(resolvedServerId);
      }
      if (closeError) {
        throw new Error(formatUnknownError(closeError));
      }
      if (this.debug) {
        console.log(`Disconnected from MCP server with ID: ${resolvedServerId}`);
      }
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnect(): Promise<void> {
    for (const serverId of safeGetConnectedServerIds(this.servers)) {
      try {
        await this.disconnectServer(serverId);
      } catch (error) {
        console.error(
          `Failed to disconnect MCP server ${serverId}: ${formatUnknownError(error)}`
        );
      }
    }
  }

  /**
   * Check if a tool exists on any connected server
   * @param toolName The name of the tool to check
   * @returns Boolean indicating if the tool exists and the server ID it exists on
   */
  hasTool(toolName: string): {
    exists: boolean;
    serverId?: string;
    serverIds?: string[];
    isAmbiguous?: boolean;
  } {
    let normalizedToolName: string;
    try {
      normalizedToolName = normalizeMCPExecutionToolName(toolName);
    } catch {
      return { exists: false };
    }
    const matchingServerIds: string[] = [];
    const ambiguousServerIds: string[] = [];
    try {
      for (const [serverId, server] of this.servers.entries()) {
        const resolvedTool = resolveMCPToolNameOnServer(
          server.tools,
          normalizedToolName
        );
        if (resolvedTool.ambiguousMatches) {
          ambiguousServerIds.push(serverId);
        } else if (resolvedTool.toolName) {
          matchingServerIds.push(serverId);
        }
      }
    } catch {
      return { exists: false };
    }
    const allMatchedServerIds = [...matchingServerIds, ...ambiguousServerIds];
    if (allMatchedServerIds.length === 0) {
      return { exists: false };
    }
    if (allMatchedServerIds.length === 1 && ambiguousServerIds.length === 0) {
      return { exists: true, serverId: allMatchedServerIds[0] };
    }
    return {
      exists: true,
      serverId: allMatchedServerIds[0],
      serverIds: allMatchedServerIds,
      isAmbiguous: true,
    };
  }

  /**
   * Get information about all connected servers
   * @returns Array of server information objects
   */
  getServerInfo(): Array<{
    id: string;
    toolCount: number;
    toolNames: string[];
  }> {
    return safeGetConnectedServerEntries(this.servers).map(([id, server]) => ({
      id,
      toolCount: server.tools.size,
      toolNames: Array.from(server.tools.keys()),
    }));
  }

  /**
   * Check if any servers are connected
   * @returns Boolean indicating if any servers are connected
   */
  hasConnections(): boolean {
    return this.getServerIds().length > 0;
  }
}

export { MCPClient };
