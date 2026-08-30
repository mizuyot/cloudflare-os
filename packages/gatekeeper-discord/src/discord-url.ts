/** Parse `https://discord.com/channels/:guildId` or `.../:guildId/:channelId`. */
export function parseDiscordResourceUrl(url: string):
    { guildId: string; channelId?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "discord.com" && parsed.hostname !== "canary.discord.com") {
    return null;
  }
  let segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] !== "channels" || !segments[1]) return null;
  let guildId = segments[1];
  if (!/^\d+$/.test(guildId)) return null;
  let channelId = segments[2];
  if (channelId && !/^\d+$/.test(channelId)) return null;
  return channelId ? { guildId, channelId } : { guildId };
}

export function discordGuildUrl(guildId: string): string {
  return `https://discord.com/channels/${guildId}`;
}

export function discordChannelUrl(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

export function discordJumpUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Build an FTS5 MATCH query from user text. Each token must match. */
export function discordFtsQuery(query: string): string {
  let tokens = query.trim().split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) throw new Error("Search query must not be empty.");
  return tokens.map(token => `"${token.replaceAll("\"", "")}"`).join(" AND ");
}

export const MAX_SEARCH_QUERY_BYTES = 1000;

export function validateDiscordSearchQuery(query: string): void {
  if (query.trim().length === 0) throw new Error("Search query must not be empty.");
  if (new TextEncoder().encode(query).byteLength > MAX_SEARCH_QUERY_BYTES) {
    throw new Error(`Search query must be at most ${MAX_SEARCH_QUERY_BYTES} bytes.`);
  }
}
