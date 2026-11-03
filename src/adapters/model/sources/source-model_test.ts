import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { requestControlModel } from "../../../../test/support/request-space-fixture.ts";
import {
  DYNAMIC_MANDATE_SOURCE,
  LEGACY_DYNAMIC_MANDATE_SOURCE,
} from "../../../domain/governance/mandates.ts";
import type {
  ModelSourceProposalStatus,
} from "../../../domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../../domain/governance/records/pending-change.ts";
import {
  type ChangePublication,
  ChangePublicationError,
} from "../../../domain/model/publication/change.ts";
import { ExplicitTooling } from "../../../../test/support/explicit-tooling.ts";
import {
  declareReviewer,
  selectValidatedSourceExecutable,
  SourceModel,
  sourceModelIdentity,
  type SourceRepository,
  type SourceRevision,
} from "./source-model.ts";

Deno.test("validated source selection retains explicit, primary and single-unit rules", () => {
  const first = requestControlModel();
  const second = structuredClone(first);
  first.operator = { ...first.operator!, primary: false };
  second.operator = { ...second.operator!, primary: true };
  const compiled = [
    {
      unit: { systemQualifiedName: "First", identity: first.identity },
      model: first,
    },
    {
      unit: { systemQualifiedName: "Second", identity: second.identity },
      model: second,
    },
  ];
  equal(selectValidatedSourceExecutable(compiled, "First"), first);
  equal(selectValidatedSourceExecutable(compiled), second);
  equal(selectValidatedSourceExecutable([compiled[0]!]), first);
  throws(
    () => selectValidatedSourceExecutable(compiled, "Missing"),
    /Select an exact native conversation system/,
  );
  throws(
    () => selectValidatedSourceExecutable([...compiled, compiled[0]!], "First"),
    /Select an exact native conversation system/,
  );
});

type Record = ModelSourceProposalStatus & {
  author: string;
  reason?: string;
  sources?: { [path: string]: string };
  diff?: unknown[];
  peerHistory?: unknown[];
};

function fixture(withProposals = true) {
  const scope = "Team::operator";
  const projectId = "git:eaa8ee83-b912-5b8d-b114-db28a72570bd";
  const revision: SourceRevision = {
    version: "branch:current",
    sources: {
      "team.sysml":
        "package Team { part operator { part catalog; part builder; } }",
    },
    elements: [{
      "@id": "team-package",
      "@type": "Package",
      qualifiedName: "Team",
      declaredName: "Team",
    }, {
      "@id": "operator-system",
      "@type": "PartUsage",
      qualifiedName: scope,
      declaredName: "operator",
      owner: { "@id": "team-package" },
    }, {
      "@id": "operator-catalog",
      "@type": "PartUsage",
      qualifiedName: `${scope}::catalog`,
      declaredName: "catalog",
      owner: { "@id": "operator-system" },
    }, {
      "@id": "operator-builder",
      "@type": "PartUsage",
      qualifiedName: `${scope}::builder`,
      declaredName: "builder",
      owner: { "@id": "operator-system" },
    }],
  };
  const identity = sourceModelIdentity(revision, projectId, scope);
  const records: Record[] = [];
  const calls = { current: 0, list: 0, mutation: 0 };
  const mutation = () => {
    calls.mutation++;
    throw new Error("Read operation attempted a repository mutation");
  };
  const repository: SourceRepository = {
    findPublication: () => Promise.resolve(null),
    initialize: mutation,
    current() {
      calls.current++;
      return Promise.resolve(revision);
    },
    at() {
      throw new Error("No historical source read expected");
    },
    propose: mutation,
    publishSystemSources: mutation,
    updateSystemSources: mutation,
    ...(withProposals
      ? {
        listProposals() {
          calls.list++;
          return Promise.resolve(records);
        },
      }
      : {}),
  };
  const model = new SourceModel({
    tooling: new ExplicitTooling(),
    repository,
    projectId,
    systemQualifiedName: scope,
  });
  const own = (
    id: string,
    status: ModelSourceProposalStatus["status"],
  ): Record => ({
    id,
    baseVersion: "branch:source-base",
    status,
    author: `agent:${identity.builderId}`,
  });
  return { model, identity, records, calls, own, revision, repository };
}

