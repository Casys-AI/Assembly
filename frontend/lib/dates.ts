/** Compact English calendar date, shared by versions and Cases in UTC. */
const SHORT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
export const shortDate = (at: string): string =>
  SHORT_DATE.format(new Date(at));
