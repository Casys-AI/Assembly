import type { ReleaseCreationAuthorizationPort } from "../application/work/saved-systems/creation-authorization.ts";
import type {
  ModelTagMutationPort,
  ReleaseTagsPort,
} from "../application/work/saved-systems/ports.ts";
import type { PostgresReleaseCreationGuard } from "../adapters/out/postgres/release-creation-guard.ts";
import type { RequestReleaseProvenancePort } from "../application/work/saved-systems/request-release-ports.ts";
import { toolDraftDigest } from "../application/work/artifacts/catalog.ts";
import { canonical } from "../domain/primitives/canonical-json.ts";
import {
  SavedSystemError,
  type SavedSystemScope,
} from "../domain/work/saved-systems.ts";
import { PostgresArtifactBindings } from "../adapters/work/artifacts/postgres-bindings.ts";
import { PostgresSavedSystemStore } from "../adapters/out/postgres/saved-system-store.ts";
import { SavedSystemAssets } from "../adapters/work/saved-system-assets.ts";
import { SavedSystemsService } from "../application/work/saved-systems/service.ts";
import { GitModelRepository } from "../adapters/out/git/repository.ts";
import type { PrismaClient } from "../adapters/out/postgres/client.ts";
import type { ModelBuildService } from "../application/model/builds/service.ts";
import type { ModelBuildStore } from "../application/model/builds/ports/out/build-store.port.ts";
import type { ModelBuildVaultPort } from "../application/model/builds/ports/out/build-vault.port.ts";

export interface SavedSystemsCompositionOptions {
  client: PrismaClient;
  scope: SavedSystemScope;
  projectDir: string;
  repositoryId: string;
  sourceScopeId: string;
  primaryOperatorId: string;
  buildService: ModelBuildService;
  vault: ModelBuildVaultPort;
  cache: Pick<ModelBuildStore, "get">;
  retainCommit(version: string): Promise<string>;
  requestProvenance?: RequestReleaseProvenancePort;
  creation?: ReleaseCreationAuthorizationPort;
  tags?: ReleaseTagsPort;
  tagMutation?: ModelTagMutationPort;
  notifyCatalogue?: () => void;
  creationGuard?: Pick<
    PostgresReleaseCreationGuard,
    "assertLocked" | "assertNativeLocked"
  >;
}

