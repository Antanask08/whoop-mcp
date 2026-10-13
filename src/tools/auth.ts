import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WhoopClient } from "../whoop/client.js";
import { guard, ok, READ_ONLY } from "./common.js";

export function registerAuthTools(server: McpServer, client: WhoopClient): void {
  server.registerTool(
    "whoop_auth_status",
    {
      title: "WHOOP connection status",
      description:
        "Check whether the server is connected to a WHOOP account: token presence, expiry, granted scopes and where tokens are stored. Never returns token values.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        authenticated: z.boolean(),
        clientConfigured: z.boolean(),
        tokenPath: z.string(),
        expiresAt: z.string().optional(),
        expiresInSeconds: z.number().optional(),
        expired: z.boolean().optional(),
        scopes: z.array(z.string()).optional(),
        nextStep: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    async () =>
      guard(async () => {
        const s = await client.authStatus();
        let nextStep: string | undefined;
        if (!s.clientConfigured) nextStep = "Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET (see .env.example), then run `npm run auth`.";
        else if (!s.authenticated) nextStep = "Run `npm run auth` in the whoop-mcp directory to sign in.";
        const summary = s.authenticated
          ? `Connected. Access token ${s.expired ? "expired (will refresh on next call)" : `valid for ${s.expiresInSeconds}s`}. Scopes: ${
              s.scopes?.join(", ") ?? "unknown"
            }.`
          : `Not connected. ${nextStep}`;
        return ok(summary, { ...s, nextStep });
      }),
  );
}
