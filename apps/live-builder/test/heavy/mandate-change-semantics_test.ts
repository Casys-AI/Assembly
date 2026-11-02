/** Host-agnostic mandate tier: the 16 scenarios that need the real toolkit
 * but no PostgreSQL, on the memory composition.
 *
 * Durable-only scenarios (restart recovery, pg-boss drain, native-pin
 * fences, lost-save reconciliation) stay in
 * mandate-change-recovery_test.ts; the two files sum to the 28 original
 * scenarios with unchanged assertions.
 */
import type { HostEdit } from "../../src/domain/model/editing/host-edit.ts";
import {
  applyEdits,
  readHostEditText,
  verifyEdits,
} from "../../src/adapters/model/sources/editing/host-writer.ts";
import {
  modelSourceElement,
  modelToolingTarget,
} from "../../src/adapters/model/sources/editing/tooling.ts";
import { sha256 } from "../../src/adapters/model/builds/materialization/artifact.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { createControlHandler } from "../../src/adapters/in/http/work/control.ts";
import { createConversationsHandler } from "../../src/adapters/in/http/work/conversations.ts";
import { OperatorConversations } from "../../src/application/work/operators/conversations.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
  assertPublicationSize,
  type ChangePublication,
  changePublication,
  ChangePublicationError,
} from "../../src/domain/model/publication/change.ts";
import {
  isHostEdit,
  isOperatorAuthorityEdit,
  type PublicationEdit,
} from "../../src/domain/model/publication/compatibility.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { reconcileChangePublications } from "../../src/application/governance/mandate-change-decisions.ts";
import { MemoryStateStore } from "../support/memory-state-store.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  SourceModel,
  type SourceRevision,
} from "../../src/adapters/model/sources/source-model.ts";
import { sourceLiterals } from "../../src/adapters/model/projections/graph/source.ts";
import type { ChatDecision } from "../../src/domain/work/dialogue.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  currentHostEdits,
  drainDecisionCompletion,
  drainDecisionRefusal,
  drainMandateQueue,
  FileRepository,
  openMandateMemorySession,
  proposeMandateChange,
  restartMemoryService,
  runtime,
} from "../support/mandate-harness.ts";

