import type { CDPSession } from "@/cdp/types";

const injectedScripts = new WeakMap<object, Set<string>>();

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
  source: string
): Promise<void> {
  let cache = injectedScripts.get(session as object);
  if (!cache) {
    cache = new Set();
    injectedScripts.set(session as object, cache);
  }
  if (cache.has(key)) return;

  try {
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
  } catch (error) {
    console.warn(
      `[CDP][ScriptInjector] Failed to register script ${key}:`,
      error
    );
  }

  await ensureRuntimeEnabled(session);
  try {
    await session.send("Runtime.evaluate", {
      expression: source,
      includeCommandLineAPI: false,
    });
  } catch (error) {
    console.warn(
      `[CDP][ScriptInjector] Failed to evaluate script ${key}:`,
      error
    );
  }

  cache.add(key);
}
