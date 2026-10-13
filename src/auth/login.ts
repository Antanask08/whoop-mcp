#!/usr/bin/env node
/**
 * One-shot OAuth login: `npm run auth`.
 * Starts a local HTTP listener on the registered redirect URI, opens the WHOOP
 * consent page, exchanges the returned code, and saves tokens to disk.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { assertClientCredentials, loadConfig, loadDotEnv, WHOOP_SCOPES } from "../config.js";
import { buildAuthUrl, exchangeCode, toStoredTokens } from "./oauth.js";
import { FileTokenStore } from "./token-store.js";

const TIMEOUT_MS = 5 * 60 * 1000;

function openBrowser(url: string): void {
  if (process.env.WHOOP_NO_BROWSER) return;
  const cmd =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printing the URL is the fallback.
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  assertClientCredentials(cfg);

  const redirect = new URL(cfg.redirectUri);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)) {
    throw new Error(
      `WHOOP_REDIRECT_URI must point at localhost for this CLI flow (got ${cfg.redirectUri}). Register e.g. http://localhost:8787/callback in the WHOOP dashboard.`,
    );
  }
  const port = Number(redirect.port || 80);
  const state = randomBytes(12).toString("hex"); // 24 chars; WHOOP requires >= 8
  const store = new FileTokenStore(cfg.tokenPath);
  const authUrl = buildAuthUrl(cfg, state, WHOOP_SCOPES);

  const result = await new Promise<{ code: string }>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${redirect.host}`);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("WHOOP login failed", `${error}: ${url.searchParams.get("error_description") ?? ""}`));
        finish(new Error(`WHOOP returned error: ${error} ${url.searchParams.get("error_description") ?? ""}`));
        return;
      }
      if (!code || gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("WHOOP login failed", "Missing code or state mismatch. Please retry."));
        finish(new Error("Missing code or state mismatch"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(page("WHOOP connected", "You can close this tab and go back to the terminal."));
      finish(null, { code });
    });

    const timer = setTimeout(() => finish(new Error("Timed out waiting for the WHOOP redirect (5 minutes).")), TIMEOUT_MS);
    let done = false;
    function finish(err: Error | null, value?: { code: string }) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Give the response a moment to flush, then close.
      setTimeout(() => server.close(), 100);
      if (err) reject(err);
      else resolve(value!);
    }

    server.on("error", (err) => finish(err));
    server.listen(port, redirect.hostname === "[::1]" ? "::1" : redirect.hostname, () => {
      console.error(`Listening on ${cfg.redirectUri} for the WHOOP redirect...`);
      const hint = process.env.WHOOP_NO_BROWSER ? "" : " (opening browser automatically)";
      console.error(`\nOpen this URL to sign in${hint}:\n\n  ${authUrl}\n`);
      openBrowser(authUrl);
    });
  });

  console.error("Got authorization code, exchanging for tokens...");
  const resp = await exchangeCode(cfg, result.code);
  const tokens = toStoredTokens(resp);
  await store.save(tokens);
  console.error(`\nConnected to WHOOP.`);
  console.error(`Scopes: ${tokens.scope ?? "(not reported)"}`);
  console.error(`Tokens saved to ${cfg.tokenPath}`);
  console.error(`Access token expires at ${new Date(tokens.expires_at).toLocaleString()}; it refreshes automatically.`);
}

main().catch((err) => {
  console.error(`\nLogin failed: ${(err as Error).message}`);
  process.exit(1);
});
