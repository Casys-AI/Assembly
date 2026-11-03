# Contrat d'API — addon Toolkit N-API (`ase-toolkit-napi`)

Normatif pour l'écriture du loader/façade TypeScript (`ToolkitRuntime` /
`ToolkitSession` de compatibilité, hors de ce paquet). Les signatures
TypeScript générées vivent dans `index.d.ts` (régénéré par `npm run build`,
@napi-rs/cli 3.10.9) ; en cas d'écart avant le premier build coordinateur,
ce document fait foi.

## Principes

- Tout est **synchrone** : chaque appel bloque le thread JS pendant le
  travail Rust. Aucun `Promise`, aucun callback.
- Aucun handle Rust ne traverse la frontière. Un élément est désigné par
  un instantané `{sessionId, generation, nativeId}` (`ElementRefSnapshot`).
  **Chaque** méthode qui en reçoit un revérifie session, génération et
  existence du `nativeId` dans la génération courante.
- `generation` démarre à 0 et augmente de 1 à chaque édition **commise**
  (`insertMember`, `rename`, `edit`). Un dry-run (`check*`, `checkEdit`)
  ou un refus ne changent ni sources ni génération. Après un commit,
  toutes les références antérieures sont refusées (`STALE_GENERATION`) :
  re-résoudre par nom qualifié ou via l'`idMap` du rapport.
- `close()` est déterministe et idempotent (`dispose()` = alias). Le
  `Drop` GC est un filet distinct, sans garantie temporelle.
- Une panic Rust devient une erreur `NATIVE_PANIC` ; la session (ou le
  serveur LSP) est **empoisonnée** : tout appel ultérieur échoue en
  `SESSION_POISONED` (resp. `LSP_POISONED`). Recréer l'objet.
- Les payloads JSON texte (`checkJson`, `query`, `outline`, `toGraph`,
  `viewInfo`, `rows`, `references`, `checkEdit`/`edit`, `unitsJson`,
  `checkSyntax`, …) sont **identiques, champ par champ, à ceux du
  wrapper WASM amont** (`crates/sysmlv2-wasm`), calculés directement sur
  `sysmlv2-transform` / `sysmlv2-model` / `sysmlv2-viz` / `sysmlv2-lsp`
  natifs. Aucun transport WASM, aucune seconde interprétation SysML.
- Identités : `nativeId` = `@id` d'interchange, `metaclass` = `@type`,
  `name` = nom déclaré (renommable, jamais une identité). Le
  `stateDigest()` natif n'est **pas** le digest d'artefact admis (`A`)
  de l'application. Aucun `sessionId`/`generation` ne doit être persisté
  (journal durable, DTO navigateur) : ce sont des valeurs éphémères
  d'adapter.

## Erreurs

Le message commence toujours par un code stable suivi de `: ` et du
détail. Pour les API miroirs du WASM, le détail est le message exact du
wrapper amont.

| Code | Sens |
|---|---|
| `SESSION_CLOSED` | session fermée (`close()`/`dispose()` déjà fait) |
| `SESSION_POISONED` | session abandonnée après panic, à recréer |
| `LIBRARY_CLOSED` | handle `ToolkitLibrary` fermé |
| `LSP_CLOSED` / `LSP_POISONED` | serveur LSP fermé / abandonné après panic |
| `WRONG_SESSION` | référence d'une autre session |
| `STALE_GENERATION` | référence d'une génération périmée |
| `ELEMENT_NOT_FOUND` | `nativeId`/cible absent de la génération courante |
| `LIBRARY_ELEMENT` | cible d'édition en bibliothèque (lecture seule) |
| `EDIT_REFUSED` | édition (typée ou batch JSON) refusée au commit/résolution |
| `INVALID_INPUT` | argument malformé (JSON d'options/ops/ids, nom d'unité vide…) |
| `NATIVE_PANIC` | panic attrapée à la frontière (objet empoisonné) |
| `TOOLKIT_ERROR` | erreur Toolkit remontée telle quelle (détail = message amont) |

