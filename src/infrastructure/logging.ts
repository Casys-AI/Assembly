/** Single technical logger (D-Log): LogTape, edges only.
 *
 * `domain/` stays silent and `application/` reports through its coded errors;
 * only composition, adapters and worker processes import this module. Each log
 * line carries the coded-error shape `{code, context, recovery}` (convention
 * A1) plus `caseId`/`invocationId` when the call site has them, so a technical
 * line joins the business journal (`application/work/operators/journal.ts`)
 * instead of floating free. The journal itself is untouched.
 *
 * Level comes from `ASSEMBLY_LOG_LEVEL` (`trace`/`debug`/`info`/`warning`/
 * `error`/`fatal`, `warn` accepted for `warning`, default `info`). The sink is
 * pretty in development (`ASSEMBLY_ENV=development|dev`) and JSON lines
 * otherwise. Both sinks keep `console.*` level semantics (`info`->stdout,
 * `warning`/`error`->stderr); the dev formatter appends leftover properties so
 * error detail that direct console writes used to print is not lost.
 */
import {
  configure,
  type ConsoleFormatter,
  defaultConsoleFormatter,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  type Logger,
  type LogLevel,
  type LogRecord,
  type Sink,
  type TextFormatter,
} from "@logtape/logtape";
import { type EnvironmentReader, readAssemblyEnv } from "./environment.ts";

/** One category per adapter family / process (D-Log). */
export const TECHNICAL_LOG_CATEGORIES = [
  "http",
  "toolkit-worker",
  "semantic-process",
  "scheduler",
  "composition",
] as const;
export type TechnicalLogCategory = typeof TECHNICAL_LOG_CATEGORIES[number];

/** Structured fields (convention A1) + correlation ids. */
export interface TechnicalLogProperties {
  code?: string;
  context?: unknown;
  recovery?: string;
  caseId?: string;
  invocationId?: string;
  [key: string]: unknown;
}

const defaultReadEnv: EnvironmentReader = (key) => Deno.env.get(key);

const LOG_LEVELS: ReadonlySet<string> = new Set([
  "trace",
  "debug",
  "info",
  "warning",
  "error",
  "fatal",
]);

/** Level from the environment; unknown or missing values fall back to `info`. */
export function resolveTechnicalLogLevel(
  readEnv: EnvironmentReader = defaultReadEnv,
): LogLevel {
  const raw = readAssemblyEnv("ASSEMBLY_LOG_LEVEL", readEnv)?.trim()
    .toLowerCase();
  const level = raw === "warn" ? "warning" : raw;
  return level !== undefined && LOG_LEVELS.has(level)
    ? (level as LogLevel)
    : "info";
}

/** JSON everywhere except an explicit development environment. */
export function isTechnicalLogJson(
  readEnv: EnvironmentReader = defaultReadEnv,
): boolean {
  const env = readAssemblyEnv("ASSEMBLY_ENV", readEnv)?.trim().toLowerCase();
  return env !== "development" && env !== "dev";
}

/** Preserve nested Error and AggregateError diagnostics in the private log. */
function errorStack(
  error: object,
  seen = new Set<object>(),
): string | undefined {
  if (seen.has(error)) return undefined;
  seen.add(error);
  const record = error as { stack?: unknown; cause?: unknown };
  const nested = [
    ...(record.cause === undefined ? [] : [record.cause]),
    ...(error instanceof AggregateError ? error.errors : []),
  ].map((cause) =>
    typeof cause === "object" && cause !== null
      ? errorStack(cause, seen)
      : String(cause)
  ).filter((stack) => stack !== undefined);
  return [
    typeof record.stack === "string" ? record.stack : undefined,
    ...nested,
  ]
    .filter((stack) => stack !== undefined).join("\nCaused by: ") || undefined;
}

/** Extract `{code, context, recovery}` plus error detail from anything thrown. */
export function errorLogProperties(error: unknown): TechnicalLogProperties {
  if (typeof error !== "object" || error === null) {
    return { error: String(error) };
  }
  const record = error as {
    code?: unknown;
    context?: unknown;
    recovery?: unknown;
    message?: unknown;
    stack?: unknown;
  };
  const stack = errorStack(error);
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(record.context !== undefined ? { context: record.context } : {}),
    ...(typeof record.recovery === "string"
      ? { recovery: record.recovery }
      : {}),
    ...(typeof record.message === "string" ? { error: record.message } : {}),
    ...(stack ? { stack } : {}),
  };
}

/** Category logger; safe to hold at module scope before configuration. */
export function technicalLogger(category: TechnicalLogCategory): Logger {
  return getLogger(category);
}

function safeJson(value: unknown): string {
  const seen = new Set<unknown>();
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === "object" && nested !== null) {
      if (seen.has(nested)) return "[Circular]";
      seen.add(nested);
    }
    return nested;
  }) ?? "null";
}

/** Pretty in dev (message + leftover properties), JSON lines otherwise. */
export function technicalLogFormatter(json: true): TextFormatter;
export function technicalLogFormatter(json: boolean): ConsoleFormatter;
export function technicalLogFormatter(
  json: boolean,
): TextFormatter | ConsoleFormatter {
  if (json) return getJsonLinesFormatter();
  return (record: LogRecord): readonly unknown[] => {
    const parts = defaultConsoleFormatter(record);
    if (Object.keys(record.properties).length === 0) return parts;
    return [...parts, safeJson(record.properties)];
  };
}

export interface TechnicalLoggingOptions {
  readEnv?: EnvironmentReader;
  /** Overrides `ASSEMBLY_LOG_LEVEL`. */
  level?: LogLevel;
  /** Overrides the `ASSEMBLY_ENV` sink selection. */
  json?: boolean;
  /** Overrides the console sink (tests capture records here). */
  sink?: Sink;
}

/** Configure the five technical categories once per process (entry points). */
export async function configureTechnicalLogging(
  options: TechnicalLoggingOptions = {},
): Promise<void> {
  const readEnv = options.readEnv ?? defaultReadEnv;
  const lowestLevel = options.level ?? resolveTechnicalLogLevel(readEnv);
  const json = options.json ?? isTechnicalLogJson(readEnv);
  const sink = options.sink ??
    getConsoleSink({ formatter: technicalLogFormatter(json) });
  await configure({
    sinks: { technical: sink },
    loggers: [
      ...TECHNICAL_LOG_CATEGORIES.map((category) => ({
        category,
        sinks: ["technical"],
        lowestLevel,
      })),
      // Internal LogTape diagnostics at error level only: this also silences
      // the "loggers are configured" info notice on the meta logger.
      {
        category: ["logtape", "meta"],
        sinks: ["technical"],
        lowestLevel: "error",
      },
    ],
  });
}
