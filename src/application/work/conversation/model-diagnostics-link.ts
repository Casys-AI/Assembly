import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import type { ChatContext } from "./chat-context.ts";

/** Host navigation metadata, never a claim that a report is available or a grant
 * to read it. The destination retains its normal exact-source/access checks. */
export function modelDiagnosticsView(
  version: unknown,
  caseId?: string,
): ChatContext["modelDiagnosticsView"] {
  if (typeof version !== "string") return undefined;
  try {
    parseModelRevisionId(version);
  } catch {
    return undefined;
  }
  // Legacy runtime Case identities contain colons. Preserve them as scope,
  // rather than silently dropping them and opening Main on a failed read.
  if (caseId !== undefined && !/^[A-Za-z0-9_:-]{1,128}$/.test(caseId)) {
    return undefined;
  }
  const query = new URLSearchParams({ page: "diagnostics", version });
  if (caseId !== undefined) query.set("caseBranch", caseId);
  return { version, href: `/system?${query}` };
}

/** Consultations carry the consulted source under result.version. The outer
 * modelVersion is the admitted execution pin and must not select this screen. */
export function withModelDiagnosticsView(
  response: unknown,
  requestedVersion: unknown,
  caseId?: string,
): unknown {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return response;
  }
  const envelope = response as Record<string, unknown>;
  const result = envelope.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return response;
  }
  const version = (result as Record<string, unknown>).version;
  if (version !== requestedVersion) return response;
  const view = modelDiagnosticsView(version, caseId);
  return view ? { ...envelope, modelDiagnosticsView: view } : response;
}
