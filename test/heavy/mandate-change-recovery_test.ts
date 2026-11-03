/** Durable-only mandate tier: restart recovery, pg-boss drain, native-pin
 * fences and lost-save reconciliation on real PostgreSQL.
 *
 * Host-agnostic scenarios live in mandate-change-semantics_test.ts; the two
 * files sum to the 28 original scenarios with unchanged assertions.
 */
import { createControlHandler } from "../../src/adapters/in/http/work/control.ts";
import { createConversationsHandler } from "../../src/adapters/in/http/work/conversations.ts";
import { OperatorConversations } from "../../src/application/work/operators/conversations.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { ChangePublicationError } from "../../src/domain/model/publication/change.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  drainDecisionCompletion,
  drainDecisionRefusal,
  drainMandateQueue,
  FileRepository,
  mandateRecoveryEnabled,
  openMandateDurableSession,
  proposeMandateChange,
  reopenMandateSession,
} from "../support/mandate-harness.ts";

for (
  const boundary of [
    "before-publication",
    "publication-return",
    // The completion-save loss boundary (approval recorded without its
    // receipt) was removed by the atomic receipt: the approval is journaled
    // atomically with the resumption receipt. This boundary now loses that
    // atomic approval-completion save instead.
    "approval-completion-save",
    "completion-return",
    "source-only-advance",
    "moved-pin",
  ] as const
) {
  Deno.test({
    name: `Toolkit and durable runtime reconcile publication at ${boundary}`,
    ignore: !mandateRecoveryEnabled,
    async fn() {
      const directory = await Deno.makeTempDir();
      const sourcesDirectory = `${directory}/sources`;
      await Deno.mkdir(sourcesDirectory);
      const repository = new FileRepository(sourcesDirectory);
      const initialSources = await loadInitialSources(undefined, {
        information: false,
      });
      const durable = await openMandateDurableSession({
        repository,
        initialSources,
      });
      const model = durable.model;
      try {
        let { service, proposed } = await proposeMandateChange(durable);
        const prior = service.snapshot.executionModel!;
        ok(proposed, service.snapshot.error);
        const input = {
          changeId: proposed.id,
          expectedRevision: proposed.baseRevision,
          verdict: "approve" as const,
        };
        repository.beforePublish = async () => {
          const pending = (await durable.storage.state.load())!
            .configuration!.changes[0];
          deepStrictEqual(pending, proposed);
          equal(pending.status, "pending");
          equal(pending.authorityExercise, undefined);
          if (boundary === "before-publication") {
            throw new Error("Injected before publication");
          }
        };
        if (boundary === "publication-return") {
          repository.afterPublish = () =>
            Promise.reject(new Error("Injected lost return"));
        }
        if (boundary === "source-only-advance") {
          repository.beforeUpdate = async () => {
            repository.beforeUpdate = undefined;
            const head = await repository.current();
            await repository.publishSystemSources(
              {
                ...head.sources,
                "authority.sysml": head.sources["authority.sysml"] + "\n",
              },
              head.version,
              "source-only",
            );
          };
        }
        const stateStore = durable.storage.state;
        const save = stateStore.save.bind(stateStore);
        if (
          ["approval-completion-save", "completion-return", "moved-pin"]
            .includes(
              boundary,
            )
        ) {
          stateStore.save = async (state, expected) => {
            const completed =
              state.configuration?.changes[0]?.status === "approved";
            if (completed && boundary !== "completion-return") {
              throw new Error("Injected before state save");
            }
            await save(state, expected);
            if (completed) throw new Error("Injected after state save");
          };
        }
        if (boundary === "source-only-advance") {
          ok(proposed.diff);
          equal(
            proposed.diff.base.repositoryVersion,
            prior.version.repositoryVersion,
          );
          await service.decideChange(input);
          await drainDecisionRefusal(durable, (error: unknown) => {
            ok(error instanceof ChangePublicationError);
            equal(error.code, "PUBLICATION_NOT_APPLICABLE");
            equal(error.recovery, "refuse");
            ok(error.message.includes("source base differs"));
          });
          const advanced = await model.readExecutableModel(prior.identity);
          equal(advanced.version.digest, prior.version.digest);
          ok(
            advanced.version.repositoryVersion !==
              prior.version.repositoryVersion,
          );
          deepStrictEqual(
            service.snapshot.configuration!.changes[0],
            proposed,
          );
          deepStrictEqual(
            (await durable.storage.state.load())!.configuration!.changes[0],
            proposed,
          );
          deepStrictEqual(
            service.snapshot.executionModel!.version,
            prior.version,
          );
          equal(service.snapshot.busy, false);
          equal(service.snapshot.phase, "Décision interrompue");
        } else if (boundary === "publication-return") {
          // Regression: the post-approve resumption tolerates the advance its
          // own approved command produced. No pin-mismatch retry storm may
          // fail the resumption, and the decision journals exactly one
          // command completion receipt.
          const workerErrorsBefore = durable.workerErrors.length;
          const eventsBefore = service.snapshot.events.length;
          await service.decideChange(input);
          await drainDecisionCompletion(durable, proposed.id, "approved");
          equal(
            durable.workerErrors.slice(workerErrorsBefore).filter((error) =>
              String(
                error instanceof Error ? error.message : String(error),
              ).includes("EXECUTION_DELIVERY_MODEL_PIN_MISMATCH")
            ).length,
            0,
          );
          equal(
            service.snapshot.events.slice(eventsBefore).filter((event) =>
              event.id.startsWith("operator-command-completed:")
            ).length,
            1,
          );
        } else {
          await service.decideChange(input);
          await drainDecisionRefusal(
            durable,
            (error: unknown) => {
              ok(
                /Injected|revision|concurrent/i.test(
                  error instanceof Error ? error.message : String(error),
                ),
                String(error),
              );
            },
          );
        }
        const publication = await repository.findPublication(proposed.id);
        equal(
          Boolean(publication),
          !["before-publication", "source-only-advance"].includes(boundary),
        );
        if (publication) {
          equal(
            publication.receipt!.adoptedPin.repositoryVersion,
            prior.version.repositoryVersion,
          );
          equal(
            publication.receipt!.authorityExercise.baseModelDigest,
            prior.version.digest,
          );
        }
        stateStore.save = save;
        if (boundary === "moved-pin") {
          repository.beforePublish = undefined;
          // The strict adoption gate refuses the revocation pin below while
          // the phase-1 proposal is still pending, so the already-published
          // phase-1 approval is reconciled by a restart first: a new worker
          // command would trip the native-pin fence while HEAD moved past
          // the admitted pin. Only then is the moved pin adopted below.
          service = (await reopenMandateSession(
            durable,
            new FileRepository(sourcesDirectory),
            { initialSources },
          )).service;
          equal(
            service.snapshot.configuration!.changes[0].status,
            "approved",
          );
          const head = await repository.current();
          // Exact revocation: same executable digest, different immutable pin.
          await repository.publishSystemSources(
            initialSources,
            head.version,
            "revocation",
          );
          const replacement = await model.readExecutableModel(prior.identity);
          equal(replacement.version.digest, prior.version.digest);
          await service.adoptModelVersion({
            expectedDigest: replacement.version.digest,
          });
        }
        const reopened = new FileRepository(sourcesDirectory);
        service = (await reopenMandateSession(durable, reopened, {
          initialSources,
        })).service;
        const restarted = service;
        if (boundary === "approval-completion-save") {
          equal(restarted.snapshot.availableExecutionModel, undefined);
          equal(restarted.snapshot.error, "Injected before state save");
          // The atomic save is lost after the adoption: unlike the removed
          // completion-save crash site (pre-adoption, interrupted phase), the
          // restart resumption completes the approval bare and reports ready.
          equal(restarted.snapshot.phase, "Prêt à discuter");
        }
        if (["before-publication", "source-only-advance"].includes(boundary)) {
          equal(restarted.snapshot.configuration!.changes[0].status, "pending");
          equal(
            restarted.snapshot.configuration!.changes[0].publication,
            undefined,
          );
          equal(
            restarted.snapshot.configuration!.changes[0].authorityExercise,
            undefined,
          );
          equal(await reopened.findPublication(proposed.id), null);
          deepStrictEqual(
            restarted.snapshot.executionModel!.version,
            prior.version,
          );
          const headBeforeRefusal = (await reopened.current()).version;
          await restarted.decideChange({ ...input, verdict: "refuse" });
          await drainDecisionCompletion(durable, proposed.id, "refused");
          equal(restarted.snapshot.configuration!.changes[0].status, "refused");
          equal(
            (await durable.storage.state.load())!.configuration!.changes[0]
              .status,
            "refused",
          );
          equal((await reopened.current()).version, headBeforeRefusal);
          equal(await reopened.findPublication(proposed.id), null);
          equal(
            (await reopened.history()).commits.length,
            boundary === "source-only-advance" ? 2 : 1,
          );
        } else {
          const completed = restarted.snapshot.configuration!.changes[0];
          equal(completed.status, "approved");
          equal(completed.publication, undefined);
          deepStrictEqual(
            completed.authorityExercise,
            publication!.receipt!.authorityExercise,
          );
          equal(completed.decidedAt, publication!.receipt!.decidedAt);
          const pinned = restarted.snapshot.executionModel!;
          equal(
            pinned.version.repositoryVersion,
            boundary === "moved-pin"
              ? (await reopened.current()).version
              : publication!.revision.version,
          );
          equal(
            pinned.configuration.network!.allowedHosts.includes(
              "recovery.example",
            ),
            boundary !== "moved-pin",
          );
          const beforeRetry = restarted.snapshot;
          await restarted.decideChange(input);
          await drainDecisionCompletion(durable, proposed.id, "approved");
          deepStrictEqual(
            restarted.snapshot.configuration,
            beforeRetry.configuration,
          );
          // The idempotent replay issues no second publication: the journal
          // grows only by the new command completion receipt.
          const replayed = restarted.snapshot.events.slice(
            beforeRetry.events.length,
          );
          // The idempotent replay issues no second publication: the journal
          // grows by exactly one command completion receipt, plus the
          // native-use edges of its dialogue resumption turn.
          equal(
            replayed.filter((event) =>
              event.id.startsWith("operator-command-completed:")
            ).length,
            1,
          );
          ok(
            replayed.every((event) =>
              event.id.startsWith("operator-command-completed:") ||
              event.id.startsWith("native:")
            ),
          );
          equal(
            (await reopened.history()).commits.filter((c) =>
              c.author === `ase:approved-change:${proposed.id}`
            ).length,
            1,
          );
        }
      } finally {
        await drainMandateQueue(durable);
        await durable.recovery.close();
        await Deno.remove(directory, { recursive: true });
      }
    },
  });
}