Exceptions : `checkEdit` ne lève pas pour un refus métier — il retourne
le JSON `{"wouldCommit": false, "refusal": "…"}` (texte amont exact) ;
il ne lève que `INVALID_INPUT` (ops JSON malformées/vides) et les codes
de session. Les dry-runs typés (`checkInsertMember`, `checkRename`)
retournent `EditPreview {wouldCommit: false, refusal}` de même.

## Fonctions du module

```ts
toolkitVersion(): string            // "0.10.10+ase.2" (épingle Toolkit)
addonVersion(): string              // version de cette crate
checkSyntax(sourcesJson: string): string
  // sourcesJson = JSON [{name, text}] ; retour = JSON findings
  // [{severity, stage, message, unit, line, col, endLine?, endCol?}]
  // (stages parse/context uniquement, aucun modèle construit)
checkSyntaxFindings(sources: SourceText[]): CheckFindingDto[]
  // même contenu, forme typée
nativeResourceCounts(): ResourceCounts
```

## `ToolkitLibrary`

```ts
new ToolkitLibrary(sources: SourceText[], recording?: Uint8Array | null)
static fromPreparedSnapshot(
  sources: SourceText[], snapshot: Uint8Array,
  recording?: Uint8Array | null, keepHostParts?: boolean | null,
): ToolkitLibrary
get libraryId(): string
get isClosed(): boolean
preparedRetains(): number
createSession(sources: SourceText[]): ToolkitSession
close(): void; dispose(): void
```

`close()` ne libère que ce handle : les sessions déjà créées retiennent
le graphe préparé partagé et restent utilisables ; seule la création de
nouvelles sessions est refusée (`LIBRARY_CLOSED`). `keepHostParts: true`
conserve la table de symboles LSP portée par le snapshot (pour
`NativeLspServer.withPreparedLibrary`) ; par défaut elle est vérifiée
puis abandonnée, comme en amont.

## `ToolkitSession`

Construction et identité :

```ts
new ToolkitSession(sources: SourceText[])   // sans bibliothèque
get sessionId(): string
get generation(): number
get isClosed(): boolean
close(): void; dispose(): void
```

API typée (héritée du prototype validé, inchangée) :

```ts
summary(): SessionSummary
check(): CheckFindingDto[]
resolve(qualifiedName: string): ElementRefSnapshot | null
describe(reference: ElementRefSnapshot): ElementDescription
describeQualified(qualifiedName: string): ElementDescription | null
countMetaclass(metaclass: string, limit?: number | null): MetaclassCount
stateDigest(): string
units(): SourceText[]
exportFullText(): string          // to_full_json_with(false) en texte
exportCompactText(): string
exportFullObject(): unknown       // même valeur, objets JS directs
exportCompactObject(): unknown
checkInsertMember(owner: ElementRefSnapshot, text: string): EditPreview
insertMember(owner: ElementRefSnapshot, text: string): EditReport
checkRename(target: ElementRefSnapshot, newName: string): EditPreview
rename(target: ElementRefSnapshot, newName: string): EditReport
```

API de compatibilité bas niveau (miroir du wrapper WASM, éléments en
instantanés vérifiés). `R` = `ElementRefSnapshot` :

