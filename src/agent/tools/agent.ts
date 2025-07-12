import { AgentStep } from "@/types/agent/types";
import fs from "fs";
import path from "path";

import {
  ActionContext,
  ActionOutput,
  ActionType,
  AgentActionDefinition,
} from "@/types";
import { getDom } from "@/context-providers/dom";
import { initActionScript, wrapUpActionScript } from "@/utils/action";
import { retry } from "@/utils/retry";
import { sleep } from "@/utils/sleep";

import {
  AgentOutputFn,
  endTaskStatuses,
  TaskParams,
  TaskOutput,
  TaskState,
  TaskStatus,
} from "@/types";

import { HyperagentError } from "../error";
import { buildAgentStepMessages } from "../messages/builder";
import { getStructuredOutputMethod } from "../llms/structured-output";
import { SYSTEM_PROMPT } from "../messages/system-prompt";
import { z } from "zod";
import { DOMState } from "@/context-providers/dom/types";
import { Page } from "playwright";
import { ActionNotFoundError } from "../actions";
import { AgentCtx } from "./types";
import sharp from "sharp";

export const compositeScreenshot = async (page: Page, overlay: string) => {
  const screenshot = await page.screenshot();
  const responseBuffer = await sharp(screenshot)
    .composite([{ input: Buffer.from(overlay, "base64") }])
    .png()
    .toBuffer();
  return responseBuffer.toString("base64");
};

export const getActionSchema = (actions: Array<AgentActionDefinition>) => {
  const zodDefs = actions.map((action) =>
    z.object({
      type: z.nativeEnum([action.type] as unknown as z.EnumLike),
      params: action.actionParams,
      actionDescription: z
        .string()
        .describe(
          "Describe why you are performing this action and what you aim to perform with this action.",
        ),
    }),
  );
  return z.union([zodDefs[0], zodDefs[1], ...zodDefs.splice(2)]);
};

const getActionHandler = (
  actions: Array<AgentActionDefinition>,
  type: string,
) => {
  const foundAction = actions.find((actions) => actions.type === type);
  if (foundAction) {
    return foundAction.run;
  } else {
    throw new ActionNotFoundError(type);
  }
};

const getActionCodeGenerator = (
  actions: Array<AgentActionDefinition>,
  type: string,
) => {
  const foundAction = actions.find((action) => action.type === type);
  if (foundAction) {
    return (
      foundAction.generateCode ||
      (async () =>
        `// Skipped. Action ${type} invoked, but skipped code logging.`)
    );
  } else {
    throw new ActionNotFoundError(type);
  }
};

const runAction = async <T extends "Local" | "Hyperbrowser">(
  action: ActionType,
  domState: DOMState,
  page: Page,
  ctx: AgentCtx<T>,
  step: number,
  substep: number,
): Promise<ActionOutput> => {
  const actionCtx: ActionContext = {
    domState,
    page,
    tokenLimit: ctx.tokenLimit,
    llm: ctx.llm,
    debugDir: ctx.debugDir,
    mcpClient: ctx.mcpClient || undefined,
    variables: ctx.variables,
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
    const actionOutput = await actionHandler(actionCtx, action.params);

    // Check if the action output contains variable updates
    if (
      actionOutput.variableUpdates &&
      actionOutput.variableUpdates.length > 0
    ) {
      // Update ctx.variables with the new values
      for (const update of actionOutput.variableUpdates) {
        ctx.variables[update.key] = {
          key: update.key,
          value: update.value,
          description:
            update.description || ctx.variables[update.key]?.description || "",
        };
      }
    }

    if (ctx.generateScript) {
      await updateActionScript(
        action,
        ctx,
        actionCtx,
        actionOutput,
        step,
        substep,
      );
    }
    return actionOutput;
  } catch (error) {
    return {
      success: false,
      message: `Action ${action.type} failed: ${error}`,
    };
  }
};

const updateActionScript = async (
  action: ActionType,
  ctx: AgentCtx<"Local" | "Hyperbrowser">,
  actionCtx: ActionContext,
  actionOutput: ActionOutput,
  step: number,
  substep: number,
) => {
  if (actionOutput.success && ctx.scriptFile) {
    const scriptFile = ctx.scriptFile;

    const actionParamsStr = JSON.stringify(action.params, null, 2);
    const generateCodeFn = getActionCodeGenerator(ctx.actions, action.type);

    const code = await generateCodeFn(
      actionCtx,
      action.params,
      `step_${step}_${substep}_`,
      actionOutput.variableUpdates,
    );

    fs.appendFileSync(
      scriptFile,
      `
      /*
      action: ${action.type}
      actionParams = ${actionParamsStr}
      */

      ${code}
      await sleep(4000);
      `,
    );
  }
};

