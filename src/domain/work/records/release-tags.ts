import {
  SavedSystemError,
  type SavedSystemSourceEvidence,
  type SavedSystemSourceSelection,
} from "./saved-systems.ts";

/** Independent create-only tag command; it does not publish a Release. */
export interface ModelTagCreationCommand {
  source: SavedSystemSourceSelection;
  name: string;
}
export interface ModelTagCreation {
  source: SavedSystemSourceEvidence;
  tag: ReleaseTagBinding;
}

export interface ReleaseTagSelection {
  mode: "existing" | "create";
  name: string;
}
/** Raw ref identity and its peeled exact commit are both immutable. */
export interface ReleaseTagBinding {
  name: string;
  refOid: string;
  commitOid: string;
}
export interface SavedSystemTag {
  selection: ReleaseTagSelection;
  binding: ReleaseTagBinding;
  verified: boolean;
}
/** Terminal acknowledgement of an exact command before any accepted tag work. */
export interface ReleaseTagRejection {
  code: "TAG_UNAVAILABLE" | "SOURCE_STALE";
  tag: ReleaseTagSelection;
}
export function assertReleaseTagRejection(
  value: unknown,
): asserts value is ReleaseTagRejection {
  const rejection = value as ReleaseTagRejection;
  if (
    !rejection || typeof rejection !== "object" || Array.isArray(rejection) ||
    Object.keys(rejection).sort().join(",") !== "code,tag" ||
    (rejection.code !== "TAG_UNAVAILABLE" && rejection.code !== "SOURCE_STALE")
  ) {
    throw new SavedSystemError(
      "INVALID_COMMAND",
      "Invalid Release tag rejection.",
    );
  }
  assertReleaseTagSelection(rejection.tag);
}

/** Conservative Git ref validation, without interpreting revision expressions. */
export function assertReleaseTagName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value.length > 200 ||
    value.startsWith("-") || value === "@" ||
    // Git ref names exclude ASCII controls, space and DEL.
    // deno-lint-ignore no-control-regex
    /[\x00-\x20\x7f~^:?*\[\\]/.test(value) ||
    value.includes("..") || value.includes("@{") ||
    value.endsWith(".") ||
    value.split("/").some((part) =>
      !part || part.startsWith(".") || part.endsWith(".lock")
    )
  ) {
    throw new SavedSystemError(
      "INVALID_COMMAND",
      "Select a valid Git tag name.",
    );
  }
}
export function assertReleaseTagSelection(
  value: unknown,
): asserts value is ReleaseTagSelection {
  const tag = value as ReleaseTagSelection;
  if (
    !tag || typeof tag !== "object" || Array.isArray(tag) ||
    Object.keys(tag).sort().join(",") !== "mode,name" ||
    !["existing", "create"].includes(tag.mode)
  ) {
    throw new SavedSystemError(
      "INVALID_COMMAND",
      "Select an existing or new tag.",
    );
  }
  assertReleaseTagName(tag.name);
}
export function assertReleaseTagBinding(
  binding: ReleaseTagBinding,
  sourceVersion: string,
): void {
  assertReleaseTagName(binding?.name);
  if (
    !/^[a-f0-9]{40}$/.test(binding.refOid) ||
    !/^[a-f0-9]{40}$/.test(binding.commitOid) ||
    sourceVersion !== `commit:${binding.commitOid}`
  ) {
    throw new SavedSystemError(
      "TAG_UNAVAILABLE",
      "The exact Release tag is unavailable.",
    );
  }
}
export function assertSavedSystemTag(
  tag: SavedSystemTag,
  sourceVersion: string,
): void {
  assertReleaseTagSelection(tag?.selection);
  assertReleaseTagBinding(tag.binding, sourceVersion);
  if (
    typeof tag.verified !== "boolean" ||
    tag.selection.name !== tag.binding.name ||
    tag.selection.mode === "create" &&
      tag.binding.refOid !== tag.binding.commitOid
  ) {
    throw new SavedSystemError(
      "TAG_UNAVAILABLE",
      "The exact Release tag is unavailable.",
    );
  }
}
