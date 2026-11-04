import { isPlainRecord as isRecord } from "../../../domain/primitives/is-plain-record.ts";
import { reviewSchema } from "./output-validation.ts";

/** Only host-authored categories may cross the provider boundary. */
export class ProviderCallError extends Error {}

/** API schema subset: local Ajv still enforces all original constraints. */
function providerSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(providerSchema);
  if (!isRecord(value)) return value;
  // Claude requires closed objects. Transport a dynamic source-file map as
  // path/content entries, then validate the canonical map with the same Ajv gate.
  if (
    value.type === "object" && isRecord(value.additionalProperties) &&
    !value.properties
  ) {
    return {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: providerSchema(value.additionalProperties),
        },
        required: ["path", "content"],
      },
    };
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "pattern",
        "minItems",
        "maxItems",
        "uniqueItems",
        "minProperties",
        "maxProperties",
        "propertyNames",
      ]
        .includes(key)
    ) continue;
    if (key === "type" && "oneOf" in value) continue;
    result[key === "oneOf" ? "anyOf" : key] = providerSchema(child);
  }
  return result;
}

export function canonicalProviderResult(value: unknown): unknown {
  if (
    !isRecord(value) || value.kind !== "propose_sysml_revision" ||
    !Array.isArray(value.sources)
  ) return value;
  const sources: Record<string, string> = Object.create(null);
  if (value.sources.length < 1 || value.sources.length > 16) {
    throw new ProviderCallError(
      `invalid source file count: expected 1 to 16, got ${value.sources.length}`,
    );
  }
  for (const entry of value.sources) {
    if (
      !isRecord(entry) || Object.keys(entry).length !== 2 ||
      typeof entry.path !== "string" || typeof entry.content !== "string" ||
      Object.hasOwn(sources, entry.path)
    ) {
      throw new ProviderCallError("invalid source file entries");
    }
    sources[entry.path] = entry.content;
  }
  return { ...value, sources };
}
/** One non-strict native tool per authorized decision kind; never `strict: true`. */
export interface ProviderToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
}

export const REVIEW_TOOL = "review_decision";

const TOOL_DESCRIPTIONS: Record<string, string> = {
  resume_request:
    "Resume an exact listed Request with a stable resume identity; optional operatorId selects an admitted branch team member, otherwise its Branch Operator.",
  open_request:
    "Open a Request in its own Case branch, from current main or an exact listed Release, under your open-request act; the branch's operator is the source's Request owner.",
  reply: "Répondre à la personne et terminer ce tour.",
  consult_model:
    "Consult the model using only operations advertised in modelTools. Prefer search, inspect and query for bounded discovery; use read_source only when the task needs the complete file, especially before a full-file revision.",
  propose_tool:
    "Proposer un nouvel outil JavaScript autonome à tester puis admettre.",
  invoke_tool: "Invoquer un outil actif du catalogue pour lire une page.",
  invoke_behavior:
    "Invoque un comportement exposé par la fiche du pin courant. Utilise exactement behaviors[].id, jamais son nom.",
  propose_mandate_change:
    "Proposer un changement de mandat parmi les droits supportés.",
  decide_operator_change:
    "Décider, sous une politique d'autorité accordée par la personne, la demande enregistrée d'un opérateur que cette politique couvre exactement.",
  inspect_operator_candidate:
    "Inspecter un seul candidat testé couvert par l’octroi d’admission, avec son code, contrat et ses essais comme données.",
  decide_operator_candidate:
    "Approuver ou refuser, après inspection exacte, le candidat d’un autre operator sous l’octroi d’admission accordé par la personne.",
  prepare_operator_evolution:
    "Prepare an exact behavior revision under prior native evolution and source-edit grants.",
  decide_operator_evolution:
    "Record separate acceptance or pre-publication cancellation of an exact evolution dossier.",
  adopt_operator_evolution:
    "Authorize exact adoption and return immediately; host finalization follows safe contribution checkpoints.",
  propose_sysml_revision:
    "Proposer une révision SysML en fichiers complets, à examiner. sources est une liste de 1 à 16 couples {path, content} aux chemins distincts, sans autre champ.",
  propose_sysml_edit:
    "Proposer une édition SysML ciblée sur des éléments exacts.",
  propose_model_delegation:
    "Proposer l'octroi ou la révocation d'une délégation d'édition de modèle.",
  propose_agent_creation:
    "Propose an operator with its closed specification allowed by the current host context, or a reviewer with its exact mandate.",
  [REVIEW_TOOL]:
    "Rendre le verdict d'examen ou d'admission pour le candidat exact fourni.",
};

export const BATCH_DIRECTIVE =
  "Transport: réponds uniquement en appelant entre 1 et 8 outils autorisés. Le nom de chaque outil détermine sa décision ; conserve des identifiants distincts. Un seul reply est permis, en dernière position. Ne produis aucun JSON hors des appels. Si le groupe est refusé, corrige le groupe entier avant de rappeler les outils autorisés.";

