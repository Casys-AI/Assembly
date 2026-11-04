import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { publishedArtifact } from "../../../../test/support/tool-artifact-fixture.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import {
  type RetainedToolDependencyDescriptor,
  retainedToolResourceId,
} from "../../../domain/work/records/retained-tool-dependencies.ts";
import {
  activeTools,
  resolveActiveTool,
  type RetainedToolsPort,
} from "./active-tools.ts";

Deno.test("the shared resolver keeps retained dependencies distinct from local candidates and never manufactures lifecycle evidence", async () => {
  const { candidate, model } = await publishedArtifact();
  if (!candidate.sourceBinding) throw new Error("Fixture binding missing");
  const state: SystemRuntimeState = {
    id: "case-runtime",
    revision: 0,
    catalogRevision: 0,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "idle",
    provider: "fixture",
  };
  const descriptor: RetainedToolDependencyDescriptor = {
    format: "request-retained-tool/v1",
    target: {
      projectId: "host",
      systemId: "system",
      executionSpaceId: "space-a",
      caseId: "case-a",
      openingId: "opening-a",
      operatorId: model.identity.builderId,
      admissionId: "admission-a",
    },
    openingBaseDigest: "a".repeat(64),
    tool: {
      candidateId: candidate.id,
      digest: candidate.digest,
      sourceBinding: candidate.sourceBinding,
    },
  };
  const { name, description, kind, code } = candidate;
  const dependency = {
    descriptor,
    resourceId: await retainedToolResourceId(descriptor),
    draft: { name, description, kind, code },
  };
  const retained: RetainedToolsPort = {
    list: () => Promise.resolve([structuredClone(dependency)]),
  };
  const before = structuredClone(state);
  for (let attempt = 0; attempt < 2; attempt++) {
    const [result] = await activeTools(state, model, retained);
    equal(result.kind, "retained-dependency");
    deepStrictEqual(result.tool, {
      name,
      description,
      kind,
      code,
      id: candidate.id,
      digest: candidate.digest,
    });
    for (
      const field of ["stage", "tests", "admission", "caseId", "createdAt"]
    ) equal(Object.hasOwn(result.tool, field), false);
    const resolved = await resolveActiveTool(state, model, candidate.id, {
      retainedTools: retained,
    });
    deepStrictEqual(resolved, result);
  }
  deepStrictEqual(state, before);
  await rejects(() =>
    activeTools(state, model, {
      list: () =>
        Promise.resolve([{
          ...dependency,
          resourceId: "retained-tool:v1:" + "0".repeat(64),
        }]),
    })
  );
  await rejects(() =>
    activeTools(state, model, {
      list: () =>
        Promise.resolve([{
          ...dependency,
          draft: { ...dependency.draft, code: code + " " },
        }]),
    })
  );
  const changed = structuredClone(model);
  changed.contracts = [];
  await rejects(() => activeTools(state, changed, retained));
  state.candidates = [structuredClone(candidate)];
  await rejects(() => activeTools(state, model, retained), /differs/);
  equal((await activeTools(state, model))[0].kind, "local-candidate");
});