for (
  const entry of [
    "http",
    "http-handler",
    "operator",
    "runtime",
    "legacy-http",
    "legacy-handler",
  ] as const
) {
  for (const published of [true] as const) {
    Deno.test({
      name:
        `T6: ${entry} reconciles before stale-base decisions, published=${published}`,
      ignore: !mandateRecoveryEnabled,
      async fn() {
        const directory = await Deno.makeTempDir();
        const repository = new FileRepository(directory);
        const initialSources = await loadInitialSources(undefined, {
          information: false,
        });
        const durable = await openMandateDurableSession({
          repository,
          initialSources,
        });
        const model = durable.model;
        let manager: OperatorConversations | undefined;
        let server: Deno.HttpServer<Deno.NetAddr> | undefined;
        try {
          let { service, proposed } = await proposeMandateChange(durable);
          const input = {
            changeId: proposed.id,
            expectedRevision: proposed.baseRevision,
            verdict: "approve" as const,
          };
          const stateStore = durable.storage.state;
          const save = stateStore.save.bind(stateStore);
          if (published) {
            stateStore.save = (state, expected) => {
              if (state.configuration?.changes[0]?.status === "approved") {
                throw new Error("Lost closure save");
              }
              return save(state, expected);
            };
          } else {
            repository.beforePublish = () =>
              Promise.reject(new Error("Before publication"));
          }
          // decideChange only enqueues: the injected failure surfaces on the
          // durable worker and is read back from the worker error.
          await service.decideChange(input);
          await drainDecisionRefusal(durable, (error: unknown) => {
            ok(
              /Lost closure save|Before publication/.test(
                error instanceof Error ? error.message : String(error),
              ),
              String(error),
            );
          });
          stateStore.save = save;
          repository.beforePublish = undefined;
          // Settle the injected phase-1 refusal (and its retries) before
          // touching the model pin: a running worker trips the adoption
          // fence, and later drains must only observe the decided commands.
          await drainMandateQueue(durable);
          // The strict adoption gate refuses a moved pin while the phase-1
          // proposal is still pending, so the stale proposal is decided
          // first, per this scenario's original intent, before any adoption.
          if (published) {
            // The approval already published before its closure save was
            // lost: a restart reconciles that publication and completes the
            // stale proposal. A new worker command cannot do it: HEAD moved
            // past the admitted pin, so the command fence trips before the
            // recovery lookup runs.
            ({ service } = await reopenMandateSession(durable, repository, {
              initialSources,
            }));
            const reconciled = service.snapshot.configuration!.changes[0];
            equal(reconciled.status, "approved");
            const reconciledPublication = await repository.findPublication(
              proposed.id,
            );
            ok(reconciledPublication?.receipt);
            deepStrictEqual(
              reconciled.authorityExercise,
              reconciledPublication.receipt.authorityExercise,
            );
            equal(
              reconciled.decidedAt,
              reconciledPublication.receipt.decidedAt,
            );
          } else {
            // The approval never published: the stale proposal is refused, so
            // the manual adoption below has no pending change to protect.
            await service.decideChange({ ...input, verdict: "refuse" });
            await drainDecisionCompletion(durable, proposed.id, "refused");
          }
          await drainMandateQueue(durable);
          const head = await repository.current();
          await repository.publishSystemSources(
            {
              ...initialSources,
              "configuration.sysml": initialSources["configuration.sysml"]
                .replace(
                  'configurationRevision : String = "0"',
                  'configurationRevision : String = "1"',
                ),
            },
            head.version,
            "manual-adoption",
          );
          const replacement = await model.readExecutableModel(
            service.snapshot.model!,
          );
          await service.adoptModelVersion({
            expectedDigest: replacement.version.digest,
          });
          equal(
            service.snapshot.configuration!.revision,
            proposed.baseRevision + 1,
          );
          equal(
            service.snapshot.configuration!.changes[0].status,
            published ? "approved" : "refused",
          );
          const pin = service.snapshot.executionModel!.version;
          // Re-propose at the adopted pin; the per-transport decisions below
          // run against the fresh proposal.
          ({ service, proposed } = await proposeMandateChange(durable));
          equal(service.snapshot.configuration!.changes[0].status, "pending");
          deepStrictEqual(service.snapshot.executionModel!.version, pin);
          if (!published) {
            // The stale-base refusal below needs a base older than HEAD: the
            // adoption above already settled, so a source-only advance (never
            // adopted) re-creates the exact staleness the original scenario
            // asserted, without tripping the adoption gate.
            const advanceHead = await repository.current();
            await repository.publishSystemSources(
              {
                ...advanceHead.sources,
                "authority.sysml": advanceHead.sources["authority.sysml"] +
                  "\n",
              },
              advanceHead.version,
              "source-only",
            );
          }
          manager = new OperatorConversations({
            primary: service,
            factory: {
              open: () => {
                throw new Error("No peer");
              },
            },
          });
          await manager.initialize({
            repositoryVersion: pin.repositoryVersion!,
            units: [{
              systemQualifiedName: "LiveBuilder::system",
              model: service.snapshot.executionModel!,
            }],
          });
          if (entry === "http" || entry === "legacy-http") {
            server = Deno.serve(
              { hostname: "127.0.0.1", port: 0, onListen() {} },
              async (request) =>
                await handleConversations(request) ??
                  await handleControl(request) ??
                  new Response(null, { status: 404 }),
            );
          }
          const servedOrigin = `http://127.0.0.1:${server?.addr.port ?? 4311}`;
          const handleConversations = createConversationsHandler(
            manager,
            servedOrigin,
          );
          const handleControl = createControlHandler(
            service,
            manager,
            servedOrigin,
          );
          // Every transport only accepts the decision: the worker outcome
          // (approval or refusal) is observed by draining, then read back
          // from the worker error and the canonical journal.
          const decide = async (verdict: "approve" | "refuse") => {
            if (entry === "runtime") {
              await service.decideChange({
                changeId: proposed.id,
                expectedRevision: proposed.baseRevision,
                verdict,
              });
              return;
            }
            const command = {
              agentId: service.snapshot.model!.builderId,
              changeId: proposed.id,
              expectedRevision: service.snapshot.revision,
              configurationRevision: proposed.baseRevision,
              verdict,
            };
            if (entry === "operator") {
              await manager!.decideChange(command);
              return;
            }
            const legacy = entry === "legacy-http" ||
              entry === "legacy-handler";
            const path = legacy
              ? "/api/decisions"
              : `/api/conversations/${
                encodeURIComponent(command.agentId)
              }/changes/${proposed.id}/decision`;
            const body = legacy
              ? {
                kind: "change",
                changeId: proposed.id,
                expectedRevision: command.expectedRevision,
                verdict,
              }
              : {
                expectedRevision: command.expectedRevision,
                configurationRevision: proposed.baseRevision,
                verdict,
              };
            const request = new Request(
              `${servedOrigin}${path}`,
              {
                method: "POST",
                headers: {
                  host: new URL(servedOrigin).host,
                  origin: servedOrigin,
                  "content-type": "application/json",
                },
                body: JSON.stringify(body),
              },
            );
            const response = server
              ? await fetch(request)
              : (await handleConversations(request) ??
                await handleControl(request))!;
            const result = await response.json();
            equal(response.status, 202, JSON.stringify(result));
            equal(result.accepted, true);
          };
          const journalRefusal = (expectedCode: string) => (error: unknown) => {
            ok(error instanceof ChangePublicationError);
            equal(error.code, expectedCode);
            equal(error.context.changeId, proposed.id);
            equal(
              error.context.systemId,
              service.snapshot.model!.systemId,
            );
          };
          if (published) {
            await decide("approve");
            await drainDecisionCompletion(durable, proposed.id, "approved");
            await decide("refuse");
            await drainDecisionRefusal(
              durable,
              (error: unknown) => {
                journalRefusal("PUBLICATION_ALREADY_APPLIED")(error);
                ok(error instanceof ChangePublicationError);
                deepStrictEqual(error.recovery, { action: "reload" });
              },
            );
            ok(
              service.snapshot.events.some((event) =>
                event.kind === "control-failed"
              ),
              "The worker refusal must be journalled",
            );
            equal(
              service.snapshot.configuration!.changes[0].status,
              "approved",
            );
          } else {
            await decide("approve");
            await drainDecisionRefusal(
              durable,
              journalRefusal("PUBLICATION_NOT_APPLICABLE"),
            );
            await decide("refuse");
            await drainDecisionCompletion(durable, proposed.id, "refused");
            equal(service.snapshot.configuration!.changes[0].status, "refused");
            equal(
              SystemGovernance.fromExecutable(
                service.snapshot.executionModel!,
                service.snapshot.configuration!.changes,
              ).propose(
                {
                  kind: "propose_mandate_change",
                  text: "Next",
                  reason: "Next",
                  requestedRights: { addNetworkHosts: ["next.example"] },
                },
                crypto.randomUUID(),
                "later",
                {
                  requestedBy:
                    service.snapshot.executionModel!.identity.builderId,
                  designerScopeId: "recovery-test:designer",
                },
              ).status,
              "pending",
            );
          }
          if (published) {
            // The fresh approval adopted its own publication: the pin moved
            // from the manually adopted revision to the new publication.
            const latest = await repository.findPublication(proposed.id);
            ok(latest);
            equal(
              service.snapshot.executionModel!.version.repositoryVersion,
              latest.revision.version,
            );
          } else {
            deepStrictEqual(service.snapshot.executionModel!.version, pin);
          }
          equal(
            (await repository.history()).commits.length,
            published ? 4 : 3,
          );
        } finally {
          await server?.shutdown();
          await manager?.dispose();
          await drainMandateQueue(durable);
          await durable.recovery.close();
          await Deno.remove(directory, { recursive: true });
        }
      },
    });
  }
}

