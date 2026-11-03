/** Product library aliases are lookup spellings, never native identities.
 * Existing snapshots, source names and digest inputs retain their exact bytes. */
const PRODUCT_PACKAGES = [
  "Core",
  "Authority",
  "LiveBuilder",
  "Conversation",
  "Execution",
  "Lifecycle",
  "Requirements",
  "Cases",
  "Invocations",
  "ModelEditing",
  "ModelAdministration",
  "ModelDelegations",
  "InitialTools",
  "ToolPublicationResult",
  "Work",
  "WorkPlans",
  "Analysis",
  "Collect",
] as const;

const legacyPackages = new Set(PRODUCT_PACKAGES.map((name) => `ASE${name}`));
const currentPackages = new Set(
  PRODUCT_PACKAGES.map((name) => `Assembly${name}`),
);

export function canonicalProductName(name: string): string {
  const [root, ...rest] = name.split("::");
  return legacyPackages.has(root!)
    ? [`Assembly${root!.slice(3)}`, ...rest].join("::")
    : name;
}

export function legacyProductName(name: string): string {
  const [root, ...rest] = name.split("::");
  return currentPackages.has(root!)
    ? [`ASE${root!.slice(8)}`, ...rest].join("::")
    : name;
}

export function productNameVariants(name: string): readonly string[] {
  return [...new Set([canonicalProductName(name), legacyProductName(name)])];
}

export function sameProductName(actual: unknown, expected: string): boolean {
  return typeof actual === "string" &&
    canonicalProductName(actual) === canonicalProductName(expected);
}

/** Resolve a library alias to the name actually present in the source model.
 * A missing member follows its existing package's spelling. Competing library
 * families are ambiguous even when their native identities differ. */
export function productNameInModel(
  elements: readonly { qualifiedName?: unknown }[],
  name: string,
): string {
  const found = elements.filter((element) =>
    sameProductName(element.qualifiedName, name)
  );
  if (found.length > 1) {
    throw new Error(`Ambiguous product library declaration: ${name}`);
  }
  if (found.length === 1) return String(found[0]!.qualifiedName);
  const [root, ...members] = canonicalProductName(name).split("::");
  if (!members.length || !currentPackages.has(root!)) {
    return canonicalProductName(name);
  }
  const packageName = productNameInModel(elements, root!);
  return [packageName, ...members].join("::");
}

/** Adapt a newly generated template, or a comparison copy, to model libraries.
 * Never rewrite stored sources, artifacts or execution digest inputs with it. */
export function productSourceForModel(
  text: string,
  elements: readonly { qualifiedName?: unknown }[],
): string {
  return text.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:ASE|Assembly)[A-Za-z]+\b/g,
    (name) => {
      if (!legacyPackages.has(name) && !currentPackages.has(name)) return name;
      return productNameInModel(elements, name);
    },
  );
}
