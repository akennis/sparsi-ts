/** Time helpers, composed inside op functions. */

export const nowISO = (): string => new Date().toISOString();
export const unixSeconds = (): number => Math.floor(Date.now() / 1000);

export const addSeconds = (date: Date, n: number): Date =>
  new Date(date.getTime() + n * 1000);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Faithful Go op catalog (sparsi-go library/time_ops.go). CityTimeOp mirrors the
// Go op's supported-city set and error wording exactly.
// ─────────────────────────────────────────────────────────────────────────────

export const CityTimeOpDescription = `CityTimeOp: returns the current time for a supported city.
  Input:  City *string — must be "New York" or "Tokyo"; any other value is a graph execution error.
  Output: Result string — current local time formatted as RFC3339.`;

const cityTimezones: Record<string, string> = {
  "New York": "America/New_York",
  Tokyo: "Asia/Tokyo",
};

/** Formats `date` in the given IANA timezone as RFC3339 (`…±HH:MM`). */
function formatRFC3339InZone(date: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour!;
  const asLocalUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMin = Math.round((asLocalUTC - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${sign}${oh}:${om}`;
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
