import assert from "node:assert/strict";
import { createRequestSpaceControls } from "./request-spaces.ts";
import type { PrismaClient } from "../adapters/out/postgres/client.ts";
import type { PostgresHostStorage } from "../adapters/out/postgres/host-storage.ts";
import {
  requestControlAdoptedState,
  requestControlBinding,
  requestSpaceScope as host,
} from "../../test/support/request-space-fixture.ts";
import { RequestSpaceError } from "../domain/work/request-spaces/scope.ts";

Deno.test("Request composition reuses the configured PRIMARY client and missing modeled policy denies issuance", async () => {
  const client = {} as PrismaClient;
  let handleReads = 0;
  let captures = 0;
  const primary = {
    binding: requestControlBinding,
    assertClient(found: PrismaClient) {
      assert.equal(found, client);
    },
    capture() {
      captures++;
      return Promise.resolve({
        source: null,
        adoptedState: requestControlAdoptedState(),
      });
    },
  };
  const storage = {
    client,
    scope: host,
    get primarySpaceControl() {
      handleReads++;
      return primary;
    },
  } as unknown as PostgresHostStorage;
  const assembled = createRequestSpaceControls(storage);
  assert.equal(handleReads, 1);
  assert.equal(captures, 0);
  await assert.rejects(
    assembled.controls.issueCapability("owner"),
    RequestSpaceError,
  );
  assert.equal(captures, 1);
  assert.throws(() =>
    createRequestSpaceControls(
      { ...storage, client: {} } as unknown as PostgresHostStorage,
    )
  );
});
