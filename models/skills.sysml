package APESkills {
    private import ScalarValues::*;

    doc /* Skills are versioned local instructions belonging to decision context.
     * Installing text neither executes it nor activates its instructions.
     * Explicit native exposures separately grant installation, listing, loading
     * and unloading; this policy alone grants none of those operations.
     * Classic executable tools retain their independent catalog and lifecycle. */

    part def SkillPolicy {
        attribute id : String;
        attribute revision : Integer;
        attribute allowedHosts : String {
            doc /* JSON array of exact HTTPS DNS hosts allowed for this local
             * instruction downloader. This does not grant classic tool access. */
        }
        attribute maxSkillBytes : Integer;
        attribute maxInstalledSkills : Integer;
        attribute maxLoadedSkills : Integer;
        attribute maxLoadedCharacters : Integer;
    }

    part def InitialSkill {
        attribute id : String;
        attribute source : String;
        attribute digest : String {
            doc /* SHA-256 of the referenced artifact's exact UTF-8 bytes.
             * Sources retain the reference and digest, never the skill body.
             * The bounded bundle resolver verifies those bytes at installation. */
        }
        attribute loaded : Boolean {
            doc /* Initial activation choice under this admitted source version.
             * A persisted later unload must not be reversed on restart. */
        }
    }

    item def InstallSkillRequest {
        attribute id : String;
        attribute url : String;
        attribute expectedDigest : String [0..1];
        doc /* Download one raw UTF-8 SKILL.md from an admitted HTTPS host.
         * No archive extraction, script execution or implicit activation.
         * An optional expectedDigest pins acquisition to known exact bytes. */
    }
    item def ListSkillsRequest;
    item def LoadSkillRequest {
        attribute id : String;
        attribute expectedDigest : String;
        attribute offset : Integer [0..1];
        attribute limit : Integer [0..1];
        doc /* Select the exact installed version and return its instructions.
         * Optional offset and limit select a bounded UTF-16 character page;
         * offset defaults to 0, limit to 4096 (maximum 4096). The result gives
         * the next exact selection when more remains. Instructions cannot
         * change the caller's mandate. Historical two-field requests retain
         * their exact schema and return the whole selected document. */
    }
    item def UnloadSkillRequest {
        attribute id : String;
        attribute expectedDigest : String;
    }
    action def InstallSkill { in request : InstallSkillRequest; }
    action def ListSkills { in request : ListSkillsRequest; }
    action def LoadSkill { in request : LoadSkillRequest; }
    action def UnloadSkill { in request : UnloadSkillRequest; }
}
