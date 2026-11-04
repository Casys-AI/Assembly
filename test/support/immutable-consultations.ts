/** Explicit memory double. PostgreSQL claim/epoch/crash qualification is separate. */
import type {
  ImmutableConsultationGroupManifest,
  ImmutableConsultationGroupPublication,
  ImmutableConsultationGroupSession,
  ImmutableConsultationMemberOutcome,
  NativeExecutionRequest,
} from "../../src/application/work/native-execution/contract.ts";
import {
  assertImmutableConsultationBusinessSource,
  assertImmutableConsultationManifest,
  assertImmutableConsultationOutcome,
} from "../../src/application/work/native-execution/immutable-consultation-checks.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";

export function memoryImmutableConsultationState() {
  return {
    groups: new Map<string, ImmutableConsultationGroupManifest>(),
    publications: new Map<string, ImmutableConsultationGroupPublication>(),
    effects: new Map<
      string,
      {
        groupId: string;
        memberDigest: string;
        status: "started" | "completed" | "unknown";
      }
    >(),
    writes: Promise.resolve(),
  };
}
interface Thread {
  request: NativeExecutionRequest;
  runId: string;
  effects: Map<string, unknown>;
  groupLedger: ReturnType<typeof memoryImmutableConsultationState>;
  retired?: boolean;
}
export function pendingMemoryImmutableConsultations(thread: Thread) {
  return [...thread.groupLedger.groups.values()].filter((group) =>
    !thread.groupLedger.publications.has(group.groupId)
  );
}
export function assertNoMemoryImmutableConsultations(thread: Thread) {
  if (pendingMemoryImmutableConsultations(thread).length) {
    throw new Error(
      "Unpublished immutable consultation groups block native progress",
    );
  }
}
export function memoryImmutableConsultationSession(
  thread: Thread,
  revisions: Map<number, SystemRuntimeState>,
): ImmutableConsultationGroupSession {
  const runId = thread.runId, ledger = thread.groupLedger;
  const write = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const next = ledger.writes.then(async () => {
      if (thread.retired || thread.runId !== runId) {
        throw new Error("Stale immutable consultation session");
      }
      return await operation();
    });
    ledger.writes = next.then(() => {}, () => {});
    return next;
  };
  return {
    async withPublicationFence(groupId, operation) {
      await write(() => {
        const manifest = ledger.groups.get(groupId);
        if (!manifest || manifest.runId !== runId) {
          throw new Error("IMMUTABLE_CONSULTATION_GROUP_UNREGISTERED");
        }
        if (
          manifest.members.some((member) =>
            ledger.effects.get(member.effectKey)?.status !== "completed"
          )
        ) throw new Error("IMMUTABLE_CONSULTATION_JOIN_INCOMPLETE");
        const messages = new Set<string>(), events = new Set<string>();
        for (const member of manifest.members) {
          const outcome = thread.effects.get(
            member.effectKey,
          ) as ImmutableConsultationMemberOutcome;
          for (const message of outcome.messages) {
            if (messages.has(message.id)) {
              throw new Error("IMMUTABLE_CONSULTATION_MESSAGE_COLLISION");
            }
            messages.add(message.id);
          }
          for (const event of outcome.events) {
            if (events.has(event.id)) {
              throw new Error("IMMUTABLE_CONSULTATION_EVENT_COLLISION");
            }
            events.add(event.id);
          }
        }
      });
      const result = await operation();
      await write(() => {});
      return result;
    },
    register(input) {
      const manifest = structuredClone(input);
      return write(async () => {
        await assertImmutableConsultationManifest(
          manifest,
          thread.request,
          runId,
        );
        const prior = ledger.groups.get(manifest.groupId);
        if (prior) {
          if (canonical(prior) !== canonical(manifest)) {
            throw new Error("IMMUTABLE_CONSULTATION_REGISTRATION_CONFLICT");
          }
          return structuredClone(prior);
        }
        assertNoMemoryImmutableConsultations(thread);
        if ([...thread.effects.values()].some((value) => value === undefined)) {
          throw new Error(
            "Unsettled native effects block immutable consultation registration",
          );
        }
        const historical = revisions.get(
          manifest.businessRevision.__assemblyRuntimeRevision.revision,
        );
        if (!historical) {
          throw new Error("Canonical business revision is unavailable");
        }
        assertImmutableConsultationBusinessSource(manifest, historical);
        const current = [...revisions.values()].at(-1)!;
        assertImmutableConsultationBusinessSource(manifest, current);
        const batch = current.conversationBatches!.find((item) =>
          item.id === manifest.batchId
        )!;
        if (
          batch.calls.findIndex((call) =>
              call.status !== "completed" && call.status !== "cancelled"
            ) !== manifest.firstOrdinal ||
          batch.immutableGroup && !batch.immutableGroup.publication &&
            (batch.immutableGroup.groupId !== manifest.groupId ||
              batch.immutableGroup.manifestDigest !== manifest.manifestDigest)
        ) throw new Error("IMMUTABLE_CONSULTATION_PREFIX_MISMATCH");
        if (
          manifest.members.some((member) =>
            thread.effects.has(member.effectKey)
          )
        ) throw new Error("IMMUTABLE_CONSULTATION_EFFECT_KEY_COLLISION");
        ledger.groups.set(manifest.groupId, manifest);
        return structuredClone(manifest);
      });
    },
    async memberEffect(groupId, member, node, operation, admit) {
      const prepare = async () => {
        const manifest = ledger.groups.get(groupId);
        if (!manifest || manifest.runId !== runId) {
          throw new Error("IMMUTABLE_CONSULTATION_GROUP_UNREGISTERED");
        }
        const registered = manifest.members.find((item) =>
          item.callId === member.callId
        );
        const sourceNode = thread.request.flow.nodes.find((item) =>
          item.id === manifest.occurrenceId
        );
        if (
          canonical(registered) !== canonical(member) ||
          canonical(sourceNode) !== canonical(node)
        ) throw new Error("IMMUTABLE_CONSULTATION_MEMBER_MISMATCH");
        const prior = ledger.effects.get(member.effectKey);
        if (prior) {
          if (
            prior.groupId !== groupId ||
            prior.memberDigest !== await executionDigest(member)
          ) throw new Error("IMMUTABLE_CONSULTATION_RECEIPT_MISMATCH");
          if (prior.status === "unknown") {
            throw new Error(`EXECUTION_EFFECT_UNKNOWN:${member.effectKey}`);
          }
          if (prior.status === "started") {
            throw new Error(
              "Immutable consultation member was already started under this invocation",
            );
          }
          return {
            manifest,
            result: structuredClone(
              thread.effects.get(member.effectKey),
            ) as ImmutableConsultationMemberOutcome,
          };
        }
        const pending = pendingMemoryImmutableConsultations(thread);
        if (
          ledger.publications.has(groupId) || pending.length !== 1 ||
          pending[0].groupId !== groupId
        ) throw new Error("IMMUTABLE_CONSULTATION_GROUP_NOT_OPEN");
        for (const [key, value] of thread.effects) {
          if (value !== undefined) continue;
          const sibling = ledger.effects.get(key);
          if (
            !sibling || sibling.groupId !== groupId ||
            sibling.status !== "started"
          ) {
            throw new Error(
              "Unsettled native effects block immutable consultation dispatch",
            );
          }
        }
        return { manifest, result: undefined };
      };
      const before = await write(prepare);
      if (before.result) return before.result;
      if (!admit) {
        throw new Error(
          "A fresh immutable consultation requires an explicit admission callback",
        );
      }
      let refusal: ImmutableConsultationMemberOutcome | undefined;
      try {
        await admit();
      } catch (error) {
        refusal = {
          groupId,
          callId: member.callId,
          effectKey: member.effectKey,
          argumentsDigest: member.argumentsDigest,
          result: {
            status: "refused",
            code: "NATIVE_EXECUTION_ADMISSION_REFUSED",
            details: (error instanceof Error ? error.message : String(error))
              .slice(0, 450),
          },
          messages: [],
          events: [],
        };
      }
      const claimed = await write(async () => {
        const current = await prepare();
        if (current.result) return current.result;
        ledger.effects.set(member.effectKey, {
          groupId,
          memberDigest: await executionDigest(member),
          status: refusal ? "completed" : "started",
        });
        thread.effects.set(member.effectKey, structuredClone(refusal));
        return refusal;
      });
      if (claimed) return claimed;
      try {
        const result = await operation();
        assertImmutableConsultationOutcome(before.manifest, member, result);
        await write(() => {
          if (ledger.effects.get(member.effectKey)?.status !== "started") {
            throw new Error("Immutable consultation effect receipt changed");
          }
          thread.effects.set(member.effectKey, structuredClone(result));
          ledger.effects.get(member.effectKey)!.status = "completed";
        });
        return result;
      } catch (error) {
        await write(() => {
          ledger.effects.get(member.effectKey)!.status = "unknown";
        }).catch(() => {});
        throw error;
      }
    },
    publish(input) {
      const publication = structuredClone(input);
      return write(async () => {
        const manifest = ledger.groups.get(publication.groupId);
        if (
          !manifest || manifest.runId !== runId ||
          manifest.manifestDigest !== publication.manifestDigest
        ) throw new Error("IMMUTABLE_CONSULTATION_GROUP_UNREGISTERED");
        const { publicationDigest, ...body } = publication;
        if (await executionDigest(body) !== publicationDigest) {
          throw new Error("IMMUTABLE_CONSULTATION_PUBLICATION_INVALID");
        }
        const prior = ledger.publications.get(publication.groupId);
        if (prior) {
          if (canonical(prior) !== canonical(publication)) {
            throw new Error("IMMUTABLE_CONSULTATION_PUBLICATION_CONFLICT");
          }
          return structuredClone(prior);
        }
        if (publication.members.length !== manifest.members.length) {
          throw new Error("IMMUTABLE_CONSULTATION_JOIN_INCOMPLETE");
        }
        const historical = revisions.get(
          publication.businessRevision.__assemblyRuntimeRevision.revision,
        );
        const batch = historical?.conversationBatches?.find((item) =>
          item.id === manifest.batchId
        );
        if (
          !historical || batch?.immutableGroup?.groupId !== manifest.groupId ||
          batch.immutableGroup.manifestDigest !== manifest.manifestDigest ||
          batch.immutableGroup.publication?.publicationDigest !==
            publicationDigest ||
          batch.immutableGroup.publication.revision !== historical.revision
        ) {
          throw new Error(
            "IMMUTABLE_CONSULTATION_CANONICAL_PUBLICATION_MISSING",
          );
        }
        for (const [index, member] of manifest.members.entries()) {
          if (ledger.effects.get(member.effectKey)?.status !== "completed") {
            throw new Error("IMMUTABLE_CONSULTATION_JOIN_INCOMPLETE");
          }
          const result = thread.effects.get(
            member.effectKey,
          ) as ImmutableConsultationMemberOutcome;
          const call = batch.calls.find((item) => item.id === member.callId);
          if (
            canonical(publication.members[index]) !==
              canonical({
                callId: member.callId,
                effectKey: member.effectKey,
                receiptDigest: await executionDigest(result),
              }) ||
            call?.status !==
              (result.result.status === "cancelled"
                ? "cancelled"
                : "completed") ||
            canonical(call.result) !== canonical(result.result) ||
            result.messages.some((message) =>
              historical.messages.filter((item) => item.id === message.id)
                  .length !== 1 ||
              canonical(
                  historical.messages.find((item) => item.id === message.id),
                ) !== canonical(message)
            ) ||
            result.events.some((event) =>
              historical.events.filter((item) => item.id === event.id)
                  .length !== 1 ||
              canonical(
                  historical.events.find((item) => item.id === event.id),
                ) !== canonical(event)
            )
          ) {
            throw new Error(
              "IMMUTABLE_CONSULTATION_CANONICAL_RECEIPT_MISMATCH",
            );
          }
        }
        ledger.publications.set(publication.groupId, publication);
        return publication;
      });
    },
    pending: () =>
      write(() => structuredClone(pendingMemoryImmutableConsultations(thread))),
  };
}
