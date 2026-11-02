/** Real isolated SQL lineage with synthetic Git/queue/control read adapters.
 * This qualifies composition boundaries only, not real Git/native effects. */
import assert from "node:assert/strict";
import { createRequestSourceAdmissionComposition } from "../../src/composition/request-source-admission.ts";
import { PostgresPrimarySpaceControlSource } from "../../src/adapters/out/postgres/primary-space-control-source.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import {
  type AdmittedSourceHead,
  PostgresRequestSourceAdmissionStore,
} from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import { PostgresRequestSourcePublicationParticipant } from "../../src/adapters/out/postgres/request-source-publication-participant.ts";
import type {
  RequestSourcePublicationContext,
  RequestSourceTargetOptions,
} from "../../src/application/model/publication/ports/out/request-source-publication.port.ts";
import type {
  RequestSourceProposalLocator,
  RequestSourceStoredProposal,
} from "../../src/application/model/source-admission/revision-ports.ts";
import {
  buildModelWriteDossierV2,
  modelWriteCommandDigestV2,
  modelWriteDossierDigestV2,
} from "../../src/application/model/publication/write-command-v2.ts";
import type { RequestModelWriteDestination } from "../../src/domain/model/editing/request-write-destination.ts";
import {
  parseRequestSourceOwnerAuthority,
  requestSourceOwnerAuthorityDigest,
  type RequestSourceOwnerAuthorityEnvelope,
  type RequestSourceOwnerPhaseBinding,
} from "../../src/application/model/source-admission/request-source-owner.ts";
import { parseRequestSourceAdmission } from "../../src/application/model/source-admission/request-source-admission.ts";
import {
  requestSpaceDigest,
  type SpaceController,
} from "../../src/domain/work/request-spaces.ts";
import type { ModelIdentity } from "../../src/domain/work/dialogue.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { admissionFixture } from "../support/request-source-admission-fixture.ts";
import {
  requestControlBinding,
  requestOpeningBase,
  requestSpaceScope as scope,
  spaceControlAuthority,
  spaceUuid,
} from "../support/request-space-fixture.ts";

