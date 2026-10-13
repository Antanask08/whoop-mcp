import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/config.js";
import { MemoryTokenStore, type StoredTokens } from "../src/auth/token-store.js";
import { WhoopClient } from "../src/whoop/client.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8")) as T;
}

export const testConfig: Config = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "http://localhost:8787/callback",
  tokenPath: "/dev/null",
  apiBase: "https://api.test/developer",
  authUrl: "https://api.test/oauth/oauth2/auth",
  tokenUrl: "https://api.test/oauth/oauth2/token",
};

export const NOW = Date.parse("2026-10-13T08:00:00.000Z");

export function freshTokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: NOW + 3600_000,
    scope: "offline read:profile read:cycles read:recovery read:sleep read:workout read:body_measurement",
    ...overrides,
  };
}

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** A fetch stub that routes by pathname and records every call. */
export function mockFetch(routes: Record<string, Route>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    const route = routes[url.pathname] ?? routes["*"];
    if (!route) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    return route(url, init);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function makeClient(routes: Record<string, Route>, tokens: StoredTokens | null = freshTokens(), now = () => NOW) {
  const store = new MemoryTokenStore(tokens);
  const { fetch, calls } = mockFetch(routes);
  const client = new WhoopClient({ config: testConfig, tokenStore: store, fetch, now });
  return { client, store, calls };
}
