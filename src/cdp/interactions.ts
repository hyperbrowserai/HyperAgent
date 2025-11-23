import type { Protocol } from "devtools-protocol";

import type { BoundingBox } from "@/cdp/bounding-box";
import { getBoundingBox } from "@/cdp/bounding-box";
import type { ResolvedCDPElement } from "@/cdp/element-resolver";
import type { CDPSession } from "@/cdp/types";

type MouseButton = "left" | "right" | "middle";

type ScrollDirection = "nextChunk" | "prevChunk";

type FillElementResult =
  | { status: "done" }
  | { status: "needsinput"; value: string }
  | { status: "error"; reason?: string };

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
  | "scrollToElement"
  | "scrollToPercentage"
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
  behavior?: "smooth" | "instant";
}

interface SelectOptionOptions {
  value: string;
}

type SelectOptionResult =
  | { status: "selected"; value: string }
  | { status: "notfound" };

interface ScrollDebugMetrics {
  targetTagName: string | null;
  containerTagName: string | null;
  isRootTarget: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  maxScroll: number;
}

const domEnabledSessions = new WeakSet<CDPSession>();
const runtimeEnabledSessions = new WeakSet<CDPSession>();
const inputEnabledSessions = new WeakSet<CDPSession>();

const FILL_ELEMENT_SCRIPT = `
function(rawValue) {
  try {
    const element = this;
    if (!element) {
      return { status: "error", reason: "Element missing" };
    }
    const doc = element.ownerDocument || document;
    const win = doc.defaultView || window;
    const value = rawValue == null ? "" : String(rawValue);

    const dispatchEvents = () => {
      try {
        element.dispatchEvent(new win.Event("input", { bubbles: true }));
        element.dispatchEvent(new win.Event("change", { bubbles: true }));
      } catch {}
    };

    const setUsingDescriptor = (target, prop, val) => {
      const proto = target.constructor?.prototype;
      const descriptor =
        (proto && Object.getOwnPropertyDescriptor(proto, prop)) ||
        Object.getOwnPropertyDescriptor(win.HTMLElement.prototype, prop) ||
        Object.getOwnPropertyDescriptor(win.HTMLInputElement?.prototype || {}, prop) ||
        Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement?.prototype || {}, prop);
      if (descriptor && descriptor.set) {
        descriptor.set.call(target, val);
        return true;
      }
      try {
        target[prop] = val;
        return true;
      } catch {
        return false;
      }
    };

    if (element instanceof win.HTMLInputElement) {
      const type = (element.type || "").toLowerCase();
      const directSetTypes = [
        "color",
        "date",
        "datetime-local",
        "month",
        "range",
        "time",
        "week",
        "checkbox",
        "radio",
        "file",
        "hidden",
      ];
      if (directSetTypes.includes(type)) {
        if (type === "checkbox" || type === "radio") {
          const normalized = value.trim().toLowerCase();
          element.checked =
            normalized === "true" ||
            normalized === "1" ||
            normalized === "on" ||
            normalized === "checked";
        } else {
          setUsingDescriptor(element, "value", value);
        }
        dispatchEvents();
        return { status: "done" };
      }

      const typeInputTypes = [
        "",
        "email",
        "number",
        "password",
        "search",
        "tel",
        "text",
        "url",
      ];
      if (typeInputTypes.includes(type)) {
        return { status: "needsinput", value };
      }

      setUsingDescriptor(element, "value", value);
      dispatchEvents();
      return { status: "done" };
    }

    if (element instanceof win.HTMLTextAreaElement) {
      return { status: "needsinput", value };
    }

    if (element.isContentEditable) {
      element.textContent = value;
      dispatchEvents();
      return { status: "done" };
    }

    if (setUsingDescriptor(element, "value", value)) {
      dispatchEvents();
      return { status: "done" };
    }

    return { status: "needsinput", value };
  } catch (error) {
    return { status: "error", reason: error?.message || "Failed to fill element" };
  }
}
`;

const PREPARE_FOR_TYPING_SCRIPT = `
function() {
  try {
    const element = this;
    if (!element || !element.isConnected) return false;
    const doc = element.ownerDocument || document;
    const win = doc.defaultView || window;
    try {
      if (typeof element.focus === "function") {
        element.focus();
      }
    } catch {}

    if (
      element instanceof win.HTMLInputElement ||
      element instanceof win.HTMLTextAreaElement
    ) {
      try {
        if (typeof element.select === "function") {
          element.select();
          return true;
        }
      } catch {}
      try {
        const length = (element.value || "").length;
        if (typeof element.setSelectionRange === "function") {
          element.setSelectionRange(0, length);
          return true;
        }
      } catch {}
      return true;
    }

    if (element.isContentEditable) {
      const selection = doc.getSelection?.();
      const range = doc.createRange?.();
      if (selection && range) {
        try {
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        } catch {}
      }
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
`;

