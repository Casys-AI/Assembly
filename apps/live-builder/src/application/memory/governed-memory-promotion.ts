/**
 * APE 5.2 Governed Memory Promotion: controlled capture, review, recall and withdrawal
 * under modeled permissions and version checks.
 */
import { executionDigest } from "../../domain/primitives/execution-digest.ts";
import type {
  MemoryContent,
  MemoryOperation,
  MemoryOperationEvent,
  MemoryRecord,
} from "../../domain/memory/entities/memory-record.ts";
import {
  MAX_GOVERNED_MEMORY_REASON_CHARS,
  type MemoryAuthority,
  memoryContentDigest,
  memoryIdentity,
  type MemoryReceipt,
  type MemoryView,
  memoryView,
  requireMemory,
  requireMemoryPermission,
  requireMemoryPolicy,
  requireMemoryVersion,
  validateMemoryContent,
} from "../../domain/memory/governed-memory-promotion.ts";
import type {
  MemoryCapture,
  MemoryReview,
  MemoryRevision,
  MemoryWithdrawal,
} from "./commands/inputs.ts";
import type { GovernedMemoryPorts } from "./ports/dependencies.ts";

/** Local governed guidance. This service neither changes a mandate nor writes a
 * skill, instruction, shared peer store or source model. Those have other routes.
 * Mutating an existing note requires both its operation grant and recall, since
 * its receipt includes the note. Initial capture and an unchanged capture replay
 * return only already-submitted data and do not implicitly grant recall.
 * Returned records are trusted internal audit objects. Their complete history
 * is not a scope-filtered disclosure to agents: transport boundaries must use
 * memoryGuidance and strip operation.content from mutation receipts. */
export class GovernedMemoryPromotionService {
  constructor(readonly ports: GovernedMemoryPorts) {}

  async capture(
    authority: MemoryAuthority,
    input: MemoryCapture,
  ): Promise<MemoryReceipt> {
    const auth = structuredClone(authority);
    requireMemoryPermission(auth, "capture");
    validateMemoryContent(input?.content);
    const request = structuredClone(input);
    this.#identity(request.id);
    const requestDigest = await this.#requestDigest(auth, "capture", request);
    const existing = await this.#load(auth, request.id, false);
    if (existing) {
      const replay = this.#replay(existing, auth, requestDigest);
      requireMemory(replay, "conflict", "candidate identity already exists");
      return replay;
    }
    const at = this.ports.now();
    requireMemoryPolicy(request.content, auth.policy, at);
    await this.#verify(auth, request.content);
    const record: MemoryRecord = {
      id: request.id,
      ownerId: auth.policy.ownerId,
      contributorId: auth.callerId,
      revision: 1,
      digest: await memoryContentDigest(auth.policy.ownerId, request.content),
      content: request.content,
      status: "candidate",
      createdAt: at,
      updatedAt: at,
      history: [],
    };
    const operation = this.#event(record, auth, "capture", requestDigest, at);
    record.history.push(operation);
    await this.ports.store.save(structuredClone(record), null);
    return this.#receipt(record, operation, false, auth);
  }

  async recall(
    authority: MemoryAuthority,
    input: { id?: string } = {},
  ): Promise<MemoryView[]> {
    const auth = structuredClone(authority);
    const request = structuredClone(input);
    requireMemoryPermission(auth, "recall");
    if (request.id !== undefined) {
      this.#identity(request.id);
      const record = await this.#load(auth, request.id, true);
      requireMemory(
        this.#withinScopes(record!, auth),
        "forbidden",
        "candidate is outside the current modeled recall scopes",
      );
      return [memoryView(record!, this.ports.now(), auth.policy)];
    }
    const records = await this.ports.store.list(auth.policy.ownerId);
    const result: MemoryView[] = [];
    for (const record of records) {
      await this.#validateRecord(auth, record);
      if (this.#withinScopes(record, auth)) {
        result.push(memoryView(record, this.ports.now(), auth.policy));
      }
    }
    return result;
  }

