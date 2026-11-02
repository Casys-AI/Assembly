//! Surfaces JSON texte miroirs du wrapper amont (`crates/sysmlv2-wasm`),
//! recalculées sur `sysmlv2-transform` / `sysmlv2-model` /
//! `sysmlv2-viz` / `sysmlv2-lsp` natifs.
//!
//! Chaque fonction retourne `Result<_, String>` où la chaîne est le
//! message exact du wrapper amont ; la couche N-API (`lib.rs`) y
//! préfixe son code stable (`TOOLKIT_ERROR`, `INVALID_INPUT`, …).
//! Aucune seconde interprétation SysML : seuls les assemblages JSON et
//! les résolutions de sélecteurs du wrapper sont repris ici.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sysmlv2_lsp::{library_uri, Encoding, Mapper};
use sysmlv2_model::eval::Value as EvalValue;
use sysmlv2_model::json::{ElementRef, ResolvedModel};
use sysmlv2_syntax::span::{LineIndex, Span};
use sysmlv2_transform::{CheckFinding, RefSite, Session, Severity};

use crate::values;

// ---- Sources `[{name, text}]` ----

/// `[{name, text}]` — the JSON shape sources cross the boundary in.
#[derive(Deserialize)]
struct SourceIn {
    name: String,
    text: String,
}

pub fn parse_sources_json(json: &str) -> Result<Vec<(String, String)>, String> {
    let sources: Vec<SourceIn> =
        serde_json::from_str(json).map_err(|e| format!("sources must be [{{name, text}}]: {e}"))?;
    // A unit's name is its identity everywhere downstream (findings,
    // splices, the lifted root namespace), so an empty one is refused
    // at the boundary, by position, instead of failing deep inside a
    // later emission.
    if let Some(i) = sources.iter().position(|s| s.name.is_empty()) {
        return Err(format!(
            "sources must be [{{name, text}}]: source {i} has an empty name"
        ));
    }
    Ok(sources.into_iter().map(|s| (s.name, s.text)).collect())
}

// ---- Findings `check` / `checkSyntax` ----

/// The findings array `check` and its session twin share.
pub fn check_findings_json(
    findings: Vec<CheckFinding>,
    indexes: &HashMap<&str, LineIndex>,
) -> String {
    let findings: Vec<serde_json::Value> = findings
        .into_iter()
        .map(|f| {
            let end = indexes
                .get(f.unit.as_str())
                .map(|li| li.line_col(f.span.end));
            let mut obj = json!({
                "severity": match f.severity {
                    Severity::Error => "error",
                    Severity::Warning => "warning",
                },
                "stage": f.stage.as_str(),
                "message": f.message,
                "unit": f.unit,
                "line": f.line,
                "col": f.col,
            });
            if let Some(end) = end {
                obj["endLine"] = json!(end.line);
                obj["endCol"] = json!(end.col);
            }
            obj
        })
        .collect();
    serde_json::Value::Array(findings).to_string()
}

// ---- Cibles d'édition et sélecteurs ----

/// Resolve an edit target: a `::`-qualified name, or
/// `@<interchange-id>` for elements without one (anonymous connectors,
/// unnamed actions). Library elements are rejected here — they are
/// read-only, and letting one through would reach for source text the
/// session does not hold.
pub fn resolve_edit_target_named(session: &mut Session, name: &str) -> Result<ElementRef, String> {
    let e = if let Some(id) = name.strip_prefix('@') {
        session
            .resolved()
            .element_by_id(id)
            .ok_or_else(|| format!("element not found: {name}"))?
    } else {
        session
            .resolved()
            .resolve_qualified(name)
            .ok_or_else(|| format!("element not found: {name}"))?
    };
    if session.resolved().is_library_element(e) {
        return Err(format!("{name} is a library element (read-only)"));
    }
    Ok(e)
}

/// An element selector: a `::`-qualified name, or `{elementId}` for
/// elements without a resolvable name.
#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
enum Selector {
    Name(String),
    Id {
        #[serde(rename = "elementId")]
        element_id: String,
    },
}

fn resolve_selector(r: &mut ResolvedModel, sel: &Selector) -> Option<ElementRef> {
    match sel {
        Selector::Name(name) => r.resolve_qualified(name),
        Selector::Id { element_id } => r.element_by_id(element_id),
    }
}

/// The JSON of a `{unit, start, end}` source extent.
pub fn extent_json((unit, span): (usize, Span)) -> serde_json::Value {
    json!({"unit": unit, "start": span.start, "end": span.end})
}

/// Where `e` is declared: its name's site, else its member extent.
pub fn declaration_site_of(session: &mut Session, e: ElementRef) -> Option<(usize, Span)> {
    let r = session.resolved();
    r.declaration_site(e).or_else(|| r.member_extent(e))
}

/// The source text of `e`'s bound value expression — the `<expr>` in
/// `= <expr>` — or `None` when the declaration carries no value part
/// (or the element has no user source).
pub fn value_source(session: &mut Session, e: ElementRef) -> Option<String> {
    let Some((_, expr)) = session.resolved().value_expr(e) else {
        return None;
    };
    let Some((unit, _)) = declaration_site_of(session, e) else {
        return None;
    };
    let src = session.source(unit)?;
    Some(src[expr.span.start as usize..expr.span.end as usize].to_string())
}

/// The full source text of the member declaration that created the
/// element (target = `::`-qualified name or `@<interchange-id>`).
/// Errors for library elements and elements without a recorded extent.
pub fn member_source(session: &mut Session, target: &str) -> Result<String, String> {
    let e = resolve_edit_target_named(session, target)?;
    let (unit, span) = session
        .resolved()
        .member_extent(e)
        .ok_or_else(|| format!("{target} has no recorded source extent"))?;
    let src = session
        .source(unit)
        .ok_or_else(|| format!("{target} is a library element (read-only)"))?;
    Ok(src[span.start as usize..span.end as usize].to_string())
}

