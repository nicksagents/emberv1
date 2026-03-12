---
name: desktop-small-model
description: Supplementary desktop guidance for small and mid-size models — environment-first, screenshot-first, one action at a time.
roles: [coordinator, advisor, director, inspector]
tools: [mcp__desktop__describe_environment, mcp__desktop__take_screenshot]
---

## Desktop Automation — Small-Model Rules

Small and mid-size models should treat desktop automation as a strict visual
loop, not a free-form GUI guess.

### Required loop

```
describe_environment -> get_active_window/list_windows -> take_screenshot -> OCR text search if labels matter -> focus/open target -> one action -> take_screenshot -> repeat
```

Never batch multiple GUI guesses into one step. One click, one shortcut, or one
typing action is the limit before re-checking the screen.

### Preferred action order

1. Focus the correct app or window.
2. Use OCR text search before coordinate clicks if a visible label should exist.
3. Use keyboard shortcuts for deterministic actions like `cmd+l`, `ctrl+l`,
   `enter`, or `tab`.
4. Use mouse movement, drag, scroll, and clicks only after a screenshot or OCR result shows where to aim.
5. After every action, take a fresh screenshot before assuming the state changed.

### Login-specific rules

1. If the login may already be saved locally, use `credential_list` or
   `credential_get` before asking the user again.
2. Retrieve credentials immediately before typing them.
3. Do not save or repeat passwords in normal memory or in the final response.
4. After a successful sign-in, remember the non-secret procedure, not the
   secret itself.
