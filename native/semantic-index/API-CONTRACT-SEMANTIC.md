# Contrat d'API — index sémantique W5/W6 (Oxigraph natif, LDkit, SHACL)

Normatif pour les consommateurs W2/viewer/agents. Publié avant les adapters pour
figer les identités et les ports. Aucun chemin WASM : Oxigraph est le crate Rust
via napi-rs (this crate). LDkit and SHACL orchestration run in Deno; SPARQL
evaluation runs in the native store. L'index n'accorde aucun droit, ne publie
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

## Port consommateur (`src/application/model/semantic/index-service.ts`)

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

## RDF projection (`src/adapters/out/oxigraph/rdf.ts`)

Entrée : `A.elements` canonique natif **normalisé déjà vérifié** (+ build,

- ids bibliothèque explicites). Aucune réanalyse SysML, aucun état runtime.
  Sortie : N-Quads canoniques triés (ordre des unités de code), déterministes,
- `{projectorVersion: "ase-rdf-quads-v4", projectionDigest (sha256 des
octets, ≠ A), quadCount}`.
  `ModelRdfProjector` (port application) est implémenté par
  `DeterministicRdfModelProjector`.

Vocabulary profile v4 (OpenMBEE SysML plus Assembly extensions):

- `rdf:type` → `https://www.omg.org/spec/SysML#<enc(@type)>` + littéral
  `urn:ase:vocab:metaclass` (le nom Toolkit reste canonique, exact).
- Native property `p` → `https://www.omg.org/spec/SysML#<enc(p)>`. Private
  `sysx:` source annotations remain under `urn:ase:vocab:prop:<enc(p)>`.
  Original JSON string literals remain present; arrays of strings also expose
  primitive members under `urn:ase:vocab:string-array-member:<enc(p)>`.
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

Blank-node labels are short opaque identifiers allocated in canonical root/key
order. Path interning preserves every shared occurrence, list position and
value; labels are local to this derived projection, not native model identities.
Earlier v2/v3 immutable cache keys remain distinct.

## Crate native (`ase-semantic-index-napi`, ce dossier)

Mêmes épingles que `native/toolkit` (napi 3.15.0, napi-derive 3.6.13, napi-build
2.6.0, CLI 3.10.9, toolchain Rust 1.98.1 (rust-version minimum 1.97),
`panic=unwind`). Oxigraph épinglé exact, `default-features = false` (Store
mémoire, pas de RocksDB). Classe `SemanticIndexStore` synchrone (le processus
hôte fournit l'isolation) :

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
`{v:1, requestId, processEpoch, ok, result|error:{code,message}}`. Les
opérations sont `load`, `query`, `has`, `release`, `close`. Le requester injecte
un epoch aléatoire par processus et vérifie epoch, version, requestId et
opération de la réponse. Les deux lecteurs utilisent des buffers d'octets à
croissance bornée, avec balayage linéaire ; ils refusent les trames trop grandes
ou UTF-8 invalides.

Options : `maxMessageBytes` (défaut 384 MiB, permettant les 256 MiB N-Quads en
base64), `maxQueuedRequests` (32), `maxQueuedBytes` (384 MiB), `closeTimeoutMs`
(2000). Une seule opération native s'exécute. Le délai passé à `request` couvre
attente de file, écriture, exécution et lecture. Les requêtes expirées en file
sont retirées. Le délai est verrouillé avant SIGKILL ; aucune réponse tardive ne
peut gagner pendant l'arrêt. La sortie du processus est observée avant sa
réutilisation. Un TIMEOUT coopératif, une panic ou un store empoisonné le
recyclent aussi avant l'opération suivante. Le query du port transmet le délai
restant du service sans marge supplémentaire. Les résultats natifs bornent le
DTO JSON complet (métadonnées et séparateurs inclus), avec plafonds de 10 000
résultats, 8 MiB et 30 secondes ; le parent fournit l'interruption dure.

`index.close()` / `executor.close()` / `requester.close()` refusent les
nouvelles requêtes, retirent la file et demandent `store.close()` avec accusé
explicite, puis observent la fin du processus. La fermeture possède une place de
contrôle réservée même si `maxQueuedRequests=0`. Si l'accusé manque au délai de
fermeture, le processus est tué et close rejette ; aucune instance n'est
ressuscitée.

`tools/setup-semantic-index.ts` exporte `installSemanticIndex(options)`,
`semanticIndexSourceFingerprint(crateDir)` et
`verifySemanticIndexPackage(packageDir, platform, sourceSha256)`. Le setup
vérifie Rust/cargo 1.98.1 et le CLI npm 3.10.9, compile sous verrou Cargo depuis
une sortie temporaire fraîche puis installe uniquement le binaire, package.json
et buildinfo.json dans
`.data/toolchains/semantic-index-native-v0.1.0-<platform>/package`. Le fichier
chargé est `native/ase-semantic-index-napi.node` ; le manifeste porte
`addonSha256`, `addonBytes`, `sourceSha256`, les versions, la plateforme et ABI.
La source inclut Cargo.lock et tous les fichiers src ; le setup vérifie son
empreinte avant/après build. Une installation existante est vérifiée, jamais
remplacée silencieusement. Les hashes attestent les octets, pas la
reproductibilité du code machine. Aucun ancien binaire Scratch n'est adopté.

Les versions contextuelles du projecteur RDF sont admises : elles incluent
l'identité du dépôt et la classification normative vérifiée. Le store est
épinglé au BuildRef complet ; le graphe nommé reste `urn:ase:build:<A>`.

## LDkit (`src/adapters/out/oxigraph/ldkit-reader.ts`)

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

## SHACL (`src/adapters/out/shacl/`)

- The two advisory constraints, `LOOP_WITHOUT_BUDGET` and
  `CAPABILITY_BEYOND_MANDATE`, use a parameterized, constraint-only SHACL-SPARQL
  profile on the complete native graph. This is not general SHACL Core/1.2.
- Compiler associations bind each exact unit/policy to its owner system,
  optional admitted budget occurrence and exact source attribute identities. The
  evaluator receives those identities, never precomputed budget booleans or host
  differences. Each constraint runs once across its associations using admitted
  AST VALUES prebinding.
- The budget query checks the exact policy owner and type. Native provenance
  checks verify each attribute's type and exact owner. The capability query
  reads actual allowedHosts/networkHosts literals by those IDs and compares
  their primitive JSON-array members. TypeScript facts remain the
  source-location mapping and independent comparison oracle; they do not grant
  execution rights.
- Shape bytes remain in `src/adapters/out/shacl/ase-diagnostics-shapes.ttl` and
  contribute their SHA-256. Reports contain the complete BuildRef,
  ProjectionRef, context digest and identity with shapes/options digests,
  projector and engine versions. Cache addressing also hashes exact facts and
  query limits; reports do not embed facts, shapes bytes or limits.
  Source/artifact fingerprints and historical cache entries remain unchanged; a
  changed derived projection has its own version/digest.
- Native queries retain read-only AST admission, quotas and process retirement.
  Truncated, unsupported or failed validation produces no conformance report.
  User masks remain outside immutable reports. Corrupt report bytes fail loudly.
- See `src/adapters/out/shacl/README.md` for the exact profile, error boundaries
  and supported operators. Native runtime is Oxigraph 0.5.12 / spargebra 0.4.8,
  with the pinned Rust toolchain and frozen/offline vendor builds.
