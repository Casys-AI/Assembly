import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { SavedOperatorManifest } from "../../../domain/work/records/saved-systems.ts";
import { validateSourceBindingReference } from "../../../domain/work/artifacts/source-reference.ts";
import { TOOL_KINDS } from "../../../domain/shared-kernel/tool-kind.ts";
import { toolDraftDigest } from "../artifacts/catalog.ts";

/** Source catalogue membership, not a runtime Candidate or a transferable admission. */
export async function assertRetainedCatalog(
  model: ExecutableModel,
  tools: SavedOperatorManifest["tools"],
): Promise<void> {
  const active = model.catalog.filter((entry) => entry.status === "active");
  if (
    active.length !== tools.length || tools.length > 256 ||
    new Set(tools.map((tool) => tool.candidateId)).size !== tools.length ||
    new Set(active.map((entry) => entry.candidateId)).size !== active.length ||
    new Set(active.map((entry) => entry.name)).size !== active.length
  ) throw new Error("Retained tool membership differs");
  for (const entry of active) {
    const matching = tools.filter((tool) =>
      tool.candidateId === entry.candidateId && tool.digest === entry.digest
    );
    if (
      !TOOL_KINDS.includes(entry.kind) || matching.length !== 1 ||
      model.contracts.filter((contract) =>
          contract.nativeId === entry.contractId && contract.kind === entry.kind
        ).length !== 1
    ) throw new Error("Unsupported retained tool contract");
    const binding = matching[0].sourceBinding;
    if (!binding) throw new Error("Retained tool binding is unavailable");
    validateSourceBindingReference(binding);
    if (
      binding.ownerId !== model.identity.builderId ||
      binding.localArtifactId !== entry.candidateId ||
      binding.reference.kind !== "tool-draft" ||
      binding.reference.contentDigest !== entry.digest
    ) throw new Error("Retained tool binding differs");
  }
  // A seed requests preparation; only a matching already active occurrence can
  // satisfy it at opening. Never prepare or approve an uncovered seed here.
  for (const seed of model.initialTools ?? []) {
    const digest = await toolDraftDigest(seed.draft);
    if (
      active.filter((entry) =>
        entry.digest === digest && entry.kind === seed.draft.kind &&
        entry.name === seed.draft.name
      ).length !== 1
    ) {
      throw new Error(
        "An initial tool seed has no exact active retained occurrence",
      );
    }
  }
}
