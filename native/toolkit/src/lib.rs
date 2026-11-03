//! Pont N-API (napi-rs) Deno -> `sysmlv2_transform::{Library, Session}`.
//!
//! Même discipline que le pont FFI v2 et le wrapper WASM, sans processus
//! CLI et sans rappeler le WASM : les classes ci-dessous gardent l'état
//! Rust privé et appellent directement les bibliothèques du Toolkit.
//!
//! Discipline de la frontière :
//! - API **synchrone** : chaque appel bloque le thread JS pendant le
//!   travail Rust. Aucune promesse d'absence de blocage côté serveur.
//! - `close()` explicite et idempotent ; le finalizer GC (Drop) est un
//!   filet de sécurité distinct, sans garantie temporelle.
//! - Aucun handle Rust emprunté ne traverse : les éléments sont désignés
//!   par des instantanés `{sessionId, generation, nativeId}`. Toute
//!   édition commise incrémente la génération et périme les anciens.
//! - Chaque opération sur une session est enveloppée dans
//!   `catch_unwind` : une panic devient une erreur `NATIVE_PANIC`,
//!   la session est abandonnée (empoisonnée) et doit être recréée,
//!   comme après le statut 2 du FFI.
//! - Aucun `unsafe Send`/`Sync` ajouté : état détenu en propre,
//!   méthodes synchrones sur le thread JS uniquement.
//! - napi-rs 3 : chaque méthode exposée porte son propre attribut
//!   (`#[napi]`, `#[napi(getter)]`, ...) ; sans attribut, une méthode
//!   d'un `impl #[napi]` reste invisible côté JS (vérifié sur le
//!   premier `index.d.ts` généré par le coordinateur).
//!
//! Erreurs : le message commence par un code stable —
//! `SESSION_CLOSED`, `SESSION_POISONED`, `LIBRARY_CLOSED`,
//! `LSP_CLOSED`, `LSP_POISONED`, `WRONG_SESSION`,
//! `STALE_GENERATION`, `ELEMENT_NOT_FOUND`, `LIBRARY_ELEMENT`,
//! `EDIT_REFUSED`, `INVALID_INPUT`, `NATIVE_PANIC`, `TOOLKIT_ERROR` —
//! suivi du détail du Toolkit quand il existe. Voir
//! `API-CONTRACT.md` pour le contrat complet (matrice WASM fermée :
//! compiler, board, views/graph/PlantUML, query,
//! describe/source/extent/references, éditions JSON, tokens LSP UTF-16).

mod dto;
mod json_api;
mod lsp;
mod values;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::json;
use sysmlv2_model::prepared::PreparedLibrary;
use sysmlv2_syntax::parser::parse_expression;
use sysmlv2_syntax::span::LineIndex;
use sysmlv2_transform::{
    CheckFinding, CommitReport, ElementRef, Library, ResolvedModel, Session, Severity,
};

use dto::*;

pub(crate) fn failure(code: &str, message: String) -> Error {
    Error::from_reason(format!("{code}: {message}"))
}

/// Classe un message d'erreur produit dans cette crate (formats du
/// wrapper amont repris par `json_api`/`values`) vers son code stable.
/// Les formats appariés sont émis uniquement par cette crate : la
/// correspondance est donc fermée et déterministe.
fn code_for(message: &str) -> &'static str {
    if message.starts_with("bad ")
        || message.starts_with("empty edit batch")
        || message.starts_with("unknown row field")
        || message.starts_with("sources must be")
    {
        "INVALID_INPUT"
    } else if message.starts_with("element not found: ") {
        "ELEMENT_NOT_FOUND"
    } else if message.ends_with("is a library element (read-only)") {
        "LIBRARY_ELEMENT"
    } else {
        "TOOLKIT_ERROR"
    }
}

fn classify(message: String) -> Error {
    failure(code_for(&message), message)
}

pub(crate) fn panic_detail(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

/// Enveloppe une opération sans état de session (création de
/// bibliothèque) : une panic devient `NATIVE_PANIC`.
pub(crate) fn guard<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(result) => result,
        Err(payload) => Err(failure(
            "NATIVE_PANIC",
            format!(
                "panic caught at N-API boundary: {}",
                panic_detail(&*payload)
            ),
        )),
    }
}

pub(crate) fn as_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

// ---- Compteurs de ressources (preuve de close et de rétention) ----

static NEXT_LIBRARY_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static LIBRARIES_ALIVE: AtomicUsize = AtomicUsize::new(0);
static SESSIONS_ALIVE: AtomicUsize = AtomicUsize::new(0);
static LIBRARIES_CREATED: AtomicU64 = AtomicU64::new(0);
static LIBRARIES_DISPOSED: AtomicU64 = AtomicU64::new(0);
static SESSIONS_CREATED: AtomicU64 = AtomicU64::new(0);
static SESSIONS_DISPOSED: AtomicU64 = AtomicU64::new(0);
pub(crate) static NEXT_LSP_ID: AtomicU64 = AtomicU64::new(1);
pub(crate) static LSP_SERVERS_ALIVE: AtomicUsize = AtomicUsize::new(0);
pub(crate) static LSP_SERVERS_CREATED: AtomicU64 = AtomicU64::new(0);
pub(crate) static LSP_SERVERS_DISPOSED: AtomicU64 = AtomicU64::new(0);

/// Graphes préparés suivis par `Weak` uniquement : le suivi ne retient
/// rien, il observe la rétention réelle (handle ou sessions).
static TRACKED_GRAPHS: Mutex<Vec<Weak<PreparedLibrary>>> = Mutex::new(Vec::new());

fn track_library(library: &Library) {
    if let Library::Prepared(graph) = library {
        if let Ok(mut tracked) = TRACKED_GRAPHS.lock() {
            tracked.push(Arc::downgrade(graph));
        }
    }
}

fn prepared_retains(library: &Library) -> u32 {
    match library {
        Library::Prepared(graph) => as_u32(Arc::strong_count(graph)),
        _ => 0,
    }
}

/// Même validation de frontière que les témoins (`parse_sources`) :
/// un nom d'unité vide est refusé avec son indice.
pub(crate) fn validate_sources(sources: Vec<SourceText>) -> Result<Vec<(String, String)>> {
    if let Some(i) = sources.iter().position(|s| s.name.is_empty()) {
        return Err(failure(
            "INVALID_INPUT",
            format!("sources must be [{{name, text}}]: source {i} has an empty name"),
        ));
    }
    Ok(sources.into_iter().map(|s| (s.name, s.text)).collect())
}

fn snapshot_for(
    resolved: &ResolvedModel,
    session_id: &str,
    generation: u32,
    element: ElementRef,
) -> ElementRefSnapshot {
    ElementRefSnapshot {
        session_id: session_id.to_string(),
        generation,
        native_id: resolved.element_id(element).to_string(),
    }
}

