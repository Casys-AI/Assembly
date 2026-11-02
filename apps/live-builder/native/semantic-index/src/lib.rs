//! Pont N-API (napi-rs) Deno -> Oxigraph (Rust natif), index W5.
//!
//! Discipline de la frontiere, comme `native/toolkit` :
//! - API **synchrone** : l'isolation et les delais durs vivent dans le
//!   processus hote tuable cote TypeScript ; aucun Promise ici.
//! - Un `Store` Oxigraph en memoire **par build** (cle = BuildRef complet
//!   fourni par l'adapter) : le dataset d'une requete est epingle a ce
//!   build, aucun autre graphe n'existe dans le store interroge.
//! - Admission par l'AST (spargebra) : requetes lecture seule uniquement,
//!   aucun `SERVICE`, aucun dataset choisi par le client. Quotas
//!   resultats/octets/duree appliques pendant l'iteration ; un `LIMIT`
//!   seul ne borne rien. Le recyclage du processus reste la limite dure.
//! - Chargement parse-integral-puis-remplacement : sha256 et graphe nomme
//!   verifies avant tout etat visible. La persistance est la projection
//!   N-Quads du magasin W2 ; perdre cet index ne perd aucune donnee.
//! - `catch_unwind` partout : une panic devient `NATIVE_PANIC` et
//!   empoisonne le store, a recreer. `close()` explicite et idempotent.
//!
//! Erreurs : message `CODE: detail` — `INDEX_CLOSED`, `INDEX_POISONED`,
//! `GRAPH_NOT_FOUND`, `QUERY_REFUSED`, `QUERY_LIMIT`, `TIMEOUT`,
//! `INVALID_INPUT`, `INTEGRITY`, `STORE_FULL`, `NATIVE_PANIC`,
//! `OXIGRAPH_ERROR`. Voir `API-CONTRACT-SEMANTIC.md`.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;
use std::time::Instant;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use oxigraph::io::{RdfFormat, RdfParser};
use oxigraph::model::{GraphName, Literal, NamedNode, Quad, Subject, Term, Triple};
use oxigraph::sparql::{Query as OxigraphQuery, QueryResults};
use oxigraph::store::Store;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spargebra::algebra::{AggregateExpression, Expression, GraphPattern, OrderExpression};
use spargebra::Query;

/// Version Oxigraph epinglee dans Cargo.toml (a garder synchronisee).
pub const OXIGRAPH_PIN: &str = "0.4.11";

pub(crate) fn failure(code: &str, message: String) -> Error {
    Error::from_reason(format!("{code}: {message}"))
}

