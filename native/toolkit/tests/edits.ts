/**
 * Éditions : éditions typées du prototype, batchs JSON du vocabulaire
 * `SysmlToolkitAdapter` (setFeatureValue, rename, insertMember,
 * replaceMember, setFeatureType, remove) et au-delà, refus
 * (cible absente, bibliothèque, collision sautée, ops malformées),
 * et invariant de rejeu des splices sur les octets sources.
 *
 * Usage: deno run -A tests/edits.ts --addon PATH.node [--out JSON]
 */
import {
  assert,
  assertEqual,
  expectCode,
  finish,
  FLASHLIGHT,
  loadAddon,
  must,
  requiredArg,
  test,
  type ToolkitSession,
} from "./support.ts";

const addon = await loadAddon(requiredArg("--addon"));

function flashlight(): ToolkitSession {
  return new addon.ToolkitSession([{
    name: "flashlight.sysml",
    text: FLASHLIGHT,
  }]);
}

interface Splice {
  unit: string;
  start: number;
  end: number;
  text: string;
}

/** Rejoue des splices pré-commit sur un texte, comme l'adapter hôte. */
function replay(text: string, splices: Splice[]): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let bytes = encoder.encode(text);
  const ordered = [...splices].sort((a, b) =>
    b.start - a.start || b.end - a.end
  );
  for (const splice of ordered) {
    const inserted = encoder.encode(splice.text);
    const next = new Uint8Array(
      splice.start + inserted.length + bytes.length - splice.end,
    );
    next.set(bytes.subarray(0, splice.start));
    next.set(inserted, splice.start);
    next.set(bytes.subarray(splice.end), splice.start + inserted.length);
    bytes = next;
  }
  return decoder.decode(bytes);
}

test("typed edits: preview keeps the session, commit bumps the generation", () => {
  const session = flashlight();
  try {
    const battery = must(session.resolve("Flashlight::Battery"), "battery");
    const preview = session.checkInsertMember(
      battery,
      "attribute capacity = 9;",
    );
    assertEqual(preview.wouldCommit, true, "insert preview commits");
    assertEqual(session.generation, 0, "preview keeps generation");
    assertEqual(
      session.units()[0]?.text,
      FLASHLIGHT,
      "preview keeps source bytes",
    );
    const report = session.insertMember(battery, "attribute capacity = 9;");
    assertEqual(report.generation, 1, "commit generation");
    assertEqual(report.splices.length, preview.splices.length, "same splices");
    assertEqual(
      session.units()[0]?.text,
      replay(FLASHLIGHT, report.splices),
      "splices replay to the new sources",
    );
    const capacity = must(
      session.resolve("Flashlight::Battery::capacity"),
      "inserted member",
    );
    assertEqual(session.evaluate(capacity), "9", "inserted value");
    // Typed edits refuse instead of throwing on preview refusals.
    const refused = session.checkRename(capacity, "voltage");
    assertEqual(
      refused.wouldCommit,
      false,
      "colliding typed rename preview refuses",
    );
    assertEqual(session.generation, 1, "refused preview keeps generation");
  } finally {
    session.close();
  }
});

test("JSON batch: the adapter vocabulary commits with reviewed splices", () => {
  const session = flashlight();
  try {
    const ops = JSON.stringify([
      {
        op: "setFeatureValue",
        target: "Flashlight::Battery::voltage",
        expr: "4",
      },
      {
        op: "insertMember",
        owner: "Flashlight::Battery",
        text: "attribute capacity = 9;",
      },
    ]);
    const preview = JSON.parse(session.checkEdit(ops)) as {
      wouldCommit: boolean;
      splices: Splice[];
      findings: string[];
      idMap: Array<[string, string]>;
    };
    assertEqual(preview.wouldCommit, true, "batch preview");
    assertEqual(session.generation, 0, "preview keeps generation");
    assertEqual(session.units()[0]?.text, FLASHLIGHT, "preview keeps bytes");
    const committed = JSON.parse(session.edit(ops)) as typeof preview;
    assertEqual(
      JSON.stringify(committed.splices),
      JSON.stringify(preview.splices),
      "commit matches its preview",
    );
    assertEqual(session.generation, 1, "generation after batch");
    assertEqual(
      session.units()[0]?.text,
      replay(FLASHLIGHT, committed.splices),
      "batch splices replay exactly",
    );
    const voltage = must(
      session.resolve("Flashlight::Battery::voltage"),
      "voltage",
    );
    assertEqual(session.evaluate(voltage), "4", "setFeatureValue applied");

    session.edit(JSON.stringify([
      {
        op: "replaceMember",
        target: "Flashlight::Battery::capacity",
        text: "attribute capacity = 10;",
      },
    ]));
    const capacity = must(
      session.resolve("Flashlight::Battery::capacity"),
      "capacity",
    );
    assertEqual(session.evaluate(capacity), "10", "replaceMember applied");
    session.edit(JSON.stringify([
      { op: "remove", target: "Flashlight::Battery::capacity" },
    ]));
    assertEqual(
      session.resolve("Flashlight::Battery::capacity"),
      null,
      "remove applied",
    );

    // setFeatureType on the usage, then rename with idMap continuity.
    session.edit(JSON.stringify([
      {
        op: "setFeatureType",
        target: "Flashlight::flashlight::battery",
        type: "Body",
      },
    ]));
    const usage = must(
      session.resolve("Flashlight::flashlight::battery"),
      "usage",
    );
    const body = must(session.resolve("Flashlight::Body"), "body");
    assertEqual(
      session.typings(usage)[0]?.nativeId,
      body.nativeId,
      "setFeatureType applied",
    );
    const renamed = JSON.parse(
      session.edit(JSON.stringify([
        { op: "rename", target: "Flashlight::Battery", newName: "Cell" },
      ])),
    ) as { idMap: Array<[string, string]> };
    const cell = must(
      session.resolve("Flashlight::Cell"),
      "renamed definition",
    );
    assert(
      renamed.idMap.some(([, next]) => next === cell.nativeId),
      "idMap reaches the renamed id",
    );
  } finally {
    session.close();
  }
});

