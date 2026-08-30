import { Cursor } from "@gadgets/workshop-shared/gatekeeper";

/** Forward-only paginated results. Call `next()` until it returns `null`; dispose the cursor when
 *  finished, including when stopping early. */
export type { Cursor };

/** A Discord user or bot that authored a message. */
export type DiscordUser = {
  /** Snowflake user ID. */
  id: string;
  /** The account's username (not necessarily unique). */
  username: string;
  /** The user's display name, when Discord reports one. */
  displayName?: string;
  /** True when Discord identifies this account as a bot. */
  isBot: boolean;
};

/** A Discord guild (server). */
export type DiscordGuildInfo = {
  /** Snowflake guild ID. */
  id: string;
  name: string;
  /** Approximate member count, when Discord reports one. */
  memberCount?: number;
};

/** Kind of channel this binding can read. Voice and category channels are not included. */
export type DiscordChannelKind = "text" | "announcement" | "forum" | "thread" | "other";

/** Metadata about a text-capable channel. */
export type DiscordChannelInfo = {
  /** Snowflake channel ID. */
  id: string;
  /** Parent guild ID. */
  guildId: string;
  name: string;
  kind: DiscordChannelKind;
  /** Channel topic, if set. */
  topic?: string;
};

/** A single message in a channel. */
export type DiscordMessage = {
  /** Snowflake message ID. */
  id: string;
  author: DiscordUser | null;
  /** Message body. Mentions are left as Discord markup (`<@id>`). */
  content: string;
  /** When the message was posted. */
  timestamp: Date;
  /** Channel this message was posted in. */
  channelId: string;
  /** Channel name, when known. */
  channelName?: string;
  /** URL that opens this message in the Discord client. */
  jumpUrl: string;
};

/** One channel from a listing, with a capability to read it. */
export type DiscordChannelEntry = {
  info: DiscordChannelInfo;
  /** Capability for this channel. Dispose it when finished. */
  channel: DiscordChannel;
};

/** One message from a listing or search. */
export type DiscordMessageEntry = {
  message: DiscordMessage;
};

/**
 * A session bound to an entire Discord server the connected user is in and the bot can read.
 * Search covers messages the bot has already indexed from that server.
 */
export interface DiscordGuildSession {
  /** Get the server's name and id. */
  getInfo(): Promise<DiscordGuildInfo>;

  /** List text-readable channels the bot can see in this server. */
  listChannels(): Promise<Cursor<DiscordChannelEntry>>;

  /**
   * Search indexed messages in this server. The query must be non-empty.
   * Results are newest first. New messages appear after the index catches up.
   */
  search(query: string): Promise<Cursor<DiscordMessageEntry>>;

  /**
   * Get a capability to a specific channel by its Discord ID. Throws if the channel is not in
   * this server or is not readable. Dispose it when finished.
   */
  getChannel(channelId: string): Promise<DiscordChannel>;
}

/**
 * A session bound to a single Discord channel. Search is limited to this channel.
 */
export interface DiscordChannel {
  /** Get this channel's name, kind, and topic. */
  getInfo(): Promise<DiscordChannelInfo>;

  /** List this channel's recent messages, newest first. */
  listMessages(): Promise<Cursor<DiscordMessageEntry>>;

  /**
   * Search indexed messages in this channel. The query must be non-empty.
   * Results are newest first.
   */
  search(query: string): Promise<Cursor<DiscordMessageEntry>>;
}