/// Description ciblée sur le modèle résolu typé : seuls les scalaires
/// et les références ci-dessous traversent, jamais un export complet.
fn describe_element(
    resolved: &mut ResolvedModel,
    session_id: &str,
    generation: u32,
    element: ElementRef,
) -> ElementDescription {
    let reference = snapshot_for(resolved, session_id, generation, element);
    let native_id = reference.native_id.clone();
    let metaclass = resolved.element_type(element).to_string();
    let name = resolved.element_name(element).map(str::to_string);
    let declared_short_name = resolved
        .element_declared_short_name(element)
        .map(str::to_string);
    let is_library_element = resolved.is_library_element(element);
    let declaration = resolved
        .declaration_position(element)
        .map(|(unit, line, col)| SourcePosition {
            unit: unit.to_string(),
            line,
            col,
        });
    let members = resolved.owned_members(element);
    let owned_members: Vec<ElementRefSnapshot> = members
        .iter()
        .map(|m| snapshot_for(resolved, session_id, generation, *m))
        .collect();
    let documentation: Vec<String> = resolved
        .element_docs(element)
        .into_iter()
        .map(|(_declared_name, body)| body)
        .collect();
    let qualified_name = resolved.element_qualified_name(element);
    let owner_ref = resolved.owner(element);
    let owner = owner_ref.map(|o| snapshot_for(resolved, session_id, generation, o));
    let owner_qualified_name = match owner_ref {
        Some(o) => resolved.element_qualified_name(o),
        None => None,
    };
    ElementDescription {
        reference,
        native_id,
        name,
        declared_short_name,
        metaclass,
        qualified_name,
        is_library_element,
        owner,
        owner_qualified_name,
        owned_members,
        declaration,
        documentation,
    }
}

/// Findings typés, même contenu que le JSON `check`/`checkSyntax`
/// amont (la forme texte partagée est `json_api::check_findings_json`).
fn findings_to_dto(
    findings: Vec<CheckFinding>,
    indexes: &HashMap<&str, LineIndex>,
) -> Vec<CheckFindingDto> {
    findings
        .into_iter()
        .map(|f| {
            let end = indexes
                .get(f.unit.as_str())
                .map(|li| li.line_col(f.span.end));
            CheckFindingDto {
                severity: match f.severity {
                    Severity::Error => "error".to_string(),
                    Severity::Warning => "warning".to_string(),
                },
                stage: f.stage.as_str().to_string(),
                message: f.message,
                unit: f.unit,
                line: f.line,
                col: f.col,
                end_line: end.map(|e| e.line),
                end_col: end.map(|e| e.col),
            }
        })
        .collect()
}

fn check_findings(session: &mut Session) -> Vec<CheckFindingDto> {
    let findings = session.check_findings();
    let indexes: HashMap<&str, LineIndex> = session
        .units()
        .map(|(_, name, text)| (name, LineIndex::new(text)))
        .collect();
    findings_to_dto(findings, &indexes)
}

fn id_map_of(report: &CommitReport) -> Vec<IdMapping> {
    report
        .id_map
        .iter()
        .map(|(old, new)| IdMapping {
            old_id: old.to_string(),
            new_id: new.to_string(),
        })
        .collect()
}

fn splices_of(report: &CommitReport) -> Vec<EditSplice> {
    report
        .splices
        .iter()
        .map(|s| EditSplice {
            unit: s.unit.clone(),
            start: s.start,
            end: s.end,
            text: s.text.clone(),
        })
        .collect()
}

/// Cible d'édition par id natif ; bibliothèque refusée (lecture seule).
/// Le `String` d'erreur porte déjà son code : le commit la transforme
/// en exception, le dry-run en `refusal`.
fn resolve_edit_target(
    session: &mut Session,
    native_id: &str,
) -> std::result::Result<ElementRef, String> {
    let element = session
        .resolved()
        .element_by_id(native_id)
        .ok_or_else(|| format!("ELEMENT_NOT_FOUND: element not found: @{native_id}"))?;
    if session.resolved().is_library_element(element) {
        return Err(format!(
            "LIBRARY_ELEMENT: @{native_id} is a library element (read-only)"
        ));
    }
    Ok(element)
}

// ---- Bibliothèque préparée partagée ----

/// Bibliothèque Toolkit préparée, partageable avec des sessions.
///
/// Contrat explicite : `close()` ne libère que ce handle. Les sessions
/// déjà créées retiennent leur propre clone bon marché de la
/// bibliothèque (l'`Arc` du graphe préparé) et restent pleinement
/// utilisables ; seule la création de nouvelles sessions est refusée.
/// C'est le même contrat que le témoin WASM (« sessions retain the
/// library independently of this handle's lifetime »).
#[napi]
pub struct ToolkitLibrary {
    id: String,
    inner: Option<Library>,
    counted: bool,
}

impl ToolkitLibrary {
    fn register(library: Library) -> Self {
        track_library(&library);
        let id = format!(
            "tk-library-{}",
            NEXT_LIBRARY_ID.fetch_add(1, Ordering::SeqCst)
        );
        LIBRARIES_ALIVE.fetch_add(1, Ordering::SeqCst);
        LIBRARIES_CREATED.fetch_add(1, Ordering::SeqCst);
        ToolkitLibrary {
            id,
            inner: Some(library),
            counted: true,
        }
    }

    fn library(&self) -> Result<&Library> {
        self.inner
            .as_ref()
            .ok_or_else(|| failure("LIBRARY_CLOSED", format!("library {} is closed", self.id)))
    }

    /// Clone bon marché de la bibliothèque détenue (partage de l'`Arc`
    /// du graphe préparé), pour `NativeLspServer.withPreparedLibrary`.
    pub(crate) fn cloned_library(&self) -> Result<Library> {
        Ok(self.library()?.clone())
    }