Deno.test("source identity follows changed revisions and rejects ambiguous declarations", () => {
  const f = fixture();
  const changed = structuredClone(f.revision);
  const builder = changed.elements.find((element) =>
    element["@id"] === "operator-builder"
  )!;
  builder["@id"] = "updated-builder";
  equal(
    sourceModelIdentity(changed, f.identity.projectId, "Team::operator")
      .builderId,
    "updated-builder",
  );
  equal(
    sourceModelIdentity(f.revision, f.identity.projectId, "Team::operator")
      .builderId,
    "operator-builder",
  );
  changed.elements.push({ ...builder, "@id": "ambiguous-builder" });
  throws(
    () => sourceModelIdentity(changed, f.identity.projectId, "Team::operator"),
    /Ambiguous product library declaration/,
  );
});

function published(version = "branch:current") {
  return {
    version,
    sourceDigest: `source-digest:${version}`,
    author: "ase:source-publication",
    createdAt: "2026-10-21T10:23:00.000Z",
    message: "Private commit message is not agent context",
    parentVersion: "branch:parent",
  };
}

Deno.test("source proposal reads expose the operator's exact current repository statuses", async () => {
  const f = fixture();
  const statuses: ModelSourceProposalStatus["status"][] = [
    "preparing",
    "proposed",
    "accepting",
    "accepted",
    "rejected",
  ];
  f.records.push(...statuses.map((status) => f.own(`own-${status}`, status)));
  f.records[3]!.acceptedVersion = "branch:accepted_exact_123";
  deepStrictEqual(await f.model.readSourceProposals(f.identity), [
    {
      id: "own-preparing",
      baseVersion: "branch:source-base",
      status: "preparing",
    },
    {
      id: "own-proposed",
      baseVersion: "branch:source-base",
      status: "proposed",
    },
    {
      id: "own-accepting",
      baseVersion: "branch:source-base",
      status: "accepting",
    },
    {
      id: "own-accepted",
      baseVersion: "branch:source-base",
      status: "accepted",
      acceptedVersion: "branch:accepted_exact_123",
    },
    {
      id: "own-rejected",
      baseVersion: "branch:source-base",
      status: "rejected",
    },
  ]);
  f.records[1]!.status = "accepted";
  f.records[1]!.acceptedVersion = "commit:accepted_later";
  const current = await f.model.readSourceProposals(f.identity);
  equal(current[1]!.status, "accepted");
  equal(current[1]!.acceptedVersion, "commit:accepted_later");
  deepStrictEqual(f.calls, { current: 2, list: 2, mutation: 0 });
});

Deno.test("source proposal ownership uses the complete exact native author rather than a shared prefix", async () => {
  const f = fixture();
  f.records.push(
    f.own("own", "proposed"),
    { ...f.own("peer", "accepted"), author: "agent:another-builder" },
    {
      ...f.own("prefix", "proposed"),
      author: `agent:${f.identity.builderId}-peer`,
    },
    { ...f.own("human", "accepted"), author: `human:${f.identity.builderId}` },
    { ...f.own("case", "proposed"), author: `Agent:${f.identity.builderId}` },
  );
  deepStrictEqual(await f.model.readSourceProposals(f.identity), [{
    id: "own",
    baseVersion: "branch:source-base",
    status: "proposed",
  }]);
});