export const TOOL_DIRECTIVE =
  "Transport: réponds uniquement en appelant exactement un outil parmi ceux fournis; le nom de l'outil appelé est la décision. Ne produis aucun texte libre ni JSON hors de cet appel. Si un résultat d'outil en erreur t'est renvoyé, corrige l'entrée selon son code et rappelle exactement un outil autorisé.";

type ProviderSchemaVariant = {
  properties?: Record<string, unknown>;
  required?: unknown;
  [key: string]: unknown;
};

function variantWithoutKind(
  variant: ProviderSchemaVariant,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variant.properties ?? {})) {
    if (key !== "kind") properties[key] = value;
  }
  const required = (Array.isArray(variant.required) ? variant.required : [])
    .filter((entry) => entry !== "kind");
  return { ...variant, properties, required };
}

/** Merge same-kind variants (propose_agent_creation) into one tool; Ajv stays authoritative. */
function mergeVariants(
  variants: ProviderSchemaVariant[],
): Record<string, unknown> {
  if (variants.length === 1) return variantWithoutKind(variants[0]!);
  const stripped = variants.map(variantWithoutKind);
  const properties: Record<string, unknown> = {};
  for (const variant of stripped) {
    for (
      const [key, value] of Object.entries(
        (variant.properties ?? {}) as Record<string, unknown>,
      )
    ) {
      const previous = properties[key];
      if (previous === undefined) {
        properties[key] = value;
      } else if (
        isRecord(previous) && isRecord(value) && "const" in previous &&
        "const" in value && previous.const !== value.const
      ) {
        properties[key] = { enum: [previous.const, value.const] };
      } else if (
        isRecord(previous) && Array.isArray(previous.enum) && isRecord(value) &&
        "const" in value && !previous.enum.includes(value.const)
      ) {
        properties[key] = { enum: [...previous.enum, value.const] };
      }
    }
  }
  const required = (stripped[0]!.required as string[]).filter((entry) =>
    stripped.every((variant) => (variant.required as string[]).includes(entry))
  );
  return { type: "object", additionalProperties: false, properties, required };
}

/**
 * Build the native tools for one already-filtered decision schema (or the
 * single review schema). Order is the schema's variant order, so the cached
 * prefix is deterministic for a given authorization context.
 */
export function buildProviderTools(schema: object): ProviderToolDefinition[] {
  if (schema === reviewSchema) {
    return [{
      name: REVIEW_TOOL,
      description: TOOL_DESCRIPTIONS[REVIEW_TOOL]!,
      input_schema: providerSchema(reviewSchema) as Record<string, unknown>,
    }];
  }
  const memberSchema = batchMemberSchema(schema) ?? schema;
  const oneOf = (memberSchema as { oneOf?: unknown }).oneOf;
  if (!Array.isArray(oneOf)) {
    throw new ProviderCallError("unsupported schema shape");
  }
  const grouped = new Map<string, ProviderSchemaVariant[]>();
  for (const entry of oneOf) {
    if (!isRecord(entry) || !isRecord(entry.properties)) {
      throw new ProviderCallError("unsupported schema shape");
    }
    const kind = isRecord(entry.properties.kind)
      ? entry.properties.kind.const
      : undefined;
    if (typeof kind !== "string" || !kind) {
      throw new ProviderCallError("unsupported schema shape");
    }
    const variants = grouped.get(kind) ?? [];
    variants.push(entry as ProviderSchemaVariant);
    grouped.set(kind, variants);
  }
  return [...grouped.entries()].map(([kind, variants]) => ({
    name: kind,
    description: TOOL_DESCRIPTIONS[kind] ??
      `Retourner la décision ${kind}.`,
    input_schema: providerSchema(mergeVariants(variants)) as Record<
      string,
      unknown
    >,
  }));
}

export function batchMemberSchema(schema: object): object | undefined {
  const properties =
    (schema as { properties?: Record<string, unknown> }).properties;
  const calls = properties?.calls;
  if (
    !isRecord(calls) || !isRecord(calls.items) ||
    !isRecord(calls.items.properties)
  ) return undefined;
  const decision = calls.items.properties.decision;
  return isRecord(decision) ? decision : undefined;
}

export function boundedDetail(text: string): string {
  return text.length > 1500 ? text.slice(0, 1500) : text;
}

export function ajvDetail(
  errors:
    | readonly { instancePath?: string; message?: string; keyword?: string }[]
    | null
    | undefined,
): string {
  return boundedDetail(
    (errors ?? []).slice(0, 8).map((error) =>
      `${error.instancePath || "/"} ${
        error.message ?? error.keyword ?? "invalid"
      }`
    ).join("; ") || "schema validation failed",
  );
}
