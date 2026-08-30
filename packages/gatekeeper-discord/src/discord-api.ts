import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import type {
  DiscordChannelInfo, DiscordChannelKind, DiscordGuildInfo, DiscordMessage, DiscordUser,
} from "./types";
import { discordJumpUrl } from "./discord-url";

const API_BASE = "https://discord.com/api/v10";
const TOKEN_URL = `${API_BASE}/oauth2/token`;
const REVOKE_URL = `${API_BASE}/oauth2/token/revoke`;
const USER_AGENT = "CloudflareOS-DiscordGatekeeper (https://github.com, 1.0)";
const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT_MAX_RETRIES = 2;

export type DiscordAccessToken = {
  token: string;
  expires: Date;
};

export type DiscordOAuthGrant = {
  accessToken: DiscordAccessToken;
  refreshToken?: string;
  grantedScopes: string[];
  user: DiscordUserProfile;
};

export type DiscordUserProfile = {
  id: string;
  username: string;
  globalName?: string;
  avatar?: string;
};

export type DiscordGuildSummary = {
  id: string;
  name: string;
  icon?: string;
};

export type DiscordPage<T> = {
  items: T[];
  nextCursor?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type RawUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
};

type RawGuild = {
  id: string;
  name: string;
  icon?: string | null;
  approximate_member_count?: number;
};

type RawChannel = {
  id: string;
  guild_id?: string;
  name?: string;
  type: number;
  topic?: string | null;
};

type RawMessage = {
  id: string;
  channel_id: string;
  content?: string;
  timestamp: string;
  author?: RawUser;
};

export class DiscordApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function expiryFrom(expiresIn?: number): Date {
  let seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 7 * 24 * 60 * 60;
  return new Date(Date.now() + seconds * 1000);
}

function splitScopes(scope?: string): string[] {
  return (scope ?? "").split(/[ ,]+/).filter(Boolean);
}

async function postForm(url: string, body: URLSearchParams): Promise<TokenResponse> {
  let response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let data = await response.json<TokenResponse>().catch(() => ({} as TokenResponse));
  if (!response.ok || data.error) {
    throw new DiscordApiError(
      response.status,
      data.error_description || data.error || `Discord token request failed (${response.status})`,
    );
  }
  return data;
}

export async function exchangeAuthCode(
    code: string, clientId: string, clientSecret: string, redirectUri: string)
    : Promise<Omit<DiscordOAuthGrant, "user">> {
  let data = await postForm(TOKEN_URL, new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  }));
  if (!data.access_token) throw new DiscordApiError(500, "Discord did not return an access token.");
  return {
    accessToken: { token: data.access_token, expires: expiryFrom(data.expires_in) },
    refreshToken: data.refresh_token,
    grantedScopes: splitScopes(data.scope),
  };
}

export async function refreshAccessToken(
    refreshToken: string, clientId: string, clientSecret: string)
    : Promise<Omit<DiscordOAuthGrant, "user"> | null> {
  try {
    let data = await postForm(TOKEN_URL, new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }));
    if (!data.access_token) return null;
    return {
      accessToken: { token: data.access_token, expires: expiryFrom(data.expires_in) },
      refreshToken: data.refresh_token ?? refreshToken,
      grantedScopes: splitScopes(data.scope),
    };
  } catch {
    return null;
  }
}

export async function revokeToken(
    token: string, clientId: string, clientSecret: string): Promise<void> {
  try {
    await postForm(REVOKE_URL, new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token,
    }));
  } catch {
    // Revoke is best-effort.
  }
}

function toUser(raw: RawUser): DiscordUser {
  let user: DiscordUser = {
    id: raw.id,
    username: raw.username,
    isBot: !!raw.bot,
  };
  if (raw.global_name) user.displayName = raw.global_name;
  return user;
}

export function channelKind(type: number): DiscordChannelKind {
  switch (type) {
    case 0: return "text";
    case 5: return "announcement";
    case 15: return "forum";
    case 11:
    case 12: return "thread";
    default: return "other";
  }
}

export function isReadableChannelType(type: number): boolean {
  return type === 0 || type === 5;
}

function toChannel(raw: RawChannel, fallbackGuildId: string): DiscordChannelInfo {
  let info: DiscordChannelInfo = {
    id: raw.id,
    guildId: raw.guild_id ?? fallbackGuildId,
    name: raw.name ?? raw.id,
    kind: channelKind(raw.type),
  };
  if (raw.topic) info.topic = raw.topic;
  return info;
}

function toMessage(raw: RawMessage, guildId: string, channelName?: string): DiscordMessage {
  let message: DiscordMessage = {
    id: raw.id,
    author: raw.author ? toUser(raw.author) : null,
    content: raw.content ?? "",
    timestamp: new Date(raw.timestamp),
    channelId: raw.channel_id,
    jumpUrl: discordJumpUrl(guildId, raw.channel_id, raw.id),
  };
  if (channelName) message.channelName = channelName;
  return message;
}

