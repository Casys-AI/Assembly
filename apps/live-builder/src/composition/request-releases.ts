import { readScopedSoftwareSourceAdmissionProof } from "../adapters/out/postgres/scoped-software-source-publication-participant.ts";
import { ReleaseCreationAuthority } from "../application/work/saved-systems/creation-authorization.ts";
import { RequestReleases } from "../application/work/saved-systems/request-releases.ts";
import type { SpaceControlPort } from "../application/work/request-spaces/ports.ts";
import { PostgresReleaseCreationGuard } from "../adapters/out/postgres/release-creation-guard.ts";
import { PostgresRequestReleaseCatalogue } from "../adapters/out/postgres/request-release-catalogue.ts";
import { PostgresRequestSpaceStore } from "../adapters/out/postgres/request-space-store.ts";
import {
  PostgresRequestSourceAdmissionStore,
  requestReleaseSourceEvidence,
} from "../adapters/out/postgres/request-source-admission-store.ts";
import { RequestSpaceError } from "../domain/work/request-spaces.ts";
import type { PostgresHostStorage } from "../adapters/out/postgres/host-storage.ts";
import { GitModelRepository } from "../adapters/out/git/repository.ts";
import { GitReleaseTags } from "../adapters/out/git/release-tags.ts";
import { GitRequestBranches } from "../adapters/out/git/request-branches.ts";
import type { RepositoryWriterLock } from "../adapters/out/git/writer-lock.ts";
import { RequestReleaseProvenance } from "../adapters/work/request-release-provenance.ts";
import type { SavedSystemAssets } from "../adapters/work/saved-system-assets.ts";
import type { OpeningRecord } from "../domain/work/request-spaces.ts";
import type { RequestReleaseAdmissionReference } from "../domain/work/saved-systems.ts";
import {
  createSavedSystemsComposition,
  type SavedSystemsCompositionOptions,
} from "./saved-systems.ts";

export interface RequestReleasesCompositionOptions extends
  Omit<
    SavedSystemsCompositionOptions,
    "client" | "scope" | "requestProvenance" | "creation" | "creationGuard"
  > {
  storage: PostgresHostStorage;
  controls: SpaceControlPort;
  writerLock: RepositoryWriterLock;
}

/** Fixed host composition: shared source assets and one existing SavedSystem
 * store with real current-control acceptance guards for both Main and Request.
 * No runtime, worker, listener, credential or admission is created here. */
