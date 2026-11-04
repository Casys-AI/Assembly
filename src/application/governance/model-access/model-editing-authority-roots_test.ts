import assert, { deepStrictEqual } from "node:assert/strict";
import type { ElementRecord } from "../../../domain/model/records/snapshot.ts";
import { modelEditingAuthorityRoots } from "./model-editing-authority-roots.ts";

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

Deno.test("authority boundaries include derived types and renamed occurrences", () => {
  const element = (
    id: string,
    qualifiedName: string,
    typeIds: string[] = [],
    generalIds: string[] = [],
  ) => ({
    id,
    qualifiedName,
    typeIds,
    generalIds,
    name: id,
    ownerId: "",
    metaclass: "ItemUsage",
    direction: "",
    isReference: false,
    redefinedIds: [],
    multiplicity: "",
    doc: "",
  });
  assert.deepEqual(
    modelEditingAuthorityRoots([
      element("occurrence", "Team::requester::business::renamed", ["derived"]),
      element("derived", "Team::CustomMandate", [], ["mandate"]),
      element("mandate", "ASECore::ConfiguredMandate"),
      element("ordinary", "Team::requester::catalog"),
    ]),
    [
      "ASECore::ConfiguredMandate",
      "Team::CustomMandate",
      "Team::requester::business::renamed",
    ],
  );
});
