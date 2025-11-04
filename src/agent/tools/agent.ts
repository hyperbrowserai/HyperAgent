import { AgentStep } from "@/types/agent/types";
import fs from "fs";

import {
  ActionContext,
  ActionOutput,
  ActionType,
  AgentActionDefinition,
} from "@/types";
import { getDom } from "@/context-providers/dom";
import { retry } from "@/utils/retry";
import { sleep } from "@/utils/sleep";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";

import { AgentOutputFn, endTaskStatuses } from "@hyperbrowser/agent/types";
import {
  TaskParams,
  TaskOutput,
  TaskState,
  TaskStatus,
} from "@hyperbrowser/agent/types";

import { HyperagentError } from "../error";
import { buildAgentStepMessages } from "../messages/builder";
import { SYSTEM_PROMPT } from "../messages/system-prompt";
import { z } from "zod";
import { DOMState } from "@/context-providers/dom/types";
import { Page } from "playwright-core";
import { ActionNotFoundError } from "../actions";
import { AgentCtx } from "./types";
import { HyperAgentMessage } from "@/llm/types";
import { Jimp } from "jimp";

const compositeScreenshot = async (page: Page, overlay: string) => {
  const screenshot = await page.screenshot({ type: "png" });
  const [baseImage, overlayImage] = await Promise.all([
    Jimp.read(screenshot as Buffer),
    Jimp.read(Buffer.from(overlay, "base64")),
  ]);
  baseImage.composite(overlayImage, 0, 0);
  const buffer = await baseImage.getBuffer("image/png");
  return buffer.toString("base64");
};

const getActionSchema = (actions: Array<AgentActionDefinition>) => {
  const zodDefs = actions.map((action) =>
    z.object({
      type: z.literal(action.type),
      params: action.actionParams,
      actionDescription: z
        .string()
        .describe(
          "Describe why you are performing this action and what you aim to perform with this action."
        ),
    })
  );
  return z.union([zodDefs[0], zodDefs[1], ...zodDefs.splice(2)] as any);
};

const getActionHandler = (
  actions: Array<AgentActionDefinition>,
  type: string
) => {
  const foundAction = actions.find((actions) => actions.type === type);
  if (foundAction) {
    return foundAction.run;
  } else {
    throw new ActionNotFoundError(type);
  }
};

const runAction = async (
  action: ActionType,
  domState: DOMState,
  page: Page,
  ctx: AgentCtx
): Promise<ActionOutput> => {
  const actionCtx: ActionContext = {
    domState,
    page,
    tokenLimit: ctx.tokenLimit,
    llm: ctx.llm,
    debugDir: ctx.debugDir,
    mcpClient: ctx.mcpClient || undefined,
    variables: Object.values(ctx.variables),
    actionConfig: ctx.actionConfig,
  };
  const actionType = action.type;
  const actionHandler = getActionHandler(ctx.actions, action.type);
  if (!actionHandler) {
    return {
      success: false,
      message: `Unknown action type: ${actionType}`,
    };
  }
  try {
    return await actionHandler(actionCtx, action.params);
  } catch (error) {
    return {
      success: false,
      message: `Action ${action.type} failed: ${error}`,
    };
  }
};