  async revise(
    authority: MemoryAuthority,
    input: MemoryRevision,
  ): Promise<MemoryReceipt> {
    const auth = structuredClone(authority);
    requireMemoryPermission(auth, "revise");
    validateMemoryContent(input?.content);
    const request = structuredClone(input);
    this.#identity(request.id);
    const record = (await this.#load(auth, request.id, true))!;
    this.#requireRead(auth, record);
    const requestDigest = await this.#requestDigest(auth, "revise", request);
    const replay = this.#replay(record, auth, requestDigest);
    if (replay) return replay;
    requireMemoryVersion(record, request.expected);
    requireMemory(
      record.status === "candidate" ||
        record.status === "revision-requested" || record.status === "rejected",
      "forbidden",
      "admitted or withdrawn guidance requires a new candidate",
    );
    const at = this.ports.now();
    requireMemoryPolicy(request.content, auth.policy, at);
    await this.#verify(auth, request.content);
    record.content = request.content;
    record.digest = await memoryContentDigest(record.ownerId, request.content);
    record.status = "candidate";
    return await this.#commit(record, auth, "revise", requestDigest, at);
  }

  async review(
    authority: MemoryAuthority,
    input: MemoryReview,
  ): Promise<MemoryReceipt> {
    const auth = structuredClone(authority);
    const request = structuredClone(input);
    requireMemory(
      ["admit", "request-revision", "reject"].includes(request.decision),
      "invalid",
      "unknown admission decision",
    );
    requireMemoryPermission(
      auth,
      request.decision === "reject" ? "reject" : "admit",
    );
    this.#identity(request.id);
    this.#reason(request.reason);
    const record = (await this.#load(auth, request.id, true))!;
    this.#requireRead(auth, record);
    const requestDigest = await this.#requestDigest(
      auth,
      request.decision,
      request,
    );
    const replay = this.#replay(record, auth, requestDigest);
    if (replay) return replay;
    requireMemoryVersion(record, request.expected);
    requireMemory(
      record.status === "candidate",
      "forbidden",
      "only a candidate can receive an admission decision",
    );
    const at = this.ports.now();
    if (request.decision === "admit") {
      requireMemory(
        auth.policy.allowSelfAdmission ||
          !record.history.some((event) =>
            (event.operation === "capture" || event.operation === "revise") &&
            event.callerId === auth.callerId
          ),
        "forbidden",
        "modeled policy forbids contributor self-admission",
      );
      requireMemoryPolicy(record.content, auth.policy, at, true);
      await this.#verify(auth, record.content);
      record.status = "admitted";
    } else {
      record.status = request.decision === "reject"
        ? "rejected"
        : "revision-requested";
    }
    return await this.#commit(
      record,
      auth,
      request.decision,
      requestDigest,
      at,
      request.reason,
    );
  }

  async withdraw(
    authority: MemoryAuthority,
    input: MemoryWithdrawal,
  ): Promise<MemoryReceipt> {
    const auth = structuredClone(authority);
    const request = structuredClone(input);
    requireMemoryPermission(auth, "withdraw");
    this.#identity(request.id);
    this.#reason(request.reason);
    const record = (await this.#load(auth, request.id, true))!;
    this.#requireRead(auth, record);
    const requestDigest = await this.#requestDigest(auth, "withdraw", request);
    const replay = this.#replay(record, auth, requestDigest);
    if (replay) return replay;
    requireMemoryVersion(record, request.expected);
    requireMemory(
      record.status !== "withdrawn",
      "forbidden",
      "candidate was already withdrawn",
    );
    record.status = "withdrawn";
    return await this.#commit(
      record,
      auth,
      "withdraw",
      requestDigest,
      this.ports.now(),
      request.reason,
    );
  }

