import fs from "fs";
import prettier from "prettier";


export function initActionScript(actionLogFile: string, task: string) {
    fs.writeFileSync(actionLogFile, `/*\n${task}\n*/\n\n`);

    // Imports from dependencies
    fs.appendFileSync(actionLogFile, `
      import { z } from "zod";
      ` + `\n\n`);

    // Import helper funmctions from Hyperagent
    if (process.env.NODE_ENV === "development") {
        fs.appendFileSync(actionLogFile, `
    import { HyperAgent } from "./src/agent";
    import { waitForElementToBeEnabled, waitForElementToBeStable } from "./src/agent/actions/click-element";
    import { sleep } from "./src/utils/sleep";
    import { parseMarkdown } from "./src/utils/html-to-markdown";
            ` + `\n\n`);
    } else {
        fs.appendFileSync(actionLogFile, `
    import { HyperAgent } from "@hyperbrowser/agent";
    import { waitForElementToBeEnabled, waitForElementToBeStable } from "@hyperbrowser/agent/actions";
    import { parseMarkdown, sleep } from "@hyperbrowser/agent/utils";
            ` + `\n\n`);
    }

    // Define helper functions
    fs.appendFileSync(actionLogFile, `
const VariableFn = () =>
  z.array(
    z.object({
      key: z.string()
      .regex(/^[a-z][a-z0-9_]*$/,
        "Key must be in snake_case format (lowercase letters, numbers, and underscores only, starting with a letter)")
      .describe("The key of the extracted variable in snake_case format (e.g., 'top_country_1', 'first_capital', 'price_usd')."),
      value: z.string().describe("The value of the extracted variable."),
      description: z.string().describe("The description of the extracted variable, including the objective that was used to extract the variable."),
    })
  ).describe("List of extracted key-value pairs from the page that you will need in your future actions.");
    ` + `\n\n`);
    
    // Add main execution function
    fs.appendFileSync(actionLogFile, `
(async () => {
  const agent = new HyperAgent({
    debug: true,
    browserProvider: "Hyperbrowser",
  });
  const page = await agent.newPage();
  if (!page) {
    throw new Error("No page found");
  }

  const ctx = {
    page: page,
        llm: agent.llm,
        variables: {} as Record<string, Record<string, unknown>>, // Record<string, HyperVariable>
      };` + `\n\n`,
    );
}

export async function wrapUpActionScript(actionLogFile: string) {
    fs.appendFileSync(actionLogFile, `})();` + `\n\n`);
    const formatted = await prettier.format(
      fs.readFileSync(actionLogFile, "utf-8"),
      {filepath: actionLogFile},
    );
    fs.writeFileSync(actionLogFile, formatted);
}
