/** Lot 10 composition: cached model projections and their HTTP facades.
 * `model-projections_test.ts` composes them with stub repositories and serves
 * them through the HTTP app, prewarms included. */
import { createModelSourceTokensHandler } from "../adapters/in/http/model/source-tokens.ts";
import { createModelBoardHandler } from "../adapters/in/http/model/board.ts";
import { createAuthorityMatrixHandler } from "../adapters/in/http/governance/authority-matrix.ts";
import { createModelAttentionHandler } from "../adapters/in/http/model/attention.ts";
import { createModelViewsHandler } from "../adapters/in/http/model/views.ts";
import { createModelBoardHeadReader } from "../adapters/model/projections/board-reader.ts";
import { createCachedModelProjections } from "../adapters/model/projections/cache.ts";
import { ModelBoardService } from "../application/model/projections/board.ts";
import {
  ModelViewDiagramService,
  ModelViewListService,
  ModelViewPlantumlService,
} from "../application/model/projections/views.ts";
import { ReadAuthorityMatrix } from "../application/governance/handlers/authority-matrix-handler.ts";
import { ModelAttentionService } from "../application/model/projections/attention.ts";
import type { ModelDiagnosticsService } from "../application/model/diagnostics/service.ts";
import type { ModelRepositoryPort } from "../application/model/repository.ts";
import type { ModelBuildStore } from "../application/model/builds/ports/out/build-store.port.ts";
import type { ModelDiagnosticsPort } from "../application/work/runtime/ports.ts";
import type { SysmlToolkitAdapter } from "../adapters/out/sysml-toolkit/adapter.ts";
import type { AuthorityMatrixProjection } from "../adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts";
import {
  errorLogProperties,
  technicalLogger,
} from "../infrastructure/logging.ts";

const log = technicalLogger("composition");

export interface ModelProjectionDependencies {
  repository: ModelRepositoryPort;
  project: { id: string };
  projectId: string;
  tooling: SysmlToolkitAdapter;
  buildStore: ModelBuildStore | undefined;
  toolkitDigest: string;
  modelDiagnostics: ModelDiagnosticsService;
  /** Absent in production: the cache uses its isolated Toolkit projector. */
  authorityMatrixProject?: AuthorityMatrixProjection;
}

export function composeModelProjections(
  dependencies: ModelProjectionDependencies,
) {
  const {
    repository,
    project,
    projectId,
    tooling,
    buildStore,
    toolkitDigest,
    modelDiagnostics,
  } = dependencies;
  const projectionReaders = createCachedModelProjections({
    repository,
    repositoryId: project.id,
    projectId,
    tooling,
    buildStore,
    toolkitIdentity: toolkitDigest,
    authorityMatrixProject: dependencies.authorityMatrixProject,
  });
  const modelBoard = new ModelBoardService(
    projectionReaders.board,
  );
  const readModelBoardHead = createModelBoardHeadReader(repository);
  const handleModelBoard = createModelBoardHandler(
    modelBoard,
    readModelBoardHead,
  );
  const authorityMatrix = ReadAuthorityMatrix(
    projectionReaders.authorityMatrix,
  );
  const handleAuthorityMatrix = createAuthorityMatrixHandler(
    authorityMatrix,
    readModelBoardHead,
  );
  const runtimeModelDiagnostics: ModelDiagnosticsPort = {
    async read(current, version) {
      return (await modelDiagnostics.list(
        version ?? current.version.repositoryVersion,
      )).diagnostics;
    },
  };
  const modelAttention = new ModelAttentionService({
    matrix: authorityMatrix,
    board: modelBoard,
    diagnostics: modelDiagnostics,
  });
  const handleModelAttention = createModelAttentionHandler(
    modelAttention,
    readModelBoardHead,
  );
  const handleSourceTokens = createModelSourceTokensHandler({
    repository,
    tooling,
  });

  const modelViewList = new ModelViewListService(
    projectionReaders.views,
  );
  const modelViewDiagram = new ModelViewDiagramService(
    projectionReaders.views,
  );
  const modelViewPlantuml = new ModelViewPlantumlService(
    projectionReaders.views,
  );
  const handleModelViews = createModelViewsHandler({
    list: modelViewList,
    diagram: modelViewDiagram,
    plantuml: modelViewPlantuml,
    head: readModelBoardHead,
  });
  return {
    projectionReaders,
    modelBoard,
    readModelBoardHead,
    handleModelBoard,
    authorityMatrix,
    handleAuthorityMatrix,
    runtimeModelDiagnostics,
    modelAttention,
    handleModelAttention,
    handleSourceTokens,
    modelViewList,
    modelViewDiagram,
    modelViewPlantuml,
    handleModelViews,
  };
}

export type ModelProjectionAssembly = ReturnType<
  typeof composeModelProjections
>;

/** Advisory prewarming starts only after listening. Reading the head and
 * projecting it share this isolated rejection boundary, like model-version. */
export function startModelProjectionPrewarms(
  projections: ModelProjectionAssembly,
): void {
  const {
    projectionReaders,
    modelBoard,
    readModelBoardHead,
    modelAttention,
    modelViewList,
    authorityMatrix,
  } = projections;
  void Promise.resolve().then(async () => {
    await projectionReaders.requestCurrent(await readModelBoardHead());
    await modelBoard.read(await readModelBoardHead());
  }).catch((error) =>
    log.warn("Initial model board read failed", errorLogProperties(error))
  );
  // Independent advisory warmup: an attention failure cannot prevent startup,
  // and a ready count lets the first model-version event carry it.
  void Promise.resolve().then(async () => {
    await modelAttention.read(await readModelBoardHead());
  }).catch((error) =>
    log.warn("Initial model attention read failed", errorLogProperties(error))
  );
  // Independent advisory warmup: a views failure cannot prevent board startup.
  void Promise.resolve().then(async () => {
    await modelViewList.read(await readModelBoardHead());
  }).catch((error) =>
    log.warn("Initial model views read failed", errorLogProperties(error))
  );
  // Independent advisory warmup: a matrix failure cannot prevent board startup.
  void Promise.resolve().then(async () => {
    await authorityMatrix.read(await readModelBoardHead());
  }).catch((error) =>
    log.warn("Initial authority matrix read failed", errorLogProperties(error))
  );
}
