import { CaseError } from "../../../../domain/work/errors/case.ts";
import type { RequestCaseConversationsPort } from "../../../../application/work/request-spaces/conversations.ts";
import { spaceHttpError, spaceSessionSecret } from "./space-session.ts";
import { requireLocalJsonCommand } from "../../../../infrastructure/http/local-security.ts";
import {
  CASE_VERDICTS,
  type CaseClosureEvidence,
  type CasesSnapshot,
  type CaseVerdict,
} from "../../../../domain/work/entities/cases.ts";

export interface CasesApplication {
  readonly cases: CasesSnapshot;
  closeCase(
    id: string,
    outcome: "done" | "abandoned",
    evidence?: CaseClosureEvidence,
  ): Promise<void>;
  runCase(id: string): Promise<void>;
  pauseCase(id: string): Promise<void>;
  resumeCase(id: string): Promise<void>;
  stopCase(id: string): Promise<void>;
}

class HttpFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireValue(
  value: unknown,
  code: string,
  status: number,
  message: string,
): asserts value {
  if (!value) throw new HttpFailure(code, status, message);
}

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

function caseId(encoded: string): string {
  let id: string;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    throw new HttpFailure(
      "INVALID_CASE_ID",
      400,
      "Identifiant de Case invalide.",
    );
  }
  requireValue(
    id.length > 0 && id.length <= 256 && id.trim() === id &&
      id !== "." && id !== ".." &&
      !Array.from(id).some((character) =>
        character === "/" || character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127
      ),
    "INVALID_CASE_ID",
    400,
    "Identifiant de Case invalide.",
  );
  return id;
}

async function commandInput(request: Request): Promise<unknown> {
  requireValue(
    request.headers.get("content-type")?.split(";", 1)[0]?.trim()
      .toLowerCase() === "application/json",
    "JSON_REQUIRED",
    415,
    "Un objet JSON est requis.",
  );
  const reader = request.body?.getReader();
  requireValue(reader, "INVALID_COMMAND", 400, "La commande est vide.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 1024) {
        try {
          await reader.cancel();
        } catch { /* The size limit still refuses the command. */ }
        throw new HttpFailure(
          "COMMAND_TOO_LARGE",
          413,
          "La commande est trop volumineuse.",
        );
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
    throw new HttpFailure("INVALID_JSON", 400, "Le JSON reçu est invalide.");
  }
  return input;
}

async function closeOutcome(
  request: Request,
): Promise<{ outcome: "done" | "abandoned"; verdict?: CaseVerdict }> {
  const input = await commandInput(request);
  requireValue(
    input && typeof input === "object" && !Array.isArray(input) &&
      Object.keys(input).every((key) => ["outcome", "verdict"].includes(key)) &&
      Object.hasOwn(input, "outcome"),
    "INVALID_COMMAND",
    400,
    "The closure command accepts outcome and verdict only.",
  );
  const { outcome, verdict } = input as Record<string, unknown>;
  requireValue(
    outcome === "done" || outcome === "abandoned",
    "INVALID_COMMAND",
    400,
    "Closure outcome must be done or abandoned.",
  );
  requireValue(
    verdict === undefined || CASE_VERDICTS.includes(verdict as CaseVerdict),
    "INVALID_COMMAND",
    400,
    "Verdict must be accepted or rejected.",
  );
  return { outcome, verdict: verdict as CaseVerdict | undefined };
}

async function emptyCommand(request: Request): Promise<void> {
  const input = await commandInput(request);
  requireValue(
    input && typeof input === "object" && !Array.isArray(input) &&
      Object.keys(input).length === 0,
    "INVALID_COMMAND",
    400,
    "Cette action n’accepte aucun paramètre.",
  );
}

