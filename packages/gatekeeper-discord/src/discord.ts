import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperUser, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription,
  ApprovalQueue, VendorDescription, GatekeeperConnectCallback, GatekeeperConnectOptions,
  AccountDescription, SupportedResource, ResourceConfiguratorFrame, ActionKind, Cursor,
  GatekeeperUserVerifier, ObservationDescription, stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  accountDescriptionFromProfile, DiscordAccessToken, DiscordBotApi, DiscordUserApi,
  exchangeAuthCode, refreshAccessToken, requireBotToken, revokeToken,
} from "./discord-api";
import {
  DiscordChannel, DiscordChannelEntry, DiscordChannelInfo, DiscordGuildInfo,
  DiscordGuildSession, DiscordMessageEntry,
} from "./types";
import { ChannelConfiguratorUI, GuildConfiguratorUI, listSharedGuildOptions } from "./discord-configurators";
import type { ConfiguratorOption } from "./configurator/guild-configurator-types";
import { DiscordGuildIndex } from "./discord-index";
import {
  discordChannelUrl, discordGuildUrl, parseDiscordResourceUrl, validateDiscordSearchQuery,
} from "./discord-url";
import TYPES_CODE from "./types.txt";
import GUILD_CONFIGURATOR_HTML from "./generated/guild-configurator-ui.txt";
import CHANNEL_CONFIGURATOR_HTML from "./generated/channel-configurator-ui.txt";
import DISCORD_LOGO_SVG from "./discord-logo.svg";
import { obsContext } from "./observability.js";

export { DiscordGuildIndex };

const VENDOR_ID = "discord";
const logger = obsContext.createLogger({
  component: "gatekeeper.discord", vendorId: VENDOR_ID,
});

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 5 * 60 * 1000;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  let encoder = new TextEncoder();
  let bufA = encoder.encode(a);
  let bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  BOT_TOKEN?: string;
};

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/discord");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// Bake the server list into the iframe HTML so the picker does not have to RPC for it.
function embedGuildOptions(html: string, options: ConfiguratorOption[]): string {
  let json = JSON.stringify(options).replace(/</g, "\\u003c");
  let snippet = `<script>globalThis.__DISCORD_GUILD_OPTIONS__=${json};</script>`;
  return html.includes("<head>") ? html.replace("<head>", `<head>${snippet}`) : snippet + html;
}

const GUILD_RESOURCE: SupportedResource = {
  urlPattern: "https://discord.com/channels/:guildId",
  title: "Discord Server",
  description: "Search and read messages the bot can see in a Discord server you belong to.",
  grantable: true,
};