// ---- Options de diagramme (`toGraph` / `toPlantuml`) ----

/// Diagram options as JSON, mirroring the Python `to_plantuml`
/// signature: `{element?, roots?, view?, horizontal?, showValues?,
/// showNotes?, showMetadata?, showInherited?, showLib?, showImported?,
/// lineStyle?, stdColor?, linkTemplate?}` — all optional, defaults
/// match Python. `roots` restricts an all-roots diagram to the named
/// top-level elements (ignored when `element` scopes to one subtree).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlantumlOpts {
    element: Option<String>,
    #[serde(default)]
    roots: Option<Vec<String>>,
    /// Summary emission for large scopes (`toGraph`, tree view; ignored
    /// by `toPlantuml`): containers outside `open` emit as one node
    /// with counts. See `SummaryIn`.
    #[serde(default)]
    summary: Option<SummaryIn>,
    #[serde(default = "default_view")]
    view: String,
    #[serde(default)]
    horizontal: bool,
    #[serde(default = "yes")]
    show_values: bool,
    #[serde(default = "yes")]
    show_notes: bool,
    #[serde(default = "yes")]
    show_metadata: bool,
    #[serde(default)]
    show_inherited: bool,
    #[serde(default)]
    show_lib: bool,
    #[serde(default)]
    show_imported: bool,
    line_style: Option<String>,
    #[serde(default)]
    std_color: bool,
    link_template: Option<String>,
}

/// `{open: [selector…], noteBudget, leafBudget, unbounded: [selector…],
/// fullWithin?}`: which containers emit their members, how many notes
/// draw as cards per cluster, how many members draw per open container,
/// and which open containers draw every member regardless (a selector
/// that does not resolve is ignored). `fullWithin` is a finite number:
/// when the summary's would-draw total is at most that, the reply is
/// the full graph instead, marked `full: true`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SummaryIn {
    #[serde(default)]
    open: Vec<Selector>,
    #[serde(default)]
    unbounded: Vec<Selector>,
    #[serde(default = "default_note_budget")]
    note_budget: usize,
    #[serde(default = "default_leaf_budget")]
    leaf_budget: usize,
    #[serde(default)]
    full_within: Option<f64>,
}

fn default_note_budget() -> usize {
    200
}

fn default_leaf_budget() -> usize {
    500
}

fn default_view() -> String {
    "tree".to_string()
}

fn yes() -> bool {
    true
}

/// The `view` and `lineStyle` vocabularies are the diagram crate's own,
/// parsed and spelled through it so this surface cannot drift.
fn parse_view(name: &str) -> Result<sysmlv2_viz::View, String> {
    name.parse()
        .map_err(|e: sysmlv2_viz::ParseOptionError| e.to_string())
}

/// A view's canonical spelling (its `--view` value without aliases).
fn view_name(view: sysmlv2_viz::View) -> &'static str {
    view.as_str()
}

/// An absent `lineStyle` is the emitter's default splines.
fn parse_line_style(name: Option<&str>) -> Result<sysmlv2_viz::LineStyle, String> {
    match name {
        None => Ok(sysmlv2_viz::LineStyle::Default),
        Some(s) => s
            .parse()
            .map_err(|e: sysmlv2_viz::ParseOptionError| e.to_string()),
    }
}

/// Resolve a diagram's `roots` selection (`::`-qualified top-level
/// names) to element handles for the emitter; `None`/empty leaves
/// the diagram at every top-level element.
fn resolve_roots(
    session: &mut Session,
    names: Option<&[String]>,
) -> Result<Option<Vec<ElementRef>>, String> {
    let Some(names) = names.filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    let mut refs = Vec::with_capacity(names.len());
    for name in names {
        let e = session
            .resolved()
            .resolve_qualified(name)
            .ok_or_else(|| format!("element not found: {name}"))?;
        refs.push(e);
    }
    Ok(Some(refs))
}

/// Parse a diagram options document (absent or empty = `{}`, so
/// serde's field defaults apply uniformly) and resolve its scope
/// against the current model — the one path both diagram emitters
/// take, so they accept the same options and read a name the same
/// way. A view usage named as `element` directs its own diagram; an
/// empty exposure comes back as `roots: Some([])`, never the whole
/// model.
#[allow(clippy::type_complexity)]
fn diagram_request(
    session: &mut Session,
    opts_json: Option<&str>,
) -> Result<
    (
        sysmlv2_viz::VizOptions,
        Option<ElementRef>,
        Option<SummaryIn>,
    ),
    String,
> {
    let opts: PlantumlOpts =
        serde_json::from_str(opts_json.filter(|s| !s.is_empty()).unwrap_or("{}"))
            .map_err(|e| format!("bad options: {e}"))?;
    let view = parse_view(&opts.view)?;
    let line_style = parse_line_style(opts.line_style.as_deref())?;
    let mut root = opts
        .element
        .as_deref()
        .map(|name| {
            session
                .resolved()
                .resolve_qualified(name)
                .ok_or_else(|| format!("element not found: {name}"))
        })
        .transpose()?;
    let mut roots = resolve_roots(session, opts.roots.as_deref())?;
    if let Some(e) = root {
        if let Some((_, exposed)) = sysmlv2_viz::view_directed(session.resolved(), e) {
            roots = Some(exposed);
            root = None;
        }
    }
    let viz = sysmlv2_viz::VizOptions::default()
        .with_direction(if opts.horizontal {
            sysmlv2_viz::Direction::LeftToRight
        } else {
            sysmlv2_viz::Direction::TopToBottom
        })
        .with_show_values(opts.show_values)
        .with_view(view)
        .with_show_notes(opts.show_notes)
        .with_show_metadata(opts.show_metadata)
        .with_show_inherited(opts.show_inherited)
        .with_show_lib(opts.show_lib)
        .with_show_imported(opts.show_imported)
        .with_line_style(line_style)
        .with_std_color(opts.std_color)
        .with_link_template(opts.link_template)
        .with_roots(roots);
    Ok((viz, root, opts.summary))
}

