import { useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  caseModelFetch,
  type CaseModelScope,
  caseSourceMetadataRevision,
  readCaseModelScope,
} from "../../lib/case-model-scope.ts";
import { type ModelLive, silentModelLive } from "../../lib/model/live.ts";
import { RequestInstructionAdoption } from "./RequestInstructionAdoption.tsx";
import { ModelLinkContext } from "./ModelContextLink.tsx";
import { useModelLive } from "./useModelLive.ts";

/**
 * Resolve again on each Case or inspection change; never render the previous
 * Case's model while the next lookup is in flight. The Case's own word on its
 * model (`live`, from the workbench's one connection) resolves it again in
 * place: what is shown stays until the new scope arrives. Without a version
 * asked, the pages read the Case's head and follow `live` themselves, as the
 * main pages follow the host's `model-version`; a version asked stays fixed.
 */
export function CaseModelBoundary(
  props: {
    caseId: string;
    search: string;
    version?: string;
    sessionReady?: boolean;
    sessionGeneration?: number;
    /** The Case's own word on its model; none tells nothing. */
    live?: ModelLive;
    onAdopted?(caseId: string): void;
    render(
      scope: CaseModelScope,
      request: typeof fetch,
      search: string,
    ): ComponentChildren;
  },
) {
  const request = useMemo(() => caseModelFetch(props.caseId), [props.caseId]);
  const result = useCaseModelScope(
    props.caseId,
    props.version,
    props.sessionReady,
    props.sessionGeneration,
    props.live,
  );
  if (result.status === "loading") {
    return <p role="status">Reading the Request model…</p>;
  }
  if (result.status === "unavailable") {
    return (
      <p class="proposal-error" role="alert">
        This Request model or inspected version is unavailable.
      </p>
    );
  }
  const scope = result.scope;
  const params = new URLSearchParams(props.search);
  // An inspected version is a fixed commit; without one, descendant readers
  // read the Case's head. Every network read still passes through the
  // server's Case resolution and version authorization.
  if (props.version) params.set("version", scope.version);
  else params.delete("version");
  params.delete("modelVersion");
  const search = `?${params}`;
  return (
    <ModelLinkContext.Provider value={props.search}>
      <CaseModelStatus scope={scope} />
      <RequestInstructionAdoption
        key={JSON.stringify([
          scope.caseId,
          scope.branchId,
          scope.executionSpaceId,
          scope.version,
          scope.branchVersion,
          scope.executionVersion,
          props.sessionReady,
          props.sessionGeneration,
        ])}
        scope={scope}
        sessionReady={props.sessionReady === true}
        onAdopted={props.onAdopted}
      />
      {props.render(scope, request, search)}
    </ModelLinkContext.Provider>
  );
}

/** The admitted source and executing model are separate Request facts. */
export function CaseModelStatus({ scope }: { scope: CaseModelScope }) {
  const inspectedDiffers = scope.version !== scope.executionVersion;
  const admittedDiffers = scope.branchVersion !== scope.executionVersion;
  if (!inspectedDiffers && !admittedDiffers) return null;
  return (
    <p role="status">
      {inspectedDiffers &&
        "The inspected version differs from the running version."}
      {inspectedDiffers && admittedDiffers && " "}
      {admittedDiffers &&
        "The admitted source differs from the running version."}
    </p>
  );
}

/**
 * A stale response cannot resolve a newer Case or inspected version. Another
 * Case, version or session starts over; the same one read again (its metadata
 * changed, or its `live` moved) keeps the scope it resolved until the answer.
 */
export function useCaseModelScope(
  caseId: string,
  version?: string,
  sessionReady = false,
  sessionGeneration = 0,
  live: ModelLive = silentModelLive,
):
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; scope: CaseModelScope } {
  const [moves, setMoves] = useState(0);
  useModelLive(() => setMoves((count) => count + 1), live);
  const identity = JSON.stringify([
    caseId,
    version ?? null,
    sessionReady,
    sessionGeneration,
  ]);
  const key = JSON.stringify([
    identity,
    caseSourceMetadataRevision(caseId),
    moves,
  ]);
  const [result, setResult] = useState<
    { identity: string; key: string; scope?: CaseModelScope }
  >({ identity: "", key: "" });
  useEffect(() => {
    let active = true;
    readCaseModelScope(caseId, version).then(
      (scope) => {
        if (active) setResult({ identity, key, scope });
      },
      () => {
        if (active) setResult({ identity, key });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  if (result.identity !== identity) return { status: "loading" };
  return result.scope
    ? { status: "ready", scope: result.scope }
    : { status: "unavailable" };
}
