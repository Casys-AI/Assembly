/** Bounded registration and receipts for the admitted immutable-read refinement.
 * The caller supplies the SAME claim/checkpoint fence used by scalar effects.
 * No operation holds a database transaction while a technical reader runs. */
import type {
  ImmutableConsultationGroupManifest,
  ImmutableConsultationGroupMember,
  ImmutableConsultationGroupPublication,
  ImmutableConsultationGroupSession,
  ImmutableConsultationMemberOutcome,
  NativeExecutionRequest,
  RuntimeRevisionReference,
} from "../../../application/work/runtime/execution.ts";
import type { CompiledFlowNode } from "../../../domain/model/execution/flow.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  executionDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import { immutableModelConsultation } from "../../../domain/model/consultation/context.ts";
import type { ExecutionSql } from "../../out/postgres/execution-transaction.ts";
import { invocationKey } from "../../../application/work/operators/journal.ts";

const immutableGroupScopeWhere =
  '"projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4';

export async function assertNoOpenImmutableConsultationGroups(
  query: ExecutionSql,
  table: string,
  values: unknown[],
): Promise<void> {
  const result = await query(
    `SELECT "groupId" FROM ${table} WHERE ${immutableGroupScopeWhere} AND "threadId"=$5 AND "publicationJson" IS NULL LIMIT 1`,
    values,
  );
  if (result.rows.length) {
    throw new Error(
      "Unpublished immutable consultation groups block native progress",
    );
  }
}

const nonblank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const digest = (value: unknown): value is string => isSha256Hex(value);
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** Shared by production persistence and its explicit memory double. */
export async function assertImmutableConsultationManifest(
  manifest: ImmutableConsultationGroupManifest,
  request: NativeExecutionRequest,
  runId: string,
): Promise<void> {
  const { manifestDigest, ...body } = manifest;
  const command = request.flow.nodes.find((node) =>
    node.id === manifest.occurrenceId
  );
  if (
    request.flow.executionProfile !== "operator-command-immutable-group-v1" ||
    !nonblank(manifest.groupId) || manifest.groupId.length > 512 ||
    !digest(manifestDigest) || await executionDigest(body) !== manifestDigest ||
    manifest.runId !== runId || !nonblank(manifest.batchId) ||
    !nonblank(manifest.contribution.inputMessageId) ||
    !natural(manifest.firstOrdinal) ||
    command?.mechanism !== "execute_operator_command" ||
    canonical(manifest.identity) !== canonical(request.identity) ||
    canonical(manifest.contribution) !== canonical(request.contribution) ||
    manifest.executionPin.modelDigest !== request.model.version.digest ||
    manifest.executionPin.repositoryVersion !==
      request.model.version.repositoryVersion ||
    !nonblank(manifest.sourcePin.version) ||
    !digest(manifest.sourcePin.digest) ||
    !Array.isArray(manifest.members) || !manifest.members.length ||
    manifest.members.length > 4 ||
    !natural(manifest.limits.responseCharacters) ||
    !natural(manifest.limits.flowSteps) ||
    manifest.limits.flowSteps > request.maxSteps ||
    manifest.limits.flowSteps < manifest.members.length
  ) throw new Error("IMMUTABLE_CONSULTATION_MANIFEST_INVALID");
  const ids = new Set<string>(),
    keys = new Set<string>(),
    argumentsSeen = new Set<string>();
  let characters = 0;
  for (const [index, member] of manifest.members.entries()) {
    if (!member) throw new Error("IMMUTABLE_CONSULTATION_MEMBER_INVALID");
    if (
      member.ordinal !== manifest.firstOrdinal + index ||
      !nonblank(member.callId) || member.callId.length > 256 ||
      ids.has(member.callId) ||
      !nonblank(member.effectKey) || keys.has(member.effectKey) ||
      !digest(member.argumentsDigest) ||
      argumentsSeen.has(member.argumentsDigest) ||
      !immutableModelConsultation(member.request) ||
      member.request.version !== manifest.sourcePin.version ||
      await executionDigest(member.request) !== member.argumentsDigest ||
      member.choice.kind !== "consult_model" ||
      typeof member.choice.text !== "string" ||
      typeof member.choice.inputJson !== "string" ||
      member.choice.inputJson.length > 65_536 ||
      canonical(JSON.parse(member.choice.inputJson)) !==
        canonical(member.request) ||
      !natural(member.responseCharacters) || !natural(member.flowStepOrdinal) ||
      member.flowStepOrdinal < 1 ||
      index > 0 &&
        member.flowStepOrdinal !==
          manifest.members[index - 1]!.flowStepOrdinal + 1
    ) throw new Error("IMMUTABLE_CONSULTATION_MEMBER_INVALID");
    ids.add(member.callId);
    keys.add(member.effectKey);
    argumentsSeen.add(member.argumentsDigest);
    characters += member.responseCharacters;
  }
  if (
    !Number.isSafeInteger(characters) ||
    characters > manifest.limits.responseCharacters
  ) {
    throw new Error("IMMUTABLE_CONSULTATION_RESERVATION_EXCEEDED");
  }
}