    fn release_count(&mut self) {
        if self.counted {
            self.counted = false;
            LIBRARIES_ALIVE.fetch_sub(1, Ordering::SeqCst);
            LIBRARIES_DISPOSED.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[napi]
impl ToolkitLibrary {
    /// Prépare des sources de bibliothèque en mémoire, avec le
    /// recording scellé optionnel enregistré contre exactement ces
    /// unités (`Library::prepared_sources`). Équivalent du
    /// constructeur WASM `PreparedLibrary(sources, snapshot?)`.
    #[napi(constructor)]
    pub fn new(sources: Vec<SourceText>, recording: Option<Uint8Array>) -> Result<Self> {
        let units = validate_sources(sources)?;
        let recording = recording.map(|bytes| {
            let slice: &[u8] = bytes.as_ref();
            slice.to_vec()
        });
        let library = guard(|| {
            Library::prepared_sources(units, recording)
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })?;
        Ok(ToolkitLibrary::register(library))
    }

    /// Décode le snapshot préparé expédié (`sysml-library.prepared`)
    /// d'exactement `sources`, sans résolution au démarrage
    /// (`Library::prepared_snapshot_with`). Équivalent natif de
    /// `PreparedLibrary.fromSnapshot` — attention, l'ordre des
    /// arguments suit ici le pont FFI : sources, snapshot, recording.
    /// `keepHostParts: true` conserve la table de symboles LSP portée
    /// par le snapshot (pour `NativeLspServer.withPreparedLibrary`) ;
    /// par défaut elle est vérifiée puis abandonnée, comme en amont.
    #[napi(factory)]
    pub fn from_prepared_snapshot(
        sources: Vec<SourceText>,
        snapshot: Uint8Array,
        recording: Option<Uint8Array>,
        keep_host_parts: Option<bool>,
    ) -> Result<Self> {
        let units = validate_sources(sources)?;
        let snapshot_slice: &[u8] = snapshot.as_ref();
        let recording = recording.map(|bytes| {
            let slice: &[u8] = bytes.as_ref();
            slice.to_vec()
        });
        let keep_host_parts = keep_host_parts.unwrap_or(false);
        let library = guard(|| {
            Library::prepared_snapshot_with(units, snapshot_slice, recording, keep_host_parts)
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })?;
        Ok(ToolkitLibrary::register(library))
    }

    #[napi(getter)]
    pub fn library_id(&self) -> String {
        self.id.clone()
    }

    #[napi(getter)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_none()
    }

    /// Nombre de détenteurs forts du graphe préparé (ce handle plus
    /// les sessions et modèles qui le partagent) ; 0 si fermée.
    #[napi]
    pub fn prepared_retains(&self) -> u32 {
        match &self.inner {
            Some(library) => prepared_retains(library),
            None => 0,
        }
    }

    /// Crée une session résolue contre cette bibliothèque. La session
    /// retient la bibliothèque indépendamment de ce handle.
    #[napi]
    pub fn create_session(&self, sources: Vec<SourceText>) -> Result<ToolkitSession> {
        let library = self.library()?.clone();
        let units = validate_sources(sources)?;
        let session = guard(|| {
            Session::from_sources_with_library(units, Some(library))
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })?;
        Ok(ToolkitSession::register(session))
    }

    /// Restore full or compact interchange using the same prepared library.
    /// The Toolkit owns lifting, validation and source reconstruction.
    #[napi]
    pub fn create_session_from_interchange_json(
        &self,
        interchange: String,
    ) -> Result<ToolkitSession> {
        let library = self.library()?;
        let value: serde_json::Value = serde_json::from_str(&interchange)
            .map_err(|e| failure("INVALID_INPUT", e.to_string()))?;
        let session = guard(|| {
            Session::from_interchange_json_with(&value, Some(library))
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })?;
        Ok(ToolkitSession::register(session))
    }

    /// Libère déterministement ce handle. Idempotent. Les sessions
    /// existantes ne sont pas affectées (voir le contrat de la classe).
    #[napi]
    pub fn close(&mut self) {
        if self.inner.take().is_some() {
            self.release_count();
        }
    }

    /// Alias de `close()` pour les hôtes qui parlent `dispose`.
    #[napi]
    pub fn dispose(&mut self) {
        self.close();
    }
}

impl Drop for ToolkitLibrary {
    fn drop(&mut self) {
        // Filet de sécurité GC, distinct de close() : sans garantie
        // temporelle, mais les compteurs restent exacts.
        self.inner = None;
        self.release_count();
    }
}

// ---- Session Toolkit à état Rust privé ----

enum EditKind {
    InsertMember(String),
    Rename(String),
}

/// Session Toolkit (`sysmlv2_transform::Session`) derrière une API
/// JS typée. L'état Rust reste privé : aucun `ElementRef` Rust ne
/// traverse la frontière, seules des références instantanées
/// `{sessionId, generation, nativeId}` circulent.
///
/// La génération démarre à 0 et augmente de 1 à chaque édition
/// commise. Un dry-run ou un échec d'édition ne changent ni les
/// sources ni la génération (garantie du Toolkit : la session reste
/// dans son état pré-commit). Toute opération est synchrone.
#[napi]
pub struct ToolkitSession {
    id: String,
    generation: u32,
    session: Option<Session>,
    poisoned: bool,
    counted: bool,
}

impl ToolkitSession {
    fn register(session: Session) -> Self {
        let id = format!(
            "tk-session-{}",
            NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst)
        );
        SESSIONS_ALIVE.fetch_add(1, Ordering::SeqCst);
        SESSIONS_CREATED.fetch_add(1, Ordering::SeqCst);
        ToolkitSession {
            id,
            generation: 0,
            session: Some(session),
            poisoned: false,
            counted: true,
        }
    }

    fn ensure_open(&self) -> Result<()> {
        if self.poisoned {
            return Err(failure(
                "SESSION_POISONED",
                format!(
                    "session {} was abandoned after a native panic; recreate it",
                    self.id
                ),
            ));
        }
        if self.session.is_none() {
            return Err(failure(
                "SESSION_CLOSED",
                format!("session {} is closed", self.id),
            ));
        }
        Ok(())
    }

    fn validate_ref(&self, reference: &ElementRefSnapshot) -> Result<()> {
        if reference.session_id != self.id {
            return Err(failure(
                "WRONG_SESSION",
                format!(
                    "reference belongs to session {} but was used on {}",
                    reference.session_id, self.id
                ),
            ));
        }
        if reference.generation != self.generation {
            return Err(failure(
                "STALE_GENERATION",
                format!(
                    "reference is from generation {} but session {} is at generation {}; re-resolve the element",
                    reference.generation, self.id, self.generation
                ),
            ));
        }
        Ok(())
    }

    fn release_count(&mut self) {
        if self.counted {
            self.counted = false;
            SESSIONS_ALIVE.fetch_sub(1, Ordering::SeqCst);
            SESSIONS_DISPOSED.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Exécute une opération sur la session ouverte. Une panic
    /// empoisonne la session : l'état natif est détruit plutôt que
    /// réutilisé à moitié muté.
    fn run<T>(&mut self, operation: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        self.ensure_open()?;
        let outcome = {
            let session = self.session.as_mut().expect("session checked open");
            catch_unwind(AssertUnwindSafe(|| operation(session)))
        };
        match outcome {
            Ok(result) => result,
            Err(payload) => {
                self.session = None;
                self.poisoned = true;
                self.release_count();
                Err(failure(
                    "NATIVE_PANIC",
                    format!(
                        "panic caught at N-API boundary: {}; session {} abandoned",
                        panic_detail(&*payload),
                        self.id
                    ),
                ))
            }
        }
    }

    fn preview(&mut self, reference: ElementRefSnapshot, kind: EditKind) -> Result<EditPreview> {
        self.ensure_open()?;
        self.validate_ref(&reference)?;
        self.run(|session| {
            let target = match resolve_edit_target(session, &reference.native_id) {
                Ok(target) => target,
                Err(refusal) => {
                    return Ok(EditPreview {
                        would_commit: false,
                        refusal: Some(refusal),
                        id_map: Vec::new(),
                        findings: Vec::new(),
                        splices: Vec::new(),
                    });
                }
            };
            let mut batch = session.edit();
            // Pas de skip_colliding_renames : une opération typée unique
            // refuse une collision au lieu de la sauter en silence.
            // (Le batch JSON des témoins saute, lui, les collisions.)
            match &kind {
                EditKind::InsertMember(text) => {
                    batch.insert_member(target, text);
                }
                EditKind::Rename(new_name) => {
                    batch.rename(target, new_name);
                }
            }
            Ok(match batch.check() {
                Ok(report) => EditPreview {
                    would_commit: true,
                    refusal: None,
                    id_map: id_map_of(&report),
                    findings: report.findings.clone(),
                    splices: splices_of(&report),
                },
                Err(e) => EditPreview {
                    would_commit: false,
                    refusal: Some(e.to_string()),
                    id_map: Vec::new(),
                    findings: Vec::new(),
                    splices: Vec::new(),
                },
            })
        })
    }

    fn commit(&mut self, reference: ElementRefSnapshot, kind: EditKind) -> Result<EditReport> {
        self.ensure_open()?;
        self.validate_ref(&reference)?;
        let report = self.run(|session| {
            let target =
                resolve_edit_target(session, &reference.native_id).map_err(Error::from_reason)?;
            let mut batch = session.edit();
            match &kind {
                EditKind::InsertMember(text) => {
                    batch.insert_member(target, text);
                }
                EditKind::Rename(new_name) => {
                    batch.rename(target, new_name);
                }
            }
            batch
                .commit()
                .map_err(|e| failure("EDIT_REFUSED", e.to_string()))
        })?;
        // Succès seulement : un échec ci-dessus laisse sources et
        // génération inchangées.
        self.generation += 1;
        Ok(EditReport {
            generation: self.generation,
            id_map: id_map_of(&report),
            findings: report.findings.clone(),
            splices: splices_of(&report),
        })
    }

    /// Valide une référence instantanée (session, génération) puis
    /// re-résout son `nativeId` dans la génération courante avant
    /// d'exécuter `operation` sur l'élément — le garde de toutes les
    /// lectures par élément de l'API de compatibilité.
    fn with_element<T>(
        &mut self,
        reference: ElementRefSnapshot,
        operation: impl FnOnce(&mut Session, ElementRef) -> Result<T>,
    ) -> Result<T> {
        self.ensure_open()?;
        self.validate_ref(&reference)?;
        self.run(|session| {
            let element = session
                .resolved()
                .element_by_id(&reference.native_id)
                .ok_or_else(|| {
                    failure(
                        "ELEMENT_NOT_FOUND",
                        format!("element not found: @{}", reference.native_id),
                    )
                })?;
            operation(session, element)
        })
    }

    /// Instantanés d'éléments de la génération courante.
    fn snapshots_of(
        session: &mut Session,
        session_id: &str,
        generation: u32,
        elements: Vec<ElementRef>,
    ) -> Vec<ElementRefSnapshot> {
        let resolved = session.resolved();
        elements
            .into_iter()
            .map(|e| snapshot_for(resolved, session_id, generation, e))
            .collect()
    }
}

#[napi]
impl ToolkitSession {
    /// Session sur des sources mémoire, sans bibliothèque
    /// (`Session::from_sources`). Pour une session résolue contre la
    /// bibliothèque standard, utiliser `ToolkitLibrary.createSession`.
    #[napi(constructor)]
    pub fn new(sources: Vec<SourceText>) -> Result<Self> {
        let units = validate_sources(sources)?;
        let session = guard(|| {
            Session::from_sources(units).map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })?;
        Ok(ToolkitSession::register(session))
    }

    #[napi(getter)]
    pub fn session_id(&self) -> String {
        self.id.clone()
    }

    #[napi(getter)]
    pub fn generation(&self) -> u32 {
        self.generation
    }

    #[napi(getter)]
    pub fn is_closed(&self) -> bool {
        self.session.is_none()
    }

    /// Résumé scalaire sans export (éléments utilisateur, références
    /// non résolues, sites de référence, unités).
    #[napi]
    pub fn summary(&mut self) -> Result<SessionSummary> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.run(|session| {
            let resolved = session.resolved_ref();
            let user_elements = as_u32(resolved.user_elements().count());
            let unresolved_count = as_u32(resolved.unresolved_count());
            let reference_sites = as_u32(resolved.reference_sites().len());
            let units: Vec<String> = session
                .units()
                .map(|(_, name, _)| name.to_string())
                .collect();
            Ok(SessionSummary {
                session_id: session_id.clone(),
                generation,
                user_elements,
                unresolved_count,
                reference_sites,
                units,
            })
        })
    }

    /// Findings de vérification typés, même contenu que le JSON
    /// `check` des témoins WASM/FFI.
    #[napi]
    pub fn check(&mut self) -> Result<Vec<CheckFindingDto>> {
        self.run(|session| Ok(check_findings(session)))
    }

    /// Résout un nom qualifié `::` en référence instantanée, ou
    /// `undefined` si absent. Aucun handle Rust n'est exposé.
    #[napi]
    pub fn resolve(&mut self, qualified_name: String) -> Result<Option<ElementRefSnapshot>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.run(|session| {
            let resolved = session.resolved();
            Ok(resolved
                .resolve_qualified(&qualified_name)
                .map(|e| snapshot_for(resolved, &session_id, generation, e)))
        })
    }

    /// Décrit l'élément désigné par une référence instantanée.
    /// Refuse session étrangère, génération périmée, session fermée
    /// et id natif inconnu dans la génération courante.
    #[napi]
    pub fn describe(&mut self, reference: ElementRefSnapshot) -> Result<ElementDescription> {
        self.ensure_open()?;
        self.validate_ref(&reference)?;
        let session_id = self.id.clone();
        let generation = self.generation;
        self.run(|session| {
            let resolved = session.resolved();
            let element = resolved
                .element_by_id(&reference.native_id)
                .ok_or_else(|| {
                    failure(
                        "ELEMENT_NOT_FOUND",
                        format!("element not found: @{}", reference.native_id),
                    )
                })?;
            Ok(describe_element(resolved, &session_id, generation, element))
        })
    }

    /// `resolve` + `describe` en un seul franchissement typé, sans
    /// aller-retour JSON. `undefined` si le nom qualifié est absent.
    #[napi]
    pub fn describe_qualified(
        &mut self,
        qualified_name: String,
    ) -> Result<Option<ElementDescription>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.run(|session| {
            let resolved = session.resolved();
            Ok(resolved
                .resolve_qualified(&qualified_name)
                .map(|e| describe_element(resolved, &session_id, generation, e)))
        })
    }

