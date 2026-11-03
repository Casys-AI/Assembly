import type { EvolutionStorePort } from "../../../application/model/evolution/ports.ts";
import type { ScopedSoftwareEvolutionDossierV2 } from "../../../application/model/evolution/scoped-software-dossier.ts";
import {
  assertScopedSoftwareWriteMatchesEvolution,
  parseScopedSoftwareWriteDossier,
} from "../../../application/model/publication/scoped-software-write.ts";
import type {
  ScopedSoftwareSourcePublicationProtocol,
  ScopedSoftwareSourceWriteResolver,
} from "../../../application/model/publication/ports/out/scoped-software-source-publication.port.ts";
import { ModelRepositoryError } from "../../../application/model/repository.ts";
import type { GitModelRepository } from "../../out/git/repository.ts";

/** One existing repository/queue, bound by host composition to the scoped
 * durable lifecycle. Resolution performs immutable reads only; fresh rights
 * are checked after recovery has ruled out a past exact Git effect. */
export function createScopedSoftwareSourceWriteResolver(options: {
  repository: Pick<GitModelRepository, "scopedSoftwareSourceWrite">;
  store: Pick<EvolutionStorePort<ScopedSoftwareEvolutionDossierV2>, "get">;
  protocol: ScopedSoftwareSourcePublicationProtocol;
}): ScopedSoftwareSourceWriteResolver {
  return {
    async resolve(value) {
      const dossier = await parseScopedSoftwareWriteDossier(value);
      const evolution = await options.store.get(dossier.decision.dossierId);
      if (!evolution) {
        throw new ModelRepositoryError(
          "SOURCE_CONFLICT",
          "The durable scoped software evolution is unavailable",
        );
      }
      await assertScopedSoftwareWriteMatchesEvolution(dossier, evolution);
      return await options.repository.scopedSoftwareSourceWrite({
        dossier,
        evolution,
        protocol: options.protocol,
      });
    },
  };
}
