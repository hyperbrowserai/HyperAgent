import { chromium, Page, Locator } from "playwright";


const MAX_STABLE_CHECKS = 2;

export async function initPage(): Promise<Page> {
    const browser = await chromium.launch({
        channel: "chrome",
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    return page;
  }

export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};


  /**
 * Waits for an element to become enabled with a timeout
 * @param locator The Playwright locator to check
 * @param timeout Maximum time to wait in milliseconds
 * @returns Promise that resolves when element is enabled or rejects on timeout
 */
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
}

/**
 * Waits for an element to become stable (not moving) with a timeout
 * @param locator The Playwright locator to check
 * @param timeout Maximum time to wait in milliseconds
 * @returns Promise that resolves when element is stable or rejects on timeout
 */
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
}
// ------------------------------------------------------------

// Main execution function
(async () => {
  const page = await initPage();
  const ctx = {
    page,
    variables: [],
  };

/*
action: goToUrl
actionParams = {
  "url": "https://flights.google.com"
}
*/
{

  await ctx.page.goto("https://flights.google.com");

}

await sleep(2000);

/*
action: inputText
actionParams = {
"index": 22,
"text": "Rio de Janeiro"
}
*/
{

    const locator = ctx.page.locator('xpath=html/body[@id="yDmH0d"]/c-wiz[2]/div/div[2]/c-wiz/div[1]/c-wiz/div[2]/div[1]/div[1]/div[1]/div/div[2]/div[@id="i23"]/div[1]/div/div/div[1]/div/div/input');
    if (!locator) {
      return { success: false, message: "Element not found" };
    }
    await locator.fill("Rio de Janeiro", { timeout: 5_000 });
  
}

await sleep(2000);

/*
action: keyPress
actionParams = {
"text": "Return"
}
*/
{
await ctx.page.keyboard.press("Enter");

}

await sleep(2000);

/*
action: inputText
actionParams = {
"index": 23,
"text": "Los Angeles"
}
*/
{

    const locator = ctx.page.locator('xpath=html/body[@id="yDmH0d"]/c-wiz[2]/div/div[2]/c-wiz/div[1]/c-wiz/div[2]/div[1]/div[1]/div[1]/div/div[2]/div[@id="i23"]/div[4]/div/div/div[1]/div/div/input');
    if (!locator) {
      return { success: false, message: "Element not found" };
    }
    await locator.fill("Los Angeles", { timeout: 5_000 });
  
}

await sleep(2000);

/*
action: keyPress
actionParams = {
"text": "Return"
}
*/
{
await ctx.page.keyboard.press("Enter");

}

await sleep(2000);

/*
action: inputText
actionParams = {
"index": 24,
"text": "07/15/2025"
}
*/
{

    const locator = ctx.page.locator('xpath=html/body[@id="yDmH0d"]/c-wiz[2]/div/div[2]/c-wiz/div[1]/c-wiz/div[2]/div[1]/div[1]/div[1]/div/div[2]/div[2]/div/div/div[1]/div/div/div[1]/div/div[1]/div/input');
    if (!locator) {
      return { success: false, message: "Element not found" };
    }
    await locator.fill("07/15/2025", { timeout: 5_000 });
  
}

await sleep(2000);

/*
action: keyPress
actionParams = {
"text": "Return"
}
*/
{
await ctx.page.keyboard.press("Enter");

}

await sleep(2000);

/*
action: inputText
actionParams = {
"index": 25,
"text": "07/22/2025"
}
*/
{

    const locator = ctx.page.locator('xpath=html/body[@id="yDmH0d"]/c-wiz[2]/div/div[2]/c-wiz/div[1]/c-wiz/div[2]/div[1]/div[1]/div[1]/div/div[2]/div[2]/div/div/div[1]/div/div/div[1]/div/div[2]/div/input');
    if (!locator) {
      return { success: false, message: "Element not found" };
    }
    await locator.fill("07/22/2025", { timeout: 5_000 });
  
}

await sleep(2000);

/*
action: keyPress
actionParams = {
"text": "Return"
}
*/
{
await ctx.page.keyboard.press("Enter");

}

await sleep(2000);

/*
action: clickElement
actionParams = {
"index": 26
}
*/
{

    const locator = ctx.page.locator('xpath=html/body[@id="yDmH0d"]/c-wiz[2]/div/div[2]/c-wiz/div[1]/c-wiz/div[2]/div[1]/div[1]/div[2]/div/button');
    if (!locator) {
      return { success: false, message: "Element not found" };
    }

    const exists = (await locator.count()) > 0;
    if (!exists) {
      return { success: false, message: "Element not found on page" };
    }

    await locator.scrollIntoViewIfNeeded({
      timeout: 2500,
    });

    await Promise.all([
      locator.waitFor({
        state: "visible",
        timeout: 2500,
      }),
      waitForElementToBeEnabled(locator, 2500),
      waitForElementToBeStable(locator, 2500),
    ]);

    await locator.click({ force: true });

}

await sleep(2000);

/*
action: clickElement
actionParams = {
"index": 58
}
*/
{

    const locator = ctx.page.locator('xpath=html/body[@id="yDmH0d"]/c-wiz[2]/div/div[2]/c-wiz/div[1]/c-wiz/div[2]/div[2]/div[2]/div/div[2]/div[1]/ul/li[3]/div/div[2]/div/div[2]/div/div[5]/div/div[2]/div[2]');
    if (!locator) {
      return { success: false, message: "Element not found" };
    }

    const exists = (await locator.count()) > 0;
    if (!exists) {
      return { success: false, message: "Element not found on page" };
    }

    await locator.scrollIntoViewIfNeeded({
      timeout: 2500,
    });

    await Promise.all([
      locator.waitFor({
        state: "visible",
        timeout: 2500,
      }),
      waitForElementToBeEnabled(locator, 2500),
      waitForElementToBeStable(locator, 2500),
    ]);

    await locator.click({ force: true });

}

await sleep(2000);

/*
action: complete
actionParams = {
"success": true,
"text": "Selected a round-trip flight from Rio de Janeiro to Los Angeles, leaving on July 15, 2025, and returning on July 22, 2025, with the least carbon dioxide emissions of 588 kg CO2."
}
*/
{

  console.log("Task complete");

}

await sleep(2000);
})();
