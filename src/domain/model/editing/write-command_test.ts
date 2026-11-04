import assert from "node:assert/strict";
import type { EditTarget, HostEdit } from "./host-edit.ts";
import { sha256 } from "../../primitives/execution-digest.ts";
import { exerciseOwnerAuthority } from "../../governance/authority.ts";
import { changePublication } from "../publication/change.ts";
import type { PendingChange } from "../../governance/records/pending-change.ts";
import { parseModelRevisionRef } from "../value-objects/element-ref.ts";
import {
  assertModelWriteDossier,
  type ModelWriteCommand,
  modelWriteDecisionDigest,
  type ModelWriteDossier,
  modelWriteIntentDigest,
  modelWriteOperationsDigest,
  parseModelWriteCommand,
} from "./write-command.ts";
import { planJournalReplay, planWholeFilesReplay } from "./journal-replay.ts";
import {
  buildOperationJournal,
  type ElementIncarnationRef,
} from "./operation-journal.ts";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const base = parseModelRevisionRef({
  repositoryId: "git:repo-1",
  version: "commit:" + "1".repeat(40),
});

function target(id: string, name: string, preimage: string): EditTarget {
  return { id, qualifiedName: name, metaclass: "PartUsage", preimage };
}

function setValue(editTarget: EditTarget, value: string): HostEdit {
  return { op: "setFeatureValue", target: editTarget, value, format: 1 };
}

Deno.test("journal preserves order, preimages and removal incarnations", () => {
  const first = setValue(target("el-1", "Sys::a", digestA), "x");
  const removal: HostEdit = {
    op: "remove",
    target: { ...target("el-2", "Sys::b", digestB), ownerId: "el-0" },
    format: 1,
  };
  const journal = buildOperationJournal({
    base,
    baseSourceDigest: digestA,
    edits: [first, removal],
  });
  assert.equal(journal.entries.length, 2);
  assert.deepStrictEqual(journal.entries.map((entry) => entry.seq), [0, 1]);
  assert.equal(journal.entries[0]!.target.preimageDigest, digestA);
  assert.equal(journal.entries[1]!.removed?.nativeId, "el-2");
  assert.equal(journal.entries[1]!.removed?.ownerNativeId, "el-0");
  assert.throws(
    () => buildOperationJournal({ base, baseSourceDigest: digestA, edits: [] }),
    { code: "WRITE_JOURNAL_INVALID" },
  );
});

function inventory(
  incarnations: ElementIncarnationRef[],
  names?: string[],
) {
  return {
    incarnations,
    qualifiedNames: names ?? incarnations.map((ref) => ref.qualifiedName),
  };
}

const el1: ElementIncarnationRef = {
  nativeId: "el-1",
  qualifiedName: "Sys::a",
  metaclass: "PartUsage",
  preimageDigest: digestA,
};

Deno.test("replay accepts disjoint base evolution and rejects a changed incarnation", () => {
  const journal = buildOperationJournal({
    base,
    baseSourceDigest: digestA,
    edits: [setValue(target("el-1", "Sys::a", digestA), "x")],
  });
  // The new base added an unrelated element; the journal target is untouched.
  const disjoint = planJournalReplay(
    journal,
    inventory([el1], ["Sys::a", "Sys::z"]),
  );
  assert.equal(disjoint.applicable, true);

  // Same id and name, different member text: a new incarnation, never a
  // permissive rename/name retarget.
  const changed = planJournalReplay(
    journal,
    inventory([{ ...el1, preimageDigest: digestB }]),
  );
  assert.equal(changed.applicable, false);
  if (!changed.applicable) {
    assert.equal(changed.block.code, "INCARNATION_CHANGED");
  }

  const missing = planJournalReplay(journal, inventory([]));
  assert.equal(missing.applicable, false);
  if (!missing.applicable) assert.equal(missing.block.code, "TARGET_MISSING");
});

Deno.test("replay follows creations, deletions and renames inside the journal chain", () => {
  const owner = target("el-0", "Sys", digestA);
  const insert: HostEdit = {
    op: "insertMember",
    owner,
    text: "part b;",
    format: 1,
    expect: [],
    introduced: [{ qualifiedName: "Sys::b", metaclass: "PartUsage" }],
  };
  const touchCreated = setValue(target("el-9", "Sys::b", digestB), "y");
  const journal = buildOperationJournal({
    base,
    baseSourceDigest: digestA,
    edits: [insert, touchCreated],
    introducedIds: new Map([["Sys::b", {
      nativeId: "el-9",
      preimageDigest: digestB,
    }]]),
  });
  const baseInventory = inventory([{
    nativeId: "el-0",
    qualifiedName: "Sys",
    metaclass: "PartUsage",
    preimageDigest: digestA,
  }]);
  assert.equal(planJournalReplay(journal, baseInventory).applicable, true);

  // A concurrent creation of the same qualified name collides.
  const colliding = planJournalReplay(
    journal,
    inventory([{
      nativeId: "el-0",
      qualifiedName: "Sys",
      metaclass: "PartUsage",
      preimageDigest: digestA,
    }], ["Sys", "Sys::b"]),
  );
  assert.equal(colliding.applicable, false);
  if (!colliding.applicable) {
    assert.equal(colliding.block.code, "NAME_COLLISION");
  }
});

