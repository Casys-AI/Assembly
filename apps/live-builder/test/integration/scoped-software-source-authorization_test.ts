/** Real Toolkit authority witness. S and R are independently compiled native
 * sources; this test exercises the production source authorizer, not its port
 * double. Its Git repository is an isolated temporary fixture. */
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  nativeEvolutionMain,
  nativeEvolutionSources,
} from "../fixtures/native-evolution.ts";
import { nativeId } from "../fixtures/model-edit-mandate.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { resolveModelEdits } from "../../src/adapters/model/sources/editing/tooling.ts";
import { validateSourceExecutable } from "../../src/adapters/model/sources/source-model.ts";
import { buildEvolutionPolicyEdits } from "../support/evolution-policy/writer.ts";
import { NativeEvolutionSourceAssessment } from "../../src/adapters/model/evolution/assessment.ts";
import { NativeModelSourceAuthorization } from "../../src/adapters/governance/model-access/source-authorization.ts";
import { recipeDigest } from "../../src/domain/model/value-objects/build.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";

Deno.test({
  name:
    "scoped source authorization uses executed R grants when admitted source S differs",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const repositoryId = "12345678-1234-4234-8234-123456789abc";
    const projectId = `git:${repositoryId}`;
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const initial = {
      ...await compiler.compile(await nativeEvolutionSources()),
      version: `commit:${"1".repeat(40)}`,
    };
    const initialModel = await validateSourceExecutable(
      initial,
      projectId,
      nativeEvolutionMain,
    );
    const policyEdits = buildEvolutionPolicyEdits(
      initial,
      initialModel.identity,
      {
        id: "scoped-authority-test",
        expectedRevision: 0,
        grants: [{
          act: "prepare",
          targetNativeId: initialModel.identity.builderId,
          category: "instructions",
          bounds: { maxCharacters: 4096 },
        }],
      },
    );
    const withGrant = await tooling.edit(initial.sources, policyEdits);
    const directory = await Deno.makeTempDir({
      prefix: "scoped-native-source-authority-",
    });
    try {
      const repository = await GitModelRepository.open({
        projectDir: directory,
        repositoryId,
        compiler,
      });
      const r = await repository.initialize(withGrant.sources);
      const actorR = await validateSourceExecutable(
        r,
        projectId,
        nativeEvolutionMain,
      );
      assert(actorR.modelEditPolicy?.operations.includes("set-value"));
      const sourceOperations = JSON.stringify(
        JSON.stringify([
          "set-value",
          "rename",
          "insert-member",
          "remove",
          "set-type",
          "retarget-reference",
        ]),
      );
      const deniedOperations = JSON.stringify(
        JSON.stringify([
          "rename",
          "insert-member",
          "remove",
          "set-type",
          "retarget-reference",
        ]),
      );
      const configuration = r.sources["configuration.sysml"]!;
      assert(configuration.includes(sourceOperations));
      const proposal = await repository.propose({
        baseVersion: r.version,
        sources: {
          ...r.sources,
          "configuration.sysml": configuration.replace(
            sourceOperations,
            deniedOperations,
          ),
        },
        author: "local-owner",
        reason: "Source mandate differs from retained runtime",
      });
      const s = await repository.accept({
        id: proposal.id,
        expectedVersion: r.version,
        author: "local-owner",
      });
      assert.notEqual(s.version, r.version);
      assert.equal(
        (await repository.at(r.version)).sourceDigest,
        r.sourceDigest,
      );
      const actorS = await validateSourceExecutable(
        s,
        projectId,
        nativeEvolutionMain,
      );
      assert(!actorS.modelEditPolicy?.operations.includes("set-value"));
      assert.notDeepEqual(actorS.modelEditPolicy, actorR.modelEditPolicy);
      const edits = [{
        kind: "set-value" as const,
        elementId: nativeId(s, `${nativeEvolutionMain}::operatorInstruction`),
        expression: JSON.stringify(
          "Instruction authorized by the retained execution mandate.",
        ),
      }];
      const result = await tooling.edit(s.sources, resolveModelEdits(s, edits));
      const after = await compiler.compile(result.sources);
      const typedEdits = {
        baseVersion: s.version,
        sourceDigest: s.sourceDigest,
        reason: "Scoped native authorization regression",
        edits,
      };
      const assessed = await new NativeEvolutionSourceAssessment({
        projectId,
        admittedActor: () => Promise.resolve(actorR),
        validateSettings: () => Promise.resolve(),
      }).authorizePreparation({
        before: s,
        after,
        actorId: actorR.identity.builderId,
        recipeDigest: await recipeDigest(await compiler.recipe()),
        typedEdits,
      });
      const input = {
        authority: s,
        before: s,
        after,
        authorization: assessed.authorization,
        author: `agent:${actorR.identity.builderId}`,
        phase: "proposal" as const,
      };
      const authorizer = new NativeModelSourceAuthorization(projectId, tooling);
      // Legacy Main validation resolves S and therefore cannot substitute for the
      // explicit software Request path; actual R admits the exact same edit.
      await assert.rejects(() => authorizer.validate(input));
      await authorizer.validateScopedSoftware(input, actorR);
      await assert.rejects(() =>
        authorizer.validateScopedSoftware(input, actorS)
      );
      const revoked = structuredClone(actorR);
      revoked.modelEditPolicy!.operations = revoked.modelEditPolicy!.operations
        .filter((operation) => operation !== "set-value");
      await assert.rejects(() =>
        authorizer.validateScopedSoftware(input, revoked)
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
