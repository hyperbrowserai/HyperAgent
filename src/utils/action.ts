import fs from "fs";
import prettier from "prettier";
import { resolve } from "path";


export function initActionScript(actionLogFile: string, task: string) {
    fs.writeFileSync(actionLogFile, `/*\n${task}\n*/\n\n`);
    fs.appendFileSync(actionLogFile, `import { chromium, Page } from "playwright";\n\n`);

    // Import helper funmctions from Hyperagent
    if (process.env.NODE_ENV === "development") {
        fs.appendFileSync(actionLogFile, `
            import { waitForElementToBeEnabled, waitForElementToBeStable } from "./src/agent/actions/click-element";
            ` + `\n\n`);
    } else {
        fs.appendFileSync(actionLogFile, `
            import { waitForElementToBeEnabled, waitForElementToBeStable } from "@hyperbrowser/agent/actions";
            ` + `\n\n`);
    }
    
    // Add simple helper functions
    fs.appendFileSync(actionLogFile, `
        const sleep = (ms: number): Promise<void> => {
        return new Promise((resolve) => setTimeout(resolve, ms));
        }
        ` + `\n\n`);
    
    // Add initPage function
    fs.appendFileSync(actionLogFile, `
        export async function initPage(): Promise<Page> {
            const browser = await chromium.launch({
                channel: "chrome",
                headless: false,
                args: ["--disable-blink-features=AutomationControlled"],
            });
            const context = await browser.newContext();
            const page = await context.newPage();
            return page;
        }` + `\n\n`
    )

    // Add main execution function
    fs.appendFileSync(actionLogFile, `
    (async () => {
        const page = await initPage();
        const ctx = {
            page,
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

    // Keep a copy of the action script in the scripts folder
    fs.copyFileSync(actionLogFile, resolve(__dirname, "../../test-action.ts"));
}
