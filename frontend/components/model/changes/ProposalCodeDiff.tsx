import { useMemo } from "preact/hooks";
import {
  type DiffMode,
  renderSourceDiff,
} from "../../../lib/model/revisions/api.ts";

/** The same escaped Git diff renderer as the system revision view. */
export function ProposalCodeDiff(
  { patch, mode = "line-by-line" }: { patch: string; mode?: DiffMode },
) {
  const markup = useMemo(() => renderSourceDiff(patch, mode), [patch, mode]);
  return (
    <div
      class={`revision-diff-host proposal-code-diff${
        mode === "side-by-side" ? " is-split" : ""
      }`}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/** A tool candidate is a new artifact, not an inferred replacement by name. */
export function newToolPatch(id: string, code: string): string {
  const file = `tools/${encodeURIComponent(id)}.ts`;
  if (!code) return `diff --git a/${file} b/${file}\nnew file mode 100644\n`;
  const newline = code.endsWith("\n");
  const lines = (newline ? code.slice(0, -1) : code).split("\n");
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${
    lines.map((line) => `+${line}`).join("\n")
  }\n${newline ? "" : "\\ No newline at end of file\n"}`;
}
