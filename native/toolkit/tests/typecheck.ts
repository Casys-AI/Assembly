/**
 * Références de types à toute la surface exportée : `deno check`
 * échoue si `index.d.ts` et `ts/toolkit.ts` dérivent. Aucune
 * exécution (jamais lancé comme script).
 */
import type {
  AddonModule,
  CheckFindingDto,
  EditPreview,
  EditReport,
  EditSplice,
  ElementDescription,
  ElementRefSnapshot,
  IdMapping,
  MetaclassCount,
  NativeLspServer,
  ResourceCounts,
  SessionSummary,
  SourcePosition,
  SourceText,
  ToolkitLibrary,
  ToolkitSession,
} from "../ts/toolkit.ts";

export type _Surface = [
  AddonModule,
  CheckFindingDto,
  EditPreview,
  EditReport,
  EditSplice,
  ElementDescription,
  ElementRefSnapshot,
  IdMapping,
  MetaclassCount,
  NativeLspServer,
  ResourceCounts,
  SessionSummary,
  SourcePosition,
  SourceText,
  ToolkitLibrary,
  ToolkitSession,
];

export function _signatures(addon: AddonModule): void {
  const library: ToolkitLibrary = new addon.ToolkitLibrary([]);
  const session: ToolkitSession = library.createSession([]);
  const server: NativeLspServer = new addon.NativeLspServer();
  const ref: ElementRefSnapshot = {
    sessionId: session.sessionId,
    generation: session.generation,
    nativeId: "id",
  };
  const _strings: string[] = [
    addon.toolkitVersion(),
    addon.addonVersion(),
    addon.checkSyntax("[]"),
    session.checkJson(),
    session.toFullJson(false),
    session.query("1"),
    session.property(ref, "name"),
    session.derived(ref, "name"),
    session.evaluate(ref),
    session.outline(),
    session.toGraph(),
    session.toPlantuml(),
    session.viewInfo("P::v"),
    session.elementId(ref),
    session.metaclass(ref),
    session.rows("[]", "[]"),
    session.memberSource("P::x"),
    session.references("P::x"),
    session.unitsJson(),
    session.checkEdit("[]"),
    session.edit("[]"),
    session.stateDigest(),
    session.exportFullText(),
    session.exportCompactText(),
  ];
  const _refs: Array<ElementRefSnapshot[]> = [
    session.derivedElements(ref, "ownedFeature"),
    session.members(ref),
    session.features(ref),
    session.typings(ref),
    session.elementsOfMetaclass("PartUsage"),
    session.roots(),
  ];
  const _counts: ResourceCounts = addon.nativeResourceCounts();
  const _findings: CheckFindingDto[] = addon.checkSyntaxFindings([]);
  const _handle: string[] = server.handle("{}");
  void [_strings, _refs, _counts, _findings, _handle];
}
