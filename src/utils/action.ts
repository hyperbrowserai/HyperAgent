import fs from "fs";
import prettier from "prettier";

export function initActionScript(actionLogFile: string, task: string) {
  fs.writeFileSync(actionLogFile, `/*\n${task}\n*/\n\n`);

  // Import helper funmctions from Hyperagent
  if (process.env.NODE_ENV === "development") {
    fs.appendFileSync(
      actionLogFile,
      `
    import { HyperAgent } from "./src/agent";
    import { waitForElementToBeEnabled, waitForElementToBeStable } from "./src/agent/actions/click-element";
    import { sleep } from "./src/utils/sleep";
    import { parseMarkdown } from "./src/utils/html-to-markdown";
    import { VariableExtractionOutput } from "./src/types/agent/types";
            ` + `\n\n`,
    );
  } else {
    fs.appendFileSync(
      actionLogFile,
      `
    import { HyperAgent } from "@hyperbrowser/agent";
    import { waitForElementToBeEnabled, waitForElementToBeStable } from "@hyperbrowser/agent/actions";
    import { parseMarkdown, sleep } from "@hyperbrowser/agent/utils";
    import { VariableExtractionOutput } from "@hyperbrowser/agent/types";
            ` + `\n\n`,
    );
  }

  // Add main execution function
  fs.appendFileSync(
    actionLogFile,
    `
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
    { filepath: actionLogFile },
  );
  fs.writeFileSync(actionLogFile, formatted);
}
