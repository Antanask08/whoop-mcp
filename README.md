# whoop-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your **WHOOP** data (recovery, sleep, strain, workouts, profile) as tools for Claude Desktop, Claude Code or any MCP client. Node.js + TypeScript, WHOOP API v2, read-only. Runs locally over stdio or on Cloudflare Workers over HTTP.

## Tools

| Tool | What it returns |
|---|---|
| `whoop_auth_status` | Whether the server is connected, token expiry, granted scopes (never the tokens themselves) |
| `whoop_get_profile` | user_id, email, first/last name |
| `whoop_get_body_measurements` | height, weight, max HR, derived BMI |
| `whoop_list_cycles` | Physiological days: strain, calories, avg/max HR. Supports `days`, `start`/`end`, pagination, `all` |
| `whoop_get_cycle` | One cycle by numeric id |
| `whoop_get_cycle_sleep` | The sleep that began a cycle |
| `whoop_get_cycle_recovery` | The recovery for a cycle |
| `whoop_list_recoveries` | Recovery %, HRV, resting HR, SpO2, skin temp |
| `whoop_list_sleeps` | Sleep sessions with stage breakdown, sleep need, performance/efficiency/consistency; `includeNaps` filter |
| `whoop_get_sleep` | One sleep by UUID |
| `whoop_list_workouts` | Workouts with strain, calories, HR zones, distance; `sportName` filter |
| `whoop_get_workout` | One workout by UUID |
| `whoop_get_daily_summary` | One call for a day: cycle + recovery + sleep + workouts, with notes about unscored data. Defaults to today |
| `whoop_get_trends` | Per-day rows and avg/min/max over the last N days (1-90); with 14+ days, last-7 vs prior-7 comparison |

All list tools accept `start`, `end` (ISO-8601, `YYYY-MM-DD`, `today`, `yesterday`), `days` (last N days), `limit` (1-25), `nextToken`, and `all` + `maxRecords` to auto-paginate. Every tool returns a short text summary plus `structuredContent`.

## Setup

### 1. Create a WHOOP developer app

1. Sign in at <https://developer.whoop.com> (your normal WHOOP account) and create a team if asked.
2. Create an app:
   - **Redirect URI:** `http://localhost:8787/callback`
   - **Scopes:** `read:profile`, `read:body_measurement`, `read:cycles`, `read:recovery`, `read:sleep`, `read:workout`, and `offline` (required for refresh tokens)
3. Copy the **Client ID** and **Client Secret**.

### 2. Install and build

```bash
cd whoop-mcp
npm install
npm run build
cp .env.example .env   # then paste WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET into .env
```

### 3. Sign in once

```bash
npm run auth
```

This opens the WHOOP consent page in your browser, catches the redirect on `localhost:8787`, and saves tokens to `~/.whoop-mcp/tokens.json` (mode 0600). Access tokens last about an hour and are refreshed automatically; WHOOP rotates the refresh token on every refresh and the server persists the new one immediately.

### 4. Register with a client

**Claude Code**

```bash
claude mcp add whoop -e WHOOP_CLIENT_ID=... -e WHOOP_CLIENT_SECRET=... -- node /ABSOLUTE/PATH/whoop-mcp/dist/index.js
```

(If `.env` lives next to `dist/`, the server loads it and you can omit the `-e` flags.)

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "whoop": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/whoop-mcp/dist/index.js"],
      "env": {
        "WHOOP_CLIENT_ID": "...",
        "WHOOP_CLIENT_SECRET": "..."
      }
    }
  }
}
```

Then ask things like "How did I sleep this week?", "What's my recovery today?", or "Compare my HRV over the last 14 days".

## Deploy to Cloudflare Workers (remote HTTP)

The same tools can run on Cloudflare's free tier so they're reachable from anywhere. The Worker entry is [src/worker.ts](src/worker.ts); tokens live in Workers KV; the MCP endpoint is protected by a shared bearer token.

| Route | Purpose |
|---|---|
| `POST /mcp` | MCP endpoint (Streamable HTTP). Requires `Authorization: Bearer <MCP_BEARER_TOKEN>` |
| `GET /auth/login?key=<MCP_BEARER_TOKEN>` | Starts the WHOOP sign-in (one time) |
| `GET /auth/callback` | WHOOP redirect target; must be registered in the WHOOP dashboard |
| `GET /auth/status?key=<MCP_BEARER_TOKEN>` | Connection status |

### Steps

1. **Log in to Cloudflare** (free account is fine):

   ```bash
   npx wrangler login
   ```

2. **Create the KV namespace** and paste the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`:

   ```bash
   npx wrangler kv namespace create TOKENS
   ```

