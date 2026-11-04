import type { JsonObject } from "../../src/domain/model/records/compiled-model.ts";
import type { ModelDiagnosticFacts } from "../../src/domain/model/policies/diagnostics.ts";

/** Raw model graph fixtures, independent of the TS diagnostic verdict fields. */
export function diagnosticModelElements(input: {
  systems: readonly {
    id: string;
    hosts: readonly string[];
    budgetPolicyId?: string;
  }[];
  plans?: readonly string[];
  policies: readonly {
    id: string;
    ownerSystemId: string;
    hosts: readonly string[];
  }[];
}): JsonObject[] {
  const ref = (id: string) => ({ "@id": id });
  const elements: JsonObject[] = [{
    "@id": "budget-type",
    "@type": "PartDefinition",
    qualifiedName: "APEWorkBudget::InvocationBudgetPolicy",
  }];
  const hosts = (owner: string, name: string, values: readonly string[]) => {
    const attribute = `${owner}-${name}`;
    elements.push(
      {
        "@id": attribute,
        "@type": "AttributeUsage",
        owner: ref(owner),
        declaredName: name,
      },
      {
        "@id": `${attribute}-value`,
        "@type": "FeatureValue",
        featureWithValue: ref(attribute),
        value: ref(`${attribute}-literal`),
      },
      {
        "@id": `${attribute}-literal`,
        "@type": "LiteralString",
        value: JSON.stringify(values),
      },
    );
  };
  for (const system of input.systems) {
    elements.push({ "@id": system.id, "@type": "PartUsage" });
    hosts(system.id, "networkHosts", system.hosts);
    if (system.budgetPolicyId) {
      elements.push({
        "@id": system.budgetPolicyId,
        "@type": "PartUsage",
        owner: ref(system.id),
        type: ref("budget-type"),
      });
    }
  }
  for (const plan of input.plans ?? []) {
    elements.push({ "@id": plan, "@type": "ActionUsage" });
  }
  for (const policy of input.policies) {
    elements.push({
      "@id": policy.id,
      "@type": "PartUsage",
      owner: ref(policy.ownerSystemId),
    });
    hosts(policy.id, "allowedHosts", policy.hosts);
  }
  return elements;
}

export function semanticShaclFixture(clean = false): {
  elements: JsonObject[];
  facts: ModelDiagnosticFacts;
} {
  return {
    elements: diagnosticModelElements({
      systems: [
        {
          id: "sys",
          hosts: ["a.example"],
          ...(clean ? { budgetPolicyId: "budget-sys" } : {}),
        },
        { id: "sys-ok", hosts: ["a.example"], budgetPolicyId: "budget-ok" },
      ],
      plans: ["plan"],
      policies: [
        {
          id: "policy",
          ownerSystemId: "sys",
          hosts: clean
            ? ["a.example"]
            : ["b.example", "a.example", "b.example"],
        },
        { id: "policy-ok", ownerSystemId: "sys-ok", hosts: ["a.example"] },
      ],
    }),
    facts: {
      graphContext: {
        units: [
          {
            elementId: "sys",
            kind: "conversation",
            ownerSystemId: "sys",
            ...(clean ? { budgetPolicyId: "budget-sys" } : {}),
          },
          {
            elementId: "sys-ok",
            kind: "conversation",
            ownerSystemId: "sys-ok",
            budgetPolicyId: "budget-ok",
          },
          {
            elementId: "plan",
            kind: "plan",
            ownerSystemId: "sys-ok",
            budgetPolicyId: "budget-ok",
          },
        ],
        capabilities: [
          {
            policyElementId: "policy",
            ownerSystemId: "sys",
            allowedHostsAttributeId: "policy-allowedHosts",
            networkHostsAttributeId: "sys-networkHosts",
          },
          {
            policyElementId: "policy-ok",
            ownerSystemId: "sys-ok",
            allowedHostsAttributeId: "policy-ok-allowedHosts",
            networkHostsAttributeId: "sys-ok-networkHosts",
          },
        ],
      },
      units: [
        {
          location: {
            elementId: "sys",
            qualifiedName: "Sys",
            source: { file: "model.sysml", line: 1, column: 1 },
          },
          kind: "conversation",
          hasInvocationBudget: clean,
          accountableHumanDeclared: true,
        },
        {
          location: { elementId: "sys-ok", qualifiedName: "SysOk" },
          kind: "conversation",
          hasInvocationBudget: true,
          accountableHumanDeclared: true,
        },
        {
          location: { elementId: "plan", qualifiedName: "SysOk::plan" },
          kind: "plan",
          hasInvocationBudget: true,
          accountableHumanDeclared: true,
        },
      ],
      effects: [],
      networkCapabilities: [
        {
          location: { elementId: "policy", qualifiedName: "Sys::policy" },
          allowedHosts: clean
            ? ["a.example"]
            : ["b.example", "a.example", "b.example"],
          mandateHosts: ["a.example"],
        },
        {
          location: { elementId: "policy-ok" },
          allowedHosts: ["a.example"],
          mandateHosts: ["a.example"],
        },
      ],
    },
  };
}