/// Emit a PlantUML diagram of the session's model (`toPlantuml` amont).
pub fn to_plantuml(session: &mut Session, opts_json: Option<&str>) -> Result<String, String> {
    let (viz, root, _) = diagram_request(session, opts_json)?;
    if viz.roots.as_ref().is_some_and(|r| r.is_empty()) {
        return Ok("@startuml\n' the view exposes nothing\n@enduml\n".to_string());
    }
    Ok(sysmlv2_viz::plantuml(session.resolved(), root, &viz))
}

/// Emit the structured diagram graph for a view (`toGraph` amont),
/// including its `summary` / `fullWithin` discipline.
pub fn to_graph(session: &mut Session, opts_json: Option<&str>) -> Result<String, String> {
    let (mut viz, mut root, summary_opts) = diagram_request(session, opts_json)?;
    let view = view_name(viz.view);
    if !matches!(
        viz.view,
        sysmlv2_viz::View::Tree
            | sysmlv2_viz::View::Interconnection
            | sysmlv2_viz::View::State
            | sysmlv2_viz::View::Action
    ) {
        return Err(format!("no structured-graph emitter for view: {view}"));
    }
    if summary_opts.is_some() && viz.view != sysmlv2_viz::View::Tree {
        return Err("summary emission is tree-only".to_string());
    }
    let full_within = summary_opts.as_ref().and_then(|sm| sm.full_within);
    if viz.roots.as_ref().is_some_and(|r| r.is_empty()) {
        let mut g = json!({ "view": view, "nodes": [], "edges": [] });
        if full_within.is_some_and(|n| 0.0 <= n) {
            // nothing to draw is within any budget
            g["full"] = json!(true);
        } else if summary_opts.is_some() {
            g["summary"] = json!({ "resolved": [], "unresolved": [] });
        }
        return Ok(g.to_string());
    }
    // Summary mode: resolve the open set, remembering what did not
    // resolve so the client can prune a persisted set.
    let mut summary = None;
    let mut resolved_open = Vec::new();
    let mut unresolved_open = Vec::new();
    if let Some(sm) = &summary_opts {
        let mut open = Vec::new();
        for sel in &sm.open {
            match resolve_selector(session.resolved(), sel) {
                Some(e) => {
                    let r = session.resolved();
                    resolved_open.push(json!({
                        "id": r.element_id(e).to_string(),
                        "qualifiedName": r.element_qualified_name(e),
                    }));
                    open.push(e);
                }
                None => unresolved_open
                    .push(serde_json::to_value(sel).unwrap_or(serde_json::Value::Null)),
            }
        }
        let unbounded = sm
            .unbounded
            .iter()
            .filter_map(|sel| resolve_selector(session.resolved(), sel))
            .collect();
        summary = Some(sysmlv2_viz::SummaryOptions {
            open,
            note_budget: sm.note_budget,
            leaf_budget: sm.leaf_budget,
            unbounded,
        });
    }
    viz.summary = summary;
    // The summary's total is counted without emitting it, so a scope
    // that fits emits only its full graph.
    let limit = full_within.filter(|n| 0.0 <= *n).map(|n| n as usize);
    let counted_fit = match limit {
        Some(limit) => {
            // The count and the emission after it start from the same
            // elements: look them up once.
            let tops = sysmlv2_viz::scope_roots(session.resolved(), root, &viz);
            viz.roots = Some(tops);
            root = None;
            sysmlv2_viz::summary_would_draw_within(session.resolved(), root, &viz, limit)
                .map_err(|e| e.to_string())?
                .is_some()
        }
        None => false,
    };
    if !counted_fit {
        let mut g =
            sysmlv2_viz::graph(session.resolved(), root, &viz).map_err(|e| e.to_string())?;
        // The summary's own total decides where a count that stopped
        // early could not: one that counted elements sharing an id.
        if !full_within.is_some_and(|n| sysmlv2_viz::summary_would_draw(&g) as f64 <= n) {
            if summary_opts.is_some() {
                g["summary"] = json!({ "resolved": resolved_open, "unresolved": unresolved_open });
            }
            return Ok(g.to_string());
        }
    }
    // The whole scope fits: emit it as the request without a summary
    // does — the options are that request's once the summary is gone.
    viz.summary = None;
    let mut full = sysmlv2_viz::graph(session.resolved(), root, &viz).map_err(|e| e.to_string())?;
    full["full"] = json!(true);
    Ok(full.to_string())
}

// ---- Outline / shape ----

/// Top-level user elements: the owned members of each unit's root
/// namespace, in declaration order.
pub fn root_refs(session: &mut Session) -> Vec<ElementRef> {
    let r = session.resolved();
    let all: Vec<ElementRef> = r.user_elements().collect();
    let mut tops = Vec::new();
    for e in all {
        if r.owner(e).is_none() && r.element_type(e) == "Namespace" {
            tops.extend(r.owned_members(e));
        }
    }
    tops
}

/// `Session::outline`'s budgets: `{outlineNodes?, outlineDepth?,
/// shapeNodes?, shapeDepth?}`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutlineIn {
    #[serde(default = "default_outline_nodes")]
    outline_nodes: usize,
    #[serde(default = "default_outline_depth")]
    outline_depth: usize,
    #[serde(default = "default_shape_nodes")]
    shape_nodes: usize,
    #[serde(default = "default_shape_depth")]
    shape_depth: usize,
}

fn default_outline_nodes() -> usize {
    4000
}

fn default_outline_depth() -> usize {
    24
}

