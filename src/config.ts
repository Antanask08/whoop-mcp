/** Node-only config loading (.env file, home directory). Workers use src/whoop/constants.ts directly. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REDIRECT_URI, WHOOP_API_BASE, WHOOP_AUTH_URL, WHOOP_TOKEN_URL, type Config } from "./whoop/constants.js";

export { assertClientCredentials, DEFAULT_REDIRECT_URI, WHOOP_API_BASE, WHOOP_AUTH_URL, WHOOP_SCOPES, WHOOP_TOKEN_URL } from "./whoop/constants.js";
export type { Config } from "./whoop/constants.js";

/**
 * Load a `.env` file from the project root (the directory above `dist/` or `src/`)
 * if one exists. Values already present in the environment win.
 */
export function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", ".env"), resolve(process.cwd(), ".env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const before = { ...process.env };
      process.loadEnvFile(file);
      // loadEnvFile overrides existing vars; restore any that were already set.
      for (const [k, v] of Object.entries(before)) {
        if (v !== undefined) process.env[k] = v;
      }
    } catch {
      // ignore malformed .env
    }
    return;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    clientId: env.WHOOP_CLIENT_ID ?? "",
    clientSecret: env.WHOOP_CLIENT_SECRET ?? "",
    redirectUri: env.WHOOP_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    tokenPath: env.WHOOP_TOKEN_PATH ?? join(homedir(), ".whoop-mcp", "tokens.json"),
    apiBase: env.WHOOP_API_BASE ?? WHOOP_API_BASE,
    authUrl: env.WHOOP_AUTH_URL ?? WHOOP_AUTH_URL,
    tokenUrl: env.WHOOP_TOKEN_URL ?? WHOOP_TOKEN_URL,
  };
}
