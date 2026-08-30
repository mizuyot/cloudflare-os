import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { ConfiguratorOption, GuildConfiguratorRpc, GuildConfiguratorValues } from "./guild-configurator-types";

function preloadedGuildCards(): Array<{ value: string; title: string; description: string }> {
  let raw = (globalThis as unknown as { __DISCORD_GUILD_OPTIONS__?: unknown }).__DISCORD_GUILD_OPTIONS__;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    let option = entry as ConfiguratorOption;
    if (typeof option.value !== "string" || typeof option.title !== "string") return [];
    return [{
      value: option.value,
      title: option.title,
      description: typeof option.subtitle === "string" ? option.subtitle : "",
    }];
  });
}

const preloaded = preloadedGuildCards();

export default {
  initial: preloaded.length === 1 ? { guildId: preloaded[0].value } : {},

  isReady({ values }) {
    return typeof values.guildId === "string" && values.guildId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://discord.com/channels/${encodeURIComponent(values.guildId ?? "")}`;
  },

  render({ values, setValues }) {
    if (preloaded.length === 1 && values.guildId !== preloaded[0].value) {
      queueMicrotask(() => setValues({ guildId: preloaded[0].value }));
    }

    if (preloaded.length <= 1) {
      return <Section>
        <Field label="Server">
          <p className="checkbox-empty">
            {preloaded.length === 0
              ? "No Discord servers found. Make sure the bot is in the server."
              : preloaded[0].title}
          </p>
        </Field>
      </Section>;
    }

    return <Section>
      <Field
        label="Server"
        description="Choose a Discord server the bot can read."
      >
        <RadioCards
          value={values.guildId}
          options={preloaded}
          onChange={guildId => setValues({ guildId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GuildConfiguratorRpc, GuildConfiguratorValues>;
