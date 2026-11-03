/**
 * Cycle de vie et identités : versions, checkSyntax, close idempotent,
 * gardes SESSION_CLOSED / WRONG_SESSION / STALE_GENERATION, rétention
 * bibliothèque→session, compteurs ramenés à la baseline, exports.
 *
 * Usage: deno run -A tests/lifecycle.ts --addon PATH.node [--out JSON]
 */
import {
  assert,
  assertEqual,
  closeAll,
  expectCode,
  finish,
  FLASHLIGHT,
  loadAddon,
  must,
  parseInterchangeText,
  requiredArg,
  test,
  validateInterchange,
} from "./support.ts";

const addon = await loadAddon(requiredArg("--addon"));
const baseline = addon.nativeResourceCounts();

test("versions: toolkit pin and addon version are distinct strings", () => {
  assertEqual(addon.toolkitVersion(), "0.10.10+ase.2", "toolkitVersion");
  assert(addon.addonVersion().length > 0, "addonVersion non-empty");
  assert(addon.addonVersion() !== addon.toolkitVersion(), "versions differ");
});

test("checkSyntax: parse findings in both forms, input errors coded", () => {
  const typed = addon.checkSyntaxFindings([{
    name: "bad.sysml",
    text: "package {",
  }]);
  assert(
    typed.some((f) => f.stage === "parse"),
    `parse finding: ${JSON.stringify(typed)}`,
  );
  const parsed = JSON.parse(
    addon.checkSyntax(
      JSON.stringify([{ name: "bad.sysml", text: "package {" }]),
    ),
  ) as Array<Record<string, unknown>>;
  assertEqual(parsed[0]?.stage, "parse", "JSON finding stage");
  const clean = addon.checkSyntaxFindings([{
    name: "ok.sysml",
    text: FLASHLIGHT,
  }]);
  assert(
    clean.every((f) => f.stage !== "parse"),
    "no parse finding on clean model",
  );
  expectCode(
    () => addon.checkSyntax("{}"),
    "INVALID_INPUT",
    "malformed sources JSON",
  );
  expectCode(
    () => addon.checkSyntaxFindings([{ name: "", text: "package P;" }]),
    "INVALID_INPUT",
    "empty unit name",
  );
});

test("session lifecycle: close is idempotent, later use is SESSION_CLOSED", () => {
  const session = new addon.ToolkitSession([{
    name: "m.sysml",
    text: FLASHLIGHT,
  }]);
  assert(session.sessionId.length > 0, "session id");
  assertEqual(session.generation, 0, "initial generation");
  assertEqual(session.isClosed, false, "open session");
  session.close();
  assertEqual(session.isClosed, true, "closed session");
  session.close();
  session.dispose();
  expectCode(() => session.check(), "SESSION_CLOSED", "check after close");
  expectCode(
    () => session.resolve("Flashlight::Body"),
    "SESSION_CLOSED",
    "resolve after close",
  );
});

test("guards: wrong session and stale generation are refused by value", () => {
  const first = new addon.ToolkitSession([{
    name: "m.sysml",
    text: FLASHLIGHT,
  }]);
  const second = new addon.ToolkitSession([{
    name: "m.sysml",
    text: FLASHLIGHT,
  }]);
  try {
    const battery = must(first.resolve("Flashlight::Battery"), "battery");
    expectCode(
      () => second.describe(battery),
      "WRONG_SESSION",
      "foreign snapshot",
    );
    // Forged snapshots are re-validated, never trusted.
    expectCode(
      () =>
        first.describe({
          sessionId: first.sessionId,
          generation: 99,
          nativeId: battery.nativeId,
        }),
      "STALE_GENERATION",
      "forged generation",
    );
    expectCode(
      () =>
        first.describe({
          sessionId: first.sessionId,
          generation: 0,
          nativeId: "no-such-id",
        }),
      "ELEMENT_NOT_FOUND",
      "forged native id",
    );
    // A committed typed edit stales every earlier snapshot.
    first.rename(battery, "Cell");
    expectCode(
      () => first.describe(battery),
      "STALE_GENERATION",
      "stale after rename",
    );
    const cell = must(first.resolve("Flashlight::Cell"), "renamed element");
    assertEqual(cell.generation, 1, "new generation");
  } finally {
    closeAll([first, second]);
  }
});

test("library close keeps live sessions usable; counts return to baseline", () => {
  const library = new addon.ToolkitLibrary([
    { name: "lib.sysml", text: "package Lib { part def Wheel; }" },
  ]);
  const session = library.createSession([
    { name: "m.sysml", text: "package M { part w : Lib::Wheel; }" },
  ]);
  library.close();
  assertEqual(library.isClosed, true, "library closed");
  expectCode(
    () => library.createSession([{ name: "x.sysml", text: "package X;" }]),
    "LIBRARY_CLOSED",
    "new session from closed library",
  );
  const wheel = must(session.resolve("Lib::Wheel"), "library element resolves");
  assert(session.isLibraryElement(wheel), "wheel belongs to the library");
  session.close();
  const after = addon.nativeResourceCounts();
  assertEqual(after.librariesAlive, baseline.librariesAlive, "libraries alive");
  assertEqual(after.sessionsAlive, baseline.sessionsAlive, "sessions alive");
});

test("exports: full/compact text and object forms are valid interchange", () => {
  const session = new addon.ToolkitSession([{
    name: "m.sysml",
    text: FLASHLIGHT,
  }]);
  try {
    const full = parseInterchangeText(session.exportFullText(), "full text");
    assert(full.length > 0, "full export non-empty");
    const compact = parseInterchangeText(
      session.exportCompactText(),
      "compact text",
    );
    assert(compact.length > 0, "compact export non-empty");
    const fullObject = validateInterchange(
      session.exportFullObject(),
      "full object",
    );
    assertEqual(fullObject.length, full.length, "object/text full parity");
    const compactObject = validateInterchange(
      session.exportCompactObject(),
      "compact object",
    );
    assertEqual(
      compactObject.length,
      compact.length,
      "object/text compact parity",
    );
    // toFullJson(false) is the same document as exportFullText.
    assertEqual(
      session.toFullJson(false),
      session.exportFullText(),
      "toFullJson parity",
    );
    const digest = session.stateDigest();
    assert(digest.length > 0, "state digest present");
    assertEqual(
      session.stateDigest(),
      digest,
      "state digest stable without edits",
    );
    const summary = session.summary();
    assertEqual(summary.sessionId, session.sessionId, "summary session id");
    assertEqual(summary.generation, 0, "summary generation");
    assert(summary.userElements > 0, "summary user elements");
  } finally {
    session.close();
  }
});

await finish("lifecycle.ts");