Deno.test("source proposal context carries no source, diff, reason, author or peer history and is detached", async () => {
  const f = fixture();
  f.records.push({
    ...f.own("own", "accepted"),
    acceptedVersion: "branch:accepted_exact",
    reason: "Private authoring context",
    sources: { "private.sysml": "package Private;" },
    diff: [{ before: "private source", after: "private revision" }],
    peerHistory: ["Other agent's private dialogue"],
  });
  const result = await f.model.readSourceProposals(f.identity);
  deepStrictEqual(Object.keys(result[0]!).sort(), [
    "acceptedVersion",
    "baseVersion",
    "id",
    "status",
  ]);
  result[0]!.id = "changed-in-context";
  result[0]!.acceptedVersion = "branch:changed-in-context";
  result.push({
    id: "added-in-context",
    baseVersion: "branch:base",
    status: "proposed",
  });
  equal(f.records.length, 1);
  equal(f.records[0]!.id, "own");
  equal(f.records[0]!.acceptedVersion, "branch:accepted_exact");
});

Deno.test("source proposal reads verify the requested native scope before listing any author records", async () => {
  const f = fixture();
  for (
    const identity of [
      { ...f.identity, builderId: "another-builder" },
      { ...f.identity, systemId: "another-system" },
      { ...f.identity, systemQualifiedName: "Team::another" },
      { ...f.identity, projectId: "git:5d85dd85-6417-576d-98cd-c3c803f111c4" },
    ]
  ) await rejects(() => f.model.readSourceProposals(identity));
  equal(f.calls.list, 0);
  equal(f.calls.mutation, 0);
});

Deno.test("an optional repository without proposal listing returns no fabricated source status", async () => {
  const f = fixture(false);
  deepStrictEqual(await f.model.readSourceProposals(f.identity), []);
  equal(f.calls.current, 1);
  equal(f.calls.list, 0);
  equal(f.calls.mutation, 0);
  await rejects(() =>
    f.model.readSourceProposals({ ...f.identity, builderId: "another" })
  );
  equal(f.calls.current, 2);
});

Deno.test("source reads without history preserve the legacy source snapshot and do not list proposals", async () => {
  const f = fixture();
  deepStrictEqual(await f.model.readSourceRevision(f.identity), {
    version: f.revision.version,
    sources: f.revision.sources,
  });
  equal(f.calls.list, 0);
  equal(f.calls.mutation, 0);
});

Deno.test("published source history exposes a peer's accepted proposal and exact public commit metadata", async () => {
  const f = fixture();
  const commit = published();
  f.repository.history = () =>
    Promise.resolve({
      headVersion: f.revision.version,
      truncated: false,
      commits: [commit],
    });
  f.records.push({
    ...f.own("peer-accepted", "accepted"),
    author: "agent:peer-builder",
    acceptedVersion: commit.version,
    reason: "Private proposal conversation",
    sources: { "peer-private.sysml": "package PeerPrivate;" },
    diff: ["Private changes"],
    peerHistory: ["Private peer messages"],
  });
  const result = await f.model.readSourceRevision(f.identity);
  deepStrictEqual(result.publishedRevisions, {
    limit: 32,
    proposalLimit: 64,
    truncated: false,
    commits: [{
      version: commit.version,
      sourceDigest: commit.sourceDigest,
      author: commit.author,
      createdAt: commit.createdAt,
      proposals: [{ id: "peer-accepted", author: "agent:peer-builder" }],
    }],
  });
  deepStrictEqual(await f.model.readSourceProposals(f.identity), []);
  equal(f.calls.mutation, 0);
});

Deno.test("only accepted proposals on the published history can contribute proposal metadata", async () => {
  const f = fixture();
  const commits = ["proposed", "rejected", "accepting", "preparing"].map((
    status,
  ) => published(`branch:${status}`));
  f.repository.history = () =>
    Promise.resolve({
      headVersion: f.revision.version,
      truncated: false,
      commits,
    });
  for (const commit of commits) {
    f.records.push({
      ...f.own(
        `private-${commit.version}`,
        commit.version.slice(7) as ModelSourceProposalStatus["status"],
      ),
      author: `agent:private-${commit.version}`,
      acceptedVersion: commit.version,
    });
  }
  f.records.push({
    ...f.own("peer-not-in-history", "accepted"),
    author: "agent:peer-unpublished-branch",
    acceptedVersion: "branch:unpublished",
  });
  deepStrictEqual(
    (await f.model.readSourceRevision(f.identity)).publishedRevisions!.commits,
    commits.map(({ version, sourceDigest, author, createdAt }) => ({
      version,
      sourceDigest,
      author,
      createdAt,
    })),
  );
});

