import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { examineDom } from "../examine-dom";
import { executePlaywrightMethod } from "../shared/execute-playwright-method";
import { getElementLocator } from "../shared/element-locator";
import { AGENT_ELEMENT_ACTIONS } from "../shared/action-restrictions";

const ActElementAction = z
  .object({
    instruction: z
      .string()
      .describe(
        "Describe the action in a short, specific phrase that mentions the element type.\n\n" +
          "Supported actions: click, fill, type, press, selectOptionFromDropdown, check, uncheck, hover, scrollTo, nextChunk, prevChunk\n\n" +
          "Examples:\n" +
          "- click the Login button\n" +
          "- fill 'user@example.com' into email field\n" +
          "- type 'search query' into search box\n" +
          "- press Enter\n" +
          "- select 'California' from state dropdown\n" +
          "- check the terms checkbox\n" +
          "- uncheck the newsletter checkbox\n" +
          "- hover over profile menu\n" +
          "- scroll to 50%\n" +
          "- scroll down one page\n" +
          "- scroll up one page"
      ),
  })
  .describe("Perform a single action on an element using natural language");

type ActElementActionType = z.infer<typeof ActElementAction>;

export const ActElementActionDefinition: AgentActionDefinition = {
  type: "actElement" as const,
  actionParams: ActElementAction,
  run: async function (
    ctx: ActionContext,
    action: ActElementActionType
  ): Promise<ActionOutput> {
    const { instruction } = action;

    // DOM state is provided by agent loop in ctx.domState
    // NO DOM FETCHING HERE - agent loop handles that

    // Convert elements map for examineDom
    const elementMap = new Map(
      Array.from(ctx.domState.elements).map(([k, v]) => [String(k), v])
    );

    // Call examineDom with current DOM state
    const examineResult = await examineDom(
      instruction,
      {
        tree: ctx.domState.domState,
        xpathMap: ctx.domState.xpathMap || {},
        elements: elementMap,
        url: ctx.page.url(),
      },
      ctx.llm
    );

    // Check if element was found
    if (!examineResult || examineResult.elements.length === 0) {
      return {
        success: false,
        message: `Failed to execute "${instruction}": Element not found on page`,
      };
    }

    const element = examineResult.elements[0];
    const method = element.method;
    const args = element.arguments || [];

    // Store debug info about selected element
    const debugInfo = ctx.debug
      ? {
          selectedElement: {
            elementId: element.elementId,
            confidence: element.confidence,
            description: element.description,
            method: method,
            arguments: args,
          },
          allCandidates: examineResult.elements.map((e) => ({
            elementId: e.elementId,
            confidence: e.confidence,
            description: e.description,
          })),
        }
      : undefined;

    // Validate action is allowed
    if (!AGENT_ELEMENT_ACTIONS.includes(method)) {
      return {
        success: false,
        message: `Action "${method}" not allowed. Allowed actions: ${AGENT_ELEMENT_ACTIONS.join(
          ", "
        )}`,
        debug: debugInfo,
      };
    }

    try {
      // Get Playwright locator using shared utility
      const { locator } = await getElementLocator(
        element.elementId,
        ctx.domState.xpathMap,
        ctx.page,
        ctx.domState.frameMap,
        !!ctx.debugDir
      );

      // Execute Playwright method using shared utility
      await executePlaywrightMethod(method, args, locator, {
        clickTimeout: ctx.actionConfig?.clickElement?.timeout ?? 3500,
        debug: !!ctx.debugDir,
      });

      return {
        success: true,
        message: `Successfully executed: ${instruction}`,
        debug: debugInfo,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to execute "${instruction}": ${errorMessage}`,
        debug: debugInfo,
      };
    }
  },
  pprintAction: function (params: ActElementActionType): string {
    return `Act: ${params.instruction}`;
  },
};
