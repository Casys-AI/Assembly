import type { StylesheetJson } from "cytoscape";

/**
 * Mécanisme arêtes structurelles : GraphController pose la classe
 * `structural` sur chaque arête quand la vue est structurelle
 * (interconnection/general). Le style ci-dessous route alors en taxi
 * orthogonal et masque le libellé par défaut ; `hl` (focus de sélection
 * du contrôleur) ou `:selected` le réaffiche. Les vues comportementales
 * ne reçoivent jamais la classe : leurs successions gardent Bézier et
 * leurs gardes restent toujours visibles.
 */
export const STRUCTURAL_EDGE_CLASS = "structural";
export const STRUCTURAL_VIEWS = ["interconnection", "general"] as const;
export function isStructuralView(view?: string | null): boolean {
  return (STRUCTURAL_VIEWS as readonly string[]).includes(view || "");
}

/** Native SysML visual grammar, applied only to this Cytoscape instance. */
export const graphStyle: StylesheetJson = [
  {
    selector: "node",
    style: {
      shape: "round-rectangle",
      width: 145,
      height: 44,
      "background-color": "#edf3f8",
      "border-color": "#748fa5",
      "border-width": 1.5,
      label: "data(label)",
      "text-wrap": "wrap",
      "text-max-width": "155px",
      "text-valign": "center",
      "font-size": 12,
      "font-weight": 600,
      color: "#243447",
      "min-zoomed-font-size": 0,
    },
  },
  {
    selector: "node.action",
    style: {
      "background-color": "#edf3f8",
      "border-color": "#819bb0",
      "text-max-width": "118px",
      width: 126,
      height: 42,
      "font-size": 13,
    },
  },
  {
    selector: "node.control",
    style: {
      shape: "diamond",
      width: 32,
      height: 32,
      "background-color": "#ffffff",
      "border-color": "#5f7d95",
      "border-width": 1.7,
      "text-valign": "center",
      "text-halign": "left",
      "text-margin-x": -14,
      "text-margin-y": 0,
      "text-max-width": "140px",
      "font-size": 12,
      "font-weight": 500,
    },
  },
  {
    selector: "node.endpoint",
    style: {
      shape: "ellipse",
      width: 17,
      height: 17,
      "background-color": "#315b7a",
      label: "",
    },
  },
  {
    selector: "node.part",
    style: {
      shape: "rectangle",
      width: 180,
      height: 80,
      "background-color": "#f2f6fa",
      "text-valign": "top",
      "text-margin-y": 28,
      "font-weight": 600,
    },
  },
  {
    selector: ":parent",
    style: {
      shape: "rectangle",
      "background-color": "#edf3f8",
      "background-opacity": .32,
      "border-color": "#819bb0",
      "border-width": 1.2,
      padding: "22px",
      "text-valign": "top",
      "text-margin-y": 22,
      "font-size": 11,
      "font-weight": 700,
      color: "#38536b",
      "min-width": "140px",
      "min-height": "0px",
    },
  },
  {
    selector: "node.native-view",
    style: {
      shape: "rectangle",
      "background-color": "#ffffff",
      "background-opacity": .1,
      "border-color": "#8b9eae",
      "border-width": 1.2,
      "border-style": "solid",
      padding: "28px",
      "text-valign": "top",
      "text-margin-y": 18,
      "font-size": 12,
      "font-weight": 600,
      "min-width": "0px",
      "min-height": "0px",
    },
  },
  {
    selector: "node.native-view.mandate-scope",
    style: {
      shape: "rectangle",
      "background-opacity": 0,
      "border-color": "#805514",
      "border-width": 1,
      "border-style": "dashed",
      "border-dash-pattern": [8, 4],
      color: "#29373b",
      padding: "38px",
      "text-max-width": "620px",
      "text-margin-y": 28,
      "text-justification": "left",
      "font-weight": 400,
    },
  },
  {
    selector: "node.native-context",
    style: {
      shape: "rectangle",
      "background-color": "#ffffff",
      "background-opacity": .1,
      "border-color": "#819bb0",
      "border-width": 1,
      "border-style": "dashed",
      padding: "22px",
      "text-valign": "top",
      "text-margin-y": 22,
      "font-size": 12,
      color: "#243447",
    },
  },
  {
    selector: "node.operator",
    style: { "background-color": "#e8c184", "border-color": "#805514" },
  },
  {
    selector: "node.overview:childless",
    style: {
      width: 180,
      height: 74,
      "text-valign": "center",
      "text-margin-y": 0,
      "font-size": 13,
      "text-max-width": "170px",
    },
  },
  {
    selector: "node.behavior-access:childless",
    style: {
      width: 180,
      height: 64,
      "text-valign": "center",
      "text-margin-y": 0,
    },
  },
  {
    selector: "node.general-action",
    style: {
      width: 126,
      height: 44,
      "font-size": 12,
      "text-max-width": "118px",
      "background-color": "#edf3f8",
      "border-color": "#819bb0",
    },
  },
  {
    selector: "node.general-result",
    style: {
      width: 145,
      height: 38,
      "font-size": 11,
      "text-max-width": "137px",
    },
  },
  {
    selector: "node.state",
    style: {
      width: 136,
      height: 44,
      "background-color": "#f4f0fb",
      "border-color": "#9c88ba",
      "font-size": 13,
    },
  },
  {
    selector: "node.state.endpoint",
    style: {
      shape: "ellipse",
      width: 17,
      height: 17,
      "background-color": "#315b7a",
      label: "",
    },
  },
  {
    selector: "node.observed-state",
    style: { "border-color": "#2a9d8f", "border-width": 3 },
  },
  {
    selector: "node.item",
    style: {
      shape: "rectangle",
      width: 140,
      height: 36,
      "background-color": "#f3eefb",
      "border-color": "#b4a2cd",
      "font-size": 11,
    },
  },
  {
    selector: "node.port",
    style: {
      shape: "rectangle",
      width: 13,
      height: 13,
      "background-color": "white",
      "border-color": "#315b7a",
      "border-width": 2,
      "font-size": 10.5,
      "font-weight": 600,
      "text-max-width": "130px",
      "text-wrap": "none",
      "text-valign": "center",
      "text-margin-y": 0,
    },
  },
  {
    selector: "node.definition",
    style: {
      "border-style": "dashed",
      "background-color": "white",
      "font-size": 11,
    },
  },
  {
    selector: "node.candidate",
    style: { "border-color": "data(stageColor)", "border-width": 3 },
  },
  { selector: "node.construction", style: { "border-style": "dashed" } },
  {
    selector: "node:selected",
    style: {
      "border-color": "#1f4d6e",
      "border-width": 2.6,
      "overlay-color": "#315b7a",
      "overlay-opacity": .18,
      "overlay-padding": 7,
    },
  },
  {
    selector: "edge",
    style: {
      width: 1.6,
      "line-color": "#71879b",
      "target-arrow-shape": "none",
      "curve-style": "bezier",
      label: "data(label)",
      "font-size": 10.5,
      "font-weight": 600,
      color: "#40576c",
      "text-wrap": "wrap",
      "text-max-width": "180px",
      "text-background-color": "#ffffff",
      "text-background-opacity": .94,
      "text-background-padding": "4px",
      "text-background-shape": "roundrectangle",
      "text-border-color": "#d7e1e9",
      "text-border-width": 1,
      "text-border-opacity": .85,
      "text-border-style": "solid",
    },
  },
  {
    selector: "edge.layout-helper",
    style: { opacity: 0, width: .1, label: "" },
  },
  {
    selector: "edge.directed",
    style: {
      "target-arrow-shape": "triangle",
      "target-arrow-color": "#617b8f",
      "arrow-scale": 1.15,
      width: 1.9,
      "text-max-width": "150px",
      "text-overflow-wrap": "anywhere",
    },
  },
  {
    selector: "edge.layout-return",
    style: {
      "curve-style": "unbundled-bezier",
      "control-point-distances": 110,
      "control-point-weights": .5,
    },
  },
  {
    selector: "edge.layout-bypass",
    style: {
      "curve-style": "unbundled-bezier",
      "control-point-distances": -150,
      "control-point-weights": .5,
    },
  },
  {
    selector: "edge.layout-bypass-left",
    style: { "control-point-distances": 300 },
  },
  {
    selector: "edge.flow",
    style: {
      "line-style": "dashed",
      "line-color": "#a792c2",
      "target-arrow-color": "#a792c2",
      "font-size": 9,
    },
  },
  {
    selector: "edge.edge-allocation",
    style: { "line-style": "dashed", "line-color": "#8b9eae", "font-size": 9 },
  },
  {
    selector: "edge.edge-owns",
    style: { "line-style": "dotted", "line-color": "#9b87ba", "font-size": 9 },
  },
  {
    selector: "edge.edge-configured-permission",
    style: {
      "line-style": "dashed",
      "line-color": "#805514",
      "target-arrow-shape": "triangle",
      "target-arrow-color": "#805514",
      "arrow-scale": 1.15,
      "font-size": 10,
    },
  },
  {
    selector: "edge.edge-connection",
    style: { "control-point-step-size": 60 },
  },
  {
    selector: "edge.edge-binding,edge.edge-field-binding",
    style: { "line-color": "#9b87ba", "line-style": "dashed", label: "=" },
  },
  {
    selector:
      "edge.edge-typing,edge.edge-feature-typing,edge.edge-specialization",
    style: { "line-style": "dotted", "line-opacity": .5, "font-size": 9 },
  },
  {
    selector: ".faded",
    style: { opacity: .16, "text-opacity": .3, "background-opacity": .45 },
  },
  {
    selector: "edge.hl",
    style: {
      width: 2.8,
      "line-color": "#1f4d6e",
      "target-arrow-color": "#1f4d6e",
      "arrow-scale": 1.25,
    },
  },
  {
    // Après les règles par kind (edge-binding « = », typing…) pour que
    // le masquage l'emporte, et après edge.hl par lisibilité : la
    // spécificité (.structural.hl / :selected) rend la réaffiche sûre.
    selector: "edge.structural",
    style: {
      "curve-style": "taxi",
      "taxi-direction": "auto",
      "taxi-turn": 20,
      "taxi-turn-min-distance": 10,
      label: "",
    },
  },
  {
    selector: "edge.structural.hl, edge.structural:selected",
    style: { label: "data(label)" },
  },
];
