import assert from "node:assert/strict";
import {
  postgresClientSchema,
  postgresQualifiedTableIdentifier,
} from "./client-schema.ts";
import type { PrismaClient } from "./client.ts";

Deno.test("PostgreSQL raw SQL refuses foreign clients and unsafe table identifiers", () => {
  const foreign = {} as PrismaClient;
  assert.throws(
    () => postgresClientSchema(foreign),
    /Unregistered PostgreSQL client/,
  );
  assert.throws(
    () => postgresQualifiedTableIdentifier(foreign, "RuntimeState"),
    /Unregistered PostgreSQL client/,
  );
  for (
    const table of [
      "",
      "public.RuntimeState",
      'RuntimeState"; DROP TABLE x',
      "x y",
    ]
  ) {
    assert.throws(
      () => postgresQualifiedTableIdentifier(foreign, table),
      /Invalid PostgreSQL table identifier/,
    );
  }
});
