---
name: credential-vault
description: Local-only credential workflow for storing, locating, and reusing website or app logins without putting secrets into normal memory.
roles: [coordinator, advisor, director, inspector]
tools: [credential_save, credential_list, credential_get]
---

## Credential Vault

Use the credential vault for usernames, login emails, passwords, and similar
account secrets that should stay local-only to the machine.

- When the operating system exposes a native keychain, Ember stores the secret
  there and keeps only non-secret credential metadata in its local data files.
- When no OS keychain is available, Ember falls back to its private local
  credential file.

- Use `credential_list` before asking the user to repeat a login they may have
  already saved.
- Use `credential_get` immediately before a browser or desktop sign-in step so
  the secret is fresh in context and does not need to be retyped from memory.
- Use `credential_save` when the user gives a new login, rotates a password, or
  explicitly wants Ember to reuse a credential later.
- Keep the label stable when updating an existing account so the same entry can
  be reused across sessions.
- Do not store passwords, tokens, OTP codes, or login emails with
  `save_memory`. Long-term memory is for reusable non-secret facts and
  procedures.
- If the task has reusable steps, save or reinforce the procedure separately
  without embedding the secret. Reference the site, app, or credential label in
  the procedure instead of the raw password.
