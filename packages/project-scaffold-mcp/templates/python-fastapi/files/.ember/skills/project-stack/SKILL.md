---
name: project-stack
description: Local conventions for the generated FastAPI scaffold.
roles: [coordinator, director, inspector]
---

## FastAPI Project Stack

- Add API surface area incrementally; do not split into many modules too early.
- Keep request and response models explicit once non-trivial routes are added.
- Add or update tests in `tests/` with each new route.