fn default_shape_nodes() -> usize {
    20000
}

fn default_shape_depth() -> usize {
    64
}

/// One element of the outline tree.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutlineNodeOut {
    name: Option<String>,
    metaclass: &'static str,
    qualified_name: Option<String>,
    children: Vec<OutlineNodeOut>,
}

/// One named element of the shape: `owner` indexes the nearest named
/// ancestor recorded before it, `-1` when there is none.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShapeNodeOut {
    id: String,
    name: String,
    qualified_name: String,
    metaclass: &'static str,
    owner: i64,
}

/// The state of one `outline` walk.
struct OutlineWalk {
    opts: OutlineIn,
    /// Outline nodes still to hand out, claimed in visiting order.
    outline_left: usize,
    shape: Vec<ShapeNodeOut>,
    /// A budget cut the shape short.
    truncated: bool,
}

/// The name an outline shows: `derived(e, "name")` when that is a
/// string, else the declared name. Errors as `derived` does.
fn display_name(session: &mut Session, e: ElementRef) -> Result<Option<String>, String> {
    match values::derived_json(session, e, "name")? {
        serde_json::Value::String(name) => Ok(Some(name)),
        _ => Ok(session.resolved().element_name(e).map(str::to_string)),
    }
}

/// Visit `e` at `depth` under the shape node `owner`: its outline
/// node, or `None` once the outline budget is spent.
fn outline_visit(
    session: &mut Session,
    walk: &mut OutlineWalk,
    e: ElementRef,
    owner: i64,
    depth: usize,
) -> Result<Option<OutlineNodeOut>, String> {
    let name = display_name(session, e)?;
    let (qualified_name, metaclass, element_id, members) = {
        let r = session.resolved();
        (
            r.element_qualified_name(e),
            r.element_type(e),
            r.element_id(e).to_string(),
            r.owned_members(e),
        )
    };
    // Shape: named elements only. An anonymous one is still walked,
    // its named members re-parented onto its nearest named ancestor.
    let mut this = owner;
    if let (Some(n), Some(q)) = (&name, &qualified_name) {
        if !n.is_empty() && !q.is_empty() {
            if walk.shape.len() >= walk.opts.shape_nodes {
                walk.truncated = true;
            } else {
                this = i64::try_from(walk.shape.len()).unwrap_or(i64::MAX);
                walk.shape.push(ShapeNodeOut {
                    id: element_id,
                    name: n.clone(),
                    qualified_name: q.clone(),
                    metaclass,
                    owner,
                });
            }
        }
    }
    // The outline claims its slot before any member is visited.
    let in_outline = walk.outline_left > 0;
    walk.outline_left = walk.outline_left.saturating_sub(1);
    let mut children = Vec::new();
    if depth < walk.opts.shape_depth {
        for m in members {
            let child = outline_visit(session, walk, m, this, depth + 1)?;
            if let Some(child) = child.filter(|_| depth < walk.opts.outline_depth) {
                children.push(child);
            }
        }
    } else if !members.is_empty() {
        walk.truncated = true;
    }
    Ok(in_outline.then_some(OutlineNodeOut {
        name,
        metaclass,
        qualified_name,
        children,
    }))
}

/// The model's outline tree and its named-element shape from one walk,
/// as JSON `{outline: [node…], shape: {nodes: [node…], truncated}}`
/// (`Session.outline` amont). Errors as `derived` does, or on
/// malformed options.
pub fn outline(session: &mut Session, opts_json: Option<&str>) -> Result<String, String> {
    let opts: OutlineIn = serde_json::from_str(opts_json.filter(|s| !s.is_empty()).unwrap_or("{}"))
        .map_err(|e| format!("bad options: {e}"))?;
    let mut walk = OutlineWalk {
        outline_left: opts.outline_nodes,
        opts,
        shape: Vec::new(),
        truncated: false,
    };
    let mut outline = Vec::new();
    for e in root_refs(session) {
        if let Some(node) = outline_visit(session, &mut walk, e, -1, 0)? {
            outline.push(node);
        }
    }
    #[derive(Serialize)]
    struct Shape {
        nodes: Vec<ShapeNodeOut>,
        truncated: bool,
    }
    #[derive(Serialize)]
    struct Reply {
        outline: Vec<OutlineNodeOut>,
        shape: Shape,
    }
    serde_json::to_string(&Reply {
        outline,
        shape: Shape {
            nodes: walk.shape,
            truncated: walk.truncated,
        },
    })
    .map_err(|e| e.to_string())
}

// ---- `rows` (lectures par élément en lot) ----

/// A field of `rows`: one per-element read, by the name of the method
/// that answers it.
enum RowField {
    Name,
    ShortName,
    QualifiedName,
    ReferenceSpelling,
    Metaclass,
    Owner,
    IsLibraryElement,
    ValueSource,
    ValueIsDefault,
    Docs,
    DeclarationSite,
    MemberExtent,
    Property(String),
    Derived(String),
}

impl RowField {
    fn parse(field: &str) -> Result<RowField, String> {
        if let Some(name) = field.strip_prefix("property:") {
            return Ok(RowField::Property(name.to_string()));
        }
        if let Some(name) = field.strip_prefix("derived:") {
            return Ok(RowField::Derived(name.to_string()));
        }
        Ok(match field {
            "name" => RowField::Name,
            "shortName" => RowField::ShortName,
            "qualifiedName" => RowField::QualifiedName,
            "referenceSpelling" => RowField::ReferenceSpelling,
            "metaclass" => RowField::Metaclass,
            "owner" => RowField::Owner,
            "isLibraryElement" => RowField::IsLibraryElement,
            "valueSource" => RowField::ValueSource,
            "valueIsDefault" => RowField::ValueIsDefault,
            "docs" => RowField::Docs,
            "declarationSite" => RowField::DeclarationSite,
            "memberExtent" => RowField::MemberExtent,
            _ => return Err(format!("unknown row field: {field}")),
        })
    }
}

