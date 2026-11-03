import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { equal } from "node:assert/strict";
import { WorkArtifactObservationBehavior } from "../../src/application/work/behaviors/artifact-observation.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { validateSourceExecutable } from "../../src/adapters/model/sources/source-model.ts";
import { operatorWorkFingerprint } from "../../src/application/work/operators/journal.ts";
import type { ModelPort } from "../../src/application/work/runtime/ports.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import {
  compareWorkResult,
  type WorkResultObservation,
} from "../../src/domain/work/policies/verified-effect-closure.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import { publishedArtifact } from "../support/tool-artifact-fixture.ts";
import { verifiedWorkSources } from "../support/verified-work-fixture.ts";
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
Deno.test({
  name: "real native predicate accepts fact reader with large model provenance",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(await verifiedWorkSources());
    const caller = await validateSourceExecutable({
      ...compiled,
      version: "test",
    }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
    const contract = caller.workResultContracts![0]!;
    const behavior = caller.behaviors!.find((b) =>
      b.id === contract.observationBehaviorId
    )!;
    const work = caller.behaviors!.find((b) =>
      b.id === contract.workBehaviorId
    )!;
    const artifact = await publishedArtifact();
    artifact.candidate.name = "reader";
    // Name is material: recompute both technical digests after the fixture rename.
    const { toolDraftDigest } = await import(
      "../../src/application/work/artifacts/catalog.ts"
    );
    artifact.candidate.digest = await toolDraftDigest(artifact.candidate);
    artifact.candidate.admission!.candidateDigest = artifact.candidate.digest;
    artifact.model.catalog[0]!.name = "reader";
    artifact.model.catalog[0]!.digest = artifact.candidate.digest;
    artifact.model.version.sourceIds = Array.from(
      { length: 20 },
      (_, i) => `native-source-${i}-01234567-89ab-cdef-0123-456789abcdef`,
    );
    const owner = artifact.agentId;
    const modelVersion = {
      digest: caller.version.digest,
      repositoryVersion: caller.version.repositoryVersion!,
    };
    const subject = {
      callerId: caller.identity.builderId,
      workInvocationId: "work:one",
      workBehaviorId: work.id,
      workInputDigest: await executionDigest({ text: "objective" }),
      modelVersion,
    };
    const fingerprint = operatorWorkFingerprint(
      owner,
      "objective",
      subject.workInvocationId,
      {
        callerId: subject.callerId,
        invocationId: subject.workInvocationId,
        behavior: work,
        modelVersion,
      },
    );
    let state: SystemRuntimeState | null = {
      model: artifact.model.identity,
      executionModel: artifact.model,
      revision: 7,
      messages: [{
        id: "m",
        role: "tool",
        text: "objective",
        at: "",
        work: {
          callerId: subject.callerId,
          correlationId: subject.workInvocationId,
          invocationId: subject.workInvocationId,
          behaviorId: work.id,
          targetNativeId: work.targetNativeId,
          modelVersion,
          fingerprint,
        },
      }],
      events: [{
        id: "e",
        at: "",
        kind: "work",
        label: "",
        work: {
          callerId: subject.callerId,
          correlationId: subject.workInvocationId,
          fingerprint,
          candidateIds: [artifact.candidate.id],
        },
      }],
      candidates: [artifact.candidate],
    } as unknown as SystemRuntimeState;
    const reader = new WorkArtifactObservationBehavior({
      targets: new Map([[behavior.targetNativeId, owner]]),
      workTargets: new Map([[work.targetNativeId, owner]]),
      resolveCallerModel: () => Promise.resolve(caller),
      target: () => ({
        store: { load: () => Promise.resolve(structuredClone(state)) },
        model: {
          ...unexpectedModelAuthoring,
          readExecutableModel: () =>
            Promise.resolve(structuredClone(artifact.model)),
        } as unknown as ModelPort,
      }),
    });
    const request = {
      behavior,
      callerId: subject.callerId,
      invocationId: "work:one:observe",
      modelVersion,
      input: {
        workInvocationId: subject.workInvocationId,
        workBehaviorId: work.id,
        workInputDigest: subject.workInputDigest,
        artifactName: "reader",
      },
    };
    const result = (await reader.invoke(request))
      .result as WorkResultObservation;
    equal(result.available, true);
    equal(result.source!.revision.length < 512, true);
    equal(compareWorkResult(contract, result, subject), "verified");
    artifact.model.catalog[0]!.name = "foreign-name";
    equal(
      compareWorkResult(
        contract,
        (await reader.invoke(request)).result,
        subject,
      ),
      "contradicted",
    );
    state = null;
    equal(
      compareWorkResult(
        contract,
        (await reader.invoke(request)).result,
        subject,
      ),
      "unknown",
    );
  },
});
