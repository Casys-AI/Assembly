# Travail V1 des vues du modèle, mis à l'abri

Copie du travail non commité du worktree `ase-wt-v1-views` (branche
`ase/v1-model-views`, base 3dadfd6), relevé le 2026-10-24 :

- les fichiers nouveaux, sous leurs chemins d'origine (`apps/live-builder/...`)
  : le modèle de domaine des vues (`src/domain/model-views.ts`), leur production
  par le Toolkit (`src/adapters/toolkit-views.ts`), la route
  (`src/adapters/model-views-http.ts`), le visualiseur ELK en Preact
  (`frontend/components/ModelDiagram.tsx`,
  `frontend/lib/model-diagram-layout.ts`) et leurs tests ;
- `tracked-changes.patch` : les modifications des fichiers déjà suivis
  (adaptateur et worker Toolkit, `main.ts`, dépendance `elkjs` du frontend…).

Ce n'est pas du code de l'app : c'est la base de départ des lots B6 (vues
Toolkit) et F15 (page SysML) de l'implémentation de System et Model. Les
fichiers sont repris à la main, sans fusion de la branche V1, dont la base a
retiré l'ancien explorateur. `decisionBranches` lisait le texte SysML par regex
: à remplacer.

`../tools/project-matrix.ts` produces the prototype authority matrix
(`data/data-*.json`, field `matrix`). Its default application path is resolved
from the script location; `--app`, `--toolkit` and `--out` override the inputs
and destination. The default output directory is created under the application's
ignored `.data/prototypes/model-views` directory.

The assembly scripts use the current adapter's view-list, diagram and PlantUML
APIs while keeping the exported view shape. Their optional final positional
argument selects a Toolkit package directory; otherwise they use the pinned
native package under the application's `.data/toolchains` directory:

- `assemble.ts NAME SOURCES BOARD MATRIX OUTPUT [TOOLKIT_DIRECTORY]`
- `assemble-sysml.ts NAME SOURCES OUTPUT [TOOLKIT_DIRECTORY]`

Published paths are portable. These commands remain prototype exporters;
removing machine paths does not qualify a new live model run.
