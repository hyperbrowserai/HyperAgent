import type { Protocol } from "devtools-protocol";

import type { BoundingBox } from "@/cdp/bounding-box";
import { getBoundingBox } from "@/cdp/bounding-box";
import type { ResolvedCDPElement } from "@/cdp/element-resolver";
import type { CDPSession } from "@/cdp/types";

type MouseButton = "left" | "right" | "middle";

type ScrollDirection = "nextChunk" | "prevChunk";

export type CDPActionMethod =
  | "click"
  | "doubleClick"
  | "hover"
  | "type"
  | "fill"
  | "press"
  | "check"
  | "uncheck"
  | "selectOptionFromDropdown"
  | "scrollTo"
  | "nextChunk"
  | "prevChunk";

export interface CDPActionElement extends ResolvedCDPElement {
  xpath?: string;
}

export interface CDPActionContext {
  element: CDPActionElement;
  debug?: boolean;
  /**
   * Existing bounding box data (e.g., from visual/debug mode)
   */
  boundingBox?: BoundingBox | null;
  /**
   * Optional lazy supplier for bounding boxes (e.g., from DOM state maps)
   */
  getBoundingBox?: () => Promise<BoundingBox | null>;
  /**
   * Prefer using injected script path for bounding boxes when possible.
   */
  preferScriptBoundingBox?: boolean;
}

interface ClickOptions {
  button?: MouseButton;
  clickCount?: 1 | 2;
  delayMs?: number;
}

interface TypeOptions {
  commitEnter?: boolean;
  delayMs?: number;
}

interface PressOptions {
  delayMs?: number;
}

interface FillOptions {
  commitChange?: boolean;
}

interface ScrollToOptions {
  target?: string | number;
}

interface SelectOptionOptions {
  value: string;
}

const domEnabledSessions = new WeakSet<CDPSession>();
const runtimeEnabledSessions = new WeakSet<CDPSession>();
const inputEnabledSessions = new WeakSet<CDPSession>();

function ensureActionContext(ctx: CDPActionContext): void {
  if (!ctx || !ctx.element) {
    throw new Error("[CDP][Interactions] Action context missing element handle");
  }
}

export async function dispatchCDPAction(
  method: CDPActionMethod,
  args: unknown[],
  ctx: CDPActionContext
): Promise<void> {
  ensureActionContext(ctx);

  switch (method) {
    case "click":
      await clickElement(ctx, args[0] as ClickOptions | undefined);
      return;
    case "doubleClick":
      await clickElement(
        ctx,
        Object.assign({}, (args[0] as ClickOptions) ?? {}, { clickCount: 2 })
      );
      return;
    case "hover":
      await hoverElement(ctx);
      return;
    case "type":
      await typeText(ctx, (args[0] as string) ?? "", args[1] as TypeOptions);
      return;
    case "fill":
      await fillElement(ctx, (args[0] as string) ?? "", args[1] as FillOptions);
      return;
    case "press":
      await pressKey(ctx, (args[0] as string) ?? "Enter", args[1] as PressOptions);
      return;
    case "check":
      await setChecked(ctx, true);
      return;
    case "uncheck":
      await setChecked(ctx, false);
      return;
    case "selectOptionFromDropdown":
      await selectOption(ctx, {
        value: (args[0] as string) ?? "",
      });
      return;
    case "scrollTo":
      await scrollToPosition(ctx, (args[0] as ScrollToOptions) ?? {});
      return;
    case "nextChunk":
      await scrollByChunk(ctx, "nextChunk");
      return;
    case "prevChunk":
      await scrollByChunk(ctx, "prevChunk");
      return;
    default:
      throw new Error(`[CDP][Interactions] Unsupported action method: ${method}`);
  }
}

async function clickElement(
  ctx: CDPActionContext,
  options?: ClickOptions
): Promise<void> {
  const { element } = ctx;
  const session = element.session;
  const button = options?.button ?? "left";
  const clickCount = options?.clickCount ?? 1;

  await scrollIntoViewIfNeeded(ctx);
  const box = await getEffectiveBoundingBox(ctx);
  if (!box) {
    throw new Error("[CDP][Interactions] Unable to determine element bounding box");
  }

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await ensureInputEnabled(session);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });

  for (let i = 0; i < clickCount; i++) {
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount,
    });
    if (options?.delayMs) {
      await delay(options.delayMs);
    }
  }
}

