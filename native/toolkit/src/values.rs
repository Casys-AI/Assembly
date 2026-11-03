//! Conversion des valeurs évaluées et des propriétés dérivées en JSON.
//!
//! Sémantique reprise du wrapper amont (`crates/sysmlv2-wasm`, méthodes
//! `value_to_json`, `derived_json`, `derived_value` de sa `Session`),
//! recalculée directement sur `sysmlv2_model` natif : mêmes formes JSON,
//! mêmes messages d'erreur, aucun transport WASM.

use serde_json::json;
use sysmlv2_model::eval::Value as EvalValue;
use sysmlv2_model::json::{dangling_id, Derived, DerivedValue, ElementRef, Reference};
use sysmlv2_transform::Session;

/// La valeur dérivée `name` de `e`, ou le message d'erreur amont exact.
pub fn derived_value(
    session: &mut Session,
    e: ElementRef,
    name: &str,
) -> Result<DerivedValue, String> {
    match session.resolved().derived(e, name) {
        Derived::NotDeclared => Err(format!(
            "{name} is not a derived property of {}",
            session.resolved().element_type(e)
        )),
        Derived::NotComputed => Err(format!("{name} is not computed by this toolkit yet")),
        Derived::Value(v) => Ok(v),
    }
}

/// La réponse JSON de `derived(e, name)` amont : `null`, booléen, chaîne,
/// tableau de chaînes, élément `{"@id": …}`, ou cible hors modèle
/// `{"outside": true, …}`.
pub fn derived_json(
    session: &mut Session,
    e: ElementRef,
    name: &str,
) -> Result<serde_json::Value, String> {
    let value = derived_value(session, e, name)?;
    let r = session.resolved();
    let id = |x: ElementRef| json!({ "@id": r.element_id(x).to_string() });
    let reference = |x: &Reference| -> Result<serde_json::Value, String> {
        Ok(match x {
            Reference::Element(x) => id(*x),
            Reference::External(u) => json!({ "outside": true, "id": u.to_string() }),
            // The full form spells an unresolved reference as its
            // deterministic dangling id: carried beside the spelling.
            Reference::Unresolved(s) => json!({
                "outside": true,
                "spelling": s,
                "danglingId": dangling_id(s),
            }),
            _ => return Err("unsupported reference shape from a newer toolkit".into()),
        })
    };
    let json = match &value {
        DerivedValue::Null => serde_json::Value::Null,
        DerivedValue::Bool(b) => serde_json::Value::Bool(*b),
        DerivedValue::Str(s) => serde_json::Value::String(s.clone()),
        DerivedValue::Strings(ss) => json!(ss),
        DerivedValue::Element(x) => id(*x),
        DerivedValue::Elements(xs) => serde_json::Value::Array(xs.iter().map(|&x| id(x)).collect()),
        DerivedValue::Reference(x) => reference(x)?,
        DerivedValue::References(xs) => {
            serde_json::Value::Array(xs.iter().map(reference).collect::<Result<_, _>>()?)
        }
        _ => return Err("unsupported derived value shape from a newer toolkit".into()),
    };
    Ok(json)
}

/// Les éléments du modèle portés par la valeur dérivée `name` de `e`
/// (`derivedElements` amont : les cibles hors modèle sont omises).
pub fn derived_elements(
    session: &mut Session,
    e: ElementRef,
    name: &str,
) -> Result<Vec<ElementRef>, String> {
    let value = derived_value(session, e, name)?;
    Ok(match &value {
        DerivedValue::Element(x) => vec![*x],
        DerivedValue::Elements(xs) => xs.clone(),
        DerivedValue::Reference(r) => r.element().into_iter().collect(),
        DerivedValue::References(rs) => rs.iter().filter_map(|r| r.element()).collect(),
        _ => Vec::new(),
    })
}

/// Une valeur évaluée en JSON, comme `query`/`evaluate` amont : les
/// éléments deviennent `{"@element": id, "qualifiedName": …}`, les
/// rationnels non exacts en JSON `{"@rational": "n/d", "approx": …}`.
pub fn value_to_json(session: &mut Session, v: &EvalValue) -> serde_json::Value {
    match v {
        EvalValue::Boolean(b) => json!(b),
        EvalValue::Integer(i) => json!(i),
        // A JSON number carries an exact rational only when its
        // decimal spelling is the value; anything else crosses as an
        // explicit fraction with a double approximation alongside.
        EvalValue::Rational(r) if r.json_number_is_exact() => json!(r.to_f64()),
        EvalValue::Rational(r) => {
            let (n, d) = r.to_string_parts();
            json!({ "@rational": format!("{n}/{d}"), "approx": r.to_f64() })
        }
        EvalValue::Real(f) => json!(f),
        EvalValue::String(s) => json!(s),
        EvalValue::Indeterminate => json!({ "@indeterminate": true }),
        EvalValue::Element(e) | EvalValue::Unbound(e) | EvalValue::UnboundMember(e) => json!({
            "@element": session.resolved().element_id(*e).to_string(),
            "qualifiedName": session.resolved().element_qualified_name(*e),
        }),
        EvalValue::Quantity(n, unit) => json!({
            "value": value_to_json(session, n),
            "unit": unit.display(),
        }),
        EvalValue::Instance {
            ty_name, fields, ..
        } => {
            let mut obj = serde_json::Map::new();
            obj.insert("@type".to_string(), json!(ty_name));
            for (name, value) in fields {
                obj.insert(name.clone(), value_to_json(session, value));
            }
            serde_json::Value::Object(obj)
        }
        EvalValue::Sequence(items) => {
            serde_json::Value::Array(items.iter().map(|i| value_to_json(session, i)).collect())
        }
    }
}
