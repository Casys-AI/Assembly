/** AST admission and recursive VALUES prebinding adapted from the Casys
 * openclaw-sysmlv2-export SHACL query module (2026-11-04).
 * Only the query transformation is reused; no synchronous/WASM store. */
// @deno-types="@types/sparqljs"
import Sparql from "sparqljs";
// @deno-types="@types/sparqljs"
import type {
  ConstructQuery,
  Expression,
  IriTerm,
  Pattern,
  SelectQuery,
  SparqlQuery,
  ValuesPattern,
} from "sparqljs";

/** Admission errors become causes of the caller's contextual validation error. */
export class ShaclQueryError extends Error {
  constructor(
    readonly code:
      | "SHACL_QUERY_PARSE"
      | "SHACL_QUERY_UNSUPPORTED"
      | "SHACL_FOCUS_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ShaclQueryError";
  }
}

export type AdmittedSelect = SelectQuery;
const prebound = new Set([
  "this",
  "ownerSystem",
  "budgetPolicy",
  "allowedHostsAttribute",
  "networkHostsAttribute",
]);
const nondeterministic = new Set(["rand", "uuid", "struuid", "now", "bnode"]);

function unsupported(message: string): never {
  throw new ShaclQueryError("SHACL_QUERY_UNSUPPORTED", message);
}

// SPARQLjs emits decoded IRI terms inside <...>. Validate these terms before
// generation, including escaped IRIs in the source and supplied focus IRIs.
function safeIri(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) &&
    !/[<>"{}|^`\\]/u.test(value) &&
    !Array.from(value).some((c) => {
      const code = c.codePointAt(0)!;
      return code <= 0x20 || (code >= 0x7f && code <= 0x9f) ||
        (code >= 0xd800 && code <= 0xdfff);
    });
}

function checkValues(
  rows: Record<string, unknown>[],
  focusBound: boolean,
): void {
  // SPARQLjs discards an empty table's variable header. Conservatively reject
  // all such tables so VALUES ?this {} cannot evade the prebinding restriction.
  if (rows.length === 0) unsupported("Empty VALUES tables are unsupported");
  if (
    focusBound &&
    rows.some((row) =>
      Object.keys(row).some((key) => prebound.has(key.slice(1)))
    )
  ) {
    unsupported("VALUES must not mention the pre-bound variable this");
  }
}

function checkAst(value: unknown, focusBound: boolean): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => checkAst(entry, focusBound));
    return;
  }
  const node = value as Record<string, unknown>;
  if (node.termType === "NamedNode" && !safeIri(String(node.value))) {
    unsupported("Query contains an unsafe or non-absolute IRI");
  }
  if (node.type === "query") {
    const query = value as SelectQuery;
    if (
      node.queryType === "CONSTRUCT" &&
      (value as ConstructQuery).template?.some((triple) =>
        [triple.subject, triple.object].some((term) =>
          term.termType === "BlankNode"
        )
      )
    ) {
      unsupported(
        "Generated blank nodes in CONSTRUCT templates are unsupported",
      );
    }
    if (focusBound && node.queryType !== "SELECT") {
      unsupported("Expected a SELECT query");
    }
    if (
      focusBound &&
      !query.variables.some((v) =>
        "termType" in v &&
        v.termType === "Variable" && v.value === "this"
      )
    ) {
      unsupported("Every SELECT must explicitly project the variable this");
    }
    if (query.from) unsupported("Dataset clauses are unsupported");
    if (query.group !== undefined || query.having !== undefined) {
      unsupported("GROUP BY and HAVING are unsupported in batched constraints");
    }
    if (query.limit !== undefined || query.offset !== undefined) {
      unsupported("LIMIT and OFFSET are unsupported in batched constraints");
    }
    if (query.values) checkValues(query.values, focusBound);
    for (const iri of Object.values(query.prefixes ?? {})) {
      if (!safeIri(iri)) unsupported("Unsafe or non-absolute prefix IRI");
    }
    if (query.base && !safeIri(query.base)) unsupported("Unsafe base IRI");
  }
  if (node.type === "minus" || node.type === "service") {
    unsupported(`${String(node.type).toUpperCase()} is unsupported`);
  }
  if (node.type === "values") {
    checkValues(node.values as Record<string, unknown>[], focusBound);
  }
  const variable = node.variable as
    | { termType?: string; value?: string }
    | undefined;
  if (
    focusBound && node.expression && variable?.termType === "Variable" &&
    prebound.has(variable.value ?? "")
  ) {
    unsupported("AS this must not reassign the pre-bound variable");
  }
  if (focusBound && node.type === "aggregate") {
    unsupported("Aggregates are unsupported in batched constraints");
  }
  if (node.type === "functionCall") {
    unsupported("IRI function calls are unsupported");
  }
  if (
    node.type === "operation" &&
    nondeterministic.has(String(node.operator).toLowerCase())
  ) {
    unsupported(
      `Nondeterministic function ${String(node.operator)} is unsupported`,
    );
  }
  Object.values(node).forEach((entry) => checkAst(entry, focusBound));
}

function parse(
  source: string,
  prefixes: Readonly<Record<string, string>>,
): SparqlQuery {
  try {
    return new Sparql.Parser({ prefixes: { ...prefixes } }).parse(source);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ShaclQueryError(
      "SHACL_QUERY_PARSE",
      `Invalid SPARQL query: ${message}`,
      { cause },
    );
  }
}

