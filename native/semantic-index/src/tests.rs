//! Tests unitaires de la crate (executes par `cargo test` du
//! coordinateur) : admission AST, integrite de chargement, quotas et
//! aller-retour d'une projection type ASE, sans aucun binaire JS.

use super::*;

fn graph_a() -> String {
    format!("urn:ase:build:{}", "a".repeat(64))
}

fn sample_quads() -> Vec<u8> {
    let graph = graph_a();
    let pkg = "urn:ase:model:repo-one:pkg";
    let part = "urn:ase:model:repo-one:part";
    let attr = "urn:ase:model:repo-one:attr";
    let list = "_:b_pkg_ownedMember";
    let lines = [
        format!("<{pkg}> <urn:ase:vocab:metaclass> \"Package\" <{graph}> ."),
        format!("<{pkg}> <urn:ase:vocab:nativeId> \"pkg\" <{graph}> ."),
        format!("<{part}> <urn:ase:vocab:metaclass> \"PartUsage\" <{graph}> ."),
        format!("<{part}> <urn:ase:vocab:nativeId> \"part\" <{graph}> ."),
        format!("<{part}> <urn:ase:vocab:name> \"p\" <{graph}> ."),
        format!("<{pkg}> <urn:ase:vocab:prop:ownedMember> <{part}> <{graph}> ."),
        format!("<{pkg}> <urn:ase:vocab:prop:ownedMember> <{attr}> <{graph}> ."),
        format!("<{pkg}> <urn:ase:vocab:list:ownedMember> {list} <{graph}> ."),
        format!("{list} <urn:ase:vocab:length> \"3\"^^<http://www.w3.org/2001/XMLSchema#integer> <{graph}> ."),
        format!("{list} <urn:ase:vocab:occurrence> _:o0 <{graph}> ."),
        format!("{list} <urn:ase:vocab:occurrence> _:o1 <{graph}> ."),
        format!("{list} <urn:ase:vocab:occurrence> _:o2 <{graph}> ."),
        "_:o0 <urn:ase:vocab:index> \"0\"^^<http://www.w3.org/2001/XMLSchema#integer> <G> .".replace("<G>", &format!("<{graph}>")),
        "_:o1 <urn:ase:vocab:index> \"1\"^^<http://www.w3.org/2001/XMLSchema#integer> <G> .".replace("<G>", &format!("<{graph}>")),
        "_:o2 <urn:ase:vocab:index> \"2\"^^<http://www.w3.org/2001/XMLSchema#integer> <G> .".replace("<G>", &format!("<{graph}>")),
        format!("_:o0 <urn:ase:vocab:value> <{part}> <{graph}> ."),
        format!("_:o1 <urn:ase:vocab:value> <{attr}> <{graph}> ."),
        format!("_:o2 <urn:ase:vocab:value> <{part}> <{graph}> ."),
    ];
    let mut text = lines.join("\n");
    text.push('\n');
    text.into_bytes()
}

fn limits() -> QueryLimits {
    QueryLimits {
        max_results: 100,
        max_bytes: 1_048_576,
        timeout_ms: 5_000,
    }
}

fn loaded_store() -> (Store, Vec<u8>) {
    let bytes = sample_quads();
    let digest = sha256_hex(&bytes);
    let (store, _) = load_into_new_store(&StoreOptions::default(), &graph_a(), &bytes, &digest)
        .expect("sample projection loads");
    (store, bytes)
}

fn error_text(error: &Error) -> String {
    error.to_string()
}

