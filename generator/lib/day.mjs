// What day an edition belongs to.
//
// The feed has a circulation of one, and he is in Melbourne, so an "edition day"
// is a Melbourne calendar day. `published_at` stays a UTC instant — an instant is
// not a date, and re-stamping it would break the promise in archive.mjs that an
// item is dated once, ever — but every place that turns an instant into the day
// it belongs to comes through here.
//
// Slicing the ISO string was only ever correct by accident. The publish cron runs
// at 09:00 UTC, which is 19:00 AEST (20:00 AEDT) the same calendar day, so UTC and
// Melbourne agreed. Any run after 14:00 UTC — a manual dispatch, a retry, a
// rescheduled routine — is already tomorrow in Melbourne, and the edition landed
// under yesterday's date, merged into an edition that had already been published.

export const TZ = "Australia/Melbourne";

// en-CA formats as YYYY-MM-DD, which is the key format the archive already uses.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The Melbourne calendar day containing `when` (a Date, an ISO string, or ms).
 * Returns "" for anything unparseable, matching what the old `.slice(0, 10)`
 * did with an empty or missing timestamp.
 */
export function editionDay(when = new Date()) {
  const at = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(at.getTime())) return "";
  return fmt.format(at);
}