/**
 * Parse and admit once. This is an explicit SPARQL 1.1 subset for SHACL 1.2
 * prebinding, not a complete SHACL-SPARQL implementation. Unknown syntax fails.
 * SELECT * (also in subqueries), dataset clauses, GROUP BY/HAVING, aggregates, slicing, custom
 * functions, and nondeterministic functions are outside this batched profile.
 */
export function admitSelect(
  source: string,
  prefixes: Readonly<Record<string, string>> = {},
): AdmittedSelect {
  const parsed = parse(source, prefixes);
  if (parsed.type !== "query" || parsed.queryType !== "SELECT") {
    unsupported("Expected a SELECT query");
  }
  checkAst(parsed, true);
  return parsed;
}

function bindExpression(expression: Expression, table: ValuesPattern): void {
  if (Array.isArray(expression)) {
    expression.forEach((e) => bindExpression(e, table));
  } else if ("type" in expression && expression.type === "operation") {
    if (
      expression.operator === "exists" || expression.operator === "notexists"
    ) {
      expression.args = [{
        type: "group",
        patterns: bindScope(expression.args as Pattern[], table),
      }];
    } else {
      expression.args.forEach((e) => bindExpression(e as Expression, table));
    }
  }
}

function bindPattern(pattern: Pattern, table: ValuesPattern): Pattern {
  if (pattern.type === "query") {
    bindQuery(pattern, table);
    // A SELECT must be the sole member of its syntactic group. The surrounding
    // scope's inserted VALUES therefore needs an additional enclosing group.
    return { type: "group", patterns: [pattern] };
  } else if (pattern.type === "union") {
    // Each entry is a UNION branch, sometimes a lone FILTER/BGP rather than a
    // group. Inserting an additional entry would create an additional branch.
    pattern.patterns = pattern.patterns.map((branch) => ({
      type: "group",
      patterns: bindScope([branch], table),
    }));
  } else if ("patterns" in pattern) {
    pattern.patterns = bindScope(pattern.patterns, table);
  } else if (pattern.type === "bind" || pattern.type === "filter") {
    bindExpression(pattern.expression, table);
  }
  return pattern;
}

function bindScope(patterns: Pattern[], table: ValuesPattern): Pattern[] {
  return [table, ...patterns.map((p) => bindPattern(p, table))];
}

function bindQuery(query: SelectQuery, table: ValuesPattern): void {
  query.where = bindScope(query.where ?? [], table);
  for (const variable of query.variables) {
    if ("expression" in variable) bindExpression(variable.expression, table);
  }
  for (const order of query.order ?? []) {
    bindExpression(order.expression, table);
  }
}

/**
 * Compile one query for all unique focus IRIs, with no per-focus query fallback.
 * VALUES appears at every independent pattern scope: outer-only insertion does
 * not prebind nested FILTER/UNION/subselects (W3C pre-binding 002/003/005/007).
 * Blank nodes and literals are explicitly outside the native-focus profile.
 */
export function bindAssociations(
  compiled: AdmittedSelect,
  associations: readonly Readonly<Record<string, string | undefined>>[],
): string {
  for (const association of associations) {
    if (
      !Object.hasOwn(association, "this") ||
      typeof association.this !== "string" || !safeIri(association.this)
    ) {
      throw new ShaclQueryError(
        "SHACL_FOCUS_INVALID",
        "Each association requires a safe absolute focus IRI",
      );
    }
  }
  const names = new Set(
    associations.flatMap((association) => Object.keys(association)),
  );
  const checkSubqueries = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(checkSubqueries);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "query") {
      const projected = new Set(
        (value as SelectQuery).variables.flatMap((variable) =>
          "termType" in variable && variable.termType === "Variable"
            ? [variable.value]
            : []
        ),
      );
      if ([...names].some((name) => !projected.has(name))) {
        unsupported(
          "Subqueries must preserve every prebound association parameter",
        );
      }
    }
    Object.values(node).forEach(checkSubqueries);
  };
  // Losing an owner in a subquery would join one owner's findings to every
  // exposure of the same focus node. Only the outer report may omit parameters.
  checkSubqueries(compiled.where);
  const values = associations.map((association) => {
    const row: Record<string, IriTerm | undefined> = {};
    for (const [name, value] of Object.entries(association)) {
      if (
        !prebound.has(name) ||
        (name !== "this" && value !== undefined &&
          (typeof value !== "string" || !safeIri(value)))
      ) {
        throw new ShaclQueryError(
          "SHACL_FOCUS_INVALID",
          "Bindings must use safe absolute IRIs and admitted parameter names",
        );
      }
      row[`?${name}`] = value === undefined ? undefined : {
        termType: "NamedNode",
        value,
        equals: (other) =>
          other?.termType === "NamedNode" && other.value === value,
      };
    }
    return row;
  });
  const query = structuredClone(compiled);
  bindQuery(query, { type: "values", values });
  return new Sparql.Generator().stringify(query);
}

export function bindFocus(
  compiled: AdmittedSelect,
  focusIris: readonly string[],
): string {
  return bindAssociations(
    compiled,
    [...new Set(focusIris)].map((value) => ({ this: value })),
  );
}