test("JSON batch refusals: missing target, library target, malformed ops", () => {
  const library = new addon.ToolkitLibrary([
    { name: "lib.sysml", text: "package Lib { part def Wheel; }" },
  ]);
  const session = library.createSession([
    { name: "m.sysml", text: "package M { part w : Lib::Wheel; }" },
  ]);
  try {
    const before = session.units();
    const generation = session.generation;
    expectCode(
      () =>
        session.edit(JSON.stringify([
          { op: "rename", target: "M::Missing", newName: "X" },
        ])),
      "EDIT_REFUSED",
      "missing target commit",
    );
    const refused = JSON.parse(
      session.checkEdit(JSON.stringify([
        { op: "rename", target: "Lib::Wheel", newName: "Tyre" },
      ])),
    ) as { wouldCommit: boolean; refusal?: string };
    assertEqual(refused.wouldCommit, false, "library target preview refuses");
    assert(
      (refused.refusal ?? "").includes("library element"),
      `library refusal text: ${refused.refusal}`,
    );
    expectCode(
      () => session.edit("not json"),
      "INVALID_INPUT",
      "malformed ops",
    );
    expectCode(() => session.edit("[]"), "INVALID_INPUT", "empty batch");
    expectCode(
      () => session.edit(JSON.stringify([{ op: "bogusOp", target: "M::w" }])),
      "INVALID_INPUT",
      "unknown op",
    );
    assertEqual(session.generation, generation, "refusals keep generation");
    assertEqual(
      JSON.stringify(session.units()),
      JSON.stringify(before),
      "refusals keep source bytes",
    );
  } finally {
    session.close();
    library.close();
  }
});

test("colliding JSON rename is skipped and reported, never silent", () => {
  const session = flashlight();
  try {
    const report = JSON.parse(
      session.edit(JSON.stringify([
        { op: "rename", target: "Flashlight::Body", newName: "Battery" },
      ])),
    ) as { findings: string[] };
    assert(report.findings.length > 0, "dropped rename is a finding");
    assert(
      session.resolve("Flashlight::Body") !== null,
      "the colliding element kept its name",
    );
  } finally {
    session.close();
  }
});

test("extended JSON vocabulary: insertTopLevel, addUnit, moveMember", () => {
  const session = flashlight();
  try {
    session.edit(JSON.stringify([
      {
        op: "insertTopLevel",
        unit: "flashlight.sysml",
        text: "package Extra { part def Case; }",
      },
    ]));
    assert(
      session.resolve("Extra::Case") !== null,
      "insertTopLevel landed",
    );
    session.edit(JSON.stringify([{ op: "addUnit", unit: "extra.sysml" }]));
    assert(
      session.units().some((u) => u.name === "extra.sysml"),
      "addUnit created the unit",
    );
    session.edit(JSON.stringify([
      {
        op: "moveMember",
        target: "Flashlight::flashlight::body",
        newOwner: "Flashlight::Battery",
      },
    ]));
    assert(
      session.resolve("Flashlight::Battery::body") !== null,
      "moveMember relocated the usage",
    );
  } finally {
    session.close();
  }
});

