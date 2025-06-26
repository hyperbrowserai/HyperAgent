import fs from "fs";


export function initActionScript(actionLogFile: string) {
    // Add imports and constants
    fs.writeFileSync(actionLogFile, `
    import { chromium, Page, Locator } from "playwright";


    const MAX_STABLE_CHECKS = 2;` + `\n\n`
    );
    
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
    
    // Add other exported helper functions from other files
    fs.appendFileSync(actionLogFile, `
    export const sleep = (ms: number): Promise<void> => {
        return new Promise((resolve) => setTimeout(resolve, ms));
    };` + `\n\n`);
    fs.appendFileSync(actionLogFile, `
    async function waitForElementToBeEnabled(
    locator: Locator,
    timeout: number = 5000
    ): Promise<void> {
    return Promise.race([
        (async () => {
        while (true) {
            if (await locator.isEnabled()) {
            return;
            }
            await sleep(100);
        }
        })(),
        new Promise<never>((_, reject) => {
        setTimeout(
            () => reject(new Error("Timeout waiting for element to be enabled")),
            timeout
        );
        }),
    ]);
    }` + `\n\n`);
    fs.appendFileSync(actionLogFile, `
    async function waitForElementToBeStable(
    locator: Locator,
    timeout: number = 5000
    ): Promise<void> {
    return Promise.race([
        (async () => {
        let previousRect: {
            x: number;
            y: number;
            width: number;
            height: number;
        } | null = null;
        let stableCount = 0;

        while (true) {
            const currentRect = await locator.boundingBox();
            if (!currentRect) {
            await sleep(100);
            continue;
            }

            if (
            previousRect &&
            previousRect.x === currentRect.x &&
            previousRect.y === currentRect.y &&
            currentRect.width === (previousRect.width ?? 0) &&
            currentRect.height === (previousRect.height ?? 0)
            ) {
            stableCount++;
            if (stableCount >= MAX_STABLE_CHECKS) {
                // Element stable for {{ MAX_STABLE_CHECKS }} consecutive checks
                return;
            }
            } else {
            stableCount = 0;
            }

            previousRect = currentRect;
            await sleep(100);
        }
        })(),
        new Promise<never>((_, reject) => {
        setTimeout(
            () => reject(new Error("Timeout waiting for element to be stable")),
            timeout
        );
        }),
    ]);
    }` + `\n\n`);

    // Add main execution function
    fs.appendFileSync(actionLogFile, `
        (async () => {
            const page = await initPage();
            const ctx = {
                page,
                variables: [],
            };` + `\n\n`
        );
}