/** Registration must come from an exact, already-recorded provider response. */
export function assertImmutableConsultationBusinessSource(
  manifest: ImmutableConsultationGroupManifest,
  state: SystemRuntimeState,
): void {
  const batch = state.conversationBatches?.find((entry) =>
    entry.id === manifest.batchId
  );
  const scope = manifest.identity.scope;
  if (
    !batch || batch.modelDigest !== manifest.executionPin.modelDigest ||
    !state.caseInvocation ||
    invocationKey(state.caseInvocation) !== manifest.identity.invocationKey ||
    state.activeInputMessageId !== manifest.contribution.inputMessageId ||
    state.executionModel?.identity.builderId !== manifest.identity.operatorId ||
    batch.invocationKey !== manifest.identity.invocationKey ||
    batch.inputMessageId !== manifest.contribution.inputMessageId ||
    (scope.kind === "request"
      ? batch.caseId !== scope.scopeId || !!batch.designerScopeId
      : batch.designerScopeId !== scope.scopeId || !!batch.caseId) ||
    batch.sourceDecision.modelContext?.version !== manifest.sourcePin.version ||
    batch.sourceDecision.modelContext.sourceDigest !==
      manifest.sourcePin.digest ||
    state.executionModel?.version.digest !==
      manifest.executionPin.modelDigest ||
    state.executionModel.version.repositoryVersion !==
      manifest.executionPin.repositoryVersion
  ) throw new Error("IMMUTABLE_CONSULTATION_SOURCE_MISMATCH");
  for (const member of manifest.members) {
    const call = member && batch.calls[member.ordinal];
    if (
      !member || !call || call.id !== member.callId ||
      canonical(call.decision) !== canonical(member.choice) ||
      call.status !== "queued" && call.status !== "started" || call.result
    ) {
      throw new Error("IMMUTABLE_CONSULTATION_SOURCE_MEMBER_MISMATCH");
    }
  }
}

