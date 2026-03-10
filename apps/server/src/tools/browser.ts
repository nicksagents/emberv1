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

interface SnapshotElement {
  id: string;
  kind: string;
  text: string;
  label: string;
  name: string;
  placeholder: string;
  type: string;
  valuePreview: string;
}

type SnapshotMode = "full" | "auth";

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

function shouldUseHeadlessBrowser(): boolean {
  const configured = process.env.EMBER_BROWSER_HEADLESS?.trim().toLowerCase();
  if (configured === "1" || configured === "true" || configured === "yes") {
    return true;
  }
  if (configured === "0" || configured === "false" || configured === "no") {
    return false;
  }

  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true;
  }

  if (process.env.CI?.trim().toLowerCase() === "true") {
    return true;
  }

  return false;
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
    session.browser = await pw.chromium.launch({ headless: shouldUseHeadlessBrowser() });
  }

  if (!session.page || session.page.isClosed()) {
    session.page = await session.browser.newPage();
    await session.page.setViewportSize({ width: 1280, height: 800 });
  }

  return session.page;
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function elementIdSelector(elementId: string): string {
  return `[data-ember-target="${escapeAttributeValue(elementId)}"]`;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function looksLikeOneTimeCode(value: string): boolean {
  return /^[A-Za-z0-9-]{4,12}$/.test(value.trim());
}

async function tryFillLocator(locator: import("playwright").Locator, value: string): Promise<boolean> {
  if (await locator.count() < 1) {
    return false;
  }
  await locator.first().fill(value, { timeout: 10_000 });
  return true;
}

async function collectPageSnapshot(page: Page, mode: SnapshotMode): Promise<{
  url: string;
  title: string;
  elements: SnapshotElement[];
}> {
  return await page.evaluate((snapshotMode) => {
    const previous = document.querySelectorAll("[data-ember-target]");
    previous.forEach((node) => node.removeAttribute("data-ember-target"));

    const isVisible = (element: Element): boolean => {
      const html = element as HTMLElement;
      const rect = html.getBoundingClientRect();
      const style = window.getComputedStyle(html);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";
    };

    const compact = (value: string | null | undefined, limit = 64): string => {
      const normalized = (value ?? "").replace(/\s+/g, " ").trim();
      return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
    };

    const labelFor = (element: Element): string => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const explicit = element.labels?.[0]?.textContent ?? "";
        const aria = element.getAttribute("aria-label") ?? "";
        return compact(explicit || aria);
      }
      return compact(element.getAttribute("aria-label") ?? "");
    };

    const textFor = (element: Element): string => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return compact(element.value || element.placeholder || "");
      }
      return compact((element as HTMLElement).innerText || element.textContent || "");
    };

    const candidates = Array.from(document.querySelectorAll(
      'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]',
    ));

    const authWords = ["sign in", "login", "log in", "email", "password", "code", "otp", "verify", "confirm", "enter"];
    const elements: SnapshotElement[] = [];
    let counter = 1;

    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      if (!isVisible(element)) {
        continue;
      }
      if (elements.length >= 30) {
        break;
      }

      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role")?.toLowerCase() ?? "";
      const type = element instanceof HTMLInputElement ? (element.type || "text").toLowerCase() : "";
      const name = compact(
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? element.name
          : element.getAttribute("name"),
      );
      const placeholder = compact(
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.placeholder
          : element.getAttribute("placeholder"),
      );
      const label = labelFor(element);
      const text = textFor(element);
      const valuePreview = compact(
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? (element.type === "password" ? "[hidden]" : element.value)
          : "",
      );

      const kind =
        tag === "button" || role === "button" ? "button" :
        tag === "a" || role === "link" ? "link" :
        tag === "select" ? "select" :
        tag === "textarea" ? "textarea" :
        tag === "input" ? "input" :
        role || tag;

      const authMeta = [text, label, name, placeholder, type].join(" ").toLowerCase();
      const authRelevant = authWords.some((word) => authMeta.includes(word));
      if (snapshotMode === "auth" && !authRelevant && kind !== "button" && kind !== "input") {
        continue;
      }
      if (snapshotMode === "auth" && !authRelevant && kind === "button" && !/continue|next|submit/i.test(authMeta)) {
        continue;
      }

      const id = `e${counter++}`;
      element.setAttribute("data-ember-target", id);
      elements.push({ id, kind, text, label, name, placeholder, type, valuePreview });
    }

    return {
      url: window.location.href,
      title: document.title,
      elements,
    };
  }, mode) as { url: string; title: string; elements: SnapshotElement[] };
}

