import { equal } from "node:assert/strict";
import { broadcastSse } from "../../src/infrastructure/http/sse.ts";
import { createSavedSystemsComposition } from "../../src/composition/saved-systems.ts";
import { registerPostgresClientSchema } from "../../src/adapters/out/postgres/client-schema.ts";
import type {
  Prisma,
  PrismaClient,
} from "../../src/adapters/out/postgres/client.ts";
import type { SavedSystemRow } from "../../src/adapters/out/postgres/saved-system-store.ts";
import { savedSystemDigest } from "../../src/domain/work/records/saved-systems.ts";
import type { SpaceController } from "../../src/domain/work/request-spaces/space-control.ts";
import {
  RELEASE_CATALOGUE_INVALIDATED,
  RELEASE_CATALOGUE_INVALIDATION,
} from "../../src/application/work/saved-systems/notifications.ts";
import { localSkillRelease } from "../../frontend/test/support/release-opening-fixture.ts";

Deno.test("production Release composition forwards only committed store mutations to the shared SSE encoder", async () => {
  const fixture = localSkillRelease("composed-release");
  const scope = fixture.origin;
  const source = {
    branch: fixture.source!.branch,
    sourceVersion: fixture.source!.sourceVersion,
  };
  const command = { saveKey: fixture.saveKey, ...fixture.metadata, source };
  const capture = {
    origin: scope,
    source: fixture.source,
    registeredOperatorIds: fixture.selectedOperators.map((operator) =>
      operator.operatorId
    ),
    operators: fixture.selectedOperators,
    admission: {
      operatorIds: fixture.selectedOperators.map((operator) =>
        operator.operatorId
      ),
      prerequisites: [],
    },
    prerequisites: [],
  };
  let row: SavedSystemRow = {
    id: fixture.id,
    saveKey: command.saveKey,
    commandDigest: await savedSystemDigest({
      scope,
      saveKey: command.saveKey,
      metadata: fixture.metadata,
      source,
    }),
    // Existing accepted history avoids inventing a fresh source/compiler path.
    creationAuthorization: "{}",
    metadata: JSON.stringify(fixture.metadata),
    capture: JSON.stringify(capture),
    createdAt: new Date(fixture.createdAt),
    status: "pending",
    revision: 0,
    manifest: null,
    digest: null,
    issues: "[]",
  };
  const commit = Promise.withResolvers<void>();
  let mutations = 0;
  const query = (_sql: Prisma.Sql) => Promise.resolve([row]);
  const tx = {
    executionSpace: { updateMany: () => Promise.resolve({ count: 1 }) },
    async $queryRaw(sql: Prisma.Sql) {
      if (!sql.sql.startsWith("UPDATE")) return [row];
      mutations++;
      const next = {
        ...row,
        status: "incomplete" as const,
        revision: row.revision + 1,
        issues: JSON.stringify(["EXACT_ASSET_UNAVAILABLE"]),
      };
      await commit.promise;
      row = next;
      return [row];
    },
  };
  const client = {
    executionSpace: { findUnique: () => Promise.resolve({}) },
    sourceRepository: {
      findUnique: () => Promise.resolve({ sourceScopeId: "source-scope" }),
    },
    $queryRaw: query,
    $transaction: (work: (selected: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  registerPostgresClientSchema(client, "controlled");
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      clients.add(controller);
    },
  });
  const reader = stream.getReader();
  let notifications = 0;
  type CompositionOptions = Parameters<typeof createSavedSystemsComposition>[0];
  const composition = createSavedSystemsComposition({
    client,
    scope,
    projectDir: "/unused-no-filesystem",
    repositoryId: fixture.source!.repositoryId,
    sourceScopeId: "source-scope",
    primaryOperatorId: fixture.selectedOperators[0].operatorId,
    // Cold native/source ports are intentionally absent: this witness repairs
    // already accepted retention using a controlled asset failure only.
    buildService: {} as CompositionOptions["buildService"],
    vault: {} as CompositionOptions["vault"],
    cache: { get: () => Promise.reject(new Error("unused cache")) },
    retainCommit: () => Promise.reject(new Error("unused native/source port")),
    creation: {
      authorize: (intent, controller) =>
        Promise.resolve({ intent, controller }),
      revalidate: () => Promise.resolve(),
    },
    creationGuard: {
      assertLocked: () => Promise.resolve(null as never),
      assertNativeLocked: () => Promise.resolve(null as never),
    },
    notifyCatalogue() {
      notifications++;
      broadcastSse(
        clients,
        RELEASE_CATALOGUE_INVALIDATED,
        RELEASE_CATALOGUE_INVALIDATION,
      );
    },
  });
  composition.assets.retain = () =>
    Promise.reject(new Error("controlled exact-asset unavailable"));
  const settleUntil = async (done: () => boolean) => {
    for (let n = 0; n < 100 && !done(); n++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    equal(done(), true);
  };
  try {
    equal((await composition.service.list())[0].status, "pending");
    const pending = composition.service.save(command, {} as SpaceController);
    void pending.catch(() => {});
    await settleUntil(() => mutations === 1);
    equal(notifications, 0);
    equal((await composition.service.list())[0].status, "pending");
    commit.resolve();
    equal((await pending).status, "incomplete");
    // This assertion fails when production composition omits notifyCatalogue.
    equal(notifications, 1);
    equal(mutations, 1);
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let frame: string;
    try {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          frameTimer = setTimeout(
            () => reject(new Error("Missing committed Release SSE frame")),
            500,
          );
        }),
      ]);
      frame = new TextDecoder().decode(next.value);
    } finally {
      clearTimeout(frameTimer);
    }
    equal(
      frame,
      'event: release-catalogue-invalidated\ndata: {"schemaVersion":1}\n\n',
    );
    equal((await composition.service.list())[0].status, "incomplete");
    // This producer/composition boundary is intentionally paired with the
    // frontend/lib/workbench/state-invalidation_test.ts and
    // frontend/components/system/SavedSystems_interactive_test.tsx. The identical content-free wire frame is their shared
    // contract; this test does not claim one full browser/Prisma runtime.
  } finally {
    commit.resolve();
    await reader.cancel();
    reader.releaseLock();
  }
});
