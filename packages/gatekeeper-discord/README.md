# Discord gatekeeper

Mediates a Gadget's **read-only** access to Discord servers the connecting user belongs to:
channels, recent messages, and search of messages the bot has indexed. Runs as its own
Cloudflare Worker and is auto-discovered from its `GATEKEEPER_DISCORD` binding.

This gatekeeper is read-only and never sends or modifies Discord data.

## Auth

Two credentials work together:

- **User OAuth** (`identify`, `guilds`) so the agent only searches servers the connecting user is in.
- **Bot token** (`BOT_TOKEN`) so the worker can read channel history and keep a searchable index.
  Discord has no Slack-style official message search API.

Create a Discord application (https://discord.com/developers/applications) with a bot user.
Provide `CLIENT_ID`, `CLIENT_SECRET`, and `BOT_TOKEN` to the worker. For local dev,
`run-dev-server.js` maps `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `DISCORD_BOT_TOKEN`.

App configuration:

- **Redirect URL** must match `<BASE_URL>/oauth`, which in local dev defaults to
  `http://localhost:8787/gatekeeper/discord/oauth`.
- Enable the **Message Content Intent**.
- Invite the bot to each server with **View Channel** and **Read Message History**.
- Private channels are readable only after the bot is added to them.

## Resources

| Granularity | URL pattern | Session type |
| --- | --- | --- |
| A server | `https://discord.com/channels/:guildId` | `DiscordGuildSession` |
| A channel | `https://discord.com/channels/:guildId/:channelId` | `DiscordChannel` |

## API

See `src/types.d.ts` for the agent-facing Session API. Highlights:

- `DiscordGuildSession`: `getInfo`, `listChannels`, `search`, `getChannel`
- `DiscordChannel`: `getInfo`, `listMessages`, `search` (always limited to that channel)

`search` reads the per-server index (SQLite FTS). The index backfills history and then polls
for new messages. Recent `listMessages` calls go to Discord directly.

## Build

```
pnpm --filter @gadgets/discord-gatekeeper build
```
