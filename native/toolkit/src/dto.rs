//! Objets JS typés échangés à la frontière N-API.
//!
//! Vocabulaire strictement Toolkit : `nativeId` est l'`@id` d'interchange,
//! `metaclass` est l'`@type` (par exemple `PartDefinition`), `name` est le
//! nom déclaré (renommable, jamais une identité). Aucun nom métier inventé.
//! Les déclarations TypeScript de ces interfaces sont produites par
//! napi-derive (`type-def`) via `@napi-rs/cli`, pas écrites à la main.

use napi_derive::napi;

/// Une unité source `(nom, texte)`, même forme que le JSON `[{name, text}]`
/// des témoins WASM/FFI, mais transportée en objets JS typés.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct SourceText {
    pub name: String,
    pub text: String,
}

/// Référence locale et périssable vers un élément d'une session.
///
/// Ne contient aucun pointeur ni handle Rust : après toute édition commise,
/// `generation` change et cette référence est refusée. `nativeId` seul ne
/// suffit jamais : la session et la génération doivent correspondre.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ElementRefSnapshot {
    pub session_id: String,
    pub generation: u32,
    pub native_id: String,
}

/// Position de déclaration 1-based dans une unité nommée.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct SourcePosition {
    pub unit: String,
    pub line: u32,
    pub col: u32,
}

/// Description ciblée d'un élément, lue sur le `ResolvedModel` typé.
///
/// `name` est le nom déclaré (renommable) ; `metaclass` est le type
/// d'interchange de l'élément. Par exemple l'élément nommé
/// `SoftwareOperator` a pour métaclasse `PartDefinition` : le nom d'une
/// définition ne devient jamais une métaclasse.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ElementDescription {
    pub reference: ElementRefSnapshot,
    pub native_id: String,
    pub name: Option<String>,
    pub declared_short_name: Option<String>,
    pub metaclass: String,
    pub qualified_name: Option<String>,
    pub is_library_element: bool,
    pub owner: Option<ElementRefSnapshot>,
    pub owner_qualified_name: Option<String>,
    pub owned_members: Vec<ElementRefSnapshot>,
    pub declaration: Option<SourcePosition>,
    pub documentation: Vec<String>,
}

/// Un finding de `Session::check_findings`, même forme que le JSON
/// `Session.check` des témoins (severity/stage/message/unit/line/col
/// et fin de span quand l'unité est connue).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct CheckFindingDto {
    pub severity: String,
    pub stage: String,
    pub message: String,
    pub unit: String,
    pub line: u32,
    pub col: u32,
    pub end_line: Option<u32>,
    pub end_col: Option<u32>,
}

/// Résumé d'une session sans aucun export : seuls des scalaires et les
/// noms d'unités traversent la frontière.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct SessionSummary {
    pub session_id: String,
    pub generation: u32,
    pub user_elements: u32,
    pub unresolved_count: u32,
    pub reference_sites: u32,
    pub units: Vec<String>,
}

/// Comptage par métaclasse avec un échantillon borné de références.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct MetaclassCount {
    pub metaclass: String,
    pub count: u32,
    pub references: Vec<ElementRefSnapshot>,
}

/// Changement d'`@id` d'interchange après édition : les renommages
/// réécrivent le chemin de propriété, donc l'id dérivé (voir `IDS.md`).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct IdMapping {
    pub old_id: String,
    pub new_id: String,
}

/// Un remplacement de texte appliqué, en coordonnées pré-commit.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct EditSplice {
    pub unit: String,
    pub start: u32,
    pub end: u32,
    pub text: String,
}

/// Résultat d'un dry-run d'édition (`check*`) : les refus métier
/// reviennent avec `wouldCommit: false`, comme `Session.checkEdit`.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct EditPreview {
    pub would_commit: bool,
    pub refusal: Option<String>,
    pub id_map: Vec<IdMapping>,
    pub findings: Vec<String>,
    pub splices: Vec<EditSplice>,
}

/// Rapport d'une édition commise. `generation` est la nouvelle
/// génération de la session : toutes les références antérieures
/// sont périmées dès le retour de l'appel.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct EditReport {
    pub generation: u32,
    pub id_map: Vec<IdMapping>,
    pub findings: Vec<String>,
    pub splices: Vec<EditSplice>,
}

/// Compteurs de ressources natives du processus addon.
///
/// `preparedGraphsAlive` compte les graphes de bibliothèque préparée
/// encore retenus (par un handle `ToolkitLibrary` ou par une session
/// qui partage le même `Arc`) ; `preparedRetains` en somme les
/// compteurs forts. Ces compteurs prouvent `close()` et la rétention
/// partagée bibliothèque/session sans dépendre du GC.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ResourceCounts {
    pub libraries_alive: u32,
    pub sessions_alive: u32,
    pub libraries_created: u32,
    pub libraries_disposed: u32,
    pub sessions_created: u32,
    pub sessions_disposed: u32,
    pub prepared_graphs_alive: u32,
    pub prepared_retains: u32,
    pub lsp_servers_alive: u32,
    pub lsp_servers_created: u32,
    pub lsp_servers_disposed: u32,
}
