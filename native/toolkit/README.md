# `ase-toolkit-napi` — addon Toolkit N-API natif

Pont N-API (napi-rs) Deno → Rust → SysML Toolkit (`sysmlv2-transform`,
`sysmlv2-model`, `sysmlv2-syntax`, `sysmlv2-viz`, `sysmlv2-lsp`).
Aucun chemin WASM : la crate ne dépend ni de `sysmlv2-wasm` ni de
`wasm-bindgen` ; la sémantique du wrapper amont est recalculée sur les
crates natives (voir [API-CONTRACT.md](API-CONTRACT.md), normatif).

## Prérequis

- Rust ≥ 1.97 (épingle workspace du Toolkit).
- Node/npm pour `@napi-rs/cli` 3.10.9 (`npm install` dans ce dossier).
- Le checkout Toolkit exact `0.10.10+ase.2` (commit
  `8b541ae04beedde6f28f4a3966f8acd039584327`) à
  `../../.data/toolchains/sysml-toolkit-source-0.10.10+ase.2/`,
  fourni par le source-setup depuis `vendor/` — les dépendances de
  `Cargo.toml` pointent là, jamais vers un chemin Scratch.
- Accès crates.io au premier build (dépendances napi/rs et LSP), qui
  génère aussi `Cargo.lock`.

## Build (coordinateur, shell hôte sous verrou)

```sh
npm install
npm run build        # napi build --release --platform --js index.js --dts index.d.ts
cargo test           # tests de contrat Rust (src/tests.rs)
```

`npm run build` régénère `index.js` (chargeur) et `index.d.ts`
(déclarations) et produit le binaire `ase-toolkit-napi.<plateforme>.node`
dans ce dossier. Le chargement Deno passe par `ts/toolkit.ts`
(`loadAddon`, require direct du `.node`).

## Tests de contrat Deno (après build)

```sh
deno run -A tests/lifecycle.ts --addon ./ase-toolkit-napi.<plateforme>.node
deno run -A tests/reads.ts     --addon ./ase-toolkit-napi.<plateforme>.node
deno run -A tests/edits.ts     --addon ./ase-toolkit-napi.<plateforme>.node
deno run -A tests/lsp-tokens.ts --addon ./ase-toolkit-napi.<plateforme>.node
deno check ts/toolkit.ts tests/*.ts   # types seuls, sans addon
```

Chaque script imprime un résumé JSON et sort en échec si un cas casse.
Les fixtures sont des modèles mémoire autonomes (aucun paquet stdlib
requis).

## Discipline (résumé, détail dans API-CONTRACT.md)

API synchrone ; `close()` déterministe et idempotent ; aucun handle
Rust exposé — les éléments circulent comme instantanés
`{sessionId, generation, nativeId}` revérifiés à chaque appel ; panic
attrapée → `NATIVE_PANIC` + objet empoisonné ; erreurs préfixées d'un
code stable. La façade TS de compatibilité
(`ToolkitRuntime`/`ToolkitSession`) vit hors de ce paquet, au-dessus
de cette API.
