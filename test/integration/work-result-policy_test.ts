import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import {
  compareWorkResult,
  instantiateWorkResultContract,
} from "../../src/domain/work/policies/verified-effect-closure.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import {
  verifiedBoundRecordSources,
  verifiedRecordSources,
  verifiedWorkSources,
} from "../support/verified-work-fixture.ts";
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
Deno.test({
  name: "native verified-effect contract compiles through real SysML toolkit",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await verifiedWorkSources();
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(sources);
    const model = await validateSourceExecutable({
      ...compiled,
      version: "test",
    }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
    assert.equal(model.workResultContracts?.length, 1);
    assert.equal(model.workResultContracts![0]!.maxObservations, 2);
    const contract = model.workResultContracts![0]!;
    const subject = {
      callerId: "caller",
      workInvocationId: "publication-1",
      workBehaviorId: contract.workBehaviorId,
      workInputDigest: "a".repeat(64),
      modelVersion: {
        digest: model.version.digest,
        repositoryVersion: "publication",
      },
    };
    const values = {
      count: 1,
      name: "reader",
      kind: "read_web_page",
      localStatus: "active",
      nativeStatus: "active",
      storedDigest: "d",
      actualDigest: "d",
      nativeDigest: "d",
      admittedDigest: "d",
      admittedCandidateId: "candidate",
      candidateId: "candidate",
      testsPassed: true,
      nativeId: "native:one",
      bindingId: "native:one",
      nativeCount: 1,
      nativeName: "reader",
      nativeKind: "read_web_page",
      nativeContractCount: 1,
      nativeContractKind: "read_web_page",
    };
    assert.equal(
      compareWorkResult(contract, {
        ...subject,
        available: true,
        source: { id: "catalog", revision: "1" },
        values,
      }, subject),
      "verified",
    );
    assert.equal(
      compareWorkResult(contract, {
        ...subject,
        available: true,
        source: { id: "catalog", revision: "1" },
        values: { ...values, bindingId: "native:another" },
      }, subject),
      "contradicted",
    );
  },
});
Deno.test({
  name:
    "native verified-effect profile rejects missing refs, same read/work access, incomplete values and budget",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    for (
      const [from, to] of [
        [
          "bind resultContract.work = AssemblyLiveBuilder::liveBuilder.collectorAccess;",
          "",
        ],
        [
          "AssemblyLiveBuilder::liveBuilder.observationAccess;",
          "AssemblyLiveBuilder::liveBuilder.collectorAccess;",
        ],
        [
          "attribute :>> maxObservations = 2;",
          "attribute :>> maxObservations = 9;",
        ],
        [
          "attribute :>> maxObservations = 2;",
          "attribute :>> maxObservations = 2; attribute :>> maxObservations = 1;",
        ],
        [
          'attribute :>> status = "active";',
          "",
        ],
        ["observed.name == expected.name", "observed.name >= expected.name"],
        ["observed.name == expected.name", "observed.name == expected.count"],
      ]
    ) {
      const sources = await verifiedWorkSources();
      sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
        from,
        to,
      );
      await assert.rejects(async () => {
        const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
          .compile(sources);
        return validateSourceExecutable(
          { ...compiled, version: "test" },
          "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb",
        );
      }, /Invalid native work result contract|Toolkit validation refused/);
    }
  },
});
Deno.test({
  name: "unused verified-effect library does not change executable digest",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await verifiedWorkSources(false);
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const compile = async () =>
      validateSourceExecutable({
        ...await compiler.compile(sources),
        version: "test",
      }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
    const before = await compile();
    delete sources["verified-effect-closure.sysml"];
    const after = await compile();
    assert.equal(before.version.digest, after.version.digest);
    assert.equal(before.workResultContracts, undefined);
  },
});
Deno.test({
  name:
    "same native compiler handles an independent record status and amount criterion",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await verifiedRecordSources();
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(sources);
    const model = await validateSourceExecutable({
      ...compiled,
      version: "record",
    }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
    assert.deepEqual(model.workResultContracts![0]!.expected.values, {
      amount: 20,
      status: "paid",
    });
    assert.equal(
      model.workResultContracts![0]!.condition.expression.kind,
      "binary",
    );
    assert(model.workResultContracts![0]!.condition.sourceIds.length > 5);
    const contract = model.workResultContracts![0]!;
    const subject = {
      callerId: "caller",
      workInvocationId: "work-1",
      workBehaviorId: contract.workBehaviorId,
      workInputDigest: "a".repeat(64),
      modelVersion: {
        digest: model.version.digest,
        repositoryVersion: "record",
      },
    };
    const observation = {
      ...subject,
      available: true,
      source: { id: "record:1", revision: "1" },
      values: { status: "paid", amount: 25 },
    };
    assert.equal(compareWorkResult(contract, observation, subject), "verified");
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
      "observed.amount >= expected.amount",
      "observed.amount <= expected.amount",
    );
    const changed = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(sources);
    const changedModel = await validateSourceExecutable({
      ...changed,
      version: "record",
    }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
    assert.equal(
      compareWorkResult(
        changedModel.workResultContracts![0]!,
        observation,
        subject,
      ),
      "contradicted",
    );
    assert.notEqual(changedModel.version.digest, model.version.digest);
  },
});
Deno.test({
  name: "native observed item must match the read action's unique typed output",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    for (const replacement of ["out result : Expected;", ""]) {
      const sources = await verifiedRecordSources();
      sources["record-state.sysml"] = sources["record-state.sysml"]!.replace(
        "out result : Observed;",
        replacement,
      );
      const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
        .compile(sources);
      await assert.rejects(
        () =>
          validateSourceExecutable(
            { ...compiled, version: "output-mismatch" },
            "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb",
          ),
        /observation action output must match observed item type/,
      );
    }
  },
});
Deno.test({
  name:
    "native Real result values retain their numeric type through compilation and comparison",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await verifiedRecordSources();
    sources["record-state.sysml"] = sources["record-state.sysml"]!.replaceAll(
      "amount : Integer",
      "amount : Real",
    );
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
      "amount = 20;",
      "amount = 20.5;",
    );
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(sources);
    const model = await validateSourceExecutable({
      ...compiled,
      version: "real-result",
    }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
    const contract = model.workResultContracts![0]!;
    assert.equal(contract.expected.values.amount, 20.5);
    const subject = {
      callerId: "caller",
      workInvocationId: "real-work",
      workBehaviorId: contract.workBehaviorId,
      workInputDigest: "a".repeat(64),
      modelVersion: {
        digest: model.version.digest,
        repositoryVersion: "real-result",
      },
    };
    const observation = {
      ...subject,
      available: true,
      source: { id: "record-A", revision: "1" },
      values: { status: "paid", amount: 25.25 },
    };
    assert.equal(compareWorkResult(contract, observation, subject), "verified");
    assert.equal(
      compareWorkResult(contract, {
        ...observation,
        values: { status: "paid", amount: 19.25 },
      }, subject),
      "contradicted",
    );
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
      "amount = 20.5;",
      "amount = 20.0;",
    );
    const wholeCompiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(sources);
    const wholeModel = await validateSourceExecutable({
      ...wholeCompiled,
      version: "real-whole",
    }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
    assert.equal(
      wholeModel.workResultContracts![0]!.expected.values.amount,
      20,
    );
    assert.equal(
      (wholeModel.workResultContracts![0]!.expected.schema.properties as Record<
        string,
        { type: string }
      >).amount!.type,
      "number",
    );
  },
});