    /// Compte les éléments d'une métaclasse et renvoie au plus
    /// `limit` références (défaut 20, comme le témoin FFI).
    #[napi]
    pub fn count_metaclass(
        &mut self,
        metaclass: String,
        limit: Option<u32>,
    ) -> Result<MetaclassCount> {
        let session_id = self.id.clone();
        let generation = self.generation;
        let limit = limit.unwrap_or(20) as usize;
        self.run(|session| {
            let resolved = session.resolved_ref();
            let elements = resolved.elements_of_metaclass(&metaclass);
            let references: Vec<ElementRefSnapshot> = elements
                .iter()
                .take(limit)
                .map(|e| snapshot_for(resolved, &session_id, generation, *e))
                .collect();
            Ok(MetaclassCount {
                metaclass: metaclass.clone(),
                count: as_u32(elements.len()),
                references,
            })
        })
    }

    /// Digest d'état de la session (même valeur que les témoins).
    #[napi]
    pub fn state_digest(&mut self) -> Result<String> {
        self.run(|session| Ok(session.state_digest().to_string()))
    }

    /// Unités utilisateur courantes `{name, text}` (vérification des
    /// splices et de l'invariance après échec d'édition).
    #[napi]
    pub fn units(&mut self) -> Result<Vec<SourceText>> {
        self.run(|session| {
            Ok(session
                .units()
                .map(|(_, name, text)| SourceText {
                    name: name.to_string(),
                    text: text.to_string(),
                })
                .collect())
        })
    }