Deno.test("two accepted no-op proposals on the same publication retain both exact proofs", async () => {
  const f = fixture();
  const commit = published();
  f.repository.history = () =>
    Promise.resolve({
      headVersion: f.revision.version,
      truncated: false,
      commits: [commit],
    });
  f.records.push(...["first", "second"].map((id) => ({
    ...f.own(id, "accepted"),
    author: `agent:${id}`,
    acceptedVersion: commit.version,
  })));
  const result = await f.model.readSourceRevision(f.identity);
  const { message: _message, parentVersion: _parentVersion, ...expected } =
    commit;
  deepStrictEqual(result.publishedRevisions!.commits, [{
    ...expected,
    proposals: [
      { id: "first", author: "agent:first" },
      { id: "second", author: "agent:second" },
    ],
  }]);
  equal(result.publishedRevisions!.truncated, false);
});

Deno.test("published proposal associations share a 64 item budget in main history order", async () => {
  const f = fixture();
  const commits = [
    published(),
    published("branch:second"),
    published("branch:third"),
  ];
  f.repository.history = () =>
    Promise.resolve({
      headVersion: f.revision.version,
      truncated: false,
      commits,
    });
  const accepted = (version: string, count: number) =>
    Array.from(
      { length: count },
      (_, index) => ({
        ...f.own(`${version}-${index}`, "accepted"),
        author: `agent:peer-${index}`,
        acceptedVersion: version,
      }),
    );
  const first = accepted(commits[0]!.version, 33);
  const second = accepted(commits[1]!.version, 32);
  const third = accepted(commits[2]!.version, 2);
  f.records.push(
    { ...f.own("pending", "proposed"), acceptedVersion: commits[0]!.version },
    ...third,
    ...second,
    ...first,
  );
  let result = (await f.model.readSourceRevision(f.identity))
    .publishedRevisions!;
  equal(result.proposalLimit, 64);
  equal(result.truncated, true);
  deepStrictEqual(
    result.commits.map((commit) => commit.proposals?.length ?? 0),
    [33, 31, 0],
  );
  deepStrictEqual(
    result.commits[0]!.proposals,
    first.map(({ id, author }) => ({ id, author })),
  );
  deepStrictEqual(
    result.commits[1]!.proposals,
    second.slice(0, 31).map(({ id, author }) => ({ id, author })),
  );
  equal(result.commits[2]!.proposals, undefined);
  f.records.splice(0, f.records.length, ...first, ...second.slice(0, 31));
  result = (await f.model.readSourceRevision(f.identity)).publishedRevisions!;
  equal(result.truncated, false);
  equal(result.commits.flatMap((commit) => commit.proposals ?? []).length, 64);
  result.commits[0]!.proposals![0]!.author = "context-only-mutation";
  equal(first[0]!.author, "agent:peer-0");
});

Deno.test("published source history always announces and enforces its 32 commit bound", async () => {
  const f = fixture();
  const limits: unknown[] = [];
  const commits = Array.from(
    { length: 40 },
    (_, index) => published(`branch:commit-${index}`),
  );
  let truncated = false;
  f.repository.history = (options) => {
    limits.push(options);
    return Promise.resolve({
      headVersion: f.revision.version,
      truncated,
      commits,
    });
  };
  let result = await f.model.readSourceRevision(f.identity);
  equal(result.publishedRevisions!.limit, 32);
  equal(result.publishedRevisions!.commits.length, 32);
  equal(result.publishedRevisions!.truncated, true);
  commits.splice(3);
  truncated = true;
  result = await f.model.readSourceRevision(f.identity);
  equal(result.publishedRevisions!.commits.length, 3);
  equal(result.publishedRevisions!.truncated, true);
  deepStrictEqual(limits, [{ limit: 32 }, { limit: 32 }]);
});

