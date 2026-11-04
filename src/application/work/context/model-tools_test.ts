import { deepStrictEqual, equal, notStrictEqual } from "node:assert/strict";
import { modelContextTools } from "./model-tools.ts";
import { DEFAULT_NETWORK_IMPACT_LIMITS } from "../../../domain/model/consultation/network-impact.ts";

// Characterization (R14 C0, moved with the catalog in R14 B5): pins the exact
// provider-facing catalog. The French texts and schemas are model-visible bytes.

const versionPattern = "^(?:branch|commit):[A-Za-z0-9_-]{1,120}$";
const page = {
  offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
  limit: { type: "integer", minimum: 1, maximum: 50 },
};
const graph = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["out", "in"] },
    property: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    cursor: { type: "string", minLength: 1, maxLength: 8192 },
  },
  additionalProperties: false,
};

Deno.test("the default catalog is exactly the six model tools, in order", () => {
  deepStrictEqual(modelContextTools(), [
    {
      operation: "search",
      name: "Rechercher dans le modèle",
      description:
        "Rechercher les identifiants, noms et métaclasses à une version source exacte. Les résultats sont paginés ; query omis parcourt le catalogue.",
      id: "model.search",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", const: "search" },
          version: { type: "string", pattern: versionPattern },
          ...page,
          query: { type: "string", maxLength: 200 },
        },
        required: ["operation", "version"],
        additionalProperties: false,
      },
    },
    {
      operation: "inspect",
      name: "Inspecter un élément du modèle",
      description:
        "Lire la déclaration exacte et les voisins du graphe épinglé. graph sélectionne direction out/in, property, limit (20 par défaut, 50 maximum) et cursor ; cette pagination est indépendante de offset/limit des sources. Un index indisponible produit un refus codé.",
      id: "model.inspect",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", const: "inspect" },
          version: { type: "string", pattern: versionPattern },
          ...page,
          elementId: { type: "string", minLength: 1, maxLength: 512 },
          graph,
          includeReferenceSites: { type: "boolean" },
        },
        required: ["operation", "version", "elementId"],
        additionalProperties: false,
      },
    },
    {
      operation: "references",
      name: "Consulter les références du modèle",
      description:
        "Lister les relations normalisées et les voisins du graphe épinglé. graph sélectionne direction (in par défaut), property, limit et cursor ; suivre nextCursor avec les mêmes version/cible/filtres.",
      id: "model.references",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", const: "references" },
          version: { type: "string", pattern: versionPattern },
          ...page,
          elementId: { type: "string", minLength: 1, maxLength: 512 },
          graph,
        },
        required: ["operation", "version", "elementId"],
        additionalProperties: false,
      },
    },
    {
      operation: "read_source",
      name: "Lire un fichier source du modèle",
      description:
        "Lire une page exacte d’un fichier SysML à la version consultée, avec son empreinte. offset et limit comptent les unités UTF-16 ; suivre next jusqu’à son absence avant de remplacer le fichier complet. Le fichier exact reste chargé pour l’édition.",
      id: "model.read_source",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", const: "read_source" },
          version: { type: "string", pattern: versionPattern },
          path: { type: "string", minLength: 1, maxLength: 240 },
          offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
          limit: { type: "integer", minimum: 1, maximum: 8192 },
        },
        required: ["operation", "version", "path"],
        additionalProperties: false,
      },
    },
    {
      operation: "unload_sources",
      name: "Décharger les sources du contexte",
      description:
        "Retirer un fichier du contexte de travail de cette demande ; omettre path pour tous les décharger. Cette opération ne modifie aucune source du modèle.",
      id: "model.unload_sources",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", const: "unload_sources" },
          version: { type: "string", pattern: versionPattern },
          path: { type: "string", minLength: 1, maxLength: 240 },
        },
        required: ["operation", "version"],
        additionalProperties: false,
      },
    },
    {
      operation: "query",
      name: "Interroger le modèle",
      description:
        "Interroger la version source exacte : mode toolkit (défaut) évalue le KerML existant ; mode sparql exécute SELECT/ASK sur le graphe RDF épinglé (jointures, filtres, agrégats ; 4096 caractères, 50 bindings, 64 KiB, 5 s). Classes et propriétés SysML : https://www.omg.org/spec/SysML# ; identités et listes ordonnées : extensions urn:ase:vocab:. Aucun repli entre modes, écriture, SERVICE ou dataset client.",
      id: "model.query",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", const: "query" },
          version: { type: "string", pattern: versionPattern },
          mode: { type: "string", enum: ["toolkit", "sparql"] },
          expression: { type: "string", minLength: 1, maxLength: 4096 },
        },
        required: ["operation", "version", "expression"],
        additionalProperties: false,
      },
    },
  ]);
  equal(modelContextTools({}).length, 6);
});

Deno.test("the network capability appends exactly one bounded tool", () => {
  const tools = modelContextTools({
    networkImpact: {
      scope: "own-history",
      limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
      maxPageSize: 3,
      maxResponseCharacters: 12_000,
    },
  });
  equal(tools.length, 7);
  deepStrictEqual(tools.slice(0, 6), modelContextTools());
  const pin = {
    operation: { type: "string", const: "network_impact" },
    version: { type: "string", pattern: versionPattern },
  };
  deepStrictEqual(tools[6], {
    id: "model.network_impact",
    operation: "network_impact",
    name: "Analyser l’impact réseau entre versions",
    description:
      "Comparer les versions immuables d’un opérateur dans son propre historique, pour un hôte exact. Retourne un résumé et une référence temporaire ; details pagine versions, transitions, témoins, observations et incertitudes. Les routes web et skills restent indépendantes ; une absence de preuve ne démontre jamais zéro accès. " +
      'Bornes effectives de l’hôte : {"scope":"own-history","limits":{"maxVersions":32,"maxSnapshots":64,"maxRecords":10000,"maxPayloadBytes":16777216,"maxTotalBytes":134217728,"timeoutMs":30000},"maxPageSize":3,"maxResponseCharacters":12000}.',
    inputSchema: {
      oneOf: [
        {
          type: "object",
          properties: {
            ...pin,
            action: { type: "string", const: "compare" },
            operatorId: { type: "string", minLength: 1, maxLength: 1024 },
            host: { type: "string", minLength: 1, maxLength: 253 },
            fromVersion: { type: "string", pattern: "^commit:[a-f0-9]{40}$" },
            toVersion: { type: "string", pattern: "^commit:[a-f0-9]{40}$" },
          },
          required: [
            "operation",
            "version",
            "action",
            "operatorId",
            "host",
            "fromVersion",
            "toVersion",
          ],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            ...pin,
            action: { type: "string", const: "details" },
            analysisRef: { type: "string", minLength: 1, maxLength: 128 },
            view: {
              type: "string",
              enum: [
                "versions",
                "transitions",
                "witnesses",
                "evidence",
                "issues",
              ],
            },
            cursor: { type: "string", minLength: 1, maxLength: 256 },
            limit: { type: "integer", minimum: 1, maximum: 3 },
          },
          required: ["operation", "version", "action", "analysisRef", "view"],
          additionalProperties: false,
        },
      ],
    },
  });
});

Deno.test("each call returns independent contracts", () => {
  const first = modelContextTools();
  const second = modelContextTools();
  deepStrictEqual(first, second);
  notStrictEqual(first[0], second[0]);
  notStrictEqual(first[0]!.inputSchema, second[0]!.inputSchema);
  first[0]!.name = "mutated";
  (first[0]!.inputSchema.properties as Record<string, unknown>).injected = {};
  deepStrictEqual(modelContextTools(), second);
});
