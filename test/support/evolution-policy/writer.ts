/** Construct native policy source through the shared writer; this grants nothing by itself. */
import type { ResolvedModelEdit } from "../../../src/domain/model/editing/tooling.ts";
import type { ModelIdentity } from "../../../src/domain/shared-kernel/model-identity.ts";
import {
  type EvolutionGrant,
  parseEvolutionGrants,
  requireEvolution,
} from "../../../src/domain/model/evolution/policy.ts";
import { validateModelEditPolicyIdentity } from "../../../src/domain/governance/policies/model-edit-policy.ts";
import { sameProductName } from "../../../src/domain/model/sysml-product-names.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../../src/domain/model/projections/source-facts.ts";
import { modelToolingTarget } from "../../../src/domain/model/editing/source-index.ts";
import type { SourceRevision } from "../../../src/domain/model/records/source-revision.ts";
import { compileEvolutionPolicy } from "../../../src/adapters/out/sysml-toolkit/compilation-policies/governance/model-access/evolution/policy.ts";

export function buildEvolutionPolicyEdits(
  base: SourceRevision,
  identity: ModelIdentity,
  input: {
    id: string;
    expectedRevision: number;
    grants: EvolutionGrant[];
  },
): ResolvedModelEdit[] {
  requireEvolution(
    Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
    "Invalid expected evolution policy revision",
  );
  validateModelEditPolicyIdentity(input.id, input.expectedRevision + 1);
  const encoded = JSON.stringify(input.grants);
  parseEvolutionGrants(encoded);
  const snapshot = sourceSnapshot(base.elements, identity.rootId);
  const current = compileEvolutionPolicy(
    snapshot,
    sourceLiterals(base.elements),
    identity,
  );
  requireEvolution(
    (current?.revision ?? 0) === input.expectedRevision &&
      (!current || current.id === input.id),
    "Evolution policy changed before source preparation",
  );
  const definitions = snapshot.elements.filter((element) =>
    sameProductName(
      element.qualifiedName,
      "AssemblyEvolution::EvolutionPolicy",
    ) && element.metaclass === "PartDefinition"
  );
  requireEvolution(
    definitions.length === 1,
    "Missing exact native EvolutionPolicy definition",
  );
  const text = `part evolutionPolicy : ${
    definitions[0]!.qualifiedName
  } {\n attribute :>> id = ${
    JSON.stringify(input.id)
  };\n attribute :>> revision = ${
    input.expectedRevision + 1
  };\n attribute :>> grants = ${JSON.stringify(encoded)};\n}`;
  if (current) {
    return [{
      kind: "replace-member",
      target: modelToolingTarget(base, current.elementId),
      text,
    }];
  }
  return [{
    kind: "insert-member",
    target: modelToolingTarget(base, identity.systemId),
    text:
      `${text}\nbind evolutionPolicy.holder = builder;\nbind evolutionPolicy.mandate = builderMandate;\nbind evolutionPolicy.issuer = owner.ownerMandate.rootAuthority;`,
  }];
}