3. **Set secrets** (generate a long random string for the bearer token, e.g. `openssl rand -hex 32`):

   ```bash
   npx wrangler secret put WHOOP_CLIENT_ID
   npx wrangler secret put WHOOP_CLIENT_SECRET
   npx wrangler secret put MCP_BEARER_TOKEN
   ```

4. **Deploy:**

   ```bash
   npm run deploy:cf
   ```

   Note the URL, e.g. `https://whoop-mcp.<your-subdomain>.workers.dev`.

5. **Register the callback in WHOOP:** edit your app at <https://developer.whoop.com> and add `https://whoop-mcp.<your-subdomain>.workers.dev/auth/callback` as a redirect URI (keep the localhost one for the stdio server).

6. **Sign in once:** open `https://whoop-mcp.<your-subdomain>.workers.dev/auth/login?key=<MCP_BEARER_TOKEN>` in a browser and approve. Tokens are stored in KV and refresh automatically.

7. **Connect Claude Code:**

   ```bash
   claude mcp add --transport http -s user whoop-remote https://whoop-mcp.<your-subdomain>.workers.dev/mcp --header "Authorization: Bearer <MCP_BEARER_TOKEN>"
   ```

### Local Workers dev

`npm run dev:cf` runs the Worker locally with Miniflare. Put `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` and `MCP_BEARER_TOKEN` in a gitignored `.dev.vars` file. The local KV is empty; either sign in through `/auth/login` (needs `http://localhost:8787/auth/callback` registered in WHOOP) or seed it from the file store:

```bash
npx wrangler kv key put --local --binding TOKENS whoop:tokens "$(cat ~/.whoop-mcp/tokens.json)"
```

### Caveats

- **One WHOOP account per deployment.** Whoever holds `MCP_BEARER_TOKEN` can read that account's data, so treat it like a password.
- **Don't share one refresh token between the local file store and KV.** WHOOP rotates it on every refresh; whichever copy refreshes first invalidates the other. Sign in separately for each (or copy tokens after the last refresh).
- **claude.ai custom connectors** require a full OAuth authorization server, not a static bearer. This deployment works with Claude Code and Claude Desktop; claude.ai web/mobile would need an OAuth layer (e.g. Cloudflare's `workers-oauth-provider`) in front.
- KV is eventually consistent. A refresh in one edge location can take up to ~60s to be visible elsewhere; in practice refreshes happen about once an hour so this is rarely hit.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` | — | From the developer dashboard. Needed at runtime for token refresh |
| `WHOOP_REDIRECT_URI` | `http://localhost:8787/callback` | Must match the dashboard exactly |
| `WHOOP_TOKEN_PATH` | `~/.whoop-mcp/tokens.json` | Where tokens are stored |

## Development

```bash
npm test          # vitest: client (refresh, rotation, single-flight, 429, pagination), tools over an in-memory MCP transport, analysis math
npm run typecheck
npm run dev       # run from source with tsx
```

Smoke test the built server without credentials:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/index.js
```

## Notes

- Uses WHOOP API **v2** only (`https://api.prod.whoop.com/developer/v2/...`). v1 is unsupported by WHOOP.
- Rate limits: 100 requests/minute, 10,000/day. On 429 the tool returns an error with the reset time instead of retrying.
- `score_state` can be `PENDING_SCORE` or `UNSCORABLE`; in that case `score` is absent and the summaries say so.
- Disconnecting: delete the token file, and optionally revoke the app's access from WHOOP with

  ```bash
  curl -X DELETE -H "Authorization: Bearer <access_token>" https://api.prod.whoop.com/developer/v2/user/access
  ```

- Nothing is written to stdout except MCP protocol messages; diagnostics go to stderr.
