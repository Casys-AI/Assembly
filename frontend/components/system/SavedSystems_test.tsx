import { ModelLinkContext } from "../view/ModelContextLink.tsx";
import { localSkillRelease } from "../../test/support/release-opening-fixture.ts";
import { doesNotMatch, equal, match, ok } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import {
  ReleaseSaveRecovery,
  SavedSystemCatalogue,
  SavedSystemInspection,
  SavedSystems,
  showReleaseRepair,
} from "./SavedSystems.tsx";
import type { SavedSystemView } from "../../lib/system/saved-systems.ts";
Deno.test("saved system component exposes save fields, catalogue and bounded exact inspection states", () => {
  const html = renderToString(
    <SavedSystems
      initiallyCreating
      source={{
        branch: { kind: "main" },
        sourceVersion: `commit:${"a".repeat(40)}`,
      }}
    />,
  );
  match(html, /Create release/);
  doesNotMatch(html, /Create a new tag/);
  match(html, /Existing tag/);
  match(html, /maxlength="120"/i);
  match(html, /maxlength="2000"/i);
  doesNotMatch(html, /Refresh releases/);
  match(html, /class="saved-systems-create"/);
  doesNotMatch(html, /<aside/);
  match(html, /Back to releases/);
  match(html, /role="region" aria-label="Release details"/);
  match(html, /class="proposal-adjustment panel saved-systems-form"/);
  match(html, /<label for="saved-system-name">Title<\/label>/);
  match(html, /<input[^>]*id="saved-system-name"/);
  match(html, /<label for="saved-system-purpose">Notes<\/label>/);
  match(html, /<textarea[^>]*id="saved-system-purpose"/);
  match(html, /<button class="proposal-accept" type="submit"/);
  const record: SavedSystemView = {
    assetAvailability: "unchecked",
    id: "S",
    saveKey: "key",
    metadata: { name: "Useful system", purpose: "Purpose" },
    createdAt: "now",
    status: "incomplete",
    manifest: null,
    digest: null,
    issues: ["EXACT_ASSET_UNAVAILABLE"],
    revision: 0,
    origin: {
      projectId: "Project",
      systemId: "Host",
      executionSpaceId: "main",
    },
    prerequisites: [{
      kind: "skill",
      operatorId: "a",
      code: "SKILL_DEPENDENCY",
    }],
    selectedOperators: [{
      operatorId: "a",
      stateRevision: 7,
      modelDigest: "model-digest",
      repositoryVersion: "commit:exact",
      settingsDigest: "settings-digest",
      tools: [],
    }],
  };
  const inspection = renderToString(<SavedSystemInspection record={record} />);
  const disclosure = inspection.indexOf('<details class="detail-more"');
  ok(disclosure > 0);
  const overview = inspection.slice(0, disclosure);
  match(overview, /Useful system/);
  match(overview, /Purpose/);
  match(overview, /This system/);
  match(overview, /main workspace/);
  match(overview, /Operator 1/);
  match(overview, /A declared skill is checked automatically/);
  doesNotMatch(
    overview,
    /commit:exact|model-digest|settings-digest|SKILL_DEPENDENCY/,
  );
  match(inspection, /<summary class="chip">Details<\/summary>/);
  match(overview, /<h4>Requirements<\/h4>/);
  match(overview, /Operator 1 · 0 tools/);
  doesNotMatch(inspection, /<details[^>]* open/);
  match(inspection, /Incomplete/);
  match(inspection, /availability has not been verified/);
  match(inspection, /commit:exact/);
  match(inspection, /model-digest/);
  match(inspection, /settings-digest/);
  match(inspection, /SKILL_DEPENDENCY/);
  doesNotMatch(inspection, /<dt>Saved<|Saving grants|exact saved source/);
  match(inspection, /<dt>Created<\/dt>/);
  doesNotMatch(inspection, /Start Request|Activate|Adopt/);
  doesNotMatch(inspection, /Assets unavailable|Tag unavailable/);
  // A failure the person must know of stays visible and announced, its
  // whole sentence in the tooltip.
  const broken = renderToString(
    <SavedSystemInspection
      record={{
        ...record,
        assetAvailability: "unavailable",
        tagAvailability: "unavailable",
      }}
    />,
  );
  match(
    broken,
    /role="status" title="Exact assets are currently unavailable or corrupt\.[^"]*">Assets unavailable · Tag unavailable<\/p>/,
  );
  const catalogue = (selected: SavedSystemView | null) =>
    renderToString(
      <SavedSystemCatalogue
        detailsId="release-details"
        records={[
          record,
          {
            ...record,
            id: "Other",
            metadata: { name: "Other system", purpose: "" },
          },
        ]}
        selected={selected}
        busy={false}
        onInspect={() => undefined}
      />,
    );
  const verified = catalogue({ ...record, assetAvailability: "verified" });
  match(verified, /aria-controls="release-details"/);
  // The selected row shares its exact inspection; the other stays unchecked.
  equal(
    (verified.match(/Exact assets verified for this read/g) ?? []).length,
    1,
  );
  equal(
    (verified.match(/availability has not been verified/g) ?? []).length,
    1,
  );
  match(
    catalogue({ ...record, assetAvailability: "unavailable" }),
    /assets are currently unavailable or corrupt/,
  );
  // Reload and stale/mismatched inspections cannot imply current availability.
  for (
    const selected of [
      null,
      {
        ...record,
        digest: "different",
        assetAvailability: "verified" as const,
      },
      {
        ...record,
        revision: record.revision + 1,
        assetAvailability: "verified" as const,
      },
    ]
  ) {
    const unchecked = catalogue(selected);
    doesNotMatch(unchecked, /Exact assets verified for this read/);
    equal(
      (unchecked.match(/availability has not been verified/g) ?? []).length,
      2,
    );
  }
  match(
    renderToString(
      <SavedSystemInspection record={{ ...record, status: "conflict" }} />,
    ),
    /admitted system changed/,
  );
});

