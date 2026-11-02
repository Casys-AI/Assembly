import type { ModelDiagnosticsService } from "./service.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import type {
  ModelDiagnosticsEmitter,
  ModelDiagnosticsRevalidator,
} from "./ports/out/diagnostics-notifications.port.ts";

/** Counts describe all findings, including masked ones. Masking is a view
 * preference, not evidence that a finding has been resolved. */
export async function revalidateModelDiagnostics(
  diagnostics: Pick<ModelDiagnosticsService, "list">,
  version: string,
  emit: ModelDiagnosticsEmitter,
): Promise<void> {
  const result = await diagnostics.list(version);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of result.diagnostics) counts[diagnostic.severity]++;
  emit("diagnostics", {
    version: result.version,
    sourceDigest: result.sourceDigest,
    counts,
  });
}

/** Observe completed source transitions, including isolated proposals. The
 * callback runs outside repository locks. Advisory linting cannot undo or
 * turn a successful source mutation into an apparent failure. */
export function observeModelRevisions(
  repository: ModelRepositoryPort,
  revalidate: ModelDiagnosticsRevalidator,
): ModelRepositoryPort {
  const notify = async (version: string) => {
    try {
      await revalidate(version);
    } catch { /* Diagnostics do not change source admission authority. */ }
  };
  return {
    async initialize(sources) {
      const revision = await repository.initialize(sources);
      await notify(revision.version);
      return revision;
    },
    current: () => repository.current(),
    ...(repository.descriptorAt
      ? { descriptorAt: (version: string) => repository.descriptorAt!(version) }
      : {}),
    ...(repository.reachableArtifactDigests
      ? {
        reachableArtifactDigests: () => repository.reachableArtifactDigests!(),
      }
      : {}),
    ...(repository.headVersion
      ? { headVersion: () => repository.headVersion!() }
      : {}),
    ...(repository.findPublicationByCommand
      ? {
        findPublicationByCommand: (id: string) =>
          repository.findPublicationByCommand!(id),
      }
      : {}),
    ...(repository.publishPrepared
      ? {
        async publishPrepared(
          input: Parameters<
            NonNullable<ModelRepositoryPort["publishPrepared"]>
          >[0],
        ) {
          const revision = await repository.publishPrepared!(input);
          await notify(revision.version);
          return revision;
        },
      }
      : {}),
    ...(repository.anchorCommandPublication
      ? {
        anchorCommandPublication: (
          input: Parameters<
            NonNullable<ModelRepositoryPort["anchorCommandPublication"]>
          >[0],
        ) => repository.anchorCommandPublication!(input),
      }
      : {}),
    at: (version, signal) => repository.at(version, signal),
    header: (version, signal) => repository.header(version, signal),
    findPublication: (id) => repository.findPublication(id),
    history: (options) => repository.history(options),
    changedFiles: (version) => repository.changedFiles(version),
    lastChangeByPath: (head) => repository.lastChangeByPath(head),
    graphDiff: (from, to, options) => repository.graphDiff(from, to, options),
    async propose(input) {
      const proposal = await repository.propose(input);
      if (proposal.proposalVersion) await notify(proposal.proposalVersion);
      return proposal;
    },
    proposal: (id) => repository.proposal(id),
    listProposals: () => repository.listProposals(),
    readProposalJournal: () => repository.readProposalJournal(),
    async accept(input) {
      const revision = await repository.accept(input);
      await notify(revision.version);
      return revision;
    },
    async reject(input) {
      const proposal = await repository.reject(input);
      // Rejection changes the proposal journal, not the admitted head.
      try {
        await notify((await repository.current()).version);
      } catch { /* Advisory observers cannot undo a completed decision. */ }
      return proposal;
    },
    async publishSystemSources(sources, expectedVersion, author) {
      const revision = await repository.publishSystemSources(
        sources,
        expectedVersion,
        author,
      );
      await notify(revision.version);
      return revision;
    },
    async updateSystemSources(update, author, options) {
      const revision = await repository.updateSystemSources(
        update,
        author,
        options,
      );
      await notify(revision.version);
      return revision;
    },
  };
}
