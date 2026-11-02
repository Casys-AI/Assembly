import { legacyProductName } from "../../src/domain/model/sysml-product-names.ts";

/** Source-only reusable fixture; never mutates the committed example. */
export async function verifiedWorkSources(
  contract = true,
): Promise<Record<string, string>> {
  const sources = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../fixtures/commercial-watch/sources.json",
        import.meta.url,
      ),
    ),
  ) as Record<string, string>;
  for (
    const name of [
      "work-operators",
      "verified-effect-closure",
      "tool-publication-result",
    ]
  ) {
    // The commercial-watch example is a frozen ASE source family. Adapt only
    // these fresh library imports in the temporary test input; its committed
    // source bytes and native package identities remain historical.
    sources[`${name}.sysml`] = (await Deno.readTextFile(
      new URL(`../../models/${name}.sysml`, import.meta.url),
    )).replace(/\bAssembly[A-Za-z]+\b/g, legacyProductName);
  }
  sources["collect.sysml"] = sources["collect.sysml"]!.replace(
    "perform action inbox : ASEWork::AgentInbox;",
    `perform action inspectWorkArtifacts : ASEWork::InspectWorkArtifacts;
        allocate inspectWorkArtifacts to catalog;
        perform action inbox : ASEWork::AgentInbox;`,
  );
  sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
    "part collectorAccess : ASEInvocations::BehaviorAccess {",
    `part observationAccess : ASEInvocations::BehaviorAccess {
          attribute :>> name = "Inspecter le résultat";
          attribute :>> description = "Read exact active work artifact facts";
          attribute :>> enabled = true;
          ref item :>> input : ASEWork::WorkArtifactQuery;
        }
        bind observationAccess.caller = builder;
        bind observationAccess.target = ASECollect::collector.inspectWorkArtifacts;
        ${
      contract
        ? `part resultContract : APEVerifiedEffectClosure::WorkResultContract {
          ref part :>> work : ASEInvocations::BehaviorAccess;
          ref part :>> observation : ASEInvocations::BehaviorAccess;
          item :>> expected : ASEToolPublicationResult::PublicationExpectation {
            attribute :>> name = "reader";
            attribute :>> kind = "read_web_page";
            attribute :>> status = "active";
            attribute :>> count = 1;
          }
          ref item :>> observed : ASEToolPublicationResult::PublicationObservation;
          item :>> query : ASEToolPublicationResult::PublicationQuery {
            attribute :>> artifactName = "reader";
          }
          constraint :>> condition {
            observed.count == expected.count and observed.name == expected.name and observed.kind == expected.kind and
            observed.nativeCount == expected.count and observed.nativeName == expected.name and observed.nativeKind == expected.kind and
            observed.nativeContractCount == expected.count and observed.nativeContractKind == expected.kind and
            observed.localStatus == expected.status and observed.nativeStatus == expected.status and
            observed.storedDigest != "" and observed.storedDigest == observed.actualDigest and
            observed.storedDigest == observed.nativeDigest and observed.storedDigest == observed.admittedDigest and
            observed.candidateId == observed.admittedCandidateId and observed.testsPassed == true and
            observed.nativeId != "" and observed.bindingId != "" and observed.nativeId == observed.bindingId
          }
          attribute :>> maxObservations = 2;
        }
        bind resultContract.work = ASELiveBuilder::liveBuilder.collectorAccess;
        bind resultContract.observation = ASELiveBuilder::liveBuilder.observationAccess;`
        : ""
    }
        part collectorAccess : ASEInvocations::BehaviorAccess {`,
  );
  return sources;
}

/** Same work/read exposures with an independent scalar record completion rule. */
export async function verifiedRecordSources(
  operator: ">=" | "<=" = ">=",
): Promise<Record<string, string>> {
  const sources = await verifiedWorkSources();
  sources["record-state.sysml"] =
    `package RecordState { private import ScalarValues::*;
    item def Expected { attribute status : String; attribute amount : Integer; }
    item def Observed { attribute status : String; attribute amount : Integer; }
    item def RecordQuery {
      attribute workInvocationId : String;
      attribute workBehaviorId : String;
      attribute workInputDigest : String;
      attribute recordId : String;
    }
    item def RecordSelection { attribute recordId : String; }
    action def ReadRecord {
      in request : RecordQuery;
      out result : Observed;
    }
  }`;
  sources["collect.sysml"] = sources["collect.sysml"]!.replace(
    "perform action inspectWorkArtifacts : ASEWork::InspectWorkArtifacts;",
    "perform action readRecord : RecordState::ReadRecord;",
  ).replace(
    "allocate inspectWorkArtifacts to catalog;",
    "allocate readRecord to catalog;",
  );
  sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
    "bind observationAccess.target = ASECollect::collector.inspectWorkArtifacts;",
    "bind observationAccess.target = ASECollect::collector.readRecord;",
  ).replace(
    "ref item :>> input : ASEWork::WorkArtifactQuery;",
    "ref item :>> input : RecordState::RecordQuery;",
  );
  sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
    /item :>> expected : ASEToolPublicationResult::PublicationExpectation \{[\s\S]*?constraint :>> condition \{[\s\S]*?\}/,
    `item :>> expected : RecordState::Expected {attribute :>> status = "paid"; attribute :>> amount = 20;}
     ref item :>> observed : RecordState::Observed;
     item :>> query : RecordState::RecordSelection { attribute :>> recordId = "record-A"; }
     constraint :>> condition {observed.status == expected.status and observed.amount ${operator} expected.amount}`,
  );
  return sources;
}

/** Expected state and read selection are copied only through native input bindings. */
export async function verifiedBoundRecordSources(): Promise<
  Record<string, string>
> {
  const sources = await verifiedRecordSources();
  sources["record-state.sysml"] = sources["record-state.sysml"]!.replace(
    "action def ReadRecord {",
    `item def WorkInput {
    attribute recordId : String;
    attribute status : String;
    attribute amount : Integer;
  }
  action def WriteRecord { in request : WorkInput; }
  action def ReadRecord {`,
  );
  sources["collect.sysml"] = sources["collect.sysml"]!.replace(
    "perform action readRecord : RecordState::ReadRecord;",
    `perform action writeRecord : RecordState::WriteRecord;
    allocate writeRecord to builder;
    perform action readRecord : RecordState::ReadRecord;`,
  );
  sources["configuration.sysml"] = sources["configuration.sysml"]!
    .replace(
      "ref item :>> input : ASEWork::WorkRequest;",
      "ref item :>> input : RecordState::WorkInput;",
    )
    .replace(
      "bind collectorAccess.target = ASECollect::collector.inbox;",
      "bind collectorAccess.target = ASECollect::collector.writeRecord;",
    )
    .replace(
      'item :>> expected : RecordState::Expected {attribute :>> status = "paid"; attribute :>> amount = 20;}',
      "ref item :>> input : RecordState::WorkInput; item :>> expected : RecordState::Expected;",
    )
    .replace(
      'item :>> query : RecordState::RecordSelection { attribute :>> recordId = "record-A"; }',
      "item :>> query : RecordState::RecordSelection;",
    )
    .replace(
      "bind resultContract.work = ASELiveBuilder::liveBuilder.collectorAccess;",
      `bind resultContract.work = ASELiveBuilder::liveBuilder.collectorAccess;
      bind resultContract.input = ASELiveBuilder::liveBuilder.collectorAccess.input;
      bind resultContract.expected.status = resultContract.input.status;
      bind resultContract.expected.amount = resultContract.input.amount;
      bind resultContract.query.recordId = resultContract.input.recordId;`,
    );
  return sources;
}