async function fixture({ client }: PostgresTestDatabase) {
  await seedPostgresRuntime(client, {
    ...scope,
    executionSpaceId: "main",
    operatorId: "operator",
  });
  const openings = new PostgresRequestSpaceStore(client, scope),
    store = new PostgresRequestSourceAdmissionStore(client);
  const command = {
    openingKey: "composition",
    text: "Historical source composition",
    source: { kind: "current-main" as const },
  };
  const allocated = await openings.begin({
    ownerId: "owner",
    command,
    commandDigest: await requestSpaceDigest({
      scope,
      ownerId: "owner",
      command,
    }),
  });
  const base = await requestOpeningBase("c"),
    repositoryId = base.manifest.source!.repositoryId;
  let opening = await openings.selectBase({
    id: allocated.id,
    ownerId: "owner",
    expectedRevision: allocated.revision,
    base,
    baseDigest: await requestSpaceDigest(base),
  });
  opening = await openings.advance({
    id: opening.id,
    ownerId: "owner",
    expectedRevision: opening.revision,
    from: "source-selected",
    to: "branch-ready",
  });
  opening = await openings.advance({
    id: opening.id,
    ownerId: "owner",
    expectedRevision: opening.revision,
    from: "branch-ready",
    to: "runtime-ready",
  });
  await client.sourceRepository.create({
    data: { ...scope, repositoryId, sourceScopeId: scope.systemId },
  });
  const primary = new PostgresPrimarySpaceControlSource(client, {
    ...requestControlBinding,
    primaryOperatorId: "operator",
  });
  const controller: SpaceController = {
    ownerId: "owner",
    capabilityId: "not-live-capability",
    capabilityRevision: 0,
    sessionId: "current-read-session",
    authority: spaceControlAuthority(),
  };
  const data = {
    authentication: 0,
    revalidations: 0,
    runtimeReads: 0,
    sourceReads: 0,
    revoked: false,
    targets: [] as RequestSourceTargetOptions[],
    stored: null as RequestSourceStoredProposal | null,
    proposalLocators: [] as RequestSourceProposalLocator[],
    events: [] as string[],
    onReconcile: undefined as
      | ((context: RequestSourcePublicationContext) => Promise<void>)
      | undefined,
  };
  const composition = createRequestSourceAdmissionComposition({
    storage: {
      client,
      scope,
      primarySpaceControl: primary,
      readCaseRuntimeState() {
        data.runtimeReads++;
        throw new Error(
          "Historical composition may not inspect current runtime",
        );
      },
    },
    controls: {
      authenticateSession() {
        data.authentication++;
        if (data.revoked) throw new Error("Current read channel revoked");
        return Promise.resolve(structuredClone(controller));
      },
      revalidate() {
        data.revalidations++;
        if (data.revoked) throw new Error("Current read channel revoked");
        return Promise.resolve();
      },
    },
    repositoryId,
    leaseMs: 1234,
    reader() {
      data.sourceReads++;
      throw new Error(
        "Historical structural binding may not compile or read Git",
      );
    },
    requestSourceTarget(options) {
      data.targets.push(options);
      return {
        destination: options.destination,
        current() {
          throw new Error("No raw HEAD read");
        },
        proposal() {
          throw new Error("No Main proposal read");
        },
        propose() {
          throw new Error("No new effect in structural fixture");
        },
        bind(dossier) {
          assert.deepEqual(dossier.command.destination, options.destination);
          return Promise.resolve({
            destination: options.destination,
            at() {
              throw new Error("No source read in structural fixture");
            },
            current() {
              throw new Error("No raw HEAD fallback");
            },
            proposal() {
              throw new Error("No Main lookup");
            },
            recover: () => Promise.resolve(null),
            accept() {
              throw new Error("No Git effect in structural fixture");
            },
          });
        },
      };
    },
    readRequestSourceProposal(locator) {
      data.proposalLocators.push(structuredClone(locator));
      return Promise.resolve(structuredClone(data.stored));
    },
    queue: {
      transition(_lease, to) {
        data.events.push(`transition:${to}`);
        return Promise.resolve();
      },
      async reconcileRequestPublication(_lease, leaseMs, context) {
        assert.equal(leaseMs, 1234);
        data.events.push("reconcile");
        await data.onReconcile?.(context);
      },
      async guardRequestPublication(_lease, leaseMs, _context, operation) {
        assert.equal(leaseMs, 1234);
        data.events.push("guard:new");
        return await operation();
      },
    },
  });
  const append = (context: RequestSourcePublicationContext) =>
    client.$transaction((tx) =>
      store.compareAndAppend(tx, opening, context.admission)
    );
  const head = async () => (await composition.admittedSource(opening)).head;
  async function evidence(
    id: number,
    givenPrior?: AdmittedSourceHead,
    next = "d",
    change: {
      destination?: RequestModelWriteDestination;
      ownerId?: string;
      digest?: string;
      identity?: Partial<ModelIdentity>;
    } = {},
  ) {
    const prior = givenPrior ?? await head();
    const priorDigest =
      (await composition.admittedSource(opening)).receipts.find((entry) =>
        entry.revision === prior.revision
      )?.payload.result.model.digest ?? base.manifest.operators[0].modelDigest;
    const raw = await admissionFixture(
      opening,
      prior,
      spaceUuid(id),
      next,
      priorDigest,
    );
    const destination = change.destination ?? raw.destination;
    const phase = (value: RequestSourceOwnerPhaseBinding) => ({
      ...value,
      destination,
      priorModel: {
        identity: { ...value.priorModel.identity, ...change.identity },
        version: {
          digest: change.digest ?? value.priorModel.version.digest,
          repositoryVersion: destination.expectedAdmittedSource.source.version,
        },
      },
      principal: {
        ...value.principal,
        controller: {
          ...value.principal.controller,
          ownerId: change.ownerId ?? value.principal.controller.ownerId,
          authority: {
            ...value.principal.controller.authority,
            scope: destination.host,
          },
        },
      },
      exercise: {
        ...value.exercise,
        baseModelDigest: change.digest ?? value.exercise.baseModelDigest,
      },
    });
    const authority = parseRequestSourceOwnerAuthority({
      v: 1,
      kind: "request-source-owner-authority",
      proposal: phase(
        (raw.authority as RequestSourceOwnerAuthorityEnvelope).proposal,
      ),
      acceptance: phase(
        (raw.authority as RequestSourceOwnerAuthorityEnvelope).acceptance,
      ),
    });
    const dossier = await buildModelWriteDossierV2({
      repositoryId,
      commandId: raw.command.commandId,
      kind: "accept-proposal",
      destination,
      authority,
      operations: {
        kind: "whole-files",
        files: {
          v: 1,
          base: destination.expectedAdmittedSource.source,
          baseSourceDigest: destination.expectedAdmittedSource.sourceDigest,
          files: [{
            path: "models/configuration.sysml",
            baseDigest: "b".repeat(64),
            text: "package Changed;",
          }],
        },
      },
      decision: {
        kind: "accept-proposal",
        proposalId: raw.command.commandId,
        expectedVersion: destination.expectedAdmittedSource.source.version,
        baseVersion: destination.expectedAdmittedSource.source.version,
        proposalSourceDigest: next.repeat(64),
        proposalVersion: "proposal:1",
        author: "local-owner",
        decisionAuthorityExercise: authority.acceptance.exercise,
      },
      recipeDigest: raw.result.build.recipe.digest,
    });
    const admission = await parseRequestSourceAdmission({
      ...raw,
      destination,
      predecessor: {
        ...destination.expectedAdmittedSource,
        manifestDigest: prior.manifestDigest,
      },
      command: dossier.command,
      commandDigest: await modelWriteCommandDigestV2(dossier.command),
      dossierDigest: await modelWriteDossierDigestV2(dossier),
      decisionDigest: dossier.command.decisionRef.digest,
      authority,
      authorityDigest: await requestSourceOwnerAuthorityDigest(authority),
      result: {
        ...raw.result,
        model: {
          ...raw.result.model,
          identity: authority.acceptance.priorModel.identity,
        },
      },
    });
    return { dossier, admission };
  }
  const lease = (context: RequestSourcePublicationContext) => ({
    repositoryId,
    commandId: context.dossier.command.commandId,
    owner: "worker",
    fence: 1,
    expiresAt: "2099-01-01T00:00:00Z",
  });
  return {
    composition,
    data,
    opening,
    client,
    repositoryId,
    controller,
    head,
    evidence,
    append,
    lease,
  };
}

