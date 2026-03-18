---
name: github-mcp
description: GitHub MCP server tools for repo, issue, PR, and code search operations.
roles: [coordinator, advisor, director, inspector]
tools: [mcp__github__create_or_update_file, mcp__github__search_repositories]
---

## GitHub MCP Tools

The GitHub MCP server gives you direct access to the GitHub API for repository operations, issue management, pull requests, and code search.

### Core tools

| Tool | Use case |
|------|----------|
| `mcp__github__search_repositories` | Find repos by keyword, language, or topic |
| `mcp__github__search_code` | Search code across GitHub (syntax, patterns, examples) |
| `mcp__github__get_file_contents` | Read a file from a GitHub repo (any branch/ref) |
| `mcp__github__create_or_update_file` | Create or update a file in a repo |
| `mcp__github__push_files` | Push multiple files in a single commit |
| `mcp__github__list_issues` | List issues for a repo (filter by state, labels, assignee) |
| `mcp__github__create_issue` | Open a new issue |
| `mcp__github__update_issue` | Edit an existing issue (title, body, state, labels, assignees) |
| `mcp__github__add_issue_comment` | Comment on an issue or PR |
| `mcp__github__create_pull_request` | Open a new PR |
| `mcp__github__list_commits` | List commits on a branch |
| `mcp__github__create_branch` | Create a new branch from a ref |
| `mcp__github__create_repository` | Create a new GitHub repository |
| `mcp__github__fork_repository` | Fork a repository |

### Workflow patterns

**Research a codebase on GitHub:**
```
1. search_repositories → find the repo
2. get_file_contents (README.md) → understand the project
3. search_code → find specific patterns or implementations
4. get_file_contents → read specific files of interest
```

**Create a PR from the agent:**
```
1. create_branch → new branch from main
2. create_or_update_file / push_files → make changes
3. create_pull_request → open the PR
```

**Triage issues:**
```
1. list_issues (state=open) → see what's open
2. update_issue → add labels, assign, comment
3. add_issue_comment → provide analysis or status updates
```

### When to use GitHub MCP vs. native git tools

- **GitHub MCP**: Remote GitHub operations — searching repos/code, managing issues/PRs, reading files from *other* repos, creating branches on remote
- **Native git_inspect + terminal**: Local git operations — status, diff, log, commit, push on the *current* workspace repo
- Use both together: native git for local work, GitHub MCP for remote collaboration
