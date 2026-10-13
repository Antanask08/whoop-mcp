/** Runtime-agnostic WHOOP constants and config shape (safe to import from Cloudflare Workers). */

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

export function assertClientCredentials(cfg: Config): void {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET are not set. Create an app at https://developer.whoop.com and put the credentials in .env (see .env.example).",
    );
  }
}
