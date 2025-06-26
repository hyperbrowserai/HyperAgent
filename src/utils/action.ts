import fs from "fs";
import prettier from "prettier";


export function initActionScript(actionLogFile: string) {
    if (process.env.NODE_ENV === "development") {
        console.log("Hey there, this is a development environment.");
    }

    // Add imports
    fs.writeFileSync(actionLogFile, `
    import { chromium, Page } from "playwright";

    import { sleep } from "@/utils/sleep";
    import { waitForElementToBeEnabled, waitForElementToBeStable } from "@/agent/actions/click-element";
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
}
