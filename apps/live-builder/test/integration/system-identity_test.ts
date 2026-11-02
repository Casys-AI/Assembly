import assert from "node:assert/strict";
import {
  resolveHostPrimaryOperator,
  resolveHostSystemId,
} from "../../src/infrastructure/system-identity.ts";

Deno.test("PG-4 host identities persist without selecting a newer source owner", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "assembly-host-identity-",
  });
  try {
    const systemId = await resolveHostSystemId(directory);
    assert.equal(await resolveHostSystemId(directory), systemId);
    assert.equal(
      await resolveHostSystemId(
        directory,
        "00000000-0000-4000-8000-000000000001",
      ),
      "00000000-0000-4000-8000-000000000001",
    );
    let initializations = 0;
    const scope = { directory, projectId: "git:source-project", systemId };
    assert.equal(
      await resolveHostPrimaryOperator({
        ...scope,
        hasPersistedRuntimes: () => Promise.resolve(false),
        initialize: () => {
          initializations++;
          return Promise.resolve("admitted-primary");
        },
      }),
      "admitted-primary",
    );
    assert.equal(
      await resolveHostPrimaryOperator({
        ...scope,
        hasPersistedRuntimes: () => Promise.resolve(true),
        initialize: () => {
          initializations++;
          return Promise.resolve("unadopted-head-owner");
        },
      }),
      "admitted-primary",
    );
    assert.equal(initializations, 1);
    await assert.rejects(
      resolveHostPrimaryOperator({
        ...scope,
        projectId: "git:foreign-project",
        hasPersistedRuntimes: () => Promise.resolve(false),
        initialize: () => Promise.resolve("foreign"),
      }),
      /does not match/,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("PG-4 missing primary locator cannot silently replace persisted runtimes", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "assembly-host-missing-owner-",
  });
  try {
    let initialized = false;
    await assert.rejects(
      resolveHostPrimaryOperator({
        directory,
        projectId: "project",
        systemId: "system",
        hasPersistedRuntimes: () => Promise.resolve(true),
        initialize: () => {
          initialized = true;
          return Promise.resolve("new-owner");
        },
      }),
      /locator is missing/,
    );
    assert.equal(initialized, false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
