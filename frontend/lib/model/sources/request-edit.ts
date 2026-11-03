import { signal } from "@preact/signals";
import { MAX_FILE_BYTES } from "../../../../src/domain/model/value-objects/sources.ts";
import {
  isRequestSourceSessionFailure,
  RequestSourceApiError,
  type RequestSourceProposal,
  type RequestSourceReceipt,
  type RequestSourceRevisionApi,
} from "./request-revisions.ts";
export interface RequestEditScope {
  caseId: string;
  branchId: string;
  executionSpaceId: string;
  viewedVersion: string;
  admittedVersion: string;
  executionVersion: string;
  sessionReady: boolean;
}
export interface RequestSourceIntent {
  v: 1;
  caseId: string;
  branchId: string;
  executionSpaceId: string;
  baseVersion: string;
  sourceDigest: string;
  proposalId: string;
  commandId: string;
  acceptAttempted: boolean;
}
export interface RequestFileDraft {
  path: string;
  baseVersion: string;
  before: string;
  text: string;
  reason: string;
}
const immutable = (v: unknown): v is string =>
  typeof v === "string" && /^commit:[a-f0-9]{40}$/.test(v);
const scopeStamp = (value: RequestEditScope) =>
  JSON.stringify([
    value.caseId,
    value.branchId,
    value.executionSpaceId,
    value.viewedVersion,
    value.admittedVersion,
    value.executionVersion,
    value.sessionReady,
  ]);
