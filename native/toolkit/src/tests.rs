//! Tests de contrat Rust de la frontière N-API, sans bibliothèque
//! standard externe (modèles mémoire minimaux). Ils exercent chaque
//! famille de la matrice : syntaxe/check, lectures par élément,
//! rows/extents, outline/graph/PlantUML/viewInfo, query/evaluate,
//! éditions JSON et refus, références UTF-16, tokens LSP UTF-16,
//! cycle de vie et gardes de session/génération.
//!
//! Exécution (coordinateur) : `cargo test` dans cette crate.

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::*;
use crate::dto::*;

// Native counters describe a whole host process. A N-API host invokes these
// synchronous methods on one JS thread; serialize contract cases so another
// case cannot change the resource baseline during a lifecycle assertion.
static TEST_SERIAL: Mutex<()> = Mutex::new(());

fn serial_test() -> std::sync::MutexGuard<'static, ()> {
    TEST_SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn source(name: &str, text: &str) -> SourceText {
    SourceText {
        name: name.to_string(),
        text: text.to_string(),
    }
}

fn err_text<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected an error, got Ok"),
        Err(error) => format!("{error} {error:?}"),
    }
}

const FLASHLIGHT: &str = "package Flashlight {\n    part def Body;\n    part def Battery {\n        attribute voltage = 3;\n    }\n    part flashlight {\n        part body : Body;\n        part battery : Battery;\n    }\n}\n";

fn flashlight_session() -> ToolkitSession {
    ToolkitSession::new(vec![source("flashlight.sysml", FLASHLIGHT)])
        .expect("session over the flashlight model")
}