Deno.test({
  name:
    "P1: approval of a real-conversation mandate proposal resumes its dialogue with exactly one completion receipt",
  ignore: !mandateRecoveryEnabled,
  async fn() {
    const directory = await Deno.makeTempDir();
    const sourcesDirectory = `${directory}/sources`;
    await Deno.mkdir(sourcesDirectory);
    const repository = new FileRepository(sourcesDirectory);
    const initialSources = await loadInitialSources(undefined, {
      information: false,
    });
    const durable = await openMandateDurableSession({
      repository,
      initialSources,
    });
    try {
      // The proposing conversation runs through the real runtime: the mandate
      // agent files its proposal on the first turn and the dialogue parks
      // awaiting the decision, keeping its native run under the old pin.
      const caseId = await durable.service.submit(
        "Request one host.",
        undefined,
        undefined,
        true,
      );
      ok(caseId);
      await durable.session.idle(durable.service);
      const filed = (await durable.storage.state.load())!;
      equal(filed.configuration!.changes.length, 1);
      const proposed = filed.configuration!.changes[0];
      equal(proposed.status, "pending");
      equal(proposed.caseId, caseId);
      const eventsBefore = durable.service.snapshot.events.length;
      await durable.service.decideChange({
        changeId: proposed.id,
        expectedRevision: proposed.baseRevision,
        verdict: "approve",
      });
      await drainDecisionCompletion(durable, proposed.id, "approved");
      // Dialogue completion: the resumed conversation acknowledges the grant.
      const settled = (await durable.storage.state.load())!;
      equal(settled.error, undefined);
      equal(settled.busy, false);
      ok(
        settled.messages.some((message) =>
          message.role === "assistant" && message.text === "Done."
        ),
        "The resumed dialogue must complete with the acknowledgement reply",
      );
      // Exactly one canonical command completion receipt for the decision.
      equal(
        durable.service.snapshot.events.slice(eventsBefore).filter((event) =>
          event.id.startsWith("operator-command-completed:")
        ).length,
        1,
      );
    } finally {
      await drainMandateQueue(durable);
      await durable.recovery.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
