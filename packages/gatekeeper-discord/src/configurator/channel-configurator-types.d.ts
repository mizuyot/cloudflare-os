export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type ChannelConfiguratorValues = {
  guildId?: string | null;
  channelId?: string | null;
};

export interface ChannelConfiguratorRpc {
  listGuilds(query: string): Promise<ConfiguratorOption[]>;
  listChannels(guildId: string, query: string): Promise<ConfiguratorOption[]>;
}
