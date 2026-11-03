import { strictEqual } from "node:assert";
import { mayConsultModel } from "./model-read-policy.ts";

Deno.test("explicit model reading preserves the three admissible right combinations", () => {
  for (const read of [false, true]) {
    for (const revision of [false, true]) {
      if (!read && revision) continue; // Refused at native compilation and provisioning.
      strictEqual(
        mayConsultModel({
          mayConsultModel: read,
          mayProposeSysmlRevision: revision,
        }),
        read,
      );
    }
  }
});

Deno.test("pre-separation pins retain their historical model-read capability", () => {
  strictEqual(mayConsultModel({ mayProposeSysmlRevision: true }), true);
  strictEqual(mayConsultModel({ mayProposeSysmlRevision: false }), false);
  strictEqual(mayConsultModel({}), false);
});