Deno.test({
  name:
    "composition resolves immutable historical A0 before Git without current credentials, runtime or open lifecycle",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database),
        first = await f.evidence(701),
        baseline = await f.head();
      await f.append(first);
      await f.append(await f.evidence(702, await f.head(), "f"));
      await f.client.executionSpace.update({
        where: {
          projectId_systemId_executionSpaceId: {
            ...scope,
            executionSpaceId: f.opening.executionSpaceId,
          },
        },
        data: { lifecycle: "closed", closedAt: new Date() },
      });
      f.data.revoked = true;
      await f.composition.resolver.resolve(first.dossier);
      assert.equal(f.data.targets.length, 1);
      assert.deepEqual(
        f.data.targets[0].destination,
        first.dossier.command.destination,
      );
      assert.equal(
        f.data.targets[0].predecessorManifestDigest,
        baseline.manifestDigest,
      );
      assert.equal(f.data.targets[0].openingBaseDigest, f.opening.baseDigest);
      assert.equal(
        f.data.authentication + f.data.revalidations + f.data.runtimeReads +
          f.data.sourceReads,
        0,
      );
      assert.ok(
        f.composition.participant instanceof
          PostgresRequestSourcePublicationParticipant,
      );
      await assert.rejects(
        () =>
          f.composition.targetForProposal(
            (first.dossier.authority as RequestSourceOwnerAuthorityEnvelope)
              .proposal,
          ),
        "new proposals cannot substitute an old predecessor for current A1",
      );
      assert.equal(f.data.targets.length, 1);
    });
  },
});

Deno.test({
  name:
    "composition refuses coherent foreign destination, owner, model and absent predecessor before Git binding",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database),
        valid = await f.evidence(710),
        d = valid.dossier.command.destination;
      const variants = [
        {
          destination: { ...d, host: { ...d.host, systemId: "foreign-host" } },
        },
        { destination: { ...d, openingId: spaceUuid(9990) } },
        {
          destination: {
            ...d,
            branchId: spaceUuid(9991),
            ref: `refs/heads/requests/${spaceUuid(9991)}`,
          },
        },
        { ownerId: "foreign-owner" },
        { digest: "f".repeat(64) },
        { identity: { systemQualifiedName: "Foreign::system" } },
        {
          destination: {
            ...d,
            expectedAdmittedSource: {
              ...d.expectedAdmittedSource,
              revision: 9,
            },
          },
        },
      ];
      for (const change of variants) {
        const context = await f.evidence(711, await f.head(), "d", change);
        await assert.rejects(() =>
          f.composition.resolver.resolve(context.dossier)
        );
        assert.equal(f.data.targets.length, 0);
      }
      assert.equal(
        f.data.authentication + f.data.revalidations + f.data.runtimeReads +
          f.data.sourceReads,
        0,
      );
    });
  },
});

