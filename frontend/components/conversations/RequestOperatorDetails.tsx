import { useEffect, useRef, useState } from "preact/hooks";
import type { RequestOperatorDetailsSnapshot } from "../../../src/application/work/request-spaces/operator-details-view.ts";
import { parseRequestOperatorDetails } from "../../lib/requests/operator-details/api.ts";
import {
  requestDetailsVisible,
  watchRequestOperatorDetailsFreshness,
} from "../../lib/requests/operator-details/freshness.ts";
import { canonical } from "../../../src/domain/primitives/canonical-json.ts";
import { AgentSkills } from "./AgentDetails.tsx";

export function requestDetailsPath(caseId: string, operatorId: string) {
  return `/api/request-cases/${encodeURIComponent(caseId)}/operators/${
    encodeURIComponent(operatorId)
  }`;
}

/** Metadata for the selected Request; reading never changes its tools or skills. */
export function RequestOperatorDetails(
  {
    caseId,
    operatorId,
    expectedModelDigest,
    expectedVersion,
    sessionReady,
    sessionGeneration,
    conversationRevision,
  }: {
    caseId: string;
    operatorId: string;
    expectedModelDigest: string;
    expectedVersion?: string;
    sessionReady: boolean;
    sessionGeneration: number;
    conversationRevision: number;
  },
) {
  const [read, setRead] = useState<
    { key: string; snapshot: RequestOperatorDetailsSnapshot } | null
  >(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const key = canonical([
    caseId,
    operatorId,
    expectedModelDigest,
    expectedVersion,
    sessionReady,
    sessionGeneration,
    conversationRevision,
  ]);
  const activeKey = useRef(key);
  activeKey.current = key;
  useEffect(() => {
    let active = true, pending = false;
    let controller: AbortController | null = null;
    let executionSpaceId: string | undefined;
    const refresh = () => {
      if (
        !active || !sessionReady || activeKey.current !== key || pending ||
        !requestDetailsVisible()
      ) return;
      pending = true;
      controller = new AbortController();
      const signal = controller.signal;
      setErrorKey(null);
      void fetch(`${requestDetailsPath(caseId, operatorId)}/details`, {
        cache: "no-store",
        signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("unavailable");
          const snapshot = parseRequestOperatorDetails(await response.json(), {
            caseId,
            operatorId,
            modelDigest: expectedModelDigest,
            version: expectedVersion,
            executionSpaceId,
          });
          if (active && !signal.aborted && activeKey.current === key) {
            executionSpaceId = snapshot.executionSpaceId;
            setRead({ key, snapshot });
          }
        }).catch(() => {
          if (active && !signal.aborted && activeKey.current === key) {
            setRead(null);
            setErrorKey(key);
          }
        }).finally(() => {
          pending = false;
        });
    };
    setRead(null);
    setErrorKey(null);
    const stop = sessionReady
      ? watchRequestOperatorDetailsFreshness(refresh, () => pending)
      : () => {};
    refresh();
    return () => {
      active = false;
      controller?.abort();
      stop();
    };
  }, [key]);
  const snapshot = sessionReady && read?.key === key ? read.snapshot : null;
  if (!snapshot) {
    return (
      <section class="agent-panel-section">
        <h3>Tools and skills</h3>
        <p role="status">
          {!sessionReady
            ? "Connect to view tools and skills."
            : errorKey === key
            ? "Tools and skills are unavailable."
            : "Loading tools and skills…"}
        </p>
      </section>
    );
  }
  return (
    <>
      <section class="agent-panel-section">
        <h3>Tools</h3>
        {snapshot.tools.length
          ? (
            <ul class="agent-context-tools">
              {snapshot.tools.map((tool) => (
                <li
                  key={tool.id}
                  class="agent-context-tool"
                  data-tool-id={tool.id}
                >
                  <div class="agent-context-tool-head">
                    <code>{tool.name}</code>
                  </div>
                  <p>{tool.description}</p>
                </li>
              ))}
            </ul>
          )
          : <p class="agent-context-empty">None</p>}
      </section>
      <section class="agent-panel-section">
        <h3>Skills</h3>
        {snapshot.skills.status === "available"
          ? <AgentSkills skills={snapshot.skills.items} empty="None" />
          : <p role="status">Skills are unavailable.</p>}
      </section>
    </>
  );
}
