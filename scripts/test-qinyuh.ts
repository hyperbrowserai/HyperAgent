import { chromium, Page } from "playwright";
import { getDom } from "../src/context-providers/dom";
import { DOMState } from "../src/context-providers/dom/types";


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
// ------------------------------------------------------------

interface ActionParams {
    [key: string]: any;
  }
interface ActionResult {
    success: boolean;
    message: string;
}

var actionParams: ActionParams;
var result: Promise<ActionResult>;

// Main execution function
(async () => {
  const page = await initPage();
  const ctx = {
    page,
    variables: [],
  };

  // action: goToUrl
  actionParams = {
    "url": "https://flights.google.com"
  }
  result = (async (ctx, action) => {
          const { url } = action;
          await ctx.page.goto(url);
          return { success: true, message: `Navigated to ${url}` };
      })(ctx, actionParams)
  console.log(result)

  // ------------------------------------------------------------
  await page.waitForLoadState('networkidle');
  var domState = await getDom(page);
  // console.log(domState?.domState);
  // ------------------------------------------------------------
  
  // action: inputText
    const locator = ctx.page.locator("xpath=html/body[@id=\"yDmH0d\"]/c-wiz[2]/div/div[2]/c-wiz/div[1]/c-wiz/div[2]/div[1]/div[1]/div[1]/div/div[2]/div[@id=\"i23\"]/div[1]/div/div/div[1]/div/div/input");
    // for (const variable of ctx.variables) {
    //     text = text.replace(`<<${variable.key}>>`, variable.value);
    // }
    if (!locator) {
        return { success: false, message: "Element not found" };
    }
    await locator.fill(text, { timeout: 5000 });

  console.log(await result)

})();


/*
1. Set up initial context:
    - var actionParams;
    - var result;
    - Context
    - Browser, Context, Page

2. Wrap all following actions is a function:
--
async function main() {
  const page = await initPage();
  ...
  ...
}
main();
--
*/