function errorResponse(error: unknown): Response {
  const failure = error instanceof Error
    ? error as Error & {
      code?: string;
      status?: number;
      context?: Record<string, string>;
      recovery?: string;
    }
    : undefined;
  const code = typeof failure?.code === "string"
    ? failure.code
    : "CASE_COMMAND_FAILED";
  const status = failure?.status && Number.isInteger(failure.status) &&
      failure.status >= 400 && failure.status <= 599
    ? failure.status
    : code === "NOT_FOUND"
    ? 404
    : ["CASE_BUSY", "CASE_CLOSED", "CASE_CONFLICT", "STALE_REVISION"].includes(
        code,
      )
    ? 409
    : code === "NOT_SUPPORTED_YET"
    ? 422
    : 400;
  return json({
    error: {
      code,
      message: failure?.message.slice(0, 450) ??
        "La commande de Case n’a pas pu être exécutée.",
      ...(failure?.context ? { context: failure.context } : {}),
      ...(failure?.recovery ? { recovery: failure.recovery } : {}),
    },
  }, status);
}

/** Local loopback controls, identical to conversation commands. A Case action
 * never changes the authority admitted by the model. Reading starts no work. */
export function createCasesHandler(
  application: CasesApplication,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
  scoped?: Pick<RequestCaseConversationsPort, "cases" | "closeCase">,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const collection = url.pathname === "/api/cases";
    const match = url.pathname.match(
      /^\/api\/cases\/([^/]+)(?:\/(close|run|pause|resume|stop))?$/,
    );
    if (!collection && !match) return null;
    const allowed = match?.[2] ? "POST" : "GET";
    if (request.method !== allowed) {
      return json(
        {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: "Méthode non autorisée.",
          },
        },
        405,
        { allow: allowed },
      );
    }
    if (url.searchParams.has("space")) {
      try {
        if (
          url.searchParams.size !== 1 ||
          url.searchParams.get("space") !== "requests" ||
          (match?.[2] && match[2] !== "close") || !scoped
        ) {
          return json({
            error: {
              code: "INVALID_REQUEST_SELECTION",
              message: "This scoped Request operation is unavailable.",
            },
          }, 400);
        }
        const id = match ? caseId(match[1]!) : undefined;
        if (match?.[2] === "close") {
          requireLocalJsonCommand(request, servedOrigin);
          const command = await closeOutcome(request);
          await scoped.closeCase(
            spaceSessionSecret(request),
            id!,
            command.outcome,
            command.verdict,
          );
        }
        const snapshot = await scoped.cases(spaceSessionSecret(request), id);
        if (id === undefined) return json(snapshot);
        const record = snapshot.cases.find((entry) => entry.id === id);
        requireValue(record, "NOT_FOUND", 404, "Case introuvable.");
        return json({ systemId: snapshot.systemId, case: record });
      } catch (error) {
        return error instanceof HttpFailure ||
            error instanceof CaseError
          ? errorResponse(error)
          : spaceHttpError(error);
      }
    }
    try {
      requireValue(
        !url.search,
        "INVALID_QUERY",
        400,
        "Aucun paramètre de requête n’est accepté.",
      );
      if (collection) return json(application.cases);
      const id = caseId(match![1]!);
      if (allowed === "POST") {
        requireLocalJsonCommand(request, servedOrigin);
        if (match![2] === "close") {
          const command = await closeOutcome(request);
          // Only the scoped session command can supply a person's judgment.
          await application.closeCase(id, command.outcome);
        } else {
          await emptyCommand(request);
          const action = match![2] as "run" | "pause" | "resume" | "stop";
          await application[`${action}Case`](id);
        }
      }
      const snapshot = application.cases;
      const caseRecord = snapshot.cases.find((entry) => entry.id === id);
      requireValue(caseRecord, "NOT_FOUND", 404, "Case introuvable.");
      return json({
        systemId: snapshot.systemId,
        case: caseRecord,
        ...(match![2] === "close" ? { closed: true } : {}),
        ...(match![2] && match![2] !== "close" ? { action: match![2] } : {}),
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
