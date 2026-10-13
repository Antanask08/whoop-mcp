/**
 * Cloudflare Workers entry point: serves the same WHOOP tools over Streamable HTTP.
 *
 * Routes
 *   GET  /                 health / info
 *   POST /mcp              MCP endpoint (Authorization: Bearer <MCP_BEARER_TOKEN>)
 *   GET  /auth/login?key=  start WHOOP OAuth (key = MCP_BEARER_TOKEN)
 *   GET  /auth/callback    WHOOP redirect target; stores tokens in KV
 *   GET  /auth/status?key= connection status
 */
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { KvTokenStore, type KVNamespaceLike } from "./auth/kv-token-store.js";
import { buildAuthUrl, exchangeCode, toStoredTokens, type FetchLike } from "./auth/oauth.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { WhoopClient } from "./whoop/client.js";
import { WHOOP_API_BASE, WHOOP_AUTH_URL, WHOOP_SCOPES, WHOOP_TOKEN_URL, type Config } from "./whoop/constants.js";

export interface Env {
  TOKENS: KVNamespaceLike;
  WHOOP_CLIENT_ID: string;
  WHOOP_CLIENT_SECRET: string;
  /** Shared secret clients must present as `Authorization: Bearer ...`. */
  MCP_BEARER_TOKEN: string;
  /** Optional override; defaults to `<worker origin>/auth/callback`. Must match the WHOOP dashboard. */
  WHOOP_REDIRECT_URI?: string;
}

export interface Deps {
  fetch: FetchLike;
  now: () => number;
}

const STATE_TTL_SECONDS = 600;
const STATE_PREFIX = "whoop:oauth-state:";

function configFor(env: Env, origin: string): Config {
  return {
    clientId: env.WHOOP_CLIENT_ID ?? "",
    clientSecret: env.WHOOP_CLIENT_SECRET ?? "",
    redirectUri: env.WHOOP_REDIRECT_URI || `${origin}/auth/callback`,
    tokenPath: "kv",
    apiBase: WHOOP_API_BASE,
    authUrl: WHOOP_AUTH_URL,
    tokenUrl: WHOOP_TOKEN_URL,
  };
}

/** Constant-time string comparison. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function bearerOf(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", ...headers } });
}

function html(title: string, body: string, status = 200): Response {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  return new Response(doc, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function unauthorized(): Response {
  return json({ error: "unauthorized", hint: "Send Authorization: Bearer <MCP_BEARER_TOKEN>" }, 401, { "www-authenticate": 'Bearer realm="whoop-mcp"' });
}

function makeClient(env: Env, cfg: Config, deps: Deps): WhoopClient {
  return new WhoopClient({ config: cfg, tokenStore: new KvTokenStore(env.TOKENS), fetch: deps.fetch, now: deps.now });
}

// One MCP handler per Worker isolate + env; each request still gets a fresh server + client.
const handlers = new WeakMap<Env, McpHttpHandler>();
function mcpHandler(env: Env, origin: string, deps: Deps): McpHttpHandler {
  let h = handlers.get(env);
  if (!h) {
    const validator = new CfWorkerJsonSchemaValidator();
    h = createMcpHandler(() => createServer(makeClient(env, configFor(env, origin), deps), { jsonSchemaValidator: validator }), {
      legacy: "stateless",
      onerror: (err) => console.error(`[whoop-mcp] ${err.message}`),
    });
    handlers.set(env, h);
  }
  return h;
}

const defaultDeps: Deps = { fetch: (input, init) => globalThis.fetch(input, init), now: () => Date.now() };

export async function handleRequest(request: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const cfg = configFor(env, origin);

  if (!env.MCP_BEARER_TOKEN) {
    return json({ error: "server_misconfigured", hint: "Set the MCP_BEARER_TOKEN secret (npx wrangler secret put MCP_BEARER_TOKEN)." }, 500);
  }

  if (url.pathname === "/" && request.method === "GET") {
    return json({ name: SERVER_NAME, version: SERVER_VERSION, mcp: `${origin}/mcp`, login: `${origin}/auth/login?key=<MCP_BEARER_TOKEN>` });
  }

  if (url.pathname === "/mcp") {
    if (!safeEqual(bearerOf(request), env.MCP_BEARER_TOKEN)) return unauthorized();
    return mcpHandler(env, origin, deps).fetch(request);
  }

  if (url.pathname === "/auth/login" && request.method === "GET") {
    if (!safeEqual(url.searchParams.get("key"), env.MCP_BEARER_TOKEN)) return unauthorized();
    if (!cfg.clientId || !cfg.clientSecret) return json({ error: "server_misconfigured", hint: "Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET secrets." }, 500);
    const state = crypto.randomUUID().replace(/-/g, "");
    await env.TOKENS.put(STATE_PREFIX + state, String(deps.now()), { expirationTtl: STATE_TTL_SECONDS });
    return Response.redirect(buildAuthUrl(cfg, state, WHOOP_SCOPES), 302);
  }

  if (url.pathname === "/auth/callback" && request.method === "GET") {
    const error = url.searchParams.get("error");
    if (error) return html("WHOOP login failed", `${error}: ${url.searchParams.get("error_description") ?? ""}`, 400);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const known = state && (await env.TOKENS.get(STATE_PREFIX + state, "text"));
    if (!code || !known) return html("WHOOP login failed", "Missing code or unknown/expired state. Start again from /auth/login.", 400);
    await env.TOKENS.delete(STATE_PREFIX + state);
    try {
      const resp = await exchangeCode(cfg, code, deps.fetch);
      const tokens = toStoredTokens(resp, undefined, deps.now());
      await new KvTokenStore(env.TOKENS).save(tokens);
      return html("WHOOP connected", `Tokens stored. Scopes: ${tokens.scope ?? "(not reported)"}. You can close this tab.`);
    } catch (err) {
      return html("WHOOP login failed", (err as Error).message, 502);
    }
  }

  if (url.pathname === "/auth/status" && request.method === "GET") {
    if (!safeEqual(url.searchParams.get("key"), env.MCP_BEARER_TOKEN)) return unauthorized();
    return json(await makeClient(env, cfg, deps).authStatus());
  }

  return json({ error: "not_found" }, 404);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