Deno.test({
  name:
    "native admitted work input binds expected values and read query before effects",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await verifiedBoundRecordSources();
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(sources);
    const model = await validateSourceExecutable({
      ...compiled,
      version: "bound-input",
    }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
    const template = model.workResultContracts![0]!;
    assert.equal(template.valueBindings?.length, 3);
    const first = instantiateWorkResultContract(template, {
      recordId: "record-A",
      status: "paid",
      amount: 20,
    });
    const second = instantiateWorkResultContract(template, {
      recordId: "record-B",
      status: "settled",
      amount: 45,
    });
    assert.deepEqual(first.expected.values, { amount: 20, status: "paid" });
    assert.deepEqual(second.expected.values, { amount: 45, status: "settled" });
    assert.deepEqual(second.query!.values, { recordId: "record-B" });
    assert(
      template.valueBindings!.every((binding) => binding.sourceIds.length >= 4),
    );
  },
});
Deno.test({
  name:
    "native result field redefinitions reject collection cardinality for bindings and literals",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    for (const cardinality of ["0..*", "2..2"]) {
      for (const bound of [true, false]) {
        const sources = bound
          ? await verifiedBoundRecordSources()
          : await verifiedRecordSources();
        sources["configuration.sysml"] = bound
          ? sources["configuration.sysml"]!.replace(
            "item :>> expected : RecordState::Expected;",
            `item :>> expected : RecordState::Expected { attribute :>> amount [${cardinality}]; }`,
          )
          : sources["configuration.sysml"]!.replace(
            "attribute :>> amount = 20;",
            `attribute :>> amount [${cardinality}] = 20;`,
          );
        await assert.rejects(async () => {
          const compiled = await new ToolkitCompiler({
            packageDir: packageDir!,
          }).compile(sources);
          return validateSourceExecutable({
            ...compiled,
            version: "invalid-cardinality",
          }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
        }, /singleton result field redefinition|Toolkit validation refused/);
      }
    }
  },
});
Deno.test({
  name:
    "native input templates reject foreign roots, cycles, duplicate or mixed values and scalar mismatches",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const cases: [string, string][] = [
      [
        "resultContract.expected.status = resultContract.input.status",
        "resultContract.expected.status = resultContract.observed.status",
      ],
      [
        "resultContract.expected.amount = resultContract.input.amount",
        "resultContract.expected.amount = resultContract.expected.amount",
      ],
      [
        "resultContract.expected.amount = resultContract.input.amount",
        "resultContract.expected.amount = resultContract.input.recordId",
      ],
      [
        "bind resultContract.expected.amount = resultContract.input.amount;",
        "bind resultContract.expected.amount = resultContract.input.amount; bind resultContract.expected.amount = resultContract.input.amount;",
      ],
      [
        "item :>> expected : RecordState::Expected;",
        "item :>> expected : RecordState::Expected {attribute :>> amount = 20;}",
      ],
      [
        "bind resultContract.input = AssemblyLiveBuilder::liveBuilder.collectorAccess.input;",
        "bind resultContract.input = AssemblyLiveBuilder::liveBuilder.observationAccess.input;",
      ],
    ];
    for (const [from, to] of cases) {
      const sources = await verifiedBoundRecordSources();
      sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
        from,
        to,
      );
      await assert.rejects(
        async () => {
          const compiled = await new ToolkitCompiler({
            packageDir: packageDir!,
          }).compile(sources);
          return validateSourceExecutable({
            ...compiled,
            version: "invalid-binding",
          }, "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb");
        },
        /Invalid native work result contract|Behavior input is a schema reference|Toolkit validation refused/,
      );
    }
  },
});
