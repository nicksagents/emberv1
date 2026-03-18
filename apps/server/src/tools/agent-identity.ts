/**
 * Agent Identity Tools
 *
 * Enables the agent to create disposable email addresses, check inboxes for
 * verification codes, and manage its own service accounts. Uses free public
 * email APIs with automatic fallback between providers.
 */

import type { EmberTool } from "./types.js";

// ─── Disposable Email Providers ─────────────────────────────────────────────────

interface DisposableEmailProvider {
  name: string;
  createAddress(): Promise<{ email: string; token?: string }>;
  checkInbox(email: string, token?: string): Promise<InboxMessage[]>;
}

interface InboxMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

// Active sessions for token-based providers
const activeSessions = new Map<string, { provider: string; token?: string; createdAt: number }>();

// ── 1secmail provider ──

const oneSecMailProvider: DisposableEmailProvider = {
  name: "1secmail",
  async createAddress() {
    const response = await fetch("https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1");
    if (!response.ok) throw new Error(`1secmail: ${response.status}`);
    const [email] = (await response.json()) as string[];
    return { email };
  },
  async checkInbox(email: string) {
    const [login, domain] = email.split("@");
    const response = await fetch(
      `https://www.1secmail.com/api/v1/?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`,
    );
    if (!response.ok) throw new Error(`1secmail inbox: ${response.status}`);
    const messages = (await response.json()) as Array<{
      id: number;
      from: string;
      subject: string;
      date: string;
    }>;

    const results: InboxMessage[] = [];
    for (const msg of messages.slice(0, 5)) {
      const detailResponse = await fetch(
        `https://www.1secmail.com/api/v1/?action=readMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${msg.id}`,
      );
      if (detailResponse.ok) {
        const detail = (await detailResponse.json()) as { body: string; textBody?: string };
        results.push({
          id: String(msg.id),
          from: msg.from,
          subject: msg.subject,
          body: detail.textBody || detail.body || "",
          receivedAt: msg.date,
        });
      }
    }
    return results;
  },
};

// ── mail.tm provider ──

const mailTmProvider: DisposableEmailProvider = {
  name: "mail.tm",
  async createAddress() {
    // Get available domains
    const domainsResponse = await fetch("https://api.mail.tm/domains");
    if (!domainsResponse.ok) throw new Error(`mail.tm domains: ${domainsResponse.status}`);
    const domainsData = (await domainsResponse.json()) as { "hydra:member": Array<{ domain: string }> };
    const domains = domainsData["hydra:member"];
    if (!domains || domains.length === 0) throw new Error("mail.tm: no domains available");

    const domain = domains[0].domain;
    const username = `ember${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${username}@${domain}`;
    const password = `Ember${Math.random().toString(36).slice(2, 10)}!1`;

    // Create account
    const createResponse = await fetch("https://api.mail.tm/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: email, password }),
    });
    if (!createResponse.ok) throw new Error(`mail.tm create: ${createResponse.status}`);

    // Get auth token
    const tokenResponse = await fetch("https://api.mail.tm/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: email, password }),
    });
    if (!tokenResponse.ok) throw new Error(`mail.tm token: ${tokenResponse.status}`);
    const tokenData = (await tokenResponse.json()) as { token: string };

    return { email, token: tokenData.token };
  },
  async checkInbox(_email: string, token?: string) {
    if (!token) throw new Error("mail.tm requires token");
    const response = await fetch("https://api.mail.tm/messages", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`mail.tm inbox: ${response.status}`);
    const data = (await response.json()) as {
      "hydra:member": Array<{
        id: string;
        from: { address: string };
        subject: string;
        text?: string;
        intro?: string;
        createdAt: string;
      }>;
    };

    return (data["hydra:member"] || []).slice(0, 5).map((msg) => ({
      id: msg.id,
      from: msg.from?.address || "unknown",
      subject: msg.subject || "(no subject)",
      body: msg.text || msg.intro || "",
      receivedAt: msg.createdAt,
    }));
  },
};

const EMAIL_PROVIDERS: DisposableEmailProvider[] = [oneSecMailProvider, mailTmProvider];

// ─── Verification Code Extraction ───────────────────────────────────────────────

const CODE_PATTERNS = [
  /\b(\d{6})\b/,                              // 6-digit code
  /\b(\d{4})\b/,                              // 4-digit code
  /verification\s*(?:code|pin)[:\s]*(\d{4,8})/i,
  /(?:code|pin|otp)[:\s]*(\d{4,8})/i,
  /\b([A-Z0-9]{6,8})\b(?=.*verif)/i,         // alphanumeric verification code
];