/** Shared host-local source visibility and exact saved-system composition. */
export function createSavedSystemsComposition(
  options: SavedSystemsCompositionOptions,
) {
  const savedScope = Object.freeze({ ...options.scope });
  async function canReadScope(scope: SavedSystemScope): Promise<boolean> {
    if (
      scope.projectId !== savedScope.projectId ||
      scope.systemId !== savedScope.systemId
    ) return false;
    const [space, source] = await Promise.all([
      options.client.executionSpace.findUnique({
        where: { projectId_systemId_executionSpaceId: scope },
      }),
      options.client.sourceRepository.findUnique({
        where: {
          projectId_systemId_repositoryId: {
            projectId: savedScope.projectId,
            systemId: savedScope.systemId,
            repositoryId: options.repositoryId,
          },
        },
      }),
    ]);
    // Closing/retiring a runtime preserves local historical source access.
    // These scoped records establish repository identity/existence, not a
    // principal ACL or a qualified historical-revocation mechanism. Missing or
    // foreign source/scope records refuse this host-local read.
    return Boolean(space && source?.sourceScopeId === options.sourceScopeId);
  }
  const canReadSavedSourceScope = () => canReadScope(savedScope);
  const savedAssets = new SavedSystemAssets({
    projectDir: options.projectDir,
    repositoryId: options.repositoryId,
    projectId: savedScope.projectId,
    sourceScopeId: options.sourceScopeId,
    primaryOperatorId: options.primaryOperatorId,
    buildService: options.buildService,
    vault: options.vault,
    cache: options.cache,
    retainCommit: options.retainCommit,
    canReadScope,
    requestProvenance: options.requestProvenance,
    async findTool(operatorId, entry) {
      if (!await canReadSavedSourceScope()) {
        throw new SavedSystemError(
          "FORBIDDEN",
          "Release source access is unavailable.",
        );
      }
      // Lookup is by exact source occurrence and bytes, never runtime catalog or
      // current candidate stage. Old immutable bindings remain legitimate sources.
      const rows = await options.client.artifactBinding.findMany({
        where: {
          ...savedScope,
          operatorId,
          ownerId: operatorId,
          localArtifactId: entry.candidateId,
          version: {
            repositoryId: options.repositoryId,
            sourceScopeId: options.sourceScopeId,
            contentDigest: entry.digest,
            kind: "tool-draft",
          },
        },
        select: { bindingId: true },
        orderBy: { bindingId: "asc" },
        take: 257,
      });
      if (rows.length > 256) return null;
      const bindings = new PostgresArtifactBindings({
        client: options.client,
        scope: { ...savedScope, operatorId },
        repositoryId: options.repositoryId,
        sourceScopeId: options.sourceScopeId,
      });
      const reader = await GitModelRepository.openArtifactSourcesReadOnly({
        projectDir: options.projectDir,
        repositoryId: options.repositoryId,
        scopeId: options.sourceScopeId,
      });
      for (const row of rows) {
        try {
          const before = await bindings.read(row.bindingId);
          if (
            !before || before.binding.reference.contentDigest !== entry.digest
          ) continue;
          const source = await reader.read(before.binding.reference);
          const after = await bindings.read(row.bindingId);
          if (!await canReadSavedSourceScope()) {
            throw new SavedSystemError(
              "FORBIDDEN",
              "Release source access changed.",
            );
          }
          if (
            !after || canonical(after.binding) !== canonical(before.binding) ||
            source.kind !== "tool-draft"
          ) continue;
          const draft = source.content;
          if (
            draft.name !== entry.name || draft.kind !== entry.kind ||
            await toolDraftDigest(draft) !== entry.digest
          ) continue;
          return {
            candidateId: entry.candidateId,
            digest: entry.digest,
            sourceBinding: before.binding,
            draft,
          };
        } catch (error) {
          if (error instanceof SavedSystemError) throw error;
          // A corrupt/missing exact binding is a missing dependency, not a
          // reason to substitute runtime bytes or a different source digest.
        }
      }
      return null;
    },
    async resolveTool(tool, operatorId) {
      const expected = tool.sourceBinding;
      if (
        !expected || expected.ownerId !== operatorId ||
        expected.localArtifactId !== tool.candidateId ||
        expected.reference.scopeId !== options.sourceScopeId ||
        expected.reference.repositoryId !== options.repositoryId ||
        !await canReadSavedSourceScope()
      ) {
        throw new SavedSystemError(
          "FORBIDDEN",
          "Saved source access is unavailable.",
        );
      }
      // Construct read-only binding access directly. storage.operator() would
      // recreate registration and must not be used for historical inspection.
      const bindings = new PostgresArtifactBindings({
        client: options.client,
        scope: { ...savedScope, operatorId },
        repositoryId: options.repositoryId,
        sourceScopeId: options.sourceScopeId,
      });
      const before = await bindings.read(expected.bindingId);
      if (!before || canonical(before.binding) !== canonical(expected)) {
        throw new SavedSystemError(
          "FORBIDDEN",
          "Saved source binding is unavailable.",
        );
      }
      const reader = await GitModelRepository.openArtifactSourcesReadOnly({
        projectDir: options.projectDir,
        repositoryId: options.repositoryId,
        scopeId: options.sourceScopeId,
      });
      const source = await reader.read(expected.reference);
      const after = await bindings.read(expected.bindingId);
      if (
        !after || canonical(after.binding) !== canonical(expected) ||
        !await canReadSavedSourceScope()
      ) throw new SavedSystemError("FORBIDDEN", "Saved source access changed.");
      if (source.kind !== "tool-draft") {
        throw new Error("Saved tool source differs");
      }
      return source.content;
    },
  });
  const deniedCreation: ReleaseCreationAuthorizationPort = {
    authorize() {
      throw new SavedSystemError(
        "FORBIDDEN",
        "Explicit current Release creation authority is unavailable.",
      );
    },
    revalidate() {
      throw new SavedSystemError(
        "FORBIDDEN",
        "Explicit current Release creation authority is unavailable.",
      );
    },
  };
  const store = new PostgresSavedSystemStore(
    options.client,
    options.creationGuard,
    undefined,
    options.notifyCatalogue,
  );
  const serviceFor = (scope: SavedSystemScope) =>
    new SavedSystemsService(
      store,
      savedAssets,
      {
        async canRead(selected, _operatorIds) {
          return selected.projectId === scope.projectId &&
            selected.systemId === scope.systemId &&
            selected.executionSpaceId === scope.executionSpaceId &&
            await canReadScope(selected);
        },
      },
      Object.freeze({ ...scope }),
      savedAssets,
      // Read/source-only compositions may omit the mutation boundary, but their
      // returned service then refuses creation rather than restoring legacy save.
      options.creation && options.creationGuard
        ? options.creation
        : deniedCreation,
      options.tags,
      options.tagMutation,
    );
  const savedSystems = serviceFor(savedScope);
  return {
    service: savedSystems,
    assets: savedAssets,
    serviceFor,
    canReadScope,
  };
}
