package CommercialWatchMission {
    private import ScalarValues::*;

    doc /* Mission bornée de démonstration : rechercher des signaux publics de
     * prestation ou de formation IA pour Casys. Ce texte cadre le travail des
     * opérateurs ; il ne prétend pas qu’une veille réelle a déjà été exécutée.
     * Les deux items ci-dessous restent dans le même fichier pour éprouver
     * deux propositions concurrentes sur des éléments natifs distincts. */

    item def WatchPolicy {
        attribute instruction : String;
    }

    item sourcePolicy : WatchPolicy {
        attribute :>> instruction = "Examiner seulement les trois URLs déclarées, conserver titre, extrait factuel, URL exacte et date lorsqu’elle est connue. Déclarer les pages inaccessibles et ne contacter personne.";
    }

    item qualificationPolicy : WatchPolicy {
        attribute :>> instruction = "Distinguer occasion rémunérée attribuable, simple catalogue de formation et frais d’inscription. Relier chaque conclusion à une source effectivement lue; conserver interprétations et inconnues séparément.";
    }

    item def PublicSource {
        attribute url : String;
    }
    item casysTeaching : PublicSource {
        attribute :>> url = "https://casys.ai/teaching";
    }
    item euDigitalOpportunities : PublicSource {
        attribute :>> url = "https://digital-skills-jobs.europa.eu/en/opportunities";
    }
    item euPublicTenders : PublicSource {
        attribute :>> url = "https://ted.europa.eu/en/";
    }
}
