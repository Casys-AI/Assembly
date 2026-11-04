/** Real native compiler, Toolkit edits, Git proposals and current-authority admission. No LLM. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { resolveModelEdits } from "../../src/domain/model/editing/source-index.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import {
  editRequest,
  nativeId,
  openMandateFixture,
} from "../fixtures/model-edit-mandate.ts";
import type { ModelEdit } from "../../src/domain/model/editing/tooling.ts";
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

Deno.test({
  name:
    "mandate scoped authoring: four operations, confinement, bypasses and revocation",
  ignore: !toolkitIntegrationEnabled,
  async fn(t) {
    const fixture = await openMandateFixture(packageDir!);
    const { repository, primary, primaryIdentity } = fixture;
    async function accept(input: Parameters<typeof repository.accept>[0]) {
      return await repository.accept({
        ...input,
        decisionAuthorityExercise: exerciseOwnerAuthority(
          await primary.readExecutableModel(primaryIdentity),
          "model-revision",
        ),
      });
    }
    async function propose(edits: ModelEdit[]) {
      const head = await repository.current();
      const digest =
        (await primary.readExecutableModel(primaryIdentity)).version.digest;
      return await primary.proposeEdit(
        primaryIdentity,
        editRequest(head, edits),
        digest,
      );
    }
    async function unchanged(action: () => Promise<unknown>) {
      const head = await repository.current(),
        dossiers = await repository.listProposals();
      await assert.rejects(action);
      assert.deepEqual(
        await repository.current(),
        head,
        "Rejected authoring must preserve accepted sources and native IR",
      );
      assert.deepEqual(
        await repository.listProposals(),
        dossiers,
        "Rejected authoring must create no dossier",
      );
    }
    try {
      await t.step(
        "allowed set, insert, rename and remove remain below the granted root",
        async () => {
          const operations = (
            head: Awaited<ReturnType<typeof repository.current>>,
          ): ModelEdit[] => [
            {
              kind: "set-value",
              elementId: nativeId(head, "Work::alpha::value"),
              expression: "11",
            },
            {
              kind: "insert-member",
              elementId: nativeId(head, "Work::alpha"),
              text: "attribute inserted : Integer = 9;",
            },
            {
              kind: "rename",
              elementId: nativeId(head, "Work::alpha::removable"),
              name: "renamed",
            },
            {
              kind: "remove",
              elementId: nativeId(head, "Work::alpha::removable"),
            },
          ];
          const base = await repository.current();
          // Each operation is independently proposed from the same immutable base.
          for (const edit of operations(base)) {
            const proposal = await propose([edit]);
            const record = await repository.proposal(proposal.id);
            assert.equal(record.status, "proposed");
            const branch = await repository.at(record.proposalVersion!);
            for (const [path, text] of Object.entries(base.sources)) {
              if (path !== "mission.sysml") {
                assert.equal(branch.sources[path], text);
              }
            }
            assert(
              branch.sources["mission.sysml"]!.includes(
                "attribute value : Integer = 2;",
              ),
            );
            assert.equal((await repository.current()).version, base.version);
          }
        },
      );
      await t.step(
        "direct foreign, mixed, root and absent-ID requests refuse atomically",
        async () => {
          const head = await repository.current();
          for (
            const edits of [
              [{
                kind: "rename",
                elementId: nativeId(head, "Work::beta::value"),
                name: "stolen",
              }],
              [{
                kind: "set-value",
                elementId: nativeId(head, "Work::alpha::value"),
                expression: "14",
              }, {
                kind: "rename",
                elementId: nativeId(head, "Work::beta::value"),
                name: "stolen",
              }],
              [{
                kind: "rename",
                elementId: nativeId(head, "Work::alpha"),
                name: "escaped",
              }],
              [{ kind: "remove", elementId: nativeId(head, "Work::alpha") }],
              [{
                kind: "set-value",
                elementId: "nonexistent-native-id",
                expression: "14",
              }],
              [{
                kind: "insert-member",
                elementId: nativeId(head, "Work::alpha"),
                text:
                  "} package escaped { attribute injected : Integer = 3; } package continuation {",
              }],
            ] as ModelEdit[][]
          ) {
            console.log(
              `Checking direct refusal: ${
                edits.map((edit) =>
                  edit.kind + ":" +
                  (edit.kind === "retarget-reference"
                    ? edit.fromId
                    : edit.elementId)
                ).join(",")
              }`,
            );
            await unchanged(() => propose(edits));
          }
        },
      );
      await t.step(
        "stale source digest and execution pin refuse without a dossier",
        async () => {
          const base = await repository.current();
          const digest =
            (await primary.readExecutableModel(primaryIdentity)).version.digest;
          const request = editRequest(base, [{
            kind: "set-value",
            elementId: nativeId(base, "Work::alpha::value"),
            expression: "90",
          }]);
          await unchanged(() =>
            primary.proposeEdit(primaryIdentity, {
              ...request,
              sourceDigest: "0".repeat(64),
            }, digest)
          );
          await unchanged(() =>
            primary.proposeEdit(primaryIdentity, request, "0".repeat(64))
          );
        },
      );
      await t.step(
        "raw source replacement cannot bypass targeted-only authority",
        async () => {
          const head = await repository.current();
          await unchanged(async () =>
            await primary.proposeRevision(
              primaryIdentity,
              {
                baseVersion: head.version,
                sources: {
                  "mission.sysml": head.sources["mission.sysml"]!.replace(
                    "= 1;",
                    "= 77;",
                  ),
                },
                reason: "Raw bypass",
              },
              (await primary.readExecutableModel(primaryIdentity)).version
                .digest,
            )
          );
        },
      );
      await t.step(
        "common-base operators admit disjoint proposals after reconciliation",
        async () => {
          const base = await repository.current();
          const a = await propose([{
            kind: "set-value",
            elementId: nativeId(base, "Work::alpha::value"),
            expression: "21",
          }]);
          const b = await fixture.peer.proposeEdit(
            fixture.peerIdentity,
            editRequest(base, [{
              kind: "set-value",
              elementId: nativeId(base, "Work::beta::value"),
              expression: "22",
            }]),
            (await fixture.peer.readExecutableModel(fixture.peerIdentity))
              .version.digest,
          );
          const acceptedA = await accept({
            id: a.id,
            expectedVersion: base.version,
            author: "qualification:coordinator",
          });
          const acceptedB = await accept({
            id: b.id,
            expectedVersion: acceptedA.version,
            author: "qualification:coordinator",
          });
          assert(acceptedB.sources["mission.sysml"]!.includes("= 21;"));
          assert(acceptedB.sources["mission.sysml"]!.includes("= 22;"));
        },
      );
      await t.step(
        "overlapping proposals preserve a pending conflict dossier",
        async () => {
          const base = await repository.current();
          const id = nativeId(base, "Work::alpha::value");
          const a = await propose([{
            kind: "set-value",
            elementId: id,
            expression: "51",
          }]);
          const b = await propose([{
            kind: "set-value",
            elementId: id,
            expression: "52",
          }]);
          const accepted = await accept({
            id: a.id,
            expectedVersion: base.version,
            author: "qualification:coordinator",
          });
          await assert.rejects(() =>
            accept({
              id: b.id,
              expectedVersion: accepted.version,
              author: "qualification:coordinator",
            })
          );
          assert.equal((await repository.current()).version, accepted.version);
          assert.equal((await repository.proposal(b.id)).status, "proposed");
        },
      );
      await t.step(
        "trusted policy revocation between proposal and acceptance denies admission",
        async () => {
          const base = await repository.current();
          const pending = await propose([{
            kind: "set-value",
            elementId: nativeId(base, "Work::alpha::value"),
            expression: "31",
          }]);
          const revoked = await repository.publishSystemSources(
            {
              ...base.sources,
              "configuration.sysml": base.sources["configuration.sysml"]!
                .replace(
                  'id = "edit-Work-alpha"',
                  'id = "edit-Work-alpha-revoked"',
                ).replaceAll(
                  "attribute :>> revision = 1;",
                  "attribute :>> revision = 2;",
                ),
            },
            base.version,
            "qualification:trusted-host",
          );
          await assert.rejects(() =>
            accept({
              id: pending.id,
              expectedVersion: revoked.version,
              author: "qualification:coordinator",
            })
          );
          assert.equal((await repository.current()).version, revoked.version);
          assert.equal(
            (await repository.proposal(pending.id)).status,
            "proposed",
          );
        },
      );
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name:
    "mandate scoped authoring: SDK reference rewrites outside grant are denied",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const fixture = await openMandateFixture(packageDir!, {
      externalReferences: true,
    });
    try {
      const base = await fixture.repository.current();
      const digest =
        (await fixture.primary.readExecutableModel(fixture.primaryIdentity))
          .version.digest;
      const request = editRequest(base, [{
        kind: "rename",
        elementId: nativeId(base, "Work::alpha::value"),
        name: "revised",
      }]);
      const actual = await fixture.tooling.edit(
        base.sources,
        resolveModelEdits(base, request.edits),
      );
      assert(
        actual.sources["mission.sysml"]!.includes(
          "attribute revised : Integer = 1;",
        ),
        "SDK actually renames the allowed target",
      );
      assert(
        actual.sources["mission.sysml"]!.includes(
          "attribute outsideReference : Integer = Work::alpha::revised;",
        ),
        "SDK actually rewrites the ungranted same-file beta reference",
      );
      assert(
        actual.sources["external.sysml"]!.includes(
          "attribute outsideReference : Integer = Work::alpha::revised;",
        ),
        "SDK actually rewrites the ungranted different-file reference",
      );
      await assert.rejects(
        () =>
          fixture.primary.proposeEdit(
            fixture.primaryIdentity,
            request,
            digest,
          ),
        (error) =>
          error instanceof ModelRepositoryError &&
          error.code === "EDIT_SCOPE_DENIED" &&
          error.message ===
            "Model edit is outside its exact admitted source scope",
      );
      assert.deepEqual(await fixture.repository.current(), base);
      assert.equal((await fixture.repository.listProposals()).length, 0);
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name:
    "mandate scoped authoring: missing policy denies and raw policy stays confined",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    for (const options of [{ noPolicy: true }, { raw: true }]) {
      const fixture = await openMandateFixture(packageDir!, options);
      try {
        const base = await fixture.repository.current();
        const digest =
          (await fixture.primary.readExecutableModel(fixture.primaryIdentity))
            .version.digest;
        if (options.noPolicy) {
          await assert.rejects(() =>
            fixture.primary.proposeEdit(
              fixture.primaryIdentity,
              editRequest(base, [{
                kind: "set-value",
                elementId: nativeId(base, "Work::alpha::value"),
                expression: "15",
              }]),
              digest,
            )
          );
        } else {
          const allowed = await fixture.primary.proposeRevision(
            fixture.primaryIdentity,
            {
              baseVersion: base.version,
              sources: {
                "mission.sysml": base.sources["mission.sysml"]!.replace(
                  "= 1;",
                  "= 15;",
                ),
              },
              reason: "Confined raw revision",
            },
            digest,
          );
          assert.equal(
            (await fixture.repository.proposal(allowed.id)).status,
            "proposed",
          );
          await assert.rejects(() =>
            fixture.primary.proposeRevision(fixture.primaryIdentity, {
              baseVersion: base.version,
              sources: {
                "mission.sysml": base.sources["mission.sysml"]!.replace(
                  "= 2;",
                  "= 99;",
                ),
              },
              reason: "Raw escape",
            }, digest)
          );
        }
        assert.deepEqual(await fixture.repository.current(), base);
      } finally {
        await fixture.close();
      }
    }
  },
});

Deno.test({
  name:
    "mandate scoped authoring: broad self-system grant cannot rewrite protected policy",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const fixture = await openMandateFixture(packageDir!, {
      raw: true,
      ownSystem: true,
    });
    try {
      const base = await fixture.repository.current();
      const digest =
        (await fixture.primary.readExecutableModel(fixture.primaryIdentity))
          .version.digest;
      await assert.rejects(
        () =>
          fixture.primary.proposeRevision(fixture.primaryIdentity, {
            baseVersion: base.version,
            sources: {
              "configuration.sysml": base.sources["configuration.sysml"]!
                .replace(
                  'id = "edit-AssemblyLiveBuilder-liveBuilder"',
                  'id = "self-granted-policy"',
                ),
            },
            reason: "Attempted policy self-grant under a broad system grant",
          }, digest),
        /mandats|contrôles|exécution|protected|authority|execution/i,
      );
      assert.deepEqual(await fixture.repository.current(), base);
      assert.equal((await fixture.repository.listProposals()).length, 0);
    } finally {
      await fixture.close();
    }
  },
});
