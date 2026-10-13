import type { Config } from "../config.js";
import { assertClientCredentials } from "../config.js";
import { refreshTokens, toStoredTokens, type FetchLike } from "../auth/oauth.js";
import type { StoredTokens, TokenStore } from "../auth/token-store.js";
import type { Paginated } from "./types.js";

/** Thrown when there are no stored tokens or they can no longer be refreshed. */
export class WhoopAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhoopAuthError";
  }
}

/** Thrown for any non-2xx WHOOP API response. */
export class WhoopApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly rateLimit?: { limit?: string; remaining?: string; resetSeconds?: number },
  ) {
    super(message);
    this.name = "WhoopApiError";
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface WhoopClientOptions {
  config: Config;
  tokenStore: TokenStore;
  fetch?: FetchLike;
  /** Seconds before expiry at which to refresh proactively. Default 60. */
  refreshSkewSeconds?: number;
  now?: () => number;
}

export interface AuthStatus {
  authenticated: boolean;
  tokenPath: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  expired?: boolean;
  scopes?: string[];
  clientConfigured: boolean;
}

export class WhoopClient {
  private readonly cfg: Config;
  private readonly store: TokenStore;
  private readonly fetchImpl: FetchLike;
  private readonly skewMs: number;
  private readonly now: () => number;
  private cached: StoredTokens | null = null;
  private loaded = false;
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(opts: WhoopClientOptions) {
    this.cfg = opts.config;
    this.store = opts.tokenStore;
    this.fetchImpl = opts.fetch ?? fetch;
    this.skewMs = (opts.refreshSkewSeconds ?? 60) * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  // ---------- auth ----------

  private async loadTokens(): Promise<StoredTokens | null> {
    if (!this.loaded) {
      this.cached = await this.store.load();
      this.loaded = true;
    }
    return this.cached;
  }

  private async ensureTokens(): Promise<StoredTokens> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      throw new WhoopAuthError(
        `Not connected to WHOOP. Run \`npm run auth\` in the whoop-mcp directory to sign in (tokens are saved to ${this.store.describe()}).`,
      );
    }
    if (tokens.expires_at - this.now() <= this.skewMs) {
      return this.refresh(tokens.access_token);
    }
    return tokens;
  }

  /**
   * Refresh the access token. Single-flight: concurrent callers share one request,
   * because WHOOP rotates the refresh token on every use and a second concurrent
   * refresh with the old token fails.
   */
  private refresh(staleAccessToken: string): Promise<StoredTokens> {
    // Someone already refreshed since the caller read its token.
    if (this.cached && this.cached.access_token !== staleAccessToken && this.cached.expires_at - this.now() > this.skewMs) {
      return Promise.resolve(this.cached);
    }
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      try {
        assertClientCredentials(this.cfg);
        const current = this.cached ?? (await this.store.load());
        if (!current) throw new WhoopAuthError("No stored WHOOP tokens to refresh. Run `npm run auth`.");
        let resp;
        try {
          resp = await refreshTokens(this.cfg, current.refresh_token, this.fetchImpl);
        } catch (err) {
          throw new WhoopAuthError(
            `WHOOP token refresh failed (${(err as Error).message}). Run \`npm run auth\` to sign in again.`,
          );
        }
        const next = toStoredTokens(resp, current.refresh_token, this.now());
        // Persist before resolving: the old refresh token is now invalid.
        await this.store.save(next);
        this.cached = next;
        return next;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async authStatus(): Promise<AuthStatus> {
    const tokens = await this.loadTokens();
    const clientConfigured = Boolean(this.cfg.clientId && this.cfg.clientSecret);
    if (!tokens) return { authenticated: false, tokenPath: this.store.describe(), clientConfigured };
    const expiresInSeconds = Math.round((tokens.expires_at - this.now()) / 1000);
    return {
      authenticated: true,
      tokenPath: this.store.describe(),
      expiresAt: new Date(tokens.expires_at).toISOString(),
      expiresInSeconds,
      expired: expiresInSeconds <= 0,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : undefined,
      clientConfigured,
    };
  }

  // ---------- requests ----------

  buildUrl(path: string, params?: QueryParams): string {
    const url = new URL(this.cfg.apiBase.replace(/\/$/, "") + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    let tokens = await this.ensureTokens();
    let res = await this.send(path, params, tokens.access_token);
    if (res.status === 401) {
      tokens = await this.refresh(tokens.access_token);
      res = await this.send(path, params, tokens.access_token);
    }
    return this.handle<T>(res, path);
  }

  private send(path: string, params: QueryParams | undefined, accessToken: string): Promise<Response> {
    return this.fetchImpl(this.buildUrl(path, params), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  }

  private async handle<T>(res: Response, path: string): Promise<T> {
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new WhoopAuthError("WHOOP rejected the access token even after refreshing. Run `npm run auth` to sign in again.");
    }
    if (res.status === 429) {
      const reset = res.headers.get("x-ratelimit-reset");
      const resetSeconds = reset ? Number(reset) : undefined;
      throw new WhoopApiError(
        `WHOOP rate limit hit (100/min, 10,000/day).${resetSeconds ? ` Retry in ~${resetSeconds}s.` : ""}`,
        429,
        body,
        {
          limit: res.headers.get("x-ratelimit-limit") ?? undefined,
          remaining: res.headers.get("x-ratelimit-remaining") ?? undefined,
          resetSeconds,
        },
      );
    }
    if (res.status === 404) {
      throw new WhoopApiError(`WHOOP returned 404 for ${path}: not found (or not yet available).`, 404, body);
    }
    throw new WhoopApiError(`WHOOP API error ${res.status} for ${path}: ${body.slice(0, 300)}`, res.status, body);
  }

  /** Fetch one page of a collection endpoint. */
  getPage<T>(path: string, params?: QueryParams): Promise<Paginated<T>> {
    return this.get<Paginated<T>>(path, params);
  }

  /** Iterate records across pages until exhausted or `maxRecords` reached. */
  async *paginate<T>(path: string, params: QueryParams = {}, maxRecords = 100): AsyncGenerator<T> {
    let yielded = 0;
    let nextToken: string | undefined = typeof params.nextToken === "string" ? params.nextToken : undefined;
    const pageSize = Math.min(25, Math.max(1, Number(params.limit ?? 25)));
    while (yielded < maxRecords) {
      const page: Paginated<T> = await this.getPage<T>(path, { ...params, limit: pageSize, nextToken });
      for (const r of page.records ?? []) {
        if (yielded >= maxRecords) return;
        yield r;
        yielded++;
      }
      if (!page.next_token || (page.records ?? []).length === 0) return;
      nextToken = page.next_token;
    }
  }

  async collect<T>(path: string, params: QueryParams = {}, maxRecords = 100): Promise<T[]> {
    const out: T[] = [];
    for await (const r of this.paginate<T>(path, params, maxRecords)) out.push(r);
    return out;
  }
}
