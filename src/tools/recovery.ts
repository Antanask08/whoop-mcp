import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WhoopClient } from "../whoop/client.js";
import type { Recovery } from "../whoop/types.js";
import { guard, listSchema, ok, pageShape, rangeShape, READ_ONLY, recoverySchema } from "./common.js";
import { describeRecovery } from "./cycles.js";
import { listRecords } from "./list.js";

export function registerRecoveryTools(server: McpServer, client: WhoopClient): void {
  server.registerTool(
    "whoop_list_recoveries",
    {
      title: "List recoveries",
      description:
        "List daily recovery scores (0-100%) with HRV (ms), resting heart rate, SpO2 and skin temperature. Newest first; sorted by the start of the related sleep.",
      inputSchema: z.object({ ...rangeShape, ...pageShape }),
      outputSchema: listSchema(recoverySchema),
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(async () => {
        const result = await listRecords<Recovery>(client, "/v2/recovery", args);
        const lines = result.records.slice(0, 10).map(describeRecovery).join("\n");
        return ok(`${result.count} recovery record(s)${result.next_token ? " (more available)" : ""}\n${lines}`, { ...result });
      }),
  );
}
