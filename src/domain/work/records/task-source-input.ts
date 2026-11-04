/** Bounded task data captured by the host from an actual human message.
 * These references confer no network or mandate rights. Never accept them from
 * provider JSON; validate them against the original host journal on each call. */
export interface TaskSourceInput {
  kind: "human-selected-urls";
  rootRequestId: string;
  source: {
    operatorId: string;
    conversationId: string;
    designerScopeId: string;
    messageId: string;
    messageDigest: string;
    /** Exact host continuation receipt that selected these URLs, when replaced. */
    resumeId?: string;
  };
  urls: string[];
}
export type TaskSourceInputCapture = Omit<TaskSourceInput, "rootRequestId">;
export const MAX_TASK_SOURCE_URLS = 20;
export const MAX_TASK_SOURCE_URL_CHARACTERS = 2_048;

/** Shared exact normalization preserves paths and query parameters. */
export function normalizeTaskSourceUrl(raw: string): string {
  let value = raw.trim().replace(/^[\[(<{]+/, "").replace(/[\])>},;!?]+$/, "");
  if (!value) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:[/?#][^\s<>"']*)?$/i
        .test(value)
    ) return "";
    value = `https://${value}`;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== "443")
    ) return "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}
export function taskSourceUrls(text: string): string[] {
  return [
    ...new Set(
      text.split(/\s+/).map(normalizeTaskSourceUrl).filter((url) =>
        !!url && url.length <= MAX_TASK_SOURCE_URL_CHARACTERS
      ),
    ),
  ].slice(0, MAX_TASK_SOURCE_URLS);
}
export function validTaskSourceInputs(
  value: unknown,
  rootRequestId: string,
): value is TaskSourceInput[] {
  if (!Array.isArray(value) || value.length > 1) return false;
  const identity = (v: unknown) =>
    typeof v === "string" && v.length > 0 && v.length <= 512 && !/\s/.test(v);
  return value.every((input: TaskSourceInput) =>
    input?.kind === "human-selected-urls" &&
    input.rootRequestId === rootRequestId && identity(input.rootRequestId) &&
    !!input.source &&
    [
      input.source.operatorId,
      input.source.conversationId,
      input.source.designerScopeId,
      input.source.messageId,
    ].every(identity) && /^[a-f0-9]{64}$/.test(input.source.messageDigest) &&
    (input.source.resumeId === undefined ||
      /^[^\s]{1,128}$/.test(input.source.resumeId)) &&
    Array.isArray(input.urls) && input.urls.length > 0 &&
    input.urls.length <= MAX_TASK_SOURCE_URLS &&
    new Set(input.urls).size === input.urls.length && input.urls.every((url) =>
      typeof url === "string" && url.length <= MAX_TASK_SOURCE_URL_CHARACTERS &&
      normalizeTaskSourceUrl(url) === url
    )
  );
}
