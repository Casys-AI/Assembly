import type { BuildRef } from "../../../../domain/model/value-objects/element-ref.ts";

/** JSON-only RDF term; adapters convert to/from RDFJS terms. */
export type RdfTermDto =
  | { readonly kind: "iri"; readonly value: string }
  | { readonly kind: "blank"; readonly value: string }
  | {
    readonly kind: "literal";
    readonly value: string;
    readonly datatype: string;
    readonly language?: string;
  };

export interface RdfQuadDto {
  readonly subject: RdfTermDto;
  /** Predicate IRIs are always IRIs. */
  readonly predicate: string;
  readonly object: RdfTermDto;
  readonly graph?: string;
}

export type SemanticQueryResult =
  | {
    readonly form: "solutions";
    readonly variables: readonly string[];
    readonly rows: readonly Readonly<Record<string, RdfTermDto>>[];
    readonly truncated: boolean;
  }
  | { readonly form: "boolean"; readonly value: boolean }
  | {
    readonly form: "graph";
    readonly quads: readonly RdfQuadDto[];
    readonly truncated: boolean;
  };

export interface SemanticQueryLimits {
  readonly maxResults: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export interface SemanticQueryRequest {
  readonly build: BuildRef;
  readonly sparql: string;
  readonly limits?: Partial<SemanticQueryLimits>;
}
