import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import {
  RevisionComparisonForm,
  RevisionDiffControls,
  RuntimeRevisionCard,
} from "./RevisionsView.tsx";
function assert(value: unknown, message = "Assertion failed"): void {
  if (!value) throw new Error(message);
}

Deno.test("native Fresh comparison GET form carries the inspected selection and chosen base", () => {
  for (const kind of ["commit", "proposal"] as const) {
    const output = renderToString(h(RevisionComparisonForm, {
      selection: { kind, id: "inspected" },
      base: "commit:chosen-base",
      target: "commit:target",
      bases: new Map([["commit:parent", "Parent"], [
        "commit:chosen-base",
        "Chosen",
      ]]),
      busy: false,
    }));
    assert(output.includes('method="GET"'));
    assert(
      output.includes(
        `action="/model?${kind}=inspected&amp;from=commit%3Achosen-base"`,
      ),
    );
    assert(output.includes('f-partial="/revisions"'));
    assert(output.includes(`type="hidden" name="${kind}" value="inspected"`));
    assert(output.includes('name="from"'));
    assert(output.includes('value="commit:chosen-base" selected'));
    assert(output.includes('type="submit"'));
  }
});

Deno.test("comparison switcher presents one content mode with source layout controls only for SysML", () => {
  for (const kind of ["source", "graph"] as const) {
    const output = renderToString(h(RevisionDiffControls, {
      kind,
      mode: "side-by-side",
      busy: false,
      onKindChange: () => {},
      onModeChange: () => {},
    }));
    assert(output.includes("Texte SysML"));
    assert(output.includes("Éléments et relations"));
    assert(
      new RegExp(`aria-pressed="${kind === "source"}"\\s*>Texte SysML`).test(
        output,
      ),
    );
    assert(
      new RegExp(`aria-pressed="${kind === "graph"}"\\s*>Éléments et relations`)
        .test(output),
    );
    assert(output.includes("Côte à côte") === (kind === "source"));
    assert(output.includes("Unifié") === (kind === "source"));
  }
});

Deno.test("runtime card selects an operator independently and offers adoption only for its inspected pinned contract", () => {
  const operators = [
    { nativeId: "primary", name: "Principal", primary: true },
    { nativeId: "worker", name: "Exécutant", primary: false },
  ];
  const props = {
    operators,
    selectedId: "worker",
    data: {
      agentId: "worker",
      version: "commit:head",
      runtime: {
        active: null,
        available: { digest: "digest", repositoryVersion: "commit:head" },
        executable: true,
      },
    },
    busy: false,
    onSelect: () => {},
    onAdopt: () => {},
  };
  let output = renderToString(h(RuntimeRevisionCard, props));
  assert(output.includes('value="worker" selected'));
  assert(output.includes("Principal · principal"));
  assert(output.includes("Adopter pour Exécutant"));
  assert(output.includes("Contrat disponible"));
  assert(!output.includes("Accepter la conception"));
  output = renderToString(
    h(RuntimeRevisionCard, {
      ...props,
      data: { ...props.data, agentId: "primary" },
    }),
  );
  assert(output.includes("Lecture du contrat de Exécutant"));
  assert(!output.includes("Adopter pour"));
  output = renderToString(
    h(RuntimeRevisionCard, { ...props, operators: operators.slice(0, 1) }),
  );
  assert(output.includes("Opérateur indisponible"));
  assert(!output.includes("Adopter pour"));
});
Deno.test("runtime card surfaces an unknown version or missing contract pin without an adoption action", () => {
  const props = {
    operators: [{ nativeId: "worker", name: "Exécutant", primary: true }],
    data: {
      agentId: "worker",
      version: "commit:head",
      runtime: {
        active: null,
        available: { digest: "digest" },
        executable: true,
      },
    },
    busy: false,
    onSelect: () => {},
    onAdopt: () => {},
  };
  let output = renderToString(h(RuntimeRevisionCard, props));
  assert(output.includes("version du contrat disponible manque"));
  assert(!output.includes("Adopter pour"));
  output = renderToString(
    h(RuntimeRevisionCard, {
      ...props,
      error: "Version de l’opérateur introuvable",
    }),
  );
  assert(output.includes('role="alert"'));
  assert(output.includes("Version de l’opérateur introuvable"));
  assert(!output.includes("Adopter pour"));
});

Deno.test("runtime card shows source authority bounds and revoked rights independently of adoption", () => {
  const administration = {
    kind: "delegation" as const,
    id: "a-to-b",
    revision: 1,
    digest: "authority",
    systemQualifiedName: "Demo::B",
    holderNativeId: "worker",
    mandateId: "mandate",
    mandateRevision: 1,
    operations: ["set-value" as const],
    grants: [{ file: "mission.sysml", qualifiedRoots: ["Demo::work"] }],
    recipients: ["Demo::C"],
    maxRedelegationDepth: 0,
  };
  const props = {
    operators: [{ nativeId: "worker", name: "B", primary: true }],
    data: {
      agentId: "worker",
      version: "commit:head",
      runtime: {
        active: { digest: "old", repositoryVersion: "commit:old" },
        available: { digest: "new", repositoryVersion: "commit:head" },
        executable: true,
        sourceRights: {
          modelEditPolicy: null,
          modelAdministration: administration,
        },
      },
    },
    busy: false,
    onSelect: () => {},
    onAdopt: () => {},
  };
  let output = renderToString(h(RuntimeRevisionCard, props));
  for (
    const text of [
      "Droits dans la version source admise",
      "Édition : aucune",
      "Administration : autorisée",
      "a-to-b",
      "mission.sysml",
      "Demo::work",
      "Demo::C",
      "Profondeur de redélégation restante : 0",
      "même avec un ancien contrat adopté",
    ]
  ) assert(output.includes(text), text);
  const editing = {
    id: "edit-b-to-c",
    revision: 1,
    elementId: "worker",
    sourceIds: ["worker"],
    holderNativeId: "worker",
    mandateNativeId: "mandate",
    mandateId: "mandate",
    mandateRevision: 1,
    operations: ["set-value" as const],
    grants: administration.grants,
    delegationDigest: "chain",
  };
  output = renderToString(h(RuntimeRevisionCard, {
    ...props,
    data: {
      ...props.data,
      runtime: {
        ...props.data.runtime,
        sourceRights: { modelEditPolicy: editing, modelAdministration: null },
      },
    },
  }));
  assert(output.includes("Édition : autorisée"));
  assert(output.includes("edit-b-to-c"));
  assert(output.includes("set-value"));
  output = renderToString(h(RuntimeRevisionCard, {
    ...props,
    data: {
      ...props.data,
      runtime: {
        ...props.data.runtime,
        sourceRights: { modelEditPolicy: null, modelAdministration: null },
      },
    },
  }));
  assert(output.includes("Administration : aucune"));
  assert(!output.includes("a-to-b"));
  assert(!output.includes("Demo::C"));
});
