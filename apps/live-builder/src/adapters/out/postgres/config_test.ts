import assert from "node:assert/strict";
import {
  postgresClientConfiguration,
  postgresPrismaUtcConnectionString,
} from "./config.ts";
import { postgresBigInt, postgresSafeInteger } from "./numbers.ts";
import { assertPostgresRuntimeScope } from "./scope.ts";

Deno.test("PostgreSQL configuration rejects invalid inputs without disclosing connection material", () => {
  const privateSentinel = "private-config-sentinel";
  for (
    const input of [
      undefined,
      "",
      privateSentinel,
      `https://user:${privateSentinel}@host/db`,
      `postgres://user:${privateSentinel}@host/`,
    ]
  ) {
    let message = "";
    try {
      postgresClientConfiguration(input);
      assert.fail("invalid configuration was accepted");
    } catch (error) {
      assert(error instanceof Error);
      message = error.message;
    }
    assert.match(message, /PostgreSQL connection configuration/);
    assert(!message.includes(privateSentinel));
  }
  const url = "postgresql://localhost/assembly_test";
  for (const size of [0, -1, 33, 1.5, Number.NaN]) {
    assert.throws(() => postgresClientConfiguration(url, size));
  }
  assert.throws(() =>
    postgresClientConfiguration(url, 1, 'foreign"; DROP SCHEMA public')
  );
  assert.equal(postgresClientConfiguration(url).maxConnections, 4);
});

Deno.test("Prisma startup retains effective PostgreSQL options and sets UTC last", () => {
  const url =
    "postgresql://user:private@localhost/assembly_test?application_name=assembly";
  const env = new URL(
    postgresPrismaUtcConnectionString(
      url,
      "-c statement_timeout=5000 -c TimeZone=Asia/Taipei",
    ),
  );
  assert.equal(env.searchParams.get("application_name"), "assembly");
  assert.equal(
    env.searchParams.get("options"),
    "-c statement_timeout=5000 -c TimeZone=Asia/Taipei -c TimeZone=UTC",
  );
  const explicit = new URL(
    postgresPrismaUtcConnectionString(
      `${url}&options=-c%20work_mem%3D4MB`,
      "-c statement_timeout=5000",
    ),
  );
  assert.equal(
    explicit.searchParams.get("options"),
    "-c work_mem=4MB -c TimeZone=UTC",
  );
  assert.throws(
    () =>
      postgresPrismaUtcConnectionString(
        `${url}&options=one&options=two`,
        undefined,
      ),
    /ambiguous/,
  );
  assert.throws(
    () => postgresPrismaUtcConnectionString(url, "private\\"),
    (error: Error) => !error.message.includes("private"),
  );
});

Deno.test("PostgreSQL scope has no implicit project, space or operator fallback", () => {
  for (
    const key of [
      "projectId",
      "systemId",
      "executionSpaceId",
      "operatorId",
    ] as const
  ) {
    assert.throws(() =>
      assertPostgresRuntimeScope({
        projectId: "p",
        systemId: "s",
        executionSpaceId: "x",
        operatorId: "o",
        [key]: "",
      })
    );
  }
});

Deno.test("PostgreSQL BIGINT boundaries preserve safe integer revisions", () => {
  for (const value of [0, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    assert.equal(postgresSafeInteger(postgresBigInt(value)), value);
  }
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => postgresBigInt(value));
  }
  assert.throws(() => postgresSafeInteger(-1n));
  assert.throws(() =>
    postgresSafeInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
  );
});
