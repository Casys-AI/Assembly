/** Real SQL control/source fences with synthetic D2 evidence, no Git/native effect claim. */
import assert from "node:assert/strict";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import type { Prisma } from "../../src/adapters/out/postgres/client.ts";
import type { PostgresPrimarySpaceControlSource } from "../../src/adapters/out/postgres/primary-space-control-source.ts";
import { PostgresSpaceCredentials } from "../../src/adapters/out/postgres/request-space-control-store.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import {
  PostgresRequestSourceAdmissionStore,
  requestReleaseSourceEvidence,
} from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import {
  PostgresReleaseCreationGuard,
  type ReleaseCreationPhase,
} from "../../src/adapters/out/postgres/release-creation-guard.ts";
import { PostgresSavedSystemStore } from "../../src/adapters/out/postgres/saved-system-store.ts";
import { ModeledSpaceControlAuthority } from "../../src/application/work/request-spaces/space-control-authority.ts";
import { CryptographicSpaceSecrets } from "../../src/adapters/work/space-control-secrets.ts";
import { SpaceControls } from "../../src/application/work/request-spaces/control.ts";
import { ReleaseCreationAuthority } from "../../src/application/work/saved-systems/creation-authorization.ts";
import type { ReleaseRetentionAuthorization } from "../../src/domain/work/release-retention.ts";
import {
  savedManifest,
  type SavedSystemCapture,
  savedSystemDigest,
  SavedSystemError,
} from "../../src/domain/work/saved-systems.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces.ts";
import { admissionFixture } from "../support/request-source-admission-fixture.ts";
import {
  requestControlBinding,
  requestControlState,
  requestOpeningBase,
  requestSpaceScope as host,
  spaceControlAuthority,
  spaceUuid,
} from "../support/request-space-fixture.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";

const forbidden = (error: unknown) =>
  error instanceof SavedSystemError && error.code === "FORBIDDEN";
