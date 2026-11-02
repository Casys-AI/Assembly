import { deepEqual, equal, match, ok } from "node:assert/strict";
import { type LogRecord, reset } from "@logtape/logtape";
import {
  configureTechnicalLogging,
  errorLogProperties,
  isTechnicalLogJson,
  resolveTechnicalLogLevel,
  TECHNICAL_LOG_CATEGORIES,
  type TechnicalLogCategory,
  technicalLogFormatter,
  technicalLogger,
} from "./logging.ts";

const read = (values: Record<string, string>) => (key: string) => values[key];

Deno.test("technical logging exposes one category per adapter family", () => {
  deepEqual([...TECHNICAL_LOG_CATEGORIES], [
    "http",
    "toolkit-worker",
    "semantic-process",
    "scheduler",
    "composition",
  ]);
  for (const category of TECHNICAL_LOG_CATEGORIES) {
    deepEqual(technicalLogger(category).category, [category]);
  }
});

Deno.test("technical log level comes from the environment", () => {
  equal(resolveTechnicalLogLevel(read({})), "info");
  equal(
    resolveTechnicalLogLevel(read({ ASSEMBLY_LOG_LEVEL: "debug" })),
    "debug",
  );
  equal(
    resolveTechnicalLogLevel(read({ ASSEMBLY_LOG_LEVEL: "WARN" })),
    "warning",
  );
  equal(
    resolveTechnicalLogLevel(read({ ASE_LOG_LEVEL: "error" })),
    "error",
  );
  equal(resolveTechnicalLogLevel(read({ ASSEMBLY_LOG_LEVEL: "nope" })), "info");
});

Deno.test("technical log sink is pretty in development, JSON otherwise", () => {
  equal(isTechnicalLogJson(read({})), true);
  equal(isTechnicalLogJson(read({ ASSEMBLY_ENV: "production" })), true);
  equal(isTechnicalLogJson(read({ ASSEMBLY_ENV: "development" })), false);
  equal(isTechnicalLogJson(read({ ASSEMBLY_ENV: "dev" })), false);
});

Deno.test("technical errors keep the coded shape plus error detail", () => {
  const coded = Object.assign(new Error("boom"), {
    code: "SOME_CODE",
    context: { path: "p" },
    recovery: "fix it",
  });
  const properties = errorLogProperties(coded);
  equal(properties.code, "SOME_CODE");
  deepEqual(properties.context, { path: "p" });
  equal(properties.recovery, "fix it");
  equal(properties.error, "boom");
  ok(typeof properties.stack === "string");
  deepEqual(errorLogProperties("plain"), { error: "plain" });
  deepEqual(errorLogProperties(undefined), { error: "undefined" });
});

async function captured(
  emit: () => void,
  options: { level?: "debug" | "warning"; json?: boolean } = {},
): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configureTechnicalLogging({
    level: options.level ?? "debug",
    json: options.json ?? true,
    sink: (record) => {
      records.push(record);
    },
  });
  try {
    emit();
  } finally {
    await reset();
  }
  return records;
}

Deno.test("technical logging routes every category and enforces the level", async () => {
  const records = await captured(() => {
    for (const category of TECHNICAL_LOG_CATEGORIES) {
      technicalLogger(category).info(`hello from ${category}`, {
        code: "HELLO",
      });
    }
    technicalLogger("composition").info("dropped below level test");
    technicalLogger("unconfigured" as TechnicalLogCategory).error("dropped");
  }, { level: "warning" });
  // `info` is below `warning`: every category emission is dropped, as is the
  // unknown category.
  equal(records.length, 0);
  const kept = await captured(() => {
    for (const category of TECHNICAL_LOG_CATEGORIES) {
      technicalLogger(category).warn(`hello from ${category}`, {
        code: "HELLO",
      });
    }
  }, { level: "warning" });
  equal(kept.length, 5);
  deepEqual(
    kept.map((record) => record.category),
    TECHNICAL_LOG_CATEGORIES.map((category) => [category]),
  );
  ok(kept.every((record) => record.level === "warning"));
});

Deno.test("technical JSON sink shape carries level, logger and properties", async () => {
  const records = await captured(() => {
    technicalLogger("composition").error("Decided changes could not resume", {
      code: "RESUME_FAILED",
      context: { changeId: "c1" },
      recovery: "retry",
      error: "boom",
    });
  });
  equal(records.length, 1);
  const line = technicalLogFormatter(true)(records[0]);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  equal(parsed.level, "ERROR");
  equal(parsed.logger, "composition");
  equal(parsed.message, "Decided changes could not resume");
  deepEqual(parsed.properties, {
    code: "RESUME_FAILED",
    context: { changeId: "c1" },
    recovery: "retry",
    error: "boom",
  });
  ok(typeof parsed["@timestamp"] === "string");
});

Deno.test("technical dev sink keeps the message and the leftover properties", async () => {
  const records = await captured(() => {
    technicalLogger("http").warn("Initial model version notification failed", {
      code: "W",
      error: "boom",
    });
  });
  equal(records.length, 1);
  const parts = technicalLogFormatter(false)(records[0]);
  const flat = parts.map((part) => String(part)).join(" ");
  match(flat, /Initial model version notification failed/);
  match(flat, /"code":"W"/);
  match(flat, /"error":"boom"/);
});
