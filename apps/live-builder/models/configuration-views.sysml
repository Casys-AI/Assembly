view builderActions : StandardViewDefinitions::GeneralView {
    expose liveBuilder::builder;
    expose liveBuilder::promotion::propose;
    expose liveBuilder::promotion::propose::candidate;
    expose liveBuilder::reply;
    expose liveBuilder::reply::response;
    expose liveBuilder::invokeRequest;
    expose liveBuilder::invokeRequest::request;
}
view agentOverview : StandardViewDefinitions::GeneralView {
    expose builderActions;
    expose liveBuilder::catalog;
    expose liveBuilder::catalog::*;
    expose liveBuilder::testSandbox;
    expose liveBuilder::admissionGate;
}
