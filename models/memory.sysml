package APEMemory {
    private import ScalarValues::*;

    doc /* APE 5.2 - Governed Memory Promotion. Bounded local-note mechanisms
     * promote observations to reusable guidance through an
     * exact revision and digest decision. Capturing or reading a candidate does
     * not admit it. A policy belongs directly to one ConversationSystem and its
     * builder owns the local memory. Each action additionally requires an exact
     * native BehaviorAccess; this declaration alone grants no permission. */

    part def GovernedMemoryPolicy {
        attribute id : String;
        attribute revision : Integer {
            doc /* Positive safe integer. Every instantiated field is required. */
        }
        attribute allowedScopes : String {
            doc /* JSON text containing an explicit array of 1 to 32 distinct,
             * nonempty scope names. No global or cross-operator scope is added
             * implicitly. These labels classify local guidance only. */
        }
        attribute requireSourceRefs : Boolean;
        attribute requireKnownOutcome : Boolean;
        attribute maxValidityMs : Integer {
            doc /* Inclusive supported range: 1 to 31536000000 milliseconds.
             * Expiration does not renew automatically on recall or restart. */
        }
        attribute allowSelfAdmission : Boolean;
    }

    item def CaptureMemoryRequest {
        attribute id : String;
        attribute contentJson : String {
            doc /* JSON text containing exactly these required fields:
             * text: nonempty proposed guidance, at most 65536 characters;
             * origin: {decisionId: exact originating decision id,
             *          sourceRefs: array of local evidence references};
             * scope: nonempty array of explicit allowed scope names;
             * validUntil: explicit validity deadline as a timestamp string;
             * outcome: {status: "pending"} while the result is unknown, or
             *          {status: "known", summary: nonempty observed result,
             *           evidenceRefs: nonempty array of local evidence references}.
             * Source and outcome references use message:<exact local message id>.
             * Use observed local ids, never invented or peer references. The
             * host checks provenance, scopes, deadline and the admitted policy.
             * Capturing creates a candidate, never admitted guidance. */
        }
    }
    item def RecallMemoryRequest {
        attribute id : String [0..1];
    }
    item def ReviseMemoryRequest {
        attribute id : String;
        attribute expectedRevision : Integer;
        attribute expectedDigest : String;
        attribute contentJson : String {
            doc /* Complete replacement content using exactly the same JSON
             * shape as CaptureMemoryRequest.contentJson: text, origin with
             * decisionId and sourceRefs, scope, validUntil, and outcome. Outcome
             * is {status: "pending"} or {status: "known", summary, evidenceRefs}.
             * References use message:<exact local message id>. Revision requires
             * the current expectedRevision and expectedDigest and does not
             * inherit admission of the previous content. */
        }
    }
    item def ReviewMemoryRequest {
        attribute id : String;
        attribute expectedRevision : Integer;
        attribute expectedDigest : String;
        attribute decision : String {
            doc /* Exact decision: admit, request-revision or reject. The host
             * validates current authority, revision, digest and evidence.
             * Admission may additionally require source references and a known
             * outcome. Neither request-revision nor reject admits the content. */
        }
        attribute reason : String;
    }
    item def WithdrawMemoryRequest {
        attribute id : String;
        attribute expectedRevision : Integer;
        attribute expectedDigest : String;
        attribute reason : String;
    }

    action def CaptureMemory {
        in request : CaptureMemoryRequest;
    }
    action def RecallMemory {
        in request : RecallMemoryRequest;
    }
    action def ReviseMemory {
        in request : ReviseMemoryRequest;
    }
    action def ReviewMemory {
        in request : ReviewMemoryRequest;
    }
    action def WithdrawMemory {
        in request : WithdrawMemoryRequest;
    }
}
