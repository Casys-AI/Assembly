import {
  requestReleaseOriginMatches,
  type VerifiedRequestReleaseSource,
} from "../../domain/work/request-release-origin.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import type { SystemRuntimeState } from "../../domain/work/dialogue.ts";
import {
  assertBaseForChoice,
  assertOpeningBase,
  exactSourceVersion,
  type OpeningRecord,
  requestSpaceDigest,
  type RequestSpaceScope,
} from "../../domain/work/request-spaces.ts";
import {
  assertSavedCapture,
  assertSavedSourceSelection,
  type RequestReleaseAdmissionReference,
  type SavedSystemCapture,
  SavedSystemError,
  type SavedSystemManifest,
  type SavedSystemScope,
  type SavedSystemSourceEvidence,
  type SavedSystemSourceSelection,
} from "../../domain/work/saved-systems.ts";
import type { OpeningStorePort } from "../../application/work/request-spaces/ports.ts";
import type { RequestReleaseProvenancePort } from "../../application/work/saved-systems/request-release-ports.ts";
import { assertRequestSpaceBirthIdentity } from "../../application/work/runtime/initialization.ts";
import { requestSpaceSeed } from "./request-space-runtime.ts";

const unavailable = () =>
  new SavedSystemError(
    "UNAVAILABLE",
    "The exact admitted Request source or its current source visibility is unavailable.",
  );

/** One origin verifier is shared by capture, Release reuse and initial skills.
 * It reads existing records/retained bytes; it provisions no runtime or asset. */
export class RequestReleaseProvenance implements RequestReleaseProvenancePort {
  constructor(
    private readonly options: {
      scope: RequestSpaceScope;
      repositoryId: string;
      openings: Pick<OpeningStorePort, "forCase">;
      branches: {
        sourceEvidence(
          record: OpeningRecord,
        ): Promise<{ version: string; branchRef: string }>;
        refForInspection(record: OpeningRecord): string;
        assertRetainedExecutionVersion?(
          record: OpeningRecord,
          version: string,
        ): Promise<void>;
      };
      canReadScope(scope: SavedSystemScope): Promise<boolean>;
      inspectModels(
        manifest: SavedSystemManifest,
      ): Promise<readonly ExecutableModel[]>;
      readState(record: OpeningRecord): Promise<SystemRuntimeState | null>;
      journal?: {
        selected(
          record: OpeningRecord,
          version: string,
        ): Promise<VerifiedRequestReleaseSource | null>;
        historical(
          record: OpeningRecord,
          reference: RequestReleaseAdmissionReference,
        ): Promise<VerifiedRequestReleaseSource>;
      };
    },
  ) {}

  private async visible(scope: SavedSystemScope) {
    if (
      scope.projectId !== this.options.scope.projectId ||
      scope.systemId !== this.options.scope.systemId ||
      !await this.options.canReadScope(scope)
    ) throw unavailable();
  }

  private async opening(
    caseId: string,
    seen: ReadonlySet<string>,
    inspectAssets = true,
  ): Promise<OpeningRecord> {
    if (seen.size >= 32 || seen.has(caseId)) throw unavailable();
    const record = await this.options.openings.forCase(caseId);
    if (
      !record?.base || !record.baseDigest || record.caseId !== caseId ||
      record.scope.projectId !== this.options.scope.projectId ||
      record.scope.systemId !== this.options.scope.systemId ||
      !["runtime-ready", "admitted", "dispatched"].includes(record.phase) ||
      await requestSpaceDigest(record.base) !== record.baseDigest ||
      await requestSpaceDigest(record.base.manifest) !==
        record.base.manifestDigest ||
      await requestSpaceDigest({
          scope: record.scope,
          ownerId: record.ownerId,
          command: record.command,
        }) !== record.commandDigest
    ) throw unavailable();
    assertOpeningBase(record.base);
    assertBaseForChoice(record.base, record.command.source);
    const next = new Set(seen).add(caseId);
    await this.manifest(record.base.manifest, next, inspectAssets);
    return record;
  }

  private async manifest(
    manifest: SavedSystemManifest,
    seen: ReadonlySet<string>,
    inspectAssets = true,
  ) {
    await this.visible(manifest.origin);
    const source = manifest.source;
    if (
      !source || source.repositoryId !== this.options.repositoryId ||
      !exactSourceVersion(source.sourceVersion)
    ) throw unavailable();
    if (manifest.origin.executionSpaceId === "main") {
      if (
        source.branch.kind !== "main" ||
        source.branchRef !== "refs/heads/admitted"
      ) throw unavailable();
    } else {
      if (source.branch.kind !== "case") throw unavailable();
      const record = await this.opening(
        source.branch.caseId,
        seen,
        inspectAssets,
      );
      const admitted = source.requestAdmission
        ? await this.options.journal?.historical(
          record,
          source.requestAdmission,
        )
        : undefined;
      if (
        !requestReleaseOriginMatches(
          manifest,
          record,
          this.options.branches.refForInspection(record),
          admitted,
        )
      ) throw unavailable();
    }
    if (inspectAssets) await this.options.inspectModels(manifest);
    await this.visible(manifest.origin);
  }

  /** Used only alongside an independent exact model/asset traversal in this
   * same operation. Current visibility is rechecked; no grant is memoized. */
  async assertOriginRelation(manifest: SavedSystemManifest): Promise<void> {
    await this.manifest(manifest, new Set(), false);
  }

  async assertManifest(manifest: SavedSystemManifest): Promise<void> {
    await this.manifest(manifest, new Set());
  }

