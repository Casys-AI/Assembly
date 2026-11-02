/**
 * APE 3.3 Process Version Governance: model revision operations participate in explicit
 * version adoption; repository revisions alone do not migrate open cases.
 */
import { compareCodeUnits } from "../../../domain/primitives/canonical-json.ts";

import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import { ModelRepositoryError } from "../repository.ts";
import type { RevisionReader } from "./ports/out/revision-reader.port.ts";

/** Revision queries stay with source history; proposal links are mutable journal facts. */
export class ModelRevisionsService {
  constructor(private readonly repository: RevisionReader) {}

  async history(options: { limit?: number } = {}) {
    const history = await this.repository.history(options);
    const proposals = await this.repository.readProposalJournal();
    const links = new Map<string, string>();
    for (
      const proposal of [...proposals].sort((a, b) =>
        compareCodeUnits(a.id, b.id)
      )
    ) {
      for (
        const version of [proposal.proposalVersion, proposal.acceptedVersion]
      ) {
        if (version) links.set(version, proposal.id);
      }
    }
    return {
      ...history,
      commits: history.commits.map((commit) => ({
        ...commit,
        ...(links.has(commit.version)
          ? { proposalId: links.get(commit.version)! }
          : {}),
      })),
    };
  }

  async files(version?: string) {
    if (version !== undefined) {
      try {
        parseModelRevisionId(version);
      } catch {
        throw new ModelRepositoryError(
          "INVALID_REQUEST",
          "Invalid immutable model version",
        );
      }
    }
    const head = version ??
      (await this.repository.history({ limit: 1 })).headVersion;
    return {
      version: head,
      files: await this.repository.lastChangeByPath(head),
    };
  }
}