    /// Export full-form en **texte** JSON (`to_full_json_with(false)`
    /// sérialisé côté Rust), à `JSON.parse` côté hôte : le chemin de
    /// contrôle identique aux témoins WASM/FFI.
    #[napi]
    pub fn export_full_text(&mut self) -> Result<String> {
        self.run(|session| Ok(session.to_full_json_with(false).to_string()))
    }

    /// Export compact en **texte** JSON (`to_compact_json_string`).
    #[napi]
    pub fn export_compact_text(&mut self) -> Result<String> {
        self.run(|session| Ok(session.to_compact_json_string()))
    }

    /// Export full-form construit directement en **objets JS** par
    /// napi-rs (conversion `serde_json::Value`), sans sérialisation
    /// texte ni `JSON.parse`. Même valeur logique que
    /// `exportFullText` parsé ; pas nécessairement plus rapide.
    #[napi]
    pub fn export_full_object(&mut self) -> Result<serde_json::Value> {
        self.run(|session| Ok(session.to_full_json_with(false)))
    }

    /// Export compact construit directement en **objets JS**.
    #[napi]
    pub fn export_compact_object(&mut self) -> Result<serde_json::Value> {
        self.run(|session| Ok(session.to_compact_json()))
    }

    /// Dry-run d'une insertion de membre : pipeline complet sur
    /// copies, session et génération inchangées.
    #[napi]
    pub fn check_insert_member(
        &mut self,
        owner: ElementRefSnapshot,
        text: String,
    ) -> Result<EditPreview> {
        self.preview(owner, EditKind::InsertMember(text))
    }

    /// Insère `text` comme dernier membre du propriétaire désigné.
    /// En cas de succès, génération +1 et anciennes références
    /// périmées. En cas de refus, exception `EDIT_REFUSED` et
    /// session strictement inchangée.
    #[napi]
    pub fn insert_member(&mut self, owner: ElementRefSnapshot, text: String) -> Result<EditReport> {
        self.commit(owner, EditKind::InsertMember(text))
    }

    /// Dry-run d'un renommage (voir `checkInsertMember`).
    #[napi]
    pub fn check_rename(
        &mut self,
        target: ElementRefSnapshot,
        new_name: String,
    ) -> Result<EditPreview> {
        self.preview(target, EditKind::Rename(new_name))
    }

    /// Renomme l'élément désigné. Le renommage réécrit le chemin de
    /// propriété : l'id natif de l'élément (et de son sous-arbre)
    /// change ; le rapport `idMap` donne les paires ancien -> nouveau
    /// effectivement observées. Ne jamais supposer un id stable.
    #[napi]
    pub fn rename(&mut self, target: ElementRefSnapshot, new_name: String) -> Result<EditReport> {
        self.commit(target, EditKind::Rename(new_name))
    }

    // ---- API de compatibilité bas niveau (miroir JSON du wrapper
    // amont, éléments en instantanés vérifiés) ----

    /// Findings de vérification en JSON texte, identiques au
    /// `Session.check()` amont (`check()` ci-dessus est la forme typée
    /// du même contenu).
    #[napi]
    pub fn check_json(&mut self) -> Result<String> {
        self.run(|session| {
            let findings = session.check_findings();
            let indexes: HashMap<&str, LineIndex> = session
                .units()
                .map(|(_, name, text)| (name, LineIndex::new(text)))
                .collect();
            Ok(json_api::check_findings_json(findings, &indexes))
        })
    }

    /// Full interchange JSON en texte (`toFullJson` amont) ; avec
    /// `recoverRefs`, les références pendantes portent aussi leur
    /// orthographe source.
    #[napi]
    pub fn to_full_json(&mut self, recover_refs: bool) -> Result<String> {
        self.run(|session| Ok(session.to_full_json_with(recover_refs).to_string()))
    }