const LINK_PATTERNS = [
  /(https?:\/\/[^\s<>"]+(?:confirm|verify|activate|validate|token)[^\s<>"]*)/i,
  /(https?:\/\/[^\s<>"]+(?:click|action|redirect)[^\s<>"]*)/i,
];

function extractVerificationData(body: string): { codes: string[]; links: string[] } {
  const codes: string[] = [];
  const links: string[] = [];

  for (const pattern of CODE_PATTERNS) {
    const match = body.match(pattern);
    if (match?.[1] && !codes.includes(match[1])) {
      codes.push(match[1]);
    }
  }

  for (const pattern of LINK_PATTERNS) {
    const match = body.match(pattern);
    if (match?.[1] && !links.includes(match[1])) {
      links.push(match[1]);
    }
  }

  return { codes, links };
}

// ─── Tool: create_disposable_email ──────────────────────────────────────────────

async function createDisposableEmailExecute(input: Record<string, unknown>): Promise<string> {
  const serviceName = typeof input.service_name === "string" ? input.service_name.trim() : "general";

  console.log(`[tool:create_disposable_email] for "${serviceName}"`);

  let lastError: string | null = null;

  for (const provider of EMAIL_PROVIDERS) {
    try {
      const result = await provider.createAddress();

      // Store session for later inbox checking
      activeSessions.set(result.email, {
        provider: provider.name,
        token: result.token,
        createdAt: Date.now(),
      });

      // Clean up old sessions (> 1 hour)
      const cutoff = Date.now() - 3600_000;
      for (const [email, session] of activeSessions) {
        if (session.createdAt < cutoff) activeSessions.delete(email);
      }

      const lines = [
        `Disposable email created successfully.`,
        `Email: ${result.email}`,
        `Provider: ${provider.name}`,
        `Purpose: ${serviceName}`,
        "",
        "Next steps:",
        "1. Use this email to sign up for the service",
        "2. Call check_disposable_inbox to retrieve verification codes",
        "3. Call credential_save to store the account credentials with tag 'ember-managed'",
      ];

      return lines.join("\n");
    } catch (err) {
      lastError = `${provider.name}: ${err instanceof Error ? err.message : String(err)}`;
      console.log(`[tool:create_disposable_email] ${provider.name} failed: ${lastError}`);
    }
  }

  return [
    `Error: all disposable email providers failed.`,
    `Last error: ${lastError}`,
    "",
    "Alternatives:",
    "- Ask the user for an email address to use",
    "- Try web_search for other disposable email services",
  ].join("\n");
}

// ─── Tool: check_disposable_inbox ───────────────────────────────────────────────

