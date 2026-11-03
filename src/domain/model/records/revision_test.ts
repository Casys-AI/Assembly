import { deepStrictEqual } from "node:assert/strict";
import { parseModelAuthor } from "./revision.ts";

Deno.test("revision author parser preserves unknown identity without inferred attribution", () => {
  for (
    const [raw, kind, ref] of [
      ["agent:builder-1", "agent", "builder-1"],
      ["local-owner", "owner", "local-owner"],
      ["local-control", "host", "local-control"],
      ["ase", "ase", "ase"],
      ["ase:provision-instance-id", "ase", "provision-instance-id"],
      ["ase:approved-change:abc", "ase", "approved-change:abc"],
      ["ase:activate-candidate:abc", "ase", "activate-candidate:abc"],
      ["ase:record-candidate:abc", "ase", "record-candidate:abc"],
      [
        "ase:record-stage-observation:abc",
        "ase",
        "record-stage-observation:abc",
      ],
      ["someone", "unknown", "someone"],
      ["agent:", "unknown", "agent:"],
      ["agent:two words", "unknown", "agent:two words"],
      ["ase:other", "unknown", "ase:other"],
      ["ase:approved-change:", "unknown", "ase:approved-change:"],
    ]
  ) deepStrictEqual(parseModelAuthor(raw), { kind, ref });
});