    /// Évalue une expression de requête KerML à la racine (sémantique
    /// `sysmlv2 query` amont) ; la valeur revient en JSON texte, les
    /// éléments comme `{"@element": id, "qualifiedName": …}`.
    #[napi]
    pub fn query(&mut self, expression: String) -> Result<String> {
        self.run(|session| {
            let parsed = parse_expression(&expression);
            let Some(ast) = parsed.expr else {
                let msg = parsed
                    .diagnostics
                    .first()
                    .map(|d| d.message.clone())
                    .unwrap_or_else(|| "not an expression".into());
                return Err(failure("TOOLKIT_ERROR", msg));
            };
            let root = session.resolved().root_scope();
            let value = session
                .resolved()
                .query(root, &ast)
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))?;
            Ok(values::value_to_json(session, &value).to_string())
        })
    }

    /// Retrouve un `@id` d'interchange (éléments anonymes et de
    /// bibliothèque compris) comme référence instantanée, ou
    /// `undefined` si absent/malformé.
    #[napi]
    pub fn element_by_id(&mut self, native_id: String) -> Result<Option<ElementRefSnapshot>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.run(|session| {
            let resolved = session.resolved();
            Ok(resolved
                .element_by_id(&native_id)
                .map(|e| snapshot_for(resolved, &session_id, generation, e)))
        })
    }

    /// Propriété (détenue/dérivée) par nom de spécification, en JSON
    /// texte — `Session.property` amont.
    #[napi]
    pub fn property(&mut self, reference: ElementRefSnapshot, name: String) -> Result<String> {
        self.with_element(reference, |session, element| {
            session
                .resolved()
                .property(element, &name)
                .map(|v| v.to_string())
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))
        })
    }

    /// Propriété dérivée par nom de spécification, en JSON texte —
    /// `Session.derived` amont (`{"@id": …}` pour un élément,
    /// `{"outside": true, …}` hors modèle).
    #[napi]
    pub fn derived(&mut self, reference: ElementRefSnapshot, name: String) -> Result<String> {
        self.with_element(reference, |session, element| {
            values::derived_json(session, element, &name)
                .map(|value| value.to_string())
                .map_err(|message| failure("TOOLKIT_ERROR", message))
        })
    }

    /// Éléments portés par la propriété dérivée `name`
    /// (`derivedElements` amont ; cibles hors modèle omises).
    #[napi]
    pub fn derived_elements(
        &mut self,
        reference: ElementRefSnapshot,
        name: String,
    ) -> Result<Vec<ElementRefSnapshot>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.with_element(reference, |session, element| {
            let elements = values::derived_elements(session, element, &name)
                .map_err(|message| failure("TOOLKIT_ERROR", message))?;
            Ok(Self::snapshots_of(
                session,
                &session_id,
                generation,
                elements,
            ))
        })
    }

    /// Texte source de l'expression de valeur liée (`= <expr>`), ou
    /// `undefined` sans partie valeur — `valueSource` amont.
    #[napi]
    pub fn value_source(&mut self, reference: ElementRefSnapshot) -> Result<Option<String>> {
        self.with_element(reference, |session, element| {
            Ok(json_api::value_source(session, element))
        })
    }

    /// La valeur propre est-elle un défaut (`default v`) plutôt qu'une
    /// liaison (`= v`) ? `undefined` sans valeur déclarée.
    #[napi]
    pub fn value_is_default(&mut self, reference: ElementRefSnapshot) -> Result<Option<bool>> {
        self.with_element(reference, |session, element| {
            Ok(session.resolved().value_is_default(element))
        })
    }

    /// La feature racine atteinte par les redéfinitions de l'élément
    /// (ou lui-même) — `redefinitionRoot` amont.
    #[napi]
    pub fn redefinition_root(
        &mut self,
        reference: ElementRefSnapshot,
    ) -> Result<ElementRefSnapshot> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.with_element(reference, |session, element| {
            let root = session.resolved().redefinition_root(element);
            Ok(snapshot_for(
                session.resolved(),
                &session_id,
                generation,
                root,
            ))
        })
    }

    /// Arbre d'outline et shape des éléments nommés en un JSON texte
    /// (`Session.outline` amont) ; options `{outlineNodes?,
    /// outlineDepth?, shapeNodes?, shapeDepth?}`.
    #[napi]
    pub fn outline(&mut self, options: Option<String>) -> Result<String> {
        self.run(|session| json_api::outline(session, options.as_deref()).map_err(classify))
    }

    /// Graphe de diagramme structuré en JSON texte (`toGraph` amont,
    /// `summary`/`fullWithin` compris) ; mêmes options qu'en amont.
    #[napi]
    pub fn to_graph(&mut self, options: Option<String>) -> Result<String> {
        self.run(|session| json_api::to_graph(session, options.as_deref()).map_err(classify))
    }

    /// Diagramme PlantUML en texte (`toPlantuml` amont) ; mêmes
    /// options que `toGraph`.
    #[napi]
    pub fn to_plantuml(&mut self, options: Option<String>) -> Result<String> {
        self.run(|session| json_api::to_plantuml(session, options.as_deref()).map_err(classify))
    }

    /// Description d'un `view` usage en JSON texte (`viewInfo`
    /// amont : rendering, éléments exposés, sous-vues, métadonnées
    /// évaluées).
    #[napi]
    pub fn view_info(&mut self, qualified_name: String) -> Result<String> {
        self.run(|session| json_api::view_info(session, &qualified_name).map_err(classify))
    }

    /// Nom déclaré de l'élément (`undefined` si anonyme) ; le `name`
    /// de spécification se lit par `derived(ref, "name")`.
    #[napi]
    pub fn name(&mut self, reference: ElementRefSnapshot) -> Result<Option<String>> {
        self.with_element(reference, |session, element| {
            Ok(session.resolved().element_name(element).map(str::to_string))
        })
    }

    /// Nom court déclaré (`<shortName>`), s'il existe.
    #[napi]
    pub fn short_name(&mut self, reference: ElementRefSnapshot) -> Result<Option<String>> {
        self.with_element(reference, |session, element| {
            Ok(session
                .resolved()
                .element_declared_short_name(element)
                .map(str::to_string))
        })
    }

    /// Membres détenus, dans l'ordre de déclaration (KerML
    /// `ownedMember`).
    #[napi]
    pub fn members(&mut self, reference: ElementRefSnapshot) -> Result<Vec<ElementRefSnapshot>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.with_element(reference, |session, element| {
            let members = session.resolved().owned_members(element);
            Ok(Self::snapshots_of(
                session,
                &session_id,
                generation,
                members,
            ))
        })
    }

    /// Features détenues via des memberships de feature (KerML
    /// `ownedFeature`).
    #[napi]
    pub fn features(&mut self, reference: ElementRefSnapshot) -> Result<Vec<ElementRefSnapshot>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.with_element(reference, |session, element| {
            let features = session.resolved().owned_features(element);
            Ok(Self::snapshots_of(
                session,
                &session_id,
                generation,
                features,
            ))
        })
    }

    /// Valeur de feature liée, évaluée, en JSON texte (même forme que
    /// `query`) — `Session.evaluate` amont.
    #[napi]
    pub fn evaluate(&mut self, reference: ElementRefSnapshot) -> Result<String> {
        self.with_element(reference, |session, element| {
            let value = session
                .resolved()
                .evaluate(element)
                .map_err(|e| failure("TOOLKIT_ERROR", e.to_string()))?;
            Ok(values::value_to_json(session, &value).to_string())
        })
    }

    /// Tout élément de la métaclasse donnée (références instantanées,
    /// sans borne — voir aussi `countMetaclass` borné).
    #[napi]
    pub fn elements_of_metaclass(&mut self, metaclass: String) -> Result<Vec<ElementRefSnapshot>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.run(|session| {
            let elements = session.resolved_ref().elements_of_metaclass(&metaclass);
            Ok(Self::snapshots_of(
                session,
                &session_id,
                generation,
                elements,
            ))
        })
    }

    /// Corps de documentation/commentaire de l'élément, normalisés
    /// pour l'affichage, dans l'ordre de déclaration.
    #[napi]
    pub fn docs(&mut self, reference: ElementRefSnapshot) -> Result<Vec<String>> {
        self.with_element(reference, |session, element| {
            Ok(session
                .resolved()
                .annotation_bodies()
                .into_iter()
                .filter(|(t, _)| *t == element)
                .map(|(_, b)| sysmlv2_model::json::doc_display_text(&b))
                .filter(|b| !b.is_empty())
                .collect())
        })
    }

    /// L'élément atteint-il l'ancêtre par la fermeture de
    /// spécialisation explicite ? Les deux références sont revérifiées.
    #[napi]
    pub fn conforms(
        &mut self,
        reference: ElementRefSnapshot,
        ancestor: ElementRefSnapshot,
    ) -> Result<bool> {
        self.ensure_open()?;
        self.validate_ref(&reference)?;
        self.validate_ref(&ancestor)?;
        self.run(|session| {
            let element = session
                .resolved()
                .element_by_id(&reference.native_id)
                .ok_or_else(|| {
                    failure(
                        "ELEMENT_NOT_FOUND",
                        format!("element not found: @{}", reference.native_id),
                    )
                })?;
            let ancestor_element = session
                .resolved()
                .element_by_id(&ancestor.native_id)
                .ok_or_else(|| {
                    failure(
                        "ELEMENT_NOT_FOUND",
                        format!("element not found: @{}", ancestor.native_id),
                    )
                })?;
            Ok(session.resolved().conforms(element, ancestor_element))
        })
    }

    /// Site de déclaration en JSON texte `{"unit": index, "start":
    /// octet, "end": octet}` (le nom déclaré, sinon l'étendue du
    /// membre), ou `undefined` sans source enregistrée.
    #[napi]
    pub fn declaration_site(&mut self, reference: ElementRefSnapshot) -> Result<Option<String>> {
        self.with_element(reference, |session, element| {
            Ok(json_api::declaration_site_of(session, element)
                .map(|site| json_api::extent_json(site).to_string()))
        })
    }

    /// L'`@id` d'interchange de l'élément, re-dérivé du modèle
    /// courant (jamais écho de la référence reçue).
    #[napi]
    pub fn element_id(&mut self, reference: ElementRefSnapshot) -> Result<String> {
        self.with_element(reference, |session, element| {
            Ok(session.resolved().element_id(element).to_string())
        })
    }

    /// Nom qualifié de l'élément (`undefined` si anonyme) — propriété
    /// du modèle, pas du texte source (voir `referenceSpelling`).
    #[napi]
    pub fn qualified_name(&mut self, reference: ElementRefSnapshot) -> Result<Option<String>> {
        self.with_element(reference, |session, element| {
            Ok(session.resolved().element_qualified_name(element))
        })
    }

    /// Nom qualifié orthographié en texte de référence re-analysable
    /// (`'part'::'view'`) ; `undefined` si anonyme.
    #[napi]
    pub fn reference_spelling(&mut self, reference: ElementRefSnapshot) -> Result<Option<String>> {
        self.with_element(reference, |session, element| {
            Ok(session.resolved().element_reference_spelling(element))
        })
    }

    /// Métaclasse de syntaxe abstraite de l'élément (`PartUsage`, …).
    #[napi]
    pub fn metaclass(&mut self, reference: ElementRefSnapshot) -> Result<String> {
        self.with_element(reference, |session, element| {
            Ok(session.resolved().element_type(element).to_string())
        })
    }

    /// L'élément appartient-il à une bibliothèque chargée ?
    #[napi]
    pub fn is_library_element(&mut self, reference: ElementRefSnapshot) -> Result<bool> {
        self.with_element(reference, |session, element| {
            Ok(session.resolved().is_library_element(element))
        })
    }

    /// Propriétaire de l'élément (`undefined` pour une racine de
    /// document).
    #[napi]
    pub fn owner(&mut self, reference: ElementRefSnapshot) -> Result<Option<ElementRefSnapshot>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.with_element(reference, |session, element| {
            let resolved = session.resolved();
            Ok(resolved
                .owner(element)
                .map(|o| snapshot_for(resolved, &session_id, generation, o)))
        })
    }

    /// Cibles explicites de typage (`: T`), résolues.
    #[napi]
    pub fn typings(&mut self, reference: ElementRefSnapshot) -> Result<Vec<ElementRefSnapshot>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.with_element(reference, |session, element| {
            let types = session.resolved().typings(element);
            Ok(Self::snapshots_of(session, &session_id, generation, types))
        })
    }

    /// Lectures par élément en lot, JSON texte (`Session.rows`
    /// amont) : `idsJson` = tableau d'`@id`, `fieldsJson` = tableau
    /// de champs (`name`, `memberExtent`, `property:<n>`,
    /// `derived:<n>`, …) ; ligne `null` si l'id est absent, erreurs
    /// par champ sous `errors`.
    #[napi]
    pub fn rows(&mut self, ids_json: String, fields_json: String) -> Result<String> {
        self.run(|session| json_api::rows(session, &ids_json, &fields_json).map_err(classify))
    }

    /// Texte source complet de la déclaration du membre (cible = nom
    /// qualifié ou `@<@id>`) — ce qu'un copier/coller transporte entre
    /// propriétaires. Refuse bibliothèque et absence d'étendue.
    #[napi]
    pub fn member_source(&mut self, target: String) -> Result<String> {
        self.run(|session| json_api::member_source(session, &target).map_err(classify))
    }

    /// Étendue complète du membre en JSON texte `{"unit","start",
    /// "end"}` (déclaration et corps), ou `undefined`.
    #[napi]
    pub fn member_extent(&mut self, reference: ElementRefSnapshot) -> Result<Option<String>> {
        self.with_element(reference, |session, element| {
            Ok(session
                .resolved()
                .member_extent(element)
                .map(|site| json_api::extent_json(site).to_string()))
        })
    }

    /// Usages de l'élément désigné (sélecteur = nom qualifié nu/JSON
    /// ou `{"elementId": …}`), JSON texte `references` amont :
    /// positions 1-based, colonnes en unités UTF-16.
    /// Additive `siteFingerprint`: full reference span, exact owner/root IDs,
    /// kind and source preimage for `retargetReference`; null if not editable.
    /// Every successful answer includes `referenceSiteFormat` equal to
    /// `assembly-native-reference-site/v1`, including empty reference arrays.
    /// `referenceSitesOmitted` counts native sites without representable positions;
    /// a null fingerprint remains an explicit returned entry, not an omission.
    #[napi]
    pub fn references(&mut self, selector_json: String) -> Result<String> {
        self.run(|session| json_api::references(session, &selector_json).map_err(classify))
    }

    /// Éléments utilisateur de premier niveau (membres des namespaces
    /// racines des unités), dans l'ordre de déclaration.
    #[napi]
    pub fn roots(&mut self) -> Result<Vec<ElementRefSnapshot>> {
        let session_id = self.id.clone();
        let generation = self.generation;
        self.run(|session| {
            let roots = json_api::root_refs(session);
            Ok(Self::snapshots_of(session, &session_id, generation, roots))
        })
    }

    /// Unités utilisateur en JSON texte `[{unit, name, text}]`
    /// (`unit` = index modèle) — `Session.units` amont ; `units()`
    /// ci-dessus est la forme typée sans index.
    #[napi]
    pub fn units_json(&mut self) -> Result<String> {
        self.run(|session| {
            let units: Vec<serde_json::Value> = session
                .units()
                .map(|(i, n, s)| json!({"unit": i, "name": n, "text": s}))
                .collect();
            Ok(serde_json::Value::Array(units).to_string())
        })
    }

    /// Dry-run d'un batch d'édition JSON (mêmes opérations que
    /// `edit`) : pipeline complet sur copies, session et génération
    /// inchangées. Retourne `{wouldCommit: true, idMap, findings,
    /// splices}` ou `{wouldCommit: false, refusal}` en JSON texte ;
    /// ne lève que pour des ops JSON malformées (`INVALID_INPUT`).
    #[napi]
    pub fn check_edit(&mut self, operations: String) -> Result<String> {
        self.ensure_open()?;
        self.run(|session| {
            let ops = json_api::parse_ops(&operations).map_err(classify)?;
            let resolved = match json_api::resolve_ops(session, ops) {
                Ok(resolved) => resolved,
                Err(refusal) => {
                    return Ok(json!({"wouldCommit": false, "refusal": refusal}).to_string());
                }
            };
            let mut batch = session.edit();
            batch.skip_colliding_renames();
            json_api::stage_ops(&mut batch, &resolved);
            Ok(match batch.check() {
                Ok(report) => {
                    let mut value = json_api::report_json(&report);
                    value["wouldCommit"] = json!(true);
                    value.to_string()
                }
                Err(e) => json!({"wouldCommit": false, "refusal": e.to_string()}).to_string(),
            })
        })
    }

    /// Applique un batch d'édition JSON (`rename`, `setFeatureValue`,
    /// `insertMember`, `replaceMember`, `setFeatureType`, `remove`,
    /// et tout le vocabulaire amont) : rapport JSON texte `{idMap,
    /// findings, splices}` en coordonnées pré-commit. En cas de
    /// succès, génération +1 et anciennes références périmées ; en cas
    /// de refus, `EDIT_REFUSED` et session strictement inchangée.
    /// Un `rename` en collision est sauté et signalé dans
    /// `findings`, comme en amont.
    /// `retargetReference {fromId,toId,site}` revalidates a complete fingerprint
    /// from `references`; it never accepts an unchecked source splice.
    #[napi]
    pub fn edit(&mut self, operations: String) -> Result<String> {
        self.ensure_open()?;
        let report = self.run(|session| {
            let ops = json_api::parse_ops(&operations).map_err(classify)?;
            let resolved = json_api::resolve_ops(session, ops)
                .map_err(|message| failure("EDIT_REFUSED", message))?;
            let mut batch = session.edit();
            batch.skip_colliding_renames();
            json_api::stage_ops(&mut batch, &resolved);
            let report = batch
                .commit()
                .map_err(|e| failure("EDIT_REFUSED", e.to_string()))?;
            Ok(json_api::report_json(&report).to_string())
        })?;
        // Succès seulement (miroir amont, batch vide d'effet compris) :
        // la session a été reconstruite, les références périment.
        self.generation += 1;
        Ok(report)
    }

    /// Libère déterministement l'état Rust. Idempotent ; tout appel
    /// ultérieur (hors getters d'identité) échoue en `SESSION_CLOSED`.
    /// Aucune ressource native n'est attachée à la durée de vie d'un
    /// Case ou d'un opérateur : seule cette session est libérée.
    #[napi]
    pub fn close(&mut self) {
        if self.session.take().is_some() {
            self.release_count();
        }
    }

    /// Alias de `close()`.
    #[napi]
    pub fn dispose(&mut self) {
        self.close();
    }
}

