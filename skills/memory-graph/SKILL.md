---
name: memory-graph
description: Knowledge graph memory MCP tools for structured entity and relation storage across sessions.
roles: [coordinator, advisor, director, inspector]
tools: [mcp__memory__create_entities, mcp__memory__search_nodes]
---

## Knowledge Graph Memory

The memory MCP server provides a persistent knowledge graph for storing **entities** (things) and **relations** (connections between things). This complements Ember's flat memory with structured graph queries.

### Core tools

| Tool | Use case |
|------|----------|
| `mcp__memory__create_entities` | Store new entities with observations |
| `mcp__memory__create_relations` | Link entities together (e.g., "ServiceA depends_on DatabaseB") |
| `mcp__memory__add_observations` | Add facts/observations to existing entities |
| `mcp__memory__delete_entities` | Remove entities and their relations |
| `mcp__memory__delete_observations` | Remove specific observations |
| `mcp__memory__delete_relations` | Remove specific relations |
| `mcp__memory__search_nodes` | Search the graph by keyword |
| `mcp__memory__open_nodes` | Retrieve specific entities by name |
| `mcp__memory__read_graph` | Read the entire knowledge graph |

### When to use graph memory vs. Ember save_memory

| Use case | Right tool |
|----------|-----------|
| Simple facts, preferences, procedures | `save_memory` (Ember native) |
| Complex relationships between things | **Knowledge graph** |
| Architecture maps (services, dependencies) | **Knowledge graph** |
| Project entity tracking (people, repos, APIs) | **Knowledge graph** |
| Cross-session task context | `save_memory` |
| Structured domain models | **Knowledge graph** |

### Workflow pattern

**Map a system architecture:**
```
1. create_entities → add services, databases, APIs as entities
2. create_relations → connect them (depends_on, calls, stores_data_in)
3. add_observations → note configs, versions, owners per entity
4. search_nodes / read_graph → query the map later
```

**Track project knowledge:**
```
1. create_entities → people, repos, deployments, environments
2. create_relations → "Alice owns RepoX", "RepoX deploys_to Staging"
3. search_nodes → find related context when working on a task
```
