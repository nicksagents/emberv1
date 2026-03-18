/**
 * Gateway Manager
 *
 * Manages platform adapter lifecycle. Adapters are opt-in via settings.
 */

export type { PlatformAdapter, IncomingMessage, MessageHandler } from "./types.js";
export { TelegramAdapter } from "./telegram.js";

import type { PlatformAdapter, MessageHandler } from "./types.js";
import { TelegramAdapter } from "./telegram.js";

const adapters: PlatformAdapter[] = [];

export interface GatewayConfig {
  telegram?: {
    enabled: boolean;
    botToken: string;
  };
  // Future: discord, slack, webhook
}

/**
 * Initialize all configured platform adapters.
 */
export async function initializeGateways(
  config: GatewayConfig,
  messageHandler: MessageHandler,
): Promise<void> {
  if (config.telegram?.enabled && config.telegram.botToken) {
    try {
      const telegram = new TelegramAdapter();
      telegram.onMessage(messageHandler);
      await telegram.initialize({ botToken: config.telegram.botToken });
      adapters.push(telegram);
    } catch (error) {
      console.warn(
        `[gateway] Failed to initialize Telegram: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Shut down all active adapters.
 */
export async function shutdownGateways(): Promise<void> {
  for (const adapter of adapters) {
    try {
      await adapter.shutdown();
    } catch (error) {
      console.warn(
        `[gateway] Failed to shut down ${adapter.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  adapters.length = 0;
}

/**
 * Get list of active adapters for status reporting.
 */
export function getActiveAdapters(): ReadonlyArray<{ id: string; name: string; platform: string; connected: boolean }> {
  return adapters.map((a) => ({
    id: a.id,
    name: a.name,
    platform: a.platform,
    connected: a.isConnected(),
  }));
}
