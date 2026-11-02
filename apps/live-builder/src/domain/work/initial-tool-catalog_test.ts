import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { validateInitialToolManifest } from "./initial-tool-catalog.ts";

const tool = {
  id: "reader-v1",
  name: "reader",
  description: "Lire les données de la page fournie",
  kind: "read_web_page",
  code: "export default ({url,html}) => ({title:url,text:html})",
};

Deno.test("initial tool selection preserves exact bytes without carrying an admission", () => {
  const input = { format: 1, tools: [{ ...tool }] };
  const selected = validateInitialToolManifest(input);
  deepStrictEqual(selected, [{
    id: tool.id,
    draft: {
      name: tool.name,
      description: tool.description,
      kind: tool.kind,
      code: tool.code,
    },
  }]);
  selected[0]!.draft.code = "changed";
  equal(input.tools[0]!.code, tool.code);
  deepStrictEqual(validateInitialToolManifest({ format: 1, tools: [] }), []);
  for (const field of ["status", "admission", "tests", "active"]) {
    throws(
      () =>
        validateInitialToolManifest({
          format: 1,
          tools: [{ ...tool, [field]: true }],
        }),
      /exact id/,
    );
  }
});

Deno.test("initial tool selection rejects duplicate identities, unsupported primitives and oversized bytes", () => {
  for (
    const value of [
      { format: 1, tools: [tool, { ...tool, name: "other" }] },
      { format: 1, tools: [tool, { ...tool, id: "other" }] },
      { format: 1, tools: [{ ...tool, kind: "shell" }] },
      { format: 1, tools: [{ ...tool, code: "a".repeat(40_001) }] },
      { format: 1, tools: [{ ...tool, id: "../other" }] },
      { format: 1, tools: [{ ...tool, name: "reader\nother" }] },
      { format: 1, tools: [{ ...tool, description: "" }] },
      {
        format: 1,
        tools: Array.from(
          { length: 9 },
          (_, index) => ({ ...tool, id: String(index), name: String(index) }),
        ),
      },
      { format: 1, tools: [], approved: true },
    ]
  ) throws(() => validateInitialToolManifest(value));
});
