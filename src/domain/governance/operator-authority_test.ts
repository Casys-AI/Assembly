import { deepStrictEqual } from "node:assert/strict";
import type { ElementRecord } from "../model/records/snapshot.ts";
import {
  awaitingPersonView,
  MAX_AWAITING_PERSON,
  modelEditingAuthorityRoots,
} from "./operator-authority.ts";

Deno.test("model editing excludes either product library without changing returned source names", () => {
  const element = (
    id: string,
    qualifiedName: string,
    typeIds: string[] = [],
    generalIds: string[] = [],
  ): ElementRecord => ({
    id,
    qualifiedName,
    name: qualifiedName.split("::").at(-1)!,
    metaclass: "PartDefinition",
    ownerId: "root",
    typeIds,
    generalIds,
    redefinedIds: [],
    isReference: false,
    direction: "",
    multiplicity: "",
    doc: "",
  });
  for (const prefix of ["ASE", "Assembly"]) {
    const elements = [
      element("policy", `${prefix}Authority::ToolAdmissionPolicy`),
      element("derived", "Business::DelegatedPolicy", [], ["policy"]),
      element("occurrence", "Business::unit::grant", ["derived"]),
      element("ordinary", "Business::ToolAdmissionPolicy"),
      element(
        "similar-prefix",
        `${prefix}AuthorityCustom::ToolAdmissionPolicy`,
      ),
    ];
    const before = structuredClone(elements);
    deepStrictEqual(
      modelEditingAuthorityRoots(elements),
      [
        `${prefix}Authority::ToolAdmissionPolicy`,
        "Business::DelegatedPolicy",
        "Business::unit::grant",
      ].sort(),
    );
    deepStrictEqual(elements, before);
  }
});

Deno.test("4.8d D2: requests awaiting the person are newest first, bounded and flagged when truncated", () => {
  const entry = (id: string, requestedAt: string) => ({
    id,
    caseId: `case-${id}`,
    requestedAt,
  });
  const many = Array.from(
    { length: MAX_AWAITING_PERSON + 2 },
    (_, index) =>
      entry(`r${index}`, `2026-10-31T00:00:${String(index).padStart(2, "0")}Z`),
  );
  const view = awaitingPersonView(many);
  deepStrictEqual(view.awaitingPersonTruncated, true);
  deepStrictEqual(view.awaitingPerson.length, MAX_AWAITING_PERSON);
  deepStrictEqual(view.awaitingPerson[0], {
    id: `r${MAX_AWAITING_PERSON + 1}`,
    caseId: `case-r${MAX_AWAITING_PERSON + 1}`,
  });
  // Same instant: the identity breaks the tie, so the order is deterministic.
  deepStrictEqual(
    awaitingPersonView([entry("b", "t"), entry("a", "t")]),
    {
      awaitingPerson: [
        { id: "a", caseId: "case-a" },
        { id: "b", caseId: "case-b" },
      ],
      awaitingPersonTruncated: false,
    },
  );
});
