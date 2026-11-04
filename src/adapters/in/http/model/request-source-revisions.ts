import { matchesExactRevision } from "../../../../domain/shared-kernel/revision-id.ts";
import type {
  ProposeRequestSourceRevision,
  RequestSourceRevisions,
} from "../../../../application/model/source-admission/revisions.ts";
import { ModelRepositoryError } from "../../../../application/model/repository.ts";
import { ModelWriteQueueError } from "../../../../application/model/publication/write-queue.ts";
import { ModelPublicationError } from "../../../../application/model/publication/service.ts";
import { RequestSourceOwnerError } from "../../../../application/model/source-admission/request-source-owner.ts";
import { ModelWriteCommandError } from "../../../../domain/model/editing/write-command-error.ts";
import {
  exactSourceVersion,
  RequestSpaceError,
  requestSpaceIdentity,
} from "../../../../domain/work/request-spaces/scope.ts";
import { requireLocalJsonCommand } from "../../../../infrastructure/http/local-security.ts";
import {
  boundedSpaceCommand,
  spaceHttpError,
  spaceJson,
  spaceSessionSecret,
} from "../work/space-session.ts";

const MAX_BODY_BYTES = 8_500_000;
const invalid = (): never => {
  throw new RequestSpaceError(
    "INVALID_COMMAND",
    "An exact Request source command is required.",
  );
};
function fields(value: unknown, names: string): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== names
  ) return invalid();
  return value as Record<string, unknown>;
}
function propose(value: unknown): ProposeRequestSourceRevision {
  const command = fields(value, "caseId,changes,expectedVersion,reason");
  if (
    !requestSpaceIdentity(command.caseId) ||
    !exactSourceVersion(command.expectedVersion) ||
    typeof command.reason !== "string" || !Array.isArray(command.changes)
  ) return invalid();
  for (const value of command.changes) {
    const change = fields(value, "path,text");
    if (
      typeof change.path !== "string" ||
      !(change.text === null || typeof change.text === "string")
    ) return invalid();
  }
  return command as unknown as ProposeRequestSourceRevision;
}
function identityPair(
  value: unknown,
  name: "proposalId" | "commandId",
): { caseId: string; id: string } {
  const command = fields(value, ["caseId", name].sort().join(","));
  if (
    !requestSpaceIdentity(command.caseId) ||
    !requestSpaceIdentity(command[name])
  ) return invalid();
  return { caseId: command.caseId, id: command[name] as string };
}
function failure(error: unknown): Response {
  if (error instanceof RequestSourceOwnerError) {
    return spaceJson({
      code: error.code,
      error: "Current Request source authority is unavailable.",
    }, 403);
  }
  if (error instanceof ModelWriteCommandError) {
    return spaceJson({
      code: error.code,
      error:
        "The Request source command is invalid or differs from its recorded intent.",
    }, error.code === "WRITE_DOSSIER_MISMATCH" ? 409 : 400);
  }
  if (error instanceof ModelWriteQueueError) {
    return spaceJson(
      {
        code: error.code,
        error: "The Request source command could not be completed.",
      },
      error.code === "WRITE_QUEUE_INVALID"
        ? 400
        : error.code === "WRITE_QUEUE_CONFLICT"
        ? 409
        : 503,
    );
  }
  if (error instanceof ModelPublicationError) {
    return spaceJson({
      code: error.code,
      error: "The Request source command could not be completed.",
    }, error.code === "NEEDS_DECISION" || error.code === "STALE" ? 409 : 403);
  }
  if (error instanceof ModelRepositoryError) {
    return spaceJson(
      {
        code: error.code,
        error: "The Request source is unavailable or changed.",
      },
      error.code === "EDIT_SCOPE_DENIED"
        ? 403
        : error.code === "NOT_FOUND"
        ? 404
        : error.code === "INVALID_REQUEST"
        ? 400
        : error.code === "STALE_REVISION" || error.code === "SOURCE_CONFLICT"
        ? 409
        : 503,
    );
  }
  return spaceHttpError(error);
}

/** Public local human surface. Scoped authority/target are resolved by the
 * service; no body may supply a principal, destination, ref or proof. */
export function createRequestSourceRevisionsHandler(
  service: Pick<RequestSourceRevisions, "propose" | "accept" | "resume">,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const routes = [
      "/api/request-source-revisions/propose",
      "/api/request-source-revisions/accept",
      "/api/request-source-revisions/resume",
    ] as const;
    if (!routes.includes(url.pathname as typeof routes[number])) return null;
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }
    try {
      requireLocalJsonCommand(request, servedOrigin);
      if (url.search) return invalid();
      const secret = spaceSessionSecret(request);
      const input = await boundedSpaceCommand(request, MAX_BODY_BYTES);
      if (url.pathname === routes[0]) {
        const command = propose(input);
        const result = await service.propose(secret, command);
        if (
          result.caseId !== command.caseId || !requestSpaceIdentity(result.id)
        ) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "The Request proposal identity differs.",
          );
        }
        return spaceJson({
          caseId: result.caseId,
          id: result.id,
          author: result.author,
          reason: result.reason,
          baseVersion: result.baseVersion,
          createdAt: result.createdAt,
          status: result.status,
          validation: result.validation,
          sourceDigest: result.sourceDigest,
          ...(result.proposalVersion
            ? { proposalVersion: result.proposalVersion }
            : {}),
          diff: result.diff.map((change) => ({
            path: change.path,
            kind: change.kind,
            ...(change.before !== undefined ? { before: change.before } : {}),
            ...(change.after !== undefined ? { after: change.after } : {}),
          })),
        });
      }
      const selected = identityPair(
        input,
        url.pathname === routes[1] ? "proposalId" : "commandId",
      );
      if (url.pathname === routes[1]) {
        const result = await service.accept(secret, {
          caseId: selected.caseId,
          proposalId: selected.id,
        });
        if (
          result.caseId !== selected.caseId || result.commandId !== selected.id
        ) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "The recorded Request command differs.",
          );
        }
        return spaceJson(
          { caseId: result.caseId, commandId: result.commandId },
          202,
        );
      }
      const result = await service.resume(secret, {
        caseId: selected.caseId,
        commandId: selected.id,
      });
      if (!result) {
        return spaceJson({
          code: "UNAVAILABLE",
          error: "The Request source command is unavailable.",
        }, 404);
      }
      if (
        !matchesExactRevision(result.version) ||
        !/^[a-f0-9]{64}$/.test(result.sourceDigest)
      ) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The published Request source is unavailable.",
        );
      }
      return spaceJson({
        caseId: selected.caseId,
        version: result.version,
        sourceDigest: result.sourceDigest,
      });
    } catch (error) {
      return failure(error);
    }
  };
}