export function createRequestReleasesComposition(
  options: RequestReleasesCompositionOptions,
) {
  const { storage } = options;
  const admissions = new PostgresRequestSourceAdmissionStore(storage.client);
  const branches = new GitRequestBranches({
    projectDir: options.projectDir,
    writerLock: options.writerLock,
    admittedVersion: async (opening) => {
      const chain = await storage.client.$transaction(
        (tx) => admissions.readAdmittedSource(tx, opening),
        { isolationLevel: "RepeatableRead" },
      );
      if (chain.head.source.repositoryId !== options.repositoryId) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The Request source belongs to another repository.",
        );
      }
      return chain.head.source.version;
    },
    reader: () =>
      GitModelRepository.openReadOnly({
        projectDir: options.projectDir,
        repositoryId: options.repositoryId,
        buildService: options.buildService,
      }),
  });
  const openings = new PostgresRequestSpaceStore(storage.client, storage.scope);
  const chainFor = (record: OpeningRecord) =>
    storage.client.$transaction(
      (tx) => admissions.readAdmittedSource(tx, record),
      { isolationLevel: "RepeatableRead" },
    );
  const historical = async (
    record: OpeningRecord,
    reference: RequestReleaseAdmissionReference,
  ) => {
    const chain = await chainFor(record);
    const facts = requestReleaseSourceEvidence(record, chain, reference);
    const receipt = chain.receipts.find((entry) =>
      entry.revision === reference.revision &&
      entry.manifestDigest === reference.manifestDigest
    );
    const software = chain.softwareReceipts.find((entry) =>
      entry.revision === reference.revision &&
      entry.manifestDigest === reference.manifestDigest
    );
    if (Boolean(receipt) === Boolean(software)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The Request source admission is unavailable.",
      );
    }
    const reader = await GitModelRepository.openReadOnly({
      projectDir: options.projectDir,
      repositoryId: options.repositoryId,
      buildService: options.buildService,
    });
    if (software) {
      // Software retention/reopening proves its dedicated queue + lifecycle/D2
      // evidence and Git anchors; a human owner envelope is never substituted.
      await storage.client.$transaction(
        (tx) =>
          readScopedSoftwareSourceAdmissionProof(tx, storage.client, software),
        { isolationLevel: "RepeatableRead" },
      );
      await reader.verifyScopedSoftwareSourceAdmission(software.payload);
    } else {
      if (!receipt) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The Request source admission is unavailable.",
        );
      }
      await reader.verifyRequestSourceAdmission(receipt.payload);
    }
    return facts;
  };
  const admittedInspection = async (
    record: OpeningRecord,
    version: string,
  ): Promise<string> => {
    const chain = await chainFor(record);
    const select = async (revision: number, manifestDigest: string) => {
      const reference: RequestReleaseAdmissionReference = {
        format: "request-release-admission/v1",
        openingId: record.id,
        openingBaseDigest: record.baseDigest!,
        revision,
        manifestDigest,
      };
      return await historical(record, reference);
    };
    if (chain.head.revision !== chain.baseline.revision) {
      const head = await select(chain.head.revision, chain.head.manifestDigest);
      if (head.source.version !== chain.head.source.version) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The admitted Request source is unavailable.",
        );
      }
    }
    if (version !== chain.baseline.source.version) {
      const selected = [...chain.receipts, ...chain.softwareReceipts].filter((
        entry,
      ) => entry.payload.result.source.version === version);
      if (selected.length !== 1) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The selected Request source is not admitted.",
        );
      }
      if (selected[0].revision !== chain.head.revision) {
        await select(selected[0].revision, selected[0].manifestDigest);
      }
    }
    await branches.assertRetainedExecutionVersion(record, version);
    const latest = await chainFor(record);
    if (
      latest.head.revision !== chain.head.revision ||
      latest.head.manifestDigest !== chain.head.manifestDigest
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The admitted Request source changed during inspection.",
      );
    }
    return chain.head.source.version;
  };
  const provenance = new RequestReleaseProvenance({
    scope: storage.scope,
    repositoryId: options.repositoryId,
    openings,
    branches,
    journal: {
      async selected(record, version) {
        const chain = await chainFor(record);
        if (chain.baseline.source.version === version) return null;
        const receipts = [...chain.receipts, ...chain.softwareReceipts].filter((
          entry,
        ) => entry.payload.result.source.version === version);
        if (receipts.length !== 1) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "The selected Request source is not admitted.",
          );
        }
        const reference: RequestReleaseAdmissionReference = {
          format: "request-release-admission/v1",
          openingId: record.id,
          openingBaseDigest: record.baseDigest!,
          revision: receipts[0].revision,
          manifestDigest: receipts[0].manifestDigest,
        };
        // This is proof of a selected source, not permission to publish it.
        return await historical(record, reference);
      },
      historical,
    },
    canReadScope(scope) {
      if (!sourceVisibility) {
        throw new Error("Release source composition is not ready");
      }
      return sourceVisibility(scope);
    },
    inspectModels(manifest) {
      if (!assets) throw new Error("Release assets composition is not ready");
      return assets.inspectModels(manifest);
    },
    readState: (record) =>
      storage.readCaseRuntimeState(
        record.executionSpaceId,
        record.caseId,
        record.base!.requestOwner.operatorId,
      ),
  });
  const creationGuard = new PostgresReleaseCreationGuard(
    storage.client,
    storage.primarySpaceControl,
  );
  const savedSystems = createSavedSystemsComposition({
    ...options,
    client: storage.client,
    scope: { ...storage.scope, executionSpaceId: "main" },
    requestProvenance: provenance,
    tags: new GitReleaseTags({
      projectDir: options.projectDir,
      repositoryId: options.repositoryId,
      reader: () =>
        GitModelRepository.openReadOnly({
          projectDir: options.projectDir,
          repositoryId: options.repositoryId,
          buildService: options.buildService,
        }),
      writerLock: options.writerLock,
      notifyCatalogue: options.notifyCatalogue,
    }),
    creation: new ReleaseCreationAuthority(options.controls),
    creationGuard,
    tagMutation: creationGuard,
  });
  const assets: SavedSystemAssets = savedSystems.assets;
  const sourceVisibility: ReturnType<
    typeof createSavedSystemsComposition
  >["canReadScope"] = savedSystems.canReadScope;
  const releases = new RequestReleases({
    scope: storage.scope,
    control: options.controls,
    openings,
    catalogue: new PostgresRequestReleaseCatalogue(
      storage.client,
      storage.scope,
    ),
    service: savedSystems.serviceFor,
  });
  return { savedSystems, releases, provenance, branches, admittedInspection };
}
