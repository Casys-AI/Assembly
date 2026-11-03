import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { modelWriteCommandDigest } from "../../../domain/model/editing/write-command.ts";
import type { QueuedArtifactSourcePublication } from "../../../domain/work/artifacts/source-publication.ts";
import type { ArtifactSourcePublicationReceipt } from "../../work/artifacts/source-repository.ts";
import type { QueuedArtifactSourcePublisher } from "../../work/artifacts/publication.ts";
import type { ArtifactSourceWritePort } from "../publication/ports/out/artifact-source-write.port.ts";
import type { ModelWriteQueuePort } from "../publication/ports/out/model-write-queue.port.ts";
import {
  assertArtifactSourceRetentionReceipt,
  buildArtifactSourceRetentionCommand,
  ModelWriteQueueError,
} from "../publication/write-queue.ts";

interface QueuedArtifactSourcePublisherOptions {
  readonly repositoryId: string;
  readonly queue: ModelWriteQueuePort;
  readonly artifactSourceWrites: ArtifactSourceWritePort;
  /** The existing repository writer's pump, shared with all model commands. */
  readonly pump: () => Promise<void>;
  readonly waitMs?: number;
}

/** Source receipt waiter over the existing W4 queue/pump. It constructs no
 * alternative writer and never reads a source commit as an admitted model. */
export class DurableQueuedArtifactSourcePublisher
  implements QueuedArtifactSourcePublisher {
  readonly #options: QueuedArtifactSourcePublisherOptions;
  constructor(options: QueuedArtifactSourcePublisherOptions) {
    if (
      options.waitMs !== undefined &&
      (!Number.isFinite(options.waitMs) || options.waitMs <= 0)
    ) {
      throw new Error("Source publication wait must be positive and bounded");
    }
    this.#options = options;
  }
  async publish(
    input: QueuedArtifactSourcePublication,
  ): Promise<ArtifactSourcePublicationReceipt> {
    const publication = structuredClone(input);
    const { repositoryId, queue, artifactSourceWrites: port } = this.#options;
    await port.assertCurrent(structuredClone(publication));
    const dossier = await buildArtifactSourceRetentionCommand({
      ...publication,
      repositoryId,
      scopeId: port.scopeId,
    });
    const commandDigest = await modelWriteCommandDigest(dossier.command);
    const command = { commandId: publication.publicationId, commandDigest };
    // An exact retained anchor can survive both an absent/retryable SQL entry
    // and a completed one. Verify it before enqueueing any recovery intent.
    const retained = await port.repository.findByCommand(command);
    if (retained) {
      await assertArtifactSourceRetentionReceipt(
        dossier,
        commandDigest,
        port.scopeId,
        port.repository,
        retained,
      );
    }
    await queue.enqueue(dossier);
    const deadline = Date.now() + (this.#options.waitMs ?? 300_000);
    while (true) {
      const entry = await queue.get(repositoryId, publication.publicationId);
      if (
        !entry || entry.commandDigest !== commandDigest ||
        canonical(entry.command) !== canonical(dossier.command)
      ) {
        throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
          repositoryId,
          commandId: publication.publicationId,
          reason:
            "Queued source command differs from the exact requested intent",
        }, "Queued source command differs from the exact requested intent");
      }
      if (entry.state === "published") {
        const receipt = await port.repository.findByCommand(command);
        if (
          !receipt ||
          entry.publishedVersion !== `commit:${receipt.reference.commitOid}`
        ) {
          throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
            repositoryId,
            commandId: publication.publicationId,
            reason: "Completed source command lacks its exact retained anchor",
          }, "Completed source command lacks its exact retained anchor");
        }
        await assertArtifactSourceRetentionReceipt(
          dossier,
          commandDigest,
          port.scopeId,
          port.repository,
          receipt,
        );
        // Completed SQL entries do not reacquire the worker; authorization is
        // therefore explicitly checked again on this direct receipt path.
        await port.assertCurrent(structuredClone(publication));
        return structuredClone(receipt);
      }
      if (entry.state === "refused" || entry.state === "needs-decision") {
        throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
          repositoryId,
          commandId: publication.publicationId,
          reason: entry.lastError?.code ?? entry.state,
        }, "Source retention requires a new authorized decision");
      }
      if (Date.now() >= deadline) {
        throw new ModelWriteQueueError("WRITE_QUEUE_UNAVAILABLE", {
          repositoryId,
          commandId: publication.publicationId,
          reason: "Bounded wait for the existing repository queue expired",
        }, "Source retention is still pending");
      }
      await this.#options.pump();
      const after = await queue.get(repositoryId, publication.publicationId);
      if (
        after?.state !== "published" && after?.state !== "refused" &&
        after?.state !== "needs-decision"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}
