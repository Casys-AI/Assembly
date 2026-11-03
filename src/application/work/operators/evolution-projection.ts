import { persistedOrder } from "../../../domain/primitives/persisted-order.ts";
/** Read-only dossier cards. Immutable source headers are read without compiling. */
import type {
  EvolutionConversationRecord,
  EvolutionConversationsSnapshot,
} from "../../../domain/work/records/operator-evolution.ts";
import type {
  EvolutionDossier,
  EvolutionStorePort,
} from "../../model/evolution/ports.ts";
import { EvolutionError } from "../../model/evolution/ports.ts";
import type { ModelRepositoryPort } from "../../model/repository.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";

export class EvolutionConversationProjection {
  readonly #sources = new Map<
    string,
    Promise<Pick<EvolutionConversationRecord, "reason" | "base" | "candidate">>
  >();
  constructor(
    readonly options: {
      repositoryId: string;
      store: EvolutionStorePort;
      repository: Pick<ModelRepositoryPort, "proposal" | "header">;
    },
  ) {}

  async record(
    d: EvolutionDossier,
    labels: ReadonlyMap<string, string | null>,
  ): Promise<EvolutionConversationRecord> {
    if (
      d.repositoryId !== this.options.repositoryId ||
      Boolean(d.origin.requestId) === Boolean(d.origin.designerScopeId)
    ) {
      throw new EvolutionError(
        "EVOLUTION_ORIGIN_INVALID",
        "The dossier has no exact Request or designer origin",
      );
    }
    const key = JSON.stringify([
      d.proposal.id,
      d.proposal.digest,
      d.proposal.baseVersion,
      d.proposal.version,
      d.proposal.sourceDigest,
    ]);
    let source = this.#sources.get(key);
    if (!source) {
      source = (async () => {
        const [proposal, base, candidate] = await Promise.all([
          this.options.repository.proposal(d.proposal.id),
          this.options.repository.header(d.proposal.baseVersion),
          this.options.repository.header(d.proposal.version),
        ]);
        if (
          proposal.id !== d.proposal.id ||
          proposal.baseVersion !== d.proposal.baseVersion ||
          proposal.proposalVersion !== d.proposal.version ||
          proposal.sourceDigest !== d.proposal.sourceDigest ||
          proposal.authorization?.kind !== "operator-evolution" ||
          proposal.authorization.operatorNativeId !==
            d.preparation.operatorNativeId ||
          proposal.authorization.exercise.operatorNativeId !==
            d.preparation.operatorNativeId ||
          proposal.authorization.exercise.proposalDigest !==
            d.proposal.digest ||
          proposal.author !== `agent:${d.preparation.operatorNativeId}` ||
          base.version !== d.proposal.baseVersion ||
          candidate.version !== d.proposal.version ||
          candidate.sourceDigest !== d.proposal.sourceDigest
        ) {
          throw new EvolutionError(
            "EVOLUTION_SOURCE_CHANGED",
            "The dossier and its immutable source proposal differ",
          );
        }
        return {
          reason: proposal.reason.slice(0, 2000),
          base: { version: base.version, sourceDigest: base.sourceDigest },
          candidate: {
            version: candidate.version,
            sourceDigest: candidate.sourceDigest,
          },
        };
      })();
      this.#sources.set(key, source);
      source.catch(() => this.#sources.delete(key));
      // Metadata only; never retain complete source trees in this projection.
      if (this.#sources.size > 256) {
        this.#sources.delete(this.#sources.keys().next().value!);
      }
    }
    const identities = await source;
    const named = (operatorId: string) => ({
      operatorId,
      name: labels.get(operatorId) ?? null,
    });
    return {
      dossierId: d.id,
      revision: d.revision,
      status: d.status,
      proposalId: d.proposal.id,
      proposalDigest: d.proposal.digest,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      ...structuredClone(identities),
      origin: {
        operatorId: d.origin.operatorId,
        ...(d.origin.requestId ? { requestId: d.origin.requestId } : {}),
        ...(d.origin.designerScopeId
          ? { designerScopeId: d.origin.designerScopeId }
          : {}),
      },
      preparer: named(d.preparation.operatorNativeId),
      finalizer: named(d.finalizerActorId),
      categories: [...d.proposal.categories],
      targets: d.proposal.targets.map((target) => ({
        ...target,
        name: labels.get(target.operatorId) ?? null,
      })),
      recipeDigest: d.proposal.recipeDigest,
      ...(d.publication
        ? {
          publication: {
            version: d.publication.version,
            sourceDigest: d.publication.sourceDigest,
            proposalDigest: d.publication.proposalDigest,
          },
        }
        : {}),
      adoptions: structuredClone(d.adoptions),
      blockers: d.blockers.slice(0, 16).map((blocker) => ({
        ...blocker,
        detail: blocker.detail.slice(0, 500),
      })),
    };
  }

  async read(
    labels: ReadonlyMap<string, string | null>,
  ): Promise<EvolutionConversationsSnapshot> {
    const recent = this.options.store.listRecent
      ? await this.options.store.listRecent(this.options.repositoryId, 256)
      : await this.options.store.listPending(this.options.repositoryId);
    const scoped = recent.filter((d) =>
      labels.has(d.origin.operatorId) &&
      Boolean(d.origin.requestId) !== Boolean(d.origin.designerScopeId)
    )
      .sort((a, b) =>
        persistedOrder(b.updatedAt, a.updatedAt) || persistedOrder(a.id, b.id)
      );
    const items = await Promise.all(
      scoped.slice(0, 64).map((d) => this.record(d, labels)),
    );
    const truncated = scoped.length > 64 || recent.length >= 256;
    return {
      version: `evolutions:${await executionDigest({ items, truncated })}`,
      items,
      truncated,
    };
  }

  close(): void {
    this.#sources.clear();
  }
}
