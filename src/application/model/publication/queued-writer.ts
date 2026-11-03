import { assertRequestChangeDossier } from "./request-change.ts";
import type { SourcePublication } from "../../../domain/model/publication/change.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { ModelCompiler } from "../builds/ports/out/model-compiler.port.ts";
import { ModelPublicationError } from "./service.ts";
import type { ModelWriteSubmissionPort } from "./submission.ts";
import type { ModelWriteQueuePort } from "./ports/out/model-write-queue.port.ts";
import { ModelWriteQueueError, type ModelWriteWorker } from "./write-queue.ts";
import { recipeDigest } from "../../../domain/model/value-objects/build.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import {
  assertModelWriteDestinationMatches,
  isScopedSoftwareWriteDossier,
  parseVersionedModelWriteDossier,
  type VersionedModelWriteDossier,
} from "./write-command-v2.ts";
import type { RequestModelWriteDestination } from "../../../domain/model/editing/request-write-destination.ts";
import type { RequestSourceWriteResolver } from "./ports/out/request-source-publication.port.ts";
import type { ScopedSoftwareSourceWriteResolver } from "./ports/out/scoped-software-source-publication.port.ts";

/** One bounded local pump. The repository queue owns cross-process claims. */
export class QueuedModelWriter implements ModelWriteSubmissionPort {
  #running?: Promise<void>;
  #timer?: ReturnType<typeof setInterval>;
  #closed = false;
  // Share the existing one-second pump cadence across concurrent callers, so
  // a retryable FIFO head cannot be reclaimed in a tight resume loop.
  #retryNotBefore = 0;
  constructor(
    readonly repositoryId: string,
    readonly queue: ModelWriteQueuePort,
    readonly worker: ModelWriteWorker,
    readonly compiler: ModelCompiler,
    readonly repository: { at(version: string): Promise<ModelRevision> },
    readonly requestSources?: RequestSourceWriteResolver,
    readonly scopedSoftwareSources?: ScopedSoftwareSourceWriteResolver,
  ) {}

