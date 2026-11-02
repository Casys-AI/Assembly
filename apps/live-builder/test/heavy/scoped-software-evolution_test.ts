// deno-lint-ignore-file require-await -- Controlled provider implements the async production port.
/** One joined BO software witness. Real Toolkit/Git/PG/native execution and
 * production composition; only the provider's decisions are scripted. */
import assert from "node:assert/strict";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  openInitialNormalRequest,
  openNormalAdmissionWitnessHost,
  readCompletedNormalRequest,
} from "../support/request-source-admission-normal-host.ts";
import { immutableRequestEvidence } from "../support/request-source-admission-qualification.ts";
import { editPolicy, nativeId } from "../fixtures/model-edit-mandate.ts";
import { buildEvolutionPolicyEdits } from "../support/evolution-policy/writer.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { parseScopedSoftwareDossier } from "../../src/application/model/evolution/scoped-software-dossier.ts";
import type { EvolutionGrant } from "../../src/domain/model/evolution/policy.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../src/domain/work/dialogue.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  scopedSoftwareSourceAdmissionRef,
  scopedSoftwareSourceCommandRef,
} from "../../src/domain/model/editing/request-source-publication.ts";
import { RequestCaseConversations } from "../../src/application/work/request-spaces/conversations.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import { ScopedSoftwareCurrentAuthority } from "../../src/adapters/model/evolution/scoped-authority.ts";
import { PostgresRequestSourceAdmissionStore } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import { RequestSpaceError } from "../../src/domain/work/request-spaces.ts";
import { modelToolingTarget } from "../../src/adapters/model/sources/editing/tooling.ts";
import { PostgresScopedSoftwareSourcePublicationParticipant } from "../../src/adapters/out/postgres/scoped-software-source-publication-participant.ts";
import { PostgresScopedSoftwareAdoptionTransition } from "../../src/adapters/out/postgres/scoped-software-adoption-transition.ts";
import { eventually } from "../support/eventually.ts";