async function buildPageSnapshot(page: Page, mode: SnapshotMode = "full"): Promise<string> {
  const snapshot = await collectPageSnapshot(page, mode);

  const lines = snapshot.elements.map((element) => {
    const details = [
      `kind=${element.kind}`,
      element.type ? `type=${element.type}` : "",
      element.text ? `text="${element.text}"` : "",
      element.label ? `label="${element.label}"` : "",
      element.name ? `name="${element.name}"` : "",
      element.placeholder ? `placeholder="${element.placeholder}"` : "",
      element.valuePreview ? `value="${element.valuePreview}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `- ${element.id} ${details}`.trim();
  });

  return [
    mode === "auth" ? "Auth snapshot:" : "Page snapshot:",
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    "",
    "Interactable elements:",
    ...(lines.length ? lines : ["(none found)"]),
    "",
    'Use click/fill with { element_id: "eN" } to target these elements directly.',
  ].join("\n");
}

async function clickElementByTextHeuristics(page: Page, labels: string[]): Promise<string> {
  for (const label of labels) {
    const locator = page.getByText(label, { exact: false });
    if (await locator.count() > 0) {
      await locator.first().click({ timeout: 10_000 });
      return `Clicked element with text: "${label}"`;
    }
  }
  throw new Error(`Could not find any element matching texts: ${labels.join(", ")}`);
}

async function clickSubmitLikeElement(page: Page, preferredText = ""): Promise<string> {
  if (preferredText.trim()) {
    return await clickElementByTextHeuristics(page, [preferredText]);
  }

  const candidates = await collectPageSnapshot(page, "auth");
  const submitCandidate = candidates.elements.find((element) =>
    element.kind === "button" &&
    /confirm|continue|submit|verify|enter|sign in|log in|send|next/.test(
      [element.text, element.label, element.name, element.placeholder].join(" ").toLowerCase(),
    ),
  );

  if (submitCandidate) {
    const locator = page.locator(elementIdSelector(submitCandidate.id));
    await locator.first().click({ timeout: 10_000 });
    return `Clicked submit-like element "${submitCandidate.id}"`;
  }

  const selector = 'button[type="submit"], input[type="submit"], button, [role="button"]';
  const locator = page.locator(selector);
  if (await locator.count() > 0) {
    await locator.first().click({ timeout: 10_000 });
    return "Clicked the first visible submit-like control.";
  }

  throw new Error("Could not find a submit button.");
}

async function fillOtpInputs(page: Page, value: string): Promise<boolean> {
  if (!looksLikeOneTimeCode(value)) {
    return false;
  }

  const inputs = page.locator("input");
  const count = await inputs.count();
  const candidateIndexes: number[] = [];

  for (let index = 0; index < count; index++) {
    const candidate = inputs.nth(index);
    const info = await candidate.evaluate((node) => {
      const input = node as HTMLInputElement;
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      const labelText = input.labels?.[0]?.textContent ?? "";
      const meta = [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute("aria-label") ?? "",
        input.autocomplete,
        input.inputMode,
        labelText,
      ]
        .join(" ")
        .toLowerCase();

      return {
        visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
        editable: !input.disabled && !input.readOnly,
        maxLength: typeof input.maxLength === "number" ? input.maxLength : -1,
        type: (input.type || "text").toLowerCase(),
        meta,
      };
    });

    const isTextLike = ["", "text", "search", "tel", "url", "email", "number", "password"].includes(info.type);
    const looksOtpField =
      info.maxLength === 1 ||
      info.meta.includes("one-time") ||
      info.meta.includes("otp") ||
      info.meta.includes("verification") ||
      info.meta.includes("code") ||
      info.meta.includes("digit") ||
      info.meta.includes("pin");

    if (info.visible && info.editable && isTextLike && looksOtpField) {
      candidateIndexes.push(index);
    }
  }

  if (candidateIndexes.length < value.length) {
    return false;
  }

  for (let index = 0; index < value.length; index++) {
    const field = inputs.nth(candidateIndexes[index]);
    await field.click({ timeout: 10_000 });
    await field.fill(value[index] ?? "", { timeout: 10_000 });
  }

  return true;
}

async function fillByHint(page: Page, input: Record<string, unknown>): Promise<string> {
  const value = typeof input.value === "string" ? input.value : "";
  const elementId = typeof input.element_id === "string" ? input.element_id.trim() : "";
  const selector = typeof input.selector === "string" ? input.selector.trim() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const placeholder = typeof input.placeholder === "string" ? input.placeholder.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";

  if (elementId) {
    const locator = page.locator(elementIdSelector(elementId));
    if (await tryFillLocator(locator, value)) {
      return `Filled element "${elementId}" with value.`;
    }
    throw new Error(`Could not find element_id "${elementId}". Call snapshot again to refresh the page map.`);
  }

  if (selector) {
    await page.fill(selector, value, { timeout: 10_000 });
    return `Filled "${selector}" with value.`;
  }

  if (label && await tryFillLocator(page.getByLabel(label, { exact: false }), value)) {
    return `Filled field labeled "${label}".`;
  }

  if (placeholder && await tryFillLocator(page.getByPlaceholder(placeholder, { exact: false }), value)) {
    return `Filled field with placeholder matching "${placeholder}".`;
  }

  if (name && await tryFillLocator(page.locator(`[name="${escapeAttributeValue(name)}"]`), value)) {
    return `Filled field named "${name}".`;
  }

  if (await fillOtpInputs(page, value)) {
    return `Filled one-time code inputs with ${value.length} characters.`;
  }

  if (looksLikeEmail(value)) {
    const emailSelector = [
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
    ].join(", ");
    if (await tryFillLocator(page.locator(emailSelector), value)) {
      return "Filled email field using common auth-field heuristics.";
    }
  }

  if (looksLikeOneTimeCode(value)) {
    const codeSelector = [
      'input[autocomplete="one-time-code"]',
      'input[name*="code" i]',
      'input[id*="code" i]',
      'input[placeholder*="code" i]',
      'input[aria-label*="code" i]',
      'input[inputmode="numeric"]',
      'input[inputmode="decimal"]',
      'input[type="tel"]',
    ].join(", ");
    if (await tryFillLocator(page.locator(codeSelector), value)) {
      return "Filled code field using common verification-field heuristics.";
    }
  }

  throw new Error(
    "Could not find a fill target. Provide selector, label, placeholder, or name, or use click + type for custom widgets.",
  );
}

async function fillEmailField(page: Page, value: string): Promise<string> {
  return await fillByHint(page, {
    value,
    label: "email",
    placeholder: "email",
    name: "email",
  });
}

async function fillCodeField(page: Page, value: string): Promise<string> {
  return await fillByHint(page, {
    value,
    label: "code",
    placeholder: "code",
    name: "code",
  });
}

// ─── Execute ──────────────────────────────────────────────────────────────────

async function execute(input: Record<string, unknown>): Promise<ToolResult> {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  if (!action) {
    return "Error: action is required. Valid actions: navigate, snapshot, auth_snapshot, open_sign_in, screenshot, click, fill, auth_fill_email, auth_fill_code, submit_form, type, press, scroll, get_text, get_html, get_links, evaluate, wait_for, wait_for_url, go_back, go_forward, get_url, select, hover, new_tab, close_tab, set_viewport, clear_cookies, reset_session";
  }

  console.log(`[tool:browser] action="${action}"`);
  const sessionKey = getSessionKey(input);
  if (action === "reset_session") {
    const session = getSession(sessionKey);
    if (session.page && !session.page.isClosed()) {
      await session.page.close().catch(() => undefined);
    }
    if (session.browser && session.browser.isConnected()) {
      await session.browser.close().catch(() => undefined);
    }
    SESSIONS.delete(sessionKey);
    return `Browser session "${sessionKey}" has been reset.`;
  }

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

      case "snapshot": {
        return await buildPageSnapshot(page);
      }

      case "auth_snapshot": {
        return await buildPageSnapshot(page, "auth");
      }

      case "open_sign_in": {
        return await clickElementByTextHeuristics(page, [
          "Sign in",
          "Sign In",
          "sign in",
          "Log in",
          "Login",
          "log in",
          "login",
        ]);
      }

      // ── Interaction ─────────────────────────────────────────────────────────

      case "click": {
        const elementId = typeof input.element_id === "string" ? input.element_id.trim() : "";
        const selector = typeof input.selector === "string" ? input.selector.trim() : "";
        const text = typeof input.text === "string" ? input.text.trim() : "";

        if (elementId) {
          const locator = page.locator(elementIdSelector(elementId));
          if (await locator.count() < 1) {
            return `Error: element_id "${elementId}" was not found. Call snapshot again to refresh the page map.`;
          }
          await locator.first().click({ timeout: 10_000 });
          return `Clicked element "${elementId}"`;
        }
        if (text) {
          await page.getByText(text, { exact: false }).first().click({ timeout: 10_000 });
          return `Clicked element with text: "${text}"`;
        }
        if (!selector) return "Error: selector or text is required for click.";
        await page.click(selector, { timeout: 10_000 });
        return `Clicked: ${selector}`;
      }

      case "fill": {
        return await fillByHint(page, input);
      }

      case "auth_fill_email": {
        const value = typeof input.value === "string" ? input.value : "";
        if (!value.trim()) return "Error: value is required for auth_fill_email.";
        return await fillEmailField(page, value);
      }

      case "auth_fill_code": {
        const value = typeof input.value === "string" ? input.value : "";
        if (!value.trim()) return "Error: value is required for auth_fill_code.";
        return await fillCodeField(page, value);
      }

      case "submit_form": {
        const text = typeof input.text === "string" ? input.text.trim() : "";
        return await clickSubmitLikeElement(page, text);
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

      case "get_html": {
        const selector = typeof input.selector === "string" ? input.selector.trim() : "";
        const html = selector
          ? await page.innerHTML(selector, { timeout: 5_000 })
          : await page.content();
        const limit = 50_000;
        return html.length > limit
          ? html.slice(0, limit) + "\n\n[… truncated at 50,000 chars]"
          : html;
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

      case "wait_for_url": {
        const urlContains = typeof input.url_contains === "string" ? input.url_contains.trim() : "";
        const timeout = typeof input.timeout === "number" ? Math.min(input.timeout, 30_000) : 10_000;
        if (!urlContains) return "Error: url_contains is required for wait_for_url.";
        await page.waitForURL((url) => url.toString().includes(urlContains), { timeout });
        return `URL matched "${urlContains}".\nCurrent URL: ${page.url()}`;
      }

      case "set_viewport": {
        const width = typeof input.width === "number" ? Math.max(320, Math.floor(input.width)) : 1280;
        const height = typeof input.height === "number" ? Math.max(240, Math.floor(input.height)) : 800;
        await page.setViewportSize({ width, height });
        return `Viewport set to ${width}x${height}.`;
      }

      case "clear_cookies": {
        await page.context().clearCookies();
        return "Cookies cleared for the current browser context.";
      }

      default:
        return (
          `Error: unknown action "${action}".\n` +
          `Valid actions: navigate, snapshot, auth_snapshot, open_sign_in, screenshot, click, fill, auth_fill_email, auth_fill_code, submit_form, type, press, scroll, hover, ` +
          `get_text, get_html, get_links, evaluate, wait_for, wait_for_url, go_back, go_forward, get_url, select, ` +
          `new_tab, close_tab, set_viewport, clear_cookies, reset_session`
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
            "snapshot (return a compact map of interactable elements with element IDs), " +
            "auth_snapshot (return a compact auth-focused page map), " +
            "open_sign_in (click a sign-in/login control using heuristics), " +
            "screenshot (capture current page as image), " +
            "click (click element by element_id, selector, or visible text), " +
            "fill (fill input/textarea by element_id, label, placeholder, name, or CSS selector), " +
            "auth_fill_email (fill the most likely email field), " +
            "auth_fill_code (fill the most likely verification/OTP field), " +
            "submit_form (click the most likely submit/confirm button), " +
            "type (type text via keyboard into focused element), " +
            "press (press a keyboard key: Enter, Tab, Escape, ArrowDown, etc.), " +
            "select (choose a <select> option by value), " +
            "scroll (scroll the page up or down), " +
            "hover (move mouse over element), " +
            "get_text (extract text from page or element), " +
            "get_html (extract rendered HTML from page or element), " +
            "get_links (list all links on page), " +
            "evaluate (run JavaScript in the page context), " +
            "wait_for (wait until a selector appears), " +
            "wait_for_url (wait until the URL contains a substring), " +
            "set_viewport (resize the browser viewport), " +
            "clear_cookies (clear cookies in the current context), " +
            "reset_session (close and recreate the browser session), " +
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
        element_id: {
          type: "string",
          description:
            "Element ID from the latest snapshot result (used with: click, fill). Prefer this for smaller models.",
        },
        label: {
          type: "string",
          description:
            "Accessible label text for an input field (used with: fill). Prefer this for auth forms instead of scraping HTML.",
        },
        placeholder: {
          type: "string",
          description:
            "Placeholder text for an input field (used with: fill).",
        },
        name: {
          type: "string",
          description:
            "name attribute for an input field (used with: fill).",
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
        url_contains: {
          type: "string",
          description: "Substring the URL must contain (used with: wait_for_url).",
        },
        width: {
          type: "number",
          description: "Viewport width in pixels (used with: set_viewport).",
        },
        height: {
          type: "number",
          description: "Viewport height in pixels (used with: set_viewport).",
        },
      },
      required: ["action"],
    },
  },
  systemPrompt: `browser — Chromium browser for real website interaction. Session persists across calls.

WORKFLOW — always follow this order:
1. navigate to the URL
2. snapshot to get a compact page map with element IDs
3. For auth flows, prefer open_sign_in, auth_snapshot, auth_fill_email, auth_fill_code, and submit_form
4. Otherwise prefer click/fill with { element_id: "eN" } from snapshot
5. If no useful element_id exists, use fill with { label, value }, { placeholder, value }, or { name, value }
6. Use screenshot only when visual confirmation matters; use snapshot/get_url for fast verification by default
7. NEVER assume an action succeeded without a fresh snapshot, screenshot, or get_url to verify

COMMON MISTAKES TO AVOID:
- Do NOT use get_html as the default discovery step — snapshot is cheaper and easier for smaller models
- Do NOT manually hunt sign-in/email/code/confirm selectors when the auth_* actions already fit the task
- Do NOT use type without first clicking the input to focus it — prefer fill with element_id, selector, label, placeholder, or name instead
- Do NOT re-navigate to a page you are already on; check the URL with get_url first
- Do NOT repeat steps that already succeeded (check prior tool results before acting)
- For one-time code / OTP widgets, fill may handle split inputs automatically; if not, click the first code box and use type
- If an element is not found, call get_html to inspect the page structure and find the correct selector`,
  execute,
};
