import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import type { ModelDelegationRecord } from "./model-delegation.ts";
import {
  MODEL_DELEGATIONS_FILE,
  readModelDelegations,
  renderModelDelegations,
} from "./model-delegation-ledger.ts";

const record: ModelDelegationRecord = {
  id: "legacy-grant",
  revision: 1,
  issuerSystem: "ASELiveBuilder::liveBuilder",
  targetSystem: "ASELiveBuilder::peer",
  targetHolderNativeId: "native-holder-id",
  targetMandateId: "builder-v1",
  targetMandateRevision: 1,
  parent: {
    kind: "root",
    id: "root-policy",
    revision: 1,
    digest: "a".repeat(64),
  },
  operations: ["set-value"],
  grants: [{ file: "mission.sysml", qualifiedRoots: ["Work::mission"] }],
  mayEdit: true,
  recipients: [],
  maxRedelegationDepth: null,
  revoked: false,
};

Deno.test("delegation ledger defaults to Assembly and reopens exact historical ASE bytes", () => {
  const current = renderModelDelegations([record]);
  ok(current.startsWith("package AssemblyModelDelegations {"));
  // This is the exact earlier encoding: only the declaration differs from the new format.
  const historical = current.replace(
    "package AssemblyModelDelegations {",
    "package ASEModelDelegations {",
  );
  const sources = { [MODEL_DELEGATIONS_FILE]: historical };
  deepStrictEqual(readModelDelegations(sources), [record]);
  equal(renderModelDelegations([record], sources), historical);
  deepStrictEqual(readModelDelegations({ [MODEL_DELEGATIONS_FILE]: current }), [
    record,
  ]);
  const revoked = { ...record, revision: 2, revoked: true };
  const appended = renderModelDelegations([revoked], sources);
  ok(appended.startsWith("package ASEModelDelegations {"));
  deepStrictEqual(
    readModelDelegations({ [MODEL_DELEGATIONS_FILE]: appended }),
    [revoked],
  );
  equal(
    readModelDelegations(sources)[0]!.targetHolderNativeId,
    record.targetHolderNativeId,
  );
  equal(readModelDelegations(sources)[0]!.targetSystem, record.targetSystem);
});

Deno.test("delegation ledger refuses competing declarations and noncanonical bytes", () => {
  const current = renderModelDelegations([record]);
  const historical = current.replace(
    "AssemblyModelDelegations",
    "ASEModelDelegations",
  );
  for (
    const malformed of [
      current + historical,
      historical + current,
      current + " ",
      current.replace("attribute records", "attribute  records"),
    ]
  ) {
    throws(() => readModelDelegations({ [MODEL_DELEGATIONS_FILE]: malformed }));
  }
});
