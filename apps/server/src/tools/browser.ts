import type { EmberTool, ToolResult } from "./types.js";

// ─── Lazy Playwright session ───────────────────────────────────────────────────

type PlaywrightModule = typeof import("playwright");
type Browser = import("playwright").Browser;
type Page = import("playwright").Page;

let _pw: PlaywrightModule | null = null;

interface BrowserSession {
  browser: Browser | null;
  page: Page | null;
}

const SESSIONS = new Map<string, BrowserSession>();

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  if (_pw) return _pw;
  try {
    _pw = await import("playwright");
    return _pw;
  } catch {
    return null;
  }
}

function getSessionKey(input: Record<string, unknown>): string {
  const value = typeof input.__sessionKey === "string" ? input.__sessionKey.trim() : "";
  return value || "default";
}

function getSession(sessionKey: string): BrowserSession {
  let session = SESSIONS.get(sessionKey) ?? null;
  if (!session) {
    session = { browser: null, page: null };
    SESSIONS.set(sessionKey, session);
  }

  return session;
}

async function getPage(sessionKey: string): Promise<Page> {
  const pw = await loadPlaywright();
  if (!pw) {
    throw new Error(
      "Playwright is not installed. " +
        "Run: pnpm add playwright --filter @ember/server && npx playwright install chromium",
    );
  }

  const session = getSession(sessionKey);

  if (!session.browser || !session.browser.isConnected()) {
    session.browser = await pw.chromium.launch({ headless: false });
  }

  if (!session.page || session.page.isClosed()) {
    session.page = await session.browser.newPage();
    await session.page.setViewportSize({ width: 1280, height: 800 });
  }

  return session.page;
}

// ─── Execute ──────────────────────────────────────────────────────────────────

