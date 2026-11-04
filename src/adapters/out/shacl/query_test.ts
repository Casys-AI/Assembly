import assert from "node:assert/strict";
import {
  admitSelect,
  bindAssociations,
  bindFocus,
  ShaclQueryError,
} from "./query.ts";
Deno.test("admission rejects forbidden AST constructs at every nesting depth", () => {
  const rejected = [
    "ASK {}",
    "INSERT DATA { <urn:a> <urn:b> <urn:c> }",
    "SELECT * WHERE {}",
    "SELECT ?this WHERE { { SELECT * WHERE {} } }",
    "SELECT ?this WHERE { { SELECT ?other WHERE {} } }",
    "SELECT ?this WHERE { FILTER NOT EXISTS { ?this ?p ?o MINUS { ?this ?p 1 } } }",
    "SELECT ?this WHERE { SERVICE <https://example.com/> { ?this ?p ?o } }",
    "SELECT ?this WHERE { VALUES ?this { <urn:a> } }",
    "SELECT ?this WHERE {} VALUES (?other ?this) { (1 UNDEF) }",
    "SELECT ?this WHERE { VALUES ?this {} }",
    "SELECT ?this WHERE { VALUES ?other {} }",
    "SELECT ?this WHERE { BIND (true AS ?this) }",
    "SELECT (true AS ?this) WHERE {}",
    "SELECT ?this FROM <urn:data> WHERE {}",
    "SELECT ?this WHERE {} LIMIT 0",
    "SELECT ?this WHERE { { SELECT ?this WHERE {} OFFSET 1 } }",
    "SELECT ?this (COUNT(?v) AS ?count) WHERE { ?this <urn:p> ?v } GROUP BY ?this",
    "SELECT ?this WHERE { ?this <urn:p> ?v } GROUP BY ?this HAVING (COUNT(?v) > 0)",
    "SELECT ?this WHERE { BIND(RAND() AS ?v) }",
    "SELECT ?this WHERE { BIND(UUID() AS ?v) }",
    "SELECT ?this WHERE { BIND(STRUUID() AS ?v) }",
    "SELECT ?this WHERE { BIND(NOW() AS ?v) }",
    "SELECT ?this WHERE { BIND(BNODE() AS ?v) }",
    "SELECT ?this WHERE { BIND(<urn:custom>(?this) AS ?v) }",
  ];
  for (const source of rejected) {
    assert.throws(() => admitSelect(source), ShaclQueryError, source);
  }
  assert.throws(() => admitSelect("SELECT ?this WHERE {"), (error) => {
    assert(error instanceof ShaclQueryError);
    assert.equal(error.code, "SHACL_QUERY_PARSE");
    assert(error.cause instanceof Error);
    assert(error.message.includes(error.cause.message));
    return true;
  });
});

Deno.test("admission rejects GROUP BY and HAVING even without aggregates", () => {
  for (
    const source of [
      "SELECT ?this WHERE {} GROUP BY ?this",
      "SELECT ?this WHERE {} HAVING (true)",
      "SELECT ?this WHERE {} GROUP BY ?this HAVING (true)",
      "SELECT ?this WHERE {} GROUP BY ?this (EXISTS { FILTER(?this = <urn:a>) } AS ?present)",
      "SELECT ?this WHERE {} HAVING (EXISTS { FILTER(?this = <urn:a>) })",
    ]
  ) {
    assert.throws(() => admitSelect(source), {
      code: "SHACL_QUERY_UNSUPPORTED",
    });
  }
});

Deno.test("focus serialization rejects injection and unsupported RDF term kinds", () => {
  const compiled = admitSelect("SELECT ?this WHERE {}");
  for (
    const value of [
      "_:blank",
      "relative",
      '"literal"',
      "urn:x> } SERVICE <https://example.com/> {} #",
      "urn:with space",
      "urn:with\\backslash",
      "urn:with\nnewline",
      "urn:bad\ud800",
    ]
  ) {
    assert.throws(() => bindFocus(compiled, [value]), {
      code: "SHACL_FOCUS_INVALID",
    });
  }
  // A unicode escape in query text must not turn into an unsafe decoded IRI
  // when the parsed query is subsequently serialized by SPARQLjs.
  assert.throws(
    () => admitSelect("SELECT ?this WHERE { ?this <urn:x\\u003E> ?v }"),
    ShaclQueryError,
  );
});

Deno.test("association bindings protect owner and budget parameters recursively", () => {
  for (
    const variable of [
      "ownerSystem",
      "budgetPolicy",
      "allowedHostsAttribute",
      "networkHostsAttribute",
    ]
  ) {
    for (
      const source of [
        `SELECT ?this WHERE { VALUES ?${variable} { <urn:a> } }`,
        `SELECT ?this WHERE { BIND(<urn:a> AS ?${variable}) }`,
        `SELECT ?this (<urn:a> AS ?${variable}) WHERE {}`,
        `SELECT ?this WHERE { FILTER NOT EXISTS { VALUES ?${variable} { <urn:a> } } }`,
      ]
    ) assert.throws(() => admitSelect(source), ShaclQueryError);
  }
  const ast = admitSelect(
    "SELECT ?this ?ownerSystem WHERE { { FILTER(bound(?this)) } FILTER NOT EXISTS { ?this <urn:p> ?budgetPolicy } }",
  );
  const before = JSON.stringify(ast);
  const query = bindAssociations(ast, [
    { this: "urn:plan", ownerSystem: "urn:a", budgetPolicy: "urn:budget" },
    { this: "urn:plan", ownerSystem: "urn:b", budgetPolicy: undefined },
  ]);
  assert.equal(JSON.stringify(ast), before);
  assert.equal((query.match(/VALUES/g) ?? []).length, 3);
  assert(query.includes("UNDEF"));
  assert.throws(
    () => bindAssociations(ast, [{ this: "urn:p", ownerSystem: "bad" }]),
    ShaclQueryError,
  );
  assert.throws(
    () => bindAssociations(ast, [{ this: "urn:p", unknown: "urn:q" }]),
    ShaclQueryError,
  );
  assert.doesNotThrow(() =>
    admitSelect(
      'SELECT ?this WHERE { BIND("SERVICE MINUS" AS ?text) FILTER(?this = <urn:SERVICE>) }',
    )
  );
});

Deno.test("each association requires a bound focus IRI", () => {
  const ast = admitSelect("SELECT ?this WHERE {}");
  for (
    const association of [
      {},
      { this: undefined },
      { ownerSystem: "urn:owner" },
      Object.create({ this: "urn:focus" }),
    ]
  ) {
    assert.throws(() => bindAssociations(ast, [association]), {
      code: "SHACL_FOCUS_INVALID",
    });
  }
  assert.doesNotThrow(() => bindAssociations(ast, [{ this: "urn:focus" }]));
  assert.doesNotThrow(() => bindAssociations(ast, []));
});

Deno.test("association subqueries cannot discard an owner before rejoining the shared focus", () => {
  const rows = [{ this: "urn:plan", ownerSystem: "urn:owner" }];
  assert.throws(
    () =>
      bindAssociations(
        admitSelect(
          "SELECT ?this ?ownerSystem WHERE { { SELECT ?this WHERE {} } }",
        ),
        rows,
      ),
    ShaclQueryError,
  );
  assert.doesNotThrow(() =>
    bindAssociations(
      admitSelect(
        "SELECT ?this ?ownerSystem WHERE { { SELECT ?this ?ownerSystem WHERE {} } }",
      ),
      rows,
    )
  );
});
