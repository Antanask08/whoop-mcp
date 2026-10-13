import { describe, expect, it } from "vitest";
import { WhoopApiError, WhoopAuthError } from "../src/whoop/client.js";
import { fixture, freshTokens, jsonResponse, makeClient, NOW } from "./helpers.js";

const profile = { user_id: 1, email: "a@b.c", first_name: "A", last_name: "B" };

function tokenRoute(counter: { n: number }) {
  return async (_url: URL, init: RequestInit) => {
    counter.n++;
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("csecret");
    expect(form.get("scope")).toBe("offline");
    return jsonResponse({
      access_token: `access-${counter.n + 1}`,
      refresh_token: `refresh-${counter.n + 1}`,
      expires_in: 3600,
      scope: "offline read:profile",
      token_type: "bearer",
    });
  };
}

describe("WhoopClient", () => {
  it("throws WhoopAuthError when no tokens are stored", async () => {
    const { client, calls } = makeClient({}, null);
    await expect(client.get("/v2/user/profile/basic")).rejects.toBeInstanceOf(WhoopAuthError);
    expect(calls).toHaveLength(0);
  });

  it("sends a bearer token and strips empty query params", async () => {
    const { client, calls } = makeClient({ "/developer/v2/cycle": () => jsonResponse({ records: [], next_token: null }) });
    await client.get("/v2/cycle", { limit: 5, start: undefined, end: "", nextToken: null });
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-1");
    expect(calls[0]!.url.search).toBe("?limit=5");
  });

  it("refreshes once on 401, persists rotated tokens, and retries", async () => {
    const counter = { n: 0 };
    let profileHits = 0;
    const { client, store, calls } = makeClient({
      "/developer/v2/user/profile/basic": (_u, init) => {
        profileHits++;
        const auth = (init.headers as Record<string, string>).Authorization;
        return auth === "Bearer access-2" ? jsonResponse(profile) : jsonResponse({ error: "expired" }, 401);
      },
      "/oauth/oauth2/token": tokenRoute(counter),
    });
    const result = await client.get("/v2/user/profile/basic");
    expect(result).toEqual(profile);
    expect(profileHits).toBe(2);
    expect(counter.n).toBe(1);
    const saved = await store.load();
    expect(saved?.access_token).toBe("access-2");
    expect(saved?.refresh_token).toBe("refresh-2");
    expect(saved?.expires_at).toBe(NOW + 3600_000);
    // token call happened between the two profile calls
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/developer/v2/user/profile/basic",
      "/oauth/oauth2/token",
      "/developer/v2/user/profile/basic",
    ]);
  });

  it("refreshes proactively when the token is about to expire", async () => {
    const counter = { n: 0 };
    const { client, calls } = makeClient(
      {
        "/developer/v2/user/profile/basic": () => jsonResponse(profile),
        "/oauth/oauth2/token": tokenRoute(counter),
      },
      freshTokens({ expires_at: NOW + 30_000 }),
    );
    await client.get("/v2/user/profile/basic");
    expect(counter.n).toBe(1);
    expect(calls[0]!.url.pathname).toBe("/oauth/oauth2/token");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer access-2");
  });

  it("shares a single refresh between concurrent requests", async () => {
    const counter = { n: 0 };
    const { client } = makeClient(
      {
        "/developer/v2/user/profile/basic": () => jsonResponse(profile),
        "/developer/v2/user/measurement/body": () => jsonResponse({ height_meter: 1.8, weight_kilogram: 75, max_heart_rate: 190 }),
        "/oauth/oauth2/token": async (u, i) => {
          await new Promise((r) => setTimeout(r, 10));
          return tokenRoute(counter)(u, i);
        },
      },
      freshTokens({ expires_at: NOW - 1 }),
    );
    await Promise.all([client.get("/v2/user/profile/basic"), client.get("/v2/user/measurement/body"), client.get("/v2/user/profile/basic")]);
    expect(counter.n).toBe(1);
  });

  it("surfaces a WhoopAuthError when the refresh itself fails", async () => {
    const { client } = makeClient(
      {
        "/oauth/oauth2/token": () => jsonResponse({ error: "invalid_grant" }, 400),
      },
      freshTokens({ expires_at: NOW - 1 }),
    );
    await expect(client.get("/v2/user/profile/basic")).rejects.toThrow(/npm run auth/);
  });

  it("turns 429 into a WhoopApiError with rate-limit info", async () => {
    const { client } = makeClient({
      "/developer/v2/cycle": () =>
        jsonResponse({ message: "slow down" }, 429, { "x-ratelimit-limit": "100;window=60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "17" }),
    });
    const err = await client.get("/v2/cycle").catch((e) => e);
    expect(err).toBeInstanceOf(WhoopApiError);
    expect(err.status).toBe(429);
    expect(err.rateLimit.resetSeconds).toBe(17);
    expect(err.message).toMatch(/17s/);
  });

  it("paginates with next_token and honours maxRecords", async () => {
    const cycle = fixture<{ id: number }>("cycle");
    const pages: Record<string, unknown> = {
      first: { records: [{ ...cycle, id: 1 }, { ...cycle, id: 2 }], next_token: "p2" },
      p2: { records: [{ ...cycle, id: 3 }, { ...cycle, id: 4 }], next_token: "p3" },
      p3: { records: [{ ...cycle, id: 5 }], next_token: null },
    };
    const { client, calls } = makeClient({
      "/developer/v2/cycle": (url) => jsonResponse(pages[url.searchParams.get("nextToken") ?? "first"]),
    });
    const all = await client.collect<{ id: number }>("/v2/cycle", { limit: 2 });
    expect(all.map((c) => c.id)).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url.searchParams.get("nextToken")).toBe("p2");

    const capped = await client.collect<{ id: number }>("/v2/cycle", { limit: 2 }, 3);
    expect(capped.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("reports auth status without leaking token values", async () => {
    const { client } = makeClient({});
    const s = await client.authStatus();
    expect(s.authenticated).toBe(true);
    expect(s.expiresInSeconds).toBe(3600);
    expect(s.scopes).toContain("read:sleep");
    expect(JSON.stringify(s)).not.toContain("access-1");
    expect(JSON.stringify(s)).not.toContain("refresh-1");
  });
});