function ensureActionContext(ctx: CDPActionContext): void {
  if (!ctx || !ctx.element) {
    throw new Error(
      "[CDP][Interactions] Action context missing element handle"
    );
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
      await pressKey(
        ctx,
        (args[0] as string) ?? "Enter",
        args[1] as PressOptions
      );
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
    case "scrollToElement": {
      await scrollElementIntoView(ctx);
      return;
    }
    case "scrollToPercentage": {
      const targetArg = args[0];
      const options =
        typeof targetArg === "object" && !Array.isArray(targetArg)
          ? (targetArg as ScrollToOptions)
          : { target: targetArg as string | number };
      await scrollToPosition(ctx, options);
      return;
    }
    case "scrollTo": {
      const targetArg = args[0];
      if (targetArg == null) {
        await scrollElementIntoView(ctx);
      } else {
        const options =
          typeof targetArg === "object" && !Array.isArray(targetArg)
            ? (targetArg as ScrollToOptions)
            : { target: targetArg as string | number };
        await scrollToPosition(ctx, options);
      }
      return;
    }
    case "nextChunk":
      await scrollByChunk(ctx, "nextChunk");
      return;
    case "prevChunk":
      await scrollByChunk(ctx, "prevChunk");
      return;
    default:
      throw new Error(
        `[CDP][Interactions] Unsupported action method: ${method}`
      );
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
    throw new Error(
      "[CDP][Interactions] Unable to determine element bounding box"
    );
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
    throw new Error(
      "[CDP][Interactions] Unable to determine element bounding box"
    );
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
  const fillResponse =
    await session.send<Protocol.Runtime.CallFunctionOnResponse>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: FILL_ELEMENT_SCRIPT,
        arguments: [{ value }],
        returnByValue: true,
      }
    );

  const fillResult = (fillResponse.result?.value ?? {}) as FillElementResult;

  if (fillResult.status === "error") {
    throw new Error(
      `Failed to fill element: ${fillResult.reason ?? "unknown error"}`
    );
  }

  if (fillResult.status === "needsinput") {
    const textToType = fillResult.value ?? value ?? "";

    await session
      .send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: PREPARE_FOR_TYPING_SCRIPT,
        returnByValue: true,
      })
      .catch(() => {});

    await focusElement(ctx);
    await ensureInputEnabled(session);

    if (textToType.length === 0) {
      await session.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      } as Record<string, unknown>);
      await session.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      } as Record<string, unknown>);
    } else {
      await session.send("Input.insertText", {
        text: textToType,
      });
    }
  }

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

  const keyDef = getKeyEventData(key);
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: keyDef.key,
    text: keyDef.text,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyDef.nativeVirtualKeyCode,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyDef.key,
    text: keyDef.text,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyDef.nativeVirtualKeyCode,
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
  const result = await session.send<Protocol.Runtime.CallFunctionOnResponse>(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `
      function(shouldCheck) {
        if (!this) return { status: "error", reason: "Element missing" };
        
        // 1. Native Checkbox
        if (this.tagName === "INPUT" && this.type === "checkbox") {
          if (this.checked === shouldCheck) {
            return { status: "noop" };
          }
          // Try native JS click first - this fires proper events and handles most frameworks
          this.click();
          
          // Verify if it worked
          if (this.checked !== shouldCheck) {
             // Click failed (maybe preventDefault or detached), force property
             this.checked = shouldCheck;
             this.dispatchEvent(new Event("input", { bubbles: true }));
             this.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return { status: "done" };
        }

        // 2. ARIA Checkbox (role=checkbox/switch/etc)
        const role = this.getAttribute("role");
        if (role === "checkbox" || role === "switch" || role === "menuitemcheckbox") {
          const ariaChecked = this.getAttribute("aria-checked");
          const isChecked = ariaChecked === "true";
          if (isChecked === shouldCheck) {
            return { status: "noop" };
          }
          // Need to click to toggle
          return { status: "needs_click" };
        }

        // 3. Fallback: Check specific 'checked' property existence (e.g. Web Components)
        if ("checked" in this) {
           if (this.checked === shouldCheck) {
             return { status: "noop" };
           }
           this.checked = shouldCheck;
           this.dispatchEvent(new Event("input", { bubbles: true }));
           this.dispatchEvent(new Event("change", { bubbles: true }));
           return { status: "done" };
        }

        // 4. Ambiguous element (e.g. label, div) - assume clicking toggles it
        return { status: "needs_click" };
      }
    `,
      arguments: [{ value: checked }],
      returnByValue: true,
    }
  );

  const value = (result.result?.value ?? {}) as {
    status: string;
    reason?: string;
  };

  if (value.status === "error") {
    throw new Error(
      `Failed to ${checked ? "check" : "uncheck"} element: ${
        value.reason || "unknown error"
      }`
    );
  }

  if (value.status === "needs_click") {
    await clickElement(ctx);
  }
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
  const result = await session.send<Protocol.Runtime.CallFunctionOnResponse>(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `
        function(rawValue) {
          if (!this || this.tagName?.toLowerCase() !== "select") {
            return { status: "notfound" };
          }
          const target = rawValue == null ? "" : String(rawValue).trim();
          const normalized = target.toLowerCase();
          const options = Array.from(this.options || []);
          if (!options.length) {
            return { status: "notfound" };
          }

          let byIndex = null;
          if (target && /^\\d+$/.test(target)) {
            const idx = Number(target);
            if (!Number.isNaN(idx) && idx >= 0 && idx < options.length) {
              byIndex = options[idx];
            }
          }

          const match =
            byIndex ||
            options.find((opt) => {
              if (!normalized) return false;
              const compare = (val) =>
                (val || "").toString().trim().toLowerCase();
              return (
                compare(opt.value) === normalized ||
                compare(opt.label) === normalized ||
                compare(opt.textContent) === normalized ||
                compare(opt.innerText) === normalized
              );
            }) ||
            options.find(Boolean);

          if (!match) {
            return { status: "notfound" };
          }

          try {
            this.value = match.value;
          } catch {
            return { status: "notfound" };
          }

          try {
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
          } catch {}

          return { status: "selected", value: match.value };
        }
      `,
      arguments: [{ value }],
      returnByValue: true,
    }
  );

  const selection = (result.result?.value ?? {}) as SelectOptionResult;
  if (selection.status !== "selected") {
    throw new Error(`Failed to select "${value}" (no matching option)`);
  }
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

  const beforeMetrics =
    ctx.debug && objectId
      ? await captureScrollMetrics(session, objectId)
      : null;
  const intendedScrollTop =
    beforeMetrics !== null ? beforeMetrics.maxScroll * (percent / 100) : null;

  if (ctx.debug) {
    console.log(
      `[CDP][Interactions] scrollTo target=${options.target ?? "50%"} -> ${percent}% (backendNodeId=${element.backendNodeId})`
    );
    if (beforeMetrics) {
      logScrollMetrics("before", beforeMetrics, {
        intentTop: intendedScrollTop ?? undefined,
      });
    } else {
      console.log(
        `[CDP][Interactions] scrollTo metrics unavailable before scroll (backendNodeId=${element.backendNodeId})`
      );
    }
  }

  const scrollResponse =
    await session.send<Protocol.Runtime.CallFunctionOnResponse>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `
          function(percent, behavior) {
            const pct = Math.max(0, Math.min(100, Number(percent)));
            const target = this;
            const doc = target.ownerDocument || document;
            const win = doc.defaultView || window;
            const isRoot = target === doc.documentElement || target === doc.body;
            const scrollContainer = isRoot
              ? (doc.scrollingElement || doc.documentElement || doc.body)
              : target;
            if (!scrollContainer) {
              return { status: "missing" };
            }
            const maxScroll = Math.max(
              0,
              Number(scrollContainer.scrollHeight || 0) -
                Number(scrollContainer.clientHeight || 0)
            );
            const nextTop = maxScroll * (pct / 100);

            const waitForIdle = () =>
              new Promise((resolve) => {
                const epsilon = 0.5;
                const requiredStableFrames = 4;
                const maxWaitMs = 2000;
                const raf =
                  typeof win.requestAnimationFrame === "function"
                    ? win.requestAnimationFrame.bind(win)
                    : (cb) => win.setTimeout(cb, 16);
                const caf =
                  typeof win.cancelAnimationFrame === "function"
                    ? win.cancelAnimationFrame.bind(win)
                    : win.clearTimeout.bind(win);
                let stableFrames = 0;
                let lastTop = scrollContainer.scrollTop;
                let rafHandle = null;
                const timeoutId = win.setTimeout(() => {
                  if (rafHandle != null) {
                    caf(rafHandle);
                  }
                  resolve({
                    status: "timeout",
                    finalTop: scrollContainer.scrollTop,
                    maxScroll,
                  });
                }, maxWaitMs);

                const step = () => {
                  const currentTop = scrollContainer.scrollTop;
                  if (Math.abs(currentTop - lastTop) <= epsilon) {
                    stableFrames += 1;
                  } else {
                    stableFrames = 0;
                  }
                  lastTop = currentTop;

                  if (stableFrames >= requiredStableFrames) {
                    win.clearTimeout(timeoutId);
                    if (rafHandle != null) {
                      caf(rafHandle);
                    }
                    resolve({
                      status: "done",
                      finalTop: currentTop,
                      maxScroll,
                    });
                    return;
                  }
                  rafHandle = raf(step);
                };

                rafHandle = raf(step);
              });

            scrollContainer.scrollTo({
              top: nextTop,
              behavior: behavior === "instant" ? "auto" : "smooth",
            });

            if (maxScroll === 0) {
              return {
                status: "noop",
                finalTop: scrollContainer.scrollTop,
                maxScroll,
              };
            }

            return waitForIdle();
          }
        `,
        arguments: [{ value: percent }, { value: options.behavior }],
        awaitPromise: true,
        returnByValue: true,
      }
    );
  const scrollResult = (scrollResponse.result?.value ?? null) as {
    status?: string;
    finalTop?: number;
    maxScroll?: number;
  } | null;

  if (ctx.debug) {
    const afterMetrics =
      objectId != null ? await captureScrollMetrics(session, objectId) : null;
    if (scrollResult) {
      const finalTop =
        typeof scrollResult.finalTop === "number"
          ? scrollResult.finalTop.toFixed(2)
          : "n/a";
      const maxScrollVal =
        typeof scrollResult.maxScroll === "number"
          ? scrollResult.maxScroll.toFixed(2)
          : "n/a";
      console.log(
        `[CDP][Interactions] scrollTo in-page wait status=${scrollResult.status ?? "unknown"} finalTop=${finalTop} maxScroll=${maxScrollVal}`
      );
    }
    if (afterMetrics) {
      logScrollMetrics("after", afterMetrics, {
        previousTop: beforeMetrics?.scrollTop,
      });
    } else {
      console.log(
        `[CDP][Interactions] scrollTo metrics unavailable after scroll (backendNodeId=${element.backendNodeId})`
      );
    }
  }
}

