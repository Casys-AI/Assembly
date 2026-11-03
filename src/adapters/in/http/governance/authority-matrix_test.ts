import assert from "node:assert/strict";
import { createAuthorityMatrixHandler } from "./authority-matrix.ts";
import { AuthorityMatrixService } from "../../../../application/governance/authority-matrix.ts";
import {
  MATRIX_VERSION,
  matrixFixture,
} from "../../../../../test/support/authority-matrix-fixtures.ts";

// The shared transport contract lives in ../versioning/handler_test.ts.
Deno.test("matrix route rejects mismatches for explicit and resolved head versions without immutable caching", async () => {
  const requested = `commit:${"b".repeat(40)}`;
  let calls = 0;
  let corrected = false;
  const service = new AuthorityMatrixService({
    read(version) {
      calls++;
      return Promise.resolve(
        matrixFixture(corrected ? version : MATRIX_VERSION),
      );
    },
  });
  const handler = createAuthorityMatrixHandler(
    service,
    () => Promise.resolve(requested),
  );
  for (const query of [`?version=${requested}`, ""]) {
    const response = await handler(
      new Request(`http://atelier.test/api/model/authority-matrix${query}`, {
        headers: { "if-none-match": "*" },
      }),
    );
    assert.equal(response?.status, 500);
    assert.equal(response?.headers.get("cache-control"), "no-store");
    assert.equal(response?.headers.get("etag"), null);
    const body = await response?.json();
    assert.equal(body.code, "MODEL_VERSION_MISMATCH");
    assert.deepEqual(body.context, {
      version: requested,
      receivedVersion: MATRIX_VERSION,
    });
  }
  assert.equal(calls, 2);
  corrected = true;
  const response = await handler(
    new Request(
      `http://atelier.test/api/model/authority-matrix?version=${requested}`,
    ),
  );
  assert.equal(response?.status, 200);
  assert.equal((await response?.json()).version, requested);
  assert.equal(calls, 3);
});