const CHANNEL_RESOURCE: SupportedResource = {
  urlPattern: "https://discord.com/channels/:guildId/:channelId",
  title: "Discord Channel",
  description: "Search and read messages in a single Discord channel.",
  grantable: true,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [GUILD_RESOURCE, CHANNEL_RESOURCE];
const OAUTH_SCOPES = ["identify", "guilds"];
const DISCORD_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(DISCORD_LOGO_SVG)}`;

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #5865F2; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #5865F2; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #5865F2; font-size: 1.5rem; margin: 0 0 1rem 0;">Discord Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please configure CLIENT_ID, CLIENT_SECRET, and BOT_TOKEN so this Cloudflare OS instance can read Discord.</p>
    </div>
  </body>
</html>`;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML,
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      let doId = path[0];
      let initiationNonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      let begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML,
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      let authUrl = new URL("https://discord.com/oauth2/authorize");
      authUrl.searchParams.set("client_id", env.CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", begun.scopes.join(" "));
      authUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      return Response.redirect(authUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      let error = url.searchParams.get("error");
      if (error) return new Response(`Discord authorization failed: ${error}`);
      let state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      let colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      let doId = state.slice(0, colonIdx);
      let oauthNonce = state.slice(colonIdx + 1);
      let code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML,
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(SELF_CLOSING_HTML,
          { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Discord",
      url: "https://discord.com",
      logo: { url: DISCORD_LOGO_URL },
      color: "#eef0ff",
      tagline: "Search servers and past conversations",
      description:
          "Connect your Discord account to give Cloudflare OS read-only access to servers you " +
          "are in and a bot can read. Build agents that find past conversations and cite the " +
          "original messages.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, OAUTH_SCOPES);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  #credentialUpdate: Promise<void> = Promise.resolve();

  async #updateCredentials<T>(operation: () => Promise<T>): Promise<T> {
    let previous = this.#credentialUpdate;
    let release!: () => void;
    this.#credentialUpdate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async setCallback(
      callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
      requestedScopes: string[]) {
    if (!this.ctx.storage.kv.get<DiscordAccessToken>("accessToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string, requestedScopes: string[]) {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    return SUPPORTED_RESOURCES.map(resource => resource.urlPattern);
  }

  async beginOAuthFlow(initiationNonce: string)
      : Promise<{ oauthNonce: string; scopes: string[] } | null> {
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    let oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    let scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? OAUTH_SCOPES;
    return { oauthNonce, scopes };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    let completion = await this.#updateCredentials(async () => {
      if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
        throw new Error("The Discord Gatekeeper is not configured.");
      }
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) {
        throw new Error("Took too long to complete the authorization. Please try again.");
      }
      let grant = await exchangeAuthCode(
          code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env) + "/oauth");
      let profile = await new DiscordUserApi(async () => grant.accessToken.token).getProfile();
      this.ctx.storage.kv.put<DiscordAccessToken>("accessToken", grant.accessToken);
      if (grant.refreshToken) this.ctx.storage.kv.put<string>("refreshToken", grant.refreshToken);
      this.ctx.storage.kv.put<string[]>("grantedScopes", grant.grantedScopes);
      this.ctx.storage.kv.put<string>("userId", profile.id);
      this.ctx.storage.kv.delete("requestedScopes");
      let reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
      if (reconnecting) this.ctx.storage.kv.delete("reconnecting");
      return { callback, grant, reconnecting: !!reconnecting };
    });

    if (completion.reconnecting) {
      await completion.callback.credentialsRestored(completion.grant.accessToken.expires);
    } else {
      try {
        let props: DiscordUserImplProps = { userObjectId: this.ctx.id.toString() };
        await completion.callback.complete(
            this.ctx.exports.DiscordUserImpl({ props }), completion.grant.accessToken.expires);
      } catch (err) {
        await this.#updateCredentials(async () => {
          let storedToken = this.ctx.storage.kv.get<DiscordAccessToken>("accessToken");
          if (storedToken?.token === completion.grant.accessToken.token) {
            this.ctx.storage.kv.delete("accessToken");
            this.ctx.storage.kv.delete("refreshToken");
          }
        });
        throw err;
      }
    }
    return true;
  }

  async getUserId(): Promise<string> {
    return this.ctx.storage.kv.get<string>("userId") ?? "";
  }

  async getAccessToken(): Promise<DiscordAccessToken> {
    return this.#updateCredentials(() => this.#getAccessTokenLocked());
  }

  async #getAccessTokenLocked(): Promise<DiscordAccessToken> {
    let cached = this.ctx.storage.kv.get<DiscordAccessToken>("accessToken");
    if (!cached) throw new Error("No Discord credentials set.");
    let expires = new Date(cached.expires);
    if (expires.valueOf() > Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
      return { token: cached.token, expires };
    }
    let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) return { token: cached.token, expires };
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Discord Gatekeeper is not configured.");
    }
    let result = await refreshAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
    if (result === null) {
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      callback?.credentialsExpired().catch(err =>
          logger.warn("failed to notify credential expiry", {
            event: "credentials.expiry.notify.failed", error: err,
          }));
      throw new Error("Discord credentials have expired or been revoked. Please re-authenticate.");
    }
    this.ctx.storage.kv.put<DiscordAccessToken>("accessToken", result.accessToken);
    if (result.refreshToken) this.ctx.storage.kv.put<string>("refreshToken", result.refreshToken);
    if (result.grantedScopes.length > 0) {
      this.ctx.storage.kv.put<string[]>("grantedScopes", result.grantedScopes);
    }
    return result.accessToken;
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<DiscordAccessToken>("accessToken")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.#updateCredentials(async () => {
      let cached = this.ctx.storage.kv.get<DiscordAccessToken>("accessToken");
      let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (this.env.CLIENT_ID && this.env.CLIENT_SECRET) {
        if (refreshToken) await revokeToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
        if (cached) await revokeToken(cached.token, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
      }
      this.ctx.storage.deleteAlarm();
      this.ctx.storage.deleteAll();
    });
  }
}