Deno.test("replay refuses an operation on an element removed earlier in the journal", () => {
  const removal: HostEdit = {
    op: "remove",
    target: target("el-1", "Sys::a", digestA),
    format: 1,
  };
  const journal = buildOperationJournal({
    base,
    baseSourceDigest: digestA,
    edits: [removal, setValue(target("el-1", "Sys::a", digestA), "x")],
  });
  const plan = planJournalReplay(journal, inventory([el1]));
  assert.equal(plan.applicable, false);
  if (!plan.applicable) assert.equal(plan.block.code, "TARGET_REMOVED");
});

Deno.test("whole-files replay is per-file: disjoint changes pass, changed targets block", async () => {
  const operations = {
    v: 1 as const,
    base,
    baseSourceDigest: digestA,
    files: [
      { path: "core.sysml", baseDigest: await sha256("old"), text: "new" },
      { path: "added.sysml", baseDigest: null, text: "created" },
    ],
  };
  const disjoint = planWholeFilesReplay(
    operations,
    new Map([["core.sysml", await sha256("old")], [
      "other.sysml",
      await sha256("z"),
    ]]),
  );
  assert.equal(disjoint.applicable, true);
  const conflict = planWholeFilesReplay(
    operations,
    new Map([["core.sysml", await sha256("concurrent")]]),
  );
  assert.equal(conflict.applicable, false);
  assert.deepStrictEqual(conflict.conflicts, ["core.sysml"]);
});

async function approvedDossier(): Promise<ModelWriteDossier> {
  const pin = {
    digest: "base",
    repositoryVersion: base.version,
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: ["source"],
  };
  const change: PendingChange = {
    id: "change-1",
    kind: "mandate-change",
    status: "approved",
    baseRevision: 0,
    baseModelDigest: pin.digest,
    requestedAt: "now",
    decidedAt: "later",
    reason: "Exact extension",
    authorityExercise: exerciseOwnerAuthority(
      { identity: { systemId: "system" }, version: pin },
      "mandate-change",
    ),
  };
  const approval = changePublication(change, pin);
  const decision = { kind: "approved-change" as const, approval, change };
  const journal = buildOperationJournal({
    base,
    baseSourceDigest: digestA,
    edits: [setValue(target("el-1", "Sys::a", digestA), "x")],
  });
  const operations = { kind: "host-edits" as const, journal };
  const intent = {
    repositoryId: base.repositoryId,
    commandId: change.id,
    kind: "approved-change" as const,
    approvedBase: base,
    operationsRef: { digest: await modelWriteOperationsDigest(operations) },
    decisionRef: {
      id: change.id,
      digest: await modelWriteDecisionDigest(decision),
    },
    recipeDigest: digestB,
  };
  const command: ModelWriteCommand = {
    v: 1,
    ...intent,
    intentDigest: await modelWriteIntentDigest(intent),
  };
  return { v: 1, command, operations, decision };
}

Deno.test("dossier admission binds command, operations and decision digests", async () => {
  const dossier = await approvedDossier();
  await assert.doesNotReject(() => assertModelWriteDossier(dossier));
  assert.deepStrictEqual(
    parseModelWriteCommand(dossier.command),
    dossier.command,
  );

  const tamperedDecision = structuredClone(dossier);
  if (tamperedDecision.decision.kind !== "approved-change") {
    throw new Error("fixture");
  }
  tamperedDecision.decision.change.reason = "Forged reason";
  await assert.rejects(() => assertModelWriteDossier(tamperedDecision), {
    code: "WRITE_DOSSIER_MISMATCH",
  });

  const tamperedOps = structuredClone(dossier);
  if (tamperedOps.operations.kind !== "host-edits") throw new Error("fixture");
  const edit = tamperedOps.operations.journal.entries[0]!.edit;
  if (edit.op !== "setFeatureValue") throw new Error("fixture");
  edit.value = "forged";
  await assert.rejects(() => assertModelWriteDossier(tamperedOps), {
    code: "WRITE_DOSSIER_MISMATCH",
  });

  const movedBase = structuredClone(dossier);
  (movedBase.command as { approvedBase: typeof base }).approvedBase =
    parseModelRevisionRef({
      repositoryId: base.repositoryId,
      version: "commit:" + "2".repeat(40),
    });
  await assert.rejects(() => assertModelWriteDossier(movedBase), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
});

Deno.test("revision refs are canonical commit identities at every boundary", async () => {
  const dossier = await approvedDossier();
  assert.throws(
    () =>
      parseModelWriteCommand({
        ...dossier.command,
        approvedBase: { repositoryId: base.repositoryId, version: "main" },
      }),
    { code: "WRITE_COMMAND_INVALID" },
  );
  assert.throws(
    () =>
      buildOperationJournal({
        base: { repositoryId: base.repositoryId, version: "v1" } as never,
        baseSourceDigest: digestA,
        edits: [setValue(target("el-1", "Sys::a", digestA), "x")],
      }),
    { code: "WRITE_JOURNAL_INVALID" },
  );
  // The persisted JSON shape is the historical one, digests unchanged.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(dossier.command)), {
    ...dossier.command,
  });
});

Deno.test("command parse is closed: a native handle field is refused", async () => {
  const dossier = await approvedDossier();
  assert.throws(
    () => parseModelWriteCommand({ ...dossier.command, sessionHandle: 42 }),
    {
      code: "WRITE_COMMAND_INVALID",
      message: "Unexpected field sessionHandle",
      context: { reason: "Unexpected field sessionHandle" },
    },
  );
  assert.throws(
    () => parseModelWriteCommand({ ...dossier.command, v: 2 }),
    { code: "WRITE_COMMAND_INVALID" },
  );
});
