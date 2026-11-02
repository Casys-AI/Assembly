import assert from "node:assert/strict";
import {
  formatCaseSchedule,
  nextCaseOccurrence,
  validateCaseSchedule,
} from "./case-schedule.ts";
import { CaseError } from "../errors/case.ts";

Deno.test("typed schedules enforce bounded numeric values without text parsing", () => {
  const every = { kind: "every", count: 3, unit: "hour" } as const;
  assert.deepEqual(validateCaseSchedule(every), every);
  assert.equal(formatCaseSchedule(every), "every 3 hours");
  assert.equal(
    formatCaseSchedule({ kind: "every", count: 1, unit: "day" }),
    "every 1 day",
  );
  assert.equal(
    formatCaseSchedule({ kind: "daily-at", hour: 8, minute: 0 }),
    "daily at 08:00 UTC",
  );
  for (
    const value of [
      "every 1m",
      null,
      {},
      { kind: "every", count: 0, unit: "minute" },
      { kind: "every", count: 1.5, unit: "hour" },
      { kind: "every", count: 1, unit: "week" },
      { kind: "every", count: Number.MAX_SAFE_INTEGER, unit: "day" },
      { kind: "daily-at", hour: 24, minute: 0 },
      { kind: "daily-at", hour: 8, minute: 60 },
      { kind: "daily-at", hour: -1, minute: 0 },
      { kind: "daily-at", hour: 1, minute: NaN },
    ]
  ) {
    assert.throws(
      () => validateCaseSchedule(value, { caseTypeId: "job" }),
      (error) =>
        error instanceof CaseError && error.code === "INVALID_SCHEDULE" &&
        error.context?.caseTypeId === "job" && !!error.recovery,
    );
  }
});

Deno.test("next typed Case occurrence skips missed intervals without losing their phase", () => {
  const birth = "2026-10-24T08:00:00.000Z";
  const hourly = { kind: "every", count: 1, unit: "hour" } as const;
  const daily = { kind: "daily-at", hour: 9, minute: 0 } as const;
  assert.equal(nextCaseOccurrence(hourly, birth), "2026-10-24T09:00:00.000Z");
  assert.equal(
    nextCaseOccurrence(hourly, "2026-10-27T08:12:00.000Z", birth),
    "2026-10-27T09:00:00.000Z",
  );
  assert.equal(
    nextCaseOccurrence(hourly, "2026-10-27T09:00:00.000Z", birth),
    "2026-10-27T10:00:00.000Z",
  );
  assert.equal(nextCaseOccurrence(daily, birth), "2026-10-24T09:00:00.000Z");
  assert.equal(
    nextCaseOccurrence(daily, "2026-10-24T09:00:00.000Z"),
    "2026-10-25T09:00:00.000Z",
  );
  assert.equal(
    nextCaseOccurrence(
      { kind: "daily-at", hour: 0, minute: 0 },
      "2026-12-31T23:59:59.999Z",
    ),
    "2027-01-01T00:00:00.000Z",
  );
  assert.throws(() => nextCaseOccurrence(hourly, "invalid"), CaseError);
});
