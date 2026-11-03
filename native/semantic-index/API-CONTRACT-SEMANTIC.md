# Contrat d'API — index sémantique W5/W6 (Oxigraph natif, LDkit, SHACL)

Normatif pour les consommateurs W2/viewer/agents. Publié avant les adapters pour
figer les identités et les ports. Aucun chemin WASM : Oxigraph est le crate Rust
via napi-rs (cette crate), LDkit et le moteur SHACL sont du
TypeScript/JavaScript pur côté Deno. L'index n'accorde aucun droit, ne publie
aucune source et se reconstruit depuis le magasin W2 ; sa perte n'écrit jamais
dans Git.

## Identités (domaine pur, `src/domain/model/value-objects/element-ref.ts`)

| Type               | Forme                                                                                  | Règle                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ModelRevisionRef` | `{repositoryId, version: ModelRevisionId}`                                             | commit immuable `commit:<40 hex>`                                      |
| `ModelElementRef`  | `{revision, nativeId}`                                                                 | nom/métaclasse = attributs, jamais identité                            |
| `BuildRef`         | `{repositoryId, sourceDigest (S), recipeDigest (R), buildKey (K), artifactDigest (A)}` | dérivé du descripteur W2 par `buildRefFromDescriptor`                  |
| `BuildElementRef`  | `{build, nativeId}`                                                                    | élément de `A.elements`                                                |
| `ProjectionRef`    | `{kind, projectorVersion, artifactDigest, projectionDigest}`                           | `projectionDigest ≠ A`                                                 |
| `NativeIdMap`      | `[{fromNativeId, toNativeId}]`                                                         | renommages explicites, application en un pas, aucun registre permanent |

Distincts et non interchangeables : `OperatorId`/mandat/candidat/admission, les
références de session native (éphémères, internes aux adapters, jamais dans un
journal durable ni un DTO navigateur) et le `stateDigest` natif (qui n'est
**pas** `A`). Les parseurs `parseModelElementRef`, `parseBuildRef`,
`parseBuildElementRef`, `parseProjectionRef`, `parseNativeIdMap` valident aux
frontières (objets fermés, digests hex 64) et lèvent `ModelRefError`
(`MODEL_REF_INVALID`). Clés stables : `modelElementRefKey`, `buildRefKey`,
`buildElementRefKey`, `projectionRefKey`.

## Codec IRI réversible (même fichier, chaînes pures)

- Graphe nommé du build : `urn:ase:build:<A>` (`buildGraphIri` /
  `parseBuildGraphIri`).
- Élément utilisateur, scopé dépôt :
  `urn:ase:model:<enc(repositoryId)>:<enc(nativeId)>`.
- Élément de bibliothèque normative : `urn:ase:library:<enc(nativeId)>` (jamais
  scopé dépôt).
- `enc` = UTF-8 percent-encodé hors `[A-Za-z0-9._-]` (hex majuscule) : aucun `:`
  dans un segment, décodage canonique strict, aucune collision entre dépôts ni
  entre paires `(dépôt, id)` ambiguës. L'IRI d'élément est stable entre builds
  d'un même dépôt ; le graphe nommé porte la version.
- `$id` LDkit ↔ identité : `buildElementIri(ref, scope)` et
  `buildElementRefFromIri(build, iri)` (vérifie le dépôt du build lié).

Collision inter-dépôts assumée et traitée : deux dépôts peuvent partager le même
`A` (mêmes sources + même recette) donc le même nom de graphe. Les clés de
magasin natif et les IRI d'éléments restent scopés dépôt (`buildRefKey`
complet), seuls les octets du graphe portent `urn:ase:build:<A>` comme l'exige
le plan.

## Port consommateur (`src/application/model/model-semantic-index.ts`)

```ts
interface ModelSemanticIndex {
  ensureProjection(build: BuildRef): Promise<SemanticIndexStatus>;
  queryReadOnly(
    request: { build; sparql; limits? },
  ): Promise<SemanticQueryResult>;
  release(build: BuildRef): Promise<void>;
  status(build: BuildRef): Promise<SemanticIndexStatus>;
}
```

- Aucune méthode d'écriture de sources. `queryReadOnly` exige un
  `ensureProjection` préalable réussi (pas de chargement caché) et refuse sinon
  `INDEX_PROJECTION_MISSING`.
- Résultats JSON uniquement (`RdfTermDto`, `SemanticQueryResult` en
  `solutions`/`boolean`/`graph`, avec `truncated`). Aucun handle natif, aucune
  génération ne traverse.
- Erreurs `SemanticIndexError` : `INDEX_INVALID_INPUT`, `INDEX_QUERY_REFUSED`,
  `INDEX_PROJECTION_MISSING`, `INDEX_PROJECTION_CORRUPT`, `INDEX_QUERY_LIMIT`,
  `INDEX_TIMEOUT`, `INDEX_BUSY`, `INDEX_UNAVAILABLE` — chacune avec `context` et
  `recovery`.

## Admission des requêtes (deux couches, les deux obligatoires)

1. Pré-filtre lexical TS (`admitReadOnlySparql`) : forme
   `SELECT`/`ASK`/`CONSTRUCT`/`DESCRIBE` uniquement ; mots-clés interdits
   `INSERT DELETE LOAD CLEAR CREATE DROP COPY MOVE ADD SERVICE FROM USING
   WITH INTO`
   (les noms préfixés `ex:from` et variables `?from` ne sont pas des mots-clés).
   Taille ≤ 64 Kio.
2. Contrôle AST natif (spargebra) : seules les requêtes (jamais les updates)
   sont admises ; tout motif `SERVICE` et tout dataset choisi par le client
   (`FROM`/`FROM NAMED`) sont refusés. Le dataset est épinglé au build autorisé
   : un `Store` Oxigraph par build chargé, aucun autre graphe visible.

Quotas d'exécution (un `LIMIT` seul ne borne pas le calcul) :
`DEFAULT_QUERY_LIMITS` = 1 000 résultats / 1 Mio / 5 s, plafonds durs
`HARD_QUERY_LIMITS` = 10 000 / 8 Mio / 30 s, concurrence bornée avec file bornée
(`INDEX_BUSY`). Les appels lourds passent par un processus natif tuable (voir
protocole ci-dessous) ; aucun appel natif synchrone dans le chemin HTTP.

## Raccord W2 (composition par le coordinateur)

- Source des éléments vérifiés : port `VerifiedBuildElementsSource`
  (`verifiedElements(build) → {elements, libraryNativeIds}`), à brancher sur
  `ModelBuildService.resolve` + les lignes Toolkit (`isLibraryElement`). Aucune
  devinette par nom pour la bibliothèque.
- Cache de projection :
  `SemanticProjectionCache = Pick<ModelBuildStore,
  "hasProjection"|"getProjection"|"putProjection"|"acquireLease"|
  "releaseLease">`,
  adressé `(kind="rdf-quads", projectorVersion, A)`. L'application n'importe
  jamais le KV concret.
- Cycle `ensureProjection` : cache → (bail → projection → `putProjection`) →
  chargement natif → pointeur `ready` déplacé seulement après vérification
  native du digest et du graphe. Chargements A/B isolés par `BuildRef` complet.
  La persistance est la projection N-Quads régénérable du magasin W2 ; l'index
  natif est recyclable.

## Projection RDF (`src/adapters/model/semantic/rdf-model-projection.ts`)

Entrée : `A.elements` canonique natif **normalisé déjà vérifié** (+ build,

- ids bibliothèque explicites). Aucune réanalyse SysML, aucun état runtime.
  Sortie : N-Quads canoniques triés (ordre des unités de code), déterministes,
- `{projectorVersion: "ase-rdf-quads-v1", projectionDigest (sha256 des
octets, ≠ A), quadCount}`.
  `ModelRdfProjector` (port application) est implémenté par
  `DeterministicRdfModelProjector`.

Vocabulaire v1 (`urn:ase:vocab:`) :

- `rdf:type` → `urn:ase:metaclass:<enc(@type)>` + littéral
  `urn:ase:vocab:metaclass` (le nom Toolkit reste canonique, exact).
- Toute autre propriété `p` → prédicat `urn:ase:vocab:prop:<enc(p)>` (réversible
  ; ex. `ownedMember`, `qualifiedName`, `sysx:sourceDocument`).
- Alias explicites (triples supplémentaires, seuls alias admis) :
  `urn:ase:vocab:name` ← `declaredName` puis `name` ;
  `urn:ase:vocab:qualifiedName` ← `qualifiedName`.
- Valeurs typées : chaîne → `xsd:string`, entier sûr → `xsd:integer`, autre
  nombre fini → `xsd:double`, booléen → `xsd:boolean`, `null` → IRI
  `urn:ase:vocab:null`, référence `{"@id"}` → IRI d'élément (bibliothèque si
  l'id est déclaré bibliothèque, sinon dépôt courant), objet imbriqué → nœud
  blanc déterministe dérivé du chemin.
- Listes : ordre **et doublons** préservés par nœuds d'occurrence —
  `s urn:ase:vocab:list:<enc(p)> L`, `L a urn:ase:vocab:OccurrenceList`,
  `L urn:ase:vocab:length n`, `L urn:ase:vocab:occurrence Oi`,
  `Oi urn:ase:vocab:index i`, `Oi urn:ase:vocab:value v` — plus les triples
  directs `s prop v` (convenance de requête ; les occurrences font foi pour le
  roundtrip, y compris liste vide ≠ propriété absente).

## Crate native (`ase-semantic-index-napi`, ce dossier)

Mêmes épingles que `native/toolkit` (napi 3.15.0, napi-derive 3.6.13, napi-build
2.6.0, CLI 3.10.9, toolchain Rust 1.98.1 (rust-version minimum 1.97), `panic=unwind`). Oxigraph épinglé exact,
`default-features = false` (Store mémoire, pas de RocksDB). Classe
`SemanticIndexStore` synchrone (le processus hôte fournit l'isolation) :

```ts
new SemanticIndexStore(optionsJson?: string)
loadBuild(storeKey, graphIri, nquads: Uint8Array, expectedDigest): {quadCount, bytes}
queryReadOnly(storeKey, sparql, limitsJson): string  // JSON SemanticQueryResult
hasBuild(storeKey): boolean
releaseBuild(storeKey): void
loadedBuilds(): string[]
close(): void; dispose(): void
storeVersion(): string; oxigraphVersion(): string
```

Erreurs `CODE: détail` : `INDEX_CLOSED`, `INDEX_POISONED`, `GRAPH_NOT_FOUND`,
`QUERY_REFUSED`, `QUERY_LIMIT`, `TIMEOUT`, `INVALID_INPUT`, `INTEGRITY`,
`STORE_FULL`, `NATIVE_PANIC`, `OXIGRAPH_ERROR`. Le chargement parse tout avant
de remplacer le graphe (aucun état partiel), vérifie sha256 et que chaque quad
appartient au graphe annoncé. Une panic empoisonne le store.

## Processus et installation

L'hôte HTTP assemble `DenoChildProcessRequester` →
`ProcessSemanticIndexExecutor` → `OxigraphNativeIndex`. Le requester reçoit
`addonPath` absolu vers un `.node` exact et `expectedAddonSha256` provenant du
manifeste vérifié. Aucun wrapper JS généré ni fallback WASI n'est chargé.
`InProcessSemanticIndexExecutor` reste réservé aux tests/outils et à l'enfant.

Le protocole JSON-Lines est `{v:1, requestId, processEpoch, operation}` →
`{v:1, requestId, processEpoch, ok, result|error:{code,message}}`. Les opérations
sont `load`, `query`, `has`, `release`, `close`. Le requester injecte un epoch
aléatoire par processus et vérifie epoch, version, requestId et opération de la
réponse. Les deux lecteurs utilisent des buffers d'octets à croissance bornée,
avec balayage linéaire ; ils refusent les trames trop grandes ou UTF-8 invalides.

Options : `maxMessageBytes` (défaut 384 MiB, permettant les 256 MiB N-Quads en
base64), `maxQueuedRequests` (32), `maxQueuedBytes` (384 MiB), `closeTimeoutMs`
(2000). Une seule opération native s'exécute. Le délai passé à `request` couvre
attente de file, écriture, exécution et lecture. Les requêtes expirées en file
sont retirées. Le délai est verrouillé avant SIGKILL ; aucune réponse tardive
ne peut gagner pendant l'arrêt. La sortie du processus est observée avant sa
réutilisation. Un TIMEOUT coopératif, une panic ou un store empoisonné le
recyclent aussi avant l'opération suivante. Le query du port transmet le délai
restant du service sans marge supplémentaire. Les résultats natifs bornent le
DTO JSON complet (métadonnées et séparateurs inclus), avec plafonds de 10 000
résultats, 8 MiB et 30 secondes ; le parent fournit l'interruption dure.

`index.close()` / `executor.close()` / `requester.close()` refusent les nouvelles
requêtes, retirent la file et demandent `store.close()` avec accusé explicite,
puis observent la fin du processus. La fermeture possède une place de contrôle
réservée même si `maxQueuedRequests=0`. Si l'accusé manque au délai de fermeture,
le processus est tué et close rejette ; aucune instance n'est ressuscitée.

`tools/setup-semantic-index.ts` exporte `installSemanticIndex(options)`,
`semanticIndexSourceFingerprint(crateDir)` et
`verifySemanticIndexPackage(packageDir, platform, sourceSha256)`.
Le setup vérifie Rust/cargo 1.98.1 et le CLI npm 3.10.9, compile sous verrou
Cargo depuis une sortie temporaire fraîche puis installe uniquement le binaire,
package.json et buildinfo.json dans
`.data/toolchains/semantic-index-native-v0.1.0-<platform>/package`.
Le fichier chargé est `native/ase-semantic-index-napi.node` ; le manifeste porte
`addonSha256`, `addonBytes`, `sourceSha256`, les versions, la plateforme et ABI.
La source inclut Cargo.lock et tous les fichiers src ; le setup vérifie son
empreinte avant/après build. Une installation existante est vérifiée, jamais
remplacée silencieusement. Les hashes attestent les octets, pas la
reproductibilité du code machine. Aucun ancien binaire Scratch n'est adopté.

Les versions contextuelles du projecteur RDF sont admises : elles incluent
l'identité du dépôt et la classification normative vérifiée. Le store est
épinglé au BuildRef complet ; le graphe nommé reste `urn:ase:build:<A>`.

## LDkit (`src/adapters/model/semantic/ldkit-model-reader.ts`)

- Moteur `StringSparqlQueryable`/RDFJS maison (`SemanticIndexQueryEngine`) qui
  transmet les chaînes SPARQL à `ModelSemanticIndex.queryReadOnly` (contexte
  versionné `LdkitReaderContext`, résultats bornés par les mêmes quotas) et
  convertit les DTO en termes/bindings RDFJS.
- Schémas LDkit versionnés exposant les noms cohérents (`$id`, métaclasse, nom
  déclaré, nom qualifié, propriétaire, membres) ; `$id` se convertit en
  `BuildElementRef` par le codec vérifié du domaine.
- Lecteur lié à un build (`BoundModelReader`) : `getElement`, `neighbors`,
  `elementsByMetaclass`, `usagesTypedBy` (requête transversale concrète). Aucune
  méthode de mise à jour : les éditions retournent à l'écrivain.

## SHACL (`src/application/model/model-shapes.ts` + `src/adapters/model/diagnostics/shacl-model-diagnostics.ts`)

- Port `ModelShapesDiagnostics.validateBuild({build, facts})` ; moteur distinct
  et versionné, sans WASM (`rdf-validate-shacl`, JS pur RDFJS — dépendances
  proposées au coordinateur, voir le ready JSON).
- Faits : les `ModelDiagnosticFacts` déjà calculés par
  `model-diagnostics-source` sont projetés en RDF (`ase-diagnostic-facts-v1`) ;
  la différence d'ensembles des hôtes et l'exposition restent calculées par ce
  projecteur de faits (occurrences `outsideHost`, booléen
  `hasInvocationBudget`), SHACL Core vérifie les constats. Aucun droit n'est
  réinterprété en RDF.
- Formes versionnées : `src/adapters/shacl/ase-diagnostics-shapes.ttl` (sha256 =
  `shapesDigest`). Deux règles d'abord : `LOOP_WITHOUT_BUDGET`,
  `CAPABILITY_BEYOND_MANDATE` — ce n'est pas « SHACL complet ».
- Rapport immuable `ShaclValidationReport` keyed
  `(A, shapesDigest, factsProjectorVersion, engineId/version,
  optionsDigest)`
  ; stockage W2 sous `("shacl-report",
  shaclReportStoreVersion(identity), A)`.
  Masques utilisateur hors rapport.
- Comparaison au lint TS : `compareDiagnostics` (code, cible, sévérité, finding,
  message/hôtes, remède, source localisable), cas positifs et négatifs couverts
  par les tests colocalisés.