export const runAgentTask = async (
  ctx: AgentCtx<"Local" | "Hyperbrowser">,
  taskState: TaskState,
  params?: TaskParams,
): Promise<TaskOutput> => {
  if (!taskState) {
    throw new HyperagentError(`Task not found`);
  }
  const taskId = taskState.id;

  if (ctx.scriptFile) {
    const scriptDir = path.dirname(ctx.scriptFile);
    fs.mkdirSync(scriptDir, { recursive: true });
    initActionScript(ctx.scriptFile, taskState.task, ctx.agentConfig);
  }

  if (ctx.debug && ctx.debugDir) {
    console.log(`Debugging task ${taskId} in ${ctx.debugDir}`);
    fs.mkdirSync(ctx.debugDir, { recursive: true });
  }

  if (!ctx.llm) {
    throw new HyperagentError("LLM not initialized");
  }
  const llmStructured = ctx.llm.withStructuredOutput(
    AgentOutputFn(getActionSchema(ctx.actions)),
    { method: getStructuredOutputMethod(ctx.llm) },
  );
  const baseMsgs = [{ role: "system", content: SYSTEM_PROMPT }];

  taskState.status = TaskStatus.RUNNING as TaskStatus;
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

    const debugStepDir = `${ctx.debugDir}/step-${currStep}`;
    if (ctx.debug) {
      fs.mkdirSync(debugStepDir, { recursive: true });
    }

    // Get DOM State
    const domState = await retry({ func: () => getDom(page) });
    if (!domState) {
      console.log("no dom state, waiting 1 second.");
      await sleep(1000);
      continue;
    }

    const trimmedScreenshot = await compositeScreenshot(
      page,
      domState.screenshot.startsWith("data:image/png;base64,")
        ? domState.screenshot.slice("data:image/png;base64,".length)
        : domState.screenshot,
    );

    // Store Dom State for Debugging
    if (ctx.debug) {
      fs.writeFileSync(`${debugStepDir}/elems.txt`, domState.domState);
      if (trimmedScreenshot) {
        fs.writeFileSync(
          `${debugStepDir}/screenshot.png`,
          Buffer.from(trimmedScreenshot, "base64"),
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
      trimmedScreenshot as string,
      Object.values(ctx.variables),
    );

    // Store Agent Step Messages for Debugging
    if (ctx.debug) {
      fs.writeFileSync(
        `${debugStepDir}/msgs.json`,
        JSON.stringify(msgs, null, 2),
      );
    }

    // Invoke LLM
    const agentOutput = await retry({
      func: () => llmStructured.invoke(msgs),
    });

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
    let substep = 0;
    for (const action of agentStepActions) {
      if (action.type === "complete") {
        taskState.status = TaskStatus.COMPLETED;
        const actionDefinition = ctx.actions.find(
          (actionDefinition) => actionDefinition.type === "complete",
        );
        if (actionDefinition) {
          output =
            (await actionDefinition.completeAction?.(
              action.params,
              ctx.variables,
            )) ?? "No complete action found";
        } else {
          output = "No complete action found";
        }
      }
      const actionOutput = await runAction(
        action as ActionType,
        domState,
        page,
        ctx,
        currStep,
        substep,
      );
      actionOutputs.push(actionOutput);
      substep = substep + 1;
      await sleep(2000); // TODO: look at this - smarter page loading
    }
    const step: AgentStep = {
      idx: currStep,
      agentOutput: agentOutput,
      actionOutputs,
    };
    taskState.steps.push(step);
    await params?.onStep?.(step);
    currStep = currStep + 1;

    if (ctx.debug && ctx.debugDir) {
      fs.writeFileSync(
        `${ctx.debugDir}/stepOutput.json`,
        JSON.stringify(step, null, 2),
      );
    }
  }

  const taskOutput: TaskOutput = {
    status: taskState.status,
    steps: taskState.steps,
    output,
  };

  if (ctx.debug && ctx.debugDir) {
    fs.writeFileSync(
      `${ctx.debugDir}/taskOutput.json`,
      JSON.stringify(taskOutput, null, 2),
    );
  }
  // Finish script.ts & format it
  if (ctx.scriptFile) {
    wrapUpActionScript(ctx.scriptFile);
  }
  await params?.onComplete?.(taskOutput);

  return taskOutput;
};