async function scrollElementIntoView(ctx: CDPActionContext): Promise<void> {
  const { element } = ctx;
  const session = element.session;

  try {
    await session.send("DOM.scrollIntoViewIfNeeded", {
      backendNodeId: element.backendNodeId,
    });
  } catch {
    const objectId = await ensureObjectHandle(element);
    await ensureRuntimeEnabled(session);
    await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `
        function() {
          if (typeof this.scrollIntoView === "function") {
            this.scrollIntoView({ behavior: "auto", block: "center" });
          }
        }
      `,
    });
  }
  await waitForScrollSettlement(session, element.backendNodeId);
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
  await waitForScrollSettlement(session, element.backendNodeId);
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
  } catch (primaryError) {
    // Try JavaScript fallback
    try {
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
    } catch (fallbackError) {
      // Re-throw with context about both failures
      throw new Error(
        `[CDP][Interactions] Failed to scroll element into view. ` +
          `Primary method failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}. ` +
          `Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
      );
    }
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

async function ensureObjectHandle(element: CDPActionElement): Promise<string> {
  if (element.objectId) {
    return element.objectId;
  }
  const response =
    (await element.session.send<Protocol.DOM.ResolveNodeResponse>(
      "DOM.resolveNode",
      {
        backendNodeId: element.backendNodeId,
      }
    )) as Protocol.DOM.ResolveNodeResponse;

  const objectId = response.object?.objectId;
  if (!objectId) {
    throw new Error("[CDP][Interactions] Failed to resolve element handle");
  }
  element.objectId = objectId;
  return objectId;
}

async function waitForScrollSettlement(
  session: CDPSession,
  backendNodeId: number
): Promise<void> {
  await ensureDomEnabled(session);

  const start = Date.now();
  const timeoutMs = 400;
  let lastPosition: { x: number; y: number } | null = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const { model } = await session.send<Protocol.DOM.GetBoxModelResponse>(
        "DOM.getBoxModel",
        { backendNodeId }
      );
      if (!model) break;
      const newPosition = {
        x: model.content[0],
        y: model.content[1],
      };
      if (
        lastPosition &&
        Math.abs(newPosition.x - lastPosition.x) < 1 &&
        Math.abs(newPosition.y - lastPosition.y) < 1
      ) {
        break;
      }
      lastPosition = newPosition;
      await delay(50);
    } catch {
      break;
    }
  }
}

async function captureScrollMetrics(
  session: CDPSession,
  objectId: string
): Promise<ScrollDebugMetrics | null> {
  await ensureRuntimeEnabled(session);
  const response = await session.send<Protocol.Runtime.CallFunctionOnResponse>(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `
          function() {
            try {
              const target = this;
              const doc = target.ownerDocument || document;
              const isRootTarget =
                target === doc.documentElement || target === doc.body;
              const scrollContainer = isRootTarget
                ? (doc.scrollingElement || doc.documentElement || doc.body)
                : target;
              if (!scrollContainer) {
                return null;
              }
              const scrollTop = Number(scrollContainer.scrollTop) || 0;
              const scrollHeight = Number(scrollContainer.scrollHeight) || 0;
              const clientHeight = Number(scrollContainer.clientHeight) || 0;
              const maxScroll = Math.max(0, scrollHeight - clientHeight);
              return {
                targetTagName: target.tagName || null,
                containerTagName: scrollContainer.tagName || null,
                isRootTarget,
                scrollTop,
                clientHeight,
                scrollHeight,
                maxScroll,
              };
            } catch (error) {
              return null;
            }
          }
        `,
      returnByValue: true,
    }
  );

  return (response.result?.value ?? null) as ScrollDebugMetrics | null;
}

function logScrollMetrics(
  phase: "before" | "after",
  metrics: ScrollDebugMetrics,
  extras?: { intentTop?: number; previousTop?: number }
): void {
  const parts = [
    `[CDP][Interactions] scrollTo metrics (${phase}) target=${metrics.targetTagName ?? "unknown"} container=${metrics.containerTagName ?? "unknown"}`,
    `scrollTop=${formatScrollNumber(metrics.scrollTop)}`,
    `maxScroll=${formatScrollNumber(metrics.maxScroll)}`,
    `clientHeight=${formatScrollNumber(metrics.clientHeight)}`,
    `scrollHeight=${formatScrollNumber(metrics.scrollHeight)}`,
  ];
  if (typeof extras?.intentTop === "number") {
    parts.push(`intentTop=${formatScrollNumber(extras.intentTop)}`);
  }
  if (typeof extras?.previousTop === "number") {
    parts.push(
      `delta=${formatScrollNumber(metrics.scrollTop - extras.previousTop)}`
    );
  }
  console.log(parts.join(" "));
}

function formatScrollNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "NaN";
  }
  return value.toFixed(2);
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

interface KeyEventData {
  key: string;
  code: string;
  text?: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
}

function getKeyEventData(inputKey: string): KeyEventData {
  const key = (inputKey ?? "").toString();
  const lower = key.toLowerCase();
  const mapping: Record<
    string,
    { key: string; code: string; keyCode: number; text?: string }
  > = {
    enter: { key: "Enter", code: "Enter", keyCode: 13 },
    tab: { key: "Tab", code: "Tab", keyCode: 9 },
    escape: { key: "Escape", code: "Escape", keyCode: 27 },
    esc: { key: "Escape", code: "Escape", keyCode: 27 },
    space: { key: " ", code: "Space", keyCode: 32, text: " " },
    backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    delete: { key: "Delete", code: "Delete", keyCode: 46 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  };

  if (mapping[lower]) {
    const entry = mapping[lower];
    return {
      key: entry.key,
      code: entry.code,
      text: entry.text,
      windowsVirtualKeyCode: entry.keyCode,
      nativeVirtualKeyCode: entry.keyCode,
    };
  }

  if (key.length === 1) {
    const char = key;
    const upper = char.toUpperCase();
    const isLetter = upper >= "A" && upper <= "Z";
    const isDigit = char >= "0" && char <= "9";
    const code = isLetter
      ? `Key${upper}`
      : isDigit
        ? `Digit${char}`
        : `Key${upper}`;
    const keyCode = isDigit ? char.charCodeAt(0) : upper.charCodeAt(0);
    return {
      key: char,
      code,
      text: char,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    };
  }

  return {
    key,
    code: key,
    windowsVirtualKeyCode: 0,
    nativeVirtualKeyCode: 0,
  };
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