Deno.test("Release creation requires a displayed source and legacy inspection never invents one", () => {
  const closed = renderToString(
    <SavedSystems
      source={{ branch: { kind: "main" }, sourceVersion: "commit:exact" }}
    />,
  );
  match(closed, /create=1[^"]*">Create release/);
  match(closed, /Create release/);
  doesNotMatch(closed, /saved-systems-form/);
  doesNotMatch(
    renderToString(<SavedSystems />),
    /saved-systems-form|Create release/,
  );
});

Deno.test("Request Release inspection keeps real origin and incomplete local-validation status in the existing panel", () => {
  const record = {
    ...localSkillRelease("ownedRelease", "caseA"),
    assetAvailability: "verified" as const,
  };
  const html = renderToString(
    <ModelLinkContext.Provider value="?caseBranch=caseB&agent=Assembly%3A%3APrimary">
      <SavedSystemInspection record={record} />
    </ModelLinkContext.Provider>,
  );
  match(html, /Incomplete/);
  match(html, /Request availability not checked/);
  match(html, /<dt>Retention status<\/dt><dd>Incomplete/);
  match(html, /PREREQUISITES_REQUIRED/);
  match(html, /Request caseA/);
  match(html, /caseBranch=caseA/);
  match(html, /agent=Assembly%3A%3APrimary/);
  doesNotMatch(
    html,
    /caseBranch=caseB|Retention completed|Start Request|Activate|Adopt/,
  );
  equal(record.status, "incomplete");
});

Deno.test("dedicated creation page names the displayed Request source and preserves its conversation links", () => {
  const record = localSkillRelease("ownedRelease", "caseA");
  const html = renderToString(
    <ModelLinkContext.Provider value="?caseBranch=caseA&agent=selected-child">
      <SavedSystems
        initiallyCreating
        source={{
          branch: { kind: "case", caseId: "caseA" },
          sourceVersion: record.source!.sourceVersion,
        }}
      />
    </ModelLinkContext.Provider>,
  );
  match(html, /aria-label="Create release"/);
  doesNotMatch(html, /<aside|Refresh releases/);
  match(html, /Request caseA.*exact source/s);
  match(html, /caseBranch=caseA/);
  match(html, /agent=selected-child/);
  doesNotMatch(html, /main · exact source/);
});

Deno.test("Release recovery shows saved exact source without an automatic submit and refuses another viewed branch", () => {
  const record = localSkillRelease("accepted", "caseA");
  const command = {
    saveKey: record.saveKey,
    ...record.metadata,
    source: {
      branch: record.source!.branch,
      sourceVersion: record.source!.sourceVersion,
    },
  };
  let retries = 0;
  const html = renderToString(
    <ReleaseSaveRecovery
      command={command}
      busy={false}
      source={{
        branch: { kind: "main" },
        sourceVersion: command.source.sourceVersion,
      }}
      onRetry={() => {
        retries++;
      }}
    />,
  );
  equal(retries, 0);
  match(html, /Release creation unconfirmed/);
  match(html, /Not confirmed/);
  match(
    html,
    /title="Release creation may have been accepted[^"]*nothing is sent automatically/,
  );
  match(html, /title="Request caseA · exact source [^"]*"><code>/);
  match(html, /<button[^>]*title="Reopen this exact source/);
  match(html, /Reopen release at original source/);
  match(html, /page=releases.*caseBranch=caseA/);
  match(html, /<button[^>]*disabled[^>]*>Retry release creation/);
  doesNotMatch(html, /capabilitySecret|type="submit"/);
  const same = renderToString(
    <ReleaseSaveRecovery
      command={command}
      source={command.source}
      busy={false}
      onRetry={() => {
        retries++;
      }}
    />,
  );
  doesNotMatch(same, /<button[^>]*disabled/);
  match(same, /caseBranch=caseA/);
  equal(retries, 0);
});
Deno.test("acknowledged incomplete Release repair keeps truthful receipt wording and explicit same-key retention action", () => {
  const record = localSkillRelease("accepted", "caseA");
  const command = {
    saveKey: record.saveKey,
    ...record.metadata,
    source: {
      branch: record.source!.branch,
      sourceVersion: record.source!.sourceVersion,
    },
  };
  const html = renderToString(
    <ReleaseSaveRecovery
      command={command}
      source={command.source}
      busy={false}
      acknowledged
      onRetry={() => {
        throw new Error("No implicit retry");
      }}
    />,
  );
  match(
    html,
    /title="This Release was created, but retention still needs attention/,
  );
  match(html, /Retention incomplete/);
  match(html, /Retry retention for this release/);
  match(
    html,
    /<button[^>]*title="The host rechecks current access and retention authority/,
  );
  doesNotMatch(html, /Retention completed|grants creation|type="submit"/);
});

Deno.test("stale source terminal attempt explains its own recovery without blaming the tag", () => {
  const old = localSkillRelease("stale", "caseA");
  const record: SavedSystemView = {
    ...old,
    status: "conflict",
    manifest: null,
    digest: null,
    rejection: { code: "SOURCE_STALE", tag: { mode: "create", name: "v1" } },
  };
  const html = renderToString(
    <SavedSystemInspection record={record} showRejectedAction />,
  );
  match(html, /selected source is no longer eligible/);
  match(html, /Reopen an eligible source/);
  doesNotMatch(html, /Tag.*is unavailable/);
  const catalogue = renderToString(
    <SavedSystemCatalogue
      records={[record]}
      selected={record}
      busy={false}
      onInspect={() => {}}
    />,
  );
  match(catalogue, /title="Publication refused · source stale/);
  match(catalogue, /is-refused">Refused</);
});

Deno.test("one title control keeps publication distinct from selected host readiness", () => {
  const untagged = localSkillRelease();
  const base: SavedSystemView = {
    ...untagged,
    tag: {
      selection: { mode: "create", name: "v1" },
      binding: {
        name: "v1",
        refOid: "a".repeat(40),
        commitOid: "a".repeat(40),
      },
      verified: true,
    },
    tagAvailability: "unchecked",
  };
  const listed = {
    ...base,
    openingAvailability: "unchecked" as const,
    openingIssues: [],
  };
  const ready = {
    ...base,
    assetAvailability: "verified" as const,
    openingAvailability: "ready" as const,
    openingIssues: [],
  };
  const render = (selected: SavedSystemView | null) =>
    renderToString(
      <SavedSystemCatalogue
        records={[listed]}
        selected={selected}
        busy={false}
        onInspect={() => {}}
      />,
    );
  const unchecked = render(null);
  equal((unchecked.match(/<button\b/g) ?? []).length, 1);
  // One clean row: the name, the tag as a chip, then the date; the exact
  // publication and readiness phrases sit in the row's tooltip.
  match(unchecked, /<button type="button" class="rev-row"/);
  match(unchecked, /<span class="chip">v1<\/span><time/);
  match(unchecked, /title="Tag published · Request availability not checked/);
  doesNotMatch(unchecked, /class="panel"|saved-systems-publication/);
  match(unchecked, /Request availability not checked/);
  doesNotMatch(unchecked, /is-ready|Ready at last check/);
  equal(showReleaseRepair(ready), false);
  equal(showReleaseRepair(listed), true);
  equal(
    showReleaseRepair({
      ...ready,
      openingIssues: ["SOURCE_OPENING_UNAVAILABLE"],
    }),
    true,
  );
  const checked = render(ready);
  equal((checked.match(/<button\b/g) ?? []).length, 1);
  match(checked, /class="saved-systems-readiness is-ready">Ready</);
  match(checked, /Ready at last check/);
  doesNotMatch(checked, /Incomplete|PREREQUISITES_REQUIRED/);
  const readyDetail = renderToString(<SavedSystemInspection record={ready} />);
  const overview = readyDetail.slice(
    0,
    readyDetail.indexOf('<details class="detail-more"'),
  );
  match(overview, /Ready at last check/);
  doesNotMatch(overview, /Incomplete|PREREQUISITES_REQUIRED|role="alert"/);
  match(readyDetail, /<dt>Retention status<\/dt><dd>Incomplete/);
  match(readyDetail, /PREREQUISITES_REQUIRED/);
  doesNotMatch(render({ ...ready, revision: ready.revision + 1 }), /is-ready/);
  doesNotMatch(
    render({ ...ready, openingIssues: ["SOURCE_OPENING_UNAVAILABLE"] }),
    /is-ready/,
  );
  const failed = {
    ...ready,
    openingAvailability: "unavailable" as const,
    openingIssues: ["INITIAL_SKILL_BUNDLE_UNAVAILABLE"],
  };
  const failedHtml = render(failed);
  match(failedHtml, /Request unavailable at last check/);
  match(failedHtml, /is-unavailable">Unavailable</);
  doesNotMatch(failedHtml, /is-ready/);
  const details = renderToString(<SavedSystemInspection record={failed} />);
  match(details, /checked automatically against the local bundle/);
  match(details, /INITIAL_SKILL_BUNDLE_UNAVAILABLE/);
  doesNotMatch(details, /Skills need to be supplied again/);
});