/// Every element's documentation bodies, by element: one pass over
/// the model's annotations.
fn docs_by_target(session: &mut Session) -> HashMap<ElementRef, Vec<String>> {
    let mut by_target: HashMap<ElementRef, Vec<String>> = HashMap::new();
    for (target, body) in session.resolved().annotation_bodies() {
        let text = sysmlv2_model::json::doc_display_text(&body);
        if !text.is_empty() {
            by_target.entry(target).or_default().push(text);
        }
    }
    by_target
}

/// One `rows` field of `e`, as the per-element read answers it.
fn row_field(
    session: &mut Session,
    e: ElementRef,
    field: &RowField,
    docs: &mut Option<HashMap<ElementRef, Vec<String>>>,
) -> Result<serde_json::Value, String> {
    Ok(match field {
        RowField::Name => json!(session.resolved().element_name(e).map(str::to_string)),
        RowField::ShortName => {
            json!(session
                .resolved()
                .element_declared_short_name(e)
                .map(str::to_string))
        }
        RowField::QualifiedName => json!(session.resolved().element_qualified_name(e)),
        RowField::ReferenceSpelling => {
            json!(session.resolved().element_reference_spelling(e))
        }
        RowField::Metaclass => json!(session.resolved().element_type(e).to_string()),
        RowField::Owner => {
            let r = session.resolved();
            json!(r.owner(e).map(|o| r.element_id(o).to_string()))
        }
        RowField::IsLibraryElement => json!(session.resolved().is_library_element(e)),
        RowField::ValueSource => json!(value_source(session, e)),
        RowField::ValueIsDefault => json!(session.resolved().value_is_default(e)),
        RowField::Docs => {
            let by_target = docs.get_or_insert_with(|| docs_by_target(session));
            json!(by_target.get(&e).map_or(&[][..], Vec::as_slice))
        }
        RowField::DeclarationSite => {
            declaration_site_of(session, e).map_or(serde_json::Value::Null, extent_json)
        }
        RowField::MemberExtent => session
            .resolved()
            .member_extent(e)
            .map_or(serde_json::Value::Null, extent_json),
        RowField::Property(name) => session
            .resolved()
            .property(e, name)
            .map_err(|e| e.to_string())?,
        RowField::Derived(name) => values::derived_json(session, e, name)?,
    })
}

/// Per-element reads for many elements in one call, as JSON
/// (`Session.rows` amont). A read that errors leaves its field out
/// and puts its message under `errors: {field: message}` instead.
pub fn rows(session: &mut Session, ids_json: &str, fields_json: &str) -> Result<String, String> {
    let ids: Vec<String> = serde_json::from_str(ids_json).map_err(|e| format!("bad ids: {e}"))?;
    let names: Vec<String> =
        serde_json::from_str(fields_json).map_err(|e| format!("bad fields: {e}"))?;
    let fields = names
        .iter()
        .map(|name| RowField::parse(name))
        .collect::<Result<Vec<_>, _>>()?;
    let mut docs = None;
    let mut out = Vec::with_capacity(ids.len());
    for id in &ids {
        let Some(e) = session.resolved().element_by_id(id) else {
            out.push(serde_json::Value::Null);
            continue;
        };
        let mut row = serde_json::Map::new();
        let mut errors = serde_json::Map::new();
        for (name, field) in names.iter().zip(&fields) {
            match row_field(session, e, field, &mut docs) {
                Ok(value) => row.insert(name.clone(), value),
                Err(message) => errors.insert(name.clone(), message.into()),
            };
        }
        if !errors.is_empty() {
            row.insert("errors".to_string(), errors.into());
        }
        out.push(row.into());
    }
    Ok(serde_json::Value::Array(out).to_string())
}

// ---- `viewInfo` ----

/// One metadata usage as `viewInfo` reports it: its (first) type and
/// the evaluated values of the features its body declares.
struct MetadataValues {
    ty: Option<String>,
    values: Vec<(String, EvalValue)>,
}

/// Describe a `view` usage for tabular consumers (`viewInfo` amont) :
/// JSON `{qualifiedName, id, rendering, exposed: [{id, qualifiedName,
/// metaclass}], views: [{name, qualifiedName, id}], metadata: [{type,
/// values}]}` ; errors when the name does not resolve to a view usage.
pub fn view_info(session: &mut Session, qualified_name: &str) -> Result<String, String> {
    let view = session
        .resolved()
        .resolve_qualified(qualified_name)
        .ok_or_else(|| format!("element not found: {qualified_name}"))?;
    if session.resolved().element_type(view) != "ViewUsage" {
        return Err(format!("{qualified_name} is not a view usage"));
    }
    let (qualified, id, rendering, exposed, views, metadata) = {
        let r = session.resolved();
        // The canonical spelling, not the caller's: a request may quote
        // names the model spells bare (`P::'Verified'` vs `P::Verified`).
        let qualified = r.element_qualified_name(view);
        let id = r.element_id(view).to_string();
        let rendering = r.view_rendering(view);
        let exposed: Vec<serde_json::Value> = r
            .view_exposed_elements(view)
            .into_iter()
            .map(|e| {
                json!({
                    "id": r.element_id(e).to_string(),
                    "qualifiedName": r.element_qualified_name(e),
                    "metaclass": r.element_type(e),
                })
            })
            .collect();
        let owned: Vec<ElementRef> = r
            .owned_members(view)
            .into_iter()
            .filter(|&m| r.element_type(m) == "ViewUsage")
            .collect();
        let mut views = Vec::with_capacity(owned.len());
        for m in owned {
            let name = r.element_name(m).map(str::to_string);
            views.push(json!({
                "name": name,
                "qualifiedName": r.element_qualified_name(m),
                "id": r.element_id(m).to_string(),
            }));
        }
        // Each metadata usage: its (first) type and the evaluated
        // values of the features its body declares; unevaluable
        // values are omitted rather than failing the whole report.
        let mut metadata: Vec<MetadataValues> = Vec::new();
        for m in r.metadata_of(view) {
            let ty = r
                .typings(m)
                .first()
                .and_then(|&t| r.element_qualified_name(t));
            let mut values = Vec::new();
            for f in r.owned_members(m) {
                let Some(name) = r.element_name(f).map(str::to_string) else {
                    continue;
                };
                if let Ok(v) = r.evaluate(f) {
                    values.push((name, v));
                }
            }
            metadata.push(MetadataValues { ty, values });
        }
        (qualified, id, rendering, exposed, views, metadata)
    };
    let metadata: Vec<serde_json::Value> = metadata
        .into_iter()
        .map(|MetadataValues { ty, values }| {
            let mut obj = serde_json::Map::new();
            for (name, v) in &values {
                obj.insert(name.clone(), values::value_to_json(session, v));
            }
            json!({ "type": ty, "values": serde_json::Value::Object(obj) })
        })
        .collect();
    Ok(json!({
        "qualifiedName": qualified,
        "id": id,
        "rendering": rendering,
        "exposed": exposed,
        "views": views,
        "metadata": metadata,
    })
    .to_string())
}

