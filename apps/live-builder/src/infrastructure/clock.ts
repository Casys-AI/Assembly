import type { ClockPort } from "../application/work/runtime/ports.ts";

/** Wall time is acquired only at the adapter boundary. */
export class SystemClock implements ClockPort {
  now(): string {
    return new Date().toISOString();
  }
}
