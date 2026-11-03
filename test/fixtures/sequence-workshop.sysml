package ASEWorkshopSequence {
    doc /* Declared successful scenario of the existing workshop's human-admitted
         * capability promotion. The software participants reference existing
         * system parts. This is a design scenario, not a claim that every message
         * below has been observed or independently persisted by the host.
         * It introduces no executable action, admission rule or callable exposure. */

    part def ParticipantHumain;

    occurrence def PromotionAvecAdmissionHumaine {
        doc /* The candidate passes its tests and a human accepts its admission.
             * Refusal and failure alternatives remain in CapabilityPromotion and
             * AdmissionCandidateLifecycle. Replies and human decisions cross the
             * host's existing conversation/control interface; the sequence does
             * not assert new structural ports on that interface. */

        part humain : ParticipantHumain {
            event occurrence demandeEnvoyee;
            then event occurrence validationRecue;
            then event occurrence accordEnvoye;
            then event occurrence reponseRecue;
        }
        ref part constructeur : AssemblyLiveBuilder::ConversationBuilder {
            event occurrence demandeRecue;
            then event occurrence candidatEnvoye;
            then event occurrence resultatRecu;
            then event occurrence reponseEnvoyee;
        }
        ref part 'Banc de test' : AssemblyLiveBuilder::CandidateTestSandbox {
            event occurrence candidatRecu;
            then event occurrence candidatControleEnvoye;
            then event occurrence candidatCatalogueEnvoye;
            then event occurrence testsEnvoyes;
        }
        ref part 'Controle admission' : AssemblyLiveBuilder::CatalogAdmissionGate {
            event occurrence candidatRecu;
            then event occurrence testsRecus;
            then event occurrence validationEnvoyee;
            then event occurrence accordRecu;
            then event occurrence admissionEnvoyee;
            then event occurrence activationRecue;
            then event occurrence resultatEnvoye;
        }
        ref part catalogue : AssemblyLiveBuilder::ToolCatalog {
            event occurrence candidatRecu;
            then event occurrence admissionRecue;
            then event occurrence activationEnvoyee;
        }

        bind constructeur = AssemblyLiveBuilder::liveBuilder.builder;
        bind 'Banc de test' = AssemblyLiveBuilder::liveBuilder.testSandbox;
        bind 'Controle admission' = AssemblyLiveBuilder::liveBuilder.admissionGate;
        bind catalogue = AssemblyLiveBuilder::liveBuilder.catalog;

        message 'Demande de construction' of AssemblyConversation::CaseContribution
            from humain.demandeEnvoyee to constructeur.demandeRecue;
        message 'Candidat propose' of AssemblyCore::CandidateIdentity
            from constructeur.candidatEnvoye to 'Banc de test'.candidatRecu;
        message 'Candidat teste vers le controle' of AssemblyCore::CandidateIdentity
            from 'Banc de test'.candidatControleEnvoye to 'Controle admission'.candidatRecu;
        message 'Candidat teste vers le catalogue' of AssemblyCore::CandidateIdentity
            from 'Banc de test'.candidatCatalogueEnvoye to catalogue.candidatRecu;
        message 'Resultats des essais' of AssemblyCore::TestResult
            from 'Banc de test'.testsEnvoyes to 'Controle admission'.testsRecus;
        message 'Validation humaine demandee' of AssemblyLiveBuilder::HumanAdmissionRequested
            from 'Controle admission'.validationEnvoyee to humain.validationRecue;
        message 'Admission acceptee' of AssemblyLiveBuilder::HumanAdmissionAccepted
            from humain.accordEnvoye to 'Controle admission'.accordRecu;
        message 'Decision admission' of AssemblyCore::AdmissionDecision
            from 'Controle admission'.admissionEnvoyee to catalogue.admissionRecue;
        message 'Activation observee' of AssemblyConversation::ActionOutcome
            from catalogue.activationEnvoyee to 'Controle admission'.activationRecue;
        message 'Retour au constructeur' of AssemblyConversation::ActionOutcome
            from 'Controle admission'.resultatEnvoye to constructeur.resultatRecu;
        message 'Reponse a utilisateur' of AssemblyCore::ConversationResponse
            from constructeur.reponseEnvoyee to humain.reponseRecue;
    }

    view promotionHumaine : StandardViewDefinitions::SequenceView {
        expose PromotionAvecAdmissionHumaine;
    }
}
