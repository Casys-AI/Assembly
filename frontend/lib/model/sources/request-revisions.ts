import {
  isSessionFailure,
  RequestSourceApiError,
  responseError,
} from "../../api-error.ts";
export {
  isSessionFailure as isRequestSourceSessionFailure,
  RequestSourceApiError,
} from "../../api-error.ts";

/** Public human commands only. Cookies are same-origin; no scope/ref/actor/proof
 * is accepted from this client. Immutable Case model fetch remains GET-only. */
export interface RequestSourceProposal {
  caseId: string;
  id: string;
  baseVersion: string;
  proposalVersion: string;
  sourceDigest: string;
  reason: string;
  createdAt: string;
  diff: {
    path: string;
    kind: "added" | "changed" | "deleted";
    before?: string;
    after?: string;
  }[];
}
export interface RequestSourceReceipt {
  caseId: string;
  version: string;
  sourceDigest: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const version = (v: unknown): v is string =>
  typeof v === "string" && /^commit:[a-f0-9]{40}$/.test(v);
const digest = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(v);
const invalid = (): never => {
  throw new RequestSourceApiError(
    "The host returned a different Request source result.",
  );
};
export function createRequestSourceRevisionApi(
  caseId: string,
  options: { fetch?: typeof fetch; onUnauthorized?(): void } = {},
) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function post(
    action: "propose" | "accept" | "resume",
    input: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await fetcher(`/api/request-source-revisions/${action}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = responseError(
        response.status,
        body,
        "The Request source command could not be confirmed.",
      );
      if (isSessionFailure(error)) options.onUnauthorized?.();
      throw error;
    }
    if (!object(body) || body.caseId !== caseId) return invalid();
    return body;
  }
  return {
    async propose(
      input: {
        expectedVersion: string;
        path: string;
        text: string;
        reason: string;
      },
    ): Promise<RequestSourceProposal> {
      const body = await post("propose", {
        caseId,
        expectedVersion: input.expectedVersion,
        changes: [{ path: input.path, text: input.text }],
        reason: input.reason,
      });
      if (
        !id(body.id) || !version(body.baseVersion) ||
        !version(body.proposalVersion) || !digest(body.sourceDigest) ||
        body.author !== "local-owner" || body.status !== "proposed" ||
        body.validation !== "validated" || typeof body.reason !== "string" ||
        typeof body.createdAt !== "string" ||
        !Array.isArray(body.diff) || body.diff.length < 1 ||
        body.diff.length > 64 ||
        !body.diff.every((change) =>
          object(change) && typeof change.path === "string" &&
          ["added", "changed", "deleted"].includes(String(change.kind)) &&
          (change.before === undefined || typeof change.before === "string") &&
          (change.after === undefined || typeof change.after === "string")
        )
      ) return invalid();
      return structuredClone({
        caseId,
        id: body.id,
        baseVersion: body.baseVersion,
        proposalVersion: body.proposalVersion,
        sourceDigest: body.sourceDigest,
        reason: body.reason,
        createdAt: body.createdAt,
        diff: body.diff,
      }) as RequestSourceProposal;
    },
    async accept(proposalId: string): Promise<void> {
      const body = await post("accept", { caseId, proposalId });
      if (body.commandId !== proposalId) return invalid();
    },
    async resume(commandId: string): Promise<RequestSourceReceipt> {
      const body = await post("resume", { caseId, commandId });
      if (!version(body.version) || !digest(body.sourceDigest)) {
        return invalid();
      }
      return { caseId, version: body.version, sourceDigest: body.sourceDigest };
    },
  };
}
export type RequestSourceRevisionApi = ReturnType<
  typeof createRequestSourceRevisionApi
>;
