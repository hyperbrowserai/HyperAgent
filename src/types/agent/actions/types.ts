import { Page } from "playwright-core";
import { A11yDOMState } from "../../../context-providers/a11y-dom/types";
import { HyperAgentLLM } from "@/llm/types";
import { z } from "zod";
import { MCPClient } from "../../../agent/mcp/client";
import { HyperVariable } from "../types";
import { ActionConfig } from "@/types/config";

export interface ActionContext {
  page: Page;
  domState: A11yDOMState;
  llm: HyperAgentLLM;
  tokenLimit: number;
  variables: HyperVariable[];
  debugDir?: string;
  mcpClient?: MCPClient;
  actionConfig?: ActionConfig;
  debug?: boolean;
}

export interface ActionOutput {
  success: boolean;
  message: string;
  extract?: object;
  debug?: any;
}

export type ActionSchemaType = z.ZodObject<{
  type: z.ZodLiteral<string>;
  params: z.ZodObject<any>;
}>;

export type ActionType = z.infer<ActionSchemaType>;

export interface AgentActionDefinition<
  T extends z.ZodType<any> = z.ZodType<any>,
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
