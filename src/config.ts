import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath: string;
  apiBase: string;
  authUrl: string;
  tokenUrl: string;
}

export const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";
export const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const DEFAULT_REDIRECT_URI = "http://localhost:8787/callback";

/** All scopes the server needs. `offline` is required to receive a refresh token. */
export const WHOOP_SCOPES = [
  "offline",
  "read:profile",
  "read:body_measurement",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
] as const;

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

export function assertClientCredentials(cfg: Config): void {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET are not set. Create an app at https://developer.whoop.com and put the credentials in .env (see .env.example).",
    );
  }
}