Deno.test("a source HEAD race pins sources to the exact head returned by publication history", async () => {
  const f = fixture();
  const historyHead = {
    ...structuredClone(f.revision),
    version: "branch:history-head",
    sources: { "team.sysml": "package Team { // accepted peer change\n}" },
  };
  const pins: string[] = [];
  f.repository.history = () =>
    Promise.resolve({
      headVersion: historyHead.version,
      truncated: false,
      commits: [published(historyHead.version)],
    });
  f.repository.at = (version) => {
    pins.push(version);
    return Promise.resolve(historyHead);
  };
  const result = await f.model.readSourceRevision(f.identity);
  equal(result.version, historyHead.version);
  deepStrictEqual(result.sources, historyHead.sources);
  equal(result.publishedRevisions!.commits[0]!.version, result.version);
  deepStrictEqual(pins, [historyHead.version]);
  equal(f.calls.current, 1);
  equal(f.calls.mutation, 0);
});

Deno.test("source publication reads verify identity before history and verify a raced immutable snapshot", async () => {
  const f = fixture();
  let histories = 0;
  f.repository.history = () => {
    histories++;
    return Promise.resolve({
      headVersion: "branch:later",
      truncated: false,
      commits: [published("branch:later")],
    });
  };
  await rejects(() =>
    f.model.readSourceRevision({ ...f.identity, builderId: "another-builder" })
  );
  equal(histories, 0);
  f.repository.at = () =>
    Promise.resolve({
      ...f.revision,
      version: "branch:later",
      elements: f.revision.elements.map((element) => ({
        ...element,
        ...(element["@id"] === f.identity.builderId
          ? { "@id": "another-builder" }
          : {}),
      })),
    });
  await rejects(() => f.model.readSourceRevision(f.identity));
  equal(histories, 1);
  equal(f.calls.list, 0);
  f.repository.at = () => Promise.resolve(f.revision);
  await rejects(
    () => f.model.readSourceRevision(f.identity),
    /snapshot does not match/,
  );
  equal(f.calls.list, 0);
});

Deno.test("published revision DTOs are detached and work without proposal listing", async () => {
  const f = fixture(false);
  const commits = [published()];
  f.repository.history = () =>
    Promise.resolve({
      headVersion: f.revision.version,
      truncated: false,
      commits,
    });
  const result = await f.model.readSourceRevision(f.identity);
  result.sources["team.sysml"] = "changed context sources";
  result.publishedRevisions!.commits[0]!.author = "changed context author";
  result.publishedRevisions!.commits.push({
    version: "branch:added",
    sourceDigest: "added-digest",
    author: "added-author",
    createdAt: "added-date",
  });
  equal(
    f.revision.sources["team.sysml"],
    "package Team { part operator { part catalog; part builder; } }",
  );
  equal(commits.length, 1);
  equal(commits[0]!.author, "ase:source-publication");
  deepStrictEqual(
    Object.keys(
      (await f.model.readSourceRevision(f.identity)).publishedRevisions!
        .commits[0]!,
    ).sort(),
    ["author", "createdAt", "sourceDigest", "version"],
  );
  equal(f.calls.list, 0);
  equal(f.calls.mutation, 0);
});

Deno.test("source proposal status preserves detached diagnostic addresses", async () => {
  const f = fixture();
  const addresses = [{ code: "LOOP_WITHOUT_BUDGET", elementId: "native-loop" }];
  f.records.push({ ...f.own("correction", "proposed"), addresses });
  const listed = await f.model.readSourceProposals(f.identity);
  deepStrictEqual(listed[0]!.addresses, addresses);
  listed[0]!.addresses![0]!.elementId = "changed-by-caller";
  equal(
    (await f.model.readSourceProposals(f.identity))[0]!.addresses![0]!
      .elementId,
    "native-loop",
  );
});

