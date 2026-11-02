# Veille commerciale à trois opérateurs

Ce dossier contient un jeu initial complet de sources SysML. Il remplace les
sources initiales d’une **instance neuve**, sans effacer une base existante. Les
fichiers de bibliothèque sont copiés ici pour rendre ce jeu autonome ; ils ne
sont pas un nouveau profil de règles métier en TypeScript.

Aucune observation commerciale ni exécution d’agent n’est fournie par ces
sources. Elles définissent le système à qualifier et le travail demandé.

## Opérateurs et routes

| Scope natif                        | Fonction                                                              | Entrée humaine | Comportements exposés au constructeur                   |
| ---------------------------------- | --------------------------------------------------------------------- | -------------- | ------------------------------------------------------- |
| `AssemblyLiveBuilder::liveBuilder` | Coordinateur veille, point de contact principal                       | Oui            | `PlanifierTravail`, `ConfierCollecte`, `ConfierAnalyse` |
| `AssemblyCollect::collector`       | Collecteur, construction du lecteur complet et collecte               | Non            | `Bibliotheque`, `ReutiliserOutil`                       |
| `AssemblyAnalysis::analyst`        | Analyste, construction du lecteur de plan et qualification du contenu | Non            | `Bibliotheque`, `ReutiliserOutil`                       |

Chaque scope est un dossier conversationnel 1.3 distinct avec son propre
constructeur, son catalogue, ses essais et son contrôle d’admission. Les travaux
arrivent aux spécialistes par leurs occurrences `AgentInbox`, allouées à leur
constructeur. Il n’existe pas de salon libre ni de lecture des conversations
voisines. Le coordinateur demeure responsable de l’intégration des résultats.

Le plan est un DAG complet de tâches référençant les identités réelles des
comportements exposés. Il doit être admis avant son premier appel. Les tâches
indépendantes peuvent s’exécuter en parallèle ; une dépendance ne fournit pas
implicitement les arguments ou les références de résultats des autres tâches.
Les identifiants de corrélation, retours, attentes et erreurs restent distincts.

## Édition du modèle : délégation explicite 4.1

Le profil public `AssemblyModelEditing::ModelEditPolicy` porte les bornes
appliquées par l’hôte pour l’édition du modèle (4.1). `model-editing.sysml` ne
contient que sa définition ; une définition seule ne délègue aucun droit. Les
deux politiques admises lient explicitement leur constructeur et son mandat
courant, avec un identifiant et une révision.

| Opérateur  | Fichier autorisé | Racine qualifiée autorisée                    |
| ---------- | ---------------- | --------------------------------------------- |
| Collecteur | `mission.sysml`  | `CommercialWatchMission::sourcePolicy`        |
| Analyste   | `mission.sysml`  | `CommercialWatchMission::qualificationPolicy` |

Les opérations admises sont `set-value`, `rename`, `insert-member`, `remove` et
`replace-source`, sérialisées en tableaux JSON canoniques, comme les grants.
Chaque changement effectif doit rester dans la paire fichier/racine admise, même
lorsqu’une proposition transmet le fichier complet. Le renommage ou la
suppression de la racine autorisée est refusé ; une modification de références
hors de cette portée est également refusée, y compris lors d’un renommage. Les
opérateurs ne peuvent pas modifier leurs propres permissions. Le Coordinateur
n’a aucune politique d’édition du modèle : il coordonne les propositions sans
écrire lui-même les sources. Le booléen de consultation ne lui confère aucun
droit d’édition.

Une proposition reste privée et soumise à validation puis décision explicite ;
ces permissions ne fusionnent, ne publient ni n’adoptent une version. Les
commandes locales du propriétaire dans l’atelier sont une autorité distincte des
mandats des opérateurs.

## Parcours de démonstration

1. Le coordinateur donne un premier plan aux deux spécialistes depuis la même
   version initiale `S0`. Chacun propose une révision privée de `mission.sysml`
   : le Collecteur modifie seulement `sourcePolicy.instruction`, Analyste
   seulement `qualificationPolicy.instruction`. Les deux éléments sont dans le
   même fichier. Les autres sources restent inchangées.
