import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { DiscordBotApi, DiscordUserApi } from "./discord-api";
import type { ChannelConfiguratorRpc, ConfiguratorOption } from "./configurator/channel-configurator-types";
import type { GuildConfiguratorRpc } from "./configurator/guild-configurator-types";

const userApiByTarget = new WeakMap<object, DiscordUserApi>();
const botApiByTarget = new WeakMap<object, DiscordBotApi>();

function optionMatches(parts: (string | undefined)[], query: string): boolean {
  let lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return true;
  let corpus = parts.filter(Boolean).join(" ").toLowerCase();
  return lowerQuery.split(/\s+/).every(term => corpus.includes(term));
}

export async function listSharedGuildOptions(
  userApi: DiscordUserApi,
  botApi: DiscordBotApi,
): Promise<ConfiguratorOption[]> {
  let botGuilds = await botApi.listGuilds();
  let userGuilds: Awaited<ReturnType<DiscordUserApi["listGuilds"]>> = [];
  try {
    userGuilds = await userApi.listGuilds();
  } catch {
    // User guild listing is best-effort; the bot's membership is the source of readable servers.
  }
  let botIds = new Set(botGuilds.map(guild => guild.id));
  let shared = userGuilds.filter(guild => botIds.has(guild.id));
  let source = shared.length > 0 ? shared : botGuilds;
  return source.map(guild => ({ value: guild.id, title: guild.name, subtitle: guild.id }));
}

async function sharedGuilds(target: object): Promise<ConfiguratorOption[]> {
  let userApi = userApiByTarget.get(target);
  let botApi = botApiByTarget.get(target);
  if (!userApi || !botApi) throw new Error("Discord configurator is not initialized.");
  return listSharedGuildOptions(userApi, botApi);
}

@validateRpc()
export class GuildConfiguratorUI extends RpcTarget implements GuildConfiguratorRpc {
  constructor(userApi: DiscordUserApi, botApi: DiscordBotApi) {
    super();
    userApiByTarget.set(this, userApi);
    botApiByTarget.set(this, botApi);
  }

  async listGuilds(query: string): Promise<ConfiguratorOption[]> {
    return (await sharedGuilds(this))
      .filter(option => optionMatches([option.title, option.subtitle], query));
  }
}

@validateRpc()
export class ChannelConfiguratorUI extends RpcTarget implements ChannelConfiguratorRpc {
  constructor(userApi: DiscordUserApi, botApi: DiscordBotApi) {
    super();
    userApiByTarget.set(this, userApi);
    botApiByTarget.set(this, botApi);
  }

  async listGuilds(query: string): Promise<ConfiguratorOption[]> {
    return (await sharedGuilds(this))
      .filter(option => optionMatches([option.title, option.subtitle], query));
  }

  async listChannels(guildId: string, query: string): Promise<ConfiguratorOption[]> {
    let botApi = botApiByTarget.get(this);
    if (!botApi) throw new Error("Discord configurator is not initialized.");
    let channels = await botApi.listChannels(guildId);
    return channels
      .map(channel => ({
        value: channel.id,
        title: `#${channel.name}`,
        subtitle: channel.kind,
      }))
      .filter(option => optionMatches([option.title, option.subtitle], query));
  }
}