/** Direct (no-writer) compatibility apply of a historical receipt without an
 * approved source base. The repository feeds the given HEAD revision straight
 * into the prepare path, exactly as a source-only commit would move the pin. */
function directApplySetup(headVersion: string) {
  const f = fixture();
  const head: SourceRevision = { ...f.revision, version: headVersion };
  const projectId = "git:eaa8ee83-b912-5b8d-b114-db28a72570bd";
  const scope = "Team::operator";
  const repository: SourceRepository = {
    findPublication: () => Promise.resolve(null),
    initialize: () => Promise.resolve(head),
    current: () => Promise.resolve(head),
    at: () => Promise.resolve(head),
    propose: () => Promise.reject(new Error("unexpected propose")),
    publishSystemSources: () => Promise.reject(new Error("unexpected publish")),
    updateSystemSources: (update) =>
      update(structuredClone(head)) as unknown as Promise<SourceRevision>,
  };
  const model = new SourceModel({
    tooling: new ExplicitTooling(),
    repository,
    projectId,
    systemQualifiedName: scope,
  });
  const identity = sourceModelIdentity(head, projectId, scope);
  const authorityExercise = {
    ownerSource: "modeled",
    systemId: identity.systemId,
    operatorId: identity.builderId,
    operatorNativeId: "operator-system",
    mandateId: "mandate",
    mandateNativeId: "mandate",
    mandateRevision: 0,
    rootAuthorityId: "root",
    rootAuthorityNativeId: "root",
    rootGrantId: "grant",
    rootGrantNativeId: "grant",
    sourceIds: [],
    authoritySchema: 2,
    action: "mandate-change",
    baseModelDigest: "digest-pin",
    outOfMandate: false,
  };
  const change = {
    id: "01900000-0000-4000-8000-000000000000",
    kind: "mandate-change",
    status: "approved",
    requestedBy: identity.builderId,
    baseRevision: 0,
    authorityExercise,
  } as unknown as PendingChange;
  // Historical receipt: no approvedSourceBase, only the adopted execution pin.
  const publication = {
    changeId: change.id,
    authorityExercise: structuredClone(authorityExercise),
    baseModelDigest: "digest-pin",
    baseRevision: 0,
    adoptedPin: { digest: "digest-pin", repositoryVersion: "branch:current" },
    decidedAt: "2026-10-28T00:00:00.000Z",
    edits: [],
  } as unknown as ChangePublication;
  return { model, identity, change, publication };
}

Deno.test("direct approved-change apply without a writer refuses a digest-preserving pin move", async () => {
  const { model, identity, change, publication } = directApplySetup(
    "branch:moved",
  );
  await rejects(
    () =>
      model.applyApprovedChange(identity, change, "digest-pin", publication),
    (error) => {
      ok(error instanceof ChangePublicationError);
      equal(error.code, "PUBLICATION_NOT_APPLICABLE");
      equal(error.recovery, "refuse");
      ok(error.message.includes("adopted source pin moved"));
      return true;
    },
  );
});

Deno.test("direct approved-change apply without a writer passes the exact adopted pin", async () => {
  const { model, identity, change, publication } = directApplySetup(
    "branch:current",
  );
  await rejects(
    () =>
      model.applyApprovedChange(identity, change, "digest-pin", publication),
    (error) => {
      ok(error instanceof ChangePublicationError);
      equal(error.code, "PUBLICATION_NOT_APPLICABLE");
      // The pin gate passed: preparation proceeded past it into model
      // preparation, which the read-only fixture cannot satisfy, instead of
      // the pin refusal.
      ok(!error.message.includes("adopted source pin moved"));
      return true;
    },
  );
});