async function hoverElement(ctx: CDPActionContext): Promise<void> {
  const { element } = ctx;
  const session = element.session;

  const box = await getEffectiveBoundingBox(ctx);
  if (!box) {
    throw new Error("[CDP][Interactions] Unable to determine element bounding box");
  }

  await ensureInputEnabled(session);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    button: "none",
  });
}

async function typeText(
  ctx: CDPActionContext,
  text: string,
  options?: TypeOptions
): Promise<void> {
  if (!text) {
    return;
  }
  const { element } = ctx;
  const session = element.session;

  await focusElement(ctx);
  await ensureInputEnabled(session);
  await session.send("Input.insertText", { text });

  if (options?.commitEnter) {
    await pressKey(ctx, "Enter");
  }
  if (options?.delayMs) {
    await delay(options.delayMs);
  }
}

async function fillElement(
  ctx: CDPActionContext,
  value: string,
  options?: FillOptions
): Promise<void> {
  const { element } = ctx;
  const session = element.session;
  const objectId = await ensureObjectHandle(element);

  await ensureRuntimeEnabled(session);
  await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `
      function(nextValue) {
        if (this && "value" in this) {
          this.value = nextValue ?? "";
          if (typeof this.dispatchEvent === "function") {
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
    `,
    arguments: [{ value }],
  });

  if (options?.commitChange) {
    await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `
        function() {
          if (typeof this.blur === "function") {
            this.blur();
          }
        }
      `,
    });
  }
}

async function pressKey(
  ctx: CDPActionContext,
  key: string,
  options?: PressOptions
): Promise<void> {
  const { element } = ctx;
  const session = element.session;

  await focusElement(ctx);
  await ensureInputEnabled(session);

  const keyDef = normalizeKeyDescriptor(key);
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: keyDef.key,
    text: keyDef.text,
    code: keyDef.code,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyDef.key,
    text: keyDef.text,
    code: keyDef.code,
  });

  if (options?.delayMs) {
    await delay(options.delayMs);
  }
}

async function setChecked(
  ctx: CDPActionContext,
  checked: boolean
): Promise<void> {
  const { element } = ctx;
  const session = element.session;
  const objectId = await ensureObjectHandle(element);

  await ensureRuntimeEnabled(session);
  await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `
      function(shouldCheck) {
        if (!this) return;
        if (this.checked === shouldCheck) return;
        this.checked = shouldCheck;
        if (typeof this.dispatchEvent === "function") {
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    `,
    arguments: [{ value: checked }],
  });
}

async function selectOption(
  ctx: CDPActionContext,
  options: SelectOptionOptions
): Promise<void> {
  const { element } = ctx;
  const session = element.session;
  const objectId = await ensureObjectHandle(element);
  const value = options.value;

  await ensureRuntimeEnabled(session);
  await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `
      function(targetValue) {
        if (!this || this.tagName?.toLowerCase() !== "select") {
          return;
        }
        const options = Array.from(this.options || []);
        const normalized = targetValue?.toString().trim().toLowerCase();
        const next = options.find(opt => {
          if (!normalized) return false;
          const byValue = (opt.value || "").toLowerCase() === normalized;
          const byText = (opt.innerText || "").toLowerCase() === normalized;
          return byValue || byText;
        }) ?? options.find(Boolean);
        if (next) {
          this.value = next.value;
          if (typeof this.dispatchEvent === "function") {
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
    `,
    arguments: [{ value }],
  });
}

async function scrollToPosition(
  ctx: CDPActionContext,
  options: ScrollToOptions
): Promise<void> {
  const percent = normalizeScrollPercent(options.target ?? "50%");
  const { element } = ctx;
  const session = element.session;
  const objectId = await ensureObjectHandle(element);

  await ensureRuntimeEnabled(session);
  await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `
      function(percent) {
        const pct = Math.max(0, Math.min(100, Number(percent)));
        const target = this;
        const isRoot = target === document.documentElement || target === document.body;
        const scrollContainer = isRoot
          ? (document.scrollingElement || document.documentElement)
          : target;
        if (!scrollContainer) return;
        const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
        const nextTop = maxScroll * (pct / 100);
        scrollContainer.scrollTo({ top: nextTop, behavior: "smooth" });
      }
    `,
    arguments: [{ value: percent }],
  });
}

