import type { EditTarget, HostEdit, Scalar } from "../editing/host-edit.ts";

/** Historical wire formats. They are never emitted by a source writer. */
interface LegacyEdit {
  owner: string;
  name: string;
  value: Scalar;
}
/** Other M1d operations already have exactly the current HostEdit shape. */
type M1dHostEdit =
  & Omit<
    Extract<HostEdit, { op: "insertMember" }>,
    "expect" | "text" | "format" | "expectDigest" | "intent"
  >
  & {
    text: string;
    format?: never;
    expect: { kind?: never; path: string; value: Scalar }[];
  };
interface OperatorAuthorityEdit {
  op: "insertMember";
  target: EditTarget;
  text: string;
  expect: { qualifiedName: string; metaclass: string; sourceText?: string }[];
}
export type PublicationEdit =
  | HostEdit
  | M1dHostEdit
  | OperatorAuthorityEdit
  | LegacyEdit;

export function isOperatorAuthorityEdit(
  edit: PublicationEdit,
): edit is OperatorAuthorityEdit {
  return "op" in edit && edit.op === "insertMember" && "target" in edit;
}
export function isHostEdit(
  edit: PublicationEdit,
): edit is HostEdit | M1dHostEdit {
  return "op" in edit && !isOperatorAuthorityEdit(edit);
}

/** Read-only projection for final-state verification of an immutable publication.
 * expectDigest detects partial corruption of format:1, not a coherent rewrite
 * into a historical format. Trust remains anchored in the Git commit SHA chain.
 * Never replay this projection: historical authority preimages belong to the
 * intermediate revision AFTER scalar writes, unlike M1d's preparation base.
 * The verifier callback deliberately receives no base. Stored receipt bytes,
 * including those preimages, remain untouched for whole-receipt recovery checks.
 */
export async function verifyPublicationReadback(
  stored: readonly PublicationEdit[],
  readers: {
    scalarTarget: (edit: LegacyEdit) => EditTarget;
    verify: (edits: readonly HostEdit[]) => Promise<void>;
  },
): Promise<void> {
  if (!Array.isArray(stored) || !stored.length) {
    throw new Error("Missing publication edits");
  }
  const scalars: HostEdit[] = [];
  const edits = structuredClone(stored).flatMap((edit): HostEdit[] => {
    if (isOperatorAuthorityEdit(edit)) {
      if (
        !Array.isArray(edit.expect) || !edit.expect.length ||
        edit.expect.some((expected) =>
          typeof expected.sourceText !== "string" || !expected.sourceText.trim()
        )
      ) throw new Error("Missing historical authority member source");
      return [{
        op: "insertMember",
        owner: edit.target,
        // The old verifier checked exact compiled member sources, not the raw
        // template's layout (its executor allowed formatting/comment changes).
        // Anchor the readback plan in that recorded member, retaining every
        // member assertion below. This is not an executable insertion/replay.
        text: edit.expect[0]!.sourceText!,
        // Old authority receipts had no inventory: project exactly their old
        // assertions for readback, never claim this as a replayable creation plan.
        introduced: edit.expect.map(({ qualifiedName, metaclass }) => ({
          qualifiedName,
          metaclass,
        })),
        expect: edit.expect.map((expected) => ({
          ...expected,
          kind: "member",
        })),
      }];
    }
    if (isHostEdit(edit)) {
      if (edit.op !== "insertMember") return [edit];
      if (edit.format === 1) return [edit];
      if (
        edit.format !== undefined || typeof edit.text !== "string" ||
        "expectDigest" in edit || "intent" in edit || edit.expect.some((e) =>
          e.kind !== undefined
        )
      ) {
        throw new Error("Invalid current insertion receipt format");
      }
      return [{
        ...edit,
        expect: edit.expect.map((expected) =>
          expected.kind === "member"
            ? expected
            : { ...expected, kind: expected.kind ?? "literal" }
        ),
      }];
    }
    scalars.push({
      op: "setFeatureValue",
      target: readers.scalarTarget(edit),
      value: edit.value,
    });
    return [];
  });
  // Legacy scalars were independent final-state assertions, not an ordered
  // Host plan: a later operation must never hide a corrupted earlier assertion.
  for (const scalar of scalars) await readers.verify([scalar]);
  if (edits.length) await readers.verify(edits);
}
