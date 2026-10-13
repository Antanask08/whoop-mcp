import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds at which the access token expires. */
  expires_at: number;
  scope?: string;
  token_type?: string;
}

export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
  /** Human-readable location, for status messages. */
  describe(): string;
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StoredTokens | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredTokens>;
      if (
        typeof parsed.access_token !== "string" ||
        typeof parsed.refresh_token !== "string" ||
        typeof parsed.expires_at !== "number"
      ) {
        return null;
      }
      return parsed as StoredTokens;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  describe(): string {
    return this.path;
  }
}

export class MemoryTokenStore implements TokenStore {
  constructor(private tokens: StoredTokens | null = null) {}
  async load(): Promise<StoredTokens | null> {
    return this.tokens ? { ...this.tokens } : null;
  }
  async save(tokens: StoredTokens): Promise<void> {
    this.tokens = { ...tokens };
  }
  async clear(): Promise<void> {
    this.tokens = null;
  }
  describe(): string {
    return "(in-memory)";
  }
}