Deno.test({
  name:
    "Evolved Release first acceptance fences the source head, historical retry survives A2 and closure, current revocation still refuses",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const storage = new PostgresHostStorage(postgresClientConfiguration(
        database.connectionString,
        3,
        database.schema,
      ));
      database.registerCleanup(() => storage.close());
      await storage.registerSystem(host);
      const primary: PostgresPrimarySpaceControlSource = storage
        .bindPrimarySpaceControl({
          primaryOperatorId: "operator",
          sourceSystemNativeId: requestControlBinding.sourceSystemNativeId,
        });
      const main = await storage.operator("operator");
      const retentionAuthority = spaceControlAuthority();
      retentionAuthority.acts.push("retain-release");
      retentionAuthority.policyRevision++;
      retentionAuthority.sourceVersion = `commit:${"b".repeat(40)}`;
      retentionAuthority.modelDigest = "b".repeat(64);
      // Seed an explicitly modeled retention policy before issuing credentials.
      // The shared three-act fixture deliberately confers no retention right.
      await main.state.save(requestControlState(retentionAuthority), null);
      const client = storage.client;
      const controls = new SpaceControls(
        new PostgresSpaceCredentials(client, primary),
        new ModeledSpaceControlAuthority(primary, primary.binding),
        new CryptographicSpaceSecrets(),
      );
      const capability = await controls.issueCapability("owner");
      const session = await controls.exchange(capability.secret);
      const controller = await controls.authenticateSession(session.secret);
      assert.equal(controller.authority.acts.includes("retain-release"), true);
      assert.equal(
        controller.authority.policyRevision,
        retentionAuthority.policyRevision,
      );
      const creation = new ReleaseCreationAuthority(controls);
      const guard = new PostgresReleaseCreationGuard(client, primary);
      const store = new PostgresSavedSystemStore(client, guard);
      const openings = new PostgresRequestSpaceStore(client, host);
      const openingCommand = {
        openingKey: "evolved-release-origin",
        text: "Keep source and execution distinct",
        source: { kind: "current-main" as const },
      };
      let opening = await openings.begin({
        ownerId: "owner",
        command: openingCommand,
        commandDigest: await requestSpaceDigest({
          scope: host,
          ownerId: "owner",
          command: openingCommand,
        }),
      });
      const base = await requestOpeningBase("a");
      opening = await openings.selectBase({
        id: opening.id,
        ownerId: "owner",
        expectedRevision: opening.revision,
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
      const scope = { ...host, executionSpaceId: opening.executionSpaceId };
      const originalBase = (await client.spaceOpening.findUniqueOrThrow({
        where: { projectId_systemId_executionSpaceId: scope },
      })).baseJson;
      const journal = new PostgresRequestSourceAdmissionStore(client);
      const read = () =>
        client.$transaction((tx) => journal.readAdmittedSource(tx, opening), {
          isolationLevel: "RepeatableRead",
        });
      const baseline = await read();
      const payloadA1 = await admissionFixture(
        opening,
        baseline.head,
        spaceUuid(801),
        "d",
        base.manifest.operators[0].modelDigest,
      );
      const receiptA1 = await client.$transaction((tx) =>
        journal.compareAndAppend(tx, opening, payloadA1)
      );
      const chainA1 = await read();
      const reference = {
        format: "request-release-admission/v1" as const,
        openingId: opening.id,
        openingBaseDigest: opening.baseDigest!,
        revision: receiptA1.revision,
        manifestDigest: receiptA1.manifestDigest,
      };
      const verified = requestReleaseSourceEvidence(
        opening,
        chainA1,
        reference,
      );
      const capture: SavedSystemCapture = {
        origin: scope,
        source: {
          branch: { kind: "case", caseId: opening.caseId },
          sourceVersion: verified.source.version,
          repositoryId: verified.source.repositoryId,
          branchRef: `refs/heads/requests/${opening.branchId}`,
          admittedHeadVersion: verified.source.version,
          sourceDigest: verified.sourceDigest,
          requestAdmission: reference,
        },
        registeredOperatorIds: ["operator"],
        operators: [{
          operatorId: "operator",
          nativeSystemId: verified.model.identity.systemId,
          systemQualifiedName: verified.model.identity.systemQualifiedName,
          modelDigest: verified.model.digest,
          repositoryVersion: verified.source.version,
          settingsDigest: base.manifest.operators[0].settingsDigest,
          tools: [],
        }],
        admission: { operatorIds: ["operator"], prerequisites: [] },
        prerequisites: [],
      };
      const command = async (saveKey: string, selected = capture) => {
        const metadata = {
          name: "Admitted source",
          purpose: "Independent of runtime",
        };
        const selection = {
          mode: "create" as const,
          name: `release/${saveKey}`,
        };
        const commitOid = selected.source!.sourceVersion.slice(7);
        const commandDigest = await savedSystemDigest({
          scope,
          saveKey,
          metadata,
          source: {
            branch: selected.source!.branch,
            sourceVersion: selected.source!.sourceVersion,
          },
          tag: selection,
        });
        const intent = {
          scope,
          saveKey,
          commandDigest,
          source: selected.source!,
        };
        return {
          scope,
          saveKey,
          commandDigest,
          metadata,
          capture: selected,
          tag: {
            selection,
            binding: { name: selection.name, refOid: commitOid, commitOid },
            verified: false,
          },
          authorization: await creation.authorize(intent, controller),
        };
      };
      let reached!: () => void, resume!: () => void;
      const freshReached = new Promise<void>((resolve) => reached = resolve);
      const freshResume = new Promise<void>((resolve) => resume = resolve);
      const pausing = new PostgresSavedSystemStore(client, {
        assertNativeLocked: (tx, authorization) =>
          guard.assertNativeLocked(tx, authorization),
        async assertLocked(
          tx: Prisma.TransactionClient,
          authorization: ReleaseRetentionAuthorization,
          phase?: ReleaseCreationPhase,
        ) {
          const proof = await guard.assertLocked(tx, authorization, phase);
          if (phase === "fresh") {
            reached();
            await freshResume;
          }
          return proof;
        },
      });
      const payloadA2 = await admissionFixture(
        opening,
        chainA1.head,
        spaceUuid(802),
        "f",
        payloadA1.result.model.digest,
      );
      const original = await command("a1-accepted");
      const accepting = pausing.begin(original);
      await Promise.race([
        freshReached,
        accepting.then(() => {
          throw new Error("The fresh acceptance fence was not observed");
        }),
      ]);
      let entered!: () => void;
      const appendEntered = new Promise<void>((resolve) => entered = resolve);
      const advancing = database.createClient().$transaction((tx) => {
        entered();
        return journal.compareAndAppend(tx, opening, payloadA2);
      });
      await appendEntered;
      resume();
      const accepted = await accepting;
      await advancing;
      assert.equal(
        accepted.capture.source!.sourceVersion,
        payloadA1.result.source.version,
      );
      assert.equal(
        (await read()).head.source.version,
        payloadA2.result.source.version,
      );
      assert.equal(
        (await read()).execution.pin.source.version,
        base.manifest.source!.sourceVersion,
      );
      assert.equal(
        (await client.spaceOpening.findUniqueOrThrow({
          where: { projectId_systemId_executionSpaceId: scope },
        })).baseJson,
        originalBase,
      );
      const stale = await command("stale-a1");
      const rejected = await store.begin(stale);
      assert.equal((await store.find(scope, stale.saveKey))!.id, rejected.id);
      assert.equal(rejected.status, "conflict");
      assert.equal(rejected.tag, undefined);
      assert.deepEqual(rejected.rejection, {
        code: "SOURCE_STALE",
        tag: stale.tag.selection,
      });
      assert.deepEqual(rejected.capture.source, stale.capture.source);
      assert.deepEqual(await store.begin(stale), rejected);
      assert.deepEqual(
        await store.rejectTag({
          ...stale,
          tag: stale.tag.selection,
          reason: "SOURCE_STALE",
        }),
        rejected,
      );
      assert.deepEqual(
        await store.availableTags(scope, capture.source!.repositoryId, [
          stale.tag.selection.name,
        ]),
        [stale.tag.selection.name],
      );
      assert.deepEqual(
        await store.rejectTag({
          ...original,
          tag: original.tag.selection,
          reason: "SOURCE_STALE",
        }),
        accepted,
      );
      const retry = await store.begin(original);
      assert.equal(retry.id, accepted.id);
      assert.deepEqual(retry.capture.source, accepted.capture.source);
      await client.executionSpace.update({
        where: { projectId_systemId_executionSpaceId: scope },
        data: { lifecycle: "closed", closedAt: new Date() },
      });
      const confirmed = await store.confirmTag({
        scope,
        id: retry.id,
        expectedRevision: retry.revision,
        authorization: original.authorization,
        ensure: () => Promise.resolve(),
      });
      const manifest = savedManifest({
        ...capture,
        operators: capture.operators.map((operator) => ({
          ...operator,
          sourceDigest: verified.sourceDigest,
          build: verified.build,
          tools: [],
        })),
      });
      const retained = await store.finalize({
        scope,
        id: retry.id,
        expectedRevision: confirmed.revision,
        authorization: original.authorization,
        capture,
        manifest,
        digest: await savedSystemDigest(manifest),
        status: "retained",
        issues: [],
      });
      assert.equal(retained.status, "retained");
      assert.deepEqual(retained.manifest!.source!.requestAdmission, reference);
      const forged = structuredClone(capture);
      forged.source!.requestAdmission!.manifestDigest = "f".repeat(64);
      const forgedCommand = await command("forged", forged);
      await assert.rejects(() => store.begin(forgedCommand), forbidden);
      const chain = await read();
      const newest = chain.receipts.at(-1)!;
      const latestCapture = structuredClone(capture);
      latestCapture.source!.sourceVersion =
        newest.payload.result.source.version;
      latestCapture.source!.admittedHeadVersion =
        latestCapture.source!.sourceVersion;
      latestCapture.source!.sourceDigest = newest.payload.result.sourceDigest;
      latestCapture.source!.requestAdmission = {
        ...reference,
        revision: newest.revision,
        manifestDigest: newest.manifestDigest,
      };
      latestCapture.operators[0].repositoryVersion =
        latestCapture.source!.sourceVersion;
      latestCapture.operators[0].modelDigest =
        newest.payload.result.model.digest;
      const pending = await command("a2-pending", latestCapture);
      const terminalAfterRevoke = await command(
        "a2-terminal-revoked",
        latestCapture,
      );
      const pendingRow = await store.begin(pending);
      await controls.revokeCapability(controller);
      await assert.rejects(() =>
        store.rejectTag({
          ...terminalAfterRevoke,
          tag: terminalAfterRevoke.tag.selection,
          reason: "SOURCE_STALE",
        }), forbidden);
      assert.equal(await store.find(scope, terminalAfterRevoke.saveKey), null);
      let nativeCalls = 0;
      await assert.rejects(() =>
        store.confirmTag({
          scope,
          id: pendingRow.id,
          expectedRevision: pendingRow.revision,
          authorization: pending.authorization,
          ensure() {
            nativeCalls++;
            return Promise.resolve();
          },
        }), forbidden);
      assert.equal(nativeCalls, 0);
      assert.equal(
        (await store.get(scope, pendingRow.id))!.tag!.verified,
        false,
      );
      assert.equal(
        (await read()).execution.pin.source.version,
        base.manifest.source!.sourceVersion,
      );
    });
  },
});
