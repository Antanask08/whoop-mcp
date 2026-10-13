import type { StoredTokens, TokenStore } from "./token-store.js";

/** The subset of Cloudflare's KVNamespace we use (avoids a hard dependency on workers-types). */
export interface KVNamespaceLike {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** TokenStore backed by Cloudflare Workers KV. One key holds the JSON blob. */
export class KvTokenStore implements TokenStore {
  constructor(
    private readonly kv: KVNamespaceLike,
    private readonly key = "whoop:tokens",
  ) {}

  async load(): Promise<StoredTokens | null> {
    const raw = await this.kv.get(this.key, "text");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredTokens>;
      if (typeof parsed.access_token !== "string" || typeof parsed.refresh_token !== "string" || typeof parsed.expires_at !== "number") {
        return null;
      }
      return parsed as StoredTokens;
    } catch {
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await this.kv.put(this.key, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    await this.kv.delete(this.key);
  }

  describe(): string {
    return `Workers KV key "${this.key}"`;
  }
}
