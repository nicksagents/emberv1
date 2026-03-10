---
name: project-overview
description: Get oriented in a repo quickly. Run this before searching files in an unfamiliar codebase.
roles: [coordinator, advisor, director, inspector, ops]
tools: [project_overview]
---

## Project Overview

Use `project_overview` to get oriented in an unfamiliar repository before
searching files or running shell commands. It provides a structural summary
(directory layout, key config files, detected frameworks) in one call.

### When to use

- First action in a new repository or project
- When the user asks a broad question about the codebase structure
- Before choosing which files to search or edit

### When to skip

- You already know the project layout from earlier in the conversation
- The user has provided enough context about the file locations
- The task is clearly scoped to a specific file the user named

After `project_overview`, narrow in with `search_files` or `list_directory`
to find the specific file you need.
