/** Controlled source facts + real canonical control/credentials/intention transactions.
 * This does not qualify Git retention, Toolkit capture or the browser round trip. */
import assert from "node:assert/strict";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import { PostgresSpaceCredentials } from "../../src/adapters/out/postgres/request-space-control-store.ts";
import { PostgresRequestSourceOwnerSessions } from "../../src/adapters/out/postgres/request-source-owner-session.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import { PostgresSavedSystemStore } from "../../src/adapters/out/postgres/saved-system-store.ts";
import { PostgresReleaseCreationGuard } from "../../src/adapters/out/postgres/release-creation-guard.ts";
import { PostgresRequestSourceAdmissionStore } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import { TAG_MUTATION_MIN_VALIDITY_MS } from "../../src/adapters/out/postgres/tag-mutation-budget.ts";
import { ModeledSpaceControlAuthority } from "../../src/application/work/request-spaces/space-control-authority.ts";
import { CryptographicSpaceSecrets } from "../../src/adapters/work/space-control-secrets.ts";
import { SpaceControls } from "../../src/application/work/request-spaces/control.ts";
import { ReleaseCreationAuthority } from "../../src/application/work/saved-systems/creation-authorization.ts";
import { releaseRetentionIntentDigest } from "../../src/domain/work/release-retention.ts";
import {
  type SavedSystemCapture,
  savedSystemDigest,
  SavedSystemError,
  type SavedSystemScope,
  type SavedSystemSourceEvidence,
  savedSystemView,
} from "../../src/domain/work/saved-systems.ts";
import {
  requestSpaceDigest,
  RequestSpaceError,
  type SpaceController,
} from "../../src/domain/work/request-spaces.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { admissionFixture } from "../support/request-source-admission-fixture.ts";
import {
  requestControlBinding,
  requestControlState,
  requestOpeningBase,
  requestSpaceScope as host,
  spaceControlAuthority,
  spaceUuid,
} from "../support/request-space-fixture.ts";

const forbidden = (error: unknown) =>
  error instanceof SavedSystemError && error.code === "FORBIDDEN";