export function assertImmutableConsultationOutcome(
  manifest: ImmutableConsultationGroupManifest,
  member: ImmutableConsultationGroupMember,
  outcome: ImmutableConsultationMemberOutcome,
): void {
  const scope = manifest.identity.scope;
  const validMessageScope = (
    message: ImmutableConsultationMemberOutcome["messages"][number],
  ) =>
    scope.kind === "request"
      ? message.caseId === scope.scopeId && !message.designerScopeId
      : message.designerScopeId === scope.scopeId && !message.caseId;
  const validPin = (
    reference:
      ImmutableConsultationMemberOutcome["messages"][number]["execution"],
  ) =>
    !reference || reference.digest === manifest.executionPin.modelDigest &&
      reference.repositoryVersion === manifest.executionPin.repositoryVersion;
  if (
    !outcome || outcome.groupId !== manifest.groupId ||
    outcome.callId !== member.callId ||
    outcome.effectKey !== member.effectKey ||
    outcome.argumentsDigest !== member.argumentsDigest ||
    !["succeeded", "failed", "refused", "cancelled"].includes(
      outcome.result?.status,
    ) ||
    !nonblank(outcome.result.code) ||
    typeof outcome.result.details !== "string" ||
    !Array.isArray(outcome.messages) || !Array.isArray(outcome.events) ||
    outcome.messages.some((message) =>
      !nonblank(message.id) || !validMessageScope(message) ||
      !validPin(message.execution) ||
      !["assistant", "tool"].includes(message.role) ||
      typeof message.text !== "string" || typeof message.at !== "string"
    ) ||
    outcome.events.some((event) =>
      !nonblank(event.id) || !validPin(event.execution) ||
      (scope.kind === "request"
        ? event.caseId !== scope.scopeId
        : !!event.caseId)
    ) ||
    new Set(outcome.messages.map((message) => message.id)).size !==
      outcome.messages.length ||
    new Set(outcome.events.map((event) => event.id)).size !==
      outcome.events.length
  ) throw new Error("IMMUTABLE_CONSULTATION_RECEIPT_MISMATCH");
}

interface ImmutableConsultationLedgerContext {
  request: NativeExecutionRequest;
  runId: string;
  threadId: string;
  epoch: bigint;
  jobId: string;
  retryCount: number;
  /** project, system, execution space, operator, thread. */
  values: unknown[];
  groupTable: string;
  effectTable: string;
  transact<T>(operation: (query: ExecutionSql) => Promise<T>): Promise<T>;
  operate<T>(operation: () => Promise<T>): Promise<T>;
  businessRevision(
    query: ExecutionSql,
    reference: RuntimeRevisionReference,
  ): Promise<SystemRuntimeState>;
  currentBusiness(query: ExecutionSql): Promise<SystemRuntimeState>;
  /** Serialize new Request groups with canonical closure of their true owner. */
  assertCaseOpen(
    query: ExecutionSql,
    source: SystemRuntimeState,
    caseId: string,
  ): Promise<void>;
}

