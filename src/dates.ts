// YAZIO stores timestamps as local user time without a zone ("YYYY-MM-DD HH:MM:SS").
// All defaults here therefore use the machine's local time zone (override with TZ).

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function today(now = new Date()): string {
  return formatDate(now);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return formatDate(new Date(y, m - 1, d + days));
}

// Typical meal times, used when an entry is logged for another day without a time.
const DAYTIME_DEFAULTS: Record<string, string> = {
  breakfast: '08:00:00',
  lunch: '12:30:00',
  dinner: '19:00:00',
  snack: '15:30:00',
};

// Builds the API timestamp. Explicit time wins; today falls back to "now";
// other days fall back to the meal's typical time or noon.
export function toApiDateTime(
  date: string,
  time?: string,
  daytime?: string,
  now = new Date()
): string {
  if (time) return `${date} ${time.length === 5 ? `${time}:00` : time}`;
  if (date === today(now)) return `${date} ${formatTime(now)}`;
  return `${date} ${(daytime && DAYTIME_DEFAULTS[daytime]) ?? '12:00:00'}`;
}

// The API answers HTTP 500 for start > end, so ranges are normalised first.
export function orderedRange(start: string, end: string): [string, string] {
  return start <= end ? [start, end] : [end, start];
}