  recipeDigest(): Promise<string> {
    return this.compiler.recipe().then(recipeDigest);
  }
  start(): void {
    if (this.#timer !== undefined || this.#closed) return;
    this.#timer = setInterval(() => {
      this.pump().catch(
        () => {/* durable state is retried by the next tick */},
      );
    }, 1000);
    this.pump().catch(() => {/* startup recovery remains durable */});
  }
  async pump(): Promise<void> {
    if (this.#closed) return;
    if (this.#running) return await this.#running;
    if (Date.now() < this.#retryNotBefore) return;
    const running = (async () => {
      for (let i = 0; i < 64 && !this.#closed; i++) {
        const result = await this.worker.runOnce(this.repositoryId);
        if (result.status === "retryable") {
          this.#retryNotBefore = Date.now() + 1000;
          break;
        }
        if (result.status === "idle" || result.status === "fence-lost") break;
      }
    })();
    this.#running = running;
    try {
      await running;
    } finally {
      if (this.#running === running) this.#running = undefined;
    }
  }
  async publish(input: VersionedModelWriteDossier): Promise<ModelRevision> {
    const dossier = await parseVersionedModelWriteDossier(input);
    if (dossier.command.repositoryId !== this.repositoryId) {
      throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
        repositoryId: this.repositoryId,
        commandId: dossier.command.commandId,
        reason: "Publication belongs to another repository",
      }, "Publication belongs to another repository");
    }
    if (this.#closed) throw new Error("Model writer is closed");
    if (dossier.command.kind === "retain-artifact-source") {
      throw new ModelWriteQueueError("WRITE_QUEUE_INVALID", {
        repositoryId: this.repositoryId,
        commandId: dossier.command.commandId,
        reason: "Source retention requires its exact source receipt surface",
      }, "Source retention requires its exact source receipt surface");
    }
    await this.queue.enqueue(dossier);
    return (await this.resume(
      dossier.command.commandId,
      undefined,
      dossier.v === 2 ? dossier.command.destination : undefined,
    ))!;
  }
  async resume(
    commandId: string,
    expectedApproval?: SourcePublication,
    expectedDestination?: RequestModelWriteDestination,
  ): Promise<ModelRevision | null> {
    const destination = expectedDestination
      ? structuredClone(expectedDestination)
      : undefined;
    const initial = await this.queue.get(this.repositoryId, commandId);
    if (!initial) return null;
    let scoped:
      | Awaited<ReturnType<RequestSourceWriteResolver["resolve"]>>
      | Awaited<ReturnType<ScopedSoftwareSourceWriteResolver["resolve"]>>
      | undefined;
    if (initial.command.v === 2) {
      const stored = await this.queue.getDossier?.(
        this.repositoryId,
        commandId,
      );
      const dossier = stored
        ? await parseVersionedModelWriteDossier(stored)
        : undefined;
      if (
        !dossier || dossier.v !== 2 || !destination ||
        canonical(initial.command) !== canonical(dossier.command)
      ) {
        throw new ModelWriteQueueError(
          "WRITE_QUEUE_CONFLICT",
          {
            repositoryId: this.repositoryId,
            commandId,
            reason:
              "Request resume needs its exact stored dossier and expected destination",
          },
          "Request resume needs its exact stored dossier and expected destination",
        );
      }
      if (isScopedSoftwareWriteDossier(dossier)) {
        if (!this.scopedSoftwareSources) {
          throw new ModelWriteQueueError("WRITE_QUEUE_INVALID", {
            repositoryId: this.repositoryId,
            commandId,
            reason:
              "Scoped software resume requires its exact software resolver",
          }, "Scoped software resume requires its exact software resolver");
        }
        assertModelWriteDestinationMatches(dossier.command, destination);
        scoped = await this.scopedSoftwareSources.resolve(dossier);
      } else {
        if (!this.requestSources) {
          throw new ModelWriteQueueError("WRITE_QUEUE_INVALID", {
            repositoryId: this.repositoryId,
            commandId,
            reason: "Request resume requires its exact human source resolver",
          }, "Request resume requires its exact human source resolver");
        }
        if (dossier.command.kind === "approved-change") {
          assertRequestChangeDossier(dossier);
        } else if (
          dossier.command.kind !== "accept-proposal" ||
          dossier.decision.kind !== "accept-proposal" ||
          dossier.decision.author !== "local-owner" ||
          dossier.operations.kind !== "whole-files"
        ) {
          throw new ModelWriteQueueError("WRITE_QUEUE_INVALID", {
            repositoryId: this.repositoryId,
            commandId,
            reason: "Unsupported Request source write route",
          }, "Unsupported Request source write route");
        }
        assertModelWriteDestinationMatches(dossier.command, destination);
        // Must bind before even a published-version fast return; this resolver
        // is historical/structural, not a fresh credential/open-target gate.
        scoped = await this.requestSources.resolve(dossier);
      }
      assertModelWriteDestinationMatches(dossier.command, scoped.destination);
    } else if (destination) {
      assertModelWriteDestinationMatches(initial.command, destination);
    }
    if (initial.command.kind === "retain-artifact-source") {
      throw new ModelWriteQueueError("WRITE_QUEUE_INVALID", {
        repositoryId: this.repositoryId,
        commandId,
        reason: "Source retention is not an admitted model publication",
      }, "Source retention is not an admitted model publication");
    }
    if (expectedApproval) {
      const dossier = await this.queue.getDossier?.(
        this.repositoryId,
        commandId,
      );
      if (
        !dossier || isScopedSoftwareWriteDossier(dossier) ||
        !("kind" in dossier.decision) ||
        dossier.decision.kind === "accept-proposal" ||
        dossier.decision.kind === "retain-artifact-source" ||
        canonical(dossier.decision.approval) !== canonical(expectedApproval)
      ) {
        throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
          repositoryId: this.repositoryId,
          commandId,
          reason: "Original approval differs from the queued decision",
        }, "Original approval differs from the queued decision");
      }
    }
    const deadline = Date.now() + 300_000;
    while (!this.#closed) {
      await this.pump();
      const entry = await this.queue.get(this.repositoryId, commandId);
      if (!entry) throw new Error("Durable write command disappeared");
      if (entry.state === "published" && entry.publishedVersion) {
        if (scoped) {
          const recovered = await scoped.recover();
          if (recovered?.version !== entry.publishedVersion) {
            throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
              repositoryId: this.repositoryId,
              commandId,
              reason:
                "Published Request command lacks its exact settled admission",
            }, "Published Request command lacks its exact settled admission");
          }
          return recovered;
        }
        return await this.repository.at(entry.publishedVersion);
      }
      if (entry.state === "needs-decision" || entry.state === "refused") {
        throw new ModelPublicationError(
          entry.state === "needs-decision" ? "NEEDS_DECISION" : "REFUSED",
          { changeId: commandId, reason: entry.lastError?.code ?? entry.state },
          entry.lastError?.message ?? entry.state,
        );
      }
      if (Date.now() >= deadline) {
        throw new ModelWriteQueueError("WRITE_QUEUE_UNAVAILABLE", {
          repositoryId: this.repositoryId,
          commandId,
          reason: "publication still pending",
        }, "Publication remains queued; retry resumes the original command");
      }
      const delay = Math.max(
        1,
        Math.min(
          deadline - Date.now(),
          this.#retryNotBefore > Date.now()
            ? this.#retryNotBefore - Date.now()
            : 25,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new Error("Model writer closed while awaiting publication");
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#running;
  }
}
