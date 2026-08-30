export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type GuildConfiguratorValues = {
  guildId?: string | null;
};

export interface GuildConfiguratorRpc {
  listGuilds(query: string): Promise<ConfiguratorOption[]>;
}