export function accountDescriptionFromProfile(profile: DiscordUserProfile): AccountDescription {
  let avatar = profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/${Number(profile.id) % 6}.png`;
  return {
    displayName: profile.globalName ?? profile.username,
    uniqueName: profile.username,
    avatar: { url: avatar },
  };
}

async function discordFetch(
    path: string, authorization: string, init: RequestInit = {}): Promise<Response> {
  let attempt = 0;
  while (true) {
    let response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: authorization,
        "User-Agent": USER_AGENT,
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
      let retryAfter = Number(response.headers.get("Retry-After") ?? "1");
      await response.body?.cancel().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, Math.min(retryAfter, 10) * 1000));
      attempt++;
      continue;
    }
    return response;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body = await response.text().catch(() => "");
    throw new DiscordApiError(
      response.status,
      `Discord API failed: ${response.status} [http=${response.status}] ${body.slice(0, 200)}`,
    );
  }
  return await response.json<T>();
}

export class DiscordUserApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  async #get<T>(path: string): Promise<T> {
    let token = await this.#getToken();
    return readJson<T>(await discordFetch(path, `Bearer ${token}`));
  }

  async getProfile(): Promise<DiscordUserProfile> {
    let raw = await this.#get<RawUser>("/users/@me");
    let profile: DiscordUserProfile = { id: raw.id, username: raw.username };
    if (raw.global_name) profile.globalName = raw.global_name;
    if (raw.avatar) profile.avatar = raw.avatar;
    return profile;
  }

  async listGuilds(): Promise<DiscordGuildSummary[]> {
    let guilds = await this.#get<RawGuild[]>("/users/@me/guilds?limit=200");
    return guilds.map(guild => {
      let summary: DiscordGuildSummary = { id: guild.id, name: guild.name };
      if (guild.icon) summary.icon = guild.icon;
      return summary;
    });
  }

  async isInGuild(guildId: string): Promise<boolean> {
    let guilds = await this.listGuilds();
    return guilds.some(guild => guild.id === guildId);
  }
}

export class DiscordBotApi {
  #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async #get<T>(path: string): Promise<T> {
    return readJson<T>(await discordFetch(path, `Bot ${this.#token}`));
  }

  async listGuilds(): Promise<DiscordGuildSummary[]> {
    let guilds = await this.#get<RawGuild[]>("/users/@me/guilds?limit=200");
    return guilds.map(guild => {
      let summary: DiscordGuildSummary = { id: guild.id, name: guild.name };
      if (guild.icon) summary.icon = guild.icon;
      return summary;
    });
  }

  async getGuild(guildId: string): Promise<DiscordGuildInfo> {
    let raw = await this.#get<RawGuild>(`/guilds/${guildId}?with_counts=true`);
    let info: DiscordGuildInfo = { id: raw.id, name: raw.name };
    if (raw.approximate_member_count) info.memberCount = raw.approximate_member_count;
    return info;
  }

  async listChannels(guildId: string): Promise<DiscordChannelInfo[]> {
    let raw = await this.#get<RawChannel[]>(`/guilds/${guildId}/channels`);
    return raw.filter(channel => isReadableChannelType(channel.type)).map(channel =>
      toChannel(channel, guildId));
  }

  async getChannel(channelId: string, guildId: string): Promise<DiscordChannelInfo> {
    let raw = await this.#get<RawChannel>(`/channels/${channelId}`);
    if (raw.guild_id && raw.guild_id !== guildId) {
      throw new DiscordApiError(404, "That channel is not in the connected Discord server.");
    }
    if (!isReadableChannelType(raw.type)) {
      throw new DiscordApiError(400, "That Discord channel is not a text channel this binding can read.");
    }
    return toChannel(raw, guildId);
  }

  async listMessages(
      channelId: string, guildId: string, channelName: string | undefined,
      before?: string, limit = 50): Promise<DiscordPage<DiscordMessage>> {
    let path = `/channels/${channelId}/messages?limit=${limit}`;
    if (before) path += `&before=${before}`;
    let raw = await this.#get<RawMessage[]>(path);
    let items = raw.map(message => toMessage(message, guildId, channelName));
    let nextCursor = items.length === limit ? items[items.length - 1]?.id : undefined;
    return { items, nextCursor };
  }

  async hasMember(guildId: string, userId: string): Promise<boolean> {
    try {
      await this.#get(`/guilds/${guildId}/members/${userId}`);
      return true;
    } catch (error) {
      if (error instanceof DiscordApiError &&
          (error.status === 404 || error.status === 403 || error.status === 401)) {
        return false;
      }
      throw error;
    }
  }
}

export function requireBotToken(env: { BOT_TOKEN?: string }): string {
  if (!env.BOT_TOKEN) {
    throw new Error("The Discord gatekeeper is missing BOT_TOKEN.");
  }
  return env.BOT_TOKEN;
}
