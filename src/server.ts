/** Runtime-agnostic server factory: registers every tool on an McpServer. */
import { McpServer, type McpServerOptions } from "@modelcontextprotocol/server";
import type { WhoopClient } from "./whoop/client.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerCycleTools } from "./tools/cycles.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerRecoveryTools } from "./tools/recovery.js";
import { registerSleepTools } from "./tools/sleep.js";
import { registerWorkoutTools } from "./tools/workouts.js";

export const SERVER_NAME = "whoop-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(client: WhoopClient, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, ...options });
  registerAuthTools(server, client);
  registerProfileTools(server, client);
  registerCycleTools(server, client);
  registerRecoveryTools(server, client);
  registerSleepTools(server, client);
  registerWorkoutTools(server, client);
  registerAnalysisTools(server, client);
  return server;
}
