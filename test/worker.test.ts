import { describe, expect, it } from "vitest";
import { handleRequest, safeEqual, type Env } from "../src/worker.js";
import type { KVNamespaceLike } from "../src/auth/kv-token-store.js";
import { KvTokenStore } from "../src/auth/kv-token-store.js";
import { freshTokens, jsonResponse, mockFetch, NOW, type Route } from "./helpers.js";

class MemoryKV implements KVNamespaceLike {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const TOKEN = "super-secret-bearer";
const ORIGIN = "https://whoop-mcp.example.workers.dev";

function makeEnv(kv = new MemoryKV()): Env & { TOKENS: MemoryKV } {
  return { TOKENS: kv, WHOOP_CLIENT_ID: "cid", WHOOP_CLIENT_SECRET: "csecret", MCP_BEARER_TOKEN: TOKEN };
}

function deps(routes: Record<string, Route> = {}) {
  const { fetch, calls } = mockFetch(routes);
  return { deps: { fetch, now: () => NOW }, calls };
}

function mcpRequest(body: unknown, auth: string | null = `Bearer ${TOKEN}`): Request {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (auth) headers.authorization = auth;
  return new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

async function readJsonRpc(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    return JSON.parse(data[data.length - 1]!);
  }
  return JSON.parse(text);
}

describe("safeEqual", () => {
  it("compares in constant time and rejects empties", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual(null, "x")).toBe(false);
  });
});

describe("KvTokenStore", () => {
  it("round-trips tokens and rejects malformed blobs", async () => {
    const kv = new MemoryKV();
    const store = new KvTokenStore(kv);
    expect(await store.load()).toBeNull();
    await store.save(freshTokens());
    expect((await store.load())?.access_token).toBe("access-1");
    await kv.put("whoop:tokens", "{not json");
    expect(await store.load()).toBeNull();
    await store.clear();
    expect(kv.store.has("whoop:tokens")).toBe(false);
  });
});

describe("worker routes", () => {
  it("GET / is public info", async () => {
    const res = await handleRequest(new Request(`${ORIGIN}/`), makeEnv(), deps().deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "whoop-mcp", mcp: `${ORIGIN}/mcp` });
  });

  it("refuses to run without MCP_BEARER_TOKEN", async () => {
    const env = makeEnv();
    env.MCP_BEARER_TOKEN = "";
    const res = await handleRequest(new Request(`${ORIGIN}/`), env, deps().deps);
    expect(res.status).toBe(500);
  });

  it("rejects /mcp without or with a wrong bearer", async () => {
    expect((await handleRequest(mcpRequest(INIT, null), makeEnv(), deps().deps)).status).toBe(401);
    expect((await handleRequest(mcpRequest(INIT, "Bearer nope"), makeEnv(), deps().deps)).status).toBe(401);
  });

  it("serves initialize and tools/list over HTTP", async () => {
    const env = makeEnv();
    const d = deps().deps;
    const init = await handleRequest(mcpRequest(INIT), env, d);
    expect(init.status).toBe(200);
    const initBody = (await readJsonRpc(init)) as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("whoop-mcp");

    const list = await handleRequest(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, d);
    expect(list.status).toBe(200);
    const listBody = (await readJsonRpc(list)) as { result: { tools: { name: string }[] } };
    expect(listBody.result.tools).toHaveLength(14);
  });

  it("calls a tool using tokens from KV", async () => {
    const env = makeEnv();
    await new KvTokenStore(env.TOKENS).save(freshTokens());
    const { deps: d, calls } = deps({
      "/developer/v2/user/profile/basic": () => jsonResponse({ user_id: 1, email: "a@b.c", first_name: "A", last_name: "B" }),
    });
    const res = await handleRequest(
      mcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoop_get_profile", arguments: {} } }),
      env,
      d,
    );
    expect(res.status).toBe(200);
    const body = (await readJsonRpc(res)) as { result: { isError?: boolean; structuredContent: { email: string } } };
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.email).toBe("a@b.c");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer access-1");
  });

  it("tool call without tokens returns an isError pointing at /auth/login", async () => {
    const res = await handleRequest(
      mcpRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "whoop_get_profile", arguments: {} } }),
      makeEnv(),
      deps().deps,
    );
    const body = (await readJsonRpc(res)) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/Workers KV/);
  });

  it("/auth/login needs the key, then redirects to WHOOP with a stored state", async () => {
    const env = makeEnv();
    expect((await handleRequest(new Request(`${ORIGIN}/auth/login`), env, deps().deps)).status).toBe(401);
    const res = await handleRequest(new Request(`${ORIGIN}/auth/login?key=${TOKEN}`), env, deps().deps);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://api.prod.whoop.com/oauth/oauth2/auth");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(loc.searchParams.get("scope")).toContain("offline");
    const state = loc.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(8);
    expect(env.TOKENS.store.has(`whoop:oauth-state:${state}`)).toBe(true);
  });

  it("/auth/callback rejects unknown state and stores tokens on success", async () => {
    const env = makeEnv();
    const { deps: d, calls } = deps({
      "/oauth/oauth2/token": (_u, init) => {
        const form = new URLSearchParams(String(init.body));
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("thecode");
        expect(form.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
        return jsonResponse({ access_token: "a1", refresh_token: "r1", expires_in: 3600, scope: "offline read:profile" });
      },
    });
    const bad = await handleRequest(new Request(`${ORIGIN}/auth/callback?code=x&state=unknown`), env, d);
    expect(bad.status).toBe(400);
    expect(calls).toHaveLength(0);

    const login = await handleRequest(new Request(`${ORIGIN}/auth/login?key=${TOKEN}`), env, d);
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const ok = await handleRequest(new Request(`${ORIGIN}/auth/callback?code=thecode&state=${state}`), env, d);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("WHOOP connected");
    const saved = await new KvTokenStore(env.TOKENS).load();
    expect(saved).toMatchObject({ access_token: "a1", refresh_token: "r1", expires_at: NOW + 3600_000 });
    expect(env.TOKENS.store.has(`whoop:oauth-state:${state}`)).toBe(false); // single use

    const status = await handleRequest(new Request(`${ORIGIN}/auth/status?key=${TOKEN}`), env, d);
    expect(await status.json()).toMatchObject({ authenticated: true, scopes: ["offline", "read:profile"] });
  });

  it("unknown routes are 404", async () => {
    expect((await handleRequest(new Request(`${ORIGIN}/nope`), makeEnv(), deps().deps)).status).toBe(404);
  });
});
