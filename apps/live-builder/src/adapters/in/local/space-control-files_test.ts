import assert from "node:assert/strict";
import { assertLocalCapabilityFile } from "./space-control-files.ts";

Deno.test("local capability import is scoped metadata plus secret, never owner/rights input", () => {
  const profile = {
    scope: { projectId: "git:project", systemId: "host-system" },
    primaryOperatorId: "runtime-operator",
    origin: "http://127.0.0.1:4313",
  };
  const file = {
    format: 1,
    ...profile.scope,
    origin: profile.origin,
    credentialId: "11111111-1111-4111-8111-111111111111",
    expiresAt: "2099-01-01T00:00:00Z",
    capabilitySecret: "a".repeat(64),
  };
  assert.doesNotThrow(() => assertLocalCapabilityFile(file, profile));
  for (
    const patch of [
      { systemId: "foreign" },
      { projectId: "foreign" },
      { origin: "http://127.0.0.1:4399" },
      { capabilitySecret: "bad" },
      { ownerId: "runtime-operator" },
      { acts: ["open-request"] },
      { expiresAt: 2099 },
    ]
  ) {
    assert.throws(() =>
      assertLocalCapabilityFile({ ...file, ...patch }, profile)
    );
  }
});
