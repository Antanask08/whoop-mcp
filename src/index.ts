#!/usr/bin/env node
/** Local stdio entry point (Claude Code / Claude Desktop). For Cloudflare Workers see src/worker.ts. */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, loadDotEnv } from "./config.js";
import { FileTokenStore } from "./auth/token-store.js";
import { WhoopClient } from "./whoop/client.js";
import { createServer } from "./server.js";

export { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

export function createDefaultClient(): WhoopClient {
  loadDotEnv();
  const config = loadConfig();
  return new WhoopClient({ config, tokenStore: new FileTokenStore(config.tokenPath) });
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === new URL(`file://${entry}`).href || import.meta.url.endsWith(entry.replace(/^.*\//, "/"));
}

if (isMain()) {
  const client = createDefaultClient();
  serveStdio(() => createServer(client), {
    onerror: (err) => console.error(`[whoop-mcp] ${err.message}`),
  });
}