// ---- `references` (positions UTF-16) ----

/// Required nullable field: unlike Option<String>, missing is not null.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub(crate) enum ReferenceChainRoot {
    Id(String),
    None(()),
}

/// A locator revalidated against the native model, never a splice instruction.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReferenceSiteFingerprint {
    unit: String,
    line: u32,
    col: u32,
    end_line: u32,
    end_col: u32,
    kind: String,
    owner_id: String,
    chain_root_id: ReferenceChainRoot,
    preimage: String,
}

fn bounded_reference_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.contains('\0')
}

impl ReferenceSiteFingerprint {
    fn validate(&self) -> Result<(), String> {
        let positions = [self.line, self.col, self.end_line, self.end_col];
        if !bounded_reference_text(&self.unit, 4096)
            || !bounded_reference_text(&self.kind, 128)
            || !bounded_reference_text(&self.owner_id, 128)
            || !bounded_reference_text(&self.preimage, 65_536)
            || matches!(&self.chain_root_id, ReferenceChainRoot::Id(id)
                if !bounded_reference_text(id, 128))
            || positions
                .iter()
                .any(|value| *value == 0 || *value > i32::MAX as u32)
            || (self.end_line, self.end_col) <= (self.line, self.col)
        {
            return Err("invalid or oversized reference site fingerprint".into());
        }
        Ok(())
    }
}

fn reference_site_fingerprint<'a>(
    session: &'a Session,
    site: &RefSite,
    mappers: &mut HashMap<usize, Option<(String, Mapper<'a>)>>,
) -> Option<ReferenceSiteFingerprint> {
    // Only owned user units may be edited; a library reference target is fine.
    let source = session.source(site.unit)?;
    let preimage = source.get(site.span.start as usize..site.span.end as usize)?;
    let location = unit_location(session, mappers, site.unit, site.span)?;
    let resolved = session.resolved_ref();
    let fingerprint = ReferenceSiteFingerprint {
        unit: location["unit"].as_str()?.into(),
        line: u32::try_from(location["line"].as_u64()?).ok()?,
        col: u32::try_from(location["col"].as_u64()?).ok()?,
        end_line: u32::try_from(location["endLine"].as_u64()?).ok()?,
        end_col: u32::try_from(location["endCol"].as_u64()?).ok()?,
        kind: site.kind.clone(),
        owner_id: resolved.element_id(site.owner).to_string(),
        chain_root_id: site
            .chain_root
            .map(|root| ReferenceChainRoot::Id(resolved.element_id(root).to_string()))
            .unwrap_or(ReferenceChainRoot::None(())),
        preimage: preimage.into(),
    };
    fingerprint.validate().ok()?;
    Some(fingerprint)
}

fn unique_reference_site(mut matches: Vec<RefSite>) -> Result<RefSite, String> {
    if matches.len() != 1 {
        return Err("reference site is stale, foreign, missing or ambiguous".into());
    }
    Ok(matches.pop().expect("exactly one reference site"))
}

#[cfg(test)]
#[test]
fn retarget_reference_rejects_ambiguous_native_site_candidates() {
    let mut session = Session::from_sources(vec![(
        "ambiguity.sysml".into(),
        "package Ambiguity { part def Shape; part specimen : Shape; }".into(),
    )])
    .unwrap();
    let shape = session
        .resolved()
        .resolve_qualified("Ambiguity::Shape")
        .unwrap();
    let sites = session.resolved_ref().references_to(shape);
    assert_eq!(sites.len(), 1);
    assert!(unique_reference_site(Vec::new()).is_err());
    assert!(unique_reference_site(vec![sites[0].clone(), sites[0].clone()]).is_err());
    assert!(unique_reference_site(sites).is_ok());
}

fn resolve_retarget_reference(
    session: &mut Session,
    from_id: &str,
    to_id: &str,
    fingerprint: &ReferenceSiteFingerprint,
) -> Result<(RefSite, ElementRef), String> {
    fingerprint.validate()?;
    if !bounded_reference_text(from_id, 128) || !bounded_reference_text(to_id, 128) {
        return Err("invalid reference target identity".into());
    }
    let from = session
        .resolved()
        .element_by_id(from_id)
        .ok_or_else(|| "old reference target is absent".to_string())?;
    let to = session
        .resolved()
        .element_by_id(to_id)
        .ok_or_else(|| "new reference target is absent".to_string())?;
    let mut mappers = HashMap::new();
    let matches = session
        .resolved_ref()
        .references_to(from)
        .into_iter()
        .filter(|site| {
            reference_site_fingerprint(session, site, &mut mappers).as_ref() == Some(fingerprint)
        })
        .collect();
    Ok((unique_reference_site(matches)?, to))
}

