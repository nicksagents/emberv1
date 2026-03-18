/**
 * Platform Gateway Adapter Interface
 *
 * Defines the contract for platform adapters (Telegram, Discord, Slack, etc.)
 * that bridge external messaging platforms to the Ember chat pipeline.
 */

export interface IncomingMessage {
  /** Platform-specific channel/chat ID */
  channelId: string;
  /** Sender's display name */
  senderName: string;
  /** Platform-specific sender ID */
  senderId: string;
  /** Message text content */
  text: string;
  /** Optional attachments (images, files) */
  attachments?: Array<{ type: string; url: string; name?: string }>;
  /** Raw platform-specific metadata */
  metadata?: Record<string, unknown>;
}

export type MessageHandler = (message: IncomingMessage) => Promise<string>;

export interface PlatformAdapter {
  /** Unique adapter identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Platform type */
  platform: "telegram" | "discord" | "slack" | "webhook" | string;
  /** Initialize the adapter with configuration */
  initialize(config: Record<string, string>): Promise<void>;
  /** Register the handler for incoming messages */
  onMessage(handler: MessageHandler): void;
  /** Send a message to a specific channel */
  sendMessage(channelId: string, content: string): Promise<void>;
  /** Whether the adapter is currently connected */
  isConnected(): boolean;
  /** Gracefully shut down the adapter */
  shutdown(): Promise<void>;
}