Deno.test("direct approved-change apply without a writer proceeds when the receipt carries no pin version", async () => {
  const { model, identity, change, publication } = directApplySetup(
    "branch:moved",
  );
  delete (publication.adoptedPin as { repositoryVersion?: string })
    .repositoryVersion;
  await rejects(
    () =>
      model.applyApprovedChange(identity, change, "digest-pin", publication),
    (error) => {
      ok(error instanceof ChangePublicationError);
      equal(error.code, "PUBLICATION_NOT_APPLICABLE");
      // The absent pin preserves prior behavior: the gate is skipped and
      // preparation proceeds into model preparation instead of refusing.
      ok(!error.message.includes("adopted source pin moved"));
      return true;
    },
  );
});

Deno.test("reviewer declaration keeps replacement patterns in names literal", () => {
  const template =
    "package P { part reviewer : ASELiveBuilder::IndependentReviewer; }";
  const declared = declareReviewer(template, "rev-$&", "Rev $' and $` here");
  ok(declared.includes('"rev-$&"'));
  ok(declared.includes('"Rev $\' and $` here"'));
  equal(
    declared.includes("part reviewer : ASELiveBuilder::IndependentReviewer;"),
    false,
  );
  equal(
    declared.startsWith(
      "package P { part reviewer : ASELiveBuilder::IndependentReviewer {",
    ),
    true,
  );
  equal(declared.endsWith("; } }"), true);
});

Deno.test("new reviewer declarations refresh only their exact historical provenance field", () => {
  const template = `part reviewer : AssemblyLiveBuilder::IndependentReviewer;
item reviewerMandate : AssemblyCore::ConfiguredMandate {
    attribute :>> source = ${JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)};
    attribute :>> scope = ${JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)};
    attribute :>> mayAdmit = true;
}`;
  const declared = declareReviewer(template, "new-reviewer", "New reviewer");
  ok(
    declared.includes(
      `attribute :>> source = ${JSON.stringify(DYNAMIC_MANDATE_SOURCE)};`,
    ),
  );
  ok(
    declared.includes(
      `attribute :>> scope = ${JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)};`,
    ),
  );
  ok(declared.includes("attribute :>> mayAdmit = true;"));
  ok(
    template.includes(
      `attribute :>> source = ${
        JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)
      };`,
    ),
  );
  const currentTemplate = template.replace(
    `attribute :>> source = ${JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)};`,
    `attribute :>> source = ${JSON.stringify(DYNAMIC_MANDATE_SOURCE)};`,
  );
  equal(
    declareReviewer(currentTemplate, "new-reviewer", "New reviewer"),
    declared,
  );
});

Deno.test("source model observes live HEAD and refuses mismatched immutable revisions before compilation", async () => {
  const f = fixture();
  let head = `commit:${"1".repeat(40)}`;
  const reads: string[] = [];
  f.repository.headVersion = () => Promise.resolve(head);
  f.repository.at = (version) => {
    reads.push(version);
    return Promise.resolve({
      ...f.revision,
      version: `commit:${"f".repeat(40)}`,
    });
  };
  await rejects(
    () => f.model.readExecutableModel(f.identity),
    /Loaded model revision differs/,
  );
  head = `commit:${"2".repeat(40)}`;
  await rejects(
    () => f.model.readExecutableModel(f.identity),
    /Loaded model revision differs/,
  );
  await rejects(
    () => f.model.readExecutableModel(f.identity, `commit:${"3".repeat(40)}`),
    /Loaded model revision differs/,
  );
  deepStrictEqual(reads, [
    `commit:${"1".repeat(40)}`,
    head,
    `commit:${"3".repeat(40)}`,
  ]);
  await rejects(
    () => f.model.readExecutableModel({ ...f.identity, projectId: "foreign" }),
    /Foreign model identity/,
  );
  equal(reads.length, 3);
});
