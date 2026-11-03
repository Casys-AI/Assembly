import {
  ArtifactSourceService,
  type ArtifactSourceServicePort,
  type QueuedArtifactSourcePublisher,
} from "../application/work/artifacts/publication.ts";
import type { ArtifactSourceRepositoryPort } from "../application/work/artifacts/source-repository.ts";
import { PostgresArtifactBindings } from "../adapters/work/artifacts/postgres-bindings.ts";
import type { PrismaClient } from "../adapters/out/postgres/client.ts";
import { safeStoragePort } from "../adapters/out/postgres/errors.ts";
import {
  assertPostgresRuntimeScope,
  assertPostgresSystemScope,
  type PostgresRuntimeScope,
  type PostgresSystemScope,
} from "../adapters/out/postgres/scope.ts";
import { canonical } from "../domain/primitives/canonical-json.ts";
import { ArtifactSourceError } from "../domain/work/artifacts/source-reference.ts";

export interface ArtifactSourceServicesOptions {
  client: PrismaClient;
  hostScope: PostgresSystemScope;
  repositoryId: string;
  sourceScopeId: string;
  repository: ArtifactSourceRepositoryPort;
  queuedPublisher: QueuedArtifactSourcePublisher;
  sourceHeader(
    version: string,
  ): Promise<{ version: string; sourceDigest: string }>;
}

/** Assemble target-local bindings over the host's existing source writer and
 * retained reader. This factory performs no queries, registration or authority
 * checks; trusted composition supplies an existing store's full runtime scope. */
export function createArtifactSourceServices(
  options: ArtifactSourceServicesOptions,
): (scope: PostgresRuntimeScope) => Promise<ArtifactSourceServicePort> {
  const hostScope = Object.freeze({
    projectId: options.hostScope.projectId,
    systemId: options.hostScope.systemId,
  });
  assertPostgresSystemScope(hostScope);
  const {
    client,
    repositoryId,
    sourceScopeId,
    repository,
    queuedPublisher,
    sourceHeader,
  } = options;
  const services = new Map<string, Promise<ArtifactSourceServicePort>>();
  return async function artifactSourcesForScope(scope) {
    const captured = Object.freeze({
      projectId: scope.projectId,
      systemId: scope.systemId,
      executionSpaceId: scope.executionSpaceId,
      operatorId: scope.operatorId,
    });
    assertPostgresRuntimeScope(captured);
    if (
      captured.projectId !== hostScope.projectId ||
      captured.systemId !== hostScope.systemId
    ) throw new ArtifactSourceError("scope");
    const key = canonical(captured);
    let pending = services.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() =>
        safeStoragePort(
          new ArtifactSourceService({
            scope: captured,
            repositoryId,
            sourceScopeId,
            repository,
            queuedPublisher,
            bindings: new PostgresArtifactBindings({
              client,
              scope: captured,
              repositoryId,
              sourceScopeId,
            }),
            sourceHeader,
          }),
        )
      );
      services.set(key, pending);
      void pending.catch(() => {
        if (services.get(key) === pending) services.delete(key);
      });
    }
    return await pending;
  };
}