impl Drop for ToolkitSession {
    fn drop(&mut self) {
        self.session = None;
        self.release_count();
    }
}

// ---- Fonctions du module ----

/// Version du Toolkit contre lequel cet addon est lié — l'épingle de
/// distribution (`sysml-toolkit-pin.ts`, manifeste vendor). Le
/// snapshot préparé refuse de toute façon un autre build : cette
/// chaîne sert au contrôle de cohérence du chargeur, jamais de preuve.
pub const TOOLKIT_VERSION: &str = "0.10.10+ase.2";

#[napi]
pub fn toolkit_version() -> String {
    TOOLKIT_VERSION.to_string()
}

/// Version du crate addon (pas celle du Toolkit — voir
/// `toolkitVersion`).
#[napi]
pub fn addon_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Étages parse/contexte seuls (`checkSyntax` amont), sans construire
/// de modèle : `sourcesJson` = JSON `[{name, text}]`, retour = JSON
/// texte des findings `[{severity, stage, message, unit, line, col,
/// endLine?, endCol?}]`. Un échec de parse est un finding, pas une
/// erreur ; seules des sources malformées lèvent `INVALID_INPUT`.
#[napi]
pub fn check_syntax(sources_json: String) -> Result<String> {
    guard(|| {
        let sources = json_api::parse_sources_json(&sources_json).map_err(classify)?;
        let findings = sysmlv2_transform::check_sources_syntax(&sources);
        let indexes: HashMap<&str, LineIndex> = sources
            .iter()
            .map(|(name, text)| (name.as_str(), LineIndex::new(text)))
            .collect();
        Ok(json_api::check_findings_json(findings, &indexes))
    })
}

