/** Real Toolkit, Git and source authorization. No provider or network calls. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import type { SourceModel } from "../../src/adapters/model/sources/source-model.ts";
import {
  MODEL_DELEGATIONS_FILE,
  readModelDelegations,
  renderModelDelegations,
} from "../../src/adapters/governance/model-access/delegation/ledger.ts";
import type { ModelDelegationChange } from "../../src/domain/governance/records/model-delegation-request.ts";
import type { ModelIdentity } from "../../src/domain/work/dialogue.ts";
import {
  delegationSystems,
  openDelegationFixture,
} from "../fixtures/model-delegation.ts";
import { editRequest, nativeId } from "../fixtures/model-edit-mandate.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

Deno.test({
  name:
    "native delegated administration: separate powers, attenuation, source admission and revocation cascade",
  ignore: !toolkitIntegrationEnabled,
  async fn(t) {
    const fixture = await openDelegationFixture(packageDir!);
    const {
      repository,
      primary,
      primaryIdentity,
      peer,
      peerIdentity,
      leaf,
      leafIdentity,
    } = fixture;
    const parentGrant: Extract<ModelDelegationChange, { kind: "grant" }> = {
      kind: "grant",
      id: "root-to-peer",
      targetSystem: delegationSystems.peer,
      operations: ["set-value", "rename"],
      grants: [{ file: "mission.sysml", qualifiedRoots: ["Work::alpha"] }],
      mayEdit: true,
      recipients: [delegationSystems.leaf],
      maxRedelegationDepth: 0,
    };
    const childGrant: Extract<ModelDelegationChange, { kind: "grant" }> = {
      kind: "grant",
      id: "peer-to-leaf",
      targetSystem: delegationSystems.leaf,
      operations: ["set-value"],
      grants: [{
        file: "mission.sysml",
        qualifiedRoots: ["Work::alpha::value"],
      }],
      mayEdit: true,
      recipients: [],
      maxRedelegationDepth: null,
    };
    async function edit(
      model: SourceModel,
      identity: ModelIdentity,
      qualifiedName: string,
      expression: string,
    ) {
      const head = await repository.current();
      const current = await model.readExecutableModel(identity);
      return await model.proposeEdit(
        identity,
        editRequest(head, [{
          kind: "set-value",
          elementId: nativeId(head, qualifiedName),
          expression,
        }]),
        current.version.digest,
      );
    }
    async function unchanged(action: () => Promise<unknown>) {
      const head = await repository.current();
      const proposals = await repository.listProposals();
      await assert.rejects(action);
      assert.equal((await repository.current()).version, head.version);
      assert.deepEqual(await repository.listProposals(), proposals);
    }
    try {
      assert(
        await t.step(
          "administration alone grants no editing and proposal grants no authority",
          async () => {
            const root = await primary.readExecutableModel(primaryIdentity);
            assert(root.modelAdministration);
            assert.equal(root.modelEditPolicy, undefined);
            await unchanged(() =>
              edit(primary, primaryIdentity, "Work::alpha::value", "8")
            );
            const proposal = await fixture.propose(
              primary,
              primaryIdentity,
              parentGrant,
            );
            const record = await repository.proposal(proposal.id);
            assert.equal(record.status, "proposed");
            assert.equal(
              (await peer.readExecutableModel(peerIdentity)).modelEditPolicy,
              undefined,
            );
            await unchanged(() =>
              edit(peer, peerIdentity, "Work::alpha::value", "8")
            );
            const proposed = await repository.at(record.proposalVersion!);
            const forged = readModelDelegations(proposed.sources);
            forged[0]!.operations = ["remove"];
            for (
              const sources of [{
                ...proposed.sources,
                [MODEL_DELEGATIONS_FILE]: renderModelDelegations(forged),
              }, {
                ...proposed.sources,
                "mission.sysml": proposed.sources["mission.sysml"]!.replace(
                  "attribute value : Integer = 1;",
                  "attribute value : Integer = 99;",
                ),
              }]
            ) {
              await unchanged(() =>
                repository.propose({
                  baseVersion: record.baseVersion,
                  sources,
                  author: record.author,
                  reason: "Attempt to exceed the exact administration request",
                  authorization: record.authorization,
                })
              );
            }
            await fixture.accept(proposal.id);
            const admitted = await peer.readExecutableModel(peerIdentity);
            assert(admitted.modelAdministration);
            assert(admitted.modelEditPolicy);
          },
        ),
      );
      assert(
        await t.step(
          "grant rejects wider operation, scope, recipient, depth and self-attribution",
          async () => {
            const forbidden: ModelDelegationChange[] = [
              { ...childGrant, id: "wide-operation", operations: ["remove"] },
              {
                ...childGrant,
                id: "wide-root",
                grants: [{
                  file: "mission.sysml",
                  qualifiedRoots: ["Work::beta"],
                }],
              },
              {
                ...childGrant,
                id: "prefix-confusion",
                grants: [{
                  file: "mission.sysml",
                  qualifiedRoots: ["Work::alpha2"],
                }],
              },
              {
                ...childGrant,
                id: "wrong-file",
                grants: [{
                  file: "configuration.sysml",
                  qualifiedRoots: ["Work::alpha"],
                }],
              },
              {
                ...childGrant,
                id: "unknown-recipient",
                targetSystem: "AssemblyLiveBuilder::unknown",
              },
              {
                ...childGrant,
                id: "self-attribution",
                targetSystem: delegationSystems.root,
              },
              {
                ...childGrant,
                id: "wide-depth",
                recipients: [delegationSystems.peer],
                maxRedelegationDepth: 1,
              },
              {
                ...childGrant,
                id: "wide-recipient-envelope",
                recipients: [delegationSystems.root],
                maxRedelegationDepth: 0,
              },
            ];
            for (const change of forbidden) {
              await unchanged(() =>
                fixture.propose(primary, primaryIdentity, change)
              );
            }
            await unchanged(() =>
              fixture.propose(peer, peerIdentity, {
                ...childGrant,
                id: "depth-zero-cannot-delegate-administration",
                recipients: [delegationSystems.leaf],
                maxRedelegationDepth: 0,
              })
            );
          },
        ),
      );
      assert(
        await t.step(
          "peer exercises its grant and redelegates narrower editing rights",
          async () => {
            const editProposal = await edit(
              peer,
              peerIdentity,
              "Work::alpha::removable",
              "8",
            );
            await fixture.accept(editProposal.id);
            assert.match(
              (await repository.current()).sources["mission.sysml"]!,
              /attribute removable : Integer = 8;/,
            );
            const delegation = await fixture.propose(
              peer,
              peerIdentity,
              childGrant,
            );
            assert.equal(
              (await leaf.readExecutableModel(leafIdentity)).modelEditPolicy,
              undefined,
            );
            await fixture.accept(delegation.id);
            const admitted = await leaf.readExecutableModel(leafIdentity);
            assert(admitted.modelEditPolicy);
            assert.equal(admitted.modelAdministration, undefined);
            const leafEdit = await edit(
              leaf,
              leafIdentity,
              "Work::alpha::value",
              "17",
            );
            await fixture.accept(leafEdit.id);
            assert.match(
              (await repository.current()).sources["mission.sysml"]!,
              /attribute value : Integer = 17;/,
            );
            await unchanged(() =>
              edit(leaf, leafIdentity, "Work::alpha::removable", "9")
            );
            await unchanged(() =>
              fixture.propose(leaf, leafIdentity, {
                ...childGrant,
                id: "exercise-does-not-confer-administration",
                targetSystem: delegationSystems.peer,
              })
            );
          },
        ),
      );
      assert(
        await t.step(
          "parent revocation disables all descendants and pending edit admission",
          async () => {
            const pending = await edit(
              leaf,
              leafIdentity,
              "Work::alpha::value",
              "18",
            );
            const revocation = await fixture.propose(primary, primaryIdentity, {
              kind: "revoke",
              id: parentGrant.id,
            });
            assert(
              (await leaf.readExecutableModel(leafIdentity)).modelEditPolicy,
            );
            await fixture.accept(revocation.id);
            assert(
              (await primary.readExecutableModel(primaryIdentity))
                .modelAdministration,
            );
            for (
              const [model, identity] of [[peer, peerIdentity], [
                leaf,
                leafIdentity,
              ]] as const
            ) {
              const current = await model.readExecutableModel(identity);
              assert.equal(current.modelEditPolicy, undefined);
              assert.equal(current.modelAdministration, undefined);
            }
            await unchanged(() => fixture.accept(pending.id));
            assert.equal(
              (await repository.proposal(pending.id)).status,
              "proposed",
            );
            assert.match(
              (await repository.current()).sources["mission.sysml"]!,
              /attribute value : Integer = 17;/,
            );
            await unchanged(() =>
              edit(leaf, leafIdentity, "Work::alpha::value", "19")
            );
            await unchanged(() =>
              fixture.propose(peer, peerIdentity, {
                ...childGrant,
                id: "revoked-issuer",
              })
            );
            await unchanged(() =>
              fixture.propose(primary, primaryIdentity, parentGrant)
            );
          },
        ),
      );
    } finally {
      await fixture.close();
    }
  },
});