Deno.test({
  name:
    "Release creation uses explicit current retention authority and atomic private receipts in Main and a closed Request",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const storage = new PostgresHostStorage(
        postgresClientConfiguration(
          database.connectionString,
          3,
          database.schema,
        ),
      );
      database.registerCleanup(() => storage.close());
      await storage.registerSystem(host);
      const primary = storage.bindPrimarySpaceControl({
        primaryOperatorId: "operator",
        sourceSystemNativeId: requestControlBinding.sourceSystemNativeId,
      });
      const main = await storage.operator("operator");
      await main.state.save(requestControlState(), null);
      const client = storage.client;
      const credentials = new PostgresSpaceCredentials(client, primary);
      const controls = new SpaceControls(
        credentials,
        new ModeledSpaceControlAuthority(primary, primary.binding),
        new CryptographicSpaceSecrets(),
      );
      const creation = new ReleaseCreationAuthority(controls);
      const guard = new PostgresReleaseCreationGuard(client, primary);
      const saved = new PostgresSavedSystemStore(client, guard);
      const session = async (lifetimeMs?: number) => {
        const capability = await controls.issueCapability("owner", lifetimeMs);
        const exchanged = await controls.exchange(capability.secret);
        return {
          secret: exchanged.secret,
          expiresAt: exchanged.expiresAt,
          controller: await controls.authenticateSession(exchanged.secret),
        };
      };
      const mainScope: SavedSystemScope = { ...host, executionSpaceId: "main" };
      const mainBase = await requestOpeningBase("d");
      const capture = (
        scope: SavedSystemScope,
        source: SavedSystemSourceEvidence,
        operators = mainBase.manifest.operators,
      ): SavedSystemCapture => ({
        origin: scope,
        source,
        registeredOperatorIds: operators.map((entry) => entry.operatorId),
        admission: {
          operatorIds: operators.map((entry) => entry.operatorId),
          prerequisites: [],
        },
        operators: operators.map((operator) => {
          assert.equal(
            operator.tools.length,
            0,
            "Controlled source fixture contains no tool bodies",
          );
          return { ...structuredClone(operator), tools: [] };
        }),
        prerequisites: [],
      });
      const command = async (
        scope: SavedSystemScope,
        selected: SavedSystemCapture,
        saveKey: string,
        controller: SpaceController,
      ) => {
        const metadata = {
          name: "Exact release",
          purpose: "Qualify current retention authority",
        };
        const source = {
          branch: selected.source!.branch,
          sourceVersion: selected.source!.sourceVersion,
        };
        const tag = {
          selection: { mode: "create" as const, name: saveKey },
          binding: {
            name: saveKey,
            refOid: source.sourceVersion.slice(7),
            commitOid: source.sourceVersion.slice(7),
          },
          verified: false,
        };
        const commandDigest = await savedSystemDigest({
          scope,
          saveKey,
          metadata,
          source,
          tag: tag.selection,
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
          tag,
          intent,
          controller,
        };
      };
      const mainCapture = capture(mainScope, mainBase.manifest.source!);
      const old = await session();
      const sourceSessions = new PostgresRequestSourceOwnerSessions(
        client,
        controls,
        primary,
      );
      const sourceSession = await sourceSessions.authenticate(old.secret);
      assert.deepEqual(sourceSession.controller, old.controller);
      await sourceSessions.revalidate(sourceSession);
      assert.deepEqual(old.controller.authority.acts, [
        "execute-conversation",
        "open-request",
        "revoke-execution",
      ]);
      // A valid channel identity is independent of a concrete source act.
      const identity = await client.$transaction((tx) =>
        credentials.assertCurrentController(tx, old.controller, 0)
      );
      assert.equal(identity.sessionRevision, 0);
      assert.deepEqual(identity.authority, old.controller.authority);
      const identityRefused = (error: unknown) =>
        error instanceof RequestSpaceError &&
        error.code === "ADMISSION_REFUSED";
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            credentials.assertCurrentController(tx, old.controller, 1)
          ),
        identityRefused,
      );
      await assert.rejects(
        () =>
          sourceSessions.revalidate({ ...sourceSession, sessionRevision: 1 }),
        identityRefused,
      );
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            credentials.assertRetainRelease(tx, old.controller)
          ),
        identityRefused,
      );
      const oldCommand = await command(
        mainScope,
        mainCapture,
        "old-three-act",
        old.controller,
      );
      // The standalone tag seam shares the real current-control fence, without
      // creating an intention row or manufacturing an execution admission.
      let tagMutations = 0;
      const tagOperation = async (signal: AbortSignal) => {
        assert.equal(signal.aborted, false);
        tagMutations++;
        await Promise.resolve();
      };
      await assert.rejects(
        () =>
          guard.run(
            { intent: oldCommand.intent, controller: old.controller },
            tagOperation,
          ),
        forbidden,
      );
      assert.equal(
        tagMutations,
        0,
        "three-act control cannot enter native tag work",
      );
      await assert.rejects(
        () => creation.authorize(oldCommand.intent, old.controller),
        forbidden,
      );
      await assert.rejects(
        () =>
          saved.begin({
            ...oldCommand,
            authorization: {
              intent: oldCommand.intent,
              controller: old.controller,
            },
          }),
        forbidden,
      );
      assert.equal(await client.savedSystem.count(), 0);
      assert.equal(await client.spaceExecutionAdmission.count(), 0);

      const four = spaceControlAuthority();
      four.acts.push("retain-release");
      four.policyRevision++;
      four.sourceVersion = `commit:${"d".repeat(40)}`;
      four.modelDigest = "d".repeat(64);
      await main.state.save(requestControlState(four, 1), 0);
      await assert.rejects(() => controls.authenticateSession(old.secret));
      await assert.rejects(() => sourceSessions.authenticate(old.secret));
      await assert.rejects(() => sourceSessions.revalidate(sourceSession));
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            credentials.assertCurrentController(tx, old.controller, 0)
          ),
        identityRefused,
      );
      assert.equal(
        (await credentials.get(old.controller.capabilityId))!.status,
        "revoked",
      );
      const current = await session();
      const mainCommand = await command(
        mainScope,
        mainCapture,
        "main-retention",
        current.controller,
      );
      const mainAuthorization = await creation.authorize(
        mainCommand.intent,
        current.controller,
      );
      await guard.run(mainAuthorization, tagOperation);
      assert.equal(
        tagMutations,
        1,
        "current Main retention control enters tag work once",
      );
      assert.equal(
        await client.savedSystem.count(),
        0,
        "tag-only work inserts no Release row",
      );
      assert.equal(await client.spaceExecutionAdmission.count(), 0);
      await assert.rejects(
        () =>
          guard.run({
            ...mainAuthorization,
            controller: { ...current.controller, ownerId: "another-owner" },
          }, tagOperation),
        forbidden,
      );
      assert.equal(
        tagMutations,
        1,
        "a changed owner cannot reuse current credentials",
      );
      const short = await session(TAG_MUTATION_MIN_VALIDITY_MS - 1000);
      const shortAuthorization = await creation.authorize(
        mainCommand.intent,
        short.controller,
      );
      await assert.rejects(
        () => guard.run(shortAuthorization, tagOperation),
        forbidden,
      );
      const [shortClock] = await client.$queryRaw<Array<{ live: boolean }>>(
        Prisma.sql`SELECT clock_timestamp()<${new Date(
          short.expiresAt,
        )} AS "live"`,
      );
      assert.equal(
        shortClock.live,
        true,
        "a live credential with insufficient native budget is refused",
      );
      assert.equal(tagMutations, 1);
      const accepted = await saved.begin({
        ...mainCommand,
        authorization: mainAuthorization,
      });
      assert.ok(accepted.creationAuthorization);
      assert.equal(accepted.creationAuthorization.act, "retain-release");
      assert.equal(
        accepted.creationAuthorization.intentDigest,
        await releaseRetentionIntentDigest(mainCommand.intent),
      );
      assert.equal(accepted.creationAuthorization.ownerId, "owner");
      assert.equal(
        accepted.creationAuthorization.capabilityId,
        current.controller.capabilityId,
      );
      assert.equal(accepted.creationAuthorization.adoptedState.revision, 1);
      assert.equal("creationAuthorization" in savedSystemView(accepted), false);
      assert.equal(
        JSON.stringify(savedSystemView(accepted)).includes(
          current.controller.sessionId,
        ),
        false,
      );
      assert.equal(await client.spaceExecutionAdmission.count(), 0);
      await assert.rejects(
        () =>
          client.$executeRaw(
            Prisma.sql`UPDATE ${
              postgresQualifiedTable(client, "SavedSystem")
            } SET "creationAuthorization"='{}' WHERE "id"=${accepted.id}`,
          ),
        /evidence is immutable/,
      );

      const openings = new PostgresRequestSpaceStore(client, host);
      const openingCommand = {
        openingKey: "closed-origin",
        text: "Controlled immutable Case source",
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
      const caseScope = { ...host, executionSpaceId: opening.executionSpaceId };
      await client.executionSpace.update({
        where: { projectId_systemId_executionSpaceId: caseScope },
        data: { lifecycle: "closed", closedAt: new Date() },
      });
      const caseSource: SavedSystemSourceEvidence = {
        ...base.manifest.source!,
        branch: { kind: "case", caseId: opening.caseId },
        branchRef: `refs/heads/requests/${opening.branchId}`,
      };
      // Hold the actual Opening UPDATE fence while the guard has already
      // acquired current credential SHARE locks. Expiration is real SQL time;
      // no persisted credential/clock is rewritten and no native work is run.
      const locked = Promise.withResolvers<number>();
      const releaseOpening = Promise.withResolvers<void>();
      const openingLock = client.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM ${
            postgresQualifiedTable(client, "SpaceOpening")
          } WHERE "id"=${opening.id} FOR UPDATE`,
        );
        const [pid] = await tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS "pid"`,
        );
        locked.resolve(pid.pid);
        await releaseOpening.promise;
      }, { timeout: 15_000 });
      let tagAttempt: Promise<PromiseSettledResult<void>[]> | undefined;
      const beforeExpiryTag = await client.savedSystem.count();
      try {
        const blockerPid = await locked.promise;
        const expiring = await session(2000);
        const expiringCommand = await command(
          caseScope,
          capture(caseScope, caseSource, base.manifest.operators),
          "tag-expiring-during-opening-lock",
          expiring.controller,
        );
        const expiringAuthorization = await creation.authorize(
          expiringCommand.intent,
          expiring.controller,
        );
        tagAttempt = Promise.allSettled([
          guard.run(expiringAuthorization, tagOperation),
        ]);
        let waiting = false;
        const waitDeadline = performance.now() + 2000;
        while (performance.now() < waitDeadline) {
          const rows = await client.$queryRaw<Array<{ pid: number }>>(
            Prisma.sql`
            SELECT a.pid FROM pg_stat_activity a
            WHERE a.datname=current_database() AND a.wait_event_type='Lock'
              AND ${blockerPid}=ANY(pg_blocking_pids(a.pid))
              AND a.query LIKE ${'%"SpaceOpening"%FOR SHARE%'}
          `,
          );
          if (rows.length) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          waiting,
          true,
          "tag guard must reach the real Opening SHARE lock wait",
        );
        const [expired] = await client.$queryRaw<Array<{ expired: boolean }>>(
          Prisma.sql`
          SELECT clock_timestamp()>=${new Date(expiring.expiresAt)} AS "expired"
          FROM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (${new Date(
            expiring.expiresAt,
          )}::timestamptz-clock_timestamp())))+0.02)
        `,
        );
        assert.equal(
          expired.expired,
          true,
          "release the Opening only after the credential really expired",
        );
      } finally {
        releaseOpening.resolve();
        await openingLock;
        if (tagAttempt) await tagAttempt;
      }
      assert.ok(tagAttempt);
      const [expiredTag] = await tagAttempt;
      assert.equal(expiredTag.status, "rejected");
      if (expiredTag.status === "rejected") {
        assert.equal(forbidden(expiredTag.reason), true);
      }
      assert.equal(
        tagMutations,
        1,
        "expiration while waiting must prevent the native callback",
      );
      assert.equal(await client.savedSystem.count(), beforeExpiryTag);
      const caseCommand = await command(
        caseScope,
        capture(caseScope, caseSource, base.manifest.operators),
        "case-retention",
        current.controller,
      );
      const caseAuthorization = await creation.authorize(
        caseCommand.intent,
        current.controller,
      );
      const beforeCaseTag = await client.savedSystem.count();
      await guard.run(caseAuthorization, tagOperation);
      assert.equal(
        tagMutations,
        2,
        "a closed Request keeps exact fresh-source tag authority",
      );
      assert.equal(await client.savedSystem.count(), beforeCaseTag);
      const caseAccepted = await saved.begin({
        ...caseCommand,
        authorization: caseAuthorization,
      });
      assert.equal(
        caseAccepted.capture.origin.executionSpaceId,
        opening.executionSpaceId,
      );
      assert.equal(caseAccepted.capture.source!.branch.kind, "case");
      assert.notEqual(
        caseAccepted.creationAuthorization!.intentDigest,
        accepted.creationAuthorization.intentDigest,
      );
      assert.equal(
        await client.spaceExecutionAdmission.count(),
        0,
        "retention must not manufacture an execution admission",
      );
      // Synthetic, correctly folded D2 evidence advances the admitted source;
      // this qualifies the SQL freshness guard, not Git/source publication.
      const sourceAdmissions = new PostgresRequestSourceAdmissionStore(client);
      const baseline = await client.$transaction((tx) =>
        sourceAdmissions.readAdmittedSource(tx, opening)
      );
      const nextSource = await admissionFixture(
        opening,
        baseline.head,
        spaceUuid(981),
        "f",
        base.manifest.operators[0].modelDigest,
      );
      await client.$transaction((tx) =>
        sourceAdmissions.compareAndAppend(tx, opening, nextSource)
      );
      const beforeStaleTag = await client.savedSystem.count();
      await assert.rejects(
        () => guard.run(caseAuthorization, tagOperation),
        (error) =>
          error instanceof SavedSystemError && error.code === "SOURCE_STALE",
      );
      assert.equal(
        tagMutations,
        2,
        "an earlier Request source never enters native tag work",
      );
      assert.equal(await client.savedSystem.count(), beforeStaleTag);
      const before = await client.savedSystem.count();
      const replay = await saved.find(mainScope, mainCommand.saveKey);
      assert.equal(replay!.id, accepted.id);
      assert.deepEqual(
        replay!.creationAuthorization,
        accepted.creationAuthorization,
      );
      const changed = await command(
        mainScope,
        mainCapture,
        "changed-command",
        current.controller,
      );
      await assert.rejects(
        () => saved.begin({ ...changed, authorization: mainAuthorization }),
        forbidden,
      );
      await assert.rejects(
        () =>
          saved.begin({
            ...mainCommand,
            metadata: {
              ...mainCommand.metadata,
              purpose: "Changed after authorization",
            },
            authorization: mainAuthorization,
          }),
        (error) =>
          error instanceof SavedSystemError &&
          error.code === "CAPTURE_CONFLICT",
      );
      const changedCapture = structuredClone(mainCapture);
      changedCapture.source!.sourceDigest = "e".repeat(64);
      const changedSource = await command(
        mainScope,
        changedCapture,
        mainCommand.saveKey,
        current.controller,
      );
      const changedAuthorization = await creation.authorize(
        changedSource.intent,
        current.controller,
      );
      await assert.rejects(
        () =>
          saved.begin({
            ...changedSource,
            authorization: changedAuthorization,
          }),
        forbidden,
      );
      const pending = await command(
        mainScope,
        mainCapture,
        "preflight-then-revoke",
        current.controller,
      );
      const pendingAuthorization = await creation.authorize(
        pending.intent,
        current.controller,
      );
      await controls.revokeCapability(current.controller);
      await assert.rejects(
        () => guard.run(pendingAuthorization, tagOperation),
        forbidden,
      );
      assert.equal(
        tagMutations,
        2,
        "revocation after preflight prevents the tag callback",
      );
      await assert.rejects(
        () => saved.begin({ ...pending, authorization: pendingAuthorization }),
        forbidden,
      );
      assert.equal(await client.savedSystem.count(), before);
      assert.deepEqual(
        (await saved.find(mainScope, mainCommand.saveKey))!
          .creationAuthorization,
        accepted.creationAuthorization,
        "a receipt is immutable historical evidence, not renewed authority",
      );
    });
  },
});