Deno.test({
  name:
    "T7: reviewer name changed between preparation and compilation blocks publication readback and reconciliation",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir();
    const store = new MemoryStateStore();
    try {
      const repository = new FileRepository(directory);
      const model = new SourceModel({
        tooling: new SysmlToolkitAdapter({
          packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
        }),
        repository,
        projectId: "git:cdc1ab4f-083e-533c-90ca-953c38b63a92",
        initialSources: await loadInitialSources(undefined, {
          information: false,
        }),
      });
      const service = runtime(model, store, true);
      await service.initialize();
      const before = service.snapshot;
      before.designer = { scopeId: "recovery-test:designer" };
      before.caseInvocation = {
        kind: "designer",
        scopeId: "recovery-test:designer",
      };
      const base = before.executionModel!;
      const governance = SystemGovernance.fromExecutable(base);
      const proposed = governance.propose(
        {
          kind: "propose_agent_creation",
          text: "Review",
          reason: "Independent reviewer",
          role: "reviewer",
          name: "Approved reviewer",
          mandate: {
            mayReviewExactCandidate: true,
            mayAdmitReviewedCandidates: true,
          },
        },
        crypto.randomUUID(),
        "now",
        {
          requestedBy: base.identity.builderId,
          designerScopeId: "recovery-test:designer",
        },
      );
      before.configuration!.changes = [proposed];
      const approved = governance.decideChange(
        proposed.id,
        proposed.baseRevision,
        true,
        "later",
      );
      repository.beforeCompile = (sources) =>
        Object.fromEntries(
          Object.entries(sources).map((
            [key, text],
          ) => [
            key,
            text.replace('"Approved reviewer"', '"Different reviewer"'),
          ]),
        );
      let writes = 0;
      const host = {
        state: structuredClone(before),
        ports: { model },
        update: () => {
          writes++;
          return Promise.resolve();
        },
        adopt: () => {
          writes++;
          return Promise.resolve();
        },
      };
      const head = await repository.current();
      const history = await repository.history();
      await rejects(() =>
        model.applyApprovedChange(
          before.model!,
          approved,
          base.version.digest,
          changePublication(approved, base.version),
        ), (error: unknown) => {
        ok(error instanceof ChangePublicationError);
        equal(error.code, "PUBLICATION_NOT_APPLICABLE");
        equal(error.recovery, "refuse");
        // C2: the refusal must come from the reviewer-name divergence
        // itself, read back against the frozen approved literal.
        ok(
          /Inserted (member )?literal differs/.test(error.message),
          error.message,
        );
        return true;
      });
      deepStrictEqual(await repository.current(), head);
      deepStrictEqual(await repository.history(), history);
      equal(await repository.findPublication(proposed.id), null);
      equal(await model.findApprovedChange(before.model!, proposed.id), null);
      await reconcileChangePublications.call(host);
      equal(writes, 0);
      deepStrictEqual(host.state, before);
      equal(
        service.snapshot.executionModel!.version.digest,
        base.version.digest,
      );
    } finally {
      await store.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "T7: divergent published reviewer blocks recovery and reconciliation",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir();
    const store = new MemoryStateStore();
    try {
      const repository = new FileRepository(directory);
      const model = new SourceModel({
        tooling: new SysmlToolkitAdapter({
          packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
        }),
        repository,
        projectId: "git:cdc1ab4f-083e-533c-90ca-953c38b63a92",
        initialSources: await loadInitialSources(undefined, {
          information: false,
        }),
      });
      const service = runtime(model, store, true);
      await service.initialize();
      const before = service.snapshot;
      const base = before.executionModel!;
      const governance = SystemGovernance.fromExecutable(base);
      const proposed = governance.propose(
        {
          kind: "propose_agent_creation",
          text: "Review",
          reason: "Independent reviewer",
          role: "reviewer",
          name: "Approved reviewer",
          mandate: {
            mayReviewExactCandidate: true,
            mayAdmitReviewedCandidates: true,
          },
        },
        crypto.randomUUID(),
        "now",
        {
          requestedBy: base.identity.builderId,
          designerScopeId: "recovery-test:designer",
        },
      );
      before.configuration!.changes = [proposed];
      const approved = governance.decideChange(
        proposed.id,
        proposed.baseRevision,
        true,
        "later",
      );
      await model.applyApprovedChange(
        before.model!,
        approved,
        base.version.digest,
        changePublication(approved, base.version),
      );
      const published = (await repository.findPublication(proposed.id))!;
      ok(published.receipt!.edits.every((edit) => "op" in edit));
      // Diverge the published reviewer name from its ops receipt.
      const path = `${directory}/${published.revision.version}.json`;
      const immutable = await Deno.readTextFile(path);
      const divergent = JSON.parse(immutable) as SourceRevision;
      const literal = sourceLiterals(divergent.elements).find((entry) =>
        entry.name === "configuredName"
      );
      ok(literal, "Published reviewer has no configuredName literal");
      divergent.elements.find((element) =>
        element["@id"] === literal.literalId
      )!.value = "Different reviewer";
      await Deno.writeTextFile(path, JSON.stringify(divergent));
      const mismatch = (error: unknown) => {
        ok(error instanceof ChangePublicationError);
        equal(error.code, "PUBLICATION_RECEIPT_MISMATCH");
        equal(error.context.changeId, proposed.id);
        return true;
      };
      await rejects(
        () => model.findApprovedChange(before.model!, proposed.id),
        mismatch,
      );
      let writes = 0;
      const host = {
        state: structuredClone(before),
        ports: { model },
        update: () => {
          writes++;
          return Promise.resolve();
        },
        adopt: () => {
          writes++;
          return Promise.resolve();
        },
      };
      await rejects(() => reconcileChangePublications.call(host), mismatch);
      equal(writes, 0);
      deepStrictEqual(host.state, before);
      await Deno.writeTextFile(path, immutable);
      const recovered = await model.findApprovedChange(
        before.model!,
        proposed.id,
      );
      ok(recovered?.model.configuration.reviewer?.name === "Approved reviewer");
    } finally {
      await store.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

for (
  const variant of [
    "networkHosts",
    "urlSelectionMode",
  ] as const
) {
  Deno.test({
    name:
      `M1a: SourceModel refuses ${variant} before publication and returns refuse to the client`,
    ignore: !toolkitIntegrationEnabled,
    async fn() {
      const directory = await Deno.makeTempDir();
      const repository = new FileRepository(directory);
      const memory = await openMandateMemorySession({
        directory,
        repository,
        initialSources: await loadInitialSources(undefined, {
          information: false,
        }),
      });
      try {
        const { service, proposed } = await proposeMandateChange(
          memory,
          variant === "urlSelectionMode"
            ? { setUrlSelectionMode: "authorized-host" }
            : { addNetworkHosts: ["recovery.example"] },
        );
        ok(proposed, service.snapshot.error);
        const head = await repository.current();
        const history = await repository.history();
        let writes = 0;
        let compilations = 0;
        repository.beforePublish = () => {
          writes++;
          return Promise.resolve();
        };
        // Keep the source, literal and provider display name intact, but lose
        // the native declaration name. Canonical receipt resolution must refuse
        // this inconsistent identity before publication.
        const compile = repository.compiler.compile.bind(repository.compiler);
        repository.compiler.compile = async (sources) => {
          const compiled = await compile(sources);
          if (variant === "urlSelectionMode" && compilations > 0) {
            const field = compiled.elements.find((element) =>
              element.qualifiedName ===
                "AssemblyLiveBuilder::liveBuilder::conversation::executionPolicy::urlSelectionMode"
            );
            ok(field);
            field.declaredName = "lostSelectionMode";
          }
          return compiled;
        };
        repository.beforeCompile = (sources) => {
          compilations++;
          if (variant === "urlSelectionMode") return sources;
          const original = 'networkHosts : String = "[\\"recovery.example\\"]"';
          const replacement =
            'networkHosts : String = "[\\"divergent.example\\"]"';
          const altered = Object.fromEntries(
            Object.entries(sources).map((
              [path, text],
            ) => [path, text.replace(original, replacement)]),
          );
          ok(
            canonical(altered) !== canonical(sources),
            "Compilation hook did not alter the candidate",
          );
          return altered;
        };
        // decideChange only enqueues: the PUBLICATION_NOT_APPLICABLE refusal
        // surfaces on the memory worker and is read back from the worker
        // error plus the canonical journal.
        await service.decideChange({
          changeId: proposed.id,
          expectedRevision: proposed.baseRevision,
          verdict: "approve",
        });
        await drainDecisionRefusal(memory, (error: unknown) => {
          ok(error instanceof ChangePublicationError);
          equal(error.code, "PUBLICATION_NOT_APPLICABLE");
          equal(error.recovery, "refuse");
          ok(
            error.message.includes(
              variant === "urlSelectionMode"
                ? "Host edit target is missing"
                : "Host edit value differs after compilation",
            ),
            error.message,
          );
        }, false);
        ok(
          service.snapshot.events.some((event) =>
            event.kind === "control-failed"
          ),
          "The worker refusal must be journalled",
        );
        equal(compilations, 1);
        equal(writes, 0);
        deepStrictEqual(await repository.current(), head);
        deepStrictEqual(await repository.history(), history);
        equal(await repository.findPublication(proposed.id), null);
        equal(service.snapshot.configuration!.changes[0].status, "pending");
        equal(
          (await memory.storage.state.load())!.configuration!.changes[0]
            .status,
          "pending",
        );
      } finally {
        await drainMandateQueue(memory);
        await memory.close();
        await Deno.remove(directory, { recursive: true });
      }
    },
  });
}

Deno.test({
  name:
    "T7: receipts cover every changed scalar for all supported approvals and recovery rereads them",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir();
    try {
      const repository = new FileRepository(directory);
      const model = new SourceModel({
        tooling: new SysmlToolkitAdapter({
          packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
        }),
        repository,
        projectId: "git:cdc1ab4f-083e-533c-90ca-953c38b63a92",
        initialSources: await loadInitialSources(undefined, {
          information: false,
        }),
      });
      const identity = await model.initialize();
      const scalarValues = (revision: SourceRevision) =>
        new Map(
          sourceLiterals(revision.elements).map((literal) => {
            const owner = revision.elements.find((element) =>
              element["@id"] === literal.owner
            )!;
            return [`${owner.qualifiedName}::${literal.name}`, literal.value];
          }),
        );
      for (
        const decision of [
          {
            kind: "propose_mandate_change",
            requestedRights: { addNetworkHosts: ["receipt.example"] },
          },
          {
            kind: "propose_mandate_change",
            requestedRights: { setUrlSelectionMode: "authorized-host" },
          },
          {
            kind: "propose_mandate_change",
            requestedRights: { mayAdmitOwnCandidates: true },
          },
          {
            kind: "propose_agent_creation",
            name: "Approved reviewer",
            role: "reviewer",
            mandate: {
              mayReviewExactCandidate: true,
              mayAdmitReviewedCandidates: true,
            },
          },
        ] satisfies Array<
          | Omit<
            Extract<ChatDecision, { kind: "propose_mandate_change" }>,
            "text" | "reason"
          >
          | Omit<
            Extract<
              ChatDecision,
              { kind: "propose_agent_creation"; role: "reviewer" }
            >,
            "text" | "reason"
          >
        >
      ) {
        const base = await model.readExecutableModel(identity);
        const baseRevision = await repository.current();
        const before = scalarValues(baseRevision);
        const governance = SystemGovernance.fromExecutable(base);
        const proposed = governance.propose(
          {
            ...structuredClone(decision),
            text: "Exact change",
            reason: "Receipt coverage",
          },
          crypto.randomUUID(),
          "now",
          {
            requestedBy: base.identity.builderId,
            designerScopeId: "recovery-test:designer",
          },
        );
        const approved = governance.decideChange(
          proposed.id,
          proposed.baseRevision,
          true,
          "later",
        );
        await model.applyApprovedChange(
          identity,
          approved,
          base.version.digest,
          changePublication(approved, base.version),
        );
        const published = (await repository.findPublication(proposed.id))!;
        const changes = [...scalarValues(published.revision)].filter((
          [key, value],
        ) => before.get(key) !== value);
        ok(changes.length > 0);
        if (decision.kind === "propose_mandate_change") {
          const targets = "addNetworkHosts" in decision.requestedRights
            ? ["networkHosts"]
            : "setUrlSelectionMode" in decision.requestedRights
            ? ["conversation::executionPolicy::urlSelectionMode"]
            : ["builderMandate::mayAdmit", "admissionMode"];
          deepStrictEqual(
            published.receipt!.edits.map((edit) => {
              ok("op" in edit && edit.op === "setFeatureValue");
              return edit.target.qualifiedName;
            }),
            [
              ...targets,
              "builderMandate::version",
              "builderMandate::id",
              "configurationRevision",
            ]
              .map((target) => `AssemblyLiveBuilder::liveBuilder::${target}`),
          );
          const edits = published.receipt!.edits.filter((
            edit,
          ): edit is HostEdit => "op" in edit && edit.op === "setFeatureValue");
          equal(edits.length, published.receipt!.edits.length);
          await verifyEdits(published.revision, edits, {
            base: baseRevision,
          });
        } else {
          const recorded = new Map<string, string>();
          for (const edit of published.receipt!.edits) {
            ok("op" in edit);
            if (edit.op === "setFeatureValue") {
              recorded.set(edit.target.qualifiedName, String(edit.value));
            }
            if (edit.op === "insertMember" && !isOperatorAuthorityEdit(edit)) {
              for (const expectation of edit.expect) {
                if (!("path" in expectation)) continue;
                recorded.set(
                  `${edit.owner.qualifiedName}::${expectation.path}`,
                  String(expectation.value),
                );
              }
            }
          }
          for (const [key, value] of changes) {
            equal(
              recorded.get(key),
              value,
              `Unrecorded approved scalar: ${key}`,
            );
          }
          const insertions = published.receipt!.edits.filter((edit) =>
            "op" in edit && edit.op === "insertMember"
          );
          equal(
            insertions.flatMap((edit) =>
              isHostEdit(edit) && edit.op === "insertMember"
                ? edit.expect.filter((expectation) => "path" in expectation)
                : []
            ).length,
            16,
          );
          const bytes =
            new TextEncoder().encode(canonical(published.receipt)).length;
          assertPublicationSize(published.receipt!);
          const trailerBytes = new TextEncoder().encode(
            `ASE-Approval: ${canonical(published.receipt)}\n`,
          ).length;
          console.log(
            `M1d reviewer receipt: ${bytes} JSON bytes; ${trailerBytes} trailer bytes`,
          );
          ok(published.receipt!.edits.every((edit) => "op" in edit));
          await verifyEdits(
            published.revision,
            currentHostEdits(published.receipt!),
            { base: baseRevision },
          );
        }
        const immutable = await Deno.readTextFile(
          `${directory}/${published.revision.version}.json`,
        );
        const literalTargets = published.receipt!.edits.flatMap((edit) => {
          ok("op" in edit);
          if (edit.op === "setFeatureValue") return [edit.target.qualifiedName];
          if (edit.op === "insertMember" && !isOperatorAuthorityEdit(edit)) {
            return edit.expect.flatMap((expectation) =>
              "path" in expectation
                ? [`${edit.owner.qualifiedName}::${expectation.path}`]
                : []
            );
          }
          return [];
        });
        for (const targetName of literalTargets) {
          const literal = sourceLiterals(published.revision.elements).find(
            (literal) => {
              const owner = published.revision.elements.find((element) =>
                element["@id"] === literal.owner
              )!;
              return `${owner.qualifiedName}::${literal.name}` ===
                targetName;
            },
          );
          ok(literal);
          const divergent: SourceRevision = JSON.parse(immutable);
          divergent.elements.find((element) =>
            element["@id"] === literal.literalId
          )!.value = "different";
          await Deno.writeTextFile(
            `${directory}/${published.revision.version}.json`,
            JSON.stringify(divergent),
          );
          await rejects(
            () => model.findApprovedChange(identity, proposed.id),
            (error: unknown) =>
              error instanceof ChangePublicationError &&
              error.code === "PUBLICATION_RECEIPT_MISMATCH",
          );
          await Deno.writeTextFile(
            `${directory}/${published.revision.version}.json`,
            immutable,
          );
        }
        const recovered = await model.findApprovedChange(identity, proposed.id);
        ok(recovered);
        deepStrictEqual(recovered.receipt, published.receipt);
        if (decision.kind === "propose_agent_creation") {
          const historical = JSON.parse(immutable);
          historical.receipt.edits = published.receipt!.edits.flatMap(
            (edit) => {
              ok("op" in edit);
              if (edit.op === "setFeatureValue") {
                return [{
                  owner: identity.systemId,
                  name: edit.target.qualifiedName.slice(
                    "AssemblyLiveBuilder::liveBuilder::".length,
                  ),
                  value: edit.value,
                }];
              }
              if (
                edit.op === "insertMember" && !isOperatorAuthorityEdit(edit) &&
                edit.owner.qualifiedName === "AssemblyLiveBuilder::liveBuilder"
              ) {
                return edit.expect.flatMap((expectation) =>
                  "path" in expectation
                    ? [{
                      owner: identity.systemId,
                      name: expectation.path,
                      value: expectation.value,
                    }]
                    : []
                );
              }
              return [];
            },
          );
          await Deno.writeTextFile(
            `${directory}/${published.revision.version}.json`,
            JSON.stringify(historical),
          );
          const legacyRecovered = await model.findApprovedChange(
            identity,
            proposed.id,
          );
          ok(legacyRecovered);
          deepStrictEqual(
            legacyRecovered.receipt!.edits,
            historical.receipt.edits,
          );
          await Deno.writeTextFile(
            `${directory}/${published.revision.version}.json`,
            immutable,
          );
        }
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "T7: historical scalar, M1d, authority, mixed and current receipts recover without rewriting their JSON",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir();
    try {
      const repository = new FileRepository(directory);
      const tooling = new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      });
      const model = new SourceModel({
        tooling,
        repository,
        projectId: "git:cdc1ab4f-083e-533c-90ca-953c38b63a92",
        initialSources: await loadInitialSources(undefined, {
          information: false,
        }),
      });
      const identity = await model.initialize();
      const publish = async (
        decision: Extract<ChatDecision, {
          kind: "propose_mandate_change" | "propose_agent_creation";
        }>,
      ) => {
        const base = await model.readExecutableModel(identity);
        const governance = SystemGovernance.fromExecutable(base);
        const proposed = governance.propose(
          decision,
          crypto.randomUUID(),
          "now",
          {
            requestedBy: base.identity.builderId,
            designerScopeId: "recovery-test:designer",
          },
        );
        const approved = governance.decideChange(
          proposed.id,
          proposed.baseRevision,
          true,
          "later",
        );
        await model.applyApprovedChange(
          identity,
          approved,
          base.version.digest,
          changePublication(approved, base.version),
        );
        const published = await repository.findPublication(proposed.id);
        ok(published?.receipt);
        return published;
      };
      const reviewer = await publish({
        kind: "propose_agent_creation",
        text: "Create reviewer",
        reason: "Historical insertion receipt",
        role: "reviewer",
        name: "Historical reviewer",
        mandate: {
          mayReviewExactCandidate: true,
          mayAdmitReviewedCandidates: true,
        },
      });
      const published = await publish({
        kind: "propose_mandate_change",
        text: "Grant model editing",
        reason: "Historical authority receipt",
        requestedRights: {
          grantModelEditing: {
            file: "configuration.sysml",
            root: "AssemblyLiveBuilder::liveBuilder::catalog",
            operations: ["insert-member"],
          },
        },
      });
      const scalar = currentHostEdits(published.receipt!).find((edit) =>
        edit.op === "setFeatureValue"
      );
      ok(scalar?.op === "setFeatureValue");
      const legacy = [{
        owner: identity.systemId,
        name: scalar.target.qualifiedName.slice(
          "AssemblyLiveBuilder::liveBuilder::".length,
        ),
        value: scalar.value,
      }];
      const reviewerInsertion = currentHostEdits(reviewer.receipt!).find((
        edit,
      ) =>
        edit.op === "insertMember" &&
        edit.expect.some((expectation) => expectation.kind === "literal")
      );
      ok(reviewerInsertion?.op === "insertMember");
      const reviewerLiterals = sourceLiterals(reviewer.revision.elements);
      const m1d = [{
        op: "insertMember" as const,
        owner: structuredClone(reviewerInsertion.owner),
        text: await readHostEditText(reviewerInsertion.text),
        ...(reviewerInsertion.batch !== undefined
          ? { batch: reviewerInsertion.batch }
          : {}),
        ...(reviewerInsertion.introduced
          ? {
            introduced: reviewerInsertion.introduced.map((member) => {
              const { qualifiedName, metaclass, value } = member;
              if (member.valueDigest === undefined) {
                return {
                  qualifiedName,
                  metaclass,
                  ...(value !== undefined ? { value } : {}),
                };
              }
              const element = modelSourceElement(
                reviewer.revision,
                qualifiedName,
                metaclass,
              );
              const literal = reviewerLiterals.find((literal) =>
                literal.attributeId === element["@id"]
              );
              ok(literal, `Missing historical literal: ${qualifiedName}`);
              return {
                qualifiedName,
                metaclass,
                value: literal.kind === "LiteralString"
                  ? literal.value
                  : literal.kind === "LiteralBoolean"
                  ? literal.value === "true"
                  : Number(literal.value),
              };
            }),
          }
          : {}),
        expect: reviewerInsertion.expect.flatMap((expectation) =>
          expectation.kind === "literal"
            ? [{ path: expectation.path, value: expectation.value }]
            : []
        ),
      }];
      ok(m1d[0]!.expect.length > 0);
      const authorityInsertion = currentHostEdits(published.receipt!).find(
        (edit) =>
          edit.op === "insertMember" &&
          edit.expect.some((expectation) => expectation.kind === "member"),
      );
      ok(authorityInsertion?.op === "insertMember");
      // The former authority writer prepared AFTER the scalar writes. Its
      // namespace preimage therefore differs from the new common-base receipt.
      const scalars = await applyEdits(
        tooling,
        reviewer.revision,
        currentHostEdits(published.receipt!).flatMap((edit) =>
          edit.op === "setFeatureValue"
            ? [{
              op: "setFeatureValue" as const,
              target: { qualifiedName: edit.target.qualifiedName },
              value: edit.value,
            }]
            : []
        ),
      );
      const intermediate: SourceRevision = {
        ...await repository.compiler.compile(scalars.sources),
        version: reviewer.revision.version,
      };
      const originalPreimage = await sha256(
        modelToolingTarget(reviewer.revision, authorityInsertion.owner.id)
          .source.text,
      );
      equal(authorityInsertion.owner.preimage, originalPreimage);
      const historicalPreimage = await sha256(
        modelToolingTarget(intermediate, authorityInsertion.owner.id).source
          .text,
      );
      ok(historicalPreimage !== originalPreimage);
      const authorityText = await readHostEditText(authorityInsertion.text);
      const authority = [{
        op: "insertMember" as const,
        target: {
          ...structuredClone(authorityInsertion.owner),
          preimage: historicalPreimage,
        },
        // Historical receipts froze compiled member bytes in expect.sourceText;
        // their requested template could keep different comments and spacing.
        text: "// Historical authority template before provider formatting\n" +
          authorityText.replaceAll("\n", "\n\n"),
        expect: authorityInsertion.expect.flatMap((expectation) =>
          expectation.kind === "member"
            ? [{
              qualifiedName: expectation.qualifiedName,
              metaclass: expectation.metaclass,
              sourceText: modelToolingTarget(
                published.revision,
                String(
                  modelSourceElement(
                    published.revision,
                    expectation.qualifiedName,
                    expectation.metaclass,
                  )["@id"],
                ),
              ).source.text,
            }]
            : []
        ),
      }];
      ok(authority[0]!.text !== authorityText);
      ok(authority[0]!.expect.length > 0);
      ok(
        authority[0]!.expect.every((expectation) =>
          typeof expectation.sourceText === "string" &&
          expectation.sourceText.length > 0
        ),
      );
      const corruptScalar = (edits: PublicationEdit[]) => {
        const edit = edits.find((edit) => !("op" in edit));
        ok(edit && !("op" in edit));
        edit.value = "different historical scalar";
      };
      const corruptM1d = (edits: PublicationEdit[]) => {
        const edit = edits.find((edit) =>
          "op" in edit && edit.op === "insertMember" && "owner" in edit
        );
        ok(
          edit && "op" in edit && edit.op === "insertMember" && "owner" in edit,
        );
        const expectation = edit.expect.find((expectation) =>
          "path" in expectation
        );
        ok(expectation && "path" in expectation);
        expectation.value = "different historical insertion";
      };
      const corruptAuthority = (edits: PublicationEdit[]) => {
        const edit = edits.find(isOperatorAuthorityEdit);
        ok(edit);
        edit.expect[0]!.sourceText += "\n// divergent receipt";
      };
      const omitAuthoritySource = (edits: PublicationEdit[]) => {
        const edit = edits.find(isOperatorAuthorityEdit);
        ok(edit);
        delete edit.expect[0]!.sourceText;
      };
      const currentAuthority = (edits: PublicationEdit[]) => {
        const edit = currentHostEdits({ ...published.receipt!, edits }).find(
          (edit) => edit.op === "insertMember" && edit.intent === "authority",
        );
        ok(edit?.op === "insertMember" && edit.format === 1);
        return edit;
      };
      const omitCurrentSource = (edits: PublicationEdit[]) => {
        const expectation = currentAuthority(edits).expect.find(
          (expected) => expected.kind === "member",
        );
        ok(expectation?.kind === "member");
        delete expectation.sourceDigest;
      };
      const corruptCurrentSource = (edits: PublicationEdit[]) => {
        const expectation = currentAuthority(edits).expect.find(
          (expected) => expected.kind === "member",
        );
        ok(expectation?.kind === "member");
        expectation.sourceDigest = "f".repeat(64);
      };
      const omitCurrentMember = (edits: PublicationEdit[]) => {
        const edit = currentAuthority(edits);
        const index = edit.expect.findIndex((expected) =>
          expected.kind === "member"
        );
        ok(index >= 0);
        edit.expect.splice(index, 1);
      };
      const omitCurrentExpectations = (edits: PublicationEdit[]) => {
        currentAuthority(edits).expect = [];
      };
      const fixtures: {
        name: string;
        edits: PublicationEdit[];
        corruptions: ((edits: PublicationEdit[]) => void)[];
      }[] = [
        {
          name: "LegacyEdit scalar",
          edits: legacy,
          corruptions: [corruptScalar],
        },
        {
          name: "M1d insertion without kind",
          edits: m1d,
          corruptions: [corruptM1d],
        },
        {
          name: "OperatorAuthorityEdit target",
          edits: authority,
          corruptions: [corruptAuthority, omitAuthoritySource],
        },
        {
          name: "mixed scalar, M1d and authority",
          // The repeated scalar must not mask a corrupted legacy assertion.
          edits: [...legacy, ...m1d, ...authority, scalar],
          corruptions: [
            corruptScalar,
            corruptM1d,
            corruptAuthority,
            omitAuthoritySource,
          ],
        },
        {
          name: "current authority insertion with digest proof",
          edits: [structuredClone(authorityInsertion)],
          corruptions: [
            omitCurrentSource,
            corruptCurrentSource,
            omitCurrentMember,
            omitCurrentExpectations,
          ],
        },
      ];
      const path = `${directory}/${published.revision.version}.json`;
      const immutable = await Deno.readTextFile(path);
      const findPublication = repository.findPublication.bind(repository);
      let receivedReceipt: ChangePublication | undefined;
      repository.findPublication = async (changeId) => {
        const found = await findPublication(changeId);
        receivedReceipt = found?.receipt;
        return found;
      };
      try {
        for (const fixture of fixtures) {
          const receipt = {
            ...structuredClone(published.receipt!),
            edits: structuredClone(fixture.edits),
          };
          const snapshot = JSON.stringify({ ...published.revision, receipt });
          await Deno.writeTextFile(path, snapshot);
          const recovered = await model.findApprovedChange(
            identity,
            receipt.changeId,
          );
          ok(recovered, fixture.name);
          equal(
            JSON.stringify(recovered.receipt),
            JSON.stringify(receipt),
            fixture.name,
          );
          equal(
            JSON.stringify(receivedReceipt),
            JSON.stringify(receipt),
            fixture.name,
          );
          equal(await Deno.readTextFile(path), snapshot, fixture.name);
          for (const corrupt of fixture.corruptions) {
            const divergent = structuredClone(receipt);
            corrupt(divergent.edits);
            const divergentSnapshot = JSON.stringify({
              ...published.revision,
              receipt: divergent,
            });
            await Deno.writeTextFile(path, divergentSnapshot);
            await rejects(
              () => model.findApprovedChange(identity, receipt.changeId),
              (error: unknown) => {
                ok(error instanceof ChangePublicationError, fixture.name);
                equal(error.code, "PUBLICATION_RECEIPT_MISMATCH", fixture.name);
                return true;
              },
            );
            equal(
              JSON.stringify(receivedReceipt),
              JSON.stringify(divergent),
              fixture.name,
            );
            equal(
              await Deno.readTextFile(path),
              divergentSnapshot,
              fixture.name,
            );
            const stored = await repository.findPublication(receipt.changeId);
            equal(
              JSON.stringify(stored!.receipt),
              JSON.stringify(divergent),
              fixture.name,
            );
          }
        }
      } finally {
        await Deno.writeTextFile(path, immutable);
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

for (const transport of ["handler", "HTTP"] as const) {
  Deno.test({
    name:
      `T7: ${transport} refuses revision-1 proposal after revision-2 adoption`,
    ignore: !toolkitIntegrationEnabled,
    async fn() {
      const directory = await Deno.makeTempDir();
      const repository = new FileRepository(directory);
      const initialSources = await loadInitialSources(undefined, {
        information: false,
      });
      initialSources["configuration.sysml"] =
        initialSources["configuration.sysml"].replace(
          'configurationRevision : String = "0"',
          'configurationRevision : String = "1"',
        );
      const memory = await openMandateMemorySession({
        directory,
        repository,
        initialSources,
      });
      const model = memory.model;
      let manager: OperatorConversations | undefined;
      let server: Deno.HttpServer<Deno.NetAddr> | undefined;
      try {
        let { service, proposed } = await proposeMandateChange(memory);
        equal(proposed.baseRevision, 1);
        // The strict adoption gate refuses a moved pin while the revision-1
        // proposal is still pending, so the stale proposal is refused first;
        // the revision-ordering assertions below then run against a fresh
        // proposal filed at the adopted pin.
        await service.decideChange({
          changeId: proposed.id,
          expectedRevision: proposed.baseRevision,
          verdict: "refuse",
        });
        await drainDecisionCompletion(memory, proposed.id, "refused");
        await drainMandateQueue(memory);
        const head = await repository.current();
        await repository.publishSystemSources(
          {
            ...head.sources,
            "configuration.sysml": head.sources["configuration.sysml"].replace(
              'configurationRevision : String = "1"',
              'configurationRevision : String = "2"',
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
        equal(service.snapshot.configuration!.revision, 2);
        equal(service.snapshot.configuration!.changes[0].status, "refused");
        // Re-propose at the adopted pin; the stale revision below is the
        // superseded revision 1, no longer this proposal's base.
        ({ service, proposed } = await proposeMandateChange(memory));
        equal(proposed.baseRevision, 2);
        equal(service.snapshot.configuration!.changes[0].status, "pending");
        manager = new OperatorConversations({
          primary: service,
          factory: {
            open() {
              throw new Error("No peer");
            },
          },
        });
        await manager.initialize({
          repositoryVersion: replacement.version.repositoryVersion!,
          units: [{
            systemQualifiedName: "LiveBuilder::system",
            model: service.snapshot.executionModel!,
          }],
        });
        if (transport === "HTTP") {
          server = Deno.serve(
            { hostname: "127.0.0.1", port: 0, onListen() {} },
            async (request) =>
              await handle(request) ?? new Response(null, { status: 404 }),
          );
        }
        const servedOrigin = `http://127.0.0.1:${server?.addr.port ?? 4311}`;
        const handle = createConversationsHandler(manager, servedOrigin);
        const conversation = manager.snapshot.conversations.find((entry) =>
          entry.agentId === service.snapshot.model!.builderId
        )!;
        const owned = conversation.proposalContext!.changes.find((entry) =>
          entry.id === proposed.id
        )!;
        equal(conversation.proposalContext!.configurationRevision, 2);
        const requestFor = (configurationRevision: number) =>
          new Request(
            `${servedOrigin}/api/conversations/${
              encodeURIComponent(conversation.agentId)
            }/changes/${proposed.id}/decision`,
            {
              method: "POST",
              headers: {
                host: new URL(servedOrigin).host,
                origin: servedOrigin,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                expectedRevision: conversation.revision,
                configurationRevision,
                verdict: "refuse",
              }),
            },
          );
        const send = async (configurationRevision: number) => {
          const request = requestFor(configurationRevision);
          return server ? await fetch(request) : (await handle(request))!;
        };
        // The superseded revision is not the proposal's identity: only the
        // exact base revision is decidable.
        const stale = await send(owned.baseRevision - 1);
        equal(stale.status, 409);
        const failure = await stale.json();
        equal(failure.code, "PUBLICATION_FAILED");
        equal(failure.recovery, "retry");
        equal(service.snapshot.configuration!.changes[0].status, "pending");
        const response = await send(owned.baseRevision);
        const body = await response.json();
        equal(response.status, 202, JSON.stringify(body));
        equal(body.accepted, true);
        // The refusal is a memory worker outcome: drain the accepted
        // command, then read the refused change from the canonical state.
        await drainDecisionCompletion(memory, proposed.id, "refused");
        equal(service.snapshot.configuration!.changes[0].status, "refused");
        equal(
          (await memory.storage.state.load())!.configuration!.changes[0]
            .status,
          "refused",
        );
        deepStrictEqual(
          service.snapshot.executionModel!.version,
          replacement.version,
        );
        equal(await repository.findPublication(proposed.id), null);
      } finally {
        await server?.shutdown();
        await manager?.dispose();
        await memory.close();
        await Deno.remove(directory, { recursive: true });
      }
    },
  });
}

Deno.test({
  name:
    "B2: a comment in CapabilityPromotion refuses transformation while the proposal remains pending and refusable",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir();
    const repository = new FileRepository(directory);
    const initialSources = await loadInitialSources(undefined, {
      information: false,
    });
    initialSources["configuration.sysml"] =
      initialSources["configuration.sysml"].replace(
        "action def CapabilityPromotion {",
        "action def CapabilityPromotion {\n    /* customized promotion */",
      );
    const memory = await openMandateMemorySession({
      directory,
      repository,
      initialSources,
      preProposed: true,
    });
    try {
      const base = memory.service.snapshot.executionModel!;
      const governance = SystemGovernance.fromExecutable(base);
      const proposed = governance.propose(
        {
          kind: "propose_agent_creation",
          text: "Review",
          reason: "Independent reviewer",
          role: "reviewer",
          name: "Reviewer",
          mandate: {
            mayReviewExactCandidate: true,
            mayAdmitReviewedCandidates: true,
          },
        },
        crypto.randomUUID(),
        "now",
        {
          requestedBy: base.identity.builderId,
          designerScopeId: "recovery-test:designer",
        },
      );
      const saved = (await memory.storage.state.load())!;
      saved.designer = { scopeId: "recovery-test:designer" };
      saved.caseInvocation = {
        kind: "designer",
        scopeId: "recovery-test:designer",
      };
      saved.configuration!.changes = [proposed];
      const inputMessageId = crypto.randomUUID();
      saved.messages = [
        ...(saved.messages ?? []),
        {
          id: inputMessageId,
          role: "user",
          text: "Review",
          at: "now",
          designerScopeId: "recovery-test:designer",
        },
      ];
      saved.activeInputMessageId = inputMessageId;
      const previous = saved.revision++;
      await memory.storage.state.save(saved, previous);
      // Same-store restart: the fresh runtime reloads the filed proposal
      // from the memory store.
      const restarted = await restartMemoryService(memory);
      const input = {
        changeId: proposed.id,
        expectedRevision: proposed.baseRevision,
        verdict: "approve" as const,
      };
      await restarted.decideChange(input);
      await drainDecisionRefusal(memory, (error: unknown) => {
        ok(error instanceof ChangePublicationError);
        equal(error.code, "PUBLICATION_NOT_APPLICABLE");
        equal(error.recovery, "refuse");
        equal(error.context.changeId, proposed.id);
        ok(error.message.includes("customized CapabilityPromotion"));
      });
      equal(restarted.snapshot.configuration!.changes[0].status, "pending");
      equal(
        restarted.snapshot.configuration!.changes[0].publication,
        undefined,
      );
      equal(
        (await repository.current()).version,
        base.version.repositoryVersion,
      );
      // Settle the refused approval's retries before refusing: later drains
      // must only observe the refuse command.
      await drainMandateQueue(memory);
      await restarted.decideChange({ ...input, verdict: "refuse" });
      await drainDecisionCompletion(memory, proposed.id, "refused");
      equal(restarted.snapshot.configuration!.changes[0].status, "refused");
      const next = SystemGovernance.fromExecutable(
        restarted.snapshot.executionModel!,
        restarted.snapshot.configuration!.changes,
      ).propose(
        {
          kind: "propose_mandate_change",
          text: "Host",
          reason: "New request",
          requestedRights: { addNetworkHosts: ["next.example"] },
        },
        crypto.randomUUID(),
        "later",
        {
          requestedBy: base.identity.builderId,
          designerScopeId: "recovery-test:designer",
        },
      );
      equal(next.status, "pending");
    } finally {
      await drainMandateQueue(memory);
      await memory.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "Toolkit: published literals divergent from receipt.edits block direct recovery and reconciliation",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir();
    const repository = new FileRepository(directory);
    const memory = await openMandateMemorySession({
      directory,
      repository,
      initialSources: await loadInitialSources(undefined, {
        information: false,
      }),
    });
    const model = memory.model;
    try {
      const { service } = await proposeMandateChange(memory);
      const before = service.snapshot;
      const proposed = before.configuration!.changes[0];
      const approved = SystemGovernance.fromExecutable(before.executionModel!, [
        proposed,
      ])
        .decideChange(proposed.id, proposed.baseRevision, true, "now");
      const receipt = changePublication(
        approved,
        before.executionModel!.version,
      );
      repository.divergentReceipt = true;
      repository.afterPublish = () =>
        Promise.reject(new Error("Lost publication return"));
      await rejects(
        () =>
          model.applyApprovedChange(
            before.model!,
            approved,
            before.executionModel!.version.digest,
            receipt,
          ),
        /Lost publication return/,
      );
      const published = await repository.findPublication(proposed.id);
      ok(published);
      ok(canonical(published.receipt!.edits) !== canonical(receipt.edits));
      const objectsBefore = await repository.history();
      repository.afterPublish = undefined;
      repository.beforeUpdate = () => {
        throw new Error("Updater must not run during recovery");
      };
      const mismatch = (error: unknown) => {
        ok(error instanceof ChangePublicationError);
        equal(error.code, "PUBLICATION_RECEIPT_MISMATCH");
        equal(error.context.changeId, proposed.id);
        equal(error.context.systemId, before.model!.systemId);
        deepStrictEqual(error.recovery, { action: "reload" });
        ok(error.message.includes("networkHosts"));
        return true;
      };
      await rejects(
        () =>
          model.applyApprovedChange(
            before.model!,
            approved,
            before.executionModel!.version.digest,
            changePublication(approved, before.executionModel!.version),
          ),
        mismatch,
      );
      let writes = 0;
      const host = {
        state: structuredClone(before),
        ports: { model },
        update: () => {
          writes++;
          return Promise.resolve();
        },
        adopt: () => {
          writes++;
          return Promise.resolve();
        },
      };
      await rejects(() => reconcileChangePublications.call(host), mismatch);
      equal(writes, 0);
      deepStrictEqual(host.state, before);
      deepStrictEqual(await repository.history(), objectsBefore);
      equal(
        (await memory.storage.state.load())!.configuration!.changes[0]
          .status,
        "pending",
      );
    } finally {
      await memory.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

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
  for (const published of [false] as const) {
    Deno.test({
      name:
        `T6: ${entry} reconciles before stale-base decisions, published=${published}`,
      ignore: !toolkitIntegrationEnabled,
      async fn() {
        const directory = await Deno.makeTempDir();
        const repository = new FileRepository(directory);
        const initialSources = await loadInitialSources(undefined, {
          information: false,
        });
        const memory = await openMandateMemorySession({
          directory,
          repository,
          initialSources,
        });
        const model = memory.model;
        let manager: OperatorConversations | undefined;
        let server: Deno.HttpServer<Deno.NetAddr> | undefined;
        try {
          let { service, proposed } = await proposeMandateChange(memory);
          const input = {
            changeId: proposed.id,
            expectedRevision: proposed.baseRevision,
            verdict: "approve" as const,
          };
          repository.beforePublish = () =>
            Promise.reject(new Error("Before publication"));
          // decideChange only enqueues: the injected failure surfaces on the
          // memory worker and is read back from the worker error.
          await service.decideChange(input);
          await drainDecisionRefusal(memory, (error: unknown) => {
            ok(
              /Lost closure save|Before publication/.test(
                error instanceof Error ? error.message : String(error),
              ),
              String(error),
            );
          });
          repository.beforePublish = undefined;
          // Settle the injected phase-1 refusal (and its retries) before
          // touching the model pin: a running worker trips the adoption
          // fence, and later drains must only observe the decided commands.
          await drainMandateQueue(memory);
          // The strict adoption gate refuses a moved pin while the phase-1
          // proposal is still pending, so the stale proposal is decided
          // first, per this scenario's original intent, before any adoption.
          // The approval never published: the stale proposal is refused, so
          // the manual adoption below has no pending change to protect.
          await service.decideChange({ ...input, verdict: "refuse" });
          await drainDecisionCompletion(memory, proposed.id, "refused");
          await drainMandateQueue(memory);
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
            "refused",
          );
          const pin = service.snapshot.executionModel!.version;
          // Re-propose at the adopted pin; the per-transport decisions below
          // run against the fresh proposal.
          ({ service, proposed } = await proposeMandateChange(memory));
          equal(service.snapshot.configuration!.changes[0].status, "pending");
          deepStrictEqual(service.snapshot.executionModel!.version, pin);
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
          await decide("approve");
          await drainDecisionRefusal(
            memory,
            journalRefusal("PUBLICATION_NOT_APPLICABLE"),
          );
          await decide("refuse");
          await drainDecisionCompletion(memory, proposed.id, "refused");
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
          deepStrictEqual(service.snapshot.executionModel!.version, pin);
          equal(
            (await repository.history()).commits.length,
            3,
          );
        } finally {
          await server?.shutdown();
          await manager?.dispose();
          await drainMandateQueue(memory);
          await memory.close();
          await Deno.remove(directory, { recursive: true });
        }
      },
    });
  }
}
