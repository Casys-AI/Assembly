view Skills : StandardViewDefinitions::GeneralView {
    expose liveBuilder::context::skills;
    expose liveBuilder::context::skills::**;
}
view Contexte : StandardViewDefinitions::GeneralView {
    expose liveBuilder::context;
    expose liveBuilder::context::policy;
    expose liveBuilder::context::evidence;
    expose liveBuilder::context::evidence::**;
    expose liveBuilder::context::evidenceAccess;
    expose liveBuilder::context::evidenceAccess::**;
    expose Skills;
}
view 'Mémoire' : StandardViewDefinitions::GeneralView {
    expose liveBuilder::memory;
    expose liveBuilder::memory::**;
}
