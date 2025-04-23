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

import { AgentOutputFn, endTaskStatuses } from "@hyperbrowser/agent/types";
import {
  TaskParams,
  TaskOutput,
  TaskState,
  TaskStatus,
} from "@hyperbrowser/agent/types";

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
import { hasDOMStateChanged } from "./diff-action-state";

const compositeScreenshot = async (page: Page, overlay: string) => {
  const screenshot = await page.screenshot();
  const responseBuffer = await sharp(screenshot)
    .composite([{ input: Buffer.from(overlay, "base64") }])
    .png()
    .toBuffer();
  return responseBuffer.toString("base64");
};

const getActionSchema = (actions: Array<AgentActionDefinition>) => {
  const zodDefs = actions.map((action) =>
    z.object({
      type: z.nativeEnum([action.type] as unknown as z.EnumLike),
      params: action.actionParams,
    })
  );
  return z.union([zodDefs[0], zodDefs[1], ...zodDefs.splice(2)]);
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

const getActionDomChangeDetectionHandler = (
  actions: Array<AgentActionDefinition>,
  type: string
) => {
  const foundAction = actions.find((actions) => actions.type === type);
  if (foundAction) {
    return foundAction.hasDomChanged;
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
  const llmStructured = ctx.llm.withStructuredOutput(
    AgentOutputFn(getActionSchema(ctx.actions)),
    {
      method: getStructuredOutputMethod(ctx.llm),
    }
  );
  const baseMsgs = [{ role: "system", content: SYSTEM_PROMPT }];

  let output = "";
  const page = taskState.startingPage;
  let currStep = 0;

  while (true) {
    let previousDomState: DOMState | null = null;
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

    // Get DOM State
    let domState = await retry({ func: () => getDom(page) });
    if (!domState) {
      console.log("no dom state, waiting 1 second.");
      await sleep(1000);
      continue;
    }

    previousDomState = domState;

    const trimmedScreenshot = await compositeScreenshot(
      page,
      domState.screenshot.startsWith("data:image/png;base64,")
        ? domState.screenshot.slice("data:image/png;base64,".length)
        : domState.screenshot
    );

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
      trimmedScreenshot as string
    );

    // Store Agent Step Messages for Debugging
    if (ctx.debug) {
      fs.writeFileSync(
        `${debugStepDir}/msgs.json`,
        JSON.stringify(msgs, null, 2)
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
    for (let idx = 0; idx < agentStepActions.length; idx++) {
      const action = agentStepActions[idx];
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
        actionOutputs.push({ success: true, message: output });
        // Assuming 'complete' action output doesn't need to be stored like regular actions
        break; // Complete action ends the step processing
      } else {
        const domChangeHandler = getActionDomChangeDetectionHandler(
          ctx.actions,
          action.type
        );

        if (
          domChangeHandler &&
          hasDOMStateChanged(
            previousDomState,
            domState, // Current DOM state fetched at the start of the step
            action,
            domChangeHandler
          )
        ) {
          // DOM state changed unexpectedly before this action could run.
          // Mark this action and subsequent actions in this step as failed.
          const failureMessage = `Action ${action.type} failed: DOM changed before execution`;
          console.warn(failureMessage); // Log the issue
          actionOutputs.push({ success: false, message: failureMessage });

          // Mark all remaining actions in this step as failed too
          for (let j = idx + 1; j < agentStepActions.length; j++) {
            const subsequentAction = agentStepActions[j];
            const subsequentFailureMessage = `Action ${subsequentAction.type} skipped: DOM changed before preceding action ${action.type}`;
            actionOutputs.push({
              success: false,
              message: subsequentFailureMessage,
            });
          }
          break; // Exit the action loop for this step
        }

        // If DOM didn't change unexpectedly, run the action
        const actionOutput = await runAction(
          action as ActionType,
          domState,
          page,
          ctx
        );
        actionOutputs.push(actionOutput);
        if (!actionOutput.success) {
          console.warn(`Action ${action.type} failed: ${actionOutput.message}`);
          // Optional: Decide if a single action failure should stop the rest of the step
          // break;
        }
        await sleep(2000); // TODO: look at this - smarter page loading
      }
      previousDomState = domState;
      const currentDomState = await retry({ func: () => getDom(page) });
      if (currentDomState) {
        domState = currentDomState;
      }
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
