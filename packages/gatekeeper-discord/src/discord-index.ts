import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { DiscordBotApi, requireBotToken } from "./discord-api";
import { discordFtsQuery } from "./discord-url";
import { obsContext } from "./observability.js";
import type { DiscordMessage } from "./types";

const VENDOR_ID = "discord";
const logger = obsContext.createLogger({
  component: "gatekeeper.discord.index", vendorId: VENDOR_ID,
});

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const BACKFILL_BATCH_CHANNELS = 4;
const MESSAGE_PAGE = 100;
const SEARCH_LIMIT = 30;

type Env = Cloudflare.Env & {
  BOT_TOKEN?: string;
};

type DiscordGuildIndexProps = {
  guildId: string;
};

function schema(sql: DurableObject["ctx"]["storage"]["sql"]): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      jump_url TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_channel_time ON messages(channel_id, timestamp DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, author_name, channel_name, tokenize = 'unicode61'
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      newest_id TEXT,
      oldest_id TEXT,
      backfill_done INTEGER NOT NULL DEFAULT 0
    );
  `);
}

@validateRpc()
export class DiscordGuildIndex extends DurableObject<Env, DiscordGuildIndexProps> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    schema(ctx.storage.sql);
  }

  #bot(): DiscordBotApi {
    return new DiscordBotApi(requireBotToken(this.env));
  }

  async kick(guildId: string): Promise<void> {
    this.ctx.storage.kv.put("guildId", guildId);
    let alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  #guildId(): string {
    return this.ctx.storage.kv.get<string>("guildId") ?? this.ctx.props.guildId;
  }

  async alarm(): Promise<void> {
    try {
      await this.#sync();
    } catch (error) {
      logger.warn("discord index sync failed", {
        event: "discord.index.sync.failed",
        guildId: this.#guildId(),
        error,
      });
    }
    await this.ctx.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
  }

  async search(query: string, channelId?: string): Promise<DiscordMessage[]> {
    let match = discordFtsQuery(query);
    let rows = channelId
      ? this.ctx.storage.sql.exec(
          `SELECT m.id, m.channel_id, m.channel_name, m.author_id, m.author_name, m.content,
                  m.timestamp, m.jump_url
           FROM messages m
           JOIN messages_fts f ON f.rowid = m.rowid
           WHERE messages_fts MATCH ? AND m.channel_id = ?
           ORDER BY m.timestamp DESC
           LIMIT ?`,
          match, channelId, SEARCH_LIMIT,
        )
      : this.ctx.storage.sql.exec(
          `SELECT m.id, m.channel_id, m.channel_name, m.author_id, m.author_name, m.content,
                  m.timestamp, m.jump_url
           FROM messages m
           JOIN messages_fts f ON f.rowid = m.rowid
           WHERE messages_fts MATCH ?
           ORDER BY m.timestamp DESC
           LIMIT ?`,
          match, SEARCH_LIMIT,
        );
    return [...rows].map(row => this.#toMessage(row as Record<string, unknown>));
  }

  async #sync(): Promise<void> {
    let guildId = this.#guildId();
    let bot = this.#bot();
    let channels = await bot.listChannels(guildId);
    for (let channel of channels) {
      this.ctx.storage.sql.exec(
        `INSERT INTO channels (id, name, newest_id, oldest_id, backfill_done)
         VALUES (?, ?, NULL, NULL, 0)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
        channel.id, channel.name,
      );
    }

    for (let channel of channels) {
      await this.#pullNew(bot, channel.id, channel.name);
    }

    let pending = [...this.ctx.storage.sql.exec(
      `SELECT id, name, oldest_id FROM channels WHERE backfill_done = 0 LIMIT ?`,
      BACKFILL_BATCH_CHANNELS,
    )];
    for (let row of pending) {
      await this.#backfill(
        bot,
        String(row.id),
        String(row.name),
        row.oldest_id ? String(row.oldest_id) : undefined,
      );
    }
  }

  async #pullNew(bot: DiscordBotApi, channelId: string, channelName: string): Promise<void> {
    let newest = this.ctx.storage.sql.exec(
      `SELECT newest_id FROM channels WHERE id = ?`, channelId,
    ).one();
    let after = newest?.newest_id ? String(newest.newest_id) : undefined;
      let page = await bot.listMessages(channelId, this.#guildId(), channelName, undefined);
    let added = 0;
    for (let message of page.items) {
      if (after && message.id <= after) continue;
      if (this.#upsert(message, channelName)) added++;
    }
    if (page.items[0]) {
      this.ctx.storage.sql.exec(
        `UPDATE channels SET newest_id = ? WHERE id = ? AND (newest_id IS NULL OR newest_id < ?)`,
        page.items[0].id, channelId, page.items[0].id,
      );
    }
    if (!after && page.items.length > 0) {
      let oldest = page.items[page.items.length - 1]!;
      this.ctx.storage.sql.exec(
        `UPDATE channels SET oldest_id = COALESCE(oldest_id, ?) WHERE id = ?`,
        oldest.id, channelId,
      );
    }
    if (added === 0 && after) return;
  }

  async #backfill(
      bot: DiscordBotApi, channelId: string, channelName: string, before?: string): Promise<void> {
    let page = await bot.listMessages(
      channelId, this.#guildId(), channelName, before, MESSAGE_PAGE,
    );
    if (page.items.length === 0) {
      this.ctx.storage.sql.exec(`UPDATE channels SET backfill_done = 1 WHERE id = ?`, channelId);
      return;
    }
    for (let message of page.items) this.#upsert(message, channelName);
    let oldest = page.items[page.items.length - 1]!;
    this.ctx.storage.sql.exec(
      `UPDATE channels SET oldest_id = ? WHERE id = ?`, oldest.id, channelId,
    );
    if (!page.nextCursor) {
      this.ctx.storage.sql.exec(`UPDATE channels SET backfill_done = 1 WHERE id = ?`, channelId);
    }
  }

  #upsert(message: DiscordMessage, channelName: string): boolean {
    let existing = this.ctx.storage.sql.exec(
      `SELECT rowid FROM messages WHERE id = ?`, message.id,
    ).toArray();
    if (existing.length > 0) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO messages
        (id, channel_id, channel_name, author_id, author_name, content, timestamp, jump_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id,
      message.channelId,
      channelName,
      message.author?.id ?? "",
      message.author?.displayName ?? message.author?.username ?? "",
      message.content,
      message.timestamp.valueOf(),
      message.jumpUrl,
    );
    let row = this.ctx.storage.sql.exec(
      `SELECT rowid FROM messages WHERE id = ?`, message.id,
    ).one();
    if (row) {
      this.ctx.storage.sql.exec(
        `INSERT INTO messages_fts (rowid, content, author_name, channel_name) VALUES (?, ?, ?, ?)`,
        row.rowid,
        message.content,
        message.author?.displayName ?? message.author?.username ?? "",
        channelName,
      );
    }
    return true;
  }

  #toMessage(row: Record<string, unknown>): DiscordMessage {
    return {
      id: String(row.id),
      author: row.author_id
        ? {
            id: String(row.author_id),
            username: String(row.author_name ?? ""),
            displayName: String(row.author_name ?? ""),
            isBot: false,
          }
        : null,
      content: String(row.content ?? ""),
      timestamp: new Date(Number(row.timestamp)),
      channelId: String(row.channel_id),
      channelName: String(row.channel_name),
      jumpUrl: String(row.jump_url),
    };
  }
}

