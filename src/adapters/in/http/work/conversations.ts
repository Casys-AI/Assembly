import { noStoreJson as json } from "../versioning/responses.ts";
import type { RequestCaseConversationsPort } from "../../../../application/work/request-spaces/conversations.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces/scope.ts";
import { spaceHttpError, spaceSessionSecret } from "./space-session.ts";
import {
  ChangePendingError,
  ChangeScopeMissingError,
} from "../../../../domain/governance/policies/governance.ts";
import { publicationFailure } from "../../../../application/model/publication/publication-failure.ts";
import { ChangePublicationError } from "../../../../domain/model/publication/change.ts";
import { ChangeApprovabilityError } from "../../../../domain/governance/policies/change-approvability.ts";
import { AuthorityInvariantError } from "../../../../domain/governance/authority.ts";
import { MAX_USER_MESSAGE_CHARS } from "../../../../domain/work/records/conversations.ts";
import {
  type AgentMessageCommand,
  type ConversationsSnapshot,
  type OperatorToolsSnapshot,
} from "../../../../application/work/operators/conversation-types.ts";
import {
  type OperatorCandidateDecision,
  type OperatorChangeDecision,
  OperatorConversationError,
} from "../../../../application/work/operators/conversations.ts";
import { CaseError } from "../../../../domain/work/errors/case.ts";
import {
  LocalHttpFailure,
  requireLocalJsonCommand,
} from "../../../../infrastructure/http/local-security.ts";
import {
  errorLogProperties,
  technicalLogger,
} from "../../../../infrastructure/logging.ts";

const log = technicalLogger("http");

export interface ConversationsApplication {
  readonly snapshot: ConversationsSnapshot;
  readonly catalogSnapshot: OperatorToolsSnapshot;
  conversations?(): Promise<ConversationsSnapshot>;
  submitHuman(command: AgentMessageCommand): Promise<string | void>;
  decideCandidate(command: OperatorCandidateDecision): Promise<void>;
  decideChange(command: OperatorChangeDecision): Promise<void>;
}