Deno.test({
  name:
    "historical leased settlement transitions then reconciles; no-lease resume only verifies the original exact D2 receipt",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database), context = await f.evidence(720);
      await f.composition.resolver.resolve(context.dossier);
      const protocol = f.data.targets[0].protocol;
      f.data.revoked = true;
      await assert.rejects(() => protocol.settleHistorical(context));
      assert.deepEqual(f.data.events, []);
      const before = await f.composition.admittedSource(f.opening);
      assert.equal(
        before.receipts.length,
        0,
        "read-only resume cannot backfill",
      );
      f.data.onReconcile = async (receipt) => {
        await f.append(receipt);
      };
      await protocol.settleHistorical(context, f.lease(context));
      assert.deepEqual(f.data.events, ["transition:publishing", "reconcile"]);
      await f.append(await f.evidence(721, await f.head(), "f"));
      const original = await f.composition.admittedSource(f.opening);
      await protocol.settleHistorical(context);
      await protocol.settleHistorical(context);
      assert.deepEqual(
        await f.composition.admittedSource(f.opening),
        original,
        "exact replay preserves the database receipt/timestamp",
      );
      assert.deepEqual(f.data.events, ["transition:publishing", "reconcile"]);
      const changed = {
        ...context,
        admission: {
          ...context.admission,
          publication: {
            ...context.admission.publication,
            receiptDigest: "e".repeat(64),
          },
        },
      };
      await assert.rejects(() => protocol.settleHistorical(changed));
      await assert.rejects(() =>
        protocol.settleHistorical(context, {
          ...f.lease(context),
          commandId: spaceUuid(9992),
        })
      );
      assert.equal(
        f.data.authentication + f.data.revalidations + f.data.runtimeReads +
          f.data.sourceReads,
        0,
      );
    });
  },
});

Deno.test({
  name:
    "new publication uses the existing typed guard while real D1 current credentials still refuse an unissued channel",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database), context = await f.evidence(730);
      await f.composition.resolver.resolve(context.dossier);
      const protocol = f.data.targets[0].protocol,
        result: ModelRevision = {
          version: context.admission.result.source.version,
          sourceDigest: context.admission.result.sourceDigest,
          sources: {},
          elements: [],
          documents: [],
          semanticDigest: "5".repeat(64),
          provenanceDigest: "6".repeat(64),
          sourceHashes: {},
          engineVersion: "fixture",
        };
      let effects = 0;
      assert.equal(
        await protocol.guardNewPublication(f.lease(context), context, () => {
          effects++;
          return Promise.resolve(result);
        }),
        result,
      );
      assert.deepEqual(f.data.events, ["guard:new"]);
      assert.equal(effects, 1);
      // The queue above is a dispatch double, not an authority guard. Actual D1
      // is instantiated in the factory and cannot authenticate this fake receipt.
      await assert.rejects(() => protocol.assertNewEffect(context.dossier));
      assert.equal(f.data.sourceReads + f.data.runtimeReads, 0);
    });
  },
});

Deno.test({
  name:
    "owned closed-history read keeps original proposal binding and current read authorization separate",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database), original = await f.evidence(740);
      await f.append(original);
      await f.client.executionSpace.update({
        where: {
          projectId_systemId_executionSpaceId: {
            ...scope,
            executionSpaceId: f.opening.executionSpaceId,
          },
        },
        data: { lifecycle: "closed", closedAt: new Date() },
      });
      f.data.stored = {
        destination: original.dossier.command.destination,
        authority:
          (original.dossier.authority as RequestSourceOwnerAuthorityEnvelope)
            .proposal,
        record: {
          id: original.dossier.command.commandId,
          branch: `proposal_${original.dossier.command.commandId}`,
          author: "local-owner",
          reason: "Original",
          baseVersion: original.dossier.command.approvedBase.version,
          createdAt: "2026-10-30T00:00:00Z",
          status: "proposed",
          validation: "validated",
          sourceDigest: "d".repeat(64),
          proposalVersion: "proposal:1",
          diff: [],
        },
      };
      const controller = await f.composition.access.authorizeRead(
        "not-logged",
        f.opening.caseId,
      );
      const stored = await f.composition.readProposal(
        controller,
        f.opening.caseId,
        original.dossier.command.commandId,
      );
      assert.deepEqual(stored, f.data.stored);
      assert.equal(stored!.destination.expectedAdmittedSource.revision, 1);
      assert.equal(
        stored!.authority.principal.controller.sessionId,
        (original.dossier.authority as RequestSourceOwnerAuthorityEnvelope)
          .proposal.principal.controller.sessionId,
      );
      assert.notEqual(
        stored!.authority.principal.controller.sessionId,
        controller.sessionId,
      );
      assert.equal(
        Object.hasOwn(f.data.proposalLocators[0], "expectedAdmittedSource"),
        false,
      );
      assert.equal(f.data.proposalLocators[0].caseId, f.opening.caseId);
      f.data.revoked = true;
      const reads = f.data.proposalLocators.length;
      await assert.rejects(() =>
        f.composition.readProposal(
          controller,
          f.opening.caseId,
          original.dossier.command.commandId,
        )
      );
      assert.equal(
        f.data.proposalLocators.length,
        reads,
        "revoked current read refuses before Git journal lookup",
      );
      assert.equal(f.data.runtimeReads + f.data.sourceReads, 0);
    });
  },
});
