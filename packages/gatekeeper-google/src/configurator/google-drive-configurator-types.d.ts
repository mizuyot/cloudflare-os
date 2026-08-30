export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type GoogleDriveConfiguratorValues = {
  folderId?: string | null;
}

export interface GoogleDriveConfiguratorRpc {
  listFolders(query: string): Promise<ConfiguratorOption[]>;
}
