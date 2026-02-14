import type { CDPSession } from "@/cdp/types";
import { formatUnknownError } from "@/utils";

interface ScriptInjectionState {
  registered: Set<string>;
  contexts: Map<string, Set<string>>;
}

const injectedScripts = new WeakMap<object, ScriptInjectionState>();

const GLOBAL_CONTEXT_TOKEN = "__global__";
const MAX_SCRIPT_INJECTOR_DIAGNOSTIC_CHARS = 400;
const MAX_SCRIPT_INJECTOR_IDENTIFIER_CHARS = 120;

function sanitizeScriptInjectorText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const withoutControlChars = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/g, " ").trim();
}

function truncateScriptInjectorText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omittedChars = value.length - maxChars;
  return `${value.slice(0, maxChars)}... [truncated ${omittedChars} chars]`;
}

function formatScriptInjectorIdentifier(value: string): string {
  const normalized = sanitizeScriptInjectorText(value);
  if (normalized.length === 0) {
    return "unknown";
  }
  return truncateScriptInjectorText(
    normalized,
    MAX_SCRIPT_INJECTOR_IDENTIFIER_CHARS
  );
}

function formatScriptInjectorDiagnostic(value: unknown): string {
  const normalized = sanitizeScriptInjectorText(formatUnknownError(value));
  if (normalized.length === 0) {
    return "unknown error";
  }
  return truncateScriptInjectorText(
    normalized,
    MAX_SCRIPT_INJECTOR_DIAGNOSTIC_CHARS
  );
}

function getState(session: CDPSession): ScriptInjectionState {
  let state = injectedScripts.get(session as object);
  if (!state) {
    state = {
      registered: new Set<string>(),
      contexts: new Map<string, Set<string>>(),
    };
    injectedScripts.set(session as object, state);
  }
  return state;
}

function contextToken(executionContextId?: number): string {
  return executionContextId === undefined
    ? GLOBAL_CONTEXT_TOKEN
    : `ctx:${executionContextId}`;
}

async function ensureRuntimeEnabled(session: CDPSession): Promise<void> {
  try {
    await session.send("Runtime.enable");
  } catch {
    // best effort
  }
}

export async function ensureScriptInjected(
  session: CDPSession,
  key: string,
  source: string,
  executionContextId?: number
): Promise<void> {
  const state = getState(session);

  if (!state.registered.has(key)) {
    try {
      await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
      state.registered.add(key);
    } catch (error) {
      console.warn(
        `[CDP][ScriptInjector] Failed to register script ${formatScriptInjectorIdentifier(
          key
        )}: ${formatScriptInjectorDiagnostic(error)}`
      );
    }
  }

  await ensureRuntimeEnabled(session);

  let contextsForKey = state.contexts.get(key);
  if (!contextsForKey) {
    contextsForKey = new Set<string>();
    state.contexts.set(key, contextsForKey);
  }

  const token = contextToken(executionContextId);
  if (contextsForKey.has(token)) {
    return;
  }

  try {
    await session.send("Runtime.evaluate", {
      expression: source,
      includeCommandLineAPI: false,
      ...(executionContextId !== undefined
        ? { contextId: executionContextId }
        : {}),
    });
    contextsForKey.add(token);
  } catch (error) {
    console.warn(
      `[CDP][ScriptInjector] Failed to evaluate script ${formatScriptInjectorIdentifier(
        key
      )} in context ${formatScriptInjectorIdentifier(
        token
      )}: ${formatScriptInjectorDiagnostic(error)}`
    );
  }
}
