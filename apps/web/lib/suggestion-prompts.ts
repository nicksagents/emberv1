/**
 * Dynamic suggestion prompts based on agent abilities.
 * 
 * This module provides a pool of prompt templates organized by role/capability.
 * When a new chat starts, we randomly select a subset to show the user,
 * giving them a taste of what each agent can do.
 */

export interface SuggestionPrompt {
  title: string;
  description: string;
  value: string;
  /** Which role this prompt is best suited for */
  role: "coordinator" | "advisor" | "director" | "inspector" | "general";
  /** Tags for categorization/filtering */
  tags: string[];
}

// Pool of prompts organized by capability/role
const PROMPT_POOL: SuggestionPrompt[] = [
  // === COORDINATOR - Research, browsing, quick tasks ===
  {
    title: "Research a topic",
    description: "Search the web and summarize findings on any topic.",
    value: "Search the web for information about ___ and give me a summary.",
    role: "coordinator",
    tags: ["web", "research"],
  },
  {
    title: "Fetch and summarize a webpage",
    description: "Pull content from a URL and extract key information.",
    value: "Fetch the content from https://___ and summarize the main points.",
    role: "coordinator",
    tags: ["web", "fetch"],
  },
  {
    title: "Explain this codebase",
    description: "Get an overview of the project structure and key files.",
    value: "Give me an overview of this codebase - what are the main components and how do they fit together?",
    role: "coordinator",
    tags: ["code", "overview"],
  },
  {
    title: "Find something in the code",
    description: "Search for functions, components, or patterns.",
    value: "Search the codebase for ___ and show me where it's defined and used.",
    role: "coordinator",
    tags: ["code", "search"],
  },
  {
    title: "Check git status",
    description: "See what's changed, recent commits, and branch info.",
    value: "Show me the current git status - what branch am I on, what's changed, and recent commits?",
    role: "coordinator",
    tags: ["git", "status"],
  },
  {
    title: "Run a terminal command",
    description: "Execute commands and see the output.",
    value: "Run this command in the terminal: ___",
    role: "coordinator",
    tags: ["terminal"],
  },
  {
    title: "Read a file",
    description: "View the contents of any file in the workspace.",
    value: "Read the file at ___ and explain what it does.",
    role: "coordinator",
    tags: ["code", "read"],
  },
  {
    title: "Test an API endpoint",
    description: "Make HTTP requests and inspect responses.",
    value: "Make a ___ request to ___ and show me the response.",
    role: "coordinator",
    tags: ["api", "http"],
  },
  {
    title: "List project files",
    description: "Browse the directory structure.",
    value: "List the files in ___ directory.",
    role: "coordinator",
    tags: ["files"],
  },

  // === ADVISOR - Planning and architecture ===
  {
    title: "Plan a feature",
    description: "Break down a complex feature into implementation steps.",
    value: "Help me plan how to implement: ___",
    role: "advisor",
    tags: ["planning", "architecture"],
  },
  {
    title: "Design an API",
    description: "Design endpoints, schemas, and data flow.",
    value: "Design an API for ___ - what endpoints, request/response shapes, and data models do I need?",
    role: "advisor",
    tags: ["api", "design"],
  },
  {
    title: "Choose a technology",
    description: "Compare options and get recommendations.",
    value: "Help me decide between ___ for my project. What are the tradeoffs?",
    role: "advisor",
    tags: ["research", "decision"],
  },
  {
    title: "Architecture review",
    description: "Evaluate the current structure and suggest improvements.",
    value: "Review the architecture of this codebase. What are the strengths and what could be improved?",
    role: "advisor",
    tags: ["architecture", "review"],
  },
  {
    title: "Scope a project",
    description: "Define milestones and delivery phases.",
    value: "Help me scope out building ___ - what are the phases and key milestones?",
    role: "advisor",
    tags: ["planning"],
  },

  // === DIRECTOR - Deep implementation ===
  {
    title: "Implement a feature",
    description: "Build a complete feature across multiple files.",
    value: "Implement ___ feature. Create the necessary files and wire everything up.",
    role: "director",
    tags: ["implementation"],
  },
  {
    title: "Build a component",
    description: "Create a React/Vue/Svelte component with styles.",
    value: "Build a ___ component that ___",
    role: "director",
    tags: ["ui", "component"],
  },
  {
    title: "Add an API endpoint",
    description: "Create server routes with handlers.",
    value: "Add a new ___ endpoint that ___",
    role: "director",
    tags: ["api", "backend"],
  },
  {
    title: "Fix a bug",
    description: "Debug and fix issues in the codebase.",
    value: "There's a bug where ___. Find and fix it.",
    role: "director",
    tags: ["debug", "fix"],
  },
  {
    title: "Refactor code",
    description: "Restructure for better maintainability.",
    value: "Refactor ___ to make it more maintainable.",
    role: "director",
    tags: ["refactor"],
  },
  {
    title: "Add tests",
    description: "Write test coverage for existing code.",
    value: "Write tests for ___",
    role: "director",
    tags: ["testing"],
  },

  // === INSPECTOR - Review and validation ===
  {
    title: "Review my code",
    description: "Get a thorough code review with specific feedback.",
    value: "Review the code in ___ - what issues or improvements should I address?",
    role: "inspector",
    tags: ["review", "code"],
  },
  {
    title: "Audit for bugs",
    description: "Find potential bugs and edge cases.",
    value: "Audit ___ for bugs and edge cases I might have missed.",
    role: "inspector",
    tags: ["audit", "bugs"],
  },
  {
    title: "Check test coverage",
    description: "Verify what's tested and what's not.",
    value: "Check the test coverage for this project and identify gaps.",
    role: "inspector",
    tags: ["testing", "coverage"],
  },
  {
    title: "Security review",
    description: "Identify potential security issues.",
    value: "Do a security review of ___ and flag any concerns.",
    role: "inspector",
    tags: ["security"],
  },
  {
    title: "Validate implementation",
    description: "Check if code matches requirements.",
    value: "Validate that ___ is correctly implemented according to the requirements.",
    role: "inspector",
    tags: ["validation"],
  },

  // === GENERAL - Any role can handle ===
  {
    title: "Help me understand",
    description: "Get explanations about concepts or code.",
    value: "Explain how ___ works in this codebase.",
    role: "general",
    tags: ["explain"],
  },
  {
    title: "Summarize changes",
    description: "Get a summary of what's changed recently.",
    value: "Summarize what has changed in the codebase recently.",
    role: "general",
    tags: ["git", "summary"],
  },
  {
    title: "List connected providers",
    description: "See which AI providers are available.",
    value: "List the connected providers and their current status.",
    role: "general",
    tags: ["settings"],
  },
  {
    title: "Check project health",
    description: "Run tests, lint, type checks to verify state.",
    value: "Check the health of this project - run tests, lint, and type checks.",
    role: "general",
    tags: ["health", "testing"],
  },
];

