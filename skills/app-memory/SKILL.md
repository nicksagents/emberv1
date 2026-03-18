---
name: app-memory
description: Structured memory for learning and recalling how to use any application — workflows, shortcuts, UI layouts, and quirks. Works across all operating systems.
roles: [coordinator, advisor, director, inspector]
tools: [app_memory_save, app_memory_search, app_memory_get, app_memory_list, app_memory_delete]
---

## App Memory

Use app memory tools to build persistent, structured knowledge about how to use
applications installed on the user's computer. This knowledge survives across
sessions so the agent learns apps once and operates them fluently afterward.

### When to use

- **Before automating a desktop app**: Call `app_memory_search` with the app name
  before taking any desktop action. If a matching workflow exists, retrieve it
  with `app_memory_get` and follow the recorded steps instead of exploring from
  scratch.
- **After successfully using an app**: When a desktop workflow succeeds (verified
  by screenshot), save the working steps with `app_memory_save` so future
  sessions can skip the trial-and-error phase.
- **When the user teaches you**: If the user explains how an app works, where a
  button is, or what shortcut to use, save that knowledge immediately.
- **When you discover a quirk**: If an app behaves unexpectedly (e.g. a menu is
  in a non-standard location, a hotkey differs from the norm), save it as
  category `quirk` so you don't forget.

### What to save

| Category       | When to use                                                     | Example                                      |
|----------------|-----------------------------------------------------------------|----------------------------------------------|
| `workflow`     | Multi-step procedures that accomplish a task                    | "Export GIMP image as PNG"                   |
| `shortcut`     | Keyboard shortcuts specific to the app                          | "GIMP keyboard shortcuts"                    |
| `ui_layout`    | Where UI elements are located on screen                         | "VS Code sidebar and panel layout"           |
| `quirk`        | Non-obvious behavior, workarounds, gotchas                      | "LibreOffice Calc paste-special requires menu"|
| `setup`        | First-time configuration or installation steps                  | "Initial GIMP plugin setup"                  |
| `navigation`   | How to reach a specific panel, menu, or setting                 | "Firefox about:config access"                |
| `preference`   | User's preferred settings within an app                         | "VS Code font size and theme"                |
| `automation`   | Scripted or macro-based workflows within the app                | "Blender Python console batch render"        |

### Workflow: Learning a new app

1. `app_memory_search` — check if we already know this app
2. `mcp__desktop__describe_environment` — confirm OS capabilities
3. `mcp__desktop__open_application` — launch the app
4. `mcp__desktop__take_screenshot` — see what we're working with
5. Explore: use `detect_text_on_screen`, `find_text_on_screen`, `list_windows`
6. Perform the task with desktop tools (click, type, shortcuts)
7. `mcp__desktop__take_screenshot` — verify the result
8. `app_memory_save` — record the successful workflow with steps

### Workflow: Using a known app

1. `app_memory_search` with the app name and task description
2. `app_memory_get` with the best matching ID
3. Follow the recorded steps using desktop tools
4. If steps need updating (UI changed, new version), save the updated workflow
   — the save tool auto-merges when app+title match

### Step structure

Each step in a workflow should capture:
- **action**: What to do (`click`, `type`, `shortcut`, `menu`, `navigate`, `wait`, etc.)
- **target**: What UI element to interact with (button label, menu name, field name)
- **value**: What to input (text, key combo, menu path)
- **note**: Tips, warnings, or observations about this step

### Cross-platform awareness

- Always record the `platform` when saving. A GIMP workflow on Linux may differ
  from macOS (different menu shortcuts, window chrome, etc.).
- Use `platform: "any"` only for truly universal workflows (e.g. web apps,
  cross-platform keyboard shortcuts like Ctrl/Cmd+C).
- When searching, the tool automatically filters by platform unless you specify
  otherwise.

### Integration with other tools

- **Desktop control**: App memory provides the *knowledge*, desktop MCP tools
  provide the *execution*. Always search app memory before blindly exploring.
- **Credential vault**: Store app login credentials in the credential vault, not
  in app memory. App memory stores the *workflow* for logging in (which fields
  to fill, which buttons to click), not the credentials themselves.
- **General memory**: Use `save_memory` for facts about the user or project.
  Use `app_memory_save` for structured app knowledge with steps and shortcuts.
- **Terminal**: For CLI apps, save common command patterns and flags as app
  memories with category `shortcut` or `workflow`. This helps recall complex
  CLI invocations.

### Rules

- Never store passwords, API keys, or secrets in app memory. Use the credential
  vault for those.
- Always verify a workflow works (via screenshot) before saving it.
- Prefer updating existing entries over creating duplicates — the save tool
  handles this automatically when app+title match.
- Keep step descriptions precise enough that the desktop tools can replay them
  (exact button labels, menu paths, key combos).
- Set `confidence` below 0.5 if the workflow is experimental or only partially
  verified. Update it to 0.8+ after confirmation.
- Use `app_memory_delete` when an app version changes enough that old workflows
  are invalid.
