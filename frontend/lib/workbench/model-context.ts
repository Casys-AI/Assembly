import { modelPageOf } from "./desk.ts";
import { sysmlLocation } from "../model/diagrams/location.ts";
import { synchronizeRevisionLocation } from "../model/revisions/api.ts";
import { placeOfPath, versionOf, viewHref } from "./view-location.ts";

/** Conversation selection is navigation state, never evidence of a branch. */
export interface ModelViewContext {
  caseId: string | null;
  agentId: string | null;
}

export function modelViewContext(
  url: Pick<URL, "searchParams">,
): ModelViewContext {
  return {
    caseId: url.searchParams.get("caseBranch") || null,
    agentId: url.searchParams.get("agent") || null,
  };
}

/** Keep the selected conversation beside either model place, including reload. */
export function withModelViewContext(
  href: string,
  context: ModelViewContext,
): string {
  return viewHref(href, { caseBranch: context.caseId, agent: context.agentId });
}

/** Display state only; a hidden conversation does not alter source identity. */
export function modelConversationHidden(
  url: Pick<URL, "searchParams">,
): boolean {
  return url.searchParams.get("conversation") === "hidden";
}

/** Global Main can be selected without changing the displayed Case source. */
export function modelShowsGlobalMain(url: Pick<URL, "searchParams">): boolean {
  return url.searchParams.get("conversation") === "main";
}

/** Entering from a full conversation opens split; page-to-page keeps its mode. */
export function modelPlaceConversationHref(
  href: string,
  hidden: boolean,
  globalMain = false,
): string {
  return viewHref(href, {
    conversation: hidden ? "hidden" : globalMain ? "main" : null,
  });
}

/** Dock conversation transitions while a System/Model page is open. */
export function modelConversationHref(
  href: string,
  current: ModelViewContext,
  target: ModelViewContext,
  fullConversationHref: string,
): string {
  const url = new URL(href, "http://view.invalid");
  if (current.caseId && target.caseId === null) {
    return viewHref(href, {
      conversation: modelShowsGlobalMain(url) ? "hidden" : "main",
    });
  }
  if (
    current.caseId && current.caseId === target.caseId &&
    modelShowsGlobalMain(url)
  ) {
    return viewHref(href, { conversation: null });
  }
  if (
    modelConversationHidden(url) && target.caseId &&
    current.caseId !== target.caseId
  ) {
    return switchModelViewContext(href, target);
  }
  if (modelConversationHidden(url)) return fullConversationHref;
  if (current.caseId === target.caseId) {
    return viewHref(href, { conversation: "hidden" });
  }
  return switchModelViewContext(href, target);
}

/** A Case reference needs a real scoped reader. Never infer a Git branch ID. */
export function unavailableModelScope(search: URLSearchParams): boolean {
  return search.has("caseBranch") ||
    (search.has("branch") && search.get("branch") !== "main");
}

/** Change the conversation context, keeping the right-hand page, not its inspection. */
export function switchModelViewContext(
  href: string,
  context: ModelViewContext,
): string {
  return withModelViewContext(
    viewHref(href, {
      branch: null,
      version: null,
      modelVersion: null,
      revision: null,
      commit: null,
      proposal: null,
      select: null,
      flow: null,
      file: null,
      line: null,
      create: null,
    }),
    context,
  );
}

/** Leave a source inspection without changing its conversation or source scope. */
export function currentContextModelHref(
  url: Pick<URL, "pathname" | "search">,
): string {
  return viewHref(url.pathname + url.search, {
    version: null,
    modelVersion: null,
    revision: null,
    commit: null,
    proposal: null,
    create: null,
  });
}

/** Scope on a plain page link: no Case, runtime or conversation mutation. */
export function inheritModelViewContext(href: string, search: string): string {
  const url = new URL(href, "http://view.invalid");
  const scope = new URLSearchParams(search);
  if (
    placeOfPath(url.pathname) !== "model" &&
    placeOfPath(url.pathname) !== "system"
  ) {
    return href;
  }
  return viewHref(href, {
    caseBranch: scope.get("caseBranch"),
    branch: scope.get("branch"),
    agent: scope.get("agent"),
    conversation: ["hidden", "main"].includes(scope.get("conversation") ?? "")
      ? scope.get("conversation")
      : null,
  });
}

/** Reopening a place keeps its inspection only when its conversation is unchanged. */
export function reopenModelViewContext(
  href: string,
  context: ModelViewContext,
): string {
  const previous = modelViewContext(new URL(href, "http://view.invalid"));
  return previous.caseId === context.caseId &&
      previous.agentId === context.agentId
    ? withModelViewContext(href, context)
    : switchModelViewContext(href, context);
}

/** Only call a parameter an inspection when the mounted page recognizes it. */
export function modelInspectionVersion(
  url: Pick<URL, "pathname" | "searchParams">,
): string | null {
  const place = placeOfPath(url.pathname);
  const version = versionOf(url);
  if (place === "system") return version;
  if (place !== "model") return null;
  const page = modelPageOf(url);
  const search = `?${url.searchParams}`;
  if (page === "sysml") return sysmlLocation(search).version ?? null;
  // Numeric execution history uses its existing, separate source selector.
  if (page === "graph") return url.searchParams.get("modelVersion") || null;
  if (page === "revisions" && !version) {
    const selected = synchronizeRevisionLocation({}, {
      pathname: url.pathname,
      search,
    }).inspection.selection;
    return selected?.kind === "commit" ? selected.id : null;
  }
  // Files/Releases read `version`; Activity/Revisions explicitly refuse it.
  // Other aliases on those pages are ignored by their existing readers.
  return version;
}