const identity = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(v);
export function requestSourceIntentKey(
  scope: Pick<RequestEditScope, "caseId" | "branchId" | "executionSpaceId">,
): string {
  return `assembly.request-source.v1:${
    JSON.stringify([scope.caseId, scope.branchId, scope.executionSpaceId])
  }`;
}
export function createRequestSourceEditor(
  options: {
    scope: RequestEditScope;
    api: RequestSourceRevisionApi;
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    onConfirmed(caseId: string): void;
    onUnauthorized?(): void;
  },
) {
  const staticScope = {
    caseId: options.scope.caseId,
    branchId: options.scope.branchId,
    executionSpaceId: options.scope.executionSpaceId,
  };
  let scope = structuredClone(options.scope),
    disposed = false,
    epoch = 0,
    selected = true;
  const draft = signal<RequestFileDraft | null>(null),
    proposal = signal<RequestSourceProposal | null>(null);
  const intent = signal<RequestSourceIntent | null>(null),
    receipt = signal<RequestSourceReceipt | null>(null);
  const busy = signal(false),
    message = signal<string | null>(null),
    proposalUncertain = signal(false),
    resumeAbsent = signal(false);
  const key = requestSourceIntentKey(staticScope);
  function persist(): boolean {
    try {
      if (!options.storage) return false;
      const value = intent.peek();
      if (!value) {
        options.storage.removeItem(key);
        return options.storage.getItem(key) === null;
      }
      const encoded = JSON.stringify(value);
      options.storage.setItem(key, encoded);
      return options.storage.getItem(key) === encoded;
    } catch {
      return false;
    }
  }
  try {
    const raw = options.storage?.getItem(key),
      saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      const value = saved as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(",") ===
          "acceptAttempted,baseVersion,branchId,caseId,commandId,executionSpaceId,proposalId,sourceDigest,v" &&
        value.v === 1 &&
        value.caseId === staticScope.caseId &&
        value.branchId === staticScope.branchId &&
        value.executionSpaceId === staticScope.executionSpaceId &&
        immutable(value.baseVersion) &&
        typeof value.sourceDigest === "string" &&
        /^[a-f0-9]{64}$/.test(value.sourceDigest) &&
        identity(value.proposalId) && value.commandId === value.proposalId &&
        typeof value.acceptAttempted === "boolean"
      ) {
        intent.value = value as unknown as RequestSourceIntent;
        message.value = value.acceptAttempted
          ? "An earlier approval is recorded here. Resume its publication using the same proposal."
          : "A proposal was created earlier. Its review is not restored; no publication is confirmed.";
      }
    }
  } catch { /* Invalid local data grants no action. */ }
  const matches = () =>
    !disposed && selected && scope.caseId === staticScope.caseId &&
    scope.branchId === staticScope.branchId &&
    scope.executionSpaceId === staticScope.executionSpaceId;
  const editable = () =>
    matches() && scope.sessionReady &&
    scope.viewedVersion === scope.admittedVersion;
  const canPropose = () => {
    const value = draft.value;
    return editable() && !busy.value && !intent.value &&
      Boolean(
        value && value.baseVersion === scope.admittedVersion &&
          value.text !== value.before && value.reason.trim() &&
          value.reason.length <= 4000 &&
          new TextEncoder().encode(value.text).length <= MAX_FILE_BYTES,
      );
  };
  const canAccept = () => {
    const value = proposal.value;
    return editable() && !busy.value &&
      Boolean(
        value && value.baseVersion === scope.admittedVersion &&
          (!intent.value?.acceptAttempted || resumeAbsent.value),
      );
  };
  async function resume() {
    const selected = structuredClone(intent.peek());
    if (!matches() || busy.peek() || !selected?.acceptAttempted) return;
    const attempt = ++epoch;
    busy.value = true;
    resumeAbsent.value = false;
    try {
      const result = await options.api.resume(selected.commandId);
      if (!matches() || epoch !== attempt) return;
      if (
        result.caseId !== staticScope.caseId ||
        result.version === selected.baseVersion ||
        result.sourceDigest !== selected.sourceDigest
      ) {
        throw new Error(
          "The published source differs from the recorded command.",
        );
      }
      receipt.value = result;
      message.value =
        "The new source version is published. This request still runs the same model.";
      options.onConfirmed(staticScope.caseId);
    } catch (error) {
      if (!matches() || epoch !== attempt) return;
      resumeAbsent.value = error instanceof RequestSourceApiError &&
        error.status === 404;
      message.value = resumeAbsent.value
        ? "No recorded publication was found. Keep this proposal identity; review the original changes before retrying its approval."
        : "Publication is not confirmed. Reconnect local control if needed, then resume this same command.";
      if (isRequestSourceSessionFailure(error)) options.onUnauthorized?.();
    } finally {
      if (matches() && epoch === attempt) busy.value = false;
    }
  }
  return {
    draft,
    proposal,
    intent,
    receipt,
    busy,
    message,
    proposalUncertain,
    resumeAbsent,
    editable,
    canPropose,
    canAccept,
    setScope(value: RequestEditScope) {
      if (scopeStamp(value) !== scopeStamp(scope)) {
        epoch++;
        if (busy.peek() && !receipt.peek()) {
          message.value =
            "The displayed context changed while a command was in flight. Your draft and known identity are kept; publication is not confirmed.";
          if (!intent.peek()) proposalUncertain.value = true;
        }
        busy.value = false;
      }
      scope = structuredClone(value);
    },
    select(caseId: string | null, sessionReady: boolean) {
      const next = caseId === staticScope.caseId;
      if (next !== selected || scope.sessionReady !== sessionReady) {
        epoch++;
        if (busy.peek() && !receipt.peek()) {
          message.value =
            "The selection or connection changed while a command was in flight. Your draft and known identity are kept; publication is not confirmed.";
          if (!intent.peek()) proposalUncertain.value = true;
        }
        busy.value = false;
      }
      selected = next;
      scope = { ...scope, sessionReady };
    },
    start(path: string, sourceText: string, sourceVersion: string) {
      if (
        !editable() || busy.peek() || sourceVersion !== scope.admittedVersion ||
        (intent.peek()?.acceptAttempted && !receipt.peek())
      ) return;
      epoch++;
      draft.value = {
        path,
        before: sourceText,
        text: sourceText,
        baseVersion: sourceVersion,
        reason: "",
      };
      proposal.value = null;
      intent.value = null;
      receipt.value = null;
      message.value = null;
      proposalUncertain.value = false;
      persist();
    },
    text(value: string) {
      const current = draft.peek();
      if (current && !busy.peek() && !intent.peek()) {
        draft.value = { ...current, text: value };
      }
    },
    reason(value: string) {
      const current = draft.peek();
      if (current && !busy.peek() && !intent.peek()) {
        draft.value = { ...current, reason: value };
      }
    },
    discard() {
      if (busy.peek() || intent.peek()?.acceptAttempted && !receipt.peek()) {
        return;
      }
      epoch++;
      draft.value = null;
      proposal.value = null;
      intent.value = null;
      message.value = null;
      receipt.value = null;
      proposalUncertain.value = false;
      persist();
    },
    async propose() {
      if (!canPropose()) return;
      const original = structuredClone(draft.peek()!);
      const attempt = ++epoch;
      busy.value = true;
      message.value = null;
      proposalUncertain.value = false;
      try {
        const result = await options.api.propose({
          expectedVersion: original.baseVersion,
          path: original.path,
          text: original.text,
          reason: original.reason,
        });
        if (!matches() || epoch !== attempt) return;
        if (
          result.caseId !== staticScope.caseId ||
          result.baseVersion !== original.baseVersion ||
          result.diff.length !== 1 || result.diff[0].path !== original.path ||
          result.diff[0].before !== original.before ||
          result.diff[0].after !== original.text
        ) {
          throw new RequestSourceApiError(
            "The source changed or the proposal differs from the draft.",
            409,
            "SOURCE_CHANGED",
          );
        }
        proposal.value = result;
        intent.value = {
          v: 1,
          ...staticScope,
          baseVersion: original.baseVersion,
          sourceDigest: result.sourceDigest,
          proposalId: result.id,
          commandId: result.id,
          acceptAttempted: false,
        };
        persist();
      } catch (error) {
        if (!matches() || epoch !== attempt) return;
        proposalUncertain.value = true;
        message.value =
          error instanceof RequestSourceApiError && error.status === 409
            ? "The source changed or the proposal differs from your draft. Your draft is kept. No publication is confirmed; open the current source and review before trying again."
            : "The proposal could not be confirmed. Your draft is kept. No publication is confirmed; this request will not retry itself.";
        if (isRequestSourceSessionFailure(error)) options.onUnauthorized?.();
      } finally {
        if (matches() && epoch === attempt) busy.value = false;
      }
    },
    async accept() {
      if (!canAccept()) return;
      const original = structuredClone(intent.peek()!);
      const attempt = ++epoch;
      intent.value = { ...original, acceptAttempted: true };
      if (!persist()) {
        intent.value = original;
        message.value =
          "This browser could not save the approval identity. No approval was sent. Enable session storage before publishing.";
        return;
      }
      busy.value = true;
      message.value = null;
      resumeAbsent.value = false;
      try {
        await options.api.accept(original.proposalId);
        if (!matches() || epoch !== attempt) return;
        busy.value = false;
        await resume();
      } catch (error) {
        if (!matches() || epoch !== attempt) return;
        message.value =
          "Approval may have been recorded. Resume the same command; do not create another proposal.";
        if (isRequestSourceSessionFailure(error)) options.onUnauthorized?.();
      } finally {
        if (matches() && epoch === attempt) busy.value = false;
      }
    },
    resume,
    dispose() {
      disposed = true;
      epoch++;
    },
  };
}
export type RequestSourceEditor = ReturnType<typeof createRequestSourceEditor>;
