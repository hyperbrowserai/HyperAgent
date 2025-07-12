import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { parseMarkdown } from "@/utils/html-to-markdown";
import fs from "fs";
import { VariableExtractionOutput } from "@/types/agent/types";
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
      NEVER include actual values (country names, city names, etc.) that you see in the DOM.
      You can specify multiple variables in the objective, but you must use <<variableKey>> to reference them.
      `),
    variables: z
      .array(
        z
          .string()
          .regex(
            /^[a-zA-Z_$][a-zA-Z0-9_$]*$/,
            "A valid TypeScript identifier that properly describes the variable.",
          )
          .describe(
            "The name used to identify a variable. It must be a valid TypeScript identifier and distinct from others used in the same task.",
          ),
      )
      .describe("The list of variables to extract from the page."),
  })
  .describe(
    "Extract content from the page to create reusable variables. REQUIRED when gathering any information that will be used in subsequent steps (e.g., country names, prices, dates, etc.)",
  );

export type ExtractActionType = z.infer<typeof ExtractAction>;

export const ExtractActionDefinition: AgentActionDefinition = {
  type: "extract" as const,
  actionParams: ExtractAction,

  run: async (
    ctx: ActionContext,
    action: ExtractActionType,
  ): Promise<ActionOutput> => {
    try {
      const content = await ctx.page.content();
      const markdown = await parseMarkdown(content);

      const originalObjective = action.objective;
      let objective = action.objective;
      for (const variable of Object.values(ctx.variables)) {
        objective = objective.replaceAll(`<<${variable.key}>>`, variable.value);
      }

      // Take a screenshot of the page
      const cdpSession = await ctx.page.context().newCDPSession(ctx.page);
      const screenshot = await cdpSession.send("Page.captureScreenshot");
      cdpSession.detach();

      // Save screenshot to debug dir if exists
      if (ctx.debugDir) {
        fs.writeFileSync(
          `${ctx.debugDir}/extract-screenshot.png`,
          Buffer.from(screenshot.data, "base64"),
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
          trimmedMarkdown,
        );
      }

      const response = await ctx.llm
        .withStructuredOutput(VariableExtractionOutput)
        .invoke([
          {
            role: "system",
            content: `
            You are a helpful assistant that extracts information from a page.

            Your task is to extract a single piece of information from the provided page content and screenshot based on a given objective.

            CRITICAL INSTRUCTIONS:
            1.  You will be given an "original objective" with variable placeholders (e.g., "<<variable_name>>") and a "resolved objective" with the placeholders filled in with actual values.
            2.  Use the RESOLVED objective to locate the information on the page.
            3.  You will also be provided with a specific "variableName" to use as the key for the extracted data.
            4.  If you find that some critical information related to the objective is present on the page, but not in the task you are given, you should extract it and return it as a variable. But make sure it is critical to the objective or provides significant value to the objective.

            OUTPUT FORMAT:
            You must output a single variable object with the following fields:
            - "key": Use the exact "variableName" provided in the prompt.
            - "value": The text content you extracted from the page. This should be a string.
            - "description": A description of the data. Use the ORIGINAL objective for this. For example, if the original objective was "Extract the capital of <<country_name>>", the description should be "The capital of <<country_name>>".

            CRITICAL RULES:
            - The 'key' MUST be the exact 'variableName' provided.
            - The 'description' MUST use the original objective's format with placeholders. NEVER include actual values (like "Paris" or "John Smith") in the description.
            - If you cannot find the information, return an empty list of variables.
            `,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `
              Original objective: "${originalObjective}"
              Resolved objective: "${objective}"
              Variables: "${action.variables.join("\n- ")}"

              Page content:
              ${trimmedMarkdown}

              Here is a screenshot of the page:
              `,
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

      const variableUpdates = response.variables.map((variable) => ({
        key: variable.key,
        value: variable.value,
        description: variable.description,
      }));

      return {
        success: true,
        message: `Extracted variables from page: 
        ${response.variables
          .map(
            (variable) =>
              `${variable.key} - ${variable.description || "No description"}`,
          )
          .join("\n- ")}`,
        variableUpdates: variableUpdates,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to extract variables: ${error}`,
      };
    }
  },

  generateCode: async (
    ctx: ActionContext,
    action: ExtractActionType,
    expectedVariables?: HyperVariable[],
  ) => {
    // This generated code will take the expected variables and use them to extract the information from the page
    const expectedVar =
      expectedVariables?.map((variable) => ({
        key: variable.key,
        description: variable.description,
      })) || action.variables.map((v) => ({ key: v, description: "" }));

    const variablesStr = action.variables.join("_");

    return `
  try {
    const content_${variablesStr} = await ctx.page.content();
    const markdown_${variablesStr} = await parseMarkdown(content_${variablesStr});
    const tokenLimit_${variablesStr} = ${ctx.tokenLimit};

    const originalObjective_${variablesStr} = "${action.objective}";
    let objective_${variablesStr} = "${action.objective}";
    for (const variable of Object.values(ctx.variables)) {
      objective_${variablesStr} = objective_${variablesStr}.replaceAll(
        \`<<\${variable.key}>>\`,
        variable.value as string,
      );
    }

    // Take a screenshot of the page
    const cdpSession_${variablesStr} = await ctx.page.context().newCDPSession(ctx.page);
    const screenshot_${variablesStr} = await cdpSession_${variablesStr}.send("Page.captureScreenshot");
    cdpSession_${variablesStr}.detach();

    const avgTokensPerChar_${variablesStr} = 0.75;  // Conservative estimate of tokens per character
    const maxTokensForContent_${variablesStr} = Math.min(20000, tokenLimit_${variablesStr} * 0.3); // Use 30% of limit or 20k
    const maxChars_${variablesStr} = Math.floor(maxTokensForContent_${variablesStr} / avgTokensPerChar_${variablesStr});
    const trimmedMarkdown_${variablesStr} =
      markdown_${variablesStr}.length > maxChars_${variablesStr}
        ? markdown_${variablesStr}.slice(0, maxChars_${variablesStr}) + "\\n[Content truncated due to length]"
        : markdown_${variablesStr};

    const response_${variablesStr} = await ctx.llm.withStructuredOutput(VariableExtractionOutput).invoke([
        {
        role: "system",
        content: \`
        You are a helpful assistant that extracts information from a page.
        Your task is to extract information from the provided page content and screenshot based on a given objective and a list of variables.
        CRITICAL INSTRUCTIONS:
        1. You will be given an "original objective" with variable placeholders (e.g., "<<variable_name>>") and a "resolved objective" with the placeholders filled in with actual values.
        2. Use the RESOLVED objective to locate the information on the page.
        3. You will be provided with a list of "variables" to extract.
        4. If you find that some critical information related to the objective is present on the page, but not in the task you are given, you should extract it and return it as a variable. But make sure it is critical to the objective or provides significant value to the objective.
        OUTPUT FORMAT:
        You must output a list of variable objects. Each object should have the following fields:
        - "key": Use the exact variable name provided in the prompt.
        - "value": The text content you extracted from the page. This should be a string.
        - "description": A description of the data. Use the ORIGINAL objective for this.
        CRITICAL RULES:
        - The 'key' MUST be one of the variable names provided.
        - The 'description' MUST use the original objective's format with placeholders. NEVER include actual values (like "Paris" or "John Smith") in the description.
        - If you cannot find the information, return an empty list of variables.
        \`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: \`
            Original objective (with variable references): "\${originalObjective_${variablesStr}}"
            Resolved objective (with actual values): "\${objective_${variablesStr}}"
            
            Extract the following information from the page according to the resolved objective.
            For each of these variables, find their values from the page content:
            ${expectedVar
              .map((v) => `- ${v.key}: ${v.description || "No description"}`)
              .join("\\n            ")}
            
            CRITICAL RULES:
            1. Keys MUST be EXACTLY as provided above - do not change them
            2. Only the 'value' field should contain the actual data from the page
            3. Use the provided descriptions exactly as given
            4. Use the RESOLVED objective to understand what to look for on the page
            
            Page content:\\n\${trimmedMarkdown_${variablesStr}}\\n
            Here is as screenshot of the page:\\n,
            \`
          },
          {
            type: "image_url",
            image_url: {
              url: \`data:image/png;base64,\${screenshot_${variablesStr}.data}\`,
            },
          },
        ],
      },
    ]);

    if (response_${variablesStr}.variables.length === 0) {
      console.log(\`No variables extracted from page.\`);
    }

    const variableUpdates_${variablesStr} = response_${variablesStr}.variables.map(variable => ({ 
      key: variable.key, 
      value: variable.value,
      description: variable.description,
    }));

    console.log(\`Extracted variables from page: 
    \${response_${variablesStr}.variables.map(variable => \`\${variable.key}\`).join(', ')}\`);

    // Update the ctx.variables with the new values
    for (const variable of variableUpdates_${variablesStr}) {
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

  pprintAction: function (params: ExtractActionType): string {
    return `Extract content from page with objective: "${params.objective}"`;
  },
};