Deno.test({
  name:
    "BO native software commands publish/adopt its Request branch, recover local restore, and retain a Release for a fresh authorized Case while Main and sibling stay unchanged",
  ignore: !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    const participant =
      PostgresScopedSoftwareSourcePublicationParticipant.prototype;
    const adoption = PostgresScopedSoftwareAdoptionTransition.prototype;
    const authorityPrototype = ScopedSoftwareCurrentAuthority.prototype;
    const originalPrepare = participant.prepareCurrent;
    const originalInitial = participant.assertNewLocked;
    const originalFinal = participant.assertExpiryLocked;
    const originalAdopt = adoption.adopt;
    const originalAssert = authorityPrototype.assertCurrentPreparedLocked;
    const prepared = new Set<object>();
    const initial = new Map<object, object>();
    const finalized = new Map<object, object>();
    const adopted = new Set<object>();
    let adopting = false;
    participant.prepareCurrent = async function (context) {
      const token = await originalPrepare.call(this, context);
      prepared.add(token);
      return token;
    };
    participant.assertNewLocked = async function (tx, context, token) {
      assert(
        prepared.has(token),
        "publication authority must be prepared before locked checks",
      );
      initial.set(token, tx);
      await originalInitial.call(this, tx, context, token);
    };
    participant.assertExpiryLocked = async function (tx, context, token) {
      assert.equal(
        initial.get(token),
        tx,
        "publication checks must share token and transaction",
      );
      await originalFinal.call(this, tx, context, token);
      finalized.set(token, tx);
    };
    adoption.adopt = async function (input) {
      adopting = true;
      try {
        return await originalAdopt.call(this, input);
      } finally {
        adopting = false;
      }
    };
    authorityPrototype.assertCurrentPreparedLocked = async function (
      tx,
      dossier,
      token,
    ) {
      if (adopting) adopted.add(token);
      await originalAssert.call(this, tx, dossier, token);
    };
    try {
      const started = performance.now();
      const mark = (phase: string) =>
        console.log("Scoped BO software witness", {
          phase,
          seconds: Math.round((performance.now() - started) / 100) / 10,
        });
      await withPostgresDatabase(async (database) => {
        const script: ChatDecision[] = [];
        const contexts: ChatContext[] = [];
        const host = await openNormalAdmissionWitnessHost(database, {
          enableRuntimeAdoption: true,
          enableSoftwareEvolutionWitness: true,
          agent: {
            label: "Controlled BO software decisions",
            async decide(context) {
              contexts.push(structuredClone(context));
              const decision: ChatDecision = script.shift() ??
                { kind: "reply", text: "Controlled BO contribution settled." };
              return decision;
            },
            async review() {
              throw new Error("This joined witness has no provider review");
            },
          },
          async beforePrimaryBootstrap(backend) {
            const identity = await backend.model.initialize();
            const actor = await backend.model.readExecutableModel(identity);
            const before = await backend.repository.current();
            assert.equal(
              actor.modelEditPolicy,
              undefined,
              "This normal seed must receive its separate explicit source-edit grant",
            );
            const grants: EvolutionGrant[] =
              (["prepare", "accept", "adopt"] as const).map((act) => ({
                act,
                targetNativeId: identity.builderId,
                category: "instructions",
                bounds: { maxCharacters: 4096 },
              }));
            const edits = buildEvolutionPolicyEdits(before, identity, {
              id: "scoped-bo-instructions",
              expectedRevision: 0,
              grants,
            });
            const changed = await backend.tooling.edit(before.sources, edits);
            const root =
              modelToolingTarget(before, identity.systemId).qualifiedName;
            const marker = `part ${
              root.split("::").at(-1)
            } : ConversationSystem {`;
            assert(changed.sources["configuration.sysml"].includes(marker));
            changed.sources["configuration.sysml"] = changed
              .sources["configuration.sysml"].replace(
                marker,
                marker + editPolicy(root),
              );
            const owner = exerciseOwnerAuthority(actor, "model-revision");
            const proposed = await backend.repository.propose({
              baseVersion: before.version,
              sources: changed.sources,
              author: "local-owner",
              reason:
                "Explicit prior native grants for one isolated BO instructions witness",
              authorization: { kind: "local-owner", authorityExercise: owner },
            });
            await backend.repository.accept({
              id: proposed.id,
              expectedVersion: before.version,
              author: "local-owner",
              decisionAuthorityExercise: owner,
            });
            assert.equal(
              (await backend.queue.get(backend.project.id, proposed.id))!.state,
              "published",
            );
          },
        });
        const origin = await openInitialNormalRequest(host),
          sibling = await openInitialNormalRequest(host);
        const { record, session } = origin;
        const repositoryId = host.backend.project.id,
          operatorId = host.primaryOperatorId;
        const targetScope = {
          ...record.scope,
          executionSpaceId: record.executionSpaceId,
          operatorId,
        };
        const baseline = await host.backend.repository.current();
        const baselineMain = await host.storage.client.runtimeState.findMany({
          where: { ...host.storage.scope, executionSpaceId: "main" },
          orderBy: { operatorId: "asc" },
        });
        const baselineSibling = await immutableRequestEvidence(
          host.storage.client,
          sibling.record,
        );
        const birth = canonical(record.base),
          oldPin = (await host.stage.executionBindings.read(record)).pin;
        const instruction =
          "BO scoped evolution: keep this exact Request and use the newly admitted instruction.";
        const readDossier = async () => {
          const rows = await host.storage.client.evolutionDossier.findMany({
            where: {
              ...record.scope,
              executionSpaceId: record.executionSpaceId,
              kind: "software-evolution-scoped-v2",
            },
          });
          assert(
            rows.length <= 1,
            "One native prepare command must create only one dossier",
          );
          return rows[0]
            ? await parseScopedSoftwareDossier(JSON.parse(rows[0].payload))
            : undefined;
        };
        const turn = async (
          decisions: ChatDecision[],
          reply: string,
          conversations = host.stage.conversations,
        ) => {
          assert.equal(script.length, 0);
          script.push(...decisions, { kind: "reply", text: reply });
          const view = await conversations.conversations(
            session.secret,
            record.caseId,
          );
          const owner = view.conversations.find((item) =>
            item.agentId === operatorId
          )!;
          await conversations.submitHuman(session.secret, {
            caseId: record.caseId,
            agentId: operatorId,
            expectedRevision: owner.revision,
            text: reply,
          });
          await eventually(async () => {
            if (host.workerErrors.length || host.deliveryFailures.length) {
              throw new AggregateError(
                [
                  ...host.workerErrors,
                  ...host.deliveryFailures.map((item) => item.error),
                ].slice(0, 8),
                "Native witness delivery failed",
              );
            }
            const binding = await host.stage.executionBindings.read(record);
            const pending = await host.storage.client.executionContribution
              .count(
                {
                  where: {
                    ...targetScope,
                    status: { in: ["queued", "running"] },
                  },
                },
              );
            return !binding.state.busy && pending === 0 &&
                script.length === 0 &&
                binding.state.messages.some((message) =>
                  message.role === "assistant" && message.text === reply
                )
              ? binding
              : undefined;
          }, { label: reply, timeoutMs: 150_000 });
        };
        const edit = {
          kind: "set-value" as const,
          elementId: nativeId(
            baseline,
            `${
              modelToolingTarget(baseline, host.initialModel.identity.systemId)
                .qualifiedName
            }::operatorInstruction`,
          ),
          expression: JSON.stringify(instruction),
        };
        await turn([{
          kind: "consult_model",
          text: "Read this admitted Request source before preparing its edit",
          inputJson: JSON.stringify({
            operation: "read_source",
            path: "configuration.sysml",
            version: baseline.version,
          }),
        }, {
          kind: "prepare_operator_evolution",
          text: "Prepare this BO's exact instruction replacement",
          reason: "Qualify scoped software evolution through native commands",
          editJson: JSON.stringify({ edits: [edit] }),
        }], "BO prepared its exact instruction replacement.");
        let dossier = (await readDossier())!;
        assert(dossier);
        assert.equal(dossier.status, "prepared");
        assert.deepEqual(dossier.proposal.categories, ["instructions"]);
        assert.deepEqual(dossier.scope.actor, {
          ...record.scope,
          executionSpaceId: record.executionSpaceId,
          operatorId,
        });
        assert.deepEqual(dossier.scope.targets[0].previousPin, oldPin);
        assert.equal(dossier.origin.requestId, record.caseId);
        assert.equal(dossier.accounting.agentInvocations, 0);
        assert.notEqual(
          dossier.proposal.digest,
          dossier.scopedProposal.sourceAssessmentDigest,
        );
        assert.equal(
          await host.evolutionStore!.scopedSoftware(dossier.scope).targetOwner(
            repositoryId,
            operatorId,
          ),
          null,
        );
        assert.equal(
          (await host.sourceAdmission.admittedSource(record)).head.source
            .version,
          baseline.version,
        );
        mark("actual BO prepare command; no publication or barrier");
        await turn([{
          kind: "decide_operator_evolution",
          text: "Accept this exact scoped software proposal",
          dossierId: dossier.id,
          decision: "accept",
        }], "BO accepted its exact scoped proposal.");
        dossier = (await readDossier())!;
        assert.equal(dossier.status, "accepted");
        assert.equal(
          (await host.sourceAdmission.admittedSource(record)).head.source
            .version,
          baseline.version,
        );
        // Bounded negative assertion on this real native dossier and admission.
        // The revocation is deliberately transaction-local and rolled back: no
        // privileged resurrection or second host/scenario is introduced.
        const authority = new ScopedSoftwareCurrentAuthority({
          client: host.storage.client,
          primaryControl: host.storage.primarySpaceControl,
          sqlAdmissions: host.controls.sqlAdmissions,
          native: host.stage.nativeRuntime,
          bindings: host.stage.executionBindings,
          journal: new PostgresRequestSourceAdmissionStore(host.storage.client),
          repository: host.backend.scopedSoftwareRepository,
          verifyGit: (admission) =>
            host.backend.scopedSoftwareRepository
              .verifyScopedSoftwareSourceAdmission(admission),
        });
        const rollbackRevocation = new Error(
          "witness: rollback transaction-local capability revocation",
        );
        await host.storage.client.$transaction(async (tx) => {
          await authority.lockPrimary(tx);
          await authority.assertAdmissionLocked(tx, dossier);
          const revoked = await tx.spaceControlCredential.updateMany({
            where: {
              ...record.scope,
              id: origin.controller.capabilityId,
              kind: "capability",
              status: "active",
            },
            data: { status: "revoked", revision: { increment: 1 } },
          });
          assert.equal(revoked.count, 1);
          await assert.rejects(
            () => authority.assertAdmissionLocked(tx, dossier),
            (error: unknown) =>
              error instanceof RequestSpaceError &&
              error.code === "ADMISSION_REFUSED",
          );
          throw rollbackRevocation;
        }).catch((error: unknown) => {
          assert.equal(error, rollbackRevocation);
        });
        assert.equal(
          (await host.storage.client.spaceControlCredential.findFirst({
            where: { ...record.scope, id: origin.controller.capabilityId },
          }))!.status,
          "active",
        );
        assert.equal(
          (await host.sourceAdmission.admittedSource(record)).head.source
            .version,
          baseline.version,
        );
        mark(
          "actual new-effect admission guard rejects transaction-local capability revocation",
        );
        const restoreFailure = new Error(
          "witness: local postcommit restore acknowledgment lost",
        );
        const restore = host.stage.runtime.restoreSoftwareEvolution.bind(
          host.stage.runtime,
        );
        let lostRestore = false;
        host.stage.runtime.restoreSoftwareEvolution = async (opening) => {
          if (opening.id === record.id && !lostRestore) {
            lostRestore = true;
            throw restoreFailure;
          }
          await restore(opening);
        };
        database.registerCleanup(() => {
          host.stage.runtime.restoreSoftwareEvolution = restore;
        });
        await turn([{
          kind: "adopt_operator_evolution",
          text: "Authorize adoption after this engaged contribution settles",
          dossierId: dossier.id,
        }], "BO armed adoption and settled its old contribution.");
        const errorEvidence = (error: unknown) =>
          error instanceof Error
            ? {
              name: error.name,
              message: error.message.slice(0, 1024),
              stack: error.stack?.split("\n").slice(0, 16).join("\n"),
            }
            : { message: String(error).slice(0, 1024) };
        const adoptionEvidence = async () => {
          const native = await host.stage.nativeRuntime.forCaseSpace(
            record.executionSpaceId,
            record.caseId,
          );
          const results = await Promise.allSettled(
            [
              readDossier(),
              host.backend.queue.get(repositoryId, dossier.proposal.id),
              host.stage.executionBindings.read(record),
              native.execution.inspect(operatorId),
              host.storage.client.executionContribution.findMany({
                where: targetScope,
                take: 8,
                orderBy: { contributionId: "asc" },
                select: {
                  contributionId: true,
                  threadId: true,
                  runId: true,
                  jobId: true,
                  status: true,
                },
              }),
              host.storage.client.executionEffect.findMany({
                where: { ...targetScope, status: { not: "completed" } },
                take: 8,
                orderBy: { effectKey: "asc" },
                select: {
                  effectKey: true,
                  threadId: true,
                  runId: true,
                  nodeId: true,
                  status: true,
                },
              }),
              host.storage.client.executionRun.findMany({
                where: targetScope,
                take: 8,
                orderBy: { runId: "asc" },
                select: {
                  threadId: true,
                  runId: true,
                  status: true,
                  errorJson: true,
                },
              }),
            ] as const,
          );
          const [d, queue, binding, snapshots, contributions, effects, runs] =
            results;
          const lookup = native.ledger.options.lookupRetirementJob;
          let jobs: unknown = "public job lookup unavailable";
          if (lookup && contributions.status === "fulfilled") {
            const ids = [
              ...new Set(
                contributions.value.map((entry) => entry.jobId).filter((
                  id,
                ): id is string => typeof id === "string"),
              ),
            ];
            const found = await host.storage.client.$transaction((tx) =>
              Promise.allSettled(ids.map((id) => lookup(tx, id)))
            );
            jobs = found.map((result) =>
              result.status === "fulfilled"
                ? result.value.map((entry) => ({
                  id: entry.id,
                  state: entry.state,
                  name: entry.name,
                }))
                : errorEvidence(result.reason)
            );
          }
          return {
            dossier: d.status === "fulfilled" && d.value
              ? {
                id: d.value.id,
                status: d.value.status,
                revision: d.value.revision,
                updatedAt: d.value.updatedAt,
                blockers: d.value.blockers.slice(0, 8),
                publication: d.value.publication,
                adoptions: d.value.adoptions.length,
              }
              : d.status === "rejected"
              ? errorEvidence(d.reason)
              : "missing",
            queue: queue.status === "fulfilled"
              ? queue.value &&
                {
                  state: queue.value.state,
                  attempts: queue.value.attempts,
                  lastFailure: queue.value.lastError,
                  publishedVersion: queue.value.publishedVersion,
                }
              : errorEvidence(queue.reason),
            runtime: binding.status === "fulfilled"
              ? {
                revision: binding.value.state.revision,
                busy: binding.value.state.busy,
                phase: binding.value.state.phase,
                pin: binding.value.pin,
              }
              : errorEvidence(binding.reason),
            snapshots: snapshots.status === "fulfilled"
              ? snapshots.value.slice(0, 8).map((entry) => ({
                threadId: entry.threadId,
                runId: entry.runId,
                status: entry.status,
                pendingContributions: entry.pendingContributions,
                unsettledEffects: entry.unsettledEffects,
                waits: entry.waits.map((wait) => ({ nodeId: wait.nodeId })),
              }))
              : errorEvidence(snapshots.reason),
            contributions: contributions.status === "fulfilled"
              ? contributions.value
              : errorEvidence(contributions.reason),
            unsettledEffects: effects.status === "fulfilled"
              ? effects.value
              : errorEvidence(effects.reason),
            runs: runs.status === "fulfilled"
              ? runs.value.map((entry) => ({
                ...entry,
                errorJson: entry.errorJson?.slice(0, 1024),
              }))
              : errorEvidence(runs.reason),
            jobs,
            deliveryErrors: host.deliveryFailures.slice(0, 8).map((entry) => ({
              deliveryId: entry.deliveryId,
              ...errorEvidence(entry.error),
            })),
            workerErrors: host.workerErrors.slice(0, 8).map(errorEvidence),
            softwareErrors: host.softwareDiagnostics.slice(0, 8).map(
              errorEvidence,
            ),
          };
        };
        let pendingBoundary = "";
        try {
          dossier = await eventually(async () => {
            const current = await readDossier();
            const expectedAckLoss = lostRestore &&
              host.workerErrors.length === 0 &&
              host.deliveryFailures.length === 0 &&
              host.softwareDiagnostics.length === 1 &&
              host.softwareDiagnostics[0] === restoreFailure;
            if (expectedAckLoss) {
              // The first read can precede COMMIT while the restore callback has
              // already failed by this point. Only this exact injected error is
              // tolerated, and only after rereading its durable adoption proof.
              const committed = current?.status === "adopted"
                ? current
                : await readDossier();
              assert(
                committed?.status === "adopted",
                "Lost local ACK requires the committed adopted dossier",
              );
              assert(committed.publication);
              assert.equal(committed.adoptions.length, 1);
              assert.equal(committed.adoptions[0].operatorId, operatorId);
              assert.equal(
                committed.adoptions[0].proposalDigest,
                committed.proposal.digest,
              );
              assert.equal(
                committed.adoptions[0].version,
                committed.publication.version,
              );
              const [chain, activated] = await Promise.all([
                host.sourceAdmission.admittedSource(record),
                host.stage.executionBindings.read(record),
              ]);
              const journal = chain.execution.softwareAdoptions.find((entry) =>
                entry.manifest.dossierId === committed.id
              );
              assert(
                journal,
                "Lost local ACK requires the software adoption journal",
              );
              assert.equal(
                journal.manifest.intentDigest,
                committed.intentDigest,
              );
              assert.equal(
                journal.manifest.proposalDigest,
                committed.proposal.digest,
              );
              assert(
                "sourceAdmission" in committed.publication,
                "Lost local ACK requires its exact D2 source reference",
              );
              assert.deepEqual(
                journal.manifest.sourceAdmission,
                committed.publication.sourceAdmission,
              );
              assert.equal(
                chain.head.source.version,
                committed.publication.version,
              );
              assert.equal(
                activated.pin.source.version,
                committed.publication.version,
              );
              assert.equal(
                activated.pin.modelDigest,
                committed.proposal.targets[0].candidateDigest,
              );
              assert(
                activated.pin.adoption,
                "Lost local ACK requires the committed execution adoption pin",
              );
              assert.equal(activated.pin.adoption.commandId, committed.id);
              assert.equal(
                activated.pin.adoption.committedRuntimeRevision,
                journal.manifest.committedRuntimeRevision,
              );
              assert(
                activated.state.revision >=
                  journal.manifest.committedRuntimeRevision,
              );
              return committed;
            }
            if (
              host.workerErrors.length || host.deliveryFailures.length ||
              host.softwareDiagnostics.length
            ) {
              throw new AggregateError(
                [
                  ...host.workerErrors,
                  ...host.deliveryFailures.map((entry) => entry.error),
                  ...host.softwareDiagnostics,
                ].slice(0, 8),
                "Software finalization reported a technical failure",
              );
            }
            const signature = current
              ? canonical({
                status: current.status,
                blockers: current.blockers,
              })
              : "missing";
            if (current?.blockers.length && signature !== pendingBoundary) {
              pendingBoundary = signature;
              console.log("Scoped BO pending boundary", {
                status: current.status,
                blockers: current.blockers.slice(0, 8),
              });
            }
            return undefined;
          }, { label: "atomic software adoption", timeoutMs: 150_000 });
        } catch (error) {
          try {
            console.error(
              "Scoped BO adoption failure evidence",
              await adoptionEvidence(),
            );
          } catch (diagnosticError) {
            console.error(
              "Scoped BO evidence capture failed",
              errorEvidence(diagnosticError),
            );
          }
          throw error;
        }
        assert(lostRestore);
        assert.deepEqual(host.softwareDiagnostics, [restoreFailure]);
        for (
          const receipt of [
            dossier.preparation,
            dossier.acceptance!,
            dossier.adoptionAuthorization!,
          ]
        ) {
          assert.equal(receipt.operatorNativeId, operatorId);
          assert.equal(receipt.proposalDigest, dossier.proposal.digest);
          assert.deepEqual(receipt.categories, ["instructions"]);
        }
        const nativeEffects = await host.storage.client.executionEffect
          .findMany({
            where: { ...targetScope, effectKey: dossier.callerCommandId },
          });
        assert.equal(nativeEffects.length, 1);
        assert.equal(nativeEffects[0].status, "completed");
        const publication = dossier.publication!;
        assert.notEqual(publication.version, baseline.version);
        const published = await host.sourceAdmission.admittedSource(record);
        assert.equal(published.head.source.version, publication.version);
        assert.equal(
          published.execution.pin.source.version,
          publication.version,
        );
        assert.equal(published.softwareReceipts.length, 1);
        assert.equal(published.execution.softwareAdoptions.length, 1);
        assert.equal(
          published.receipts.length,
          0,
          "Software publication must not synthesize a human source receipt",
        );
        assert.equal(
          published.execution.adoptions.length,
          0,
          "Software activation must not synthesize a human adoption",
        );
        await host.backend.scopedSoftwareRepository
          .verifyScopedSoftwareSourceAdmission(
            published.softwareReceipts[0].payload,
          );
        const readRef = async (ref: string) => {
          const result = await new Deno.Command("git", {
            args: [
              "--git-dir",
              `${host.backend.project.projectDir}/.git`,
              "rev-parse",
              "--verify",
              ref,
            ],
            stdout: "piped",
            stderr: "piped",
          }).output();
          assert(result.success);
          return `commit:${new TextDecoder().decode(result.stdout).trim()}`;
        };
        assert.equal(
          await readRef(`refs/heads/requests/${record.branchId}`),
          publication.version,
        );
        assert.equal(
          await readRef(scopedSoftwareSourceCommandRef(publication.commandId)),
          publication.version,
        );
        assert.equal(
          await readRef(
            scopedSoftwareSourceAdmissionRef(
              publication.commandId,
              publication.version,
            ),
          ),
          publication.version,
        );
        const manifest = published.execution.softwareAdoptions[0].manifest;
        assert.equal(
          manifest.authorizationRuntimeRevision,
          manifest.boundary.previousRuntimeRevision + 1,
        );
        assert.equal(
          manifest.committedRuntimeRevision,
          manifest.boundary.previousRuntimeRevision + 2,
        );
        assert.deepEqual(manifest.boundary.previousPin, oldPin);
        assert.equal(dossier.adoptions.length, 1);
        assert.equal(
          await host.evolutionStore!.scopedSoftware(dossier.scope).targetOwner(
            repositoryId,
            operatorId,
          ),
          null,
        );
        mark(
          "real Git/D2 and native retirement/admission transaction; lost local restore receipt retained",
        );

        const cold = host.coldSoftwareRuntimeForWitness();
        host.useRuntimeForWitness(cold);
        const coldConversations = new RequestCaseConversations({
          scope: host.storage.scope,
          control: host.stage.controls,
          store: new PostgresRequestSpaceStore(
            host.storage.client,
            host.storage.scope,
          ),
          admissions: host.controls.admissions,
          runtime: cold,
        });
        await cold.provision(record);
        await turn(
          [],
          "Cold BO executes the exact software-adopted model.",
          coldConversations,
        );
        const actual = contexts.findLast((context) =>
          context.case?.id === record.caseId
        )!;
        assert.equal(
          actual.admittedModelVersion!.repositoryVersion,
          publication.version,
        );
        assert.equal(
          actual.admittedModelVersion!.digest,
          dossier.proposal.targets[0].candidateDigest,
        );
        assert.equal(actual.operator!.instruction, instruction);
        assert.equal(actual.modelContext!.version, publication.version);
        const recovered = await host.stage.executionBindings.read(record);
        assert.equal(
          recovered.state.events.filter((event) =>
            event.effectiveModelUpdate?.dossierId === dossier.id
          ).length,
          1,
        );
        assert.equal((await readDossier())!.adoptions.length, 1);
        assert.equal(
          (await host.backend.repository.current()).version,
          baseline.version,
        );
        assert.deepEqual(
          await host.storage.client.runtimeState.findMany({
            where: { ...host.storage.scope, executionSpaceId: "main" },
            orderBy: { operatorId: "asc" },
          }),
          baselineMain,
        );
        assert.deepEqual(
          await immutableRequestEvidence(host.storage.client, sibling.record),
          baselineSibling,
        );
        assert.equal(
          canonical(
            (await new PostgresRequestSpaceStore(
              host.storage.client,
              host.storage.scope,
            ).get(record.id))!.base,
          ),
          birth,
        );
        const system = await host.stage.supervision.read(session.secret, {
          caseId: record.caseId,
        });
        assert.equal(system.main.role, "MO");
        assert.equal(system.main.actor.executionSpaceId, "main");
        assert.equal(system.main.source!.sourceVersion, baseline.version);
        const bo = system.instances.find((entry) =>
          entry.case?.id === record.caseId
        )!;
        assert(bo);
        assert.equal(bo.role, "BO");
        assert.equal(bo.actor.executionSpaceId, record.executionSpaceId);
        assert.equal(bo.source!.sourceVersion, publication.version);
        assert.equal(
          bo.source!.modelDigest,
          dossier.proposal.targets[0].candidateDigest,
        );
        assert.equal(
          bo.supervision.status,
          "unresolved",
          "Opening ancestry must not fabricate a Main-to-BO supervision grant",
        );
        const model = await host.stage.caseBranchReader.resolve(
          record.caseId,
          origin.controller,
          publication.version,
        );
        assert.equal(model.version, publication.version);
        assert.equal(model.branchVersion, publication.version);
        assert.equal(model.executionVersion, publication.version);
        assert.equal(model.baseVersion, baseline.version);
        assert.equal(model.readOnly, true);
        const details = await host.stage.operatorDetails.read(
          session.secret,
          record.caseId,
          operatorId,
        );
        assert.equal(
          details.observedSource.source.version,
          publication.version,
        );
        assert.equal(
          details.observedSource.modelDigest,
          dossier.proposal.targets[0].candidateDigest,
        );
        mark(
          "cold BO execution and actual System/Model readers; Main/sibling/B0 bytes preserved",
        );

        // The human proposal path must join the same software-admitted predecessor
        // without converting its historical software authority into human proof.
        const sourceAfterSoftware = await host.backend.scopedSoftwareRepository
          .at(publication.version);
        const humanInstruction = JSON.stringify(
          instruction + " Separate human draft.",
        );
        assert(
          sourceAfterSoftware.sources["configuration.sysml"].includes(
            JSON.stringify(instruction),
          ),
        );
        const humanDraft = await host.revisions.propose(session.secret, {
          caseId: record.caseId,
          expectedVersion: publication.version,
          changes: [{
            path: "configuration.sysml",
            text: sourceAfterSoftware.sources["configuration.sysml"].replace(
              JSON.stringify(instruction),
              humanInstruction,
            ),
          }],
          reason:
            "Qualify human preparation after exact software adoption without accepting the draft",
        });
        assert.equal(humanDraft.baseVersion, publication.version);
        assert.equal(humanDraft.caseId, record.caseId);
        assert.equal(
          (await host.sourceAdmission.admittedSource(record)).head.source
            .version,
          publication.version,
        );
        assert.equal(
          (await host.stage.executionBindings.read(record)).pin.source.version,
          publication.version,
        );
        mark(
          "public human proposal joins exact software predecessor; draft does not admit",
        );

        const tag = `software-bo-${crypto.randomUUID()}`;
        const selected = {
          branch: { kind: "case" as const, caseId: record.caseId },
          sourceVersion: publication.version,
        };
        await host.releases.releases.createTag(session.secret, {
          name: tag,
          source: selected,
        });
        const retained = await host.releases.releases.save(session.secret, {
          saveKey: tag,
          tag: { mode: "existing", name: tag },
          name: "BO software-evolved system",
          purpose:
            "Fresh Request reuses admitted software source independently",
          source: selected,
        });
        assert(
          retained.manifest && retained.digest &&
            retained.source?.requestAdmission,
        );
        assert.equal(retained.source.sourceVersion, publication.version);
        assert.equal(
          retained.source.requestAdmission.manifestDigest,
          published.head.manifestDigest,
        );
        const capability = await host.stage.controls.issueCapability(
            origin.controller.ownerId,
          ),
          freshSession = await host.stage.controls.exchange(capability.secret);
        const freshController = await host.stage.controls.authenticateSession(
          freshSession.secret,
        );
        assert.notEqual(
          freshController.capabilityId,
          origin.controller.capabilityId,
        );
        const opened = await host.stage.openings.open({
          openingKey: `software-fresh-${crypto.randomUUID()}`,
          text: "Fresh Case from the exact software-evolved Release",
          source: {
            kind: "release",
            releaseId: retained.id,
            digest: retained.digest,
          },
        }, freshSession.secret);
        assert.equal(opened.phase, "dispatched", JSON.stringify(opened.issues));
        const fresh = await readCompletedNormalRequest(host, opened.id);
        for (
          const field of [
            "caseId",
            "executionSpaceId",
            "branchId",
            "initialContributionId",
            "admissionId",
          ] as const
        ) {
          assert.notEqual(fresh.record[field], record[field]);
          assert.notEqual(fresh.record[field], sibling.record[field]);
        }
        assert.equal(
          fresh.state.executionModel!.version.repositoryVersion,
          publication.version,
        );
        assert.equal(
          fresh.state.executionModel!.operator!.instruction,
          instruction,
        );
        assert.deepEqual(fresh.record.base!.release, {
          id: retained.id,
          digest: retained.digest,
        });
        assert.equal(
          (await host.backend.repository.current()).version,
          baseline.version,
        );
        assert.deepEqual(host.workerErrors, []);
        assert.deepEqual(host.deliveryFailures, []);
        assert.equal(script.length, 0);
        assert(
          finalized.size > 0,
          "publication must pass both prepared authority checks",
        );
        assert(
          adopted.size > 0,
          "adoption must validate its prepared authority",
        );
        for (const token of adopted) {
          assert(
            !prepared.has(token),
            "adoption must prepare a separate token",
          );
        }
        mark(
          "exact software Release reused in fresh independently authorized Case",
        );
      });
    } finally {
      participant.prepareCurrent = originalPrepare;
      participant.assertNewLocked = originalInitial;
      participant.assertExpiryLocked = originalFinal;
      adoption.adopt = originalAdopt;
      authorityPrototype.assertCurrentPreparedLocked = originalAssert;
    }
  },
});