function createAccessTokenGetter(
    getStub: () => DurableObjectStub<UserAccount>): () => Promise<string> {
  let cached: DiscordAccessToken | undefined;
  return async () => {
    if (!cached || cached.expires.valueOf() < Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
      cached = await getStub().getAccessToken();
    }
    return cached.token;
  };
}

type DiscordUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class DiscordUserImpl extends WorkerEntrypoint<Env, DiscordUserImplProps>
    implements GatekeeperUser {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #userApi(): DiscordUserApi {
    return new DiscordUserApi(createAccessTokenGetter(() => this.#account()));
  }

  #botApi(): DiscordBotApi {
    return new DiscordBotApi(requireBotToken(this.env));
  }

  async describe(): Promise<AccountDescription> {
    let profile = await this.#userApi().getProfile();
    let description = accountDescriptionFromProfile(profile);
    description.grantedResourceUrlPatterns = await this.#account().getGrantedResourceUrlPatterns();
    return description;
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let parsed = parseDiscordResourceUrl(url);
    if (!parsed) throw new Error(`Unsupported Discord resource URL: ${url}`);
    if (parsed.channelId) {
      let props: DiscordChannelGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        guildId: parsed.guildId,
        channelId: parsed.channelId,
      };
      return {
        class: this.ctx.exports.DiscordChannelGatekeeperImpl({ props }),
        resource: CHANNEL_RESOURCE,
      };
    }
    let props: DiscordGuildGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      guildId: parsed.guildId,
    };
    return {
      class: this.ctx.exports.DiscordGuildGatekeeperImpl({ props }),
      resource: GUILD_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let userApi = this.#userApi();
    let botApi = this.#botApi();
    if (resourceUrlPattern === GUILD_RESOURCE.urlPattern) {
      let options: ConfiguratorOption[] = [];
      try {
        options = await listSharedGuildOptions(userApi, botApi);
      } catch (error) {
        logger.warn("failed to list Discord guilds for configurator", {
          event: "configurator.guilds.list.failed",
          error,
        });
      }
      return {
        iframeHtml: embedGuildOptions(GUILD_CONFIGURATOR_HTML, options),
        ui: new RpcStub(new GuildConfiguratorUI(userApi, botApi)),
      };
    }
    if (resourceUrlPattern === CHANNEL_RESOURCE.urlPattern) {
      return {
        iframeHtml: CHANNEL_CONFIGURATOR_HTML,
        ui: new RpcStub(new ChannelConfiguratorUI(userApi, botApi)),
      };
    }
    throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
  }

  async reconnect(): Promise<{ url: string }> {
    let initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce, OAUTH_SCOPES);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: DiscordVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.DiscordVerifier({ props });
  }
}

type DiscordVerifierProps = {
  userObjectId: string;
};

export interface DiscordVerifierApi extends GatekeeperUserVerifier {
  hasGuildAccess(guildId: string): Promise<boolean>;
}

@validateRpc()
export class DiscordVerifier extends WorkerEntrypoint<Env, DiscordVerifierProps>
    implements DiscordVerifierApi {
  async hasGuildAccess(guildId: string): Promise<boolean> {
    let account = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    let userApi = new DiscordUserApi(async () => (await account.getAccessToken()).token);
    try {
      return await userApi.isInGuild(guildId);
    } catch (error) {
      let status = error instanceof Error
          ? Number((error.message.match(/\[http=(\d{3})\]/) ?? [])[1])
          : undefined;
      if (status === 401 || status === 403 || status === 404) return false;
      throw error;
    }
  }
}

const NO_ACTIONS: ActionKind[] = [];

function unreachableAction(): never {
  throw new Error("Discord gatekeeper is read-only and submits no actions.");
}

type DiscordSessionContext = {
  approvalQueue: RpcStub<ApprovalQueue>;
  bot: DiscordBotApi;
  index: DurableObjectStub<DiscordGuildIndex>;
  guildId: string;
};

function dupCtx(ctx: DiscordSessionContext): DiscordSessionContext {
  return {
    approvalQueue: ctx.approvalQueue.dup(),
    bot: ctx.bot,
    index: ctx.index,
    guildId: ctx.guildId,
  };
}

