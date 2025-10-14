import { Page } from "patchright";
import { DOMState } from "../../../context-providers/dom/types";
import { HyperAgentLLM } from "@/llm/types";
import { z } from "zod";
import { MCPClient } from "../../../agent/mcp/client";
import { HyperVariable } from "../types";

export interface ActionContext {
  page: Page;
  domState: DOMState;
  llm: HyperAgentLLM;
  tokenLimit: number;
  variables: HyperVariable[];
  debugDir?: string;
  mcpClient?: MCPClient;
}

export interface ActionOutput {
  success: boolean;
  message: string;
  extract?: object;
}

export type ActionSchemaType = z.ZodObject<
  {
    type: z.ZodLiteral<string>;

    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    params: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
  },
  "strip",
  z.ZodTypeAny,
  {
    params: object;
    type: string;
  },
  {
    params: object;
    type: string;
  }
>;

export type ActionType = z.infer<ActionSchemaType>;

export interface AgentActionDefinition<
  T extends z.AnyZodObject = z.AnyZodObject,
> {
  readonly type: string;
  actionParams: T;

  run(ctx: ActionContext, params: z.infer<T>): Promise<ActionOutput>;
  /**
   * completeAction is only called if the name of this action is "complete". It is meant to format text into a proper format for output.
   * @param params
   */
  completeAction?(params: z.infer<T>): Promise<string>;
  pprintAction?(params: z.infer<T>): string;
}