/// Même contenu que `checkSyntax`, en forme typée depuis des
/// `SourceText[]`.
#[napi]
pub fn check_syntax_findings(sources: Vec<SourceText>) -> Result<Vec<CheckFindingDto>> {
    let units = validate_sources(sources)?;
    guard(|| {
        let findings = sysmlv2_transform::check_sources_syntax(&units);
        let indexes: HashMap<&str, LineIndex> = units
            .iter()
            .map(|(name, text)| (name.as_str(), LineIndex::new(text)))
            .collect();
        Ok(findings_to_dto(findings, &indexes))
    })
}

/// Compteurs de ressources natives vivantes dans ce processus addon.
/// Permet de prouver un nettoyage explicite à zéro et d'observer la
/// rétention partagée bibliothèque/session, indépendamment du GC.
#[napi]
pub fn native_resource_counts() -> ResourceCounts {
    let (graphs_alive, retains) = match TRACKED_GRAPHS.lock() {
        Ok(mut tracked) => {
            tracked.retain(|weak| weak.strong_count() > 0);
            let retains: usize = tracked.iter().map(|weak| weak.strong_count()).sum();
            (as_u32(tracked.len()), as_u32(retains))
        }
        Err(_) => (0, 0),
    };
    ResourceCounts {
        libraries_alive: as_u32(LIBRARIES_ALIVE.load(Ordering::SeqCst)),
        sessions_alive: as_u32(SESSIONS_ALIVE.load(Ordering::SeqCst)),
        libraries_created: as_u32(
            usize::try_from(LIBRARIES_CREATED.load(Ordering::SeqCst)).unwrap_or(usize::MAX),
        ),
        libraries_disposed: as_u32(
            usize::try_from(LIBRARIES_DISPOSED.load(Ordering::SeqCst)).unwrap_or(usize::MAX),
        ),
        sessions_created: as_u32(
            usize::try_from(SESSIONS_CREATED.load(Ordering::SeqCst)).unwrap_or(usize::MAX),
        ),
        sessions_disposed: as_u32(
            usize::try_from(SESSIONS_DISPOSED.load(Ordering::SeqCst)).unwrap_or(usize::MAX),
        ),
        prepared_graphs_alive: graphs_alive,
        prepared_retains: retains,
        lsp_servers_alive: as_u32(LSP_SERVERS_ALIVE.load(Ordering::SeqCst)),
        lsp_servers_created: as_u32(
            usize::try_from(LSP_SERVERS_CREATED.load(Ordering::SeqCst)).unwrap_or(usize::MAX),
        ),
        lsp_servers_disposed: as_u32(
            usize::try_from(LSP_SERVERS_DISPOSED.load(Ordering::SeqCst)).unwrap_or(usize::MAX),
        ),
    }
}
