import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ChannelConfiguratorRpc, ChannelConfiguratorValues,
} from "./channel-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.guildId === "string" && values.guildId.length > 0 &&
      typeof values.channelId === "string" && values.channelId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://discord.com/channels/${encodeURIComponent(values.guildId ?? "")}` +
      `/${encodeURIComponent(values.channelId ?? "")}`;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const guildId = segments[1];
    const channelId = segments[2];
    return {
      ...(guildId ? { guildId } : {}),
      ...(channelId ? { channelId } : {}),
    };
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Server" description="The Discord server that contains the channel.">
        <Autocomplete
          name="guildId"
          value={values.guildId}
          placeholder="Search servers..."
          loadOptions={query => ui.listGuilds(query)}
          onChange={guildId => setValues({ guildId, channelId: null })}
        />
      </Field>
      <Field label="Channel" description="Choose a text channel the bot can read.">
        <Autocomplete
          name="channelId"
          value={values.channelId}
          placeholder="Search channels..."
          loadOptions={query => values.guildId ? ui.listChannels(values.guildId, query) : Promise.resolve([])}
          onChange={channelId => setValues({ channelId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ChannelConfiguratorRpc, ChannelConfiguratorValues>;