```ts
checkJson(): string                    // == Session.check() amont
toFullJson(recoverRefs: boolean): string
query(expression: string): string      // valeur JSON ; élément = {"@element": id, "qualifiedName": …}
elementById(nativeId: string): R | null
property(reference: R, name: string): string        // JSON
derived(reference: R, name: string): string         // JSON
derivedElements(reference: R, name: string): R[]
valueSource(reference: R): string | null
valueIsDefault(reference: R): boolean | null
redefinitionRoot(reference: R): R
outline(optionsJson?: string | null): string        // {outline, shape:{nodes, truncated}}
toGraph(optionsJson?: string | null): string
toPlantuml(optionsJson?: string | null): string
viewInfo(qualifiedName: string): string
name(reference: R): string | null
shortName(reference: R): string | null
members(reference: R): R[]
features(reference: R): R[]
evaluate(reference: R): string                      // JSON, comme query
elementsOfMetaclass(metaclass: string): R[]
docs(reference: R): string[]
conforms(reference: R, ancestor: R): boolean
declarationSite(reference: R): string | null        // JSON {"unit":n,"start":b,"end":b}
elementId(reference: R): string
qualifiedName(reference: R): string | null
referenceSpelling(reference: R): string | null
metaclass(reference: R): string
isLibraryElement(reference: R): boolean
owner(reference: R): R | null
typings(reference: R): R[]
rows(idsJson: string, fieldsJson: string): string   // champs: name, shortName,
  // qualifiedName, referenceSpelling, metaclass, owner (id|null),
  // isLibraryElement, valueSource, valueIsDefault, docs,
  // declarationSite, memberExtent, property:<n>, derived:<n> ;
  // ligne null si id absent ; erreurs par champ sous "errors"
memberSource(target: string): string   // cible = nom qualifié ou "@<id>"
memberExtent(reference: R): string | null           // JSON {"unit","start","end"}
references(selectorJson: string): string            // sélecteur = nom qualifié
  // (nu ou JSON) ou {"elementId": …} ; positions 1-based, colonnes UTF-16
roots(): R[]
unitsJson(): string                    // [{unit, name, text}] (index modèle)
checkEdit(operationsJson: string): string           // JSON, voir ci-dessous
edit(operationsJson: string): string                // JSON, génération +1 si OK
```

Batchs d'édition JSON (`checkEdit`/`edit`) : tableau d'opérations au
format amont exact — `rename {target, newName}`,
`setFeatureValue {target, expr}`, `setFeatureType {target, type}`,
`setRedefinedFeature {target, feature}`, `removeFeatureValue {target}`,
`setCommentBody {target, body}`, `insertMember {owner, text}`,
`insertTopLevel {unit, text}`, `addUnit {unit}`, `remove {target}`,
`replaceMember {target, text}`,
`moveMember {target, newOwner?, index?}`. Cibles : nom qualifié `::`
ou `@<@id>` ; bibliothèque refusée. Rapport :
`{idMap: [[oldId, newId]…], findings: [string…], splices: [{unit,
start, end, text}…]}` en coordonnées pré-commit (octets) ;
`checkEdit` ajoute `wouldCommit`. Un `rename` en collision avec un
sibling est **sauté** et signalé dans `findings` (comme en amont) —
contrairement aux éditions typées unitaires, qui refusent.

### Explicit native reference retargeting

The additive operation `retargetReference {fromId, toId, site}` joins the same
atomic preview/commit builder as `setFeatureType`. Both IDs identify elements
already present in the current native model; referenced library elements are
allowed, but the edited site must belong to an owned user source unit.

`references(selector)` retains its existing declaration, positions, kind and
display owner. Every successful response includes top-level
`referenceSiteFormat: "assembly-native-reference-site/v1"`, including when its
references array is empty, distinguishing this binding from older packages.
It also includes `referenceSitesOmitted`, the exact nonnegative difference
between the native `references_to` inventory and the positioned entries returned
by this response. Sites with no available source position are counted rather
than silently implying completeness. This count does not claim that the native
inventory describes every possible model relationship. A visible reference with
a null fingerprint is not omitted: consumers requiring editable completeness
must reject both a positive omission count and null fingerprints.
Each reference additionally has `siteFingerprint`, either null
(not editable or outside protocol bounds) or this closed object:

```json
{"unit":"configuration.sysml","line":268,"col":31,"endLine":268,"endCol":44,"kind":"chainingFeature","ownerId":"exact-native-site-owner","chainRootId":"exact-occurrence-id","preimage":"readCaseState"}
```

Copy that object into `site`. Its one-based UTF-16 positions describe the full
native reference span, whereas the legacy positions describe its final name
segment. `ownerId` is the actual native site owner (possibly synthetic), not the
nearest named display owner. `chainRootId` is required and may be null. A site
is re-resolved by matching every field and the exact old target; zero or multiple
matches refuse. Fingerprints are source locators, not rights or persisted session
handles. A later application layer must independently enforce source authority.

