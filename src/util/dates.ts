const DAY_MS = 86_400_000;

export interface RangeInput {
  start?: string;
  end?: string;
  days?: number;
}

export interface ResolvedRange {
  start?: string;
  end?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse user-facing date input into a Date. Date-only strings are local midnight. */
export function parseDateInput(input: string, opts: { endOfDay?: boolean; now?: Date } = {}): Date {
  const now = opts.now ?? new Date();
  const s = input.trim().toLowerCase();
  let d: Date;
  if (s === "now") return now;
  if (s === "today") d = startOfLocalDay(now);
  else if (s === "yesterday") d = startOfLocalDay(new Date(now.getTime() - DAY_MS));
  else if (DATE_ONLY.test(s)) {
    const [y, m, day] = s.split("-").map(Number) as [number, number, number];
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: "${input}". Use YYYY-MM-DD, an ISO-8601 timestamp, "today" or "yesterday".`);
    return d; // precise timestamp: no end-of-day adjustment
  }
  if (opts.endOfDay) d = new Date(d.getTime() + DAY_MS);
  return d;
}

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Resolve {start,end,days} into ISO strings for WHOOP's start/end query params. */
export function resolveRange(input: RangeInput, now: Date = new Date()): ResolvedRange {
  const out: ResolvedRange = {};
  if (input.days !== undefined) {
    out.start = new Date(now.getTime() - input.days * DAY_MS).toISOString();
  }
  if (input.start) out.start = parseDateInput(input.start, { now }).toISOString();
  if (input.end) out.end = parseDateInput(input.end, { endOfDay: true, now }).toISOString();
  if (out.start && out.end && out.start > out.end) {
    throw new Error(`start (${out.start}) must be before end (${out.end}).`);
  }
  return out;
}

/** Parse a WHOOP timezone_offset like "+05:30" / "-04:00" / "Z" into minutes. */
export function parseOffsetMinutes(offset: string | undefined | null): number {
  if (!offset || offset === "Z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/** The local calendar date (YYYY-MM-DD) of an instant, in the record's own timezone. */
export function localDateOf(iso: string, timezoneOffset?: string | null): string {
  const t = new Date(iso).getTime() + parseOffsetMinutes(timezoneOffset) * 60_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** YYYY-MM-DD in the machine's local timezone. */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}
