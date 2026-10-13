import type { QueryParams, WhoopClient } from "../whoop/client.js";
import { resolveRange } from "../util/dates.js";
import type { PageArgs, RangeArgs } from "./common.js";

export interface ListResult<T> {
  records: T[];
  count: number;
  next_token?: string | null;
  truncated?: boolean;
}

/** Shared implementation for WHOOP collection endpoints (cycles, recoveries, sleeps, workouts). */
export async function listRecords<T>(
  client: WhoopClient,
  path: string,
  args: RangeArgs & PageArgs,
  filter?: (r: T) => boolean,
): Promise<ListResult<T>> {
  const range = resolveRange(args);
  const params: QueryParams = { start: range.start, end: range.end };

  if (args.all) {
    // Fetch one extra to detect truncation without a second round-trip.
    const raw = await client.collect<T>(path, { ...params, limit: 25, nextToken: args.nextToken }, args.maxRecords + 1);
    const truncated = raw.length > args.maxRecords;
    const sliced = truncated ? raw.slice(0, args.maxRecords) : raw;
    const records = filter ? sliced.filter(filter) : sliced;
    return { records, count: records.length, truncated };
  }

  const page = await client.getPage<T>(path, { ...params, limit: args.limit, nextToken: args.nextToken });
  const records = filter ? (page.records ?? []).filter(filter) : (page.records ?? []);
  return { records, count: records.length, next_token: page.next_token ?? null };
}
