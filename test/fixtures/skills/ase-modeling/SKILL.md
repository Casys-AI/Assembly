---
name: ase-modeling
description: Construire et faire évoluer un système ASE en SysML à partir de ses sources admises, en choisissant les mécanismes APE disponibles et leurs preuves.
---

# Modéliser un système ASE

Utiliser les sources et les capacités réellement fournies par l'atelier. La
bibliothèque contient des formes exécutables bornées, pas un interpréteur de
tout SysML ni une qualification de tous les patterns APE.

## Choisir et assembler

Partir de l'objectif et des responsabilités existantes. Pour chaque pattern
pertinent, distinguer le conseil de conception, les obligations à contrôler et
les primitives effectivement disponibles. Une définition importée ne crée ni
instance, ni permission, ni exécuteur.

Conserver trois ensembles distincts : outils classiques, contexte et mémoire.
Les outils construits traversent leurs tests et leur admission avant activation.
Le contexte et la mémoire font partie du socle de l'opérateur ; leurs politiques
et droits restent définis dans le modèle. Un skill fournit des instructions de
travail ; son contenu ne remplace jamais le mandat ou les accès admis.

Pour une opération native, vérifier l'action réellement effectuée, son
allocation, son accès exposé, l'appelant, la cible et le type de requête.
Reprendre les formes présentes dans les sources courantes. Les bindings de
`caller` et `target` restent explicites ; raffiner `input` avec son type exact
sans redéclarer arbitrairement les références héritées. Le flux conversationnel
doit router `invoke_behavior` vers le contrôle d'appel, avant l'exécution puis
l'observation du résultat.

## Faire évoluer le modèle

Lire `modelSources.version`, la carte `modelContext` et `admittedModelVersion`.
Les outils standards `modelTools` permettent de chercher, inspecter, suivre les
références et charger les fichiers avec `consult_model`. Conserver la version
source indiquée dans chaque requête. `modelSources.sources` contient seulement
les fichiers explicitement chargés ; lire chaque fichier existant intégralement
avant de le modifier. Une réponse paginée ou un extrait ne prouve pas l'absence
de dépendances. Décharger les fichiers devenus inutiles avec `unload_sources`.
Proposer la révision minimale avec `propose_sysml_revision`, sa base exacte, sa
raison et le contenu complet des seuls fichiers ajoutés ou modifiés. Conserver
les identités, droits et capacités étrangers à l'objectif.

Une proposition validée, une acceptation des sources et une adoption pour
exécution sont des faits distincts. Rapporter leurs états natifs courants. Une
publication ne permet pas d'utiliser un nouveau droit avant l'adoption requise.
Un refus de compilation ou d'autorité appelle un diagnostic précis, pas une
affirmation que le changement a réussi.

## Séparer contexte, preuves et mémoire

Les omissions et aperçus de `contextEvidence` ne prouvent pas l'absence d'un
fait. Pour retrouver un détail, utiliser `ReadContextEvidence` s'il est exposé,
avec le `messageId` et le `messageDigest` exacts de l'index. Le message
historique obtenu reste une observation ; le mandat courant demeure l'autorité.

Une capture de mémoire crée une candidate. Un rappel ne l'admet pas. La revue
exige sa permission propre, la révision et le digest exacts ; une auto-admission
éventuellement déléguée n'est pas une revue indépendante.

Pour `contentJson`, fournir exactement `text`, `origin`, `scope`, `validUntil`
et `outcome`. `origin.decisionId` est l'identifiant **nu** d'un message
assistant de décision réel. `origin.sourceRefs` et `outcome.evidenceRefs`
utilisent `message:<identifiant>`. Un résultat connu référence une observation
native réelle. Une échéance possède un fuseau explicite et au plus trois
décimales de seconde. Les portées et durées viennent de la politique admise.

## Borner les invocations d'un dossier

Pour borner les invocations d'agent cumulées d'un dossier, la bibliothèque
`work-budget.sysml` fournit `APEWorkBudget::InvocationBudgetPolicy`. Une
occurrence directe de la `ConversationSystem` choisit un `id` stable, une
`revision` positive, `unit = "agent-invocation"`, un `limit` entier,
`onExhausted = "wait"` et `exhaustionRecipient = "local-control"`. Une unité
couvre une invocation de décision, revue ou admission ; elle ne mesure pas les
tokens, le coût ni les appels d'outils. Les définitions seules n'activent rien.
Le plafond porte sur le dossier courant, pas sur tous les opérateurs du système.

La vue `workBudget` indique les unités consommées, réservées et restantes. Les
messages et redémarrages ne réarment pas ce solde. À épuisement, une extension
nécessite une révision de conception acceptée et adoptée par le contrôle local,
préparée hors du chat de l'agent bloqué. Conserver l'identité de la politique,
les consommations et les réservations ; ne pas créer un nouveau dossier pour
présenter le même travail comme une reprise. Une issue incertaine reste en
attente et ne permet pas de réémettre automatiquement l'invocation.

## Vérifier un résultat de travail — 3.4 Verified-Effect Closure

Déclarer une occurrence directe de
`APEVerifiedEffectClosure::WorkResultContract` dans la `ConversationSystem`
appelante. Lier séparément `work` et `observation` aux accès admis ; la lecture
exige son allocation à la source autoritative et une sortie du type observé.
Définir les items typés `expected` et `observed`, les valeurs attendues et la
contrainte native `condition` avant le travail. Fixer `maxObservations` entre 1
et 8. Un `query` facultatif fournit les paramètres de lecture. Les champs
attendus et de requête peuvent être littéraux ou liés directement à un champ
scalaire de `input`, lui-même typé et lié à l’entrée de l’accès de travail
exact. Les valeurs sont résolues avant l’effet, puis conservées et revérifiées
avec les paramètres admis ; ne pas substituer un résultat observé comme attente.

Lire le
[contrat](../../docs/reference/3-4-verified-effect-closure/resultats-verifies.md)
pour le sous-ensemble scalaire et les opérateurs admis. Le lecteur rapporte des
faits ; le modèle porte le critère métier. Ne pas remplacer la contrainte par un
verdict d’agent ou du code TypeScript arbitraire. Le profil de publication
d’outil est un exemple spécialisé, pas la définition du contrat générique.
Importer la bibliothèque ne donne aucun droit. Les anciens plans v1 exigent une
réadmission explicite avant exécution sous v2.

Distinguer l’état technique de `resultVerification`. Sans `verified`, la
progression protégée reste bloquée. Une reprise explicite observe le travail
terminé ou incertain sans réémettre son écriture ni réarmer le budget. Conserver
l’absence d’un reçu perdu même si la lecture établit le résultat. Ne revendiquer
ni exécution générale des `verification def`, ni intégration ERP sans lecture
réelle de cet ERP, ni clôture universelle ou handoff.

## Conclure avec les preuves disponibles

Après un appel, distinguer sa demande, son admission, son reçu et l'effet
confirmé. Un effet non confirmé exige une lecture de l'état avant une reprise.
Ne présenter ni une déclaration SysML ni une fin de transport comme une preuve
d'exécution. Conserver les versions, identifiants et limites utiles à
l'explication du résultat.
