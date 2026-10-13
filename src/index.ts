#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, loadDotEnv } from "./config.js";
import { FileTokenStore } from "./auth/token-store.js";
import { WhoopClient } from "./whoop/client.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerCycleTools } from "./tools/cycles.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerRecoveryTools } from "./tools/recovery.js";
import { registerSleepTools } from "./tools/sleep.js";
import { registerWorkoutTools } from "./tools/workouts.js";

export const SERVER_NAME = "whoop-mcp";
export const SERVER_VERSION = "0.1.0";

/** Build a fully-registered McpServer around a WhoopClient. */
export function createServer(client: WhoopClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
  registerAuthTools(server, client);
  registerProfileTools(server, client);
  registerCycleTools(server, client);
  registerRecoveryTools(server, client);
  registerSleepTools(server, client);
  registerWorkoutTools(server, client);
  registerAnalysisTools(server, client);
  return server;
}

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