async function execute(input: Record<string, unknown>): Promise<ToolResult> {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  if (!action) {
    return "Error: action is required. Valid actions: navigate, screenshot, click, fill, type, press, scroll, get_text, get_links, evaluate, wait_for, go_back, go_forward, get_url, select, new_tab, close_tab";
  }

  console.log(`[tool:browser] action="${action}"`);
  const sessionKey = getSessionKey(input);

  let page: Page;
  try {
    page = await getPage(sessionKey);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    switch (action) {
      // ── Navigation ──────────────────────────────────────────────────────────

      case "navigate": {
        const url = typeof input.url === "string" ? input.url.trim() : "";
        if (!url) return "Error: url is required for navigate.";
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const title = await page.title();
        return `Navigated to: ${page.url()}\nTitle: ${title}`;
      }

      case "go_back": {
        await page.goBack({ timeout: 10_000 });
        return `Went back.\nCurrent URL: ${page.url()}\nTitle: ${await page.title()}`;
      }

      case "go_forward": {
        await page.goForward({ timeout: 10_000 });
        return `Went forward.\nCurrent URL: ${page.url()}\nTitle: ${await page.title()}`;
      }

      case "get_url": {
        return `URL: ${page.url()}\nTitle: ${await page.title()}`;
      }

      // ── Tabs ────────────────────────────────────────────────────────────────

      case "new_tab": {
        const session = getSession(sessionKey);
        if (!session.browser) return "Error: no browser session open.";
        session.page = await session.browser.newPage();
        await session.page.setViewportSize({ width: 1280, height: 800 });
        const targetUrl = typeof input.url === "string" ? input.url.trim() : "";
        if (targetUrl) {
          await session.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }
        return `New tab opened. URL: ${session.page.url()}`;
      }

      case "close_tab": {
        const session = getSession(sessionKey);
        await page.close();
        session.page = null;
        return "Tab closed.";
      }

      // ── Visual ──────────────────────────────────────────────────────────────

      case "screenshot": {
        const [buf, title, bodyText] = await Promise.all([
          page.screenshot({ type: "png", fullPage: false }),
          page.title(),
          page.evaluate(() => (document.body as HTMLElement).innerText) as Promise<string>,
        ]);
        const base64 = buf.toString("base64");
        const textPreview = bodyText.length > 4_000
          ? bodyText.slice(0, 4_000) + "\n[… use get_text to read more]"
          : bodyText;
        const textSummary =
          `Screenshot taken.\nURL: ${page.url()}\nTitle: ${title}\n\nPage text:\n${textPreview}`;
        return {
          text: textSummary,
          imageBase64: base64,
          imageMimeType: "image/png",
        };
      }

      // ── Interaction ─────────────────────────────────────────────────────────

      case "click": {
        const selector = typeof input.selector === "string" ? input.selector.trim() : "";
        const text = typeof input.text === "string" ? input.text.trim() : "";

        if (text) {
          await page.getByText(text, { exact: false }).first().click({ timeout: 10_000 });
          return `Clicked element with text: "${text}"`;
        }
        if (!selector) return "Error: selector or text is required for click.";
        await page.click(selector, { timeout: 10_000 });
        return `Clicked: ${selector}`;
      }

      case "fill": {
        const selector = typeof input.selector === "string" ? input.selector.trim() : "";
        const value = typeof input.value === "string" ? input.value : "";
        if (!selector) return "Error: selector is required for fill.";
        await page.fill(selector, value, { timeout: 10_000 });
        return `Filled "${selector}" with value.`;
      }

      case "type": {
        const text = typeof input.text === "string" ? input.text : "";
        await page.keyboard.type(text, { delay: 20 });
        return `Typed ${text.length} characters.`;
      }

      case "press": {
        const key = typeof input.key === "string" ? input.key.trim() : "";
        if (!key) return "Error: key is required for press (e.g. Enter, Tab, Escape, ArrowDown).";
        await page.keyboard.press(key);
        return `Pressed: ${key}`;
      }

      case "select": {
        const selector = typeof input.selector === "string" ? input.selector.trim() : "";
        const value = typeof input.value === "string" ? input.value.trim() : "";
        if (!selector) return "Error: selector is required for select.";
        await page.selectOption(selector, value, { timeout: 10_000 });
        return `Selected "${value}" in ${selector}`;
      }

      case "scroll": {
        const direction = typeof input.direction === "string" ? input.direction : "down";
        const amount = typeof input.amount === "number" ? input.amount : 600;
        await page.evaluate(
          ({ dir, amt }: { dir: string; amt: number }) => {
            window.scrollBy(0, dir === "up" ? -amt : amt);
          },
          { dir: direction, amt: amount },
        );
        return `Scrolled ${direction} ${amount}px.`;
      }

      case "hover": {
        const selector = typeof input.selector === "string" ? input.selector.trim() : "";
        if (!selector) return "Error: selector is required for hover.";
        await page.hover(selector, { timeout: 10_000 });
        return `Hovered over: ${selector}`;
      }

      // ── Reading ─────────────────────────────────────────────────────────────

      case "get_text": {
        const selector = typeof input.selector === "string" ? input.selector.trim() : "";
        if (selector) {
          const text = await page.textContent(selector, { timeout: 5_000 });
          return text?.trim() ?? "(no text content found for selector)";
        }
        // Return full page inner text (good for reading articles, documents)
        const body = (await page.evaluate(() => document.body.innerText)) as string;
        const limit = 30_000;
        return body.length > limit
          ? body.slice(0, limit) + "\n\n[… truncated at 30,000 chars]"
          : body;
      }

      case "get_links": {
        const links = (await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]"))
            .map((a) => ({
              text: (a as HTMLAnchorElement).innerText.replace(/\s+/g, " ").trim(),
              href: (a as HTMLAnchorElement).href,
            }))
            .filter((l) => l.text && l.href && !l.href.startsWith("javascript:"))
            .slice(0, 60),
        )) as Array<{ text: string; href: string }>;

        if (!links.length) return "(no links found on this page)";
        return links.map((l) => `${l.text}\n  ${l.href}`).join("\n\n");
      }

      case "evaluate": {
        const script = typeof input.script === "string" ? input.script.trim() : "";
        if (!script) return "Error: script is required for evaluate.";
        const result = await page.evaluate(script);
        if (result === undefined || result === null) return "(script returned no value)";
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      }

      case "wait_for": {
        const selector = typeof input.selector === "string" ? input.selector.trim() : "";
        const timeout = typeof input.timeout === "number" ? Math.min(input.timeout, 30_000) : 10_000;
        if (!selector) return "Error: selector is required for wait_for.";
        await page.waitForSelector(selector, { timeout });
        return `Element "${selector}" is now visible.`;
      }

      default:
        return (
          `Error: unknown action "${action}".\n` +
          `Valid actions: navigate, screenshot, click, fill, type, press, scroll, hover, ` +
          `get_text, get_links, evaluate, wait_for, go_back, go_forward, get_url, select, ` +
          `new_tab, close_tab`
        );
    }
  } catch (err) {
    return `Error during browser action "${action}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const browserTool: EmberTool = {
  definition: {
    name: "browser",
    description:
      "Control a real Chromium browser to navigate pages, fill forms, click elements, " +
      "and take screenshots. Screenshots are returned as images so vision-capable models " +
      "can see the current page state. Use navigate + screenshot to start, then interact " +
      "with the page using click, fill, type, press, scroll, etc. The browser session " +
      "persists across tool calls within a conversation.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "The browser action to perform. One of: " +
            "navigate (go to URL), " +
            "screenshot (capture current page as image), " +
            "click (click element by selector or visible text), " +
            "fill (fill input/textarea by CSS selector), " +
            "type (type text via keyboard into focused element), " +
            "press (press a keyboard key: Enter, Tab, Escape, ArrowDown, etc.), " +
            "select (choose a <select> option by value), " +
            "scroll (scroll the page up or down), " +
            "hover (move mouse over element), " +
            "get_text (extract text from page or element), " +
            "get_links (list all links on page), " +
            "evaluate (run JavaScript in the page context), " +
            "wait_for (wait until a selector appears), " +
            "go_back, go_forward, get_url, new_tab, close_tab",
        },
        url: {
          type: "string",
          description: "URL to navigate to (used with: navigate, new_tab).",
        },
        selector: {
          type: "string",
          description:
            "CSS selector for the target element (used with: click, fill, select, hover, get_text, wait_for).",
        },
        text: {
          type: "string",
          description:
            "Visible text to locate an element (alternative to selector for click), " +
            "or characters to type (used with: type).",
        },
        value: {
          type: "string",
          description: "Text value to fill or select option value (used with: fill, select).",
        },
        key: {
          type: "string",
          description:
            "Key name to press (used with: press). Examples: Enter, Tab, Escape, ArrowDown, Backspace.",
        },
        direction: {
          type: "string",
          description: 'Scroll direction: "up" or "down" (used with: scroll, default: down).',
        },
        amount: {
          type: "number",
          description: "Pixels to scroll (used with: scroll, default: 600).",
        },
        script: {
          type: "string",
          description:
            "JavaScript expression to evaluate in the page context (used with: evaluate). " +
            "Return value is serialized and returned as text.",
        },
        timeout: {
          type: "number",
          description: "Max wait time in milliseconds (used with: wait_for, default: 10000).",
        },
      },
      required: ["action"],
    },
  },
  systemPrompt:
    "browser — Use for real website navigation and UI interaction. After navigating or interacting, inspect the current state with screenshot, get_text, or get_url before concluding what happened. The session persists across calls.",
  execute,
};
