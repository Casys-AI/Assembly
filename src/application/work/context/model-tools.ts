import type {
  ModelContextCapabilities,
  ModelContextOperation,
} from "../../../domain/model/consultation/context.ts";

/** Descriptive contracts for the host's standard model consultation service.
 * Their presence is decided by the host from the caller's existing authority. */
export interface ModelContextTool {
  id: string;
  name: string;
  description: string;
  operation:
    | ModelContextOperation
    | "unload_sources"
    | "query"
    | "network_impact";
  inputSchema: Record<string, unknown>;
}

const modelToolDescriptions: Array<
  Pick<ModelContextTool, "operation" | "name" | "description">
> = [
  {
    operation: "search",
    name: "Rechercher dans le modèle",
    description:
      "Rechercher les identifiants, noms et métaclasses à une version source exacte. Les résultats sont paginés ; query omis parcourt le catalogue.",
  },
  {
    operation: "inspect",
    name: "Inspecter un élément du modèle",
    description:
      "Lire la déclaration exacte et les voisins du graphe épinglé. graph sélectionne direction out/in, property, limit (20 par défaut, 50 maximum) et cursor ; cette pagination est indépendante de offset/limit des sources. Un index indisponible produit un refus codé.",
  },
  {
    operation: "references",
    name: "Consulter les références du modèle",
    description:
      "Lister les relations normalisées et les voisins du graphe épinglé. graph sélectionne direction (in par défaut), property, limit et cursor ; suivre nextCursor avec les mêmes version/cible/filtres.",
  },
  {
    operation: "read_source",
    name: "Lire un fichier source du modèle",
    description:
      "Lire une page exacte d’un fichier SysML à la version consultée, avec son empreinte. offset et limit comptent les unités UTF-16 ; suivre next jusqu’à son absence avant de remplacer le fichier complet. Le fichier exact reste chargé pour l’édition.",
  },
  {
    operation: "unload_sources",
    name: "Décharger les sources du contexte",
    description:
      "Retirer un fichier du contexte de travail de cette demande ; omettre path pour tous les décharger. Cette opération ne modifie aucune source du modèle.",
  },
  {
    operation: "query",
    name: "Interroger le modèle",
    description:
      "Interroger la version source exacte : mode toolkit (défaut) évalue le KerML existant ; mode sparql exécute SELECT/ASK sur le graphe RDF épinglé (jointures, filtres, agrégats ; 4096 caractères, 50 bindings, 64 KiB, 5 s). Classes et propriétés SysML : https://www.omg.org/spec/SysML# ; identités et listes ordonnées : extensions urn:ase:vocab:. Aucun repli entre modes, écriture, SERVICE ou dataset client.",
  },
];

/** Return independent, serializable contracts, without executable callbacks. */
export function modelContextTools(
  capabilities: ModelContextCapabilities = {},
): ModelContextTool[] {
  const tools: ModelContextTool[] = modelToolDescriptions.map((descriptor) => {
    const properties: Record<string, unknown> = {
      operation: { type: "string", const: descriptor.operation },
      version: {
        type: "string",
        pattern: "^(?:branch|commit):[A-Za-z0-9_-]{1,120}$",
      },
    };
    const required = ["operation", "version"];
    if (["search", "inspect", "references"].includes(descriptor.operation)) {
      properties.offset = { type: "integer", minimum: 0, maximum: 1_000_000 };
      properties.limit = { type: "integer", minimum: 1, maximum: 50 };
    }
    if (descriptor.operation === "search") {
      properties.query = { type: "string", maxLength: 200 };
    }
    if (descriptor.operation === "query") {
      properties.mode = { type: "string", enum: ["toolkit", "sparql"] };
      properties.expression = {
        type: "string",
        minLength: 1,
        maxLength: 4096,
      };
      required.push("expression");
    }
    if (["inspect", "references"].includes(descriptor.operation)) {
      properties.elementId = { type: "string", minLength: 1, maxLength: 512 };
      required.push("elementId");
      properties.graph = {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["out", "in"] },
          property: { type: "string", minLength: 1, maxLength: 512 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          cursor: { type: "string", minLength: 1, maxLength: 8192 },
        },
        additionalProperties: false,
      };
    }
    if (descriptor.operation === "inspect") {
      properties.includeReferenceSites = { type: "boolean" };
    }
    if (["read_source", "unload_sources"].includes(descriptor.operation)) {
      properties.path = { type: "string", minLength: 1, maxLength: 240 };
      if (descriptor.operation === "read_source") required.push("path");
    }
    if (descriptor.operation === "read_source") {
      properties.offset = { type: "integer", minimum: 0, maximum: 1_000_000 };
      properties.limit = { type: "integer", minimum: 1, maximum: 8192 };
    }
    return {
      ...descriptor,
      id: `model.${descriptor.operation}`,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    };
  });
  if (capabilities.networkImpact) {
    const pin = {
      operation: { type: "string", const: "network_impact" },
      version: {
        type: "string",
        pattern: "^(?:branch|commit):[A-Za-z0-9_-]{1,120}$",
      },
    };
    tools.push({
      id: "model.network_impact",
      operation: "network_impact",
      name: "Analyser l’impact réseau entre versions",
      description:
        "Comparer les versions immuables d’un opérateur dans son propre historique, pour un hôte exact. Retourne un résumé et une référence temporaire ; details pagine versions, transitions, témoins, observations et incertitudes. Les routes web et skills restent indépendantes ; une absence de preuve ne démontre jamais zéro accès. " +
        `Bornes effectives de l’hôte : ${
          JSON.stringify(capabilities.networkImpact)
        }.`,
      inputSchema: {
        oneOf: [{
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
        }, {
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
            limit: {
              type: "integer",
              minimum: 1,
              maximum: capabilities.networkImpact.maxPageSize,
            },
          },
          required: ["operation", "version", "action", "analysisRef", "view"],
          additionalProperties: false,
        }],
      },
    });
  }
  return structuredClone(tools);
}
