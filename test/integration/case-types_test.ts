import assert from "node:assert/strict";
import { caseTypesForModel } from "../../src/domain/work/records/case-types.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { resolveModelEdits } from "../../src/domain/model/editing/source-index.ts";
import type { ModelEdit } from "../../src/domain/model/editing/tooling.ts";
import { CaseError } from "../../src/domain/work/errors/case.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const projectId = "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb";
const request = `part request : AssemblyCases::CaseType {
 attribute :>> envelope = AssemblyCases::EnvelopeKind::conversational;
 ref action :>> behavior = conversation;
 ref part :>> owner = builder;
 attribute :>> maxInvocations = 12;
}`;

async function compile(options: {
  extra?: string;
  library?: boolean;
  legacyEnvelope?: boolean;
  importLibrary?: boolean;
} = {}) {
  let sources = await loadInitialSources(undefined, { information: false });
  if (options.library === false) delete sources["cases.sysml"];
  if (options.importLibrary) {
    sources["configuration.sysml"] = sources["configuration.sysml"].replace(
      "package AssemblyLiveBuilder {",
      "package AssemblyLiveBuilder {\n    private import AssemblyCases::*;",
    );
  }
  const compiler = new ToolkitCompiler({ packageDir: packageDir! });
  let compiled = await compiler.compile(sources);
  const edits: ModelEdit[] = [];
  const nativeId = (qualifiedName: string) => {
    const element = compiled.elements.find((entry) =>
      entry.qualifiedName === qualifiedName
    );
    assert.equal(typeof element?.["@id"], "string");
    return String(element!["@id"]);
  };
  if (options.extra) {
    edits.push({
      kind: "insert-member",
      elementId: nativeId("AssemblyLiveBuilder::liveBuilder"),
      text: options.extra,
    });
  }
  if (options.legacyEnvelope === false) {
    for (
      const name of ["envelopeKind", "envelopePattern", "envelopeRevision"]
    ) {
      edits.push({
        kind: "remove",
        elementId: nativeId(`AssemblyLiveBuilder::liveBuilder::${name}`),
      });
    }
  }
  if (edits.length) {
    sources = (await new SysmlToolkitAdapter({ packageDir: packageDir! }).edit(
      sources,
      resolveModelEdits({ ...compiled, version: "case-types-base" }, edits),
    )).sources;
    compiled = await compiler.compile(sources);
  }
  return await validateSourceExecutable(
    { ...compiled, version: "case-types-test" },
    projectId,
  );
}

Deno.test({
  name: "real AssemblyCases library preserves historical executable encodings",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const legacy = await compile({ library: false });
    const withLibrary = await compile({ importLibrary: true });
    assert.deepEqual(withLibrary, legacy);
    assert.equal(Object.hasOwn(withLibrary, "caseTypes"), false);
    const [implicit] = caseTypesForModel(legacy);
    assert.equal(implicit.type, "request");
    assert.equal(implicit.ownerId, legacy.identity.builderId);
    assert.equal(implicit.behaviorId, legacy.flows.conversation.rootNativeId);
  },
});

Deno.test({
  name:
    "real Toolkit reads typed Every and DailyAt schedules and refuses invalid native values",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const scheduled = (name: string, envelope: string, schedule: string) =>
      `part ${name} : AssemblyCases::CaseType {
      attribute :>> envelope = AssemblyCases::EnvelopeKind::${envelope};
      ref action :>> behavior = conversation;
      ref part :>> owner = builder;
      attribute :>> maxInvocations = 3;
      ${schedule}
    }`;
    const every = (count: number, unit: string) =>
      `attribute :>> schedule : AssemblyCases::Every { :>> count = ${count}; :>> unit = AssemblyCases::ScheduleUnit::${unit}; }`;
    const daily = (hour: number, minute: number) =>
      `attribute :>> schedule : AssemblyCases::DailyAt { :>> hour = ${hour}; :>> minute = ${minute}; }`;
    const model = await compile({
      extra: request +
        scheduled("minuteJob", "deterministic", every(15, "minute")) +
        scheduled("hourJob", "deterministic", every(3, "hour")) +
        scheduled("dayJob", "deterministic", every(1, "day")) +
        scheduled("'Morning summary'", "deterministic", daily(8, 0)) +
        scheduled("morningWatch", "reassessment", daily(23, 59)),
    });
    assert.deepEqual(
      model.caseTypes!.find((entry) => entry.name === "minuteJob")!.schedule,
      { kind: "every", count: 15, unit: "minute" },
    );
    assert.deepEqual(
      model.caseTypes!.find((entry) => entry.name === "Morning summary")!
        .schedule,
      { kind: "daily-at", hour: 8, minute: 0 },
    );
    assert.equal(
      model.caseTypes!.find((entry) => entry.name === "morningWatch")!.type,
      "watch",
    );
    for (
      const schedule of [
        every(0, "minute"),
        every(1.5, "hour"),
        every(9007199254740991, "day"),
        daily(24, 0),
        daily(9, 60),
        'attribute :>> schedule = "every 15m";',
        "attribute :>> schedule : AssemblyCases::Every { :>> count = 1; }",
        'attribute :>> schedule : AssemblyCases::Every { :>> count = 1; :>> unit = "minute"; }',
      ]
    ) {
      await assert.rejects(
        () =>
          compile({
            extra: request + scheduled("invalidJob", "deterministic", schedule),
          }),
        (error) =>
          error instanceof CaseError && error.code === "INVALID_SCHEDULE" &&
            !!error.context?.caseTypeId && !!error.recovery ||
          error instanceof Error &&
            /Toolkit validation refused/.test(error.message),
      );
    }
  },
});

Deno.test({
  name:
    "real AssemblyCases compiles typed envelopes references and invocation budget",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const model = await compile({ extra: request });
    assert.equal(model.caseTypes?.length, 1);
    const caseType = model.caseTypes![0];
    assert.equal(caseType.type, "request");
    assert.equal(caseType.envelope, "conversational");
    assert.equal(caseType.ownerId, model.identity.builderId);
    assert.equal(caseType.behaviorId, model.flows.conversation.rootNativeId);
    assert.equal(caseType.maxInvocations, 12);
    const withoutLegacy = await compile({
      extra: request,
      legacyEnvelope: false,
    });
    assert.deepEqual(withoutLegacy.caseTypes, model.caseTypes);
  },
});

Deno.test({
  name:
    "real AssemblyCases declares future envelopes and rejects untyped values",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const job = request.replace("part request", "part job").replace(
      "::conversational",
      "::deterministic",
    );
    const watch = request.replace("part request", "part watch").replace(
      "::conversational",
      "::reassessment",
    ).replace("attribute :>> maxInvocations = 12;", "");
    const model = await compile({ extra: request + job + watch });
    assert.deepEqual(
      model.caseTypes!.map((type) => type.type).sort(),
      ["job", "request", "watch"],
    );
    assert.equal(
      model.caseTypes!.find((type) => type.type === "watch")!.maxInvocations,
      undefined,
    );
    await assert.rejects(
      () =>
        compile({
          extra: request.replace(
            "AssemblyCases::EnvelopeKind::conversational",
            '"conversational"',
          ),
        }),
      /Expected an enum|Invalid native case type|Toolkit validation refused|Legacy String/,
    );
  },
});
