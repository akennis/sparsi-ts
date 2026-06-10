/** Time helpers, composed inside op functions. */

export const nowISO = (): string => new Date().toISOString();
export const unixSeconds = (): number => Math.floor(Date.now() / 1000);

export const addSeconds = (date: Date, n: number): Date =>
  new Date(date.getTime() + n * 1000);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Time op catalog: CityTimeOp returns the current local time for a supported city.
// ─────────────────────────────────────────────────────────────────────────────

export const CityTimeOpDescription = `CityTimeOp: returns the current time for a supported city.
  Input:  City *string — must be "New York" or "Tokyo"; any other value is a graph execution error.
  Output: Result string — current local time formatted as RFC3339.`;

const cityTimezones: Record<string, string> = {
  "New York": "America/New_York",
  Tokyo: "Asia/Tokyo",
};

/** Parses an Intl "longOffset" string (e.g. "GMT-04:00", "GMT+09:00", "GMT"). */
function parseLongOffset(longOffset: string): string {
  const m = longOffset.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return "+00:00"; // bare "GMT" === UTC
  return `${m[1]}${m[2]!.padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`;
}

/**
 * Formats `date` in the given IANA timezone as RFC3339 (`…±HH:MM`). The offset is
 * read directly from the zone's "longOffset" name (the exact IANA offset, correct
 * across DST) rather than back-computed from a UTC delta. Throws a `CityTimeOp:`
 * error if the zone can't be loaded or silently fell back to UTC (missing ICU/tz
 * data).
 */
function formatRFC3339InZone(date: Date, timeZone: string): string {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "longOffset",
    });
  } catch (err) {
    throw new Error(
      `CityTimeOp: failed to load timezone "${timeZone}": ${(err as Error).message}`,
    );
  }
  if (dtf.resolvedOptions().timeZone !== timeZone) {
    throw new Error(
      `CityTimeOp: failed to load timezone "${timeZone}": zone did not apply (missing ICU/timezone data?)`,
    );
  }
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour!;
  const offset = parseLongOffset(parts.timeZoneName ?? "");
  // RFC3339 renders a zero UTC offset as the literal "Z", not "+00:00".
  const zone = offset === "+00:00" ? "Z" : offset;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${zone}`;
}

/** Current time in `city` (only "New York" / "Tokyo") as RFC3339. */
export function cityTime(city: string, now: Date = new Date()): string {
  const tzName = cityTimezones[city];
  if (tzName === undefined)
    throw new Error(
      `CityTimeOp: unsupported city "${city}" (supported: "New York", "Tokyo")`,
    );
  return formatRFC3339InZone(now, tzName);
}
