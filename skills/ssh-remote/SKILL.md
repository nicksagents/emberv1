---
name: ssh-remote
description: Execute remote commands over SSH on LAN and Tailscale devices.
roles: [coordinator, advisor, director, inspector]
tools: [ssh_execute, credential_list, credential_get, network_tools]
---

## SSH Remote Control

Use `ssh_execute` when a task must run on another machine (local network or tailnet) instead of this host.

- Confirm connectivity first:
  - `network_tools action=tailscale_status` for tailnet paths.
  - `network_tools action=ping host=<target>` for basic reachability.
- Run a safe connection check before changing anything:
  - `ssh_execute action=test host=<host> username=<user> ...`
- Then run one focused command at a time:
  - `ssh_execute action=run host=<host> username=<user> command="<command>"`

Credential handling:

- Prefer credential vault lookup over raw password input.
- Use `credential_list` to locate the right login.
- Use `credential_get` only when needed and keep secrets out of normal chat text.
- For SSH key auth, pass `private_key_path` and avoid password mode.

Safety defaults:

- `ssh_execute` defaults to private-network/Tailscale hosts only.
- Public hosts require explicit `allow_public_host=true`.
- Keep `host_key_policy=accept-new` or `strict` unless the user explicitly asks to disable verification.
