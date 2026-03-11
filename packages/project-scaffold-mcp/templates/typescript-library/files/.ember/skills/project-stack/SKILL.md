---
name: project-stack
description: Local conventions for the generated TypeScript library scaffold.
roles: [coordinator, director, inspector]
---

## TypeScript Library Project Stack

- Keep the initial export surface in `src/index.ts`.
- Add files only when they improve clarity, not by default.
- Every exported behavior change should come with a test update.
