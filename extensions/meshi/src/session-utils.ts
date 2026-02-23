/**
 * Extract the Telegram user ID from a session key.
 *
 * With `session.dmScope: "per-channel-peer"`, Telegram DM session keys
 * look like: `agent:{agentId}:telegram:direct:{telegramUserId}`
 *
 * Returns null if the key doesn't match the expected Telegram DM pattern.
 */
export function extractTelegramUserId(sessionKey: string | undefined): string | null {
  if (!sessionKey) return null;
  const match = sessionKey.match(/:telegram:direct:(\d+)/);
  return match?.[1] ?? null;
}
