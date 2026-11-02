import { DYNAMIC_MANDATE_SOURCE } from "./mandates.ts";

/** Trusted Request composition; substitutions accept scalar values and quoted names only. */
export const REQUEST_OPERATOR_TEMPLATE = `part __SYSTEM__ : ConversationSystem {
        attribute operatorName : String = __NAME__;
        attribute operatorInstruction : String = __INSTRUCTION__;
        attribute primaryContact : Boolean = false;
        attribute humanInputEnabled : Boolean = false;
        attribute authoritySchema : Integer = 2;
        attribute envelopeKind : String = "conversational-case-management";
        attribute envelopePattern : String = "1.3";
        attribute envelopeRevision : String = "1";
        attribute configurationId : String = __ID__;
        attribute configurationRevision : String = "0";
        attribute admissionMode : String = "human";
        attribute networkHosts : String = __HOSTS__;
        part owner : AssemblyCore::HumanOperator {
            item ownerMandate : AssemblyAuthority::Mandate {
                attribute :>> id = "owner";
                attribute :>> revision = 1;
                part rootAuthority : AssemblyAuthority::RootAuthority {
                    attribute :>> id = "owner-root";
                }
                part rootGrant : AssemblyAuthority::RootGrant {
                    attribute :>> id = "owner-root-grant";
                }
                bind rootGrant.issuer = rootAuthority;
            }
        }
        bind owner.ownerMandate.holder = owner;
        part builder : ConversationBuilder {
 attribute operatorId : String = __ID__;
 attribute configuredName : String = __NAME__;
 attribute instruction : String = __INSTRUCTION__;
 }
        part testSandbox : CandidateTestSandbox;
        part catalog : ToolCatalog {
            item readWebPageContract : CapabilityContract {
                attribute :>> kind = "read_web_page";
                attribute :>> module = "default({url,html}) => {title,text}";
                attribute :>> acceptanceCriteria = "Return the actual nonempty HTML document title and readable text, decoding HTML entities.\\nExclude script, style and comment contents; never execute HTML scripts.\\nPure self-contained HTML transformation: no imports, DOMParser, fetch, network, files, environment, subprocesses or ambient permissions. URL is available for URL resolution.\\nPreserve the meaningful body text, including prose and headings. Three varied full-text extraction fixtures must pass.";
            }
            item readWebPageOutlineContract : CapabilityContract {
                attribute :>> kind = "read_web_page_outline";
                attribute :>> module = "default({url,html}) => {title,text}";
                attribute :>> acceptanceCriteria = "Return the actual nonempty HTML document title and readable text, decoding HTML entities.\\nExclude script, style and comment contents; never execute HTML scripts.\\nPure self-contained HTML transformation: no imports, DOMParser, fetch, network, files, environment, subprocesses or ambient permissions. URL is available for URL resolution.\\ntext conveys all h1-h6 heading texts in document order and the distinct canonical absolute http(s) URLs from anchor href attributes, in first occurrence order. Full body prose is not required.\\nResolve relative paths, ../ paths, ?queries and //host URLs using new URL(href, url). Decode HTML entities in href; remove URL fragments, deduplicate after canonicalization, skip empty or fragment-only href and all non-http(s) schemes (including javascript:, data:, mailto:).\\nRender each canonical URL intact in text, separated by whitespace or Markdown link delimiters. Three varied outline extraction fixtures must pass.";
            }
        }
        part admissionGate : CatalogAdmissionGate;
        item builderMandate : ConfiguredMandate {
            attribute :>> id = "builder-v1";
            attribute :>> version = "1";
            attribute :>> scope = "Propose read_web_page and read_web_page_outline; invoke active catalog tools";
            attribute :>> source = ${JSON.stringify(DYNAMIC_MANDATE_SOURCE)};
            attribute :>> evidenceLevel = "configured";
            attribute :>> grantingOperator = "unknown";
            attribute :>> mayProposeReadWebPage = true;
            attribute :>> mayProposeReadWebPageOutline = true;
            attribute :>> mayInvokeActiveCatalog = true;
            attribute :>> mayReviewExactCandidate = false;
            attribute :>> mayAdmit = false;
            attribute :>> mayActivate = false;
            attribute :>> mayChangeOwnMandate = false;
            attribute :>> mayCreateAgents = false;
        }
        bind builder.mandate = builderMandate;
        bind builderMandate.holder = builder;
        connect builder.proposals to testSandbox.proposals;
        connect testSandbox.testedCandidates to catalog.candidates;
        connect testSandbox.testedCandidates to admissionGate.candidates;
        connect testSandbox.results to admissionGate.tests;
        connect admissionGate.decisions to catalog.admissions;
        perform action reply : ReplyToConversation;
        perform action invokeRequest : RequestToolInvocation;
        allocate reply to builder;
        allocate invokeRequest to builder;
        perform action promotion : CapabilityPromotion;
        allocate promotion.propose to builder;
        allocate promotion.test to testSandbox;
        allocate promotion.admit to admissionGate;
        allocate promotion.activate to catalog;
        allocate promotion.refuse to admissionGate;
        perform action operatorFlowTemplate : ConsultingConversationV1;
        attribute operatorFlowTemplateRevision : Integer = __FLOW_REVISION__;
        perform action conversation : ConsultingConversationV1 {
            item executionPolicy : ExecutionPolicy {
                attribute :>> maxAgentDecisions = 7;
                attribute :>> maxToolProposals = 2;
                attribute :>> maxFlowSteps = 128;
                attribute :>> urlSelectionMode = "user-provided";
                attribute :>> mayAddNetworkHosts = true;
                attribute :>> mayDelegateOwnAdmission = false;
                attribute :>> mayCreateReviewer = false;
                attribute :>> mayChangeUrlSelection = false;
                __MODEL_READ_DECLARATION__
                attribute :>> mayProposeSysmlRevision = __MAY_PROPOSE_SYSML_REVISION__;
            }
        }
        allocate conversation.readCaseState to admissionGate;
        allocate conversation.executeOperatorCommand to admissionGate;
        allocate conversation.chooseNextMove to builder;
        allocate conversation.replyOrClarify to builder;
        allocate conversation.waitForInput to admissionGate;
        allocate conversation.checkRequestedAction to admissionGate;
        allocate conversation.executeAction to catalog;
        allocate conversation.recordRefusal to admissionGate;
        allocate conversation.submitChangeProposal to admissionGate;
        allocate conversation.observeOutcome to admissionGate;
    
        attribute firstRequestObjective : String = __OBJECTIVE__;
        part __REQUEST__ : AssemblyCases::CaseType {
            attribute :>> envelope = AssemblyCases::EnvelopeKind::conversational;
            ref action :>> behavior = conversation;
            ref part :>> owner = builder;
            attribute :>> maxInvocations = __CEILING__;
        }
}`;