#[test]
fn load_then_select_roundtrips_names_and_list_order_with_duplicates() {
    let (store, _) = loaded_store();
    let text = run_query(
        &store,
        "PREFIX ase: <urn:ase:vocab:> SELECT ?value WHERE { \
         <urn:ase:model:repo-one:pkg> <urn:ase:vocab:list:ownedMember> ?list . \
         ?list ase:occurrence ?occurrence . \
         ?occurrence ase:index ?index ; ase:value ?value } ORDER BY ?index",
        limits(),
    )
    .expect("ordered members query");
    let payload: Value = serde_json::from_str(&text).expect("json result");
    let values: Vec<&str> = payload["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| row["value"]["value"].as_str().expect("iri value"))
        .collect();
    assert_eq!(
        values,
        [
            "urn:ase:model:repo-one:part",
            "urn:ase:model:repo-one:attr",
            "urn:ase:model:repo-one:part",
        ]
    );

    let ask = run_query(
        &store,
        "ASK { <urn:ase:model:repo-one:part> <urn:ase:vocab:name> \"p\" }",
        limits(),
    )
    .expect("ask query");
    let payload: Value = serde_json::from_str(&ask).expect("json result");
    assert_eq!(payload["form"], "boolean");
    assert_eq!(payload["value"], true);
}

#[test]
fn stores_are_isolated_per_build() {
    let (store_a, _) = loaded_store();
    let graph_b = format!("urn:ase:build:{}", "b".repeat(64));
    let quads_b =
        format!("<urn:ase:model:repo-two:only> <urn:ase:vocab:name> \"other\" <{graph_b}> .\n")
            .into_bytes();
    let digest_b = sha256_hex(&quads_b);
    let (store_b, _) = load_into_new_store(&StoreOptions::default(), &graph_b, &quads_b, &digest_b)
        .expect("second build loads");
    let from_a = run_query(&store_a, "SELECT ?s WHERE { ?s ?p \"other\" }", limits())
        .expect("cross query on A");
    let payload: Value = serde_json::from_str(&from_a).expect("json");
    assert_eq!(payload["rows"].as_array().expect("rows").len(), 0);
    let from_b = run_query(&store_b, "SELECT ?s WHERE { ?s ?p \"other\" }", limits())
        .expect("cross query on B");
    let payload: Value = serde_json::from_str(&from_b).expect("json");
    assert_eq!(payload["rows"].as_array().expect("rows").len(), 1);
}

#[test]
fn loading_verifies_digest_and_graph_before_any_state() {
    let bytes = sample_quads();
    let wrong_digest = "0".repeat(64);
    let error = load_into_new_store(&StoreOptions::default(), &graph_a(), &bytes, &wrong_digest)
        .err()
        .expect("digest mismatch refused");
    assert!(error_text(&error).contains("INTEGRITY"), "{error}");

    let digest = sha256_hex(&bytes);
    let other_graph = format!("urn:ase:build:{}", "c".repeat(64));
    let error = load_into_new_store(&StoreOptions::default(), &other_graph, &bytes, &digest)
        .err()
        .expect("graph mismatch refused");
    assert!(error_text(&error).contains("INTEGRITY"), "{error}");
}

#[test]
fn admission_refuses_updates_service_and_client_datasets() {
    for refused in [
        // Updates et operations reseau/disque : ne parsent pas comme Query.
        "INSERT DATA { <a> <b> <c> }",
        "DELETE WHERE { ?s ?p ?o }",
        "DELETE { ?s ?p ?o } INSERT { ?s ?p ?o } WHERE { ?s ?p ?o }",
        "CLEAR ALL",
        "CREATE GRAPH <urn:x>",
        "DROP ALL",
        "COPY DEFAULT TO <urn:x>",
        "MOVE DEFAULT TO <urn:x>",
        "ADD DEFAULT TO <urn:x>",
        "LOAD <https://example.invalid/data>",
        "LOAD SILENT <https://example.invalid/data> INTO GRAPH <urn:x>",
        // SERVICE direct, silencieux, variable, et imbrique partout ou
        // l'algebre peut le porter (sous-requete, OPTIONAL, UNION, GRAPH,
        // EXISTS derriere FILTER/BIND, MINUS).
        "SELECT * WHERE { SERVICE <https://example.invalid> { ?s ?p ?o } }",
        "SELECT * WHERE { SERVICE SILENT <https://example.invalid> { ?s ?p ?o } }",
        "SELECT * WHERE { BIND(<https://example.invalid> AS ?ep) SERVICE ?ep { ?s ?p ?o } }",
        "SELECT * WHERE { { SELECT * WHERE { SERVICE <https://example.invalid> { ?s ?p ?o } } } }",
        "SELECT * WHERE { ?s ?p ?o OPTIONAL { SERVICE <https://example.invalid> { ?s ?q ?r } } }",
        "SELECT * WHERE { { ?s ?p ?o } UNION { SERVICE <https://example.invalid> { ?s ?p ?o } } }",
        "SELECT * WHERE { GRAPH ?g { SERVICE <https://example.invalid> { ?s ?p ?o } } }",
        "SELECT * WHERE { ?s ?p ?o FILTER EXISTS { SERVICE <https://example.invalid> { ?s ?q ?r } } }",
        "SELECT * WHERE { ?s ?p ?o LATERAL { SERVICE <https://example.invalid> { ?s ?q ?r } } }",
        "SELECT * WHERE { SERVICE <https://example.invalid> { ?s ?q ?r } LATERAL { ?s ?p ?o } }",
        "SELECT * WHERE { ?s ?p ?o MINUS { SERVICE <https://example.invalid> { ?s ?q ?r } } }",
        "ASK { SERVICE <https://example.invalid> { ?s ?p ?o } }",
        "CONSTRUCT { ?s ?p ?o } WHERE { SERVICE <https://example.invalid> { ?s ?p ?o } }",
        // Datasets choisis par le client, toutes formes confondues.
        "SELECT * FROM <urn:ase:build:other> WHERE { ?s ?p ?o }",
        "SELECT * FROM NAMED <urn:x> WHERE { ?s ?p ?o }",
        "SELECT * FROM <https://example.invalid/g> WHERE { ?s ?p ?o }",
        "ASK FROM <urn:x> { ?s ?p ?o }",
        "CONSTRUCT { ?s ?p ?o } FROM <urn:x> WHERE { ?s ?p ?o }",
        "DESCRIBE * FROM <urn:x> WHERE { ?s ?p ?o }",
    ] {
        let error = admit_query(refused).expect_err("must refuse");
        assert!(
            error_text(&error).contains("QUERY_REFUSED"),
            "{refused} -> {error}"
        );
    }
    for admitted in [
        "SELECT * WHERE { ?s ?p ?o }",
        "ASK { ?s ?p ?o }",
        "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }",
        "DESCRIBE <urn:ase:model:r:el-1>",
        "SELECT * WHERE { GRAPH <urn:ase:build:x> { ?s ?p ?o } }",
        "SELECT * WHERE { ?s ?p ?o FILTER EXISTS { ?s ?q ?r } }",
        // Les mots interdits dans les litteraux/IRI n'ont rien d'un mot-cle.
        "SELECT * WHERE { ?s ?p \"SERVICE FROM LOAD\" }",
        "SELECT * WHERE { <urn:ase:vocab:from-service> ?p ?o }",
        "SELECT * WHERE { ?s ?p ?o LATERAL { ?s ?q ?r } }",
    ] {
        admit_query(admitted)
            .unwrap_or_else(|error| panic!("{admitted} should be admitted: {error}"));
    }
}

#[test]
fn construct_and_describe_return_bounded_graph_form() {
    let (store, _) = loaded_store();
    let text = run_query(
        &store,
        "CONSTRUCT { ?s <urn:ase:vocab:name> ?o } WHERE { ?s <urn:ase:vocab:name> ?o }",
        limits(),
    )
    .expect("construct query");
    let payload: Value = serde_json::from_str(&text).expect("json result");
    assert_eq!(payload["form"], "graph");
    assert_eq!(payload["truncated"], false);
    let quads = payload["quads"].as_array().expect("quads");
    assert_eq!(quads.len(), 1, "{text}");
    assert_eq!(quads[0]["subject"]["value"], "urn:ase:model:repo-one:part");
    assert_eq!(quads[0]["predicate"], "urn:ase:vocab:name");
    assert_eq!(quads[0]["object"]["kind"], "literal");
    assert_eq!(quads[0]["object"]["value"], "p");

    let text = run_query(&store, "DESCRIBE <urn:ase:model:repo-one:part>", limits())
        .expect("describe query");
    let payload: Value = serde_json::from_str(&text).expect("json result");
    assert_eq!(payload["form"], "graph", "{text}");

    let ask_false = run_query(
        &store,
        "ASK { <urn:ase:model:repo-one:part> <urn:ase:vocab:name> \"absent\" }",
        limits(),
    )
    .expect("ask false query");
    let payload: Value = serde_json::from_str(&ask_false).expect("json result");
    assert_eq!(payload["value"], false);
}

#[test]
fn bare_patterns_read_the_build_graph_and_graph_patterns_see_it_named() {
    // Sans epinglage du dataset cote serveur, un motif nu ne lirait que le
    // graphe par defaut (vide) : la projection vit dans le graphe nomme du
    // build. Le meme graphe reste adressable par GRAPH <iri> et GRAPH ?g.
    let (store, _) = loaded_store();
    let bare = run_query(
        &store,
        "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }",
        limits(),
    )
    .expect("bare count");
    let payload: Value = serde_json::from_str(&bare).expect("json");
    assert_eq!(payload["rows"][0]["n"]["value"], "18", "{bare}");

    let named = run_query(
        &store,
        "SELECT ?g WHERE { GRAPH ?g { <urn:ase:model:repo-one:part> ?p ?o } }",
        limits(),
    )
    .expect("graph variable");
    let payload: Value = serde_json::from_str(&named).expect("json");
    let graphs: Vec<&str> = payload["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| row["g"]["value"].as_str().expect("graph iri"))
        .collect();
    assert!(!graphs.is_empty(), "{named}");
    assert!(graphs.iter().all(|graph| *graph == graph_a()), "{named}");
}

#[test]
fn loading_rejects_malformed_oversized_and_overfull_nquads() {
    let malformed = b"<a> <b> not-a-term .\n".to_vec();
    let digest = sha256_hex(&malformed);
    let error = load_into_new_store(&StoreOptions::default(), &graph_a(), &malformed, &digest)
        .err()
        .expect("malformed N-Quads refused");
    assert!(error_text(&error).contains("INVALID_INPUT"), "{error}");

    let bytes = sample_quads();
    let digest = sha256_hex(&bytes);
    let small_bytes = StoreOptions {
        max_quad_bytes: 16,
        ..StoreOptions::default()
    };
    let error = load_into_new_store(&small_bytes, &graph_a(), &bytes, &digest)
        .err()
        .expect("oversized projection refused");
    assert!(error_text(&error).contains("INVALID_INPUT"), "{error}");

    let few_quads = StoreOptions {
        max_quads_per_build: 3,
        ..StoreOptions::default()
    };
    let error = load_into_new_store(&few_quads, &graph_a(), &bytes, &digest)
        .err()
        .expect("quad quota refused");
    assert!(error_text(&error).contains("QUERY_LIMIT"), "{error}");
}

#[test]
fn budget_deadline_is_a_hard_error_not_a_truncation() {
    let mut budget = Budget {
        started: Instant::now() - std::time::Duration::from_millis(50),
        limits: QueryLimits {
            max_results: 100,
            max_bytes: 1_048_576,
            timeout_ms: 1,
        },
        bytes: 0,
        seen: 0,
    };
    let error = budget.admit_row(1).expect_err("expired budget refuses");
    assert!(error_text(&error).contains("TIMEOUT"), "{error}");
    let error = budget
        .check_deadline()
        .expect_err("expired deadline refuses");
    assert!(error_text(&error).contains("TIMEOUT"), "{error}");
}

#[test]
fn result_and_byte_quotas_truncate_instead_of_overrunning() {
    let (store, _) = loaded_store();
    let text = run_query(
        &store,
        "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
        QueryLimits {
            max_results: 2,
            max_bytes: 1_048_576,
            timeout_ms: 5_000,
        },
    )
    .expect("bounded query");
    let payload: Value = serde_json::from_str(&text).expect("json");
    assert_eq!(payload["rows"].as_array().expect("rows").len(), 2);
    assert_eq!(payload["truncated"], true);

    let text = run_query(
        &store,
        "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
        QueryLimits {
            max_results: 100,
            max_bytes: 120,
            timeout_ms: 5_000,
        },
    )
    .expect("byte bounded query");
    let payload: Value = serde_json::from_str(&text).expect("json");
    assert_eq!(payload["truncated"], true);
    assert!(text.len() <= 120, "{text}");
    assert!(payload["rows"].as_array().expect("rows").len() < 18);
}

#[test]
fn service_hidden_in_valid_expression_queries_is_refused_by_ast() {
    for sparql in [
        "SELECT (EXISTS { SERVICE <https://example.invalid/> { ?s ?p ?o } } AS ?present) WHERE {}",
        "SELECT * WHERE { ?s ?p ?o LATERAL { SERVICE <https://example.invalid/> { ?s ?q ?r } } }",
        "SELECT * WHERE { SERVICE <https://example.invalid/> { ?s ?q ?r } LATERAL { ?s ?p ?o } }",
        "SELECT ?present WHERE { BIND(EXISTS { SERVICE <https://example.invalid/> { ?s ?p ?o } } AS ?present) }",
        "SELECT ?s WHERE { ?s ?p ?o } ORDER BY (EXISTS { SERVICE <https://example.invalid/> { ?a ?b ?c } })",
        "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o } HAVING (EXISTS { SERVICE <https://example.invalid/> { ?a ?b ?c } })",
        "SELECT (SUM(IF(EXISTS { SERVICE <https://example.invalid/> { ?a ?b ?c } }, 1, 0)) AS ?n) WHERE { ?s ?p ?o }",
    ] {
        SparqlParser::new().parse_query(sparql)
            .unwrap_or_else(|error| panic!("test query must first be syntactically valid: {error}: {sparql}"));
        let error = admit_query(sparql).expect_err("AST expression must refuse federation");
        assert!(error_text(&error).contains("SERVICE patterns are refused"), "{error}");
    }
}

#[test]
fn exact_serialized_result_bytes_include_metadata_and_separators() {
    let (store, _) = loaded_store();
    for sparql in [
        "ASK { ?s ?p ?o }",
        "SELECT ?s ?p ?o WHERE { ?s ?p ?o } ORDER BY ?s ?p ?o",
        "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }",
    ] {
        let unbounded = run_query(&store, sparql, limits()).expect("reference result");
        let exact = run_query(
            &store,
            sparql,
            QueryLimits {
                max_bytes: unbounded.len(),
                ..limits()
            },
        )
        .expect("exact complete result quota fits");
        assert!(exact.len() <= unbounded.len());
        let error = run_query(
            &store,
            sparql,
            QueryLimits {
                max_bytes: 1,
                ..limits()
            },
        )
        .expect_err("even empty result metadata cannot fit");
        assert!(error_text(&error).contains("QUERY_LIMIT"), "{error}");
    }
    let bounded = run_query(
        &store,
        "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
        QueryLimits {
            max_bytes: 600,
            ..limits()
        },
    )
    .expect("some bounded rows fit");
    let payload: Value = serde_json::from_str(&bounded).expect("json");
    assert!(payload["rows"].as_array().expect("rows").len() > 1);
    assert_eq!(payload["truncated"], true);
    assert!(bounded.len() <= 600, "{bounded}");
}

#[test]
fn native_entry_points_reject_unbounded_inputs_and_zero_store_quotas() {
    let (store, _) = loaded_store();
    for limits in [
        QueryLimits {
            max_results: 10_001,
            ..limits()
        },
        QueryLimits {
            max_bytes: 8_388_609,
            ..limits()
        },
        QueryLimits {
            timeout_ms: 30_001,
            ..limits()
        },
        QueryLimits {
            max_results: 0,
            ..limits()
        },
    ] {
        let error = run_query(&store, "ASK {}", limits).expect_err("hard native quota");
        assert!(error_text(&error).contains("INVALID_INPUT"), "{error}");
    }
    let error = run_query(&store, &" ".repeat(65_537), limits()).expect_err("query bytes");
    assert!(error_text(&error).contains("INVALID_INPUT"), "{error}");
    for options in [
        r#"{"maxLoadedBuilds":0}"#,
        r#"{"maxQuadsPerBuild":0}"#,
        r#"{"maxQuadBytes":0}"#,
    ] {
        let error = SemanticIndexStore::new(Some(options.into()))
            .err()
            .expect("zero quota refused");
        assert!(error_text(&error).contains("INVALID_INPUT"), "{error}");
    }
    let empty: &[u8] = b"";
    let error = load_into_new_store(
        &StoreOptions::default(),
        "urn:unrelated:graph",
        empty,
        &sha256_hex(empty),
    )
    .err()
    .expect("graph must have canonical build identity even when empty");
    assert!(error_text(&error).contains("INVALID_INPUT"), "{error}");
}

#[test]
fn panic_poison_is_preserved_and_close_can_clean_a_poisoned_mutex() {
    let store = SemanticIndexStore::new(None).expect("store");
    let error = store
        .guard::<()>(|_| panic!("test panic"))
        .expect_err("panic caught");
    assert!(error_text(&error).contains("NATIVE_PANIC"), "{error}");
    let error = store
        .has_build("key".into())
        .expect_err("poisoned store cannot be reused");
    assert!(error_text(&error).contains("INDEX_POISONED"), "{error}");
    store.close();
    store.close();
    assert!(store.is_closed());
}

#[test]
fn rdf_12_terms_remain_outside_the_projection_contract() {
    let (store, _) = loaded_store();
    for sparql in [
        "SELECT (<<( <urn:s> <urn:p> <urn:o> )>> AS ?triple) WHERE {}",
        "SELECT (<< <urn:s> <urn:p> <urn:o> >> AS ?triple) WHERE {}",
    ] {
        let error = run_query(&store, sparql, limits()).expect_err("triple terms refused");
        assert!(error_text(&error).contains("QUERY_REFUSED"), "{error}");
    }
    let payload: Value = serde_json::from_str(
        &run_query(
            &store,
            "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }",
            limits(),
        )
        .expect("RDF 1.1 graph result"),
    )
    .expect("json");
    let quads = payload["quads"].as_array().expect("quads");
    assert!(quads.iter().any(|quad| quad["subject"]["kind"] == "iri"));
    assert!(quads.iter().any(|quad| quad["subject"]["kind"] == "blank"));
}

#[test]
fn failed_reloads_preserve_the_previously_published_build() {
    let store = SemanticIndexStore::new(None).expect("store");
    let bytes = sample_quads();
    let digest = sha256_hex(&bytes);
    store
        .load_build(
            "build".into(),
            graph_a(),
            bytes.clone().into(),
            digest.clone(),
        )
        .expect("initial load");
    let malformed = format!(
        "{}not a quad\n",
        String::from_utf8(bytes.clone()).expect("utf8")
    )
    .into_bytes();
    for (graph, replacement, expected_digest) in [
        (graph_a(), bytes.clone(), "0".repeat(64)),
        (
            format!("urn:ase:build:{}", "b".repeat(64)),
            bytes.clone(),
            digest,
        ),
        (graph_a(), malformed.clone(), sha256_hex(&malformed)),
    ] {
        store
            .load_build("build".into(), graph, replacement.into(), expected_digest)
            .err()
            .expect("invalid reload refused");
        let result = store
            .query_read_only(
                "build".into(),
                "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }".into(),
                r#"{"maxResults":100,"maxBytes":1048576,"timeoutMs":5000}"#.into(),
            )
            .expect("previous build remains queryable");
        let payload: Value = serde_json::from_str(&result).expect("json");
        assert_eq!(payload["rows"][0]["n"]["value"], "18");
    }
}