/// Where `span` of `unit` lies, positioned as an editor positions it:
/// JSON `{unit, line, col, endLine, endCol}` — the unit's name, 1-based
/// lines, and columns counted in UTF-16 code units — which is the
/// language server's location for the same span, one-based. A unit of
/// an in-memory library is named as the server names it, under the
/// `sysmlv2-lib:/` scheme. `mappers` memoizes a unit's line table
/// across the sites of one answer. A unit whose text the session does
/// not hold has no position.
fn unit_location<'a>(
    session: &'a Session,
    mappers: &mut HashMap<usize, Option<(String, Mapper<'a>)>>,
    unit: usize,
    span: Span,
) -> Option<serde_json::Value> {
    let (name, mapper) = mappers
        .entry(unit)
        .or_insert_with(|| {
            let (name, text) = session
                .units()
                .find(|(i, _, _)| *i == unit)
                .map(|(_, name, text)| (name.to_string(), text))
                .or_else(|| {
                    session
                        .library_unit(unit)
                        .map(|(name, text)| (library_uri(name), text))
                })?;
            Some((name, Mapper::new(text, Encoding::Utf16)))
        })
        .as_ref()?;
    let range = mapper.range(span);
    Some(json!({
        "unit": name,
        "line": range.start.line + 1,
        "col": range.start.character + 1,
        "endLine": range.end.line + 1,
        "endCol": range.end.character + 1,
    }))
}

/// Find usages (`references` amont) : JSON `{declaration: {unit, line,
/// col, endLine, endCol, site} | null, references: [{unit, line, col,
/// endLine, endCol, kind, owner}]}` — positions 1-based, colonnes en
/// unités UTF-16. The selector is a qualified name or `{elementId}`.
pub fn references(session: &mut Session, selector_json: &str) -> Result<String, String> {
    // A bare name is as good as its JSON string form.
    let sel: Selector = serde_json::from_str(selector_json)
        .unwrap_or_else(|_| Selector::Name(selector_json.to_string()));
    let e = resolve_selector(session.resolved(), &sel)
        .ok_or_else(|| format!("element not found: {selector_json}"))?;
    let (declaration, sites) = {
        let resolved = session.resolved_ref();
        let declaration = resolved
            .declaration_site(e)
            .map(|site| (site, "name"))
            .or_else(|| resolved.member_extent(e).map(|site| (site, "extent")));
        let sites = resolved.references_to(e);
        (declaration, sites)
    };
    // Each site is written on a relationship or an expression, which
    // has no name of its own; the element named for it is the first
    // one above that has a qualified name.
    let owners: Vec<serde_json::Value> = sites
        .iter()
        .map(|site| {
            let r = session.resolved();
            let mut cur = Some(site.owner);
            while let Some(o) = cur {
                if let Some(qualified_name) = r.element_qualified_name(o) {
                    return json!({
                        "id": r.element_id(o).to_string(),
                        "qualifiedName": qualified_name,
                    });
                }
                cur = r.owner(o);
            }
            serde_json::Value::Null
        })
        .collect();
    let mut mappers = HashMap::new();
    let declaration = declaration.and_then(|((unit, span), site)| {
        let mut location = unit_location(session, &mut mappers, unit, span)?;
        location["site"] = json!(site);
        Some(location)
    });
    let references: Vec<serde_json::Value> = sites
        .iter()
        .zip(owners)
        .filter_map(|(site, owner)| {
            let mut location = unit_location(session, &mut mappers, site.unit, site.name_span)?;
            location["kind"] = json!(site.kind);
            location["owner"] = owner;
            location["siteFingerprint"] =
                json!(reference_site_fingerprint(session, site, &mut mappers));
            Some(location)
        })
        .collect();
    let reference_sites_omitted = sites.len() - references.len();
    Ok(json!({
        "referenceSiteFormat": "assembly-native-reference-site/v1",
        "referenceSitesOmitted": reference_sites_omitted,
        "declaration": declaration,
        "references": references,
    })
    .to_string())
}

// ---- Batchs d'édition JSON (`edit` / `checkEdit`) ----

/// One edit-batch operation as JSON (the `edit` method takes an
/// array) — vocabulaire amont exact, champs inconnus refusés.
#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub(crate) enum EditOpIn {
    #[serde(rename = "rename", rename_all = "camelCase")]
    Rename { target: String, new_name: String },
    #[serde(rename = "setFeatureValue")]
    SetFeatureValue { target: String, expr: String },
    #[serde(rename = "setFeatureType")]
    SetFeatureType {
        target: String,
        #[serde(rename = "type")]
        ty: String,
    },
    #[serde(rename = "retargetReference", rename_all = "camelCase")]
    RetargetReference {
        from_id: String,
        to_id: String,
        site: ReferenceSiteFingerprint,
    },
    #[serde(rename = "setRedefinedFeature")]
    SetRedefinedFeature { target: String, feature: String },
    #[serde(rename = "removeFeatureValue")]
    RemoveFeatureValue { target: String },
    #[serde(rename = "setCommentBody")]
    SetCommentBody { target: String, body: String },
    #[serde(rename = "insertMember")]
    InsertMember { owner: String, text: String },
    #[serde(rename = "insertTopLevel")]
    InsertTopLevel { unit: String, text: String },
    #[serde(rename = "addUnit")]
    AddUnit { unit: String },
    #[serde(rename = "remove")]
    Remove { target: String },
    #[serde(rename = "replaceMember")]
    ReplaceMember { target: String, text: String },
    #[serde(rename = "moveMember", rename_all = "camelCase")]
    MoveMember {
        target: String,
        #[serde(default)]
        new_owner: Option<String>,
        #[serde(default)]
        index: Option<u32>,
    },
}