// Track recently shown prompts to avoid repetition
const RECENT_PROMPTS_KEY = "ember_recent_prompts";
const MAX_RECENT = 12;

function getRecentPrompts(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(RECENT_PROMPTS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function addToRecent(title: string) {
  if (typeof window === "undefined") return;
  try {
    const recent = getRecentPrompts();
    const updated = [title, ...recent.filter((t) => t !== title)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_PROMPTS_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Get a diverse set of random suggestion prompts.
 * 
 * The algorithm:
 * 1. Gets recently shown prompts to avoid repetition
 * 2. Separates prompts into "fresh" (not recently shown) and "recent"
 * 3. Prioritizes fresh prompts, but falls back to recent if needed
 * 4. Ensures some variety by including different roles when possible
 */
export function getRandomSuggestionPrompts(count: number = 4): SuggestionPrompt[] {
  const recentTitles = new Set(getRecentPrompts());
  
  // Separate into fresh and recent
  const fresh: SuggestionPrompt[] = [];
  const recent: SuggestionPrompt[] = [];
  
  for (const prompt of PROMPT_POOL) {
    if (recentTitles.has(prompt.title)) {
      recent.push(prompt);
    } else {
      fresh.push(prompt);
    }
  }
  
  // Shuffle both groups
  const shuffledFresh = shuffle(fresh);
  const shuffledRecent = shuffle(recent);
  
  // Try to get a diverse selection across roles
  const selected: SuggestionPrompt[] = [];
  const usedRoles = new Set<string>();
  
  // First pass: prefer diverse roles from fresh prompts
  for (const prompt of shuffledFresh) {
    if (selected.length >= count) break;
    if (!usedRoles.has(prompt.role) || selected.length < count - 1) {
      selected.push(prompt);
      usedRoles.add(prompt.role);
      addToRecent(prompt.title);
    }
  }
  
  // Second pass: fill remaining slots from fresh
  for (const prompt of shuffledFresh) {
    if (selected.length >= count) break;
    if (!selected.includes(prompt)) {
      selected.push(prompt);
      addToRecent(prompt.title);
    }
  }
  
  // Final pass: fill from recent if we still need more
  for (const prompt of shuffledRecent) {
    if (selected.length >= count) break;
    if (!selected.includes(prompt)) {
      selected.push(prompt);
      addToRecent(prompt.title);
    }
  }
  
  return selected;
}

/**
 * Get prompts filtered by a specific role.
 */
export function getPromptsByRole(role: SuggestionPrompt["role"]): SuggestionPrompt[] {
  return PROMPT_POOL.filter((p) => p.role === role || p.role === "general");
}

/**
 * Get prompts filtered by tag.
 */
export function getPromptsByTag(tag: string): SuggestionPrompt[] {
  return PROMPT_POOL.filter((p) => p.tags.includes(tag));
}

/**
 * Search prompts by keyword.
 */
export function searchPrompts(query: string): SuggestionPrompt[] {
  const q = query.toLowerCase();
  return PROMPT_POOL.filter(
    (p) =>
      p.title.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.tags.some((t) => t.includes(q))
  );
}
