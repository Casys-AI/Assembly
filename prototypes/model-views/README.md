# Maquette des vues du modèle (System et Model)

Maquette basse fidélité du 24 octobre 2026, conservée comme référence de design.
Une partie des pages est maintenant implémentée dans `frontend/` ; la maquette
contient aussi des vues encore prévues. Consulter les
[choix des pages System et Model](../../docs/explanation/modeles/pages-system-et-model.md)
et le
[guide de l’interface actuelle](../../docs/how-to/modeles/parcourir-system-et-model.md).
Les détails ci-dessous décrivent la maquette, pas une preuve de fonctionnement
de l’app.

## La voir

```sh
cd prototypes/model-views
../../.data/toolchains/deno-v2.9.7/deno run --allow-read=. --allow-write=dist build.ts
../../.data/toolchains/deno-v2.9.7/deno run --allow-net=127.0.0.1:5310 --allow-read=. serve.ts
```

Puis ouvrir http://127.0.0.1:5310.

Le Dock suit l'app :

- **À gauche** : les Cases ouverts, en tuiles à initiales, qui ouvrent leur
  conversation épinglée à gauche, puis la tuile Cases (Open et Done ; écrire en
  bas démarre un Case).
- **Au centre** : le logo (cercle de 64 px), qui ouvre la conversation du
  Concepteur. Seule, elle flotte au-dessus du logo ; à côté d'une fenêtre, elle
  devient le volet de gauche.
- **À droite** : Jobs et Watches, deux piles qui ouvrent leur liste au-dessus du
  Dock, un séparateur, puis trois places :
  - **System** : la représentation lisible. Team en est l'accueil, puis Explore,
    Flows, Requirements, Rights ; Parts, Allocations et Building blocks sont
    sous More.
  - **Model** : le SysML versionné dans Git (Activity, Revisions, Files, SysML).
  - **To decide** : ce qui attend une décision, une ligne par point. La pastille
    de la barre de titre y mène aussi.

Le menu ASE change de système (commercial-watch, demo-ase).

## Fichiers

| Fichier                  | Rôle                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `template.html`          | Toute la maquette : CSS, helper `h()`, une fonction `pages.*` par page, état `S`, `render()`. Les noms internes des espaces sont `model` (System) et `evolution` (Model). |
| `sysml-template.html`    | Le visualiseur SysML pur : vues `toGraph`, PlantUML du Toolkit, exports.                                                                                                  |
| `build.ts`, `serve.ts`   | Injection des données dans `dist/` (non versionné) et service local.                                                                                                      |
| `data/`                  | Instantané du 2026-10-24 : tableau projeté (`board-*`), données de travail (`data-*`), vues SysML (`sysml-*`), dépôt Git de demo-administration (`repo-*`).               |
| `tools/project-board.ts` | Projection du tableau depuis un modèle, par le Toolkit seul, sans regex sur le texte SysML. Il régénère `data/board-*.json`.                                              |

Les `data-*` et `sysml-*` ont été produits par `SysmlToolkitAdapter.views()`,
retiré depuis avec l'explorateur V1 : ils restent un instantané. Le même dépôt
d'exemple sert pour les deux systèmes.

## Règles de design

- **Montrer, pas écrire.** Pas de paragraphe d'introduction ni de bandeau de
  cartes en tête de page. Le texte exact va dans l'infobulle ou dans le détail.
- **Le vide d'abord.** L'élégance tient au vide, pas aux petits effets.
- **Le détail s'ouvre sous l'élément cliqué**, un seul à la fois. Jamais de
  popover qui cache, jamais de panneau fixe à droite.
- **Le titre tombe toujours au même endroit.** Les pages pleine largeur, comme
  SysML, gardent leur titre aligné.
- **L'information va sur l'objet.** Dans Revisions, « main » et « running » sont
  des pastilles sur le commit concerné. Le compte des propositions est sur leur
  onglet. Accepter et Refuser sont sur la proposition.
- **Un contrôle visible agit toujours.** Un bouton qui ne fait rien est un
  défaut grave.

## Jetons et cadre

Les jetons sont ceux de l'app (`frontend/assets/styles.css` et `desk.css`),
recopiés en tête de `template.html`.

- **Couleurs** : `--desk #f3f2ef`, `--paper #faf9f7`, `--card #fff`,
  `--ink #1d1d1f`, `--muted #636368`, `--faint #9a9a9f`, `--line #e4e1da`,
  `--line-strong #d6d2c9`, `--hover rgb(0 0 0 / 4%)`, `--chip rgb(0 0 0 / 5%)`.
  Avertissement : `#8a642a` sur `#f6eedd`.
- **Typographie** : police système, corps 13.5px/1.5 ; mono `ui-monospace`.
- **Cadre** : `main` avec padding 0 28px et `scrollbar-gutter: stable` ; `.page`
  de 1080px de large au maximum, centrée, padding 36px 12px 56px ; `h1` en 600
  22px/1.25, letter-spacing -.02em, marge basse 28px.

## Composants

À chercher par leur classe dans `template.html` :

- `.seg` : contrôle segmenté, avec sa pastille de compte `.count`.
- `.rev-row` : ligne de liste. Titre sur deux lignes au plus ; méta en 11.5px,
  hash en mono, pastilles.
- `.chip` : pastille.
- `.decide` : boutons en pilule ; le bouton principal est sur fond `--ink`.
- `.feed-group` : libellé de groupe.
- `.change-row` : fil façon notifications GitHub.
- `.tmap.force` : réseau de l'équipe (d3-force, départ fixe donc stable, nœuds
  déplaçables).
- Vues en liste et détail : Revisions (liste de 280px à gauche, détail à droite)
  et Files (arborescence, puis le fichier coloré en SysML).
- Diffs : Diff2Html 3.4.56, la version de `RevisionsView`.
