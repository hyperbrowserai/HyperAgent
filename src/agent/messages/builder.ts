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
  variables: HyperVariable[]
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
  messages.push({
    role: "user",
    content: `=== Variables ===\n${variables.map((v) => `<<${v.key}>> - ${v.description}`).join("\n")}\n`,
  });

  // Add previous actions section if there are steps
  if (steps.length > 0) {
    messages.push({
      role: "user",
      content: "=== Previous Actions ===\n",
    });
    for (const step of steps) {
      messages.push({
        role: "ai",
        content: JSON.stringify(step.agentOutput),
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
    content: `=== Elements ===\n${domState.domState}\n`,
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
