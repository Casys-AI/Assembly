import type { SourceModel } from "../../src/adapters/model/sources/source-model.ts";
import type { ModelIdentity } from "../../src/domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../src/domain/governance/records/pending-change.ts";
import { changePublication } from "../../src/domain/model/publication/change.ts";

/** Explicit publication receipt for direct adapter tests (including stale-digest negatives). */
export async function applyApprovedSourceChange(
  model: SourceModel,
  identity: ModelIdentity,
  change: PendingChange,
  expectedDigest: string,
) {
  const current = await model.readExecutableModel(identity);
  return await model.applyApprovedChange(
    identity,
    change,
    expectedDigest,
    changePublication(change, { ...current.version, digest: expectedDigest }),
  );
}
