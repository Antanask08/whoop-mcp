import type { Config } from "../config.js";
import { WHOOP_SCOPES } from "../config.js";
import type { StoredTokens } from "./token-store.js";

export type FetchLike = typeof fetch;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export function buildAuthUrl(cfg: Config, state: string, scopes: readonly string[] = WHOOP_SCOPES): string {
  const url = new URL(cfg.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function postToken(cfg: Config, form: Record<string, string>, fetchImpl: FetchLike): Promise<TokenResponse> {
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new OAuthError(`WHOOP token endpoint returned ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  }
  let json: TokenResponse;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    throw new OAuthError("WHOOP token endpoint returned non-JSON body", res.status, text);
  }
  if (!json.access_token) {
    throw new OAuthError("WHOOP token response has no access_token", res.status, text);
  }
  return json;
}

export function exchangeCode(cfg: Config, code: string, fetchImpl: FetchLike = fetch): Promise<TokenResponse> {
  return postToken(
    cfg,
    {
      grant_type: "authorization_code",
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
    },
    fetchImpl,
  );
}

export function refreshTokens(cfg: Config, refreshToken: string, fetchImpl: FetchLike = fetch): Promise<TokenResponse> {
  return postToken(
    cfg,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "offline",
    },
    fetchImpl,
  );
}

/** Convert a token endpoint response into the persisted shape. */
export function toStoredTokens(resp: TokenResponse, previousRefreshToken?: string, now: number = Date.now()): StoredTokens {
  const refresh = resp.refresh_token ?? previousRefreshToken;
  if (!refresh) {
    throw new OAuthError(
      "WHOOP did not return a refresh token. Make sure the `offline` scope is enabled for your app and was requested.",
      200,
      "",
    );
  }
  return {
    access_token: resp.access_token,
    refresh_token: refresh,
    expires_at: now + (resp.expires_in ?? 3600) * 1000,
    scope: resp.scope,
    token_type: resp.token_type,
  };
}
