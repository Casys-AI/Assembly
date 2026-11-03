import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { sourceSnapshot } from "../../src/adapters/model/projections/graph/source.ts";
import {
  AuthorityInvariantError,
  exerciseOwnerAuthority,
} from "../../src/domain/governance/authority.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test({
  name:
    "Toolkit compiles the modeled owner, readable invariants and its exact root provenance",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const sources = await loadInitialSources(undefined, { information: false });
    const compiled = await compiler.compile(sources);
    const revision = { ...compiled, version: "test:owner" };
    const model = await validateSourceExecutable(
      revision,
      "git:cdc1ab4f-083e-533c-90ca-953c38b63a92",
    );
    const owner = model.ownerAuthority!;
    assert(owner.ownerSource === "modeled");
    assert(owner.mandateId === "owner" && owner.mandateRevision === 1);
    assert(owner.rootAuthorityId === "owner-root");
    assert(owner.rootGrantId === "owner-root-grant");
    assert(model.version.authoritySchema === 2);
    const snapshot = sourceSnapshot(compiled.elements, model.identity.rootId);
    const requirements = snapshot.elements.filter((e) =>
      e.metaclass === "RequirementDefinition" &&
      e.qualifiedName.startsWith("AssemblyAuthority::")
    );
    assert(
      requirements.length === 5 &&
        requirements.every((e) => e.doc.includes("Invariant")),
    );
    const systemType = snapshot.elements.find((e) =>
      e.qualifiedName === "AssemblyLiveBuilder::ConversationSystem"
    );
    assert(systemType);
    for (const requirement of requirements) {
      const subjects = snapshot.elements.filter((e) =>
        e.ownerId === requirement.id && e.name === "system"
      );
      assert(subjects.length === 1);
      assert(subjects[0]!.typeIds.includes(systemType.id));
    }
    const receipt = exerciseOwnerAuthority(model, "model-adoption");
    assert(receipt.rootGrantNativeId === owner.rootGrantNativeId);
    assert(
      receipt.baseModelDigest === model.version.digest && !receipt.outOfMandate,
    );

    const changed = structuredClone(sources);
    changed["configuration.sysml"] = changed["configuration.sysml"]!.replace(
      'attribute :>> id = "owner-root-grant";',
      'attribute :>> id = "revised-root-grant";',
    );
    const next = await validateSourceExecutable(
      { ...await compiler.compile(changed), version: "test:owner-next" },
      model.identity.projectId,
    );
    assert(
      next.version.digest !== model.version.digest,
      "Root grant identity must affect versioned execution semantics",
    );

    for (
      const [before, after] of [
        ["bind rootGrant.issuer = rootAuthority;", ""],
        [
          "owner : AssemblyCore::HumanOperator",
          "owner : AssemblyCore::HumanOperator [0]",
        ],
        [
          "rootGrant : AssemblyAuthority::RootGrant",
          "rootGrant : AssemblyAuthority::RootGrant [2]",
        ],
      ]
    ) {
      const malformed = structuredClone(sources);
      malformed["configuration.sysml"] = malformed["configuration.sysml"]!
        .replace(before!, after!);
      let rejected = false;
      try {
        await validateSourceExecutable(
          {
            ...await compiler.compile(malformed),
            version: "test:owner-invalid",
          },
          model.identity.projectId,
        );
      } catch (error) {
        assert(
          error instanceof AuthorityInvariantError && error.invariant === 1,
          String(error),
        );
        rejected = true;
      }
      assert(
        rejected,
        `Malformed owner must not become legacy: ${after || before}`,
      );
    }
  },
});

Deno.test({
  name:
    "Toolkit keeps historical business owner fields in implicit legacy authority",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const sources = await loadInitialSources(undefined, { information: false });
    const configuration = sources["configuration.sysml"]!;
    const declarationStart = configuration.indexOf("        part owner :");
    const declarationEnd = configuration.indexOf("        part builder :");
    assert(declarationStart >= 0 && declarationEnd > declarationStart);
    const declaration = configuration.slice(declarationStart, declarationEnd);
    const legacy = configuration.replace(declaration, "").replace(
      "        attribute authoritySchema : Integer = 2;\n",
      "",
    );
    for (
      const businessMembers of [
        'attribute owner : String = "commercial team";',
        'attribute authoritySchema : String = "sales-v1";',
        'item businessRecord { attribute owner : String = "Alice"; }',
        `item businessRecord { ${declaration} }`,
      ]
    ) {
      const historicalSources = {
        ...sources,
        "configuration.sysml": legacy.replace(
          "        part builder :",
          `        ${businessMembers}\n        part builder :`,
        ),
      };
      const model = await validateSourceExecutable(
        {
          ...await compiler.compile(historicalSources),
          version: "test:legacy",
        },
        "git:cdc1ab4f-083e-533c-90ca-953c38b63a92",
      );
      assert(model.ownerAuthority?.ownerSource === "implicit-legacy");
    }
  },
});

Deno.test({
  name:
    "Toolkit resolves renamed root-bearing authority usages by type and position",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const sources = await loadInitialSources(undefined, { information: false });
    sources["configuration.sysml"] = sources["configuration.sysml"]!
      .replace(
        "owner : AssemblyCore::HumanOperator",
        "custodian : AssemblyCore::HumanOperator",
      )
      .replaceAll("owner.", "custodian.")
      .replace("= owner;", "= custodian;")
      .replaceAll("ownerMandate", "custody")
      .replaceAll("rootAuthority", "origin")
      .replaceAll("rootGrant", "permission")
      .replace(
        "        part builder :",
        '        attribute owner : String = "commercial team";\n' +
          '        item businessRecord { attribute owner : String = "Alice"; }\n' +
          "        part builder :",
      );
    const model = await validateSourceExecutable(
      { ...await compiler.compile(sources), version: "test:renamed-owner" },
      "git:cdc1ab4f-083e-533c-90ca-953c38b63a92",
    );
    assert(model.ownerAuthority?.ownerSource === "modeled");
    assert(model.ownerAuthority.operatorId === "custodian");
    assert(model.ownerAuthority.mandateId === "owner");
    assert(model.ownerAuthority.rootAuthorityId === "owner-root");
    assert(model.ownerAuthority.rootGrantId === "owner-root-grant");
  },
});
