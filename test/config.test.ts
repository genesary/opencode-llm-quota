import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { keycloakTokenSource, TOKEN_SOURCE_KEY, tokenFor } from "../src/token-source.js";

describe("resolveConfig", () => {
  it("has sane defaults with no configuration at all", () => {
    expect(resolveConfig({}, {})).toEqual({
      enabled: true,
      providerId: "keycloak",
      intervalMs: 60_000,
      thresholds: { minutePct: 80, weeklyPct: 50, inFlightPct: 75 },
      toastThresholds: [80, 100],
      toasts: true,
      labels: {},
      quotaPath: "/v1/quota",
    });
  });

  it("follows opencode-keycloak-auth's provider id with no cross-configuration", () => {
    expect(resolveConfig({}, { OPENCODE_KC_PROVIDER_ID: "platform" }).providerId).toBe("platform");
    expect(
      resolveConfig({}, { OPENCODE_KC_PROVIDER_ID: "platform", OPENCODE_QUOTA_PROVIDER_ID: "other" })
        .providerId,
    ).toBe("other");
    expect(resolveConfig({ providerId: "mine" }, { OPENCODE_QUOTA_PROVIDER_ID: "other" }).providerId).toBe(
      "mine",
    );
  });

  it("never lets the interval go below 60 s", () => {
    expect(resolveConfig({ intervalSeconds: 5 }, {}).intervalMs).toBe(60_000);
    expect(resolveConfig({}, { OPENCODE_QUOTA_INTERVAL: "0" }).intervalMs).toBe(60_000);
    expect(resolveConfig({ intervalSeconds: "120" }, {}).intervalMs).toBe(120_000);
    expect(resolveConfig({ intervalSeconds: "nope" }, {}).intervalMs).toBe(60_000);
  });

  it("only accepts a plain path for quotaPath", () => {
    expect(resolveConfig({ quotaPath: "/quota/v2" }, {}).quotaPath).toBe("/quota/v2");
    for (const bad of ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "/a?b", "/a b"]) {
      expect(resolveConfig({ quotaPath: bad }, {}).quotaPath).toBe("/v1/quota");
    }
  });

  it("reads booleans, thresholds and the path from options or env", () => {
    const config = resolveConfig(
      { toastThresholdsPct: "100, 90", weeklyThresholdPct: 70 },
      { OPENCODE_QUOTA_ENABLED: "off", OPENCODE_QUOTA_TOASTS: "no", OPENCODE_QUOTA_PATH: "quota" },
    );
    expect(config.enabled).toBe(false);
    expect(config.toasts).toBe(false);
    expect(config.toastThresholds).toEqual([90, 100]);
    expect(config.thresholds.weeklyPct).toBe(70);
    expect(config.quotaPath).toBe("/quota");
  });
});

describe("token source (OpenCode v1, published by opencode-keycloak-auth)", () => {
  it("absent → undefined", async () => {
    expect(keycloakTokenSource({})).toBeUndefined();
    expect(await tokenFor("keycloak", {})).toBeUndefined();
  });

  it("wrong version or shape → ignored", () => {
    expect(
      keycloakTokenSource({ [TOKEN_SOURCE_KEY]: { version: 2, token: async () => "x" } }),
    ).toBeUndefined();
    expect(keycloakTokenSource({ [TOKEN_SOURCE_KEY]: { version: 1 } })).toBeUndefined();
  });

  it("returns the provider's token, and swallows errors", async () => {
    const scope = {
      [TOKEN_SOURCE_KEY]: {
        version: 1,
        token: async (id: string) => (id === "keycloak" ? "jwt" : undefined),
      },
    };
    expect(await tokenFor("keycloak", scope)).toBe("jwt");
    expect(await tokenFor("other", scope)).toBeUndefined();
    const broken = {
      [TOKEN_SOURCE_KEY]: {
        version: 1,
        token: async () => {
          throw new Error("refresh failed");
        },
      },
    };
    expect(await tokenFor("keycloak", broken)).toBeUndefined();
  });
});
