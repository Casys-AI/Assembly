import { sourceLiterals } from "../projections/source-facts.ts";
import type { SourceRevision } from "../records/source-revision.ts";
import { modelSourceElement } from "../editing/source-index.ts";
import { productNameInModel } from "../sysml-product-names.ts";
import { assert } from "../../primitives/assert.ts";
import type { JsonObject as Element } from "../records/compiled-model.ts";

export function reference(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const id = (value as Element)["@id"];
  return typeof id === "string" ? id : undefined;
}

export function references(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    const id = reference(entry);
    return id ? [id] : [];
  });
}

export function id(element: Element): string {
  const value = element["@id"];
  assert(
    typeof value === "string" && value.length > 0,
    "Missing model identity",
  );
  return value;
}

export function one(
  revision: SourceRevision,
  name: string,
  metaclass?: string,
): Element {
  return modelSourceElement(
    revision,
    productNameInModel(revision.elements, name),
    metaclass,
  );
}

export function owned(
  revision: SourceRevision,
  owner: string,
  name: string,
): Element {
  let found = revision.elements.filter((element) =>
    reference(element.owner) === owner && element.declaredName === name
  );
  if (found.length === 0) {
    const attributes = sourceLiterals(revision.elements).filter((value) =>
      value.owner === owner && value.name === name
    );
    found = attributes.flatMap((value) =>
      revision.elements.filter((element) =>
        element["@id"] === value.attributeId
      )
    );
  }
  assert(
    found.length === 1,
    `Expected one owned feature ${name}; found ${found.length}`,
  );
  return found[0]!;
}

export function literal(revision: SourceRevision, attribute: Element): Element {
  const matches = sourceLiterals(revision.elements).filter((value) =>
    value.attributeId === id(attribute)
  );
  assert(
    matches.length === 1,
    `Expected one explicit feature value for ${attribute.qualifiedName}`,
  );
  const direct = revision.elements.find((element) =>
    element["@id"] === matches[0]!.literalId
  );
  assert(
    direct &&
      /^Literal(String|Boolean|Integer|Rational|Real)$/.test(
        String(direct["@type"]),
      ),
    `Expected an explicit literal for ${
      attribute.qualifiedName ?? id(attribute)
    }`,
  );
  return direct;
}