/** 512 KiB: a 100 000-character message in UTF-8 plus its JSON envelope. */
const MAX_BODY_BYTES = 524_288;
class HttpFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
function requireValue(
  value: unknown,
  status: number,
  message: string,
): asserts value {
  if (!value) throw new HttpFailure(status, message);
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  requireValue(
    request.headers.get("content-type")?.split(";", 1)[0]?.trim()
      .toLowerCase() === "application/json",
    415,
    "Un objet JSON est requis.",
  );
  const reader = request.body?.getReader();
  requireValue(reader, 400, "La requête est vide.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch { /* The size limit still refuses the command. */ }
        throw new HttpFailure(413, "La commande est trop volumineuse.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpFailure(400, "Le JSON reçu est invalide.");
  }
  requireValue(
    input && typeof input === "object" && !Array.isArray(input),
    400,
    "Un objet JSON est requis.",
  );
  return input as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function commandRevision(value: unknown): number {
  requireValue(
    Number.isSafeInteger(value) && (value as number) >= 0,
    400,
    "La révision de la conversation est invalide.",
  );
  return value as number;
}

function messageBody(value: Record<string, unknown>, defaultRevision?: number) {
  const fields = [
    "text",
    ...(defaultRevision === undefined ? ["expectedRevision"] : []),
  ];
  if (Object.hasOwn(value, "caseId")) fields.push("caseId");
  if (Object.hasOwn(value, "newConversation")) fields.push("newConversation");
  const validId = value.caseId === undefined ||
    typeof value.caseId === "string" && value.caseId.length > 0 &&
      value.caseId.length <= 256 && value.caseId.trim() === value.caseId &&
      !Array.from(value.caseId).some((char) =>
        char === "/" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      );
  if (
    !exactFields(value, fields) || !validId ||
    value.newConversation !== undefined && value.newConversation !== true ||
    value.newConversation && value.caseId !== undefined ||
    typeof value.text !== "string" || !value.text.trim() ||
    value.text.length > MAX_USER_MESSAGE_CHARS
  ) {
    throw new OperatorConversationError(
      "INVALID_MESSAGE",
      "Message ou sélection de conversation invalide.",
      400,
      {},
      `Send text (1–${MAX_USER_MESSAGE_CHARS} characters) and the required expectedRevision; omit selection for the Main Operator, use newConversation: true for a new Case, or caseId to resume one.`,
    );
  }
  return {
    text: value.text.trim(),
    expectedRevision: defaultRevision ??
      commandRevision(value.expectedRevision),
    ...(value.caseId !== undefined ? { caseId: value.caseId as string } : {}),
    ...(value.newConversation ? { newConversation: true as const } : {}),
  };
}

function decisionBody(
  value: Record<string, unknown>,
): Omit<OperatorCandidateDecision, "agentId"> {
  requireValue(
    exactFields(value, [
      "candidateId",
      "candidateDigest",
      "expectedRevision",
      "verdict",
      "reason",
    ]),
    400,
    "La décision doit identifier le candidat exact, sa révision et sa justification.",
  );
  for (const key of ["candidateId", "candidateDigest"] as const) {
    requireValue(
      typeof value[key] === "string" && value[key].trim().length > 0 &&
        value[key].length <= 256,
      400,
      "L’identité du candidat est invalide.",
    );
  }
  requireValue(
    value.verdict === "approve" || value.verdict === "refuse",
    400,
    "Le verdict est invalide.",
  );
  requireValue(
    typeof value.reason === "string" && value.reason.trim().length > 0 &&
      value.reason.length <= 2_000,
    400,
    "La décision doit être justifiée en 1 à 2 000 caractères.",
  );
  return {
    candidateId: value.candidateId as string,
    candidateDigest: value.candidateDigest as string,
    expectedRevision: commandRevision(value.expectedRevision),
    verdict: value.verdict,
    reason: value.reason.trim(),
  };
}

function changeDecisionBody(
  value: Record<string, unknown>,
): Omit<OperatorChangeDecision, "agentId" | "changeId"> {
  requireValue(
    exactFields(value, [
      "expectedRevision",
      "configurationRevision",
      "verdict",
    ]),
    400,
    "La décision doit identifier les révisions exactes et le verdict.",
  );
  requireValue(
    value.verdict === "approve" || value.verdict === "refuse",
    400,
    "Le verdict est invalide.",
  );
  return {
    expectedRevision: commandRevision(value.expectedRevision),
    configurationRevision: commandRevision(value.configurationRevision),
    verdict: value.verdict,
  };
}

/** Reading a modeled operator never starts it. Only a valid local command can. */
export function createConversationsHandler(
  application: ConversationsApplication,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
  scoped?: Pick<
    RequestCaseConversationsPort,
    | "conversations"
    | "submitHuman"
    | "decideChange"
    | "networkDecisionStatus"
    | "resumeNetworkDecision"
  >,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const collection = url.pathname === "/api/conversations";
    const catalog = url.pathname === "/api/operator-tools";
    const primaryMessages = url.pathname === "/api/messages";
    const match = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/(messages|decisions)$/,
    );
    const changeMatch = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/changes\/([^/]+)\/decision(\/resume)?$/,
    );
    if (!collection && !catalog && !primaryMessages && !match && !changeMatch) {
      if (
        url.pathname.startsWith("/api/conversations/") &&
        (url.searchParams.has("space") || url.searchParams.has("caseId"))
      ) {
        return json({
          code: "UNAVAILABLE",
          error: "This scoped Request operation is unavailable",
        }, 404);
      }
      return null;
    }
    const allowed = collection || catalog
      ? "GET"
      : changeMatch && !changeMatch[3]
      ? "GET, POST"
      : "POST";
    if (!allowed.split(", ").includes(request.method)) {
      return new Response(null, {
        status: 405,
        headers: { allow: allowed, "cache-control": "no-store" },
      });
    }
    // Explicit scoped selection is terminal even when auth or lookup fails.
    if (url.searchParams.has("space") || url.searchParams.has("caseId")) {
      try {
        if (!scoped) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "Request conversations are unavailable",
          );
        }
        if (
          collection && request.method === "GET" &&
          url.searchParams.size === 1 &&
          url.searchParams.getAll("caseId").length === 1
        ) {
          const id = url.searchParams.get("caseId")!;
          return json(
            await scoped.conversations(spaceSessionSecret(request), id),
          );
        }
        if (
          changeMatch && url.searchParams.get("space") === "requests" &&
          (request.method === "GET" && !changeMatch[3] &&
              url.searchParams.size === 2 &&
              url.searchParams.getAll("caseId").length === 1 ||
            request.method === "POST" && url.searchParams.size === 1)
        ) {
          let agentId: string, changeId: string;
          try {
            agentId = decodeURIComponent(changeMatch[1]!);
            changeId = decodeURIComponent(changeMatch[2]!);
          } catch {
            throw new HttpFailure(400, "Invalid decision identity");
          }
          for (const id of [agentId, changeId]) {
            requireValue(
              id.length > 0 && id.length <= 256 && id.trim() === id &&
                id !== "." && id !== ".." && !Array.from(id).some((c) =>
                  c === "/" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
                ),
              400,
              "Invalid decision identity",
            );
          }
          if (request.method === "GET") {
            const caseId = url.searchParams.get("caseId")!;
            requireValue(
              caseId.length > 0 && caseId.length <= 256 &&
                caseId.trim() === caseId && !Array.from(caseId).some((c) =>
                  c === "/" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
                ),
              400,
              "An exact Request is required",
            );
            if (!scoped.networkDecisionStatus) {
              throw new RequestSpaceError(
                "UNAVAILABLE",
                "Request decisions are unavailable",
              );
            }
            return json(
              await scoped.networkDecisionStatus(
                spaceSessionSecret(request),
                caseId,
                agentId,
                changeId,
              ),
            );
          }
          requireLocalJsonCommand(request, servedOrigin);
          const body = await jsonBody(request);
          requireValue(
            typeof body.caseId === "string" && body.caseId.length > 0 &&
              body.caseId.length <= 256 &&
              body.caseId.trim() === body.caseId &&
              !Array.from(body.caseId).some((c) =>
                c === "/" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
              ),
            400,
            "An exact Request is required",
          );
          const { caseId, ...decisionInput } = body;
          if (changeMatch[3]) {
            requireValue(
              Object.keys(decisionInput).length === 0,
              400,
              "Unexpected resume fields",
            );
            if (!scoped.resumeNetworkDecision) {
              throw new RequestSpaceError(
                "UNAVAILABLE",
                "Request decisions are unavailable",
              );
            }
            return json(
              await scoped.resumeNetworkDecision(
                spaceSessionSecret(request),
                caseId as string,
                agentId,
                changeId,
              ),
              202,
            );
          }
          const decision = changeDecisionBody(decisionInput);
          if (!scoped.decideChange) {
            throw new RequestSpaceError(
              "UNAVAILABLE",
              "Request decisions are unavailable",
            );
          }
          const result = await scoped.decideChange(
            spaceSessionSecret(request),
            {
              caseId: caseId as string,
              agentId,
              changeId,
              ...decision,
            },
          );
          return json(result, 202);
        }
        if (
          !match || match[2] !== "messages" || request.method !== "POST" ||
          url.searchParams.size !== 1 ||
          url.searchParams.get("space") !== "requests"
        ) {
          throw new RequestSpaceError(
            "INVALID_COMMAND",
            "This scoped Request operation is unavailable",
          );
        }
        requireLocalJsonCommand(request, servedOrigin);
        let agentId: string;
        try {
          agentId = decodeURIComponent(match[1]!);
        } catch {
          throw new HttpFailure(400, "Invalid operator identity");
        }
        requireValue(
          agentId.length > 0 && agentId.length <= 256 &&
            agentId.trim() === agentId &&
            agentId !== "." && agentId !== ".." &&
            !Array.from(agentId).some((char) =>
              char === "/" || char.charCodeAt(0) < 32 ||
              char.charCodeAt(0) === 127
            ),
          400,
          "Invalid operator identity",
        );
        const message = messageBody(await jsonBody(request));
        if (!message.caseId || message.newConversation !== undefined) {
          throw new RequestSpaceError(
            "INVALID_COMMAND",
            "An existing Request must be selected",
          );
        }
        const caseId = await scoped.submitHuman(spaceSessionSecret(request), {
          agentId,
          ...message,
        });
        return json({ accepted: true, ...(caseId ? { caseId } : {}) }, 202);
      } catch (error) {
        if (error instanceof RequestSpaceError) return spaceHttpError(error);
        if (
          error instanceof OperatorConversationError ||
          error instanceof CaseError
        ) {
          return json(
            { code: error.code, error: error.message },
            error instanceof OperatorConversationError ? error.status : 409,
          );
        }
        if (error instanceof LocalHttpFailure || error instanceof HttpFailure) {
          return json({ error: error.message }, error.status);
        }
        // The response stays generic; the cause must still reach the host log.
        log.error(
          "Scoped Request operation failed",
          errorLogProperties(error),
        );
        return json({
          code: "UNAVAILABLE",
          error: "Request conversation unavailable",
        }, 503);
      }
    }
    let changeContext: ChangePublicationError["context"] | undefined;
    try {
      requireValue(
        !url.search,
        400,
        "Aucun paramètre de requête n’est accepté.",
      );
      if (collection) {
        return json(
          application.conversations
            ? await application.conversations()
            : application.snapshot,
        );
      }
      if (catalog) return json(application.catalogSnapshot);
      requireLocalJsonCommand(request, servedOrigin);
      let agentId: string;
      try {
        agentId = primaryMessages
          ? application.snapshot.defaultAgentId
          : decodeURIComponent((changeMatch ?? match)![1]!);
      } catch {
        throw new HttpFailure(400, "L’identifiant de l’agent est invalide.");
      }
      requireValue(
        agentId.length > 0 && agentId.length <= 256 &&
          agentId.trim() === agentId && !Array.from(agentId).some((character) =>
            character === "/" || character.charCodeAt(0) < 32 ||
            character.charCodeAt(0) === 127
          ) &&
          agentId !== "." && agentId !== "..",
        400,
        "L’identifiant de l’agent est invalide.",
      );
      const conversation = application.snapshot.conversations.find((entry) =>
        entry.agentId === agentId
      );
      if (!conversation) {
        throw new OperatorConversationError(
          "UNKNOWN_AGENT",
          "Cet agent n’est pas disponible.",
          404,
          { agentId },
          "Reload /api/conversations and select an available agent.",
        );
      }
      const body = await jsonBody(request);
      const changeDecision = changeMatch ? changeDecisionBody(body) : null;
      const decision =
        !primaryMessages && !changeMatch && match![2] === "decisions"
          ? decisionBody(body)
          : null;
      const message = changeMatch || decision ? null : messageBody(
        body,
        primaryMessages ? conversation.revision : undefined,
      );
      const expectedRevision = changeDecision?.expectedRevision ??
        decision?.expectedRevision ?? message!.expectedRevision;
      let changeId: string | undefined;
      if (changeDecision) {
        try {
          changeId = decodeURIComponent(changeMatch![2]!);
        } catch {
          throw new HttpFailure(
            400,
            "L’identifiant de proposition est invalide.",
          );
        }
        requireValue(
          changeId.length > 0 && changeId.length <= 256 &&
            changeId.trim() === changeId &&
            !Array.from(changeId).some((character) =>
              character === "/" || character.charCodeAt(0) < 32 ||
              character.charCodeAt(0) === 127
            ) && changeId !== "." && changeId !== "..",
          400,
          "L’identifiant de proposition est invalide.",
        );
        requireValue(
          conversation.runtimeOwned === true && conversation.proposalContext,
          409,
          "Aucun runtime propriétaire ne contrôle cette proposition.",
        );
        changeContext = { changeId };
        const owned = conversation.proposalContext.changes.find((entry) =>
          entry.id === changeId
        );
        requireValue(
          owned,
          404,
          "Cette proposition n’appartient pas à cet opérateur.",
        );
        if (owned.baseRevision !== changeDecision.configurationRevision) {
          throw new ChangePublicationError(
            "PUBLICATION_FAILED",
            changeContext,
            "La proposition a changé. Relisez son état avant de décider.",
          );
        }
        // Publication status and stale configuration are decided by the runtime
        // only after its exhaustive publication lookup.
        requireValue(
          owned.status === "pending" || owned.status === "approved",
          409,
          "La proposition a changé. Relisez son état avant de décider.",
        );
      } else if (decision) {
        const owned = application.catalogSnapshot.tools.find((entry) =>
          entry.agentId === agentId &&
          entry.candidate.id === decision.candidateId
        );
        requireValue(
          owned,
          404,
          "Ce candidat n’appartient pas à cet opérateur.",
        );
        requireValue(
          owned.candidate.digest === decision.candidateDigest,
          409,
          "Le candidat a changé. Relisez son contenu avant de décider.",
        );
      } else {
        requireValue(
          conversation.canSend || conversation.runtimeOwned === true &&
              message?.caseId !== undefined && !message.newConversation,
          403,
          conversation.readOnlyReason ||
            "Le modèle n’expose pas de conversation humaine pour cet agent.",
        );
      }
      if (
        changeContext &&
        (conversation.busy || conversation.revision !== expectedRevision)
      ) {
        throw new ChangePublicationError(
          "PUBLICATION_FAILED",
          changeContext,
          conversation.busy
            ? "Une réponse est déjà en cours dans cette conversation."
            : "La conversation a changé. Relisez son état avant de décider.",
        );
      }
      if (conversation.busy) {
        throw new OperatorConversationError(
          "AGENT_BUSY",
          "Une réponse est déjà en cours pour cet opérateur.",
          409,
          { agentId, ...(message?.caseId ? { caseId: message.caseId } : {}) },
          "retry after the current reply",
        );
      }
      if (conversation.revision !== expectedRevision) {
        throw new OperatorConversationError(
          "STALE_CONVERSATION",
          "La conversation a changé. Relisez son état avant d’envoyer le message.",
          409,
          { agentId },
          "Reload /api/conversations and retry with the agent's current revision.",
        );
      }
      // The application repeats admission and CAS at the actual reservation.
      if (changeDecision) {
        await application.decideChange({
          agentId,
          changeId: changeId!,
          ...changeDecision,
        });
      } else if (decision) {
        await application.decideCandidate({ agentId, ...decision });
      } else {
        const caseId = await application.submitHuman({ agentId, ...message! });
        return json({ accepted: true, ...(caseId ? { caseId } : {}) }, 202);
      }
      return json({ accepted: true }, 202);
    } catch (caught) {
      const error =
        changeContext && caught instanceof OperatorConversationError &&
          ["AGENT_BUSY", "STALE_CONVERSATION"].includes(caught.code)
          ? publicationFailure(caught, changeContext, "retry")
          : caught;
      if (
        error instanceof ChangePendingError ||
        error instanceof ChangeScopeMissingError
      ) {
        return json({
          error: error.message,
          code: error.code,
          context: error.context,
          recovery: error.recovery,
        }, 409);
      }
      if (error instanceof CaseError) {
        return json(
          {
            error: error.message,
            code: error.code,
            context: error.context,
            recovery: error.recovery,
          },
          error.code === "CASE_NOT_FOUND"
            ? 404
            : error.code === "CASE_NOT_OWNED"
            ? 403
            : 409,
        );
      }
      if (
        error instanceof ChangePublicationError ||
        error instanceof OperatorConversationError
      ) {
        return json({
          error: error.message,
          code: error.code,
          context: error.context,
          recovery: error.recovery,
        }, error instanceof ChangePublicationError ? 409 : error.status);
      }
      if (error instanceof LocalHttpFailure) {
        return json({
          error: error.message,
          code: error.code,
          recovery: error.recovery,
        }, error.status);
      }
      if (error instanceof HttpFailure) {
        return json({ error: error.message }, error.status);
      }
      if (error instanceof AuthorityInvariantError) {
        return json({
          error: error.message,
          code: error.code,
          invariant: error.invariant,
          reason: error.reason,
          ...(error instanceof ChangeApprovabilityError
            ? { context: error.context, recovery: error.recovery }
            : {}),
        }, 403);
      }
      return json({
        error: error instanceof Error
          ? error.message.slice(0, 450)
          : "La commande n’a pas pu être exécutée.",
      }, 400);
    }
  };
}
