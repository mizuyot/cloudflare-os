import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  discordChannelUrl, discordFtsQuery, discordGuildUrl, discordJumpUrl,
  parseDiscordResourceUrl, validateDiscordSearchQuery,
} from "../src/discord-url.ts";

describe("parseDiscordResourceUrl", () => {
  it("reads a server URL", () => {
    assert.deepEqual(
      parseDiscordResourceUrl("https://discord.com/channels/111"),
      { guildId: "111" },
    );
  });

  it("reads a channel URL", () => {
    assert.deepEqual(
      parseDiscordResourceUrl("https://discord.com/channels/111/222"),
      { guildId: "111", channelId: "222" },
    );
  });

  it("rejects non-Discord URLs", () => {
    assert.equal(parseDiscordResourceUrl("https://slack.com/channels/111"), null);
    assert.equal(parseDiscordResourceUrl("https://discord.com/invite/abc"), null);
  });
});

describe("discord URLs", () => {
  it("builds canonical links", () => {
    assert.equal(discordGuildUrl("1"), "https://discord.com/channels/1");
    assert.equal(discordChannelUrl("1", "2"), "https://discord.com/channels/1/2");
    assert.equal(discordJumpUrl("1", "2", "3"), "https://discord.com/channels/1/2/3");
  });
});

describe("search query", () => {
  it("quotes each token for FTS5", () => {
    assert.equal(discordFtsQuery("渋谷 人件費"), '"渋谷" AND "人件費"');
  });

  it("rejects empty queries", () => {
    assert.throws(() => validateDiscordSearchQuery("   "), /empty/);
    assert.throws(() => discordFtsQuery(""), /empty/);
  });
});
