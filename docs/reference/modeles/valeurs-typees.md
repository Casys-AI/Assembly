# Native model values

`sourceValues` projects values from the native graph without evaluating SysML
expressions. This read complements `sourceLiterals`; it changes neither its
scalar encoding nor the serialization of historical artifacts.

## Entries and values

An entry identifies the owner, member name, `featureId`, `featureValueId`,
`expressionId`, native types and source position when available. Its
multiplicity is `single`, `many` or `unknown`.

| Form                   | Interpretation                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scalar                 | `LiteralString`, `LiteralBoolean`, `LiteralInteger` or `LiteralReal`; value encoded as a string as in `sourceLiterals`                                |
| Enumeration            | `FeatureReferenceExpression` targeting an `EnumerationUsage` owned by an `EnumerationDefinition`; enumeration identity and literal spelling preserved |
| Reference              | Native identity and qualified name of the target; a reference is not converted into a business string                                                 |
| Sequence               | Comma operator; scalar or enumerated elements, nested sequences flattened in order                                                                    |
| Empty sequence         | `NullExpression`, corresponding to `()`                                                                                                               |
| Unsupported expression | `unsupported` with its reason, never silently dropped                                                                                                 |

The absence of a `FeatureValue` means no value is declared. A relation that does
not identify exactly one resolved member is refused. Several values on the same
member produce an unsupported entry, with the affected identities.

Toolkit 0.10.10 preserves only two entries in `argument` for some comma
expressions with more than two arguments. The reader then reconstructs the
sequence through the ordered `input` features and their `FeatureValue`. An
ordering mismatch is refused. Unknown references and expressions within a
sequence are refused, without producing a partial result.

## Multiplicity

`sourceMultiplicityReader` follows explicit bounds, redefinitions, subsets and
typings. A local bound takes precedence; several inherited restrictions are
intersected. The `[1..1]` default applies only to structural usages owned by a
definition or usage, without an explicit subset or redefinition. A package
member does not receive this default.

An unknown multiplicity prevents legacy reads that require a single-valued
string. Handling implicitly single-valued connection ends remains follow-up work
in work package 2, before a policy depends on it.

## Policy readers

`sourceValueReaders` looks for an exact name within an exact owner:

- `natural` requires a single-valued native integer literal, typed by
  `ScalarValues::Natural`, nonnegative and representable as a safe integer;
- `stringList` preserves the order, duplicates and empty strings of a native
  sequence;
- `enumValue` preserves the literal spelling and can check the expected
  enumeration identity and vocabulary.

Compatibility with a JSON list stored in a `String` requires the
`legacy: "json"` option. For a legacy enumeration, `legacy: "literal"` is also
possible. The consumer chooses this encoding; the reader does not infer it from
the content. The member must be a single-valued `ScalarValues::String`. A legacy
string is not assigned an invented enumeration identity.

`SourceValueReadError` errors carry one of the codes `MISSING_VALUE`,
`DUPLICATE_VALUE`, `UNSUPPORTED_VALUE`, `INVALID_TYPE`, `INVALID_JSON`,
`ENUM_MISMATCH` or `INVALID_ENUM_LITERAL`, with the member and its available
location. A missing, ambiguous or unreadable value never becomes a default
policy value.

## Scope and sources

As of 25 October 2026, `compileCaseTypes` uses these readers. Their availability
does not mean that network, editing, administration, skill or memory policies
have stopped using JSON strings. Those migrations remain open.

- [Entry projection](../../../src/domain/model/projections/source-values.ts):
  `sourceValues`.
- [Native expressions](../../../src/domain/model/value-objects/expressions.ts):
  `SourceValue` and `sourceExpressionReader`.
- [Multiplicities](../../../src/domain/model/value-objects/multiplicity.ts):
  `sourceMultiplicityReader`.
- [Readers and errors](../../../src/domain/model/value-objects/readers.ts):
  `sourceValueReaders` and `SourceValueReadError`.
- Existing Toolkit tests:
  [values](../../../test/integration/source-values_test.ts),
  [regressions](../../../test/integration/source-values-regression_test.ts) and
  [multiplicities](../../../test/integration/source-value-multiplicity_test.ts).
  This page describes the code; it does not constitute a new execution of these
  tests.