/** Reuse the durable operator composition without manufacturing another Request. */
export const TEAM_OPERATOR_TEMPLATE = REQUEST_OPERATOR_TEMPLATE
  .replace(
    /\n {8}attribute firstRequestObjective[\s\S]*?\n}$/,
    "\n        perform action inbox : AssemblyWork::AgentInbox;\n        allocate inbox to builder;\n__TEAM_DECLARATIONS__\n}",
  )
  .replace("maxAgentDecisions = 7", "maxAgentDecisions = __MAX_DECISIONS__")
  .replace("maxToolProposals = 2", "maxToolProposals = __MAX_PROPOSALS__")
  .replace("maxFlowSteps = 128", "maxFlowSteps = __MAX_STEPS__")
  .replace(
    "mayProposeReadWebPage = true",
    "mayProposeReadWebPage = __MAY_PROPOSE_READ_WEB_PAGE__",
  )
  .replace(
    "mayProposeReadWebPageOutline = true",
    "mayProposeReadWebPageOutline = __MAY_PROPOSE_READ_WEB_PAGE_OUTLINE__",
  )
  .replace(
    "mayInvokeActiveCatalog = true",
    "mayInvokeActiveCatalog = __MAY_INVOKE_ACTIVE_CATALOG__",
  )
  .replace(
    "mayAddNetworkHosts = true",
    "mayAddNetworkHosts = __MAY_ADD_NETWORK_HOSTS__",
  );

/** State the explicit proposal capability. Actual hosts remain separately provisioned. */
export function teamOperatorTemplate(
  mayAddNetworkHosts: boolean,
): string {
  return TEAM_OPERATOR_TEMPLATE.replace(
    "__MAY_ADD_NETWORK_HOSTS__",
    String(mayAddNetworkHosts),
  );
}
