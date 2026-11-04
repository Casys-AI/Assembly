import { sourceExecutablesCompilation } from "../adapters/out/sysml-toolkit/compilation/source-executables.ts";
import type { createRequestReleasesComposition } from "./request-releases.ts";
import type { ModelBuildService } from "../application/model/builds/service.ts";
import { RequestOpeningSources } from "../application/work/request-spaces/opening-sources.ts";
import { RequestOpeningHost } from "../application/work/request-spaces/opening-host.ts";
import { GitModelRepository } from "../adapters/out/git/repository.ts";
import { GitRequestBranches } from "../adapters/out/git/request-branches.ts";
import type { RepositoryWriterLock } from "../adapters/out/git/writer-lock.ts";
import type { SavedSystemScope } from "../domain/work/saved-systems.ts";
import { RequestRuntimeDependencies } from "./request-runtime-dependencies.ts";
import { RequestSpaceError } from "../domain/work/request-spaces.ts";
import type { createSavedSystemsComposition } from "./saved-systems.ts";

export interface RequestOpeningSourcesCompositionOptions {
  scope: SavedSystemScope;
  projectDir: string;
  repositoryId: string;
  buildService: ModelBuildService;
  repository: Pick<GitModelRepository, "history" | "header">;
  writerLock: RepositoryWriterLock;
  savedSystems: ReturnType<typeof createSavedSystemsComposition>;
  dependencies: RequestRuntimeDependencies;
  requestReleases?: ReturnType<typeof createRequestReleasesComposition>;
}

/** Real source/retention adapters, the canonical writer lock and one concrete
 * Case dependency factory travel together. No readiness boolean is accepted. */
export function createRequestOpeningSourcesComposition(
  options: RequestOpeningSourcesCompositionOptions,
) {
  if (!(options.dependencies instanceof RequestRuntimeDependencies)) {
    throw new RequestSpaceError(
      "FORBIDDEN",
      "A concrete scoped Request dependency factory is required",
    );
  }
  const sourceScope = Object.freeze({ ...options.scope });
  const sourceProjectId = `git:${options.repositoryId}`;
  const dependencies = options.dependencies.create;
  const reader = () =>
    GitModelRepository.openReadOnly({
      projectDir: options.projectDir,
      repositoryId: options.repositoryId,
      buildService: options.buildService,
    });
  const host = new RequestOpeningHost({
    compilation: sourceExecutablesCompilation,
    scope: sourceScope,
    sourceProjectId,
    repositoryId: options.repositoryId,
    repository: options.repository,
    reader,
    runner: options.dependencies.runner,
    dependencies,
    inspectInitialSkills: options.dependencies.inspectInitialSkills,
    assertSourceOriginRelation: options.requestReleases
      ? (manifest) =>
        options.requestReleases!.provenance.assertOriginRelation(manifest)
      : undefined,
  });
  const source = new RequestOpeningSources({
    compilation: sourceExecutablesCompilation,
    sourceScope,
    sourceProjectId,
    registry: options.savedSystems.assets,
    assets: options.savedSystems.assets,
    releases: options.requestReleases
      ? {
        inspect: (id, controller) =>
          options.requestReleases!.releases.inspectForOpening(id, controller),
      }
      : options.savedSystems.service,
    reader,
    currentMainVersion: host.currentMainVersion,
    supportsHost: host.supportsHost,
    inspectHostSupport: host.inspectHostSupport,
  });
  const branches = options.requestReleases?.branches ?? new GitRequestBranches({
    projectDir: options.projectDir,
    writerLock: options.writerLock,
    reader,
  });
  return {
    source,
    branches,
    sourceProvenance: options.requestReleases?.provenance,
    admittedInspection: options.requestReleases?.admittedInspection,
    dependencies,
    readBundledSkill: options.dependencies.readBundledSkill,
    supportsHost: host.supportsHost,
    inspectHostSupport: host.inspectHostSupport,
  };
}
