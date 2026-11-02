import { CaseError } from "../errors/case.ts";

export type CaseSchedule =
  | { kind: "every"; count: number; unit: "minute" | "hour" | "day" }
  | { kind: "daily-at"; hour: number; minute: number };

const units = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/** Validate native values. No schedule source text is interpreted by the host. */
export function validateCaseSchedule(
  value: unknown,
  context: Record<string, string> = {},
): CaseSchedule {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const schedule = value as CaseSchedule;
    if (Object.keys(schedule).length === 3) {
      if (
        schedule.kind === "every" && Object.hasOwn(units, schedule.unit) &&
        Number.isSafeInteger(schedule.count) && schedule.count >= 1 &&
        Number.isSafeInteger(schedule.count * units[schedule.unit])
      ) {
        return { kind: "every", count: schedule.count, unit: schedule.unit };
      }
      if (
        schedule.kind === "daily-at" && Number.isSafeInteger(schedule.hour) &&
        schedule.hour >= 0 && schedule.hour <= 23 &&
        Number.isSafeInteger(schedule.minute) && schedule.minute >= 0 &&
        schedule.minute <= 59
      ) {
        return {
          kind: "daily-at",
          hour: schedule.hour,
          minute: schedule.minute,
        };
      }
    }
  }
  throw new CaseError(
    "INVALID_SCHEDULE",
    "Invalid typed Case schedule",
    context,
    "Declare Every with count >= 1 and ScheduleUnit minute/hour/day, or DailyAt with hour 0..23 and minute 0..59 (UTC), then propose a corrected model revision.",
  );
}

/** Presentation only: this text is never read back as scheduling authority. */
export function formatCaseSchedule(value: CaseSchedule): string {
  const schedule = validateCaseSchedule(value);
  return schedule.kind === "every"
    ? `every ${schedule.count} ${schedule.unit}${
      schedule.count === 1 ? "" : "s"
    }`
    : `daily at ${String(schedule.hour).padStart(2, "0")}:${
      String(schedule.minute).padStart(2, "0")
    } UTC`;
}

/** Strictly future occurrence; missed intervals are coalesced without a burst. */
export function nextCaseOccurrence(
  schedule: CaseSchedule,
  after: string,
  anchor: string = after,
): string {
  const parsed = validateCaseSchedule(schedule);
  const afterMs = Date.parse(after), anchorMs = Date.parse(anchor);
  let next: number;
  if (parsed.kind === "every") {
    const milliseconds = parsed.count * units[parsed.unit];
    next = anchorMs +
      Math.max(1, Math.floor((afterMs - anchorMs) / milliseconds) + 1) *
        milliseconds;
  } else {
    const date = new Date(afterMs);
    date.setUTCHours(parsed.hour, parsed.minute, 0, 0);
    if (date.getTime() <= afterMs) date.setUTCDate(date.getUTCDate() + 1);
    next = date.getTime();
  }
  if (
    !Number.isFinite(afterMs) || !Number.isFinite(anchorMs) ||
    !Number.isFinite(new Date(next).getTime())
  ) {
    throw new CaseError(
      "INVALID_SCHEDULE",
      "Case schedule exceeds the supported date range",
      { after, anchor },
      "Use a valid UTC clock value and a shorter recurrence interval.",
    );
  }
  return new Date(next).toISOString();
}
