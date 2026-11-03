import { replaceGlobals } from "../../test/support/globals.ts";
import { doesNotMatch, equal, match } from "node:assert/strict";
import {
  requestDetailsPath,
  RequestOperatorDetails,
} from "./RequestOperatorDetails.tsx";
import { act } from "preact/test-utils";
import type { VNode } from "preact";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { press } from "../../test/support/press.ts";
import type { RequestOperatorDetailsSnapshot } from "../../../src/application/work/request-spaces/operator-details-view.ts";
import { parseModelRevisionId } from "../../../src/domain/shared-kernel/revision-id.ts";

Deno.test("Request details path keeps exact Case and operator identities", () => {
  equal(
    requestDetailsPath("case/a", "native:owner"),
    "/api/request-cases/case%2Fa/operators/native%3Aowner",
  );
});

Deno.test("Request details synchronously fence session replacements and conversation revisions at the same model pin", async () => {
  const version = parseModelRevisionId(`commit:${"c".repeat(40)}`);
  const props = {
    caseId: "case-a",
    operatorId: "native:owner",
    expectedModelDigest: "d".repeat(64),
    expectedVersion: version,
    sessionReady: false,
    sessionGeneration: 0,
    conversationRevision: 1,
  };
  const snapshot = (
    name: string,
    loaded: boolean,
  ): RequestOperatorDetailsSnapshot => ({
    caseId: props.caseId,
    operatorId: props.operatorId,
    executionSpaceId: "space-a",
    observedSource: {
      source: { repositoryId: "repo", version },
      modelDigest: props.expectedModelDigest,
      sourceAdmission: { revision: 1, manifestDigest: "b".repeat(64) },
      adoption: null,
    },
    runtimeRevision: 4,
    tools: [],
    skills: {
      status: "available",
      revision: loaded ? 1 : 2,
      items: [{
        id: "skill",
        name,
        description: "Installed",
        digest: "e".repeat(64),
        loaded,
      }],
    },
  });
  const pending: Array<
    { resolve(response: Response): void; signal?: AbortSignal | null }
  > = [];
  // Deliberately ignore abort: a late response must still be fenced by the component.
  const restoreFetch = replaceGlobals({
    fetch: (_input, options) =>
      new Promise<Response>((resolve) =>
        pending.push({ resolve, signal: options?.signal })
      ),
  });
  const root = probeRoot();
  let node!: VNode;
  const frames: string[] = [];
  function Probe(current: typeof props) {
    node = RequestOperatorDetails(current);
    frames.push(press(node).html);
    return null;
  }
  const release = async (index: number, name: string, loaded = true) => {
    await act(async () => {
      pending[index].resolve(Response.json(snapshot(name, loaded)));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    await root.show(Probe, props);
    equal(pending.length, 0);
    match(press(node).html, /Connect to view tools and skills/);
    await root.show(Probe, { ...props, sessionReady: true });
    equal(pending.length, 1);
    await release(0, "Session zero private skill");
    match(press(node).html, /Session zero private skill/);
    doesNotMatch(press(node).html, />loaded</);

    let before = frames.length;
    await root.show(Probe, {
      ...props,
      sessionReady: true,
      sessionGeneration: 1,
    });
    doesNotMatch(
      frames[before],
      /Session zero private skill|Open exact source/,
    );
    equal(pending.length, 2);
    equal(pending[0].signal?.aborted, true);
    before = frames.length;
    await root.show(Probe, {
      ...props,
      sessionReady: true,
      sessionGeneration: 2,
    });
    doesNotMatch(frames[before], /Session zero private skill/);
    equal(pending.length, 3);
    equal(pending[1].signal?.aborted, true);
    await release(1, "Late replaced-session private skill");
    doesNotMatch(
      press(node).html,
      /Late replaced-session private skill|Session zero private skill/,
    );
    await release(2, "Current session private skill");
    match(press(node).html, /Current session private skill/);

    before = frames.length;
    await root.show(Probe, {
      ...props,
      sessionReady: true,
      sessionGeneration: 2,
      conversationRevision: 2,
    });
    doesNotMatch(frames[before], /Current session private skill/);
    equal(pending.length, 4);
    await release(3, "Updated installed skill", false);
    match(press(node).html, /Updated installed skill/);
    doesNotMatch(press(node).html, /is-active|Current session private skill/);

    await root.show(Probe, {
      ...props,
      sessionReady: true,
      sessionGeneration: 2,
      conversationRevision: 3,
    });
    equal(pending.length, 5);
    before = frames.length;
    await root.show(Probe, {
      ...props,
      sessionReady: false,
      sessionGeneration: 3,
      conversationRevision: 3,
    });
    doesNotMatch(frames[before], /Updated installed skill|Open exact source/);
    equal(pending.length, 5);
    equal(pending[4].signal?.aborted, true);
    await release(4, "Late revoked-session private skill");
    doesNotMatch(
      press(node).html,
      /Late revoked-session private skill|Updated installed skill/,
    );
    match(press(node).html, /Connect to view tools and skills/);
  } finally {
    restoreFetch();
    await root.restore();
  }
});

Deno.test("mounted Request details refresh same-pin catalogues and revocations, reject malformed success and fence delayed scope", async () => {
  const version = parseModelRevisionId(`commit:${"c".repeat(40)}`);
  const props = {
    caseId: "case-a",
    operatorId: "native:owner",
    expectedModelDigest: "d".repeat(64),
    expectedVersion: version,
    sessionReady: true,
    sessionGeneration: 1,
    conversationRevision: 1,
  };
  const snapshot = (
    name: string,
    loaded = true,
    caseId = "case-a",
  ): RequestOperatorDetailsSnapshot => ({
    caseId,
    executionSpaceId: caseId === "case-a" ? "space-a" : "space-b",
    operatorId: props.operatorId,
    observedSource: {
      source: { repositoryId: "repo", version },
      modelDigest: props.expectedModelDigest,
      sourceAdmission: { revision: 1, manifestDigest: "b".repeat(64) },
      adoption: null,
    },
    runtimeRevision: 4,
    tools: [],
    skills: {
      status: "available",
      revision: loaded ? 1 : 2,
      items: [{
        id: "skill",
        name,
        description: "Installed",
        digest: "e".repeat(64),
        loaded,
      }],
    },
  });
  const pending: Array<
    { resolve(response: Response): void; signal?: AbortSignal | null }
  > = [];
  let interval = () => {},
    visibility = () => {},
    visible = true,
    removed = 0,
    stopped = 0;
  const restoreGlobals = replaceGlobals({
    fetch: (_input, options) =>
      new Promise<Response>((resolve) =>
        pending.push({ resolve, signal: options?.signal })
      ),
    setInterval: (callback: () => void, milliseconds: number) => {
      equal(milliseconds, 15_000);
      interval = callback;
      return 123;
    },
    clearInterval: () => {
      stopped++;
    },
  });
  const root = probeRoot(), listeners = root.windowListeners();
  Object.defineProperties(document, {
    visibilityState: {
      configurable: true,
      get: () => visible ? "visible" : "hidden",
    },
    addEventListener: {
      configurable: true,
      value: (_event: string, callback: () => void) => {
        visibility = callback;
      },
    },
    removeEventListener: {
      configurable: true,
      value: () => {
        removed++;
      },
    },
  });
  let node!: VNode;
  function Probe(current: typeof props) {
    node = RequestOperatorDetails(current);
    return null;
  }
  const focus = () => {
    for (const entry of listeners.filter((entry) => entry.type === "focus")) {
      entry.listener({});
    }
  };
  const release = async (index: number, response: Response) => {
    await act(async () => {
      pending[index].resolve(response);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    await root.show(Probe, props);
    equal(pending.length, 1);
    await act(() => {
      interval();
      focus();
      visibility();
    });
    equal(pending.length, 1);
    equal(pending[0].signal?.aborted, false);
    await release(0, Response.json(snapshot("Original private skill")));
    match(press(node).html, /Original private skill/);
    doesNotMatch(
      press(node).html,
      /<button|Read again|Open exact source|comparison|Retained dependencies|Retained source/,
    );
    await act(() => interval());
    equal(pending.length, 2);
    match(press(node).html, /Original private skill/);
    await act(() => {
      interval();
      focus();
    });
    equal(pending.length, 2);
    equal(pending[1].signal?.aborted, false);
    await release(1, Response.json(snapshot("Updated private skill", false)));
    match(press(node).html, /Updated private skill/);
    doesNotMatch(press(node).html, /is-active/);
    visible = false;
    await act(() => {
      interval();
      focus();
      visibility();
    });
    equal(pending.length, 2);
    visible = true;
    await act(() => visibility());
    equal(pending.length, 3);
    match(press(node).html, /Updated private skill/);
    await release(2, Response.json({ error: "revoked" }, { status: 403 }));
    match(press(node).html, /Tools and skills are unavailable/);
    doesNotMatch(press(node).html, /Updated private skill/);
    doesNotMatch(
      press(node).html,
      /<button|Read again|Open exact source|comparison/,
    );
    await act(() => focus());
    equal(pending.length, 4);
    await release(
      3,
      Response.json({
        ...snapshot("Malformed private skill"),
        skills: { status: "available", revision: 1 },
      }),
    );
    match(press(node).html, /Tools and skills are unavailable/);
    doesNotMatch(press(node).html, /Malformed private skill/);
    await act(() => focus());
    equal(pending.length, 5);
    await root.show(Probe, { ...props, caseId: "case-b" });
    equal(pending.length, 6);
    equal(pending[4].signal?.aborted, true);
    await release(
      5,
      Response.json(snapshot("Case B private skill", true, "case-b")),
    );
    match(press(node).html, /Case B private skill/);
    await release(4, Response.json(snapshot("Late Case A private skill")));
    match(press(node).html, /Case B private skill/);
    doesNotMatch(press(node).html, /Late Case A private skill/);
  } finally {
    await root.restore();
    restoreGlobals();
  }
  equal(stopped, 2);
  equal(removed, 2);
  equal(listeners.filter((entry) => entry.type === "focus").length, 0);
});
