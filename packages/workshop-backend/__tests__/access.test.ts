import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_PROBE_USER_ID,
  accessRateLimitKey,
  resolveCfAccessIdentity,
  verifyCfAccessJwt,
} from "../src/access.js";

const joseMocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn().mockResolvedValue({ payload: { sub: "user-1" } }),
}));

vi.mock("jose", () => joseMocks);

const accessEnv = {
  CF_ACCESS_AUD: "workshop-audience",
  CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
};

describe("verifyCfAccessJwt", () => {
  it("reuses the remote JWK set for requests with the same issuer", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const otherEnv = {
      ...accessEnv,
      CF_ACCESS_ISS: "https://other-team.cloudflareaccess.com",
    };

    await verifyCfAccessJwt(request, accessEnv);
    await verifyCfAccessJwt(request, accessEnv);
    await verifyCfAccessJwt(request, otherEnv);

    expect(joseMocks.createRemoteJWKSet).toHaveBeenCalledTimes(2);
    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      1, new URL("https://team.cloudflareaccess.com/cdn-cgi/access/certs"),
    );
    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      2, new URL("https://other-team.cloudflareaccess.com/cdn-cgi/access/certs"),
    );
  });

  it("rejects missing and invalid assertions", async () => {
    const requestWithoutToken = new Request("https://workshop.example/api/client-errors");
    const verifier = vi.fn();
    const missing = await verifyCfAccessJwt(requestWithoutToken, accessEnv, verifier);
    expect(missing).toBeNull();
    expect(verifier).not.toHaveBeenCalled();

    const requestWithToken = new Request("https://workshop.example/api/client-errors", {
      headers: { "cf-access-jwt-assertion": "invalid" },
    });
    verifier.mockRejectedValue(new Error("invalid signature"));
    const invalid = await verifyCfAccessJwt(requestWithToken, accessEnv, verifier);
    expect(invalid).toBeNull();
  });

  it("returns claims only after verification", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const verifier = vi.fn().mockResolvedValue({
      sub: "user-1", email: "person@example.com",
    });

    await expect(verifyCfAccessJwt(request, accessEnv, verifier)).resolves.toEqual({
      sub: "user-1", email: "person@example.com",
    });
  });
});

describe("resolveCfAccessIdentity", () => {
  const probeClientId = "probe-client.access";

  it("maps a matching service-token common_name to cursor-probe", () => {
    expect(resolveCfAccessIdentity(
        { common_name: probeClientId },
        { CF_ACCESS_PROBE_CLIENT_ID: probeClientId },
    )).toBe(ACCESS_PROBE_USER_ID);
  });

  it("rejects a mismatched common_name the same as today's no-email gate", () => {
    expect(resolveCfAccessIdentity(
        { common_name: "other-client.access" },
        { CF_ACCESS_PROBE_CLIENT_ID: probeClientId },
    )).toBeNull();
  });

  it("rejects a service token when CF_ACCESS_PROBE_CLIENT_ID is unset", () => {
    expect(resolveCfAccessIdentity({ common_name: probeClientId }, {})).toBeNull();
  });

  it("keeps the existing email path even when a probe client id is configured", () => {
    expect(resolveCfAccessIdentity(
        { email: "person@example.com", common_name: probeClientId },
        { CF_ACCESS_PROBE_CLIENT_ID: probeClientId },
    )).toBe("person@example.com");
  });
});

describe("accessRateLimitKey", () => {
  it("uses the verified subject and hashes email only as a fallback", async () => {
    await expect(accessRateLimitKey({ sub: "user-1", email: "person@example.com" }))
      .resolves.toBe("access-sub:user-1");
    const emailKey = await accessRateLimitKey({ email: "person@example.com" });
    expect(emailKey).toMatch(/^access-email:[0-9a-f]{64}$/);
    expect(emailKey).not.toContain("person@example.com");
  });
});
