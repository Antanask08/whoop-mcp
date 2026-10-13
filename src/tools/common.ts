import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { WhoopApiError, WhoopAuthError } from "../whoop/client.js";
import { json } from "../util/format.js";

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// ---------- shared input schemas ----------

export const rangeShape = {
  start: z
    .string()
    .optional()
    .describe('Earliest record start, inclusive. ISO-8601 timestamp, YYYY-MM-DD (local midnight), "today" or "yesterday".'),
  end: z
    .string()
    .optional()
    .describe("Latest time, inclusive. ISO-8601 timestamp or YYYY-MM-DD (end of that local day). Defaults to now."),
  days: z.number().int().min(1).max(90).optional().describe("Shortcut: last N days ending now. Ignored if `start` is given."),
};

export const pageShape = {
  limit: z.number().int().min(1).max(25).default(10).describe("Records per page (WHOOP max 25)."),
  nextToken: z.string().optional().describe("Pagination token from a previous response's `next_token`."),
  all: z.boolean().default(false).describe("Auto-paginate and return up to `maxRecords` records instead of one page."),
  maxRecords: z.number().int().min(1).max(500).default(100).describe("Cap when `all` is true."),
};

export type RangeArgs = { start?: string; end?: string; days?: number };
export type PageArgs = { limit: number; nextToken?: string; all: boolean; maxRecords: number };

// ---------- shared output schemas (loose: WHOOP may add fields) ----------

const scoreState = z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]);

export const cycleSchema = z.looseObject({
  id: z.number(),
  start: z.string(),
  end: z.string().nullable().optional(),
  timezone_offset: z.string().optional(),
  score_state: scoreState,
  score: z
    .looseObject({ strain: z.number(), kilojoule: z.number(), average_heart_rate: z.number(), max_heart_rate: z.number() })
    .nullable()
    .optional(),
  step_count: z.number().nullable().optional(),
});

export const recoverySchema = z.looseObject({
  cycle_id: z.number(),
  sleep_id: z.string(),
  score_state: scoreState,
  score: z
    .looseObject({
      user_calibrating: z.boolean(),
      recovery_score: z.number(),
      resting_heart_rate: z.number(),
      hrv_rmssd_milli: z.number(),
      spo2_percentage: z.number().nullable().optional(),
      skin_temp_celsius: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const sleepSchema = z.looseObject({
  id: z.string(),
  cycle_id: z.number().nullable().optional(),
  start: z.string(),
  end: z.string(),
  timezone_offset: z.string().optional(),
  nap: z.boolean(),
  score_state: scoreState,
  score: z.looseObject({}).nullable().optional(),
});

export const workoutSchema = z.looseObject({
  id: z.string(),
  start: z.string(),
  end: z.string(),
  timezone_offset: z.string().optional(),
  sport_name: z.string().nullable().optional(),
  sport_id: z.number().nullable().optional(),
  score_state: scoreState,
  score: z.looseObject({}).nullable().optional(),
});

export function listSchema<T extends z.ZodType>(item: T) {
  return z.object({
    records: z.array(item),
    count: z.number(),
    next_token: z.string().nullable().optional().describe("Pass as `nextToken` to fetch the next page. Absent when `all` was used or no more pages."),
    truncated: z.boolean().optional().describe("True when `all` stopped at `maxRecords`."),
  });
}

// ---------- result helpers ----------

export function ok<T extends Record<string, unknown>>(summary: string, structured: T): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${json(structured)}` }],
    structuredContent: structured,
  };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function errorMessage(err: unknown): string {
  if (err instanceof WhoopAuthError) return err.message;
  if (err instanceof WhoopApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Run a tool body, converting thrown errors into `isError` results. */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(errorMessage(err));
  }
}