  async capture(
    selection: SavedSystemSourceSelection,
    scope: SavedSystemScope,
  ): Promise<SavedSystemSourceEvidence> {
    assertSavedSourceSelection(selection);
    if (selection.branch.kind !== "case" || scope.executionSpaceId === "main") {
      throw unavailable();
    }
    await this.visible(scope);
    const record = await this.opening(selection.branch.caseId, new Set());
    if (record.executionSpaceId !== scope.executionSpaceId) throw unavailable();
    const admitted = await this.options.journal?.selected(
      record,
      selection.sourceVersion,
    );
    if (admitted) {
      if (
        admitted.source.repositoryId !== this.options.repositoryId ||
        admitted.source.version !== selection.sourceVersion
      ) throw unavailable();
      const models = await this.options.inspectModels(record.base!.manifest);
      const owner = models.filter((model) =>
        model.identity.builderId === record.base!.requestOwner.operatorId
      );
      const state = await this.options.readState(record);
      if (owner.length !== 1 || !state) throw unavailable();
      assertRequestSpaceBirthIdentity(state, requestSpaceSeed(record), {
        operatorId: owner[0].identity.builderId,
        modelDigest: owner[0].version.digest,
        repositoryVersion: owner[0].version.repositoryVersion!,
      });
      await this.visible(scope);
      return {
        ...structuredClone(selection),
        repositoryId: this.options.repositoryId,
        branchRef: this.options.branches.refForInspection(record),
        admittedHeadVersion: admitted.source.version,
        sourceDigest: admitted.sourceDigest,
        requestAdmission: structuredClone(admitted.requestAdmission),
      };
    }
    if (
      record.base!.manifest.source!.sourceVersion !== selection.sourceVersion
    ) throw unavailable();
    // With a verified D2 baseline, the physical ref may already contain the
    // next publication while its admission is still pending. Check the retained
    // admitted baseline and ref ancestry without selecting the physical tip.
    let actual: { version: string; branchRef: string };
    if (this.options.journal) {
      if (!this.options.branches.assertRetainedExecutionVersion) {
        throw unavailable();
      }
      await this.options.branches.assertRetainedExecutionVersion(
        record,
        selection.sourceVersion,
      );
      actual = {
        version: selection.sourceVersion,
        branchRef: this.options.branches.refForInspection(record),
      };
    } else {
      actual = await this.options.branches.sourceEvidence(record);
    }
    if (
      actual.version !== selection.sourceVersion ||
      actual.branchRef !== this.options.branches.refForInspection(record)
    ) throw unavailable();
    const models = await this.options.inspectModels(record.base!.manifest);
    const owner = models.filter((model) =>
      model.identity.builderId === record.base!.requestOwner.operatorId
    );
    const state = await this.options.readState(record);
    if (owner.length !== 1 || !state) throw unavailable();
    // Birth identity is immutable even when the present execution pin advances.
    assertRequestSpaceBirthIdentity(state, requestSpaceSeed(record), {
      operatorId: owner[0].identity.builderId,
      modelDigest: owner[0].version.digest,
      repositoryVersion: owner[0].version.repositoryVersion!,
    });
    await this.visible(scope);
    return {
      ...structuredClone(selection),
      repositoryId: this.options.repositoryId,
      branchRef: actual.branchRef,
      admittedHeadVersion: actual.version,
      sourceDigest: record.base!.manifest.source!.sourceDigest,
    };
  }

  async assertAccepted(
    capture: SavedSystemCapture,
    scope: SavedSystemScope,
  ): Promise<void> {
    assertSavedCapture(capture);
    if (
      canonical(capture.origin) !== canonical(scope) || !capture.source ||
      capture.source.branch.kind !== "case"
    ) throw unavailable();
    await this.visible(scope);
    const record = await this.opening(capture.source.branch.caseId, new Set());
    if (capture.source.requestAdmission) {
      const admitted = await this.options.journal?.historical(
        record,
        capture.source.requestAdmission,
      );
      const owner = capture.operators.filter((item) =>
        item.operatorId === record.base!.requestOwner.operatorId
      );
      if (
        !admitted || record.executionSpaceId !== scope.executionSpaceId ||
        capture.source.branchRef !==
          this.options.branches.refForInspection(record) ||
        canonical(capture.source.requestAdmission) !==
          canonical(admitted.requestAdmission) ||
        capture.source.requestAdmission.openingId !== record.id ||
        capture.source.requestAdmission.openingBaseDigest !==
          record.baseDigest ||
        capture.source.repositoryId !== admitted.source.repositoryId ||
        capture.source.sourceVersion !== admitted.source.version ||
        capture.source.admittedHeadVersion !== admitted.source.version ||
        capture.source.sourceDigest !== admitted.sourceDigest ||
        owner.length !== 1 ||
        owner[0].modelDigest !== admitted.model.digest ||
        owner[0].nativeSystemId !== admitted.model.identity.systemId ||
        (admitted.model.identity.systemQualifiedName !== undefined &&
          owner[0].systemQualifiedName !==
            admitted.model.identity.systemQualifiedName) ||
        admitted.model.identity.builderId !== owner[0].operatorId ||
        admitted.model.identity.projectId !==
          `git:${capture.source.repositoryId}`
      ) throw unavailable();
      await this.visible(scope);
      return;
    }
    if (
      record.executionSpaceId !== scope.executionSpaceId ||
      capture.source.branchRef !==
        this.options.branches.refForInspection(record) ||
      capture.source.sourceVersion !==
        record.base!.manifest.source!.sourceVersion ||
      capture.source.sourceDigest !==
        record.base!.manifest.source!.sourceDigest ||
      capture.source.admittedHeadVersion !== capture.source.sourceVersion
    ) throw unavailable();
    // Accepted-source recovery is historical. It deliberately does not ask the
    // original live branch/runtime to move back after a later admitted change.
    await this.visible(scope);
  }
}