class DiscordCursor<T> extends RpcTarget implements Cursor<T> {
  #ctx: DiscordSessionContext;
  #loadPage: (
    ctx: DiscordSessionContext, cursor: string | undefined,
  ) => Promise<{ items: T[]; nextCursor?: string; observation: ObservationDescription }>;
  #cursor: string | undefined;
  #exhausted = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(
      ctx: DiscordSessionContext,
      loadPage: (
        ctx: DiscordSessionContext, cursor: string | undefined,
      ) => Promise<{ items: T[]; nextCursor?: string; observation: ObservationDescription }>) {
    super();
    this.#ctx = dupCtx(ctx);
    this.#loadPage = loadPage;
  }

  [Symbol.dispose]() {
    this.#ctx.approvalQueue[Symbol.dispose]();
  }

  next(): Promise<T[] | null> {
    let result = this.#tail.then(() => this.#nextPage());
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #nextPage(): Promise<T[] | null> {
    while (!this.#exhausted) {
      let page = await this.#loadPage(this.#ctx, this.#cursor);
      this.#cursor = page.nextCursor;
      this.#exhausted = !page.nextCursor;
      if (page.items.length === 0) continue;
      await this.#ctx.approvalQueue.authorizeObservation(page.observation);
      return page.items;
    }
    return null;
  }
}

type DiscordGuildGatekeeperImplProps = {
  userObjectId: string;
  guildId: string;
};

