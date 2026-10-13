export function msToHm(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "n/a";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function msToHours(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return round(ms / 3_600_000, 2);
}

export function kjToKcal(kj: number | null | undefined): number | null {
  if (kj === null || kj === undefined || !Number.isFinite(kj)) return null;
  return Math.round(kj / 4.184);
}

export function round(n: number | null | undefined, digits = 1): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "n/a" : `${Math.round(n)}%`;
}

export function num(n: number | null | undefined, digits = 1, unit = ""): string {
  const r = round(n, digits);
  return r === null ? "n/a" : `${r}${unit}`;
}

export function metersToKm(m: number | null | undefined): number | null {
  return m === null || m === undefined ? null : round(m / 1000, 2);
}

/** Safe JSON for content blocks. */
export function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}