fn panic_detail(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct StoreOptions {
    pub max_loaded_builds: usize,
    pub max_quads_per_build: usize,
    pub max_quad_bytes: usize,
}

impl Default for StoreOptions {
    fn default() -> Self {
        Self {
            max_loaded_builds: 4,
            max_quads_per_build: 5_000_000,
            max_quad_bytes: 268_435_456,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryLimits {
    pub max_results: usize,
    pub max_bytes: usize,
    pub timeout_ms: u64,
}

struct Inner {
    stores: HashMap<String, Store>,
    closed: bool,
    poisoned: bool,
    options: StoreOptions,
}

impl Inner {
    fn live(&self) -> Result<()> {
        if self.closed {
            Err(failure("INDEX_CLOSED", "semantic index is closed".into()))
        } else if self.poisoned {
            Err(failure(
                "INDEX_POISONED",
                "semantic index was poisoned by a panic; recreate it".into(),
            ))
        } else {
            Ok(())
        }
    }
}

#[napi(object)]
pub struct LoadReportDto {
    pub quad_count: u32,
    pub bytes: u32,
}

#[napi]
pub struct SemanticIndexStore {
    inner: Mutex<Inner>,
}

impl SemanticIndexStore {
    /// Execute `operation` under the lock with panic capture; a panic
    /// poisons the store exactly like the Toolkit bridge sessions.
    fn guard<T>(&self, operation: impl FnOnce(&mut Inner) -> Result<T>) -> Result<T> {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let mut inner = match self.inner.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            inner.live()?;
            operation(&mut inner)
        }));
        match outcome {
            Ok(result) => result,
            Err(payload) => {
                let mut inner = self
                    .inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                inner.poisoned = true;
                drop(inner);
                Err(failure(
                    "NATIVE_PANIC",
                    format!(
                        "panic caught at N-API boundary: {}",
                        panic_detail(&*payload)
                    ),
                ))
            }
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn as_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

// ---- Admission: l'AST decide, pas le texte ----

/// Refuse tout dataset explicite (`FROM` / `FROM NAMED`) : le store par
/// build est le seul dataset. Le pre-filtre TS rejette deja le mot-cle ;
/// ce controle est la couche autoritative. spargebra 0.3.5 place le type
/// dans `algebra` et `Query::dataset()` retourne `None` quand aucune
/// clause dataset n'a ete ecrite : la seule presence d'un dataset est un
/// choix du client.
fn dataset_chosen(parsed: &Query) -> bool {
    parsed.dataset().is_some()
}

/// Un `SERVICE` peut se cacher dans une expression (`EXISTS { SERVICE
/// ... }` derriere FILTER/BIND/HAVING/ORDER BY/agregat) : le parcours des
/// motifs seul ne suffit pas.
fn expression_has_service(expression: &Expression) -> bool {
    match expression {
        Expression::Exists(pattern) => pattern_has_service(pattern),
        Expression::Or(left, right)
        | Expression::And(left, right)
        | Expression::Equal(left, right)
        | Expression::SameTerm(left, right)
        | Expression::Greater(left, right)
        | Expression::GreaterOrEqual(left, right)
        | Expression::Less(left, right)
        | Expression::LessOrEqual(left, right)
        | Expression::Add(left, right)
        | Expression::Subtract(left, right)
        | Expression::Multiply(left, right)
        | Expression::Divide(left, right) => {
            expression_has_service(left) || expression_has_service(right)
        }
        Expression::In(first, rest) => {
            expression_has_service(first) || rest.iter().any(expression_has_service)
        }
        Expression::UnaryPlus(inner) | Expression::UnaryMinus(inner) | Expression::Not(inner) => {
            expression_has_service(inner)
        }
        Expression::If(condition, then, otherwise) => {
            expression_has_service(condition)
                || expression_has_service(then)
                || expression_has_service(otherwise)
        }
        Expression::Coalesce(expressions) | Expression::FunctionCall(_, expressions) => {
            expressions.iter().any(expression_has_service)
        }
        Expression::NamedNode(_)
        | Expression::Literal(_)
        | Expression::Variable(_)
        | Expression::Bound(_) => false,
    }
}

fn pattern_has_service(pattern: &GraphPattern) -> bool {
    match pattern {
        GraphPattern::Service { .. } => true,
        GraphPattern::Join { left, right }
        | GraphPattern::Union { left, right }
        | GraphPattern::Minus { left, right }
        | GraphPattern::Lateral { left, right } => {
            pattern_has_service(left) || pattern_has_service(right)
        }
        GraphPattern::LeftJoin {
            left,
            right,
            expression,
        } => {
            pattern_has_service(left)
                || pattern_has_service(right)
                || expression.as_ref().is_some_and(expression_has_service)
        }
        GraphPattern::Filter { expr, inner } => {
            expression_has_service(expr) || pattern_has_service(inner)
        }
        GraphPattern::Extend {
            inner, expression, ..
        } => pattern_has_service(inner) || expression_has_service(expression),
        GraphPattern::OrderBy { inner, expression } => {
            pattern_has_service(inner)
                || expression.iter().any(|ordering| match ordering {
                    OrderExpression::Asc(inner) | OrderExpression::Desc(inner) => {
                        expression_has_service(inner)
                    }
                })
        }
        GraphPattern::Group {
            inner, aggregates, ..
        } => {
            pattern_has_service(inner)
                || aggregates.iter().any(|(_, aggregate)| match aggregate {
                    AggregateExpression::CountSolutions { .. } => false,
                    AggregateExpression::FunctionCall { expr, .. } => expression_has_service(expr),
                })
        }
        GraphPattern::Graph { inner, .. }
        | GraphPattern::Project { inner, .. }
        | GraphPattern::Distinct { inner, .. }
        | GraphPattern::Reduced { inner, .. }
        | GraphPattern::Slice { inner, .. } => pattern_has_service(inner),
        GraphPattern::Bgp { .. } | GraphPattern::Path { .. } | GraphPattern::Values { .. } => false,
    }
}

/// Parse et admet uniquement SELECT/ASK/CONSTRUCT/DESCRIBE sans SERVICE
/// ni dataset client. Les updates ne parsent meme pas comme `Query`
/// (spargebra 0.3.5 : `Query::parse`, aucun `SparqlParser`). La requete
/// parsee admise est retournee pour etre executee telle quelle : aucun
/// re-parse du texte apres admission.
fn admit_query(sparql: &str) -> Result<Query> {
    let parsed = Query::parse(sparql, None)
        .map_err(|error| failure("QUERY_REFUSED", format!("SPARQL parse refused: {error}")))?;
    let pattern: &GraphPattern = match &parsed {
        Query::Select { pattern, .. }
        | Query::Ask { pattern, .. }
        | Query::Construct { pattern, .. }
        | Query::Describe { pattern, .. } => pattern,
    };
    if dataset_chosen(&parsed) {
        return Err(failure(
            "QUERY_REFUSED",
            "client-chosen dataset (FROM/FROM NAMED) is refused".into(),
        ));
    }
    if pattern_has_service(pattern) {
        return Err(failure(
            "QUERY_REFUSED",
            "SERVICE patterns are refused (no federation, no network)".into(),
        ));
    }
    Ok(parsed)
}

// ---- Serialisation DTO (meme forme que SemanticQueryResult cote TS) ----

fn literal_dto(literal: &Literal) -> Value {
    let mut dto = json!({
        "kind": "literal",
        "value": literal.value(),
        "datatype": literal.datatype().as_str(),
    });
    if let Some(language) = literal.language() {
        dto["language"] = json!(language);
    }
    dto
}

fn term_dto(term: &Term) -> Result<Value> {
    Ok(match term {
        Term::NamedNode(node) => json!({"kind": "iri", "value": node.as_str()}),
        Term::BlankNode(node) => json!({"kind": "blank", "value": node.as_str()}),
        Term::Literal(literal) => literal_dto(literal),
        Term::Triple(_) => {
            return Err(failure(
                "OXIGRAPH_ERROR",
                "quoted triple terms are outside the ASE projection".into(),
            ))
        }
    })
}

/// oxrdf 0.2.4 : le sujet d'un `Triple` est un `Subject` (distinct de
/// `NamedOrBlankNode`, variante triple cite en plus sous `rdf-star`).
fn subject_dto(subject: &Subject) -> Result<Value> {
    Ok(match subject {
        Subject::NamedNode(node) => json!({"kind": "iri", "value": node.as_str()}),
        Subject::BlankNode(node) => json!({"kind": "blank", "value": node.as_str()}),
        Subject::Triple(_) => {
            return Err(failure(
                "OXIGRAPH_ERROR",
                "quoted triple subjects are outside the ASE projection".into(),
            ))
        }
    })
}

fn triple_dto(triple: &Triple) -> Result<Value> {
    Ok(json!({
        "subject": subject_dto(&triple.subject)?,
        "predicate": triple.predicate.as_str(),
        "object": term_dto(&triple.object)?,
    }))
}

struct Budget {
    started: Instant,
    limits: QueryLimits,
    bytes: usize,
    seen: usize,
}

impl Budget {
    /// `Ok(false)` = quota atteint, tronquer proprement.
    fn admit_row(&mut self, row_bytes: usize) -> Result<bool> {
        if self.started.elapsed().as_millis() > u128::from(self.limits.timeout_ms) {
            return Err(failure(
                "TIMEOUT",
                format!("query exceeded {}ms", self.limits.timeout_ms),
            ));
        }
        if self.seen >= self.limits.max_results {
            return Ok(false);
        }
        // The empty result envelope is reserved before iteration; commas
        // between rows are part of the result byte quota too.
        let row_bytes = row_bytes.saturating_add(usize::from(self.seen > 0));
        if self.bytes.saturating_add(row_bytes) > self.limits.max_bytes {
            return Ok(false);
        }
        self.bytes += row_bytes;
        self.seen += 1;
        Ok(true)
    }

    fn reserve_envelope(&mut self, envelope: &Value) -> Result<()> {
        self.bytes = serde_json::to_vec(envelope)
            .map_err(|error| failure("OXIGRAPH_ERROR", format!("serialization failed: {error}")))?
            .len();
        if self.bytes > self.limits.max_bytes {
            return Err(failure(
                "QUERY_LIMIT",
                "result metadata exceeds byte budget".into(),
            ));
        }
        Ok(())
    }

    fn check_deadline(&self) -> Result<()> {
        if self.started.elapsed().as_millis() > u128::from(self.limits.timeout_ms) {
            Err(failure(
                "TIMEOUT",
                format!("query exceeded {}ms", self.limits.timeout_ms),
            ))
        } else {
            Ok(())
        }
    }
}

fn run_query(store: &Store, sparql: &str, limits: QueryLimits) -> Result<String> {
    if sparql.is_empty() || sparql.len() > 65_536 {
        return Err(failure(
            "INVALID_INPUT",
            "query must contain 1–65536 bytes".into(),
        ));
    }
    if limits.max_results == 0
        || limits.max_results > 10_000
        || limits.max_bytes == 0
        || limits.max_bytes > 8_388_608
        || limits.timeout_ms == 0
        || limits.timeout_ms > 30_000
    {
        return Err(failure(
            "INVALID_INPUT",
            "query limits exceed supported bounds".into(),
        ));
    }
    // Le budget temps couvre parse + planification + iteration.
    let mut budget = Budget {
        started: Instant::now(),
        limits,
        bytes: 0,
        seen: 0,
    };
    let admitted = admit_query(sparql)?;
    budget.check_deadline()?;
    // Dataset epingle cote serveur : sans clause FROM, Oxigraph ne lirait
    // que le graphe par defaut (vide ici). Le store par build ne contient
    // que le graphe nomme du build, donc l'union de ses graphes est
    // exactement ce graphe ; les motifs GRAPH continuent de le voir comme
    // graphe nomme. Aucun dataset client n'arrive jusqu'ici (admission).
    let mut query = OxigraphQuery::from(admitted);
    query.dataset_mut().set_default_graph_as_union();
    let results = store
        .query(query)
        .map_err(|error| failure("OXIGRAPH_ERROR", format!("query failed: {error}")))?;
    budget.check_deadline()?;
    let payload = match results {
        QueryResults::Boolean(value) => {
            let value = json!({"form": "boolean", "value": value});
            budget.reserve_envelope(&value)?;
            value
        }
        QueryResults::Solutions(solutions) => {
            let variables: Vec<String> = solutions
                .variables()
                .iter()
                .map(|variable| variable.as_str().to_string())
                .collect();
            // `false` is one byte longer than `true`, so this reserves
            // enough metadata even when we later mark a result truncated.
            budget.reserve_envelope(&json!({
                "form": "solutions", "variables": variables,
                "rows": [], "truncated": false,
            }))?;
            let mut rows: Vec<Value> = Vec::new();
            let mut truncated = false;
            for (index, solution) in solutions.enumerate() {
                if index % 256 == 0 {
                    budget.check_deadline()?;
                }
                let solution = solution.map_err(|error| {
                    failure("OXIGRAPH_ERROR", format!("result failed: {error}"))
                })?;
                let mut row = serde_json::Map::new();
                for variable in &variables {
                    if let Some(term) = solution.get(variable.as_str()) {
                        row.insert(variable.clone(), term_dto(term)?);
                    }
                }
                let row_value = Value::Object(row);
                let row_bytes = serde_json::to_vec(&row_value)
                    .map_err(|error| {
                        failure("OXIGRAPH_ERROR", format!("serialization failed: {error}"))
                    })?
                    .len();
                if !budget.admit_row(row_bytes)? {
                    truncated = true;
                    break;
                }
                rows.push(row_value);
            }
            json!({
                "form": "solutions",
                "variables": variables,
                "rows": rows,
                "truncated": truncated,
            })
        }
        QueryResults::Graph(triples) => {
            budget.reserve_envelope(&json!({
                "form": "graph", "quads": [], "truncated": false,
            }))?;
            let mut quads: Vec<Value> = Vec::new();
            let mut truncated = false;
            for (index, triple) in triples.enumerate() {
                if index % 256 == 0 {
                    budget.check_deadline()?;
                }
                let triple = triple.map_err(|error| {
                    failure("OXIGRAPH_ERROR", format!("result failed: {error}"))
                })?;
                let dto = triple_dto(&triple)?;
                let row_bytes = serde_json::to_vec(&dto)
                    .map_err(|error| {
                        failure("OXIGRAPH_ERROR", format!("serialization failed: {error}"))
                    })?
                    .len();
                if !budget.admit_row(row_bytes)? {
                    truncated = true;
                    break;
                }
                quads.push(dto);
            }
            json!({"form": "graph", "quads": quads, "truncated": truncated})
        }
    };
    budget.check_deadline()?;
    let encoded = serde_json::to_string(&payload)
        .map_err(|error| failure("OXIGRAPH_ERROR", format!("serialization failed: {error}")))?;
    // Defense against changes to DTO metadata or serialization accounting.
    if encoded.len() > budget.limits.max_bytes {
        return Err(failure(
            "QUERY_LIMIT",
            "serialized result exceeds byte budget".into(),
        ));
    }
    budget.check_deadline()?;
    Ok(encoded)
}

// ---- Chargement: parse integral, verification, puis remplacement ----

fn load_into_new_store(
    options: &StoreOptions,
    graph_iri: &str,
    nquads: &[u8],
    expected_digest: &str,
) -> Result<(Store, usize)> {
    if nquads.len() > options.max_quad_bytes {
        return Err(failure(
            "INVALID_INPUT",
            format!(
                "projection is {} bytes, limit is {}",
                nquads.len(),
                options.max_quad_bytes
            ),
        ));
    }
    let digest = sha256_hex(nquads);
    if digest != expected_digest {
        return Err(failure(
            "INTEGRITY",
            "projection bytes do not match their stated digest".into(),
        ));
    }
    let digest_segment = graph_iri.strip_prefix("urn:ase:build:").unwrap_or("");
    if digest_segment.len() != 64
        || !digest_segment
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(failure(
            "INVALID_INPUT",
            "expected canonical build graph IRI".into(),
        ));
    }
    let graph_node = NamedNode::new(graph_iri)
        .map_err(|error| failure("INVALID_INPUT", format!("bad graph IRI: {error}")))?;
    let expected_graph = GraphName::NamedNode(graph_node);
    // Parse complet avant tout etat visible : un echec laisse l'ancien
    // graphe intact.
    let parser = RdfParser::from_format(RdfFormat::NQuads);
    let mut quads: Vec<Quad> = Vec::new();
    for quad in parser.for_slice(nquads) {
        let quad = quad
            .map_err(|error| failure("INVALID_INPUT", format!("N-Quads parse failed: {error}")))?;
        if quad.graph_name != expected_graph {
            return Err(failure(
                "INTEGRITY",
                format!(
                    "quad graph {:?} does not match the announced build graph",
                    quad.graph_name
                ),
            ));
        }
        quads.push(quad);
        if quads.len() > options.max_quads_per_build {
            return Err(failure(
                "QUERY_LIMIT",
                format!("projection exceeds {} quads", options.max_quads_per_build),
            ));
        }
    }
    let store = Store::new()
        .map_err(|error| failure("OXIGRAPH_ERROR", format!("store open failed: {error}")))?;
    for quad in &quads {
        store
            .insert(quad)
            .map_err(|error| failure("OXIGRAPH_ERROR", format!("insert failed: {error}")))?;
    }
    Ok((store, quads.len()))
}

#[napi]
impl SemanticIndexStore {
    #[napi(constructor)]
    pub fn new(options_json: Option<String>) -> Result<Self> {
        let options = match options_json {
            None => StoreOptions::default(),
            Some(text) => serde_json::from_str::<StoreOptions>(&text)
                .map_err(|error| failure("INVALID_INPUT", format!("bad store options: {error}")))?,
        };
        if options.max_loaded_builds == 0
            || options.max_quads_per_build == 0
            || options.max_quad_bytes == 0
        {
            return Err(failure("INVALID_INPUT", "store quotas must be >= 1".into()));
        }
        Ok(Self {
            inner: Mutex::new(Inner {
                stores: HashMap::new(),
                closed: false,
                poisoned: false,
                options,
            }),
        })
    }

    #[napi(getter)]
    pub fn is_closed(&self) -> bool {
        self.inner.lock().map(|inner| inner.closed).unwrap_or(true)
    }

    /// Charge (ou recharge atomiquement) la projection d'un build.
    #[napi]
    pub fn load_build(
        &self,
        store_key: String,
        graph_iri: String,
        nquads: Buffer,
        expected_digest: String,
    ) -> Result<LoadReportDto> {
        let bytes: Vec<u8> = nquads.into();
        self.guard(|inner| {
            if store_key.is_empty() || store_key.len() > 4096 {
                return Err(failure("INVALID_INPUT", "invalid build store key".into()));
            }
            if !inner.stores.contains_key(&store_key)
                && inner.stores.len() >= inner.options.max_loaded_builds
            {
                return Err(failure(
                    "STORE_FULL",
                    format!(
                        "already {} builds loaded; release one first",
                        inner.stores.len()
                    ),
                ));
            }
            let byte_count = bytes.len();
            let (store, quad_count) =
                load_into_new_store(&inner.options, &graph_iri, &bytes, &expected_digest)?;
            inner.stores.insert(store_key, store);
            Ok(LoadReportDto {
                quad_count: as_u32(quad_count),
                bytes: as_u32(byte_count),
            })
        })
    }

    /// Requete lecture seule sur le dataset epingle du build. Retourne
    /// le JSON `SemanticQueryResult` du contrat TypeScript.
    #[napi]
    pub fn query_read_only(
        &self,
        store_key: String,
        sparql: String,
        limits_json: String,
    ) -> Result<String> {
        self.guard(|inner| {
            let limits: QueryLimits = serde_json::from_str(&limits_json)
                .map_err(|error| failure("INVALID_INPUT", format!("bad query limits: {error}")))?;
            if limits.max_results == 0 || limits.max_bytes == 0 || limits.timeout_ms == 0 {
                return Err(failure(
                    "INVALID_INPUT",
                    "query limits must all be >= 1".into(),
                ));
            }
            let store = inner.stores.get(&store_key).ok_or_else(|| {
                failure(
                    "GRAPH_NOT_FOUND",
                    "no projection loaded for this build".into(),
                )
            })?;
            run_query(store, &sparql, limits)
        })
    }

    #[napi]
    pub fn has_build(&self, store_key: String) -> Result<bool> {
        self.guard(|inner| Ok(inner.stores.contains_key(&store_key)))
    }

    #[napi]
    pub fn release_build(&self, store_key: String) -> Result<()> {
        self.guard(|inner| {
            inner.stores.remove(&store_key);
            Ok(())
        })
    }

    #[napi]
    pub fn loaded_builds(&self) -> Result<Vec<String>> {
        self.guard(|inner| {
            let mut keys: Vec<String> = inner.stores.keys().cloned().collect();
            keys.sort();
            Ok(keys)
        })
    }

    #[napi]
    pub fn close(&self) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.stores.clear();
        inner.closed = true;
    }

    #[napi]
    pub fn dispose(&self) {
        self.close();
    }
}

#[napi]
pub fn store_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn oxigraph_version() -> String {
    OXIGRAPH_PIN.to_string()
}

#[cfg(test)]
mod tests;