async function scrollByChunk(
  ctx: CDPActionContext,
  direction: ScrollDirection
): Promise<void> {
  const { element } = ctx;
  const session = element.session;
  const objectId = await ensureObjectHandle(element);
  const box = await getEffectiveBoundingBox(ctx);

  const delta = box ? box.height : 400;
  const sign = direction === "nextChunk" ? 1 : -1;

  await ensureRuntimeEnabled(session);
  await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `
      function(amount) {
        const target = this;
        const isRoot = target === document.documentElement || target === document.body;
        const scrollContainer = isRoot
          ? (document.scrollingElement || document.documentElement)
          : target;
        if (!scrollContainer) return;
        scrollContainer.scrollBy({ top: amount, left: 0, behavior: "smooth" });
      }
    `,
    arguments: [{ value: delta * sign }],
  });
}

async function focusElement(ctx: CDPActionContext): Promise<void> {
  const { element } = ctx;
  const session = element.session;
  const objectId = await ensureObjectHandle(element);

  await ensureRuntimeEnabled(session);
  await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `
      function() {
        if (typeof this.focus === "function") {
          this.focus();
        }
      }
    `,
  });
}

async function scrollIntoViewIfNeeded(ctx: CDPActionContext): Promise<void> {
  const { element } = ctx;
  const session = element.session;
  const backendNodeId = element.backendNodeId;

  await ensureDomEnabled(session);
  try {
    await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    const objectId = await ensureObjectHandle(element);
    await ensureRuntimeEnabled(session);
    await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `
        function() {
          if (typeof this.scrollIntoView === "function") {
            this.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
          }
        }
      `,
    });
  }
}

async function getEffectiveBoundingBox(
  ctx: CDPActionContext
): Promise<BoundingBox | null> {
  if (ctx.boundingBox) {
    return ctx.boundingBox;
  }

  if (ctx.getBoundingBox) {
    const cached = await ctx.getBoundingBox();
    if (cached) {
      ctx.boundingBox = cached;
      return cached;
    }
  }

  const box = await getBoundingBox({
    session: ctx.element.session,
    backendNodeId: ctx.element.backendNodeId,
    xpath: ctx.element.xpath,
    preferScript: ctx.preferScriptBoundingBox,
  });
  if (box) {
    ctx.boundingBox = box;
  }
  return box;
}

async function ensureDomEnabled(session: CDPSession): Promise<void> {
  if (domEnabledSessions.has(session)) return;
  try {
    await session.send("DOM.enable");
  } catch {
    // best-effort
  }
  domEnabledSessions.add(session);
}

async function ensureRuntimeEnabled(session: CDPSession): Promise<void> {
  if (runtimeEnabledSessions.has(session)) return;
  try {
    await session.send("Runtime.enable");
  } catch {
    // best-effort
  }
  runtimeEnabledSessions.add(session);
}

async function ensureInputEnabled(session: CDPSession): Promise<void> {
  if (inputEnabledSessions.has(session)) return;
  try {
    await session.send("Input.enable");
  } catch {
    // Input.enable is optional; ignore failures
  }
  inputEnabledSessions.add(session);
}

async function ensureObjectHandle(
  element: CDPActionElement
): Promise<string> {
  if (element.objectId) {
    return element.objectId;
  }
  const response = (await element.session.send<
    Protocol.DOM.ResolveNodeResponse
  >("DOM.resolveNode", {
    backendNodeId: element.backendNodeId,
  })) as Protocol.DOM.ResolveNodeResponse;

  const objectId = response.object?.objectId;
  if (!objectId) {
    throw new Error("[CDP][Interactions] Failed to resolve element handle");
  }
  element.objectId = objectId;
  return objectId;
}

function normalizeScrollPercent(target: string | number): number {
  if (typeof target === "number") {
    return clamp(target, 0, 100);
  }
  const text = target.trim();
  if (text.endsWith("%")) {
    const parsed = Number.parseFloat(text.slice(0, -1));
    return clamp(Number.isNaN(parsed) ? 50 : parsed, 0, 100);
  }
  const num = Number.parseFloat(text);
  return clamp(Number.isNaN(num) ? 50 : num, 0, 100);
}

function normalizeKeyDescriptor(key: string): {
  key: string;
  code: string;
  text?: string;
} {
  const trimmed = key?.toString() ?? "";
  switch (trimmed.toLowerCase()) {
    case "enter":
      return { key: "Enter", code: "Enter" };
    case "tab":
      return { key: "Tab", code: "Tab" };
    case "escape":
    case "esc":
      return { key: "Escape", code: "Escape" };
    case "space":
      return { key: " ", code: "Space", text: " " };
    default:
      if (trimmed.length === 1) {
        return { key: trimmed, code: `Key${trimmed.toUpperCase()}`, text: trimmed };
      }
      return { key: trimmed, code: trimmed };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function delay(ms?: number): Promise<void> {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
