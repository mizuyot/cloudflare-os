import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Cloudflare Access settings required to verify an assertion. */
export type CfAccessEnv = Readonly<{
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ISS?: string;
  /** Client ID of the one Access service token allowed to enter without an email claim. */
  CF_ACCESS_PROBE_CLIENT_ID?: string;
}>;

/** Workshop user id used when a matching Access service token is accepted. Not an admin. */
export const ACCESS_PROBE_USER_ID = "cursor-probe";

/**
 * Maps a verified Access JWT to a Workshop user id.
 *
 * An email claim, when present, is the existing human path. A token with no email is accepted
 * only when `common_name` exactly equals `CF_ACCESS_PROBE_CLIENT_ID`, and then maps to
 * {@link ACCESS_PROBE_USER_ID}. A missing env value, a mismatched id, or any other no-email
 * claim is rejected (same as today's email-required gate).
 */
export function resolveCfAccessIdentity(
    payload: JWTPayload,
    env: Pick<CfAccessEnv, "CF_ACCESS_PROBE_CLIENT_ID">): string | null {
  if (typeof payload.email === "string" && payload.email.length > 0) {
    return payload.email;
  }
  const expected = env.CF_ACCESS_PROBE_CLIENT_ID;
  if (!expected) return null;
  if (typeof payload.common_name !== "string" || payload.common_name !== expected) {
    return null;
  }
  return ACCESS_PROBE_USER_ID;
}

type AccessTokenVerifier = (token: string, env: CfAccessEnv) => Promise<JWTPayload>;

const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyToken(token: string, env: CfAccessEnv): Promise<JWTPayload> {
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_ISS) {
    throw new Error("Cloudflare Access issuer and audience must both be configured.");
  }
  let jwks = remoteJwkSets.get(env.CF_ACCESS_ISS);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.CF_ACCESS_ISS}/cdn-cgi/access/certs`));
    remoteJwkSets.set(env.CF_ACCESS_ISS, jwks);
  }
  return (await jwtVerify(token, jwks, {
    issuer: env.CF_ACCESS_ISS,
    audience: env.CF_ACCESS_AUD,
  })).payload;
}

/** Returns verified Cloudflare Access claims, or null when the assertion cannot be trusted. */
export async function verifyCfAccessJwt(
    request: Request,
    env: CfAccessEnv,
    verifier: AccessTokenVerifier = verifyToken): Promise<JWTPayload | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    return await verifier(token, env);
  } catch {
    return null;
  }
}

/** Returns a privacy-preserving limiter key derived only from verified Access claims. */
export async function accessRateLimitKey(payload: JWTPayload): Promise<string | null> {
  if (payload.sub) return `access-sub:${payload.sub}`;
  if (typeof payload.email !== "string" || payload.email.length === 0) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.email));
  return `access-email:${new Uint8Array(digest).toHex()}`;
}
