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

            Your task is to extract information from the provided page content and screenshot based on a given objective and a list of variable names.

            CRITICAL INSTRUCTIONS:
            1. You will be given an "original objective" with variable placeholders (e.g., "<<variable_name>>") and a "resolved objective" with the placeholders filled in with actual values.
            2. Use the RESOLVED objective to locate the information on the page.
            3. You will be provided with a list of variable names to extract.
            4. If you find that some critical information related to the objective is present on the page, but not in the task you are given, you should extract it and return it as a variable. But make sure it is critical to the objective or provides significant value to the objective.

            OUTPUT FORMAT:
            You must output an array of variable objects. Each object should have the following fields:
            - "key": Use the exact variable name from the provided list.
            - "value": The text content you extracted from the page. This should be a string.
            - "description": A description of the data using the ORIGINAL objective format with placeholders. For example, if the original objective was "Extract the capital of <<country_name>>", the description should be "The capital of <<country_name>>".

            CRITICAL RULES:
            - The 'key' MUST be one of the exact variable names provided in the list.
            - The 'description' MUST use the original objective's format with placeholders. NEVER include actual values (like "Paris" or "John Smith") in the description.
            - If you cannot find the information for a variable, return an object with that variable's key and a value of "Not Available".
            - You MUST return one object for each variable in the provided list.
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
              
              Variables to extract:
              ${action.variables.map((v) => `- ${v}`).join("\n              ")}

              Instructions:
              1. Use the RESOLVED objective to find the information on the page
              2. For each variable listed above, extract the corresponding value
              3. Return one object per variable with the exact key name provided

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
        // Add "Not Available" values for each variable requested
        const variableUpdates = action.variables.map((variable) => ({
          key: variable,
          value: "Not Available",
          description: action.objective,
        }));
        return {
          success: true,
          message: `No variables extracted from page.`,
          variableUpdates: variableUpdates,
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
    prefix: string,
    expectedVariables?: HyperVariable[],
  ) => {
    // This generated code will take the expected variables and use them to extract the information from the page
    const expectedVars =
      expectedVariables?.map((variable) => ({
        key: variable.key,
        description: variable.description,
      })) || action.variables.map((v) => ({ key: v, description: "" }));

    const varPrefix = `${prefix}_extract`;

    return `
  try {
    const ${varPrefix}_content = await ctx.page.content();
    const ${varPrefix}_markdown = await parseMarkdown(${varPrefix}_content);
    const ${varPrefix}_tokenLimit = ${ctx.tokenLimit};

    const ${varPrefix}_originalObjective = ${JSON.stringify(action.objective)};
    let ${varPrefix}_objective = ${JSON.stringify(action.objective)};
    for (const variable of Object.values(ctx.variables)) {
      ${varPrefix}_objective = ${varPrefix}_objective.replaceAll(
        \`<<\${variable.key}>>\`,
        variable.value as string,
      );
    }

    // Take a screenshot of the page
    const ${varPrefix}_cdpSession = await ctx.page.context().newCDPSession(ctx.page);
    const ${varPrefix}_screenshot = await ${varPrefix}_cdpSession.send("Page.captureScreenshot");
    ${varPrefix}_cdpSession.detach();

    const ${varPrefix}_avgTokensPerChar = 0.75;  // Conservative estimate of tokens per character
    const ${varPrefix}_maxTokensForContent = Math.min(20000, ${varPrefix}_tokenLimit * 0.3);
    const ${varPrefix}_maxChars = Math.floor(${varPrefix}_maxTokensForContent / ${varPrefix}_avgTokensPerChar);
    const ${varPrefix}_trimmedMarkdown =
      ${varPrefix}_markdown.length > ${varPrefix}_maxChars
        ? ${varPrefix}_markdown.slice(0, ${varPrefix}_maxChars) + "\\n[Content truncated due to length]"
        : ${varPrefix}_markdown;

    const ${varPrefix}_response = await ctx.llm.withStructuredOutput(VariableExtractionOutput).invoke([
        {
        role: "system",
        content: \`
        You are a helpful assistant that extracts information from a page.

        Your task is to extract information from the provided page content and screenshot based on a given objective and a list of variable names.

        CRITICAL INSTRUCTIONS:
        1. You will be given an "original objective" with variable placeholders (e.g., "<<variable_name>>") and a "resolved objective" with the placeholders filled in with actual values.
        2. Use the RESOLVED objective to locate the information on the page.
        3. You will be provided with a list of variable names to extract.
        4. If you find that some critical information related to the objective is present on the page, but not in the task you are given, you should extract it and return it as a variable. But make sure it is critical to the objective or provides significant value to the objective.

        OUTPUT FORMAT:
        You must output an array of variable objects. Each object should have the following fields:
        - "key": Use the exact variable name from the provided list.
        - "value": The text content you extracted from the page. This should be a string.
        - "description": A description of the data using the ORIGINAL objective format with placeholders. For example, if the original objective was "Extract the capital of <<country_name>>", the description should be "The capital of <<country_name>>".

        CRITICAL RULES:
        - The 'key' MUST be one of the exact variable names provided in the list.
        - The 'description' MUST use the original objective's format with placeholders. NEVER include actual values (like "Paris" or "John Smith") in the description.
        - If you cannot find the information for a variable, return an object with that variable's key and a value of "Not Available".
        - You MUST return one object for each variable in the provided list.
        \`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: \`
            Original objective: "\${${varPrefix}_originalObjective}"
            Resolved objective: "\${${varPrefix}_objective}"
            
            Variables to extract:
            ${expectedVars.map((v) => `- ${v.key}`).join("\\n            ")}

            Instructions:
            1. Use the RESOLVED objective to find the information on the page
            2. For each variable listed above, extract the corresponding value
            3. Return one object per variable with the exact key name provided

            Page content:
            \${${varPrefix}_trimmedMarkdown}

            Here is a screenshot of the page:
            \`
          },
          {
            type: "image_url",
            image_url: {
              url: \`data:image/png;base64,\${${varPrefix}_screenshot.data}\`,
            },
          },
        ],
      },
    ]);

    let ${varPrefix}_variableUpdates;
    if (${varPrefix}_response.variables.length === 0) {
      console.log(\`No variables extracted from page. Adding "Not Available" values\`);
      ${varPrefix}_variableUpdates = ${JSON.stringify(
        expectedVars,
      )}.map((variable: {key: string, description: string}) => ({
        key: variable.key,
        value: "Not Available",
        description: variable.description,
      }));
    } else {
      console.log(\`Extracted variables from page: \${${varPrefix}_response.variables.map((v: any) => v.key).join(', ')}\`);
      ${varPrefix}_variableUpdates = ${varPrefix}_response.variables.map((variable: any) => ({
        key: variable.key,
        value: variable.value,
        description: variable.description,
      }));
    }

    for (const variable of ${varPrefix}_variableUpdates) {
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
