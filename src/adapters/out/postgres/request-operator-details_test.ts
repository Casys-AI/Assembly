import { deepStrictEqual, equal } from "node:assert/strict";
import { PostgresRequestOperatorDetailsObservations } from "./request-operator-details.ts";
import type { PrismaClient } from "./client.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import type { RequestExecutionBinding } from "../../../application/model/evolution/request-adoption-ports.ts";

Deno.test("persisted Request details select exact skill scope with no runtime factory or writes", async () => {
  const queries: unknown[] = [], bindingReads: string[] = [];
  // Any accessor except the single persisted catalogue query is an error,
  // including runtime initialization and operator/runtime upsert accessors.
  const client = new Proxy({}, {
    get(_target, key) {
      if (key !== "skillCatalog") {
        throw new Error(`Unexpected database access: ${String(key)}`);
      }
      return {
        findUnique(query: unknown) {
          queries.push(query);
          return Promise.resolve(null);
        },
      };
    },
  }) as PrismaClient;
  const observations = new PostgresRequestOperatorDetailsObservations(client, {
    read(record) {
      bindingReads.push(record.executionSpaceId);
      return Promise.resolve({} as RequestExecutionBinding);
    },
  });
  for (const executionSpaceId of ["space-a", "space-b"]) {
    const record = {
      scope: { projectId: "host", systemId: "system" },
      caseId: `case-${executionSpaceId}`,
      executionSpaceId,
      base: { requestOwner: { operatorId: "same-native" } },
    } as OpeningRecord;
    equal(await observations.skills(record), null);
    await observations.binding(record);
  }
  deepStrictEqual(bindingReads, ["space-a", "space-b"]);
  deepStrictEqual(
    queries,
    ["space-a", "space-b"].map((executionSpaceId) => ({
      where: {
        projectId_systemId_executionSpaceId_operatorId_ownerId: {
          projectId: "host",
          systemId: "system",
          executionSpaceId,
          operatorId: "same-native",
          ownerId: "same-native",
        },
      },
    })),
  );
});