export const runAgentTask = async (
  ctx: AgentCtx,
  taskState: TaskState,
  params?: TaskParams
): Promise<TaskOutput> => {
  const taskId = taskState.id;
  const debugDir = params?.debugDir || `debug/${taskId}`;
  if (ctx.debug) {
    console.log(`Debugging task ${taskId} in ${debugDir}`);
  }
  if (!taskState) {
    throw new HyperagentError(`Task ${taskId} not found`);
  }

  taskState.status = TaskStatus.RUNNING as TaskStatus;
  if (!ctx.llm) {
    throw new HyperagentError("LLM not initialized");
  }
  // Use the new structured output interface
  const actionSchema = getActionSchema(ctx.actions);

  // V1 always uses visual mode with full system prompt
  const systemPrompt = SYSTEM_PROMPT;

  const baseMsgs: HyperAgentMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  let output = "";
  const page = taskState.startingPage;
  let currStep = 0;
  while (true) {
    // Status Checks
    if ((taskState.status as TaskStatus) == TaskStatus.PAUSED) {
      await sleep(100);
      continue;
    }
    if (endTaskStatuses.has(taskState.status)) {
      break;
    }
    if (params?.maxSteps && currStep >= params.maxSteps) {
      taskState.status = TaskStatus.CANCELLED;
      break;
    }
    const debugStepDir = `${debugDir}/step-${currStep}`;
    if (ctx.debug) {
      fs.mkdirSync(debugStepDir, { recursive: true });
    }

    // Get DOM State (V1 always uses visual mode)
    let domState: DOMState | null = null;
    try {
      domState = await retry({
        func: async () => {
          const s = await getDom(page);
          if (!s) throw new Error("no dom state");
          return s;
        },
        params: {
          retryCount: 3,
        },
      });
    } catch (error) {
      if (ctx.debug) {
        console.log(
          "Failed to retrieve DOM state after 3 retries. Failing task.",
          error
        );
      }
      taskState.status = TaskStatus.FAILED;
      taskState.error = "Failed to retrieve DOM state";
      break;
    }

    if (!domState) {
      taskState.status = TaskStatus.FAILED;
      taskState.error = "Failed to retrieve DOM state";
      break;
    }

    // V1 always uses visual mode with composite screenshot
    let trimmedScreenshot: string | undefined;
    if (domState.screenshot) {
      trimmedScreenshot = await compositeScreenshot(
        page,
        domState.screenshot.startsWith("data:image/png;base64,")
          ? domState.screenshot.slice("data:image/png;base64,".length)
          : domState.screenshot
      );
    }

    // Store Dom State for Debugging
    if (ctx.debug) {
      fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(`${debugStepDir}/elems.txt`, domState.domState);
      if (trimmedScreenshot) {
        fs.writeFileSync(
          `${debugStepDir}/screenshot.png`,
          Buffer.from(trimmedScreenshot, "base64")
        );
      }
    }

    // Build Agent Step Messages
    const msgs = await buildAgentStepMessages(
      baseMsgs,
      taskState.steps,
      taskState.task,
      page,
      domState,
      trimmedScreenshot,
      Object.values(ctx.variables)
    );

    // Store Agent Step Messages for Debugging
    if (ctx.debug) {
      fs.writeFileSync(
        `${debugStepDir}/msgs.json`,
        JSON.stringify(msgs, null, 2)
      );
    }

    // Invoke LLM with structured output
    const structuredResult = await retry({
      func: () =>
        ctx.llm.invokeStructured(
          {
            schema: AgentOutputFn(actionSchema),
            options: {
              temperature: 0,
            },
          },
          msgs
        ),
    });

    if (!structuredResult.parsed) {
      throw new Error("Failed to get structured output from LLM");
    }

    const agentOutput = structuredResult.parsed;

    params?.debugOnAgentOutput?.(agentOutput);

    // Status Checks
    if ((taskState.status as TaskStatus) == TaskStatus.PAUSED) {
      await sleep(100);
      continue;
    }
    if (endTaskStatuses.has(taskState.status)) {
      break;
    }

    // Run Actions
    const agentStepActions = agentOutput.actions;
    const actionOutputs: ActionOutput[] = [];
    for (const action of agentStepActions) {
      if (action.type === "complete") {
        taskState.status = TaskStatus.COMPLETED;
        const actionDefinition = ctx.actions.find(
          (actionDefinition) => actionDefinition.type === "complete"
        );
        if (actionDefinition) {
          output =
            (await actionDefinition.completeAction?.(action.params)) ??
            "No complete action found";
        } else {
          output = "No complete action found";
        }
      }
      const actionOutput = await runAction(
        action as ActionType,
        domState,
        page,
        ctx
      );
      actionOutputs.push(actionOutput);
      // Wait for DOM to settle after action
      await waitForSettledDOM(page);
    }
    const step: AgentStep = {
      idx: currStep,
      agentOutput: agentOutput,
      actionOutputs,
    };
    taskState.steps.push(step);
    await params?.onStep?.(step);
    currStep = currStep + 1;

    if (ctx.debug) {
      fs.writeFileSync(
        `${debugStepDir}/stepOutput.json`,
        JSON.stringify(step, null, 2)
      );
    }
  }

  const taskOutput: TaskOutput = {
    status: taskState.status,
    steps: taskState.steps,
    output,
  };
  if (ctx.debug) {
    fs.writeFileSync(
      `${debugDir}/taskOutput.json`,
      JSON.stringify(taskOutput, null, 2)
    );
  }
  await params?.onComplete?.(taskOutput);
  return taskOutput;
};