@validateRpc()
export class DiscordGuildGatekeeperImpl
    extends DurableObject<Env, DiscordGuildGatekeeperImplProps>
    implements Gatekeeper<DiscordGuildSession> {
  #index(): DurableObjectStub<DiscordGuildIndex> {
    return this.ctx.exports.DiscordGuildIndex.getByName(this.ctx.props.guildId);
  }

  #bot(): DiscordBotApi {
    return new DiscordBotApi(requireBotToken(this.env));
  }

  async describe(): Promise<ResourceDescription> {
    let guild = await this.#bot().getGuild(this.ctx.props.guildId);
    return {
      url: discordGuildUrl(this.ctx.props.guildId),
      title: guild.name,
      snippet: `Discord server: ${guild.name} (read-only)`,
      suggestedBindingName: "DISCORD_SERVER",
      tsType: "DiscordGuildSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return NO_ACTIONS;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<DiscordGuildSession> {
    await this.#index().kick(this.ctx.props.guildId);
    return new DiscordGuildSessionImpl({
      approvalQueue: approvalQueue.dup(),
      bot: this.#bot(),
      index: this.#index(),
      guildId: this.ctx.props.guildId,
    });
  }

  async applyAction(_action: number): Promise<void> { unreachableAction(); }
  async rejectAction(_action: number): Promise<void> { unreachableAction(); }
  revertAction(_action: number): Promise<void> { unreachableAction(); }

  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<DiscordVerifierApi>;
    if (!(await verifier.hasGuildAccess(this.ctx.props.guildId))) {
      throw new Error(
        "This collaborator is not a member of the bound Discord server, so they cannot observe " +
        "data this workspace read from it.",
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

type DiscordChannelGatekeeperImplProps = {
  userObjectId: string;
  guildId: string;
  channelId: string;
};

@validateRpc()
export class DiscordChannelGatekeeperImpl
    extends DurableObject<Env, DiscordChannelGatekeeperImplProps>
    implements Gatekeeper<DiscordChannel> {
  #index(): DurableObjectStub<DiscordGuildIndex> {
    return this.ctx.exports.DiscordGuildIndex.getByName(this.ctx.props.guildId);
  }

  #bot(): DiscordBotApi {
    return new DiscordBotApi(requireBotToken(this.env));
  }

  async describe(): Promise<ResourceDescription> {
    let channel = await this.#bot().getChannel(this.ctx.props.channelId, this.ctx.props.guildId);
    return {
      url: discordChannelUrl(this.ctx.props.guildId, this.ctx.props.channelId),
      title: `#${channel.name}`,
      snippet: `Discord channel: #${channel.name} (read-only)`,
      suggestedBindingName: "DISCORD_CHANNEL",
      tsType: "DiscordChannel",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return NO_ACTIONS;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<DiscordChannel> {
    await this.#index().kick(this.ctx.props.guildId);
    let info = await this.#bot().getChannel(this.ctx.props.channelId, this.ctx.props.guildId);
    return new DiscordChannelImpl({
      approvalQueue: approvalQueue.dup(),
      bot: this.#bot(),
      index: this.#index(),
      guildId: this.ctx.props.guildId,
    }, info);
  }

  async applyAction(_action: number): Promise<void> { unreachableAction(); }
  async rejectAction(_action: number): Promise<void> { unreachableAction(); }
  revertAction(_action: number): Promise<void> { unreachableAction(); }

  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<DiscordVerifierApi>;
    if (!(await verifier.hasGuildAccess(this.ctx.props.guildId))) {
      throw new Error(
        "This collaborator is not a member of the Discord server that contains this channel, " +
        "so they cannot observe data this workspace read from it.",
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
class DiscordGuildSessionImpl extends RpcTarget implements DiscordGuildSession {
  #ctx: DiscordSessionContext;

  constructor(ctx: DiscordSessionContext) {
    super();
    this.#ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.#ctx.approvalQueue[Symbol.dispose]();
  }

  async getInfo(): Promise<DiscordGuildInfo> {
    let info = await this.#ctx.bot.getGuild(this.#ctx.guildId);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read Discord server ${info.name}`,
      description: `Read metadata for Discord server "${info.name}".`,
    });
    return info;
  }

  async listChannels(): Promise<Cursor<DiscordChannelEntry>> {
    let channels = await this.#ctx.bot.listChannels(this.#ctx.guildId);
    let sent = false;
    return new DiscordCursor(this.#ctx, async ctx => {
      if (sent) return { items: [], observation: { title: "", description: "" } };
      sent = true;
      let items = channels.map(info => ({
        info,
        channel: new DiscordChannelImpl(dupCtx(ctx), info),
      }));
      return {
        items,
        observation: {
          title: "List Discord channels",
          description: `Listed ${items.length} readable channel(s) in the connected Discord server.`,
        },
      };
    });
  }

  async search(query: string): Promise<Cursor<DiscordMessageEntry>> {
    validateDiscordSearchQuery(query);
    let messages = await this.#ctx.index.search(query);
    let sent = false;
    return new DiscordCursor(this.#ctx, async () => {
      if (sent) return { items: [], observation: { title: "", description: "" } };
      sent = true;
      return {
        items: messages.map(message => ({ message })),
        observation: {
          title: `Discord search: ${query}`,
          description:
            `Searched the connected Discord server for "${query}". Returned ${messages.length} ` +
            "message(s).",
        },
      };
    });
  }

  async getChannel(channelId: string): Promise<DiscordChannel> {
    let info = await this.#ctx.bot.getChannel(channelId, this.#ctx.guildId);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open Discord channel #${info.name}`,
      description: `Opened #${info.name} in the connected Discord server.`,
    });
    return new DiscordChannelImpl(dupCtx(this.#ctx), info);
  }
}

@validateRpc()
class DiscordChannelImpl extends RpcTarget implements DiscordChannel {
  #ctx: DiscordSessionContext;
  #info: DiscordChannelInfo;

  constructor(ctx: DiscordSessionContext, info: DiscordChannelInfo) {
    super();
    this.#ctx = ctx;
    this.#info = info;
  }

  [Symbol.dispose](): void {
    this.#ctx.approvalQueue[Symbol.dispose]();
  }

  async getInfo(): Promise<DiscordChannelInfo> {
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read Discord channel #${this.#info.name}`,
      description: `Read metadata for #${this.#info.name}.`,
    });
    return this.#info;
  }

  async listMessages(): Promise<Cursor<DiscordMessageEntry>> {
    return new DiscordCursor(this.#ctx, async (ctx, cursor) => {
      let page = await ctx.bot.listMessages(
          this.#info.id, ctx.guildId, this.#info.name, cursor, 50);
      return {
        items: page.items.map(message => ({ message })),
        nextCursor: page.nextCursor,
        observation: {
          title: `List messages in #${this.#info.name}`,
          description: `Listed ${page.items.length} message(s) in #${this.#info.name}.`,
        },
      };
    });
  }

  async search(query: string): Promise<Cursor<DiscordMessageEntry>> {
    validateDiscordSearchQuery(query);
    let messages = await this.#ctx.index.search(query, this.#info.id);
    let sent = false;
    return new DiscordCursor(this.#ctx, async () => {
      if (sent) return { items: [], observation: { title: "", description: "" } };
      sent = true;
      return {
        items: messages.map(message => ({ message })),
        observation: {
          title: `Discord search in #${this.#info.name}: ${query}`,
          description:
            `Searched #${this.#info.name} for "${query}". Returned ${messages.length} message(s).`,
        },
      };
    });
  }
}
