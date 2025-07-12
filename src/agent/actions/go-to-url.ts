import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

export const GoToUrlAction = z
  .object({
    url: z.string().describe(
      `The URL you want to navigate to. This can be a static value or the name of a variable given in the format <<variableKey>>. 
        If you're using a variable, make sure it comes from the list of variables provided to you.`,
    ),
  })
  .describe("Navigate to a specific URL in the browser");

export type GoToUrlActionType = z.infer<typeof GoToUrlAction>;

export const GoToURLActionDefinition: AgentActionDefinition = {
  type: "goToUrl" as const,
  actionParams: GoToUrlAction,

  run: async (ctx: ActionContext, action: GoToUrlActionType) => {
    let { url } = action;
    for (const variable of Object.values(ctx.variables)) {
      url = url.replaceAll(`<<${variable.key}>>`, variable.value as string);
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = `https://${url}`;
    }
    await ctx.page.goto(url);
    return { success: true, message: `Navigated to ${url}` };
  },

  generateCode: async (
    ctx: ActionContext,
    action: GoToUrlActionType,
    prefix: string,
  ) => {
    const varPrefix = `${prefix}_goToUrl`;
    return `
      let ${varPrefix}_url = "${action.url}";
      for (const variable of Object.values(ctx.variables)) {
        ${varPrefix}_url = ${varPrefix}_url.replaceAll(
          \`<<\${variable.key}>>\`,
          variable.value as string,
        );
      }
      await ctx.page.goto(${varPrefix}_url);
      console.log(\`Navigated to \${${varPrefix}_url}\`);
    `;
  },

  pprintAction: function (params: GoToUrlActionType): string {
    return `Navigate to URL: ${params.url}`;
  },
};
