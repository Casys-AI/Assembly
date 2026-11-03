package APEContext {
    private import ScalarValues::*;

    doc /* APE 5.1 - Context Separation. Bounded decision-context policy and
     * evidence access separate the current decision context from durable
     * execution evidence. A concrete ConversationSystem may own one explicit
     * policy. Definitions alone neither change the context nor grant access to
     * evidence. ReadContextEvidence requires a separately admitted BehaviorAccess
     * and remains confined to the receiving operator's own conversation. */

    part def DecisionContextPolicy {
        attribute id : String;
        attribute revision : Integer {
            doc /* Positive safe integer. Every instantiated field is required. */
        }
        attribute recentMessages : Integer {
            doc /* Inclusive supported range: 1 to 100. */
        }
        attribute maxMessageCharacters : Integer {
            doc /* Inclusive supported range: 256 to 100000 characters. */
        }
        attribute maxCollectionItems : Integer {
            doc /* Inclusive supported range: 1 to 128. */
        }
        attribute maxContextCharacters : Integer {
            doc /* Inclusive supported range: 4096 to 2000000 characters for the
             * complete serialized decision context. Required facts are never
             * silently dropped to satisfy this bound. */
        }
    }

    part def ModelingGuidance {
        attribute id : String;
        attribute revision : Integer;
        attribute content : String;
        doc /* Source-admitted modeling advice for this operator. Guidance helps
         * construction decisions; it grants no permission and does not assert
         * that a pattern has been implemented or qualified. */
    }

    item def ContextEvidenceRequest {
        attribute messageId : String {
            doc /* Exact id of an evidence message in this operator's own
             * conversation. A reference is not permission to read a peer. */
        }
        attribute messageDigest : String {
            doc /* Exact SHA-256 digest supplied with the evidence reference.
             * A stale or altered message must not satisfy this request. */
        }
        attribute offset : Integer [0..1];
        attribute limit : Integer [0..1];
        doc /* Read a bounded UTF-16 character page of the exact journal message
         * encoded as JSON. Offset defaults to 0; limit defaults to 2048 and may
         * not exceed 2048. The response carries the next exact selection.
         * Ownership and the digest of the complete message are checked for
         * every page. Historical two-field pins retain their whole-message
         * contract; pagination requires admission of this request type. */
    }

    action def ReadContextEvidence {
        in request : ContextEvidenceRequest;
    }
}