async function checkDisposableInboxExecute(input: Record<string, unknown>): Promise<string> {
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!email) return "Error: email is required.";

  const waitSeconds = typeof input.wait_seconds === "number"
    ? Math.max(0, Math.min(30, Math.floor(input.wait_seconds)))
    : 10;
  const extractCode = input.extract_code !== false;

  console.log(`[tool:check_disposable_inbox] ${email} wait=${waitSeconds}s`);

  // Wait if requested
  if (waitSeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }

  // Find provider
  const session = activeSessions.get(email);
  let messages: InboxMessage[] = [];
  let providerName = "unknown";

  if (session) {
    const provider = EMAIL_PROVIDERS.find((p) => p.name === session.provider);
    if (provider) {
      try {
        messages = await provider.checkInbox(email, session.token);
        providerName = provider.name;
      } catch (err) {
        return `Error checking inbox via ${provider.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } else {
    // Try to infer provider from domain
    const domain = email.split("@")[1];
    if (!domain) return "Error: invalid email format.";

    // Try 1secmail for common disposable domains
    try {
      messages = await oneSecMailProvider.checkInbox(email);
      providerName = "1secmail";
    } catch (err) {
      return `Error: no active session for ${email} and fallback failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (messages.length === 0) {
    return [
      `No messages found in ${email} inbox (checked via ${providerName}).`,
      "",
      "The email may not have arrived yet. Try again with a longer wait:",
      `  check_disposable_inbox email="${email}" wait_seconds=20`,
    ].join("\n");
  }

  const sections: string[] = [`Inbox for ${email} (${messages.length} message${messages.length > 1 ? "s" : ""}):`];

  for (const msg of messages) {
    sections.push("");
    sections.push(`  From: ${msg.from}`);
    sections.push(`  Subject: ${msg.subject}`);
    sections.push(`  Received: ${msg.receivedAt}`);

    // Truncate body for readability
    const bodyPreview = msg.body.length > 500 ? msg.body.slice(0, 497) + "..." : msg.body;
    sections.push(`  Body: ${bodyPreview}`);

    if (extractCode) {
      const { codes, links } = extractVerificationData(msg.body);
      if (codes.length > 0) {
        sections.push(`  >> VERIFICATION CODES: ${codes.join(", ")}`);
      }
      if (links.length > 0) {
        sections.push(`  >> CONFIRMATION LINKS:`);
        for (const link of links) {
          sections.push(`     ${link}`);
        }
      }
    }
  }

  return sections.join("\n");
}

// ─── Tool: manage_agent_accounts ────────────────────────────────────────────────

async function manageAgentAccountsExecute(input: Record<string, unknown>): Promise<string> {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  if (!action) return "Error: action is required (list, check-status, or plan-signup).";

  const service = typeof input.service === "string" ? input.service.trim() : "";

  console.log(`[tool:manage_agent_accounts] action=${action} service="${service}"`);

  switch (action) {
    case "list":
      return [
        "To list Ember-managed accounts, use:",
        '  credential_list tags="ember-managed"',
        "",
        "This will show all accounts the agent has created autonomously.",
        "Each entry includes the service name, email used, and creation date.",
      ].join("\n");

    case "check-status":
      if (!service) return "Error: service name is required for check-status.";
      return [
        `To check status of accounts for "${service}":`,
        `  1. credential_list tags="ember-managed" — find the entry`,
        `  2. credential_get id="<entry-id>" — retrieve the credentials`,
        `  3. Use the credentials to test access (e.g., API call or browser login)`,
      ].join("\n");

    case "plan-signup": {
      if (!service) return "Error: service name is required for plan-signup.";
      return [
        `Signup plan for "${service}":`,
        "",
        "1. Check if you already have an account:",
        `   credential_list tags="ember-managed,${service.toLowerCase()}"`,
        "",
        "2. If no existing account, get a disposable email:",
        `   create_disposable_email service_name="${service}"`,
        "",
        "3. Navigate to the signup page:",
        `   Use mcp__playwright__browser_navigate or mcp__desktop__open_application`,
        "",
        "4. Fill in the signup form:",
        "   - Use the disposable email as the email address",
        "   - Generate a secure password",
        "   - Fill other required fields",
        "",
        "5. Check for verification email:",
        `   check_disposable_inbox email="<the-email>" wait_seconds=15 extract_code=true`,
        "",
        "6. Complete verification (enter code or click link)",
        "",
        "7. Save the account:",
        `   credential_save label="${service} (ember-managed)" kind="website" ` +
        `email="<the-email>" password="<the-password>" ` +
        `tags="ember-managed,${service.toLowerCase()}"`,
      ].join("\n");
    }

    default:
      return `Error: unknown action "${action}". Use: list, check-status, or plan-signup.`;
  }
}

// ─── Tool Exports ───────────────────────────────────────────────────────────────

export const createDisposableEmailTool: EmberTool = {
  definition: {
    name: "create_disposable_email",
    description:
      "Create a temporary disposable email address for service signups and verifications. " +
      "Automatically tries multiple email providers. The email stays active for inbox checking. " +
      "After signing up, use credential_save to store the account tagged 'ember-managed'.",
    inputSchema: {
      type: "object",
      properties: {
        service_name: {
          type: "string",
          description: "What service you are signing up for (for record-keeping).",
        },
      },
    },
  },
  execute: createDisposableEmailExecute,
};

export const checkDisposableInboxTool: EmberTool = {
  definition: {
    name: "check_disposable_inbox",
    description:
      "Check the inbox of a previously created disposable email for new messages. " +
      "Automatically extracts verification codes and confirmation links from email bodies.",
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "The disposable email address to check.",
        },
        wait_seconds: {
          type: "number",
          description: "Wait before checking (default 10, max 30). Useful for slow verification emails.",
        },
        extract_code: {
          type: "boolean",
          description: "Extract verification codes and confirmation links. Default true.",
        },
      },
      required: ["email"],
    },
  },
  execute: checkDisposableInboxExecute,
};

export const manageAgentAccountsTool: EmberTool = {
  definition: {
    name: "manage_agent_accounts",
    description:
      "Manage Ember's autonomous service accounts. List accounts the agent owns, " +
      "check their status, or get a step-by-step signup plan for a new service.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "check-status", "plan-signup"],
          description: "What to do.",
        },
        service: {
          type: "string",
          description: "Service name (required for check-status and plan-signup).",
        },
      },
      required: ["action"],
    },
  },
  execute: manageAgentAccountsExecute,
};