/// [`EditOpIn`] with element references resolved against the current
/// session state.
pub(crate) enum ResolvedOp {
    Rename(ElementRef, String),
    SetFeatureValue(ElementRef, String),
    SetFeatureType(ElementRef, String),
    RetargetReference(RefSite, ElementRef),
    SetRedefinedFeature(ElementRef, String),
    RemoveFeatureValue(ElementRef),
    SetCommentBody(ElementRef, String),
    InsertMember(ElementRef, String),
    InsertTopLevel(String, String),
    AddUnit(String),
    Remove(ElementRef),
    ReplaceMember(ElementRef, String),
    MoveMember(ElementRef, ElementRef, Option<usize>),
}

pub fn parse_ops(ops_json: &str) -> Result<Vec<EditOpIn>, String> {
    let ops: Vec<EditOpIn> =
        serde_json::from_str(ops_json).map_err(|e| format!("bad edit ops: {e}"))?;
    if ops.is_empty() {
        return Err("empty edit batch".to_string());
    }
    Ok(ops)
}

/// Resolve every element reference against the current state, so a
/// bad reference fails before any planning starts.
pub fn resolve_ops(session: &mut Session, ops: Vec<EditOpIn>) -> Result<Vec<ResolvedOp>, String> {
    let mut resolved = Vec::with_capacity(ops.len());
    for op in ops {
        resolved.push(match op {
            EditOpIn::Rename { target, new_name } => {
                ResolvedOp::Rename(resolve_edit_target_named(session, &target)?, new_name)
            }
            EditOpIn::SetFeatureValue { target, expr } => {
                ResolvedOp::SetFeatureValue(resolve_edit_target_named(session, &target)?, expr)
            }
            EditOpIn::SetFeatureType { target, ty } => {
                ResolvedOp::SetFeatureType(resolve_edit_target_named(session, &target)?, ty)
            }
            EditOpIn::RetargetReference {
                from_id,
                to_id,
                site,
            } => {
                let (site, to) = resolve_retarget_reference(session, &from_id, &to_id, &site)?;
                ResolvedOp::RetargetReference(site, to)
            }
            EditOpIn::SetRedefinedFeature { target, feature } => ResolvedOp::SetRedefinedFeature(
                resolve_edit_target_named(session, &target)?,
                feature,
            ),
            EditOpIn::RemoveFeatureValue { target } => {
                ResolvedOp::RemoveFeatureValue(resolve_edit_target_named(session, &target)?)
            }
            EditOpIn::SetCommentBody { target, body } => {
                ResolvedOp::SetCommentBody(resolve_edit_target_named(session, &target)?, body)
            }
            EditOpIn::InsertMember { owner, text } => {
                ResolvedOp::InsertMember(resolve_edit_target_named(session, &owner)?, text)
            }
            EditOpIn::InsertTopLevel { unit, text } => ResolvedOp::InsertTopLevel(unit, text),
            EditOpIn::AddUnit { unit } => ResolvedOp::AddUnit(unit),
            EditOpIn::Remove { target } => {
                ResolvedOp::Remove(resolve_edit_target_named(session, &target)?)
            }
            EditOpIn::ReplaceMember { target, text } => {
                ResolvedOp::ReplaceMember(resolve_edit_target_named(session, &target)?, text)
            }
            EditOpIn::MoveMember {
                target,
                new_owner,
                index,
            } => {
                let e = resolve_edit_target_named(session, &target)?;
                let owner = match new_owner {
                    Some(name) => resolve_edit_target_named(session, &name)?,
                    None => session
                        .resolved()
                        .owner(e)
                        .ok_or_else(|| format!("{target} has no owner to reorder in"))?,
                };
                ResolvedOp::MoveMember(e, owner, index.map(|i| i as usize))
            }
        });
    }
    Ok(resolved)
}

pub fn stage_ops(batch: &mut sysmlv2_transform::EditBuilder<'_>, ops: &[ResolvedOp]) {
    for op in ops {
        match op {
            ResolvedOp::Rename(e, name) => batch.rename(*e, name),
            ResolvedOp::SetFeatureValue(e, expr) => batch.set_feature_value(*e, expr),
            ResolvedOp::SetFeatureType(e, ty) => batch.set_feature_type(*e, ty),
            ResolvedOp::RetargetReference(site, to) => batch.retarget(site.clone(), *to),
            ResolvedOp::SetRedefinedFeature(e, t) => batch.set_redefined_feature(*e, t),
            ResolvedOp::RemoveFeatureValue(e) => batch.remove_feature_value(*e),
            ResolvedOp::SetCommentBody(e, body) => batch.set_comment_body(*e, body),
            ResolvedOp::InsertMember(e, text) => batch.insert_member(*e, text),
            ResolvedOp::InsertTopLevel(unit, text) => batch.insert_top_level(unit, text),
            ResolvedOp::AddUnit(unit) => batch.add_unit(unit),
            ResolvedOp::Remove(e) => batch.remove(*e),
            ResolvedOp::ReplaceMember(e, text) => batch.replace_member(*e, text),
            ResolvedOp::MoveMember(e, owner, index) => batch.move_member(*e, *owner, *index),
        };
    }
}

pub fn report_json(report: &sysmlv2_transform::CommitReport) -> serde_json::Value {
    json!({
        "idMap": report
            .id_map
            .iter()
            .map(|(old, new)| json!([old.to_string(), new.to_string()]))
            .collect::<Vec<_>>(),
        "findings": report.findings,
        "splices": report
            .splices
            .iter()
            .map(|s| json!({
                "unit": s.unit,
                "start": s.start,
                "end": s.end,
                "text": s.text,
            }))
            .collect::<Vec<_>>(),
    })
}
