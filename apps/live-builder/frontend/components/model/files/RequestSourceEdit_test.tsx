import assert from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { RequestSourceEdit } from "./RequestSourceEdit.tsx";
import {
  createRequestSourceEditor,
  type RequestEditScope,
} from "../../../lib/model/sources/request-edit.ts";
import { ModelLinkContext } from "../../view/ModelContextLink.tsx";
import {
  caseSourceMetadataRevision,
  refreshCaseSourceMetadata,
} from "../../../lib/case-model-scope.ts";
const base = `commit:${"a".repeat(40)}`, next = `commit:${"b".repeat(40)}`;
const scope: RequestEditScope = {
  caseId: "case-a",
  branchId: "branch-a",
  executionSpaceId: "space-a",
  viewedVersion: base,
  admittedVersion: base,
  executionVersion: base,
  sessionReady: true,
};
function fixture() {
  const data = new Map<string, string>(), commands: string[] = [];
  const editor = createRequestSourceEditor({
    scope,
    storage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    },
    api: {
      propose: () =>
        Promise.resolve({
          caseId: "case-a",
          id: "proposal-a",
          baseVersion: base,
          proposalVersion: next,
          sourceDigest: "c".repeat(64),
          createdAt: "now",
          reason: "Clearer instructions",
          diff: [{
            path: "core.sysml",
            kind: "changed",
            before: "old",
            after: "new",
          }],
        }),
      accept: () => {
        commands.push("accept");
        return Promise.resolve();
      },
      resume: () =>
        Promise.resolve({
          caseId: "case-a",
          version: next,
          sourceDigest: "c".repeat(64),
        }),
    },
    onConfirmed: (caseId) => refreshCaseSourceMetadata(caseId),
  });
  const html = (version = base, admittedVersion = base) =>
    renderToString(
      <ModelLinkContext.Provider value="?caseBranch=case-a&agent=selected-operator">
        <RequestSourceEdit
          editor={editor}
          path="core.sysml"
          text="old"
          version={version}
          admittedVersion={admittedVersion}
          executionVersion={base}
        />
      </ModelLinkContext.Provider>,
    );
  return { editor, html, commands };
}
Deno.test("current admitted source offers selected-file editing; historical or running older version remains read-only", () => {
  const f = fixture();
  assert.match(f.html(), /Edit instructions in this file/);
  f.editor.setScope({ ...scope, viewedVersion: next });
  assert.doesNotMatch(f.html(next), /Edit instructions in this file/);
  assert.match(f.html(next), /read-only/);
  assert.match(f.html(next), /caseBranch=case-a/);
  assert.match(f.html(next), /agent=selected-operator/);
  f.editor.setScope({ ...scope, admittedVersion: next });
  assert.doesNotMatch(f.html(base, next), /Edit instructions in this file/);
});
Deno.test("exact proposal diff is reviewed before accept-only publication; historical inspection cannot approve", async () => {
  const f = fixture();
  f.editor.start("core.sysml", "old", base);
  f.editor.text("new");
  f.editor.reason("Clearer instructions");
  await f.editor.propose();
  const html = f.html();
  assert.match(html, /Review Request instructions/);
  assert.match(html, /Publish this source change/);
  assert.match(html, /proposal-code-diff/);
  assert.doesNotMatch(html, />Decline<|Put in service|Create release/);
  f.editor.setScope({ ...scope, viewedVersion: next });
  await f.editor.accept();
  assert.deepEqual(f.commands, []);
});
Deno.test("confirmed publication changes only that Case metadata generation and retains executing version", async () => {
  const f = fixture(),
    a = caseSourceMetadataRevision("case-a"),
    b = caseSourceMetadataRevision("case-b");
  f.editor.start("core.sysml", "old", base);
  f.editor.text("new");
  f.editor.reason("Clearer instructions");
  await f.editor.propose();
  await f.editor.accept();
  assert.equal(caseSourceMetadataRevision("case-a"), a + 1);
  assert.equal(caseSourceMetadataRevision("case-b"), b);
  assert.match(
    f.html(),
    /keeps running its existing model|runs the same model/,
  );
  assert.match(f.html(), new RegExp(base));
  assert.doesNotMatch(f.html(), /Put in service|Create release/);
});
