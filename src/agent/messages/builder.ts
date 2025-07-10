import { AgentStep } from "@/types";
import { BaseMessageLike } from "@langchain/core/messages";
import { Page } from "playwright";
import { getScrollInfo } from "./utils";
import { retry } from "@/utils/retry";
import { DOMState } from "@/context-providers/dom/types";
import { HyperVariable } from "@/types/agent/types";

export const buildAgentStepMessages = async (
  baseMessages: BaseMessageLike[],
  steps: AgentStep[],
  task: string,
  page: Page,
  domState: DOMState,
  screenshot: string,
  variables: HyperVariable[],
): Promise<BaseMessageLike[]> => {
  const messages = [...baseMessages];

  // Add the final goal section
  messages.push({
    role: "user",
    content: `=== Final Goal ===\n${task}\n`,
  });

  // Add current URL section
  messages.push({
    role: "user",
    content: `=== Current URL ===\n${page.url()}\n`,
  });

  // Add variables section
  if (variables.length > 0) {
    messages.push({
      role: "user",
      content: `=== Variables ===
      ${variables.map((v) => `<<${v.key}>> = (${v.description || "extracted value"})`).join("\n")}
      REMINDER: Use <<variableKey>> in action parameters instead of the actual value.`,
    });
  } else {
    messages.push({
      role: "user",
      content: `=== Variables ===\nNo variables extracted yet.\n`,
    });
  }

  // Add previous actions section if there are steps
  if (steps.length > 0) {
    messages.push({
      role: "user",
      content: "=== Previous Actions ===\n",
    });
    for (const step of steps) {
      const actionOutputs = JSON.stringify({
        actionOutputs: step.actionOutputs.map((output) => ({
          success: output.success,
          message: output.message,
          extract: output.extract,
          // Intentionally not including variableUpdates here to avoid leaking information of values
        })),
        thoughts: step.agentOutput.thoughts,
        memory: step.agentOutput.memory,
        nextGoal: step.agentOutput.nextGoal,
        actions: step.agentOutput.actions,
        // Intentionally not including variableUpdates here to avoid leaking information of values
      });
      messages.push({
        role: "ai",
        content: JSON.stringify(actionOutputs),
      });
      for (const actionOutput of step.actionOutputs) {
        messages.push({
          role: "user",
          content: actionOutput.extract
            ? `${actionOutput.message} :\n ${JSON.stringify(actionOutput.extract)}`
            : actionOutput.message,
        });
      }
    }
  }

  // Add elements section with DOM tree
  messages.push({
    role: "user",
    content: `=== Elements (FOR REFERENCE ONLY - NEVER USE ACTUAL VALUES IN YOUR RESPONSE) ===
${domState.domState}
CRITICAL: Any values you see here (country names, city names, etc.) must ONLY be referenced through variables.
If you see "United Kingdom" here and you've extracted it as <<top_country_1>>, you MUST use <<top_country_1>> everywhere.`,
  });

  // Add page screenshot section
  const scrollInfo = await retry({ func: () => getScrollInfo(page) });
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "=== Page Screenshot ===\n",
      },
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${screenshot}`,
        },
      },
      {
        type: "text",
        text: `=== Page State ===\nPixels above: ${scrollInfo[0]}\nPixels below: ${scrollInfo[1]}\n`,
      },
    ],
  });

  return messages;
};
