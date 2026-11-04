import type { SystemRuntimeState } from "../../../src/application/work/runtime/state.ts";
export function snapshot(): SystemRuntimeState {
  return {
    id: "ui-fixture",
    revision: 7,
    catalogRevision: 2,
    busy: false,
    phase: "Prêt",
    provider: "fixture",
    events: [],
    messages: [{
      id: "m1",
      role: "user",
      text: "<script>attack()</script>",
      at: "now",
    }, {
      id: "m2",
      role: "tool",
      text: "<img src=x onerror=attack()>",
      at: "now",
    }],
    candidates: [{
      id: "c1",
      digest: "a".repeat(64),
      name: "<Lire>",
      description: "Vérifier la page",
      code: "<script>candidate()</script>",
      kind: "read_web_page",
      stage: "awaiting-admission",
      createdAt: "now",
      baseCatalogRevision: 2,
      tests: {
        passed: true,
        checks: [{ name: "Lecture", passed: true, detail: "texte conservé" }],
      },
      review: {
        candidateDigest: "a".repeat(64),
        verdict: "approve",
        reason: "Conforme au contrat",
      },
    }],
    configuration: {
      id: "cfg",
      revision: 3,
      envelope: {
        kind: "conversational-case-management",
        pattern: "1.3",
        revision: 1,
      },
      builder: {
        id: "builder",
        mandateRevision: 2,
        admissionAuthority: "human",
      },
      changes: [],
    },
  };
}