  async #commit(
    record: MemoryRecord,
    authority: MemoryAuthority,
    action: MemoryOperation,
    requestDigest: string,
    at: string,
    reason?: string,
  ): Promise<MemoryReceipt> {
    const prior = record.history.at(-1)!;
    const expected = { revision: prior.revision, digest: prior.digest };
    record.revision++;
    record.updatedAt = at;
    const operation = this.#event(
      record,
      authority,
      action,
      requestDigest,
      at,
      reason,
    );
    record.history.push(operation);
    await this.ports.store.save(structuredClone(record), expected);
    return this.#receipt(record, operation, false, authority);
  }

  #event(
    record: MemoryRecord,
    authority: MemoryAuthority,
    operation: MemoryOperation,
    requestDigest: string,
    at: string,
    reason?: string,
  ): MemoryOperationEvent {
    return {
      operation,
      callerId: authority.callerId,
      behaviorId: authority.behaviorId,
      invocationId: authority.invocationId,
      modelVersion: structuredClone(authority.modelVersion),
      policyId: authority.policy.id,
      requestDigest,
      at,
      ...(reason !== undefined ? { reason } : {}),
      revision: record.revision,
      digest: record.digest,
      status: record.status,
      content: structuredClone(record.content),
    };
  }

  #replay(
    record: MemoryRecord,
    authority: MemoryAuthority,
    requestDigest: string,
  ): MemoryReceipt | null {
    const operation = record.history.find((event) =>
      event.callerId === authority.callerId &&
      event.invocationId === authority.invocationId
    );
    if (!operation) return null;
    requireMemory(
      operation.requestDigest === requestDigest,
      "conflict",
      "native invocation was already committed with a different request",
    );
    // A write grant does not allow reading revisions supplied by others. The
    // unchanged initial receipt contains only the contributor's submitted data.
    if (record.revision !== operation.revision) {
      this.#requireRead(authority, record);
    }
    return this.#receipt(record, operation, true, authority);
  }

  #receipt(
    record: MemoryRecord,
    operation: MemoryOperationEvent,
    replayed: boolean,
    authority: MemoryAuthority,
  ): MemoryReceipt {
    return {
      memory: memoryView(record, this.ports.now(), authority.policy),
      operation: structuredClone(operation),
      replayed,
    };
  }

  async #requestDigest(
    authority: MemoryAuthority,
    operation: MemoryOperation,
    input: unknown,
  ): Promise<string> {
    const digest = await executionDigest({
      operation,
      input,
      callerId: authority.callerId,
      behaviorId: authority.behaviorId,
      invocationId: authority.invocationId,
      modelVersion: authority.modelVersion,
      policyId: authority.policy.id,
    });
    // This check explains conflicts before the write. The adapter must also
    // enforce invocation uniqueness atomically across notes and processes.
    for (
      const record of await this.ports.store.list(authority.policy.ownerId)
    ) {
      await this.#validateRecord(authority, record);
      for (const event of record.history) {
        if (
          event.callerId === authority.callerId &&
          event.invocationId === authority.invocationId
        ) {
          requireMemory(
            event.requestDigest === digest,
            "conflict",
            "native invocation was already committed with a different request",
          );
        }
      }
    }
    return digest;
  }

  #withinScopes(record: MemoryRecord, authority: MemoryAuthority): boolean {
    return record.content.scope.every((scope) =>
      authority.policy.allowedScopes.includes(scope)
    );
  }

  #requireRead(authority: MemoryAuthority, record: MemoryRecord): void {
    requireMemoryPermission(authority, "recall");
    requireMemory(
      this.#withinScopes(record, authority),
      "forbidden",
      "candidate is outside the current modeled recall scopes",
    );
  }

  async #load(
    authority: MemoryAuthority,
    id: string,
    required: boolean,
  ): Promise<MemoryRecord | null> {
    const loaded = await this.ports.store.load(authority.policy.ownerId, id);
    requireMemory(!required || loaded, "not-found", "candidate was not found");
    if (!loaded) return null;
    const record = structuredClone(loaded);
    requireMemory(record.id === id, "invalid", "storage returned another note");
    await this.#validateRecord(authority, record);
    return record;
  }

  async #validateRecord(
    authority: MemoryAuthority,
    record: MemoryRecord,
  ): Promise<void> {
    requireMemory(
      record.ownerId === authority.policy.ownerId,
      "forbidden",
      "storage returned another operator's private memory",
    );
    requireMemory(
      record.digest ===
        await memoryContentDigest(record.ownerId, record.content),
      "conflict",
      "stored candidate bytes do not match their digest",
    );
    const latest = record.history.at(-1);
    requireMemory(
      latest && latest.revision === record.revision &&
        latest.digest === record.digest && latest.status === record.status,
      "conflict",
      "stored candidate version does not match its operation history",
    );
  }

  async #verify(
    authority: MemoryAuthority,
    content: MemoryContent,
  ): Promise<void> {
    requireMemory(
      await this.ports.provenance.verify(
        authority.policy.ownerId,
        structuredClone(content),
      ),
      "provenance",
      "originating decision or evidence cannot be resolved in this scope",
    );
  }

  #identity(id: string): void {
    requireMemory(memoryIdentity(id), "invalid", "invalid candidate identity");
  }

  #reason(reason: string): void {
    requireMemory(
      typeof reason === "string" && reason.trim() &&
        reason.length <= MAX_GOVERNED_MEMORY_REASON_CHARS,
      "invalid",
      `admission decision or withdrawal requires a non-empty reason of at most ${MAX_GOVERNED_MEMORY_REASON_CHARS} characters`,
    );
  }
}
