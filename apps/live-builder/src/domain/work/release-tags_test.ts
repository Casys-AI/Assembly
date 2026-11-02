import { doesNotThrow, throws } from "node:assert/strict";
import {
  assertReleaseTagSelection,
  assertSavedSystemTag,
} from "./release-tags.ts";

Deno.test("Release tag names cannot select revisions, options or escape the tag namespace", () => {
  for (
    const name of [
      "",
      "-f",
      "../main",
      "/v1",
      "v1/",
      "v1.lock",
      "v1//a",
      "v1..2",
      "v1@{0}",
      "v1^{commit}",
      "v1\\x",
      "v1 x",
      ".hidden",
      "a/.hidden",
      "v1\n",
    ]
  ) {
    throws(() => assertReleaseTagSelection({ mode: "create", name }));
  }
  doesNotThrow(() =>
    assertReleaseTagSelection({ mode: "existing", name: "release/1.2.3-rc1" })
  );
  throws(() =>
    assertReleaseTagSelection({
      mode: "create",
      name: "v1",
      ref: "refs/heads/main",
    })
  );
});

Deno.test("Release tag evidence freezes both raw and peeled identities without changing source version", () => {
  const oid = "a".repeat(40);
  const tag = {
    selection: { mode: "existing" as const, name: "v1" },
    binding: { name: "v1", refOid: "b".repeat(40), commitOid: oid },
    verified: false,
  };
  doesNotThrow(() => assertSavedSystemTag(tag, `commit:${oid}`));
  throws(() => assertSavedSystemTag(tag, `commit:${"c".repeat(40)}`));
  throws(() =>
    assertSavedSystemTag({
      ...tag,
      selection: { ...tag.selection, name: "v2" },
    }, `commit:${oid}`)
  );
  throws(() =>
    assertSavedSystemTag({
      ...tag,
      selection: { ...tag.selection, mode: "create" },
    }, `commit:${oid}`)
  );
});
