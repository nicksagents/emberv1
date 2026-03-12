---
name: playwright-browser
description: Playwright MCP browser tools for web automation — accessibility-tree navigation, form interaction, and UI verification.
roles: [coordinator, advisor, director, inspector]
tools: [mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot]
---

## Playwright Browser Tools

### When to use the browser vs. lighter tools

The browser is expensive — slow to start, token-heavy, and blocks the Raspberry Pi.
**Always prefer the lighter tool first:**

| Need | Right tool |
|------|-----------|
| Search the web | `web_search` |
| Read a public webpage, docs, article | `fetch_page` |
| Call a JSON/REST API | `http_request` |
| Log in to a site, fill a form, click buttons | **browser** |
| Scrape a page that blocks plain HTTP | **browser** |
| Verify UI state / visual layout | **browser** |
| Anything that requires a live authenticated session | **browser** |

**Never open the browser just to read content.** If `fetch_page` can retrieve the
page (it handles redirects and most public sites), use it. The browser is for
interaction — clicking, typing, submitting forms, navigating behind auth walls.

**Decision rule:** Ask yourself — *do I need to click or log in?*
- **No** → use `fetch_page` (or `web_search` + `fetch_page`)
- **Yes** → use the browser

### Core tools (use these for 95% of tasks)

| Tool | When to use |
|------|-------------|
| `mcp__playwright__browser_navigate` | Go to a URL |
| `mcp__playwright__browser_snapshot` | Read the current page (accessibility tree with element refs) |
| `mcp__playwright__browser_click` | Click an element by ref from snapshot |
| `mcp__playwright__browser_fill_form` | Fill one or more form inputs in a single call |
| `mcp__playwright__browser_type` | Type into the currently focused element |
| `mcp__playwright__browser_press_key` | Press a key: Enter, Tab, Escape, ArrowDown, etc. |
| `mcp__playwright__browser_select_option` | Choose a `<select>` option |
| `mcp__playwright__browser_check` | Check a checkbox |
| `mcp__playwright__browser_take_screenshot` | Capture the page as an image |
| `mcp__playwright__browser_navigate_back` | Go to previous page |
| `mcp__playwright__browser_wait_for` | Wait for text or element to appear |
| `mcp__playwright__browser_handle_dialog` | Accept or dismiss a JS dialog (alert/confirm/prompt) |

### Required workflow — always follow this order

```
1. mcp__playwright__browser_navigate        → go to the target URL
2. mcp__playwright__browser_snapshot        → read the accessibility tree; note element refs
3. mcp__playwright__browser_click / mcp__playwright__browser_fill_form / mcp__playwright__browser_press_key   → act using refs
4. mcp__playwright__browser_snapshot        → verify the action succeeded before continuing
```

Never assume an action succeeded. Always take a fresh snapshot (or verify via
`browser_wait_for`) before treating a step as complete.

### Reading the snapshot

`browser_snapshot` returns an **accessibility tree** — a structured list of
interactive elements with **ref numbers** (e.g. `ref=12`). These refs are stable
within a snapshot but change after page updates, so always re-snapshot after
navigation or major DOM changes.

```
snapshot:
  - button "Sign in"  ref=5
  - textbox "Email address"  ref=8
  - textbox "Password"  ref=9
  - button "Continue"  ref=11
```

Use the ref directly in subsequent tool calls:
```
mcp__playwright__browser_click(ref=5)
mcp__playwright__browser_fill_form(fields=[{ref: 8, value: "user@example.com"}])
```

### Auth flows — step-by-step pattern

```
1. mcp__playwright__browser_navigate(url)
2. mcp__playwright__browser_snapshot                         ← find the "Sign in" link/button ref
3. mcp__playwright__browser_click(ref=N)                     ← open the sign-in form
4. mcp__playwright__browser_snapshot                         ← find email and password refs
5. mcp__playwright__browser_fill_form(fields=[               ← fill all auth fields in one call
     {ref: emailRef, value: "..."},
     {ref: passwordRef, value: "..."}
   ])
6. mcp__playwright__browser_click(ref=submitRef)             ← submit
7. mcp__playwright__browser_snapshot or mcp__playwright__browser_wait_for     ← verify logged in
```

For verification / OTP flows (email code, SMS code):
```
8. mcp__playwright__browser_snapshot                         ← find the code input ref
9. mcp__playwright__browser_fill_form(fields=[{ref: codeRef, value: "123456"}])
10. mcp__playwright__browser_click(ref=submitRef)
11. mcp__playwright__browser_wait_for(text="Welcome")        ← confirm success
```

### Session reuse

If the browser tool surface exposes storage-state tools, prefer reusing a saved
session before repeating a full login:

1. `mcp__playwright__browser_set_storage_state` before navigation when a known good state exists
2. If the session is valid, continue without re-entering credentials
3. After a successful fresh login, `mcp__playwright__browser_storage_state` can capture the new session for later reuse

Keep secrets in the credential vault and treat storage state as session data,
not as durable user-profile memory.

### Filling forms efficiently

`browser_fill_form` fills multiple fields in one MCP round-trip — prefer it
over calling `browser_click` + `browser_type` per field:

```json
mcp__playwright__browser_fill_form(fields=[
  {"ref": 8, "value": "alice@example.com"},
  {"ref": 9, "value": "my-password"}
])
```

If a field has no ref yet, take a snapshot first, then use the ref from the result.

### Screenshots — when to use them

Use `browser_take_screenshot` only when:
- Visual layout confirmation is specifically required
- The snapshot accessibility tree does not reveal enough context
- You are debugging an unexpected page state

For state checks (URL, title, element presence), prefer `browser_snapshot` or
`browser_wait_for` — they are cheaper and work for non-visual models.

### Avoiding common mistakes

- **Do NOT navigate if you are already on the correct URL** — take a snapshot first to check
- **Do NOT skip the snapshot step** — acting without a snapshot means guessing refs that no longer exist
- **Do NOT call browser_fill_form without a ref** — if you lack a ref, take a snapshot
- **Do NOT use low-level mouse tools** (`browser_mouse_click_xy`, `browser_mouse_drag_xy`)
  unless the target element has no accessible ref and all other approaches failed
- **Do NOT re-try a failed action with the same ref** — refs expire after DOM updates;
  always re-snapshot and get fresh refs
- **Do NOT use `browser_evaluate` for simple reads** — the snapshot or `browser_wait_for`
  cover most cases with fewer tokens

### Advanced tools (use only when needed)

| Tool | Use case |
|------|----------|
| `mcp__playwright__browser_evaluate` | Run arbitrary JS; last resort for reading hidden state |
| `mcp__playwright__browser_drag` | Drag-and-drop UI interactions |
| `mcp__playwright__browser_reload` | Force-reload when page is stale |
| `mcp__playwright__browser_network_requests` | Debug API calls during a flow |
| `mcp__playwright__browser_console_messages` | Read JS console logs for error diagnosis |
| `mcp__playwright__browser_tabs` | List open tabs when multi-tab context is needed |
| `mcp__playwright__browser_storage_state` | Export cookies + localStorage for session persistence |
| `mcp__playwright__browser_set_storage_state` | Restore a previously saved session |
