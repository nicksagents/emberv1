/**
 * Telegram Platform Adapter
 *
 * Uses the Telegram Bot API with long polling (no webhook server needed).
 * Each Telegram chat is mapped to an Ember conversation.
 */

import type { IncomingMessage, MessageHandler, PlatformAdapter } from "./types.js";

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const POLL_TIMEOUT_SECONDS = 30;
const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

export class TelegramAdapter implements PlatformAdapter {
  readonly id = "telegram";
  readonly name = "Telegram";
  readonly platform = "telegram" as const;

  private botToken: string | null = null;
  private handler: MessageHandler | null = null;
  private polling = false;
  private lastUpdateId = 0;
  private connected = false;
  private abortController: AbortController | null = null;

  async initialize(config: Record<string, string>): Promise<void> {
    const token = config.botToken ?? config.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error("Telegram bot token is required (config.botToken or TELEGRAM_BOT_TOKEN)");
    }
    this.botToken = token;

    // Verify token by calling getMe
    const me = await this.apiCall("getMe");
    if (!me.ok) {
      throw new Error(`Telegram bot token verification failed: ${JSON.stringify(me)}`);
    }
    this.connected = true;
    console.log(`[gateway:telegram] Connected as @${(me.result as { username: string }).username}`);

    // Start polling
    this.startPolling();
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    if (!this.botToken) throw new Error("Telegram adapter not initialized");

    // Split long messages
    const chunks = splitMessage(content, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.apiCall("sendMessage", {
        chat_id: channelId,
        text: chunk,
        parse_mode: "Markdown",
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async shutdown(): Promise<void> {
    this.polling = false;
    this.connected = false;
    this.abortController?.abort();
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        this.abortController = new AbortController();
        const updates = await this.apiCall("getUpdates", {
          offset: this.lastUpdateId + 1,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message"],
        });

        if (!updates.ok || !Array.isArray(updates.result)) continue;

        for (const update of updates.result as TelegramUpdate[]) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          if (update.message?.text) {
            void this.handleUpdate(update);
          }
        }
      } catch (error) {
        if (this.polling) {
          console.warn(
            `[gateway:telegram] Poll error: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Back off on error
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!this.handler || !update.message?.text) return;

    const incoming: IncomingMessage = {
      channelId: String(update.message.chat.id),
      senderName: [update.message.from?.first_name, update.message.from?.last_name]
        .filter(Boolean)
        .join(" ") || "Unknown",
      senderId: String(update.message.from?.id ?? "unknown"),
      text: update.message.text,
      metadata: { telegramUpdateId: update.update_id },
    };

    try {
      const response = await this.handler(incoming);
      await this.sendMessage(incoming.channelId, response);
    } catch (error) {
      console.warn(
        `[gateway:telegram] Handler error for chat ${incoming.channelId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        await this.sendMessage(
          incoming.channelId,
          "Sorry, I encountered an error processing your message.",
        );
      } catch {
        // Best-effort error notification
      }
    }
  }

  private async apiCall(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown }> {
    if (!this.botToken) throw new Error("Not initialized");
    const url = `${TELEGRAM_API_BASE}${this.botToken}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : undefined,
      signal: this.abortController?.signal,
    });
    return (await response.json()) as { ok: boolean; result?: unknown };
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength * 0.5) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name: string; last_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}
