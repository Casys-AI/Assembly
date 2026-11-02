import { ChangePublicationError } from "../../../../domain/model/publication/change.ts";
import { ChangeApprovabilityError } from "../../../../domain/governance/policies/change-approvability.ts";
import { AuthorityInvariantError } from "../../../../domain/governance/authority.ts";
import { CaseError } from "../../../../domain/work/errors/case.ts";
import type { SystemRuntime } from "../../../../application/work/runtime/system.ts";
import type { OperatorConversations } from "../../../../application/work/operators/conversations.ts";
import {
  LocalHttpFailure,
  requireLocalJsonCommand,
} from "../../../../infrastructure/http/local-security.ts";

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const exactKeys = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};
const nonempty = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const decisionRevision = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const decisionVerdict = (value: unknown): value is "approve" | "refuse" =>
  value === "approve" || value === "refuse";

/** Legacy local controls share the runtime's publication decision boundary. */
export function createControlHandler(
  service: Pick<SystemRuntime, "snapshot" | "decideChange">,
  conversations: Pick<OperatorConversations, "submitHuman" | "decideCandidate">,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "POST") {
        if (!["/api/messages", "/api/decisions"].includes(url.pathname)) {
          return new Response("Not found", { status: 404 });
        }
        requireLocalJsonCommand(request, servedOrigin);
        const raw = await request.text();
        if (raw.length > 35000) {
          return json({ error: "Requête trop longue" }, 413);
        }
        const input = JSON.parse(raw);
        if (url.pathname === "/api/messages") {
          if (!exactKeys(input, ["text"]) || typeof input.text !== "string") {
            return json({ error: "Message invalide" }, 400);
          }
          await conversations.submitHuman({
            agentId: service.snapshot.executionModel!.identity.builderId,
            expectedRevision: service.snapshot.revision,
            text: input.text,
          });
          return json({ accepted: true }, 202);
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return json({ error: "Décision invalide" }, 400);
        }
        if (input.kind === "candidate") {
          if (
            !exactKeys(input, [
              "kind",
              "candidateId",
              "candidateDigest",
              "expectedRevision",
              "verdict",
              "reason",
            ]) || !nonempty(input.candidateId, 200) ||
            typeof input.candidateDigest !== "string" ||
            !/^[a-f0-9]{64}$/i.test(input.candidateDigest) ||
            !decisionRevision(input.expectedRevision) ||
            !decisionVerdict(input.verdict) || !nonempty(input.reason, 2000)
          ) return json({ error: "Décision de candidat invalide" }, 400);
          if (input.expectedRevision !== service.snapshot.revision) {
            throw new Error("L’état a changé ; recharge la proposition.");
          }
          await conversations.decideCandidate({
            agentId: service.snapshot.executionModel!.identity.builderId,
            expectedRevision: input.expectedRevision,
            candidateId: input.candidateId,
            candidateDigest: input.candidateDigest,
            verdict: input.verdict,
            reason: input.reason,
          });
        } else if (input.kind === "change") {
          if (
            !exactKeys(input, [
              "kind",
              "changeId",
              "expectedRevision",
              "verdict",
            ]) || !nonempty(input.changeId, 200) ||
            !decisionRevision(input.expectedRevision) ||
            !decisionVerdict(input.verdict)
          ) return json({ error: "Décision de configuration invalide" }, 400);
          if (input.expectedRevision !== service.snapshot.revision) {
            throw new ChangePublicationError("PUBLICATION_FAILED", {
              changeId: input.changeId,
              systemId: service.snapshot.model?.systemId,
            }, "L’état a changé ; recharge la proposition.");
          }
          const change = service.snapshot.configuration!.changes.find((entry) =>
            entry.id === input.changeId
          );
          if (!change) return json({ error: "Proposition introuvable" }, 404);
          await service.decideChange({
            changeId: input.changeId,
            expectedRevision: change.baseRevision,
            verdict: input.verdict,
          });
        } else return json({ error: "Type de décision inconnu" }, 400);
        return json({ accepted: true }, 202);
      }
      return null;
    } catch (error) {
      if (error instanceof LocalHttpFailure) {
        return json({
          error: error.message,
          code: error.code,
          recovery: error.recovery,
        }, error.status);
      }
      return json(
        {
          ...(error instanceof ChangePublicationError ||
              error instanceof CaseError
            ? {
              code: error.code,
              context: error.context,
              recovery: error.recovery,
            }
            : {}),
          ...(error instanceof AuthorityInvariantError
            ? {
              code: error.code,
              invariant: error.invariant,
              reason: error.reason,
              ...(error instanceof ChangeApprovabilityError
                ? { context: error.context, recovery: error.recovery }
                : {}),
            }
            : {}),
          error: error instanceof Error
            ? error.message.slice(0, 450)
            : "Opération échouée",
        },
        error instanceof ChangePublicationError || error instanceof CaseError ||
          service.snapshot.busy
          ? 409
          : 400,
      );
    }
  };
}
