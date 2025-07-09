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
      const tokenLimit = ctx.tokenLimit;

      let objective = action.objective;
      for (const variable of ctx.variables) {
        objective = objective.replace(`<<${variable.key}>>`, variable.value);
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
      // Be conservative to avoid hitting API limits
      const avgTokensPerChar = 0.75;  // Conservative estimate of tokens per character
      // Use a much smaller limit to account for prompt overhead and API limits
      const maxTokensForContent = Math.min(20000, tokenLimit * 0.3); // Use 30% of limit or 20k, whichever is smaller
      const maxChars = Math.floor(maxTokensForContent / avgTokensPerChar);
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
              Extract the following information from the page according to this objective: "${objective}"
              
              CRITICAL RULES:
              1. Analyze the objective to create the correct key:
                 - Look for variable references like <<variable_name>> in the objective
                 - Create a key that matches the context and variable reference
                 - Example: "Extract capital of <<top_country_1>>" → key: "capital_of_top_country_1"
                 - Example: "Extract capital of <<top_country_2>>" → key: "capital_of_top_country_2"
                 - Example: "Extract price from <<city_1>> to <<city_2>>" → key: "price_city_1_to_city_2"
              
              2. Keys MUST be generic (no actual values):
                 - NEVER include actual country/city names you see on the page
                 - Use the variable numbers/identifiers from the objective
              
              3. Description MUST match the objective's variable reference:
                 - Use the same <<variable_reference>> from the objective
                 - Example: If objective has <<top_country_2>>, description uses <<top_country_2>>
              
              4. Only the 'value' field contains the actual extracted data
              
              Return the results in structured output format.
              
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
    const content${variableName} = await ctx.page.content();
    const markdown${variableName} = await parseMarkdown(content${variableName});
    const tokenLimit${variableName} = ${ctx.tokenLimit};

    let objective${variableName} = "${action.objective}";
    for (const variable of ctx.variables) {
      objective${variableName} = objective${variableName}.replace(\`<<\${variable.key}>>\`, variable.value);
    }

    // Take a screenshot of the page
    const cdpSession${variableName} = await ctx.page.context().newCDPSession(ctx.page);
    const screenshot${variableName} = await cdpSession${variableName}.send("Page.captureScreenshot");
    cdpSession${variableName}.detach();

    const avgTokensPerChar${variableName} = 0.75;  // Conservative estimate of tokens per character
    const maxTokensForContent${variableName} = Math.min(20000, tokenLimit${variableName} * 0.3); // Use 30% of limit or 20k
    const maxChars${variableName} = Math.floor(maxTokensForContent${variableName} / avgTokensPerChar${variableName});
    const trimmedMarkdown${variableName} =
      markdown${variableName}.length > maxChars${variableName}
        ? markdown${variableName}.slice(0, maxChars${variableName}) + "\\n[Content truncated due to length]"
        : markdown${variableName};

    const response${variableName} = await ctx.llm.withStructuredOutput(z.object({variables: VariableFn()})).invoke([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: \`
            Extract the following information from the page according to this objective: "\${objective${variableName}}"
              For each of these variables, find their values from the page content:
              ${expectedVar.map(v => `- ${v.key}: ${v.description}`).join('\n              ')}
              
              CRITICAL RULES:
              1. Keys MUST be EXACTLY as provided above - do not change them
              2. Keys should NEVER contain actual values or any other information that you can see in the DOM
              3. Descriptions MUST use variable references like <<capital_of_from_country>>
              4. Only 'value' should contain the actual data
              
              Return the results in structured output format.
              
              Page content:\\n\${trimmedMarkdown${variableName}}\\n
              Here is as screenshot of the page:\\n,
            \`
          },
          {
            type: "image_url",
            image_url: {
              url: \`data:image/png;base64,\${screenshot${variableName}.data}\`,
            },
          },
        ],
      },
    ]);

    if (response${variableName}.variables.length === 0) {
      console.log(\`No variables extracted from page.\`);
    }

    const variableUpdates${variableName} = response${variableName}.variables.map(variable => ({ 
      key: variable.key, 
      value: variable.value,
      description: variable.description,
    }));

    console.log(\`Extracted variables from page: 
    \${response${variableName}.variables.map(variable => \`\${variable.key}\`).join(', ')}\`);

    // Update the ctx.variables with the new values
    for (const variable of variableUpdates${variableName}) {
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
