import { requestReleaseFixture } from "./request-release-fixture.ts";
import { spaceUuid } from "./request-space-fixture.ts";
import {
  type OpeningBase,
  type OpeningRecord,
} from "../../src/domain/work/request-spaces/opening.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces/scope.ts";

/** Immutable flat manifests linked through exact durable opening records.
 * Test-only: no runtime, database, repository or source assets are constructed. */
export async function requestOriginChain(count: number, cycle = false) {
  if (!Number.isInteger(count) || count < 1 || cycle && count < 2) {
    throw new Error("Invalid fixture depth");
  }
  const seed = await requestReleaseFixture();
  const records: OpeningRecord[] = [];
  let previous = structuredClone(seed.record.base!);
  for (let index = 0; index < count; index++) {
    const record = structuredClone(seed.record);
    record.id = `chain-opening-${index}`;
    record.caseId = `chain-case-${index}`;
    record.executionSpaceId = `chain-space-${index}`;
    record.branchId = spaceUuid(100 + index);
    record.caseNumber = index + 1;
    record.initialContributionId = `chain-input-${index}`;
    record.admissionId = `chain-admission-${index}`;
    record.base = structuredClone(previous);
    record.command = {
      openingKey: `chain-key-${index}`,
      text: "Exact retained origin chain",
      source: index === 0 ? { kind: "current-main" } : {
        kind: "release",
        releaseId: previous.release!.id,
        digest: previous.manifestDigest,
      },
    };
    record.commandDigest = await requestSpaceDigest({
      scope: record.scope,
      ownerId: record.ownerId,
      command: record.command,
    });
    record.baseDigest = await requestSpaceDigest(record.base);
    const manifest = structuredClone(seed.manifest);
    manifest.origin.executionSpaceId = record.executionSpaceId;
    manifest.source!.branch = { kind: "case", caseId: record.caseId };
    manifest.source!.branchRef = `refs/heads/requests/${record.branchId}`;
    const digest = await requestSpaceDigest(manifest);
    previous = {
      ...structuredClone(seed.record.base!),
      sourceKind: "release",
      release: { id: `chain-release-${index}`, digest },
      manifest,
      manifestDigest: digest,
    } satisfies OpeningBase;
    records.push(record);
  }
  if (cycle) {
    // The oldest record now points to the newest manifest. Recompute both
    // exact digests so only a multi-level cycle, never stale bytes, can refuse.
    records[0].base = structuredClone(previous);
    records[0].command.source = {
      kind: "release",
      releaseId: previous.release!.id,
      digest: previous.manifestDigest,
    };
    records[0].baseDigest = await requestSpaceDigest(records[0].base);
    records[0].commandDigest = await requestSpaceDigest({
      scope: records[0].scope,
      ownerId: records[0].ownerId,
      command: records[0].command,
    });
  }
  return { ...seed, records, manifest: previous.manifest, base: previous };
}
