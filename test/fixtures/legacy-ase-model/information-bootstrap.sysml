// Fragment inserted into the concrete initial ConversationSystem.
// Classic generated tools remain in its separate catalog.
part context {
    part policy : APEContext::DecisionContextPolicy {
        attribute :>> id = "decision-context-v1";
        attribute :>> revision = 1;
        attribute :>> recentMessages = 8;
        attribute :>> maxMessageCharacters = 2000;
        attribute :>> maxCollectionItems = 12;
        attribute :>> maxContextCharacters = 250000;
    }
    perform action evidence : APEContext::ReadContextEvidence;
    part evidenceAccess : ASEInvocations::BehaviorAccess {
        attribute :>> name = "ConsulterPreuve";
        attribute :>> description = "Read one exact local evidence message by verified id and digest.";
        attribute :>> enabled = true;
        ref item :>> input : APEContext::ContextEvidenceRequest;
    }
    part skills {
        part policy : APESkills::SkillPolicy {
            attribute :>> id = "context-skills-v1";
            attribute :>> revision = 1;
            attribute :>> allowedHosts = "[\"raw.githubusercontent.com\"]";
            attribute :>> maxSkillBytes = 65536;
            attribute :>> maxInstalledSkills = 32;
            attribute :>> maxLoadedSkills = 4;
            attribute :>> maxLoadedCharacters = 48000;
        }
        part aseModeling : APESkills::InitialSkill {
            attribute :>> id = "ase-modeling";
            attribute :>> source = "bundle:ase-modeling";
            attribute :>> digest = "__ASE_SKILL_DIGEST__";
            attribute :>> loaded = true;
        }
        perform action install : APESkills::InstallSkill;
        part installAccess : ASEInvocations::BehaviorAccess {
            attribute :>> name = "InstallerSkill";
            attribute :>> description = "Download and install raw skill instructions from a source-admitted HTTPS host; do not load them.";
            attribute :>> enabled = true;
            ref item :>> input : APESkills::InstallSkillRequest;
        }
        perform action list : APESkills::ListSkills;
        part listAccess : ASEInvocations::BehaviorAccess {
            attribute :>> name = "ListerSkills";
            attribute :>> description = "List local installed skills and their exact versions without their instruction contents.";
            attribute :>> enabled = true;
            ref item :>> input : APESkills::ListSkillsRequest;
        }
        perform action load : APESkills::LoadSkill;
        part loadAccess : ASEInvocations::BehaviorAccess {
            attribute :>> name = "ChargerSkill";
            attribute :>> description = "Load an exact installed skill into subsequent decision contexts.";
            attribute :>> enabled = true;
            ref item :>> input : APESkills::LoadSkillRequest;
        }
        perform action unload : APESkills::UnloadSkill;
        part unloadAccess : ASEInvocations::BehaviorAccess {
            attribute :>> name = "DechargerSkill";
            attribute :>> description = "Remove an exact installed skill from subsequent decision contexts without deleting its audit trail.";
            attribute :>> enabled = true;
            ref item :>> input : APESkills::UnloadSkillRequest;
        }
    }
}
part memory {
    part policy : APEMemory::GovernedMemoryPolicy {
        attribute :>> id = "local-memory-v1";
        attribute :>> revision = 1;
        attribute :>> allowedScopes = "[\"modeling\"]";
        attribute :>> requireSourceRefs = true;
        attribute :>> requireKnownOutcome = true;
        attribute :>> maxValidityMs = 86400000;
        attribute :>> allowSelfAdmission = false;
    }
    perform action capture : APEMemory::CaptureMemory;
    part captureAccess : ASEInvocations::BehaviorAccess {
        attribute :>> name = "CapturerMemoire";
        attribute :>> description = "Contribute a local candidate memory; capture does not admit its guidance.";
        attribute :>> enabled = true;
        ref item :>> input : APEMemory::CaptureMemoryRequest;
    }
    perform action recall : APEMemory::RecallMemory;
    part recallAccess : ASEInvocations::BehaviorAccess {
        attribute :>> name = "RappelerMemoire";
        attribute :>> description = "Read local memory statuses without admitting candidates.";
        attribute :>> enabled = true;
        ref item :>> input : APEMemory::RecallMemoryRequest;
    }
    perform action revise : APEMemory::ReviseMemory;
    part reviseAccess : ASEInvocations::BehaviorAccess {
        attribute :>> name = "ReviserMemoire";
        attribute :>> description = "Revise an exact local candidate under revision and digest control.";
        attribute :>> enabled = true;
        ref item :>> input : APEMemory::ReviseMemoryRequest;
    }
    perform action review : APEMemory::ReviewMemory;
    part reviewAccess : ASEInvocations::BehaviorAccess {
        attribute :>> name = "RevoirMemoire";
        attribute :>> description = "Decide an exact local memory under the separately admitted memory policy.";
        attribute :>> enabled = true;
        ref item :>> input : APEMemory::ReviewMemoryRequest;
    }
    perform action withdraw : APEMemory::WithdrawMemory;
    part withdrawAccess : ASEInvocations::BehaviorAccess {
        attribute :>> name = "RetirerMemoire";
        attribute :>> description = "Withdraw an exact local memory from current guidance without erasing its history.";
        attribute :>> enabled = true;
        ref item :>> input : APEMemory::WithdrawMemoryRequest;
    }
}
allocate context.evidence to admissionGate;
bind context.evidenceAccess.caller = builder;
bind context.evidenceAccess.target = context.evidence;
allocate context.skills.install to admissionGate;
bind context.skills.installAccess.caller = builder;
bind context.skills.installAccess.target = context.skills.install;
allocate context.skills.list to admissionGate;
bind context.skills.listAccess.caller = builder;
bind context.skills.listAccess.target = context.skills.list;
allocate context.skills.load to admissionGate;
bind context.skills.loadAccess.caller = builder;
bind context.skills.loadAccess.target = context.skills.load;
allocate context.skills.unload to admissionGate;
bind context.skills.unloadAccess.caller = builder;
bind context.skills.unloadAccess.target = context.skills.unload;
allocate memory.capture to admissionGate;
bind memory.captureAccess.caller = builder;
bind memory.captureAccess.target = memory.capture;
allocate memory.recall to admissionGate;
bind memory.recallAccess.caller = builder;
bind memory.recallAccess.target = memory.recall;
allocate memory.revise to admissionGate;
bind memory.reviseAccess.caller = builder;
bind memory.reviseAccess.target = memory.revise;
allocate memory.review to admissionGate;
bind memory.reviewAccess.caller = builder;
bind memory.reviewAccess.target = memory.review;
allocate memory.withdraw to admissionGate;
bind memory.withdrawAccess.caller = builder;
bind memory.withdrawAccess.target = memory.withdraw;
