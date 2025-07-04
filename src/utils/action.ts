import fs from "fs";
import prettier from "prettier";


export function initActionScript(actionLogFile: string, task: string) {
    fs.writeFileSync(actionLogFile, `/*\n${task}\n*/\n\n`);

    // Import helper funmctions from Hyperagent
    if (process.env.NODE_ENV === "development") {
        fs.appendFileSync(actionLogFile, `
    import { HyperAgent, HyperPage } from "./src/agent";
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

    // Add main execution function
    fs.appendFileSync(actionLogFile, `
    (async () => {
      const agent = new HyperAgent({
        debug: true,
        browserProvider: "Hyperbrowser",
      });
      const page = await agent.newPage();

      const ctx = {
        page: HyperPage,
        variables: [],
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