test("retargetReference revalidates a complete UTF-16 site and joins a type edit", () => {
  const text = "package NativeRetarget { action def OldFlow { action readCaseState; } action def NewFlow { action readCaseState; } part system { part performer; perform action conversation : OldFlow { attribute retainedPolicy = 7; } perform action peer : OldFlow; /* 😀 */ allocate conversation.readCaseState to performer; allocate peer.readCaseState to performer; } }";
  const session = new addon.ToolkitSession([{ name: "retarget.sysml", text }]);
  try {
    const root = must(session.resolve("NativeRetarget::system::conversation"), "occurrence");
    const from = must(session.resolve("NativeRetarget::OldFlow::readCaseState"), "old child");
    const to = must(session.resolve("NativeRetarget::NewFlow::readCaseState"), "new child");
    const refs = JSON.parse(session.references(JSON.stringify({ elementId: from.nativeId }))) as {
      referenceSiteFormat: string;
      referenceSitesOmitted: number;
      references: Array<{ kind: string; owner: unknown; siteFingerprint: Record<string, unknown> | null }>;
    };
    assertEqual(refs.referenceSiteFormat, "assembly-native-reference-site/v1", "native fingerprint protocol version");
    assertEqual(refs.referenceSitesOmitted, 0, "every native site is represented");
    const unused = JSON.parse(session.references(JSON.stringify({ elementId: to.nativeId })));
    assertEqual(unused.referenceSiteFormat, "assembly-native-reference-site/v1", "empty references retain protocol version");
    assertEqual(unused.referenceSitesOmitted, 0, "empty native inventory has no omitted sites");
    assertEqual(unused.references.length, 0, "new child is initially unused");
    const reference = must(refs.references.find((entry) => entry.siteFingerprint?.chainRootId === root.nativeId), "contextual site");
    const site = must(reference.siteFingerprint, "fingerprint");
    assert(reference.owner !== undefined && reference.kind.length > 0, "legacy read fields remain");
    const at = text.indexOf("conversation.readCaseState") + "conversation.".length;
    assertEqual(site.col, at + 1, "one-based UTF-16 full reference column");
    assert(site.col !== new TextEncoder().encode(text.slice(0, at)).length + 1, "UTF-16 differs from bytes");
    const operations = [
      { op: "setFeatureType", target: "NativeRetarget::system::conversation", type: "NativeRetarget::NewFlow" },
      { op: "retargetReference", fromId: from.nativeId, toId: to.nativeId, site },
    ];
    const before = session.unitsJson();
    for (const invalidSite of [
      { ...site, preimage: "stale" },
      { ...site, ownerId: to.nativeId },
      { ...site, chainRootId: null },
      { ...site, unit: "sysmlv2-lib:/retarget.sysml" },
    ]) {
      const wrong = JSON.stringify([operations[0], { ...operations[1], site: invalidSite }]);
      assertEqual(JSON.parse(session.checkEdit(wrong)).wouldCommit, false, "stale/foreign site preview refuses");
      expectCode(() => session.edit(wrong), "EDIT_REFUSED", "stale/foreign site commit refuses");
      assertEqual(session.unitsJson(), before, "refusal preserves every source byte");
      assertEqual(session.generation, 0, "refusal preserves generation");
    }
    expectCode(() => session.checkEdit(JSON.stringify([{ ...operations[1], site: { ...site, rawSplice: true } }])),
      "INVALID_INPUT", "nested unknown fields are rejected");
    const preview = JSON.parse(session.checkEdit(JSON.stringify(operations)));
    assertEqual(preview.wouldCommit, true, "complete plan previews");
    assertEqual(session.unitsJson(), before, "preview does not mutate");
    const committed = JSON.parse(session.edit(JSON.stringify(operations)));
    assertEqual(JSON.stringify(committed.splices), JSON.stringify(preview.splices), "same reviewed splices");
    assertEqual(session.generation, 1, "single atomic commit");
    const nextRefs = JSON.parse(session.references(JSON.stringify({ elementId: to.nativeId }))) as typeof refs;
    assert(nextRefs.references.some((entry) => entry.siteFingerprint?.chainRootId === root.nativeId),
      "new target retains the contextual occurrence root");
    const nextSource = session.unitsJson();
    assert(nextSource.includes("attribute retainedPolicy = 7;"), "policy body retained");
    assert(nextSource.includes("allocate peer.readCaseState to performer;"), "unaffected Peer retained");
    expectCode(() => session.edit(JSON.stringify(operations)), "EDIT_REFUSED", "old fingerprint is stale after commit");
    assertEqual(session.unitsJson(), nextSource, "stale replay leaves committed source intact");
  } finally {
    session.close();
  }
});

await finish("edits.ts");
