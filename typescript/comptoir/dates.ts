// Dates like Python's datetime module, on days written YYYY-MM-DD (chapters 13 and 15): read a date
// like date.fromisoformat, add days, find the Monday of a week, the day of the week.

export const utcDay = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
export const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** date + timedelta(days=n). */
export const addDays = (day: string, n: number): string => iso(new Date(utcDay(day).getTime() + n * 86_400_000));

/** The Monday of a day's week (weekday() is 0 on Monday). */
export const mondayOf = (day: string): string => addDays(day, -((utcDay(day).getUTCDay() + 6) % 7));

/**
 * Python's date.fromisoformat(): “2026-10-21”, “20261021”, and ISO weeks (“2026-W43”, “2026-W43-3”,
 * “2026W433”). Returns the day in the YYYY-MM-DD format, or null if the text is not a date.
 */
export function readDate(text: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (year < 1 || month < 1 || month > 12 || day < 1) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCFullYear(year); // years before 100 are not shifted by 1900
    return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? iso(d).padStart(10, "0") : null;
  }
  m = /^(\d{4})-W(\d{2})(?:-(\d))?$/.exec(text) ?? /^(\d{4})W(\d{2})(\d)?$/.exec(text);
  if (!m) return null;
  const [year, week, day] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)];
  if (year < 1 || day < 1 || day > 7 || week < 1) return null;
  // The Monday of week 1: the one of the week of January 4.
  const fourth = new Date(Date.UTC(year, 0, 4));
  fourth.setUTCFullYear(year);
  const monday1 = fourth.getTime() - ((fourth.getUTCDay() + 6) % 7) * 86_400_000;
  // A year has 53 weeks if it starts on a Thursday, or on a Wednesday when it is a leap year.
  const first = (fourth.getUTCDay() + 6 - 3 + 7) % 7; // day of the week of January 1, Monday = 0
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (week > (first === 3 || (first === 2 && leap) ? 53 : 52)) return null;
  return iso(new Date(monday1 + ((week - 1) * 7 + day - 1) * 86_400_000)).padStart(10, "0");
}


/** Python's weekday(): 0 on Monday, 6 on Sunday. */
export const weekday = (day: string): number => (utcDay(day).getUTCDay() + 6) % 7;