/// Capability probe, not a workaround: a leaf-only retarget must FAIL this test.
/// No N-API vocabulary or production editing policy is changed by the probe.
#[test]
fn retarget_and_type_edit_preserve_occurrence_chain() {
    use sysmlv2_transform::RefSite;

    let _serial = serial_test();
    const NAME: &str = "retarget-probe.sysml";
    const MODEL: &str = r#"package RetargetProbe {
    action def OldFlow { action readCaseState; action observeOutcome; }
    action def NewFlow { action readCaseState; action observeOutcome; }
    part system {
        part performer;
        part peerPerformer;
        perform action conversation : OldFlow {
            doc /* retained occurrence body */
            attribute retainedPolicy = 7;
        }
        perform action peer : OldFlow;
        allocate conversation.readCaseState to performer;
        allocate conversation.observeOutcome to performer;
        allocate peer.readCaseState to peerPerformer;
    }
}
"#;
    fn texts(session: &Session) -> Vec<(String, String)> {
        session
            .units()
            .map(|(_, name, text)| (name.into(), text.into()))
            .collect()
    }
    fn resolve(session: &mut Session, name: &str) -> ElementRef {
        session
            .resolved()
            .resolve_qualified(name)
            .unwrap_or_else(|| panic!("missing {name}"))
    }
    fn site(session: &mut Session, child: ElementRef, root: ElementRef) -> RefSite {
        let matches: Vec<_> = session
            .resolved()
            .references_to(child)
            .into_iter()
            .filter(|site| site.chain_root == Some(root) && site.kind != "qualifier")
            .collect();
        assert_eq!(
            matches.len(),
            1,
            "one contextual allocation site: {matches:?}"
        );
        let selected = matches.into_iter().next().unwrap();
        let source = session.source(selected.unit).expect("owned user source");
        assert!(!source[selected.span.start as usize..selected.span.end as usize].is_empty());
        selected
    }
    fn chains(session: &mut Session, allocation: ElementRef) -> Vec<Vec<String>> {
        let ends = session.resolved().connector_end_targets(allocation);
        ends.into_iter()
            .map(|end| {
                assert!(
                    end.spelling.is_none(),
                    "unresolved allocation end: {:?}",
                    end.spelling
                );
                end.chain
                    .into_iter()
                    .map(|element| session.resolved_ref().element_id(element).to_string())
                    .collect()
            })
            .collect()
    }
    fn allocation_for(session: &mut Session, root: ElementRef, child: ElementRef) -> ElementRef {
        let candidates = session
            .resolved_ref()
            .elements_of_metaclass("AllocationUsage");
        let expected = vec![root, child];
        let matches: Vec<_> = candidates
            .into_iter()
            .filter(|candidate| {
                session
                    .resolved()
                    .connector_end_targets(*candidate)
                    .iter()
                    .any(|end| end.chain == expected)
            })
            .collect();
        assert_eq!(
            matches.len(),
            1,
            "one allocation for the exact occurrence/child"
        );
        matches[0]
    }
    fn plan(
        session: &mut Session,
        root: ElementRef,
        sites: &[(RefSite, ElementRef)],
        commit: bool,
    ) -> std::result::Result<CommitReport, sysmlv2_transform::TransformError> {
        let mut batch = session.edit();
        batch.set_feature_type(root, "RetargetProbe::NewFlow");
        for (site, target) in sites {
            batch.retarget(site.clone(), *target);
        }
        if commit {
            batch.commit()
        } else {
            batch.check()
        }
    }

    // Preserve the discovered pinned-core refusal independently of the real
    // 5.9 names below. Reference spelling quotes the reserved name `step`,
    // while the model qualifiedName leaves it bare; do not normalize the core
    // expectation or accept this refusal as a successful migration.
    {
        let quoted_model = MODEL.replace("readCaseState", "'step'");
        let mut quoted =
            Session::from_sources_with_library(vec![(NAME.into(), quoted_model)], None)
                .expect("quoted-name refusal fixture");
        let root = resolve(&mut quoted, "RetargetProbe::system::conversation");
        let old = resolve(&mut quoted, "RetargetProbe::OldFlow::step");
        let next = resolve(&mut quoted, "RetargetProbe::NewFlow::step");
        let other = resolve(&mut quoted, "RetargetProbe::OldFlow::observeOutcome");
        let next_other = resolve(&mut quoted, "RetargetProbe::NewFlow::observeOutcome");
        let bindings = vec![
            (site(&mut quoted, old, root), next),
            (site(&mut quoted, other, root), next_other),
        ];
        let before_sources = texts(&quoted);
        let before_model = quoted.to_compact_json();
        for commit in [false, true] {
            let refusal = plan(&mut quoted, root, &bindings, commit)
                .expect_err("the pinned core must retain its known quoted-name refusal");
            eprintln!("retarget quoted-name refusal (commit={commit}): {refusal:?}");
            match refusal {
                sysmlv2_transform::TransformError::SemanticIdentity { broken } => {
                    assert!(
                        broken
                            .iter()
                            .any(|message| message.contains("rewritten reference")
                                && message.contains("RetargetProbe::NewFlow::step")
                                && message.contains("RetargetProbe::NewFlow::'step'")),
                        "retain the exact known spelling/qualifiedName mismatch: {broken:?}"
                    );
                }
                other => panic!("unexpected quoted-name refusal: {other:?}"),
            }
            assert_eq!(texts(&quoted), before_sources);
            assert_eq!(quoted.to_compact_json(), before_model);
        }
    }

    let mut session = Session::from_sources_with_library(vec![(NAME.into(), MODEL.into())], None)
        .expect("minimal native source fixture");
    let conversation = resolve(&mut session, "RetargetProbe::system::conversation");
    let peer = resolve(&mut session, "RetargetProbe::system::peer");
    let old_step = resolve(&mut session, "RetargetProbe::OldFlow::readCaseState");
    let old_other = resolve(&mut session, "RetargetProbe::OldFlow::observeOutcome");
    let new_step = resolve(&mut session, "RetargetProbe::NewFlow::readCaseState");
    let new_other = resolve(&mut session, "RetargetProbe::NewFlow::observeOutcome");
    let performer = resolve(&mut session, "RetargetProbe::system::performer");
    let first = allocation_for(&mut session, conversation, old_step);
    let second = allocation_for(&mut session, conversation, old_other);
    let peer_allocation = allocation_for(&mut session, peer, old_step);
    let allocation_ids: Vec<_> = [first, second, peer_allocation]
        .into_iter()
        .map(|element| session.resolved_ref().element_id(element).to_string())
        .collect();
    let peer_before = chains(&mut session, peer_allocation);
    let old_sources = texts(&session);
    let old_model = session.to_compact_json();
    let occurrence_id = session.resolved_ref().element_id(conversation).to_string();
    let performer_id = session.resolved_ref().element_id(performer).to_string();
    let new_ids: Vec<_> = [new_step, new_other]
        .into_iter()
        .map(|element| session.resolved_ref().element_id(element).to_string())
        .collect();
    let intended = vec![
        (site(&mut session, old_step, conversation), new_step),
        (site(&mut session, old_other, conversation), new_other),
    ];
    let mut allowed = session.resolved_ref().typing_spans(conversation);
    allowed.extend(intended.iter().map(|(site, _)| (site.unit, site.span)));

    for (label, bindings) in [
        ("type-only", &intended[..0]),
        ("omitted-reference", &intended[..1]),
    ] {
        let refused = plan(&mut session, conversation, bindings, false);
        assert!(refused.is_err(), "{label} preview must refuse: {refused:?}");
        let refused = plan(&mut session, conversation, bindings, true);
        assert!(refused.is_err(), "{label} commit must refuse: {refused:?}");
        assert_eq!(
            texts(&session),
            old_sources,
            "{label} leaves all source bytes unchanged"
        );
        assert_eq!(
            session.to_compact_json(),
            old_model,
            "{label} leaves the model unchanged"
        );
    }
    let preview = plan(&mut session, conversation, &intended, false);
    eprintln!("retarget occurrence-chain probe preview: {preview:?}");
    assert_eq!(
        texts(&session),
        old_sources,
        "preview never mutates the session"
    );
    let preview =
        preview.expect("explicit retargets must preserve the contextual allocation chain");
    assert!(
        preview.findings.is_empty(),
        "probe findings: {:?}",
        preview.findings
    );
    let committed = plan(&mut session, conversation, &intended, true)
        .expect("the exact reviewed plan must commit atomically");
    let splice_rows = |report: &CommitReport| {
        report
            .splices
            .iter()
            .map(|s| (s.unit.clone(), s.start, s.end, s.text.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        splice_rows(&preview),
        splice_rows(&committed),
        "preview/commit splices agree"
    );
    assert!(committed.findings.is_empty());
    for splice in &committed.splices {
        assert_eq!(splice.unit, NAME);
        assert!(
            allowed
                .iter()
                .any(|(_, span)| splice.start >= span.start && splice.end <= span.end),
            "unexpected edit outside explicit type/reference spans: {splice:?}"
        );
    }
    let after_sources = texts(&session);
    eprintln!("retarget occurrence-chain probe committed source: {after_sources:?}");
    assert!(after_sources[0]
        .1
        .contains("conversation : RetargetProbe::NewFlow {"));
    let after_conversation = resolve(&mut session, "RetargetProbe::system::conversation");
    assert_eq!(
        session
            .resolved_ref()
            .element_id(after_conversation)
            .to_string(),
        occurrence_id
    );
    for (index, id) in allocation_ids.iter().enumerate() {
        let allocation = session
            .resolved()
            .element_by_id(id)
            .unwrap_or_else(|| panic!("allocation identity changed: {id}"));
        let actual = chains(&mut session, allocation);
        eprintln!("retarget occurrence-chain probe allocation {index}: {actual:?}");
        let expected = if index == 2 {
            peer_before.clone()
        } else {
            vec![
                vec![occurrence_id.clone(), new_ids[index].clone()],
                vec![performer_id.clone()],
            ]
        };
        assert_eq!(
            actual, expected,
            "leaf-only or wrong-occurrence allocation is not success"
        );
    }
    assert!(after_sources[0]
        .1
        .contains("doc /* retained occurrence body */\n            attribute retainedPolicy = 7;"));
    assert!(after_sources[0]
        .1
        .contains("perform action peer : OldFlow;"));
    assert!(after_sources[0]
        .1
        .contains("allocate peer.readCaseState to peerPerformer;"));
}

#[test]
fn retarget_reference_json_revalidates_closed_fingerprints_and_preserves_chains() {
    let _serial = serial_test();
    const MODEL: &str = "package RefBinding { action def OldFlow { action readCaseState; action observeOutcome; } action def NewFlow { action readCaseState; action observeOutcome; } part system { part performer; perform action conversation : OldFlow { attribute retainedPolicy = 7; } perform action peer : OldFlow; /* 😀 UTF16 */ allocate conversation.readCaseState to performer; allocate conversation.observeOutcome to performer; allocate peer.readCaseState to performer; } }";
    let mut session = ToolkitSession::new(vec![source("binding.sysml", MODEL)]).unwrap();
    let root = must_resolve(&mut session, "RefBinding::system::conversation");
    let peer = must_resolve(&mut session, "RefBinding::system::peer");
    let old = must_resolve(&mut session, "RefBinding::OldFlow::readCaseState");
    let next = must_resolve(&mut session, "RefBinding::NewFlow::readCaseState");
    let other = must_resolve(&mut session, "RefBinding::OldFlow::observeOutcome");
    let next_other = must_resolve(&mut session, "RefBinding::NewFlow::observeOutcome");
    let fingerprint = |session: &mut ToolkitSession, id: &str| -> Value {
        let refs: Value = serde_json::from_str(
            &session
                .references(json!({"elementId":id}).to_string())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            refs["referenceSiteFormat"],
            "assembly-native-reference-site/v1"
        );
        assert_eq!(refs["referenceSitesOmitted"], 0);
        let matching: Vec<_> = refs["references"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|site| site["siteFingerprint"]["chainRootId"] == root.native_id)
            .collect();
        assert_eq!(matching.len(), 1, "exact contextual site: {refs}");
        assert!(
            matching[0]["owner"].is_object(),
            "legacy read fields stay present"
        );
        matching[0]["siteFingerprint"].clone()
    };
    let first_site = fingerprint(&mut session, &old.native_id);
    let second_site = fingerprint(&mut session, &other.native_id);
    let empty: Value = serde_json::from_str(
        &session
            .references(json!({"elementId":next.native_id}).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        empty["referenceSiteFormat"],
        "assembly-native-reference-site/v1"
    );
    assert_eq!(empty["referenceSitesOmitted"], 0);
    assert_eq!(
        empty["references"],
        json!([]),
        "new unused child still reports the protocol version"
    );
    let mut cursor = session
        .element_by_id(first_site["ownerId"].as_str().unwrap().into())
        .unwrap();
    let mut seen = std::collections::HashSet::new();
    let mut owner_chain = Vec::new();
    let mut containing_allocation = false;
    for _ in 0..64 {
        let current = cursor.take().expect("owner chain reaches its allocation");
        assert!(
            seen.insert(current.native_id.clone()),
            "native owner chain cannot cycle"
        );
        let metaclass = session.metaclass(current.clone()).unwrap();
        let extent = session.member_extent(current.clone()).unwrap();
        owner_chain.push(json!({"id":current.native_id,"metaclass":metaclass,"extent":extent}));
        if metaclass == "AllocationUsage" {
            assert!(!session.is_library_element(current.clone()).unwrap());
            assert!(
                extent.is_some(),
                "owning allocation has a native source extent"
            );
            let member = session
                .member_source(format!("@{}", current.native_id))
                .unwrap();
            assert!(member.contains("allocate conversation.readCaseState to performer;"));
            owner_chain.push(json!({"memberSource":member}));
            containing_allocation = true;
            break;
        }
        cursor = session.owner(current).unwrap();
    }
    assert!(
        containing_allocation,
        "bounded native owner ascent must find the source allocation: {owner_chain:?}"
    );
    eprintln!(
        "retarget native owner/extent evidence: {}",
        json!({"site":first_site,"owners":owner_chain})
    );
    let reference_at = MODEL.find("conversation.readCaseState").unwrap() + "conversation.".len();
    assert_eq!(
        first_site["col"],
        MODEL[..reference_at].encode_utf16().count() as u64 + 1
    );
    assert_ne!(
        first_site["col"],
        reference_at as u64 + 1,
        "UTF16 is not a byte offset"
    );
    let operations = json!([
        {"op":"setFeatureType","target":"RefBinding::system::conversation","type":"RefBinding::NewFlow"},
        {"op":"retargetReference","fromId":old.native_id,"toId":next.native_id,"site":first_site},
        {"op":"retargetReference","fromId":other.native_id,"toId":next_other.native_id,"site":second_site}
    ]);
    let before = session.units_json().unwrap();
    for (field, value) in [
        ("unit", json!("foreign.sysml")),
        ("unit", json!("sysmlv2-lib:/binding.sysml")),
        ("line", json!(2)),
        ("col", json!(1)),
        ("endLine", json!(2)),
        ("endCol", json!(1)),
        ("kind", json!("wrong-kind")),
        ("ownerId", json!(peer.native_id)),
        ("chainRootId", json!(peer.native_id)),
        ("chainRootId", Value::Null),
        ("preimage", json!("stale")),
        ("preimage", json!("x".repeat(65_537))),
        ("line", json!(0)),
        ("line", json!(u32::MAX)),
    ] {
        let mut wrong = operations.clone();
        wrong[1]["site"][field] = value;
        let preview: Value =
            serde_json::from_str(&session.check_edit(wrong.to_string()).unwrap()).unwrap();
        assert_eq!(
            preview["wouldCommit"], false,
            "wrong fingerprint {field}: {preview}"
        );
        assert!(err_text(session.edit(wrong.to_string())).contains("EDIT_REFUSED"));
        assert_eq!(session.units_json().unwrap(), before);
        assert_eq!(session.generation(), 0);
    }
    for (field, value) in [
        ("fromId", json!(next.native_id)),
        ("toId", json!("missing")),
        ("fromId", json!("x".repeat(129))),
    ] {
        let mut wrong = operations.clone();
        wrong[1][field] = value;
        assert!(err_text(session.edit(wrong.to_string())).contains("EDIT_REFUSED"));
        assert_eq!(session.units_json().unwrap(), before);
    }
    for mutation in 0..5 {
        let mut wrong = operations.clone();
        match mutation {
            0 => {
                wrong[1]["unexpected"] = json!(true);
            }
            1 => {
                wrong[1]["site"]["unexpected"] = json!(true);
            }
            2 => {
                wrong[1]["site"]
                    .as_object_mut()
                    .unwrap()
                    .remove("chainRootId");
            }
            3 => {
                wrong[1]["site"]["col"] = json!(-1);
            }
            _ => {
                wrong[1]["site"]["preimage"] = json!({"text":"raw"});
            }
        }
        assert!(err_text(session.check_edit(wrong.to_string())).contains("INVALID_INPUT"));
        assert!(err_text(session.edit(wrong.to_string())).contains("INVALID_INPUT"));
        assert_eq!(session.units_json().unwrap(), before);
        assert_eq!(session.generation(), 0);
    }
    let preview: Value =
        serde_json::from_str(&session.check_edit(operations.to_string()).unwrap()).unwrap();
    assert_eq!(preview["wouldCommit"], true, "{preview}");
    assert_eq!(session.units_json().unwrap(), before);
    let committed: Value =
        serde_json::from_str(&session.edit(operations.to_string()).unwrap()).unwrap();
    assert_eq!(preview["splices"], committed["splices"]);
    assert_eq!(session.generation(), 1);
    let inner = session.session.as_mut().unwrap();
    let occurrence = inner.resolved().element_by_id(&root.native_id).unwrap();
    let performer = inner
        .resolved()
        .resolve_qualified("RefBinding::system::performer")
        .unwrap();
    let mut observed = Vec::new();
    for allocation in inner
        .resolved_ref()
        .elements_of_metaclass("AllocationUsage")
    {
        let ends = inner.resolved().connector_end_targets(allocation);
        assert_eq!(ends.len(), 2);
        assert_eq!(ends[1].chain, vec![performer]);
        observed.push(ends[0].chain.clone());
    }
    assert!(observed.contains(&vec![
        occurrence,
        inner.resolved().element_by_id(&next.native_id).unwrap()
    ]));
    assert!(observed.contains(&vec![
        occurrence,
        inner
            .resolved()
            .element_by_id(&next_other.native_id)
            .unwrap()
    ]));
    assert!(observed.contains(&vec![
        inner.resolved().element_by_id(&peer.native_id).unwrap(),
        inner.resolved().element_by_id(&old.native_id).unwrap()
    ]));
    assert!(session
        .units_json()
        .unwrap()
        .contains("attribute retainedPolicy = 7;"));
    assert!(
        err_text(session.edit(operations.to_string())).contains("EDIT_REFUSED"),
        "old fingerprint cannot replay after adoption"
    );
    assert_eq!(session.generation(), 1);
    session.close();
}

#[test]
fn retarget_reference_json_allows_library_targets_but_not_library_site_writes() {
    let _serial = serial_test();
    let mut library = ToolkitLibrary::new(
        vec![source(
            "lib.sysml",
            "package Lib { part def First; part def Second; }",
        )],
        None,
    )
    .unwrap();
    let mut session = library
        .create_session(vec![source(
            "owned.sysml",
            "package User { part instance : Lib::First; }",
        )])
        .unwrap();
    let first = must_resolve(&mut session, "Lib::First");
    let second = must_resolve(&mut session, "Lib::Second");
    let refs: Value = serde_json::from_str(
        &session
            .references(json!({"elementId":first.native_id}).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(refs["referenceSitesOmitted"], 0);
    let site = refs["references"][0]["siteFingerprint"].clone();
    assert!(site.is_object());
    assert!(site["chainRootId"].is_null());
    let operation = json!([{"op":"retargetReference","fromId":first.native_id,"toId":second.native_id,"site":site}]);
    let mut foreign = operation.clone();
    foreign[0]["site"]["unit"] = json!("sysmlv2-lib:/lib.sysml");
    assert!(err_text(session.edit(foreign.to_string())).contains("EDIT_REFUSED"));
    let preview: Value =
        serde_json::from_str(&session.check_edit(operation.to_string()).unwrap()).unwrap();
    assert_eq!(preview["wouldCommit"], true, "{preview}");
    session.edit(operation.to_string()).unwrap();
    assert!(session.units_json().unwrap().contains("Lib::Second"));
    assert_eq!(session.generation(), 1);
    session.close();
    library.close();
}

#[test]
fn retarget_reference_json_keeps_quoted_name_refusal_atomic() {
    let _serial = serial_test();
    let mut session = ToolkitSession::new(vec![source("quoted.sysml",
        "package Quoted { action def OldFlow { action 'step'; } action def NewFlow { action 'step'; } part system { part performer; perform action conversation : OldFlow; allocate conversation.'step' to performer; } }")]).unwrap();
    let root = must_resolve(&mut session, "Quoted::system::conversation");
    let from = must_resolve(&mut session, "Quoted::OldFlow::step");
    let to = must_resolve(&mut session, "Quoted::NewFlow::step");
    let refs: Value = serde_json::from_str(
        &session
            .references(json!({"elementId":from.native_id}).to_string())
            .unwrap(),
    )
    .unwrap();
    let site = refs["references"]
        .as_array()
        .unwrap()
        .iter()
        .find(|reference| reference["siteFingerprint"]["chainRootId"] == root.native_id)
        .unwrap()["siteFingerprint"]
        .clone();
    let operations = json!([
        {"op":"setFeatureType","target":"Quoted::system::conversation","type":"Quoted::NewFlow"},
        {"op":"retargetReference","fromId":from.native_id,"toId":to.native_id,"site":site}
    ])
    .to_string();
    let before = session.units_json().unwrap();
    let preview: Value =
        serde_json::from_str(&session.check_edit(operations.clone()).unwrap()).unwrap();
    assert_eq!(preview["wouldCommit"], false);
    assert!(preview["refusal"]
        .as_str()
        .unwrap()
        .contains("Quoted::NewFlow::'step'"));
    assert!(err_text(session.edit(operations)).contains("EDIT_REFUSED"));
    assert_eq!(session.units_json().unwrap(), before);
    assert_eq!(session.generation(), 0);
    session.close();
}

fn must_resolve(session: &mut ToolkitSession, qn: &str) -> ElementRefSnapshot {
    session
        .resolve(qn.to_string())
        .expect("resolve call")
        .unwrap_or_else(|| panic!("{qn} must resolve"))
}

#[test]
fn syntax_checks_report_parse_findings_without_a_model() {
    let _serial = serial_test();
    let findings =
        check_syntax_findings(vec![source("bad.sysml", "package {")]).expect("typed syntax check");
    assert!(
        findings.iter().any(|f| f.stage == "parse"),
        "a parse finding is expected: {findings:?}"
    );
    let text = check_syntax("[{\"name\":\"bad.sysml\",\"text\":\"package {\"}]".to_string())
        .expect("JSON syntax check");
    let parsed: Value = serde_json::from_str(&text).expect("findings JSON");
    assert_eq!(parsed[0]["stage"], "parse");
    // Malformed sources JSON is an input error, not a finding.
    let message = err_text(check_syntax("{}".to_string()));
    assert!(message.contains("INVALID_INPUT"), "{message}");
    // Clean sources produce no error-severity parse finding.
    let clean =
        check_syntax_findings(vec![source("ok.sysml", FLASHLIGHT)]).expect("clean syntax check");
    assert!(clean.iter().all(|f| f.stage != "parse"), "{clean:?}");
}

#[test]
fn session_reads_describe_the_model_by_snapshot() {
    let _serial = serial_test();
    let mut session = flashlight_session();
    let battery = must_resolve(&mut session, "Flashlight::Battery");
    let description = session.describe(battery.clone()).expect("describe");
    assert_eq!(description.metaclass, "PartDefinition");
    assert_eq!(description.name.as_deref(), Some("Battery"));
    assert!(!description.is_library_element);
    assert_eq!(description.owned_members.len(), 1);

    // The low-level mirror answers the same facts.
    assert_eq!(
        session.name(battery.clone()).expect("name").as_deref(),
        Some("Battery")
    );
    assert_eq!(
        session.metaclass(battery.clone()).expect("metaclass"),
        "PartDefinition"
    );
    assert_eq!(
        session
            .qualified_name(battery.clone())
            .expect("qualified name")
            .as_deref(),
        Some("Flashlight::Battery")
    );
    assert_eq!(
        session.element_id(battery.clone()).expect("element id"),
        battery.native_id
    );
    assert!(!session
        .is_library_element(battery.clone())
        .expect("library check"));

    // elementById round-trips to the same snapshot identity.
    let by_id = session
        .element_by_id(battery.native_id.clone())
        .expect("elementById")
        .expect("present");
    assert_eq!(by_id.native_id, battery.native_id);
    assert_eq!(by_id.generation, battery.generation);

    // Usage -> typing -> definition, owner back to the package.
    let usage = must_resolve(&mut session, "Flashlight::flashlight::battery");
    let types = session.typings(usage.clone()).expect("typings");
    assert_eq!(types.len(), 1);
    assert_eq!(types[0].native_id, battery.native_id);
    let owner = session
        .owner(usage.clone())
        .expect("owner")
        .expect("owned usage");
    assert_eq!(
        session.name(owner).expect("owner name").as_deref(),
        Some("flashlight")
    );

    // Metaclass enumeration sees both definitions and both usages.
    let defs = session
        .elements_of_metaclass("PartDefinition".to_string())
        .expect("definitions");
    assert_eq!(defs.len(), 2);
    let counted = session
        .count_metaclass("PartUsage".to_string(), None)
        .expect("count usages");
    assert_eq!(counted.count, 3);

    // check JSON and typed check agree on emptiness for this model
    // (referential findings may exist without a library; parse none).
    let check_text = session.check_json().expect("check JSON");
    let parsed: Value = serde_json::from_str(&check_text).expect("check parses");
    assert!(parsed
        .as_array()
        .expect("array")
        .iter()
        .all(|f| f["stage"] != "parse"));

    session.close();
    session.close();
    let message = err_text(session.resolve("Flashlight::Body".to_string()));
    assert!(message.contains("SESSION_CLOSED"), "{message}");
}

#[test]
fn rows_extents_and_member_source_match_the_wasm_shapes() {
    let _serial = serial_test();
    let mut session = flashlight_session();
    let battery = must_resolve(&mut session, "Flashlight::Battery");
    let ids = serde_json::json!([battery.native_id, "no-such-id"]).to_string();
    let fields = serde_json::json!([
        "name",
        "qualifiedName",
        "metaclass",
        "isLibraryElement",
        "owner",
        "memberExtent"
    ])
    .to_string();
    let text = session.rows(ids, fields).expect("rows");
    let rows: Value = serde_json::from_str(&text).expect("rows JSON");
    assert_eq!(rows[0]["name"], "Battery");
    assert_eq!(rows[0]["qualifiedName"], "Flashlight::Battery");
    assert_eq!(rows[0]["metaclass"], "PartDefinition");
    assert_eq!(rows[0]["isLibraryElement"], false);
    assert!(rows[0]["owner"].is_string());
    let extent = &rows[0]["memberExtent"];
    let start = extent["start"].as_u64().expect("extent start") as usize;
    let end = extent["end"].as_u64().expect("extent end") as usize;
    assert!(FLASHLIGHT[start..end].contains("part def Battery"));
    assert!(rows[1].is_null(), "absent id rows are null");

    // memberSource returns exactly the extent's bytes.
    let member = session
        .member_source("Flashlight::Battery".to_string())
        .expect("member source");
    assert_eq!(member, FLASHLIGHT[start..end]);

    // memberExtent / declarationSite through snapshots parse the same.
    let extent_text = session
        .member_extent(battery.clone())
        .expect("memberExtent")
        .expect("extent present");
    let extent_json: Value = serde_json::from_str(&extent_text).expect("extent JSON");
    assert_eq!(
        extent_json["start"].as_u64().expect("start") as usize,
        start
    );
    assert!(session
        .declaration_site(battery.clone())
        .expect("declarationSite")
        .is_some());

    // Unknown row field is an input error.
    let message = err_text(session.rows("[]".to_string(), "[\"bogus\"]".to_string()));
    assert!(message.contains("INVALID_INPUT"), "{message}");
    session.close();
}

#[test]
fn derived_property_evaluate_and_query_agree() {
    let _serial = serial_test();
    let mut session = flashlight_session();
    let voltage = must_resolve(&mut session, "Flashlight::Battery::voltage");
    let evaluated = session.evaluate(voltage.clone()).expect("evaluate");
    assert_eq!(evaluated, "3");
    let name = session
        .derived(voltage.clone(), "name".to_string())
        .expect("derived name");
    assert_eq!(name, "\"voltage\"");

    let battery = must_resolve(&mut session, "Flashlight::Battery");
    let features = session
        .derived_elements(battery.clone(), "ownedFeature".to_string())
        .expect("derived ownedFeature");
    assert_eq!(features.len(), 1);
    assert_eq!(features[0].native_id, voltage.native_id);

    // A property the metaclass does not declare as derived errors
    // like upstream, and the session stays usable afterwards.
    let message = err_text(session.derived(voltage.clone(), "bogusProperty".to_string()));
    assert!(message.contains("TOOLKIT_ERROR"), "{message}");
    assert_eq!(session.evaluate(voltage).expect("still usable"), "3");

    // Root query evaluates a literal expression.
    let value = session.query("3 + 4".to_string()).expect("query");
    assert_eq!(value, "7");
    let message = err_text(session.query("not an expression !!".to_string()));
    assert!(message.contains("TOOLKIT_ERROR"), "{message}");
    session.close();
}

#[test]
fn outline_graph_plantuml_and_view_info_project_the_same_model() {
    let _serial = serial_test();
    let model = "package Rig {\n    part def Amp;\n    part rig {\n        part amp : Amp;\n        part spare : Amp;\n    }\n    view shallow { expose rig::*; }\n}\n";
    let mut session = ToolkitSession::new(vec![source("rig.sysml", model)]).expect("rig session");

    let outline_text = session
        .outline(Some("{\"shapeNodes\": 20000}".to_string()))
        .expect("outline");
    let outline: Value = serde_json::from_str(&outline_text).expect("outline JSON");
    let nodes = outline["shape"]["nodes"].as_array().expect("shape nodes");
    let names: Vec<&str> = nodes
        .iter()
        .map(|n| n["qualifiedName"].as_str().expect("qname"))
        .collect();
    assert!(names.contains(&"Rig::rig::amp"), "{names:?}");
    assert!(names.contains(&"Rig::shallow"), "{names:?}");
    assert_eq!(outline["shape"]["truncated"], false);

    let graph_text = session
        .to_graph(Some("{\"view\":\"tree\",\"element\":\"Rig\"}".to_string()))
        .expect("toGraph");
    let graph: Value = serde_json::from_str(&graph_text).expect("graph JSON");
    assert!(graph["nodes"].as_array().expect("nodes").len() > 1);

    let plantuml = session
        .to_plantuml(Some("{\"view\":\"tree\",\"element\":\"Rig\"}".to_string()))
        .expect("toPlantuml");
    assert!(plantuml.starts_with("@startuml"), "{plantuml}");
    assert!(plantuml.contains("amp"), "{plantuml}");

    let info_text = session
        .view_info("Rig::shallow".to_string())
        .expect("viewInfo");
    let info: Value = serde_json::from_str(&info_text).expect("viewInfo JSON");
    let exposed = info["exposed"].as_array().expect("exposed");
    assert!(
        exposed
            .iter()
            .any(|e| e["qualifiedName"] == "Rig::rig::amp"),
        "{info}"
    );
    let message = err_text(session.view_info("Rig::Amp".to_string()));
    assert!(message.contains("is not a view usage"), "{message}");
    session.close();
}

#[test]
fn action_view_keeps_the_else_branch() {
    let _serial = serial_test();
    // Guarded shorthand shape covered by the corrected Toolkit:
    // `first ingest if ok then fast; else slow;`.
    let model = "package Flow {\n    action def Router {\n        attribute ok;\n        action ingest;\n        action fast;\n        action slow;\n        first start;\n        then ingest;\n        first ingest if ok then fast;\n        else slow;\n    }\n}\n";
    let mut session = ToolkitSession::new(vec![source("flow.sysml", model)]).expect("flow session");
    let graph_text = session
        .to_graph(Some(
            "{\"view\":\"action\",\"element\":\"Flow::Router\"}".to_string(),
        ))
        .expect("action graph");
    let graph: Value = serde_json::from_str(&graph_text).expect("graph JSON");
    let labels: Vec<String> = graph["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .map(|n| n["label"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(labels.iter().any(|l| l.contains("slow")), "{labels:?}");
    assert!(labels.iter().any(|l| l.contains("fast")), "{labels:?}");
    assert!(!graph["edges"].as_array().expect("edges").is_empty());
    let plantuml = session
        .to_plantuml(Some(
            "{\"view\":\"action\",\"element\":\"Flow::Router\"}".to_string(),
        ))
        .expect("action plantuml");
    assert!(plantuml.contains("slow"), "{plantuml}");
    session.close();
}

#[test]
fn json_edits_commit_preview_and_refusals_follow_upstream() {
    let _serial = serial_test();
    let mut session = flashlight_session();
    let battery_before = must_resolve(&mut session, "Flashlight::Battery");

    // Preview: wouldCommit, no source or generation change.
    let preview_text = session
        .check_edit(
            "[{\"op\":\"rename\",\"target\":\"Flashlight::Battery\",\"newName\":\"Cell\"}]"
                .to_string(),
        )
        .expect("checkEdit");
    let preview: Value = serde_json::from_str(&preview_text).expect("preview JSON");
    assert_eq!(preview["wouldCommit"], true);
    assert!(!preview["splices"].as_array().expect("splices").is_empty());
    assert_eq!(session.generation(), 0);
    assert!(
        session
            .describe(battery_before.clone())
            .expect("preview kept the session")
            .name
            .as_deref()
            == Some("Battery")
    );

    // Commit: generation bumps, old snapshot is stale, ids remap.
    let report_text = session
        .edit(
            "[{\"op\":\"rename\",\"target\":\"Flashlight::Battery\",\"newName\":\"Cell\"}]"
                .to_string(),
        )
        .expect("edit rename");
    let report: Value = serde_json::from_str(&report_text).expect("report JSON");
    assert_eq!(report["splices"], preview["splices"]);
    assert_eq!(session.generation(), 1);
    let message = err_text(session.describe(battery_before));
    assert!(message.contains("STALE_GENERATION"), "{message}");
    let cell = must_resolve(&mut session, "Flashlight::Cell");
    let id_map = report["idMap"].as_array().expect("idMap");
    assert!(
        id_map.iter().any(|pair| pair[1] == cell.native_id),
        "rename idMap reaches the new id: {report}"
    );

    // setFeatureValue + insertMember + setFeatureType + replaceMember
    // + remove: the adapter's whole JSON vocabulary.
    session
        .edit(
            "[{\"op\":\"setFeatureValue\",\"target\":\"Flashlight::Cell::voltage\",\"expr\":\"4\"}]"
                .to_string(),
        )
        .expect("setFeatureValue");
    let voltage = must_resolve(&mut session, "Flashlight::Cell::voltage");
    assert_eq!(session.evaluate(voltage).expect("evaluate 4"), "4");
    session
        .edit(
            "[{\"op\":\"insertMember\",\"owner\":\"Flashlight::Cell\",\"text\":\"attribute capacity = 9;\"}]"
                .to_string(),
        )
        .expect("insertMember");
    assert!(session
        .resolve("Flashlight::Cell::capacity".to_string())
        .expect("resolve capacity")
        .is_some());
    session
        .edit(
            "[{\"op\":\"replaceMember\",\"target\":\"Flashlight::Cell::capacity\",\"text\":\"attribute capacity = 10;\"}]"
                .to_string(),
        )
        .expect("replaceMember");
    let capacity = must_resolve(&mut session, "Flashlight::Cell::capacity");
    assert_eq!(session.evaluate(capacity).expect("evaluate 10"), "10");
    session
        .edit("[{\"op\":\"remove\",\"target\":\"Flashlight::Cell::capacity\"}]".to_string())
        .expect("remove");
    assert!(session
        .resolve("Flashlight::Cell::capacity".to_string())
        .expect("capacity gone")
        .is_none());

    // Refusals: missing target refuses the commit and previews as
    // wouldCommit:false; malformed ops are input errors.
    let message = err_text(session.edit(
        "[{\"op\":\"rename\",\"target\":\"Flashlight::Missing\",\"newName\":\"X\"}]".to_string(),
    ));
    assert!(message.contains("EDIT_REFUSED"), "{message}");
    let refused_text = session
        .check_edit(
            "[{\"op\":\"rename\",\"target\":\"Flashlight::Missing\",\"newName\":\"X\"}]"
                .to_string(),
        )
        .expect("checkEdit refusal is data");
    let refused: Value = serde_json::from_str(&refused_text).expect("refusal JSON");
    assert_eq!(refused["wouldCommit"], false);
    assert!(refused["refusal"]
        .as_str()
        .expect("refusal")
        .contains("element not found"));
    let message = err_text(session.edit("not json".to_string()));
    assert!(message.contains("INVALID_INPUT"), "{message}");
    let message = err_text(session.edit("[]".to_string()));
    assert!(message.contains("INVALID_INPUT"), "{message}");
    session.close();
}

#[test]
fn colliding_rename_is_skipped_with_a_finding_in_json_batches() {
    let _serial = serial_test();
    let mut session = flashlight_session();
    let report_text = session
        .edit(
            "[{\"op\":\"rename\",\"target\":\"Flashlight::Body\",\"newName\":\"Battery\"}]"
                .to_string(),
        )
        .expect("colliding rename commits the (empty) rest like upstream");
    let report: Value = serde_json::from_str(&report_text).expect("report JSON");
    assert!(
        !report["findings"].as_array().expect("findings").is_empty(),
        "the dropped rename is reported: {report}"
    );
    assert!(session
        .resolve("Flashlight::Body".to_string())
        .expect("Body kept its name")
        .is_some());
    session.close();
}

#[test]
fn references_use_utf16_columns() {
    let _serial = serial_test();
    // One line: an emoji (2 UTF-16 units, 4 UTF-8 bytes) precedes
    // both the declaration and the reference, so byte columns and
    // UTF-16 columns differ observably.
    let text = "package P { /* \u{1F600} */ part def Battery; part b : Battery; }\n";
    let mut session = ToolkitSession::new(vec![source("p.sysml", text)]).expect("utf16 session");
    let utf16_col =
        |byte_offset: usize| -> u64 { text[..byte_offset].encode_utf16().count() as u64 + 1 };
    let declaration_at = text.find("part def Battery").expect("decl") + "part def ".len();
    let reference_at = text.rfind("Battery").expect("reference");
    assert_ne!(utf16_col(reference_at), reference_at as u64 + 1);

    let text_out = session
        .references("P::Battery".to_string())
        .expect("references");
    let parsed: Value = serde_json::from_str(&text_out).expect("references JSON");
    assert_eq!(
        parsed["declaration"]["col"].as_u64().expect("decl col"),
        utf16_col(declaration_at)
    );
    let sites = parsed["references"].as_array().expect("sites");
    assert_eq!(sites.len(), 1, "{parsed}");
    assert_eq!(
        sites[0]["col"].as_u64().expect("ref col"),
        utf16_col(reference_at)
    );
    assert_eq!(sites[0]["kind"], "type");
    session.close();
}

#[test]
fn library_close_keeps_sessions_and_wrong_session_is_refused() {
    let _serial = serial_test();
    let baseline = native_resource_counts();
    let mut library = ToolkitLibrary::new(
        vec![source("lib.sysml", "package Lib { part def Wheel; }")],
        None,
    )
    .expect("library");
    let mut first = library
        .create_session(vec![source(
            "m.sysml",
            "package M { part w : Lib::Wheel; }",
        )])
        .expect("session with library");
    let mut second = flashlight_session();
    library.close();
    // The existing session retains the shared graph.
    let wheel = first
        .resolve("Lib::Wheel".to_string())
        .expect("session survives library close")
        .expect("wheel resolves");
    assert!(first
        .is_library_element(wheel.clone())
        .expect("wheel is a library element"));
    // Library elements refuse JSON edits.
    let refused = first
        .check_edit(
            "[{\"op\":\"rename\",\"target\":\"Lib::Wheel\",\"newName\":\"Tyre\"}]".to_string(),
        )
        .expect("library edit previews as refusal");
    let refused_json: Value = serde_json::from_str(&refused).expect("refusal JSON");
    assert_eq!(refused_json["wouldCommit"], false);
    // A snapshot from one session is refused by another.
    let message = err_text(second.describe(wheel));
    assert!(message.contains("WRONG_SESSION"), "{message}");
    first.close();
    second.close();
    let after = native_resource_counts();
    assert_eq!(after.libraries_alive, baseline.libraries_alive);
    assert_eq!(after.sessions_alive, baseline.sessions_alive);
}

/// Decode LSP semantic tokens (delta encoding) against the UTF-16
/// units of `text`, returning (line, start, length, slice) rows.
fn decode_tokens(data: &[u64], text: &str) -> Vec<(u64, u64, u64, String)> {
    let lines: Vec<Vec<u16>> = text
        .split('\n')
        .map(|line| line.encode_utf16().collect())
        .collect();
    let mut out = Vec::new();
    let (mut line, mut start) = (0u64, 0u64);
    for chunk in data.chunks_exact(5) {
        if chunk[0] == 0 {
            start += chunk[1];
        } else {
            line += chunk[0];
            start = chunk[1];
        }
        let units = &lines[line as usize];
        let slice = String::from_utf16_lossy(&units[start as usize..(start + chunk[2]) as usize]);
        out.push((line, start, chunk[2], slice));
    }
    out
}

#[test]
fn lsp_semantic_tokens_are_utf16_like_the_token_reader_expects() {
    let _serial = serial_test();
    let baseline = native_resource_counts();
    let mut server = crate::lsp::NativeLspServer::new();
    let send = |server: &mut crate::lsp::NativeLspServer, message: Value| -> Vec<Value> {
        server
            .handle(message.to_string())
            .expect("lsp handle")
            .iter()
            .map(|reply| serde_json::from_str(reply).expect("reply JSON"))
            .collect()
    };
    let replies = send(
        &mut server,
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "processId": null, "rootUri": null,
            "capabilities": {"general": {"positionEncodings": ["utf-16"]}},
            "workspaceFolders": null
        }}),
    );
    let init = replies
        .iter()
        .find(|m| m["id"] == 1)
        .expect("initialize reply");
    let encoding = &init["result"]["capabilities"]["positionEncoding"];
    assert!(
        encoding.is_null() || encoding == "utf-16",
        "position encoding must be UTF-16: {encoding}"
    );
    let provider = &init["result"]["capabilities"]["semanticTokensProvider"];
    assert!(provider["legend"]["tokenTypes"].is_array(), "{provider}");
    assert!(
        provider["full"] == true || provider["full"].is_object(),
        "full semantic tokens must be advertised: {provider}"
    );
    send(
        &mut server,
        json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );
    // Emoji on the same line as code: UTF-16 and byte offsets differ.
    let text = "package P { /* \u{1F600} */ part def Wheel; }\n";
    let uri = "file:///ase-syntax/p.sysml";
    send(
        &mut server,
        json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {"uri": uri, "languageId": "sysml", "version": 1, "text": text}
        }}),
    );
    let replies = send(
        &mut server,
        json!({"jsonrpc": "2.0", "id": 2, "method": "textDocument/semanticTokens/full",
               "params": {"textDocument": {"uri": uri}}}),
    );
    let result = replies.iter().find(|m| m["id"] == 2).expect("tokens reply");
    let data: Vec<u64> = result["result"]["data"]
        .as_array()
        .expect("token data")
        .iter()
        .map(|v| v.as_u64().expect("token integer"))
        .collect();
    assert!(!data.is_empty());
    let tokens = decode_tokens(&data, text);
    let wheel_at = text.find("Wheel").expect("Wheel in source");
    let wheel_utf16 = text[..wheel_at].encode_utf16().count() as u64;
    assert_ne!(
        wheel_utf16, wheel_at as u64,
        "the fixture must separate encodings"
    );
    assert!(
        tokens
            .iter()
            .any(|(_, start, _, slice)| slice == "Wheel" && *start == wheel_utf16),
        "Wheel token must sit at its UTF-16 offset {wheel_utf16}: {tokens:?}"
    );
    server.close();
    let message = err_text(server.handle("{}".to_string()));
    assert!(message.contains("LSP_CLOSED"), "{message}");
    let after = native_resource_counts();
    assert_eq!(after.lsp_servers_alive, baseline.lsp_servers_alive);
}