2. La proposition SysML suspend normalement le dossier : elle ne change pas la
   branche acceptée et n’autorise pas sa propre fusion ou adoption. Examiner et
   décider les deux propositions, vérifier leur fusion et recompiler précèdent
   la reprise explicite. Un conflit sur une même propriété reste à résoudre ; le
   fichier de mission fournit aussi ce cas à provoquer séparément.
3. Un second plan demande au Collecteur de construire `lire_veille_sources`, de
   type `read_web_page`. Une tâche Analyste dépendant de cette construction lui
   fait construire `plan_veille_liens`, de type `read_web_page_outline`, puis
   lire la bibliothèque des artefacts effectivement actifs.
4. Analyste demande la réutilisation du lecteur du Collecteur avec son
   `sourceAgentId`, son `candidateId` et son `digest` exacts. Cette importation
   devient une proposition locale : les essais, l’admission et l’activation
   locales restent exigés. Deux lectures sur des entrées autorisées différentes
   peuvent ensuite éprouver la réutilisation de la même version.
5. Le coordinateur utilise les résultats corrélés pour rendre une synthèse
   sourcée. Une proposition, une attente, un refus ou une erreur ne constitue
   jamais une lecture réussie ni une mission terminée.

Le bootstrap de ce **nouveau modèle** autorise chaque constructeur à admettre
ses propres candidats testés (`admissionMode = "builder"`). Ce n’est pas une
revue indépendante. Le coordinateur ne propose ni n’appelle directement des
outils ; les deux spécialistes possèdent les contrats de lecteurs existants.
Cette configuration ne modifie aucun droit d’une ancienne instance.

Chaque dossier borne ses choix à 12 décisions d’agent, 2 propositions d’outil
par tour et 256 étapes de flot. La sélection d’URL est `authorized-host`. Les
opérateurs ne peuvent pas ajouter d’hôte, créer un reviewer ou élargir leur
propre admission par le chat.

## Sources publiques proposées

`mission.sysml` déclare trois pages initiales sur trois hôtes exacts :

- `https://casys.ai/teaching` ;
- `https://digital-skills-jobs.europa.eu/en/opportunities` ;
- `https://ted.europa.eu/en/`.

Ces URLs doivent être vérifiées avant une démonstration réseau. Leur présence
dans le modèle ne garantit ni leur accessibilité actuelle, ni l’existence d’une
occasion de prestation. Une redirection vers un autre hôte n’élargit pas le
mandat. Si une page est inaccessible ou n’offre pas d’information suffisante, le
résultat doit le dire.

La mission cherche un signal de prestation ou de formation en IA pour Casys.
Elle distingue une mission rémunérée attribuable d’un catalogue, de frais payés
par un participant ou d’une simple possibilité de visibilité. Chaque conclusion
garde son URL, son extrait utile et sa date lorsqu’elle est connue. Aucun
contact, formulaire, inscription ou enrichissement personnel ne fait partie de
ce parcours.

## Qualifier les sources sans lancer les agents

Depuis `apps/live-builder`, avec la toolchain locale déjà installée :

```sh
.data/toolchains/deno-v2.9.7/deno run --no-prompt --allow-read --allow-write --allow-run --allow-env=SYSML_TOOLKIT_DIR test/fixtures/commercial-watch/qualify.ts
```

This command compiles with the qualified native SysML Toolkit `0.10.10+ase.2`,
validates executable scopes and their exposures, then writes
`assembly-sources.json` for a new instance. Set `SYSML_TOOLKIT_DIR` when the
verified package is installed outside the default location. It opens no model
database, starts no application server and calls no agent provider. The printed
JSON contains the native identities actually compiled.

The original `sources.json` is retained byte for byte as the historical ASE
export used by compatibility tests. New systems use the canonical `.sysml` files
or `assembly-sources.json`; old systems and tests can still read the original
export without changing its source identities.
