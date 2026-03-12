---
name: desktop-control
description: Desktop MCP tools for native app automation, screenshots, keyboard, mouse, and app focus. Use with browser, terminal, and file tools for full machine workflows.
roles: [coordinator, advisor, director, inspector, ops]
tools: [mcp__desktop__describe_environment]
---

## Desktop Control

Use the desktop MCP tools when the task requires control of a native desktop app,
the whole screen, or OS-level UI outside the Playwright browser.

### When to use desktop vs browser vs terminal

| Need | Right surface |
|------|---------------|
| Web login, page interaction, DOM-aware automation | `mcp__playwright__browser_*` |
| Native apps, app switching, whole-screen screenshots, mouse/keyboard control | `mcp__desktop__*` |
| Commands, scripts, package managers, system diagnostics | `run_terminal_command` |
| Code and project files | native file tools or filesystem MCP |

### Required workflow

For any desktop task, start with:

1. `mcp__desktop__describe_environment`
2. `mcp__desktop__take_screenshot`

Then use the smallest next action:

- Open or focus the target app with `mcp__desktop__open_application` or `mcp__desktop__focus_application`
- Use `mcp__desktop__move_mouse` + `mcp__desktop__click_mouse` for pointer actions
- Use `mcp__desktop__type_text` or `mcp__desktop__press_keys` for keyboard actions
- Re-run `mcp__desktop__take_screenshot` after every meaningful step

Never assume a desktop action worked without a fresh screenshot or another tool result.

### Cross-tool workflow

- Use Playwright browser tools for websites the agent can drive inside Chromium.
- Use desktop tools when the target is a native app or when the OS shell/app switcher matters.
- Use terminal for shell work instead of trying to type commands into GUI terminals.
- Use file tools or filesystem MCP for reading and editing files instead of clicking around Finder or Explorer.

### Practical rules

- Call `describe_environment` first so you know what the current OS actually supports.
- Prefer focusing an app before typing or pressing keys.
- Prefer `type_text` for literal text and `press_keys` for shortcuts like `cmd+l`, `ctrl+shift+p`, or `enter`.
- For navigation or verification, screenshots are the source of truth.
- If desktop capabilities are unavailable on the current machine, fall back to browser, terminal, or file tools.