/** Every transaction supplied by the parent is claim/epoch/checkpoint fenced. */
export function createPostgresImmutableConsultationSession(
  context: ImmutableConsultationLedgerContext,
): ImmutableConsultationGroupSession {
  const c = context;
  const groups =
    `FROM ${c.groupTable} WHERE ${immutableGroupScopeWhere} AND "threadId"=$5`;
  const effects =
    `FROM ${c.effectTable} WHERE ${immutableGroupScopeWhere} AND "threadId"=$5`;
  const readGroup = async (query: ExecutionSql, groupId: string) => {
    const row = (await query(`SELECT * ${groups} AND "groupId"=$6 FOR UPDATE`, [
      ...c.values,
      groupId,
    ])).rows[0];
    if (
      !row || row.runId !== c.runId ||
      row.contributionId !== c.request.contribution.id ||
      typeof row.manifestJson !== "string"
    ) throw new Error("IMMUTABLE_CONSULTATION_GROUP_UNREGISTERED");
    const manifest = JSON.parse(
      row.manifestJson,
    ) as ImmutableConsultationGroupManifest;
    await assertImmutableConsultationManifest(manifest, c.request, c.runId);
    return { row, manifest };
  };
  const requestDigest = (
    manifest: ImmutableConsultationGroupManifest,
    member: ImmutableConsultationGroupMember,
  ) =>
    executionDigest({
      version: 1,
      groupId: manifest.groupId,
      manifestDigest: manifest.manifestDigest,
      member,
      nodeId: manifest.occurrenceId,
      contribution: manifest.contribution,
      executionPin: manifest.executionPin,
    });
  const checkSiblings = async (
    query: ExecutionSql,
    manifest: ImmutableConsultationGroupManifest,
  ) => {
    const open = (await query(
      `SELECT "groupId" ${groups} AND "publicationJson" IS NULL FOR UPDATE`,
      c.values,
    )).rows;
    if (open.length !== 1 || open[0].groupId !== manifest.groupId) {
      throw new Error("IMMUTABLE_CONSULTATION_GROUP_NOT_OPEN");
    }
    const unsettled = (await query(
      `SELECT * ${effects} AND "status"<>'completed' FOR UPDATE`,
      c.values,
    )).rows;
    for (const row of unsettled) {
      const sibling = manifest.members.find((member) =>
        member?.effectKey === row.effectKey
      );
      if (
        !sibling || row.status !== "started" || row.runId !== c.runId ||
        row.contributionId !== c.request.contribution.id ||
        BigInt(row.epoch as bigint) !== c.epoch || row.jobId !== c.jobId ||
        row.retryCount !== c.retryCount ||
        row.nodeId !==
          c.request.flow.nodes.find((node) =>
            node.id === manifest.occurrenceId
          )!.nativeId ||
        row.requestDigest !== await requestDigest(manifest, sibling)
      ) {
        throw new Error(
          "Unsettled native effects block immutable consultation dispatch",
        );
      }
    }
    if (unsettled.length >= manifest.members.length) {
      throw new Error("IMMUTABLE_CONSULTATION_CONCURRENCY_EXCEEDED");
    }
  };
  const insert = async (
    query: ExecutionSql,
    manifest: ImmutableConsultationGroupManifest,
    member: ImmutableConsultationGroupMember,
    node: CompiledFlowNode,
    result?: ImmutableConsultationMemberOutcome,
  ) => {
    await query(
      `INSERT INTO ${c.effectTable} ("projectId","systemId","executionSpaceId","operatorId","threadId","effectKey","runId","contributionId","nodeId","requestDigest","status","epoch","jobId","retryCount","startedAt","resultJson","completedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp(),$15,CASE WHEN $15::text IS NULL THEN NULL ELSE clock_timestamp() END)`,
      [
        ...c.values,
        member.effectKey,
        c.runId,
        c.request.contribution.id,
        node.nativeId,
        await requestDigest(manifest, member),
        result ? "completed" : "started",
        c.epoch,
        c.jobId,
        c.retryCount,
        result ? canonical(result) : null,
      ],
    );
  };
  return {
    async withPublicationFence(groupId, operation) {
      await c.transact(async (query) => {
        const { manifest } = await readGroup(query, groupId);
        const messageIds = new Set<string>(), eventIds = new Set<string>();
        for (const member of manifest.members) {
          const receipt = (await query(
            `SELECT "status","requestDigest","resultJson" ${effects} AND "effectKey"=$6`,
            [...c.values, member.effectKey],
          )).rows[0];
          if (
            !receipt || receipt.status !== "completed" ||
            typeof receipt.resultJson !== "string" ||
            receipt.requestDigest !== await requestDigest(manifest, member)
          ) {
            throw new Error("IMMUTABLE_CONSULTATION_JOIN_INCOMPLETE");
          }
          const outcome = JSON.parse(
            receipt.resultJson,
          ) as ImmutableConsultationMemberOutcome;
          assertImmutableConsultationOutcome(manifest, member, outcome);
          for (const message of outcome.messages) {
            if (messageIds.has(message.id)) {
              throw new Error("IMMUTABLE_CONSULTATION_MESSAGE_COLLISION");
            }
            messageIds.add(message.id);
          }
          for (const event of outcome.events) {
            if (eventIds.has(event.id)) {
              throw new Error("IMMUTABLE_CONSULTATION_EVENT_COLLISION");
            }
            eventIds.add(event.id);
          }
        }
      });
      const result = await c.operate(operation);
      await c.transact(async (query) => {
        await readGroup(query, groupId);
      });
      return result;
    },
    async register(input) {
      const manifest = structuredClone(input);
      await assertImmutableConsultationManifest(manifest, c.request, c.runId);
      return await c.transact(async (query) => {
        const prior =
          (await query(`SELECT * ${groups} AND "groupId"=$6 FOR UPDATE`, [
            ...c.values,
            manifest.groupId,
          ])).rows[0];
        if (prior) {
          if (
            prior.runId !== c.runId ||
            prior.contributionId !== c.request.contribution.id ||
            prior.manifestJson !== canonical(manifest) ||
            prior.manifestDigest !== manifest.manifestDigest
          ) {
            throw new Error("IMMUTABLE_CONSULTATION_REGISTRATION_CONFLICT");
          }
          return JSON.parse(
            String(prior.manifestJson),
          ) as ImmutableConsultationGroupManifest;
        }
        await assertNoOpenImmutableConsultationGroups(
          query,
          c.groupTable,
          c.values,
        );
        const unsettled = await query(
          `SELECT "effectKey" ${effects} AND "status"<>'completed' LIMIT 1`,
          c.values,
        );
        if (unsettled.rows.length) {
          throw new Error(
            "Unsettled native effects block immutable consultation registration",
          );
        }
        const source = await c.businessRevision(
          query,
          manifest.businessRevision,
        );
        assertImmutableConsultationBusinessSource(manifest, source);
        if (manifest.identity.scope.kind === "request") {
          await c.assertCaseOpen(
            query,
            source,
            manifest.identity.scope.scopeId,
          );
        }
        const current = await c.currentBusiness(query);
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
        ) {
          throw new Error("IMMUTABLE_CONSULTATION_PREFIX_MISMATCH");
        }
        // No member key may appropriate an earlier scalar or another group's receipt.
        const collisions = await query(
          `SELECT "effectKey" ${effects} AND "effectKey"=ANY($6::text[])`,
          [
            ...c.values,
            manifest.members.map((member) => member!.effectKey),
          ],
        );
        if (collisions.rows.length) {
          throw new Error("IMMUTABLE_CONSULTATION_EFFECT_KEY_COLLISION");
        }
        await query(
          `INSERT INTO ${c.groupTable} ("projectId","systemId","executionSpaceId","operatorId","threadId","groupId","runId","contributionId","manifestDigest","manifestJson","registeredAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())`,
          [
            ...c.values,
            manifest.groupId,
            c.runId,
            c.request.contribution.id,
            manifest.manifestDigest,
            canonical(manifest),
          ],
        );
        return manifest;
      });
    },
    async memberEffect(groupId, submitted, node, operation, admit) {
      const member = structuredClone(submitted);
      const prepare = async (query: ExecutionSql) => {
        const { row, manifest } = await readGroup(query, groupId);
        const registered = manifest.members.find((item) =>
          item?.callId === member.callId
        );
        const sourceNode = c.request.flow.nodes.find((item) =>
          item.id === manifest.occurrenceId
        )!;
        if (
          !registered || canonical(registered) !== canonical(member) ||
          node.id !== sourceNode.id || canonical(node) !== canonical(sourceNode)
        ) {
          throw new Error("IMMUTABLE_CONSULTATION_MEMBER_MISMATCH");
        }
        const prior =
          (await query(`SELECT * ${effects} AND "effectKey"=$6 FOR UPDATE`, [
            ...c.values,
            member.effectKey,
          ])).rows[0];
        if (prior) {
          if (
            prior.requestDigest !== await requestDigest(manifest, member) ||
            prior.runId !== c.runId ||
            prior.contributionId !== c.request.contribution.id ||
            prior.nodeId !== node.nativeId
          ) {
            throw new Error("IMMUTABLE_CONSULTATION_RECEIPT_MISMATCH");
          }
          if (
            prior.status === "completed" && typeof prior.resultJson === "string"
          ) {
            const result = JSON.parse(
              prior.resultJson,
            ) as ImmutableConsultationMemberOutcome;
            assertImmutableConsultationOutcome(manifest, member, result);
            return { manifest, result };
          }
          if (
            prior.status === "started" &&
            BigInt(prior.epoch as bigint) === c.epoch &&
            prior.jobId === c.jobId && prior.retryCount === c.retryCount
          ) {
            throw new Error(
              "Immutable consultation member was already started under this invocation",
            );
          }
          if (prior.status === "started") {
            await query(
              `UPDATE ${c.effectTable} SET "status"='unknown' WHERE ${immutableGroupScopeWhere} AND "threadId"=$5 AND "effectKey"=$6 AND "status"='started'`,
              [...c.values, member.effectKey],
            );
          }
          return { manifest, unknown: true as const };
        }
        if (row.publicationJson !== null) {
          throw new Error("IMMUTABLE_CONSULTATION_GROUP_PUBLISHED");
        }
        await checkSiblings(query, manifest);
        return { manifest };
      };
      const prior = await c.transact(prepare);
      if (prior.unknown) {
        throw new Error(`EXECUTION_EFFECT_UNKNOWN:${member.effectKey}`);
      }
      if (prior.result) return prior.result;
      if (!admit) {
        throw new Error(
          "A fresh immutable consultation requires an explicit admission callback",
        );
      }
      let refusal: ImmutableConsultationMemberOutcome | undefined;
      try {
        await c.operate(admit);
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
      const claimed = await c.transact(async (query) => {
        const current = await prepare(query);
        if (current.result || current.unknown) return current;
        // This same-group check also applies when admission refused this member.
        await insert(query, current.manifest, member, node, refusal);
        return { ...current, result: refusal };
      });
      if (claimed.unknown) {
        throw new Error(`EXECUTION_EFFECT_UNKNOWN:${member.effectKey}`);
      }
      if (claimed.result) return claimed.result;
      try {
        const outcome = await c.operate(operation);
        assertImmutableConsultationOutcome(claimed.manifest, member, outcome);
        await c.transact(async (query) => {
          const { manifest } = await readGroup(query, groupId);
          assertImmutableConsultationOutcome(manifest, member, outcome);
          const completed = await query(
            `UPDATE ${c.effectTable} SET "status"='completed',"resultJson"=$7,"completedAt"=clock_timestamp() WHERE ${immutableGroupScopeWhere} AND "threadId"=$5 AND "effectKey"=$6 AND "status"='started' AND "epoch"=$8 AND "jobId"=$9 AND "retryCount"=$10 RETURNING "effectKey"`,
            [
              ...c.values,
              member.effectKey,
              canonical(outcome),
              c.epoch,
              c.jobId,
              c.retryCount,
            ],
          );
          if (completed.rows.length !== 1) {
            throw new Error("Immutable consultation effect receipt changed");
          }
        });
        return outcome;
      } catch (error) {
        await c.transact(async (query) => {
          await query(
            `UPDATE ${c.effectTable} SET "status"='unknown' WHERE ${immutableGroupScopeWhere} AND "threadId"=$5 AND "effectKey"=$6 AND "status"='started' AND "epoch"=$7 AND "jobId"=$8 AND "retryCount"=$9`,
            [...c.values, member.effectKey, c.epoch, c.jobId, c.retryCount],
          );
        }).catch(() => {});
        throw error;
      }
    },
    async publish(input) {
      const publication = structuredClone(input),
        { publicationDigest, ...body } = publication;
      if (
        !digest(publicationDigest) ||
        await executionDigest(body) !== publicationDigest
      ) {
        throw new Error("IMMUTABLE_CONSULTATION_PUBLICATION_INVALID");
      }
      return await c.transact(async (query) => {
        const { row, manifest } = await readGroup(query, publication.groupId);
        if (publication.manifestDigest !== manifest.manifestDigest) {
          throw new Error("IMMUTABLE_CONSULTATION_PUBLICATION_MISMATCH");
        }
        if (row.publicationJson !== null) {
          if (row.publicationJson !== canonical(publication)) {
            throw new Error("IMMUTABLE_CONSULTATION_PUBLICATION_CONFLICT");
          }
          return JSON.parse(
            String(row.publicationJson),
          ) as ImmutableConsultationGroupPublication;
        }
        if (publication.members.length !== manifest.members.length) {
          throw new Error("IMMUTABLE_CONSULTATION_JOIN_INCOMPLETE");
        }
        const outcomes: ImmutableConsultationMemberOutcome[] = [];
        for (const [index, member] of manifest.members.entries()) {
          const receipt =
            (await query(`SELECT * ${effects} AND "effectKey"=$6`, [
              ...c.values,
              member!.effectKey,
            ])).rows[0];
          if (
            !receipt || receipt.status !== "completed" ||
            typeof receipt.resultJson !== "string" ||
            receipt.requestDigest !== await requestDigest(manifest, member!)
          ) throw new Error("IMMUTABLE_CONSULTATION_JOIN_INCOMPLETE");
          const outcome = JSON.parse(
            receipt.resultJson,
          ) as ImmutableConsultationMemberOutcome;
          assertImmutableConsultationOutcome(manifest, member!, outcome);
          if (
            canonical(publication.members[index]) !==
              canonical({
                callId: member!.callId,
                effectKey: member!.effectKey,
                receiptDigest: await executionDigest(outcome),
              })
          ) {
            throw new Error(
              "IMMUTABLE_CONSULTATION_PUBLICATION_RECEIPT_MISMATCH",
            );
          }
          outcomes.push(outcome);
        }
        const state = await c.businessRevision(
          query,
          publication.businessRevision,
        );
        const batch = state.conversationBatches?.find((item) =>
          item.id === manifest.batchId
        );
        if (
          !batch || batch.immutableGroup?.groupId !== manifest.groupId ||
          batch.immutableGroup.manifestDigest !== manifest.manifestDigest ||
          batch.immutableGroup.publication?.publicationDigest !==
            publicationDigest ||
          batch.immutableGroup.publication.revision !== state.revision
        ) {
          throw new Error(
            "IMMUTABLE_CONSULTATION_CANONICAL_PUBLICATION_MISSING",
          );
        }
        for (const outcome of outcomes) {
          const call = batch.calls.find((item) => item.id === outcome.callId);
          if (
            call?.status !==
              (outcome.result.status === "cancelled"
                ? "cancelled"
                : "completed") ||
            canonical(call.result) !== canonical(outcome.result) ||
            outcome.messages.some((message) =>
              state.messages.filter((item) => item.id === message.id).length !==
                1 ||
              canonical(
                  state.messages.find((item) => item.id === message.id),
                ) !== canonical(message)
            ) ||
            outcome.events.some((event) =>
              state.events.filter((item) => item.id === event.id).length !==
                1 ||
              canonical(state.events.find((item) => item.id === event.id)) !==
                canonical(event)
            )
          ) {
            throw new Error(
              "IMMUTABLE_CONSULTATION_CANONICAL_RECEIPT_MISMATCH",
            );
          }
        }
        await query(
          `UPDATE ${c.groupTable} SET "publicationJson"=$7,"publishedAt"=clock_timestamp() WHERE ${immutableGroupScopeWhere} AND "threadId"=$5 AND "groupId"=$6 AND "publicationJson" IS NULL`,
          [...c.values, manifest.groupId, canonical(publication)],
        );
        return publication;
      });
    },
    async pending() {
      return await c.transact(async (query) => {
        const rows = (await query(
          `SELECT "manifestJson" ${groups} AND "publicationJson" IS NULL ORDER BY "registeredAt","groupId"`,
          c.values,
        )).rows;
        return rows.map((row) =>
          JSON.parse(
            String(row.manifestJson),
          ) as ImmutableConsultationGroupManifest
        );
      });
    },
  };
}
