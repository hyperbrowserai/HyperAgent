import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { parseMarkdown } from "@/utils/html-to-markdown";
import fs from "fs";
import { VariableFn } from "@/types/agent/types";
import { HyperVariable } from "@/types/agent/types";

export const ExtractAction = z
  .object({
    objective: z.string().describe(`
      The goal of the extraction. MUST use <<variableKey>> to reference ALL previously extracted variables.
      Examples:
      - CORRECT: "Extract the capital of <<top_country_1>>"
      - WRONG: "Extract the capital of Gabon"
      - CORRECT: "Find the price from <<departure_city>> to <<arrival_city>>"
      - WRONG: "Find the price from Paris to London"
      NEVER include actual values (country names, city names, etc.) that you see in the DOM.`),
    variableName: z.string()
      .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, "Must be a valid TypeScript identifier")
      .describe("The variable name used to identify a variable. Must be a valid TypeScript identifier and not previously used."),
  })
  .describe(
    "Extract content from the page to create reusable variables. REQUIRED when gathering any information that will be used in subsequent steps (e.g., country names, prices, dates, etc.)"
  )

export type ExtractActionType = z.infer<typeof ExtractAction>;

export const ExtractActionDefinition: AgentActionDefinition = {
  type: "extract" as const,
  actionParams: ExtractAction,

  run: async (
    ctx: ActionContext,
    action: ExtractActionType
  ): Promise<ActionOutput> => {
    try {
      const content = await ctx.page.content();
      const markdown = await parseMarkdown(content);

      const originalObjective = action.objective;
      let objective = action.objective;
      for (const variable of ctx.variables) {
        objective = objective.replace(
          new RegExp(`<<${variable.key}>>`, "g"),
          variable.value,
        );
      }

      // Take a screenshot of the page
      const cdpSession = await ctx.page.context().newCDPSession(ctx.page);
      const screenshot = await cdpSession.send("Page.captureScreenshot");
      cdpSession.detach();

      // Save screenshot to debug dir if exists
      if (ctx.debugDir) {
        fs.writeFileSync(
          `${ctx.debugDir}/extract-screenshot.png`,
          Buffer.from(screenshot.data, "base64")
        );
      }

      // Trim markdown to stay within token limit
      // TODO: this is a hack, we should use a better token counting method
      const avgTokensPerChar = 0.75; // Conservative estimate of tokens per character
      const maxChars = Math.floor(ctx.tokenLimit / avgTokensPerChar);
      const trimmedMarkdown =
        markdown.length > maxChars
          ? markdown.slice(0, maxChars) + "\n[Content truncated due to length]"
          : markdown;
      if (ctx.debugDir) {
        fs.writeFileSync(
          `${ctx.debugDir}/extract-markdown-content.md`,
          trimmedMarkdown
        );
      }

      const response = await ctx.llm.withStructuredOutput(z.object({variables: VariableFn()})).invoke([
        {
          role: "user", 
          content: [
            {
              type: "text",
              text: `
              Original objective (with variable references): "${originalObjective}"
              Resolved objective (with actual values): "${objective}"
              
              CRITICAL INSTRUCTIONS:
              1. Use the RESOLVED objective to find the information on the page
              2. Use the ORIGINAL objective to create your key and description
              
              For the key:
              - Look at the ORIGINAL objective: "${originalObjective}"
              - Take the variable references (e.g., <<top_country_1>>) and convert to snake_case
              - Add appropriate prefix (e.g., "capital_of_", "price_of_")
              
              EXAMPLES:
              Original: "Extract the capital of <<top_country_1>>"
              Resolved: "Extract the capital of Ethiopia"
              → key: "capital_of_top_country_1"
              → value: "Addis Ababa" (found using resolved objective)
              → description: "The capital of <<top_country_1>>"
              
              Original: "Extract the capital of <<top_country_2>>"
              Resolved: "Extract the capital of Italy"
              → key: "capital_of_top_country_2"
              → value: "Rome" (found using resolved objective)
              → description: "The capital of <<top_country_2>>"
              
              NEVER use actual country/city names in the key or description!
              
              Page content:\n${trimmedMarkdown}\n
              Here is as screenshot of the page:\n`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${screenshot.data}`,
              },
            },
          ],
        },
      ]);

      if (response.variables.length === 0) {
        return {
          success: false,
          message: `No variables extracted from page.`,
        };
      }

      const variableUpdates = response.variables.map(variable => ({ 
        key: variable.key, 
        value: variable.value,
        description: variable.description,
      }));

      return {
        success: true,
        message: `Extracted variables from page: 
        ${response.variables.map(variable => `${variable.key}`).join(', ')}`,
        variableUpdates: variableUpdates,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to extract variables: ${error}`,
      };
    }
  },

  generateCode: async (ctx: ActionContext, action: ExtractActionType, expectedVariables?: HyperVariable[]) => {
    // This generated code will take the expected variables and use them to extract the information from the page
    const expectedVar = expectedVariables?.map(variable => ({
      key: variable.key,
      description: variable.description
    })) || [];
    
    const variableName = action.variableName;

    return `
  try {
    const content_${variableName} = await ctx.page.content();
    const markdown_${variableName} = await parseMarkdown(content_${variableName});
    const tokenLimit_${variableName} = ${ctx.tokenLimit};

    const originalObjective_${variableName} = "${action.objective}";
    let objective_${variableName} = "${action.objective}";
    for (const variable of Object.values(ctx.variables)) {
      objective_${variableName} = objective_${variableName}.replace(
        new RegExp(\`<<\${variable.key}>>\`, "g"),
        variable.value
      );
    }

    // Take a screenshot of the page
    const cdpSession_${variableName} = await ctx.page.context().newCDPSession(ctx.page);
    const screenshot_${variableName} = await cdpSession_${variableName}.send("Page.captureScreenshot");
    cdpSession_${variableName}.detach();

    const avgTokensPerChar_${variableName} = 0.75;  // Conservative estimate of tokens per character
    const maxTokensForContent_${variableName} = Math.min(20000, tokenLimit_${variableName} * 0.3); // Use 30% of limit or 20k
    const maxChars_${variableName} = Math.floor(maxTokensForContent_${variableName} / avgTokensPerChar_${variableName});
    const trimmedMarkdown_${variableName} =
      markdown_${variableName}.length > maxChars_${variableName}
        ? markdown_${variableName}.slice(0, maxChars_${variableName}) + "\\n[Content truncated due to length]"
        : markdown_${variableName};

    const response${variableName} = await ctx.llm.withStructuredOutput(z.object({variables: VariableFn()})).invoke([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: \`
            Original objective (with variable references): "\${originalObjective_${variableName}}"
            Resolved objective (with actual values): "\${objective_${variableName}}"
            
            Extract the following information from the page according to the resolved objective.
            For each of these variables, find their values from the page content:
            ${expectedVar.map(v => `- ${v.key}: ${v.description}`).join('\\n            ')}
            
            CRITICAL RULES:
            1. Keys MUST be EXACTLY as provided above - do not change them
            2. Only the 'value' field should contain the actual data from the page
            3. Use the provided descriptions exactly as given
            4. Use the RESOLVED objective to understand what to look for on the page
            
            Page content:\\n\${trimmedMarkdown_${variableName}}\\n
            Here is as screenshot of the page:\\n,
            \`
          },
          {
            type: "image_url",
            image_url: {
              url: \`data:image/png;base64,\${screenshot_${variableName}.data}\`,
            },
          },
        ],
      },
    ]);

    if (response_${variableName}.variables.length === 0) {
      console.log(\`No variables extracted from page.\`);
    }

    const variableUpdates_${variableName} = response_${variableName}.variables.map(variable => ({ 
      key: variable.key, 
      value: variable.value,
      description: variable.description,
    }));

    console.log(\`Extracted variables from page: 
    \${response_${variableName}.variables.map(variable => \`\${variable.key}\`).join(', ')}\`);

    // Update the ctx.variables with the new values
    for (const variable of variableUpdates_${variableName}) {
      ctx.variables[variable.key] = {
        key: variable.key,
        value: variable.value,
        description: variable.description,
      };
    }
    console.log('Current variables:', JSON.stringify(ctx.variables, null, 2));
  } catch (error) {
    console.log(\`Failed to extract variables: \${error}\`);
  }
    `;
  },

  pprintAction: function(params: ExtractActionType): string {
    return `Extract content from page with objective: "${params.objective}"`;
  },
};
