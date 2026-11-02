package ASESequenceExample {
    doc /* Illustrative interaction for a separate demonstration system.
         * It is a declared scenario, not an observed execution trace or a callable behavior. */
    item def Request;
    item def Response;

    occurrence def Exchange {
        doc /* A declared request followed by a response. The event successions
             * establish the order, independently of message declaration order. */
        part caller {
            event occurrence sent;
            then event occurrence received;
        }
        part worker {
            event occurrence received;
            then event occurrence sent;
        }
        message response of Response from worker.sent to caller.received;
        message request of Request from caller.sent to worker.received;
    }

    view exchange : StandardViewDefinitions::SequenceView {
        expose Exchange;
    }
}