All keys are required; unknown keys and malformed field types reject as
`INVALID_INPUT`. Bounds are UTF-8 bytes: unit 4096, IDs/kind 128, preimage 65536;
positions are integers from 1 through 2147483647, with a nonempty forward range.
Out-of-bound, absent, stale or foreign sites/targets refuse preview as
`wouldCommit:false`; commit fails `EDIT_REFUSED` without source/generation change.
Core identity checks, splice expectations and overlap guards remain active.
The pinned core's reserved-name spelling/qualifiedName mismatch remains a known
fail-closed limitation; this binding does not normalize or override it.

Options diagramme (`toGraph`/`toPlantuml`) et `outline` : mêmes
documents JSON qu'en amont (`{element?, roots?, summary?, view?,
horizontal?, showValues?, showNotes?, showMetadata?, showInherited?,
showLib?, showImported?, lineStyle?, stdColor?, linkTemplate?}` ;
`{outlineNodes?, outlineDepth?, shapeNodes?, shapeDepth?}`), mêmes
défauts, champs inconnus refusés.

## `NativeLspServer`

Serveur push `sysmlv2-lsp` natif. `handle` prend un message JSON-RPC
client→serveur (texte) et retourne les messages serveur→client produits
(textes), exactement comme `LspServer.handle` amont — y compris
l'encodage de positions **UTF-16** négocié à `initialize` et les
`textDocument/semanticTokens/full` consommés par
`toolkit-source-tokens.ts`.

```ts
new NativeLspServer()               // syntaxe seule, sans bibliothèque
static withLibrarySources(sources: SourceText[], snapshot?: Uint8Array | null): NativeLspServer
static withPreparedLibrary(library: ToolkitLibrary): NativeLspServer
get serverId(): string
get isClosed(): boolean
handle(message: string): string[]
setWorkspace(sources: SourceText[]): string[]   // messages de refresh produits
setWorkspaceJson(sourcesJson: string): string[] // forme JSON [{name, text}]
invalidateSessions(): string[]
setHideRedundantValueHints(on: boolean): string[]
setNumberFormat(spec: string): string[]
setInferUnitTypes(on: boolean): void
close(): void; dispose(): void
```

## DTO (inchangés du prototype, `ResourceCounts` étendu de façon additive)

`SourceText {name, text}`,
`ElementRefSnapshot {sessionId, generation, nativeId}`,
`SourcePosition {unit, line, col}`,
`ElementDescription {reference, nativeId, name?, declaredShortName?,
metaclass, qualifiedName?, isLibraryElement, owner?,
ownerQualifiedName?, ownedMembers, declaration?, documentation}`,
`CheckFindingDto {severity, stage, message, unit, line, col,
endLine?, endCol?}`, `SessionSummary {sessionId, generation,
userElements, unresolvedCount, referenceSites, units}`,
`MetaclassCount {metaclass, count, references}`,
`IdMapping {oldId, newId}`, `EditSplice {unit, start, end, text}`,
`EditPreview {wouldCommit, refusal?, idMap, findings, splices}`,
`EditReport {generation, idMap, findings, splices}`,
`ResourceCounts {librariesAlive, sessionsAlive, librariesCreated,
librariesDisposed, sessionsCreated, sessionsDisposed,
preparedGraphsAlive, preparedRetains, lspServersAlive,
lspServersCreated, lspServersDisposed}`.

## Chargement (côté paquet)

`ts/toolkit.ts` fournit `loadAddon(path?)` (require direct du `.node`
sous Deno, repli `index.js` généré), `nativeErrorCode`/`isNativeError`,
`closeAll`, `validateInterchange`/`parseInterchangeText`. La façade
`ToolkitRuntime`/`ToolkitSession` à faux handles `free()` reste à la
charge de l'agent loader, au-dessus de cette API — jamais l'inverse.
