---
name: project-stack
description: Local conventions for the generated Node HTTP scaffold.
roles: [coordinator, director, inspector]
---

## Node HTTP Project Stack

- Prefer the built-in `node:http` server until requirements justify a framework.
- Keep config in environment variables rather than hard-coded branching.
- Replace the placeholder root handler first.
