---
name: project-stack
description: Local conventions for the generated Rust CLI scaffold.
roles: [coordinator, director, inspector]
---

## Rust CLI Project Stack

- Keep `src/main.rs` as the initial implementation hub.
- Add crates only when they materially reduce code or risk.
- Preserve a clean `cargo check` / `cargo test` workflow.
