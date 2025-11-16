import type { CDPSession } from "@/cdp/types";

interface ScriptInjectionState {
  registered: Set<string>;
  contexts: Map<string, Set<string>>;
}

const injectedScripts = new WeakMap<object, ScriptInjectionState>();

const GLOBAL_CONTEXT_TOKEN = "__global__";

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
        `[CDP][ScriptInjector] Failed to register script ${key}:`,
        error
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
      `[CDP][ScriptInjector] Failed to evaluate script ${key} in context ${token}:`,
      error
    );
  }
}
