import { formatPatch, structuredPatch } from "diff";
import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import { ModelChangeView } from "../changes/ModelChangeCard.tsx";
import { filesHref } from "../../../lib/model/sources/files.ts";
import type { RequestSourceEditor } from "../../../lib/model/sources/request-edit.ts";
import type { RequestSourceProposal } from "../../../lib/model/sources/request-revisions.ts";

/** Format exactly the server's reviewed before/after, using the existing escaped
 * Git-diff presentation. No source HTML, native handle or authority is generated. */
export function requestProposalDiff(proposal: RequestSourceProposal) {
  let additions = 0, deletions = 0;
  const patch = proposal.diff.map((change) => {
    const data = structuredPatch(
      change.path,
      change.path,
      change.before ?? "",
      change.after ?? "",
      "",
      "",
      { context: 3 },
    );
    for (const hunk of data.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
      }
    }
    return formatPatch(data);
  }).join("\n");
  return {
    patch,
    stats: { additions, deletions, files: proposal.diff.length },
  };
}
export function RequestSourceEdit(
  props: {
    editor: RequestSourceEditor;
    path: string;
    text: string;
    version: string;
    admittedVersion: string;
    executionVersion: string;
  },
) {
  const { editor } = props,
    draft = editor.draft.value,
    proposal = editor.proposal.value,
    intent = editor.intent.value;
  const receipt = editor.receipt.value, busy = editor.busy.value;
  const editHere = editor.editable(), sameDraft = draft?.path === props.path;
  const diff = proposal ? requestProposalDiff(proposal) : null;
  return (
    <section
      class="proposal-adjustment"
      aria-label="Request source instructions"
    >
      <p>
        Publishing saves a new source version. This request keeps running its
        existing model.
      </p>
      {!editHere && (
        <p>
          This displayed version is read-only.{" "}
          <ModelContextLink
            href={filesHref({
              version: props.admittedVersion,
              file: props.path,
            })}
          >
            View the current source
          </ModelContextLink>
        </p>
      )}
      {editor.message.value && (
        <p class="proposal-notice" role="status">{editor.message.value}</p>
      )}
      {receipt && (
        <p role="status">
          Published source <code>{receipt.version}</code>. Running model{" "}
          <code>{props.executionVersion}</code> is unchanged.
        </p>
      )}
      {intent && (
        <p>
          Proposal <code>{intent.proposalId}</code> · Original source{" "}
          <code>{intent.baseVersion}</code>
        </p>
      )}
      {intent?.acceptAttempted && !receipt && (
        <div class="proposal-actions">
          <button
            type="button"
            class="proposal-accept"
            disabled={busy}
            onClick={() => void editor.resume()}
          >
            {busy ? "Checking publication…" : "Resume this publication"}
          </button>
        </div>
      )}
      {!draft && !intent && editHere && (
        <button
          type="button"
          class="proposal-adjust"
          onClick={() => editor.start(props.path, props.text, props.version)}
        >
          Edit instructions in this file
        </button>
      )}
      {intent && !proposal && !intent.acceptAttempted && (
        <p>
          The original review is not available after reload. No publication is
          confirmed.{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => editor.discard()}
          >
            Discard this unapproved proposal locally
          </button>
        </p>
      )}
      {draft && sameDraft && !proposal && !intent && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void editor.propose();
          }}
        >
          <label for="request-source-text">Proposed text of {draft.path}</label>
          <textarea
            id="request-source-text"
            value={draft.text}
            disabled={busy || !editHere}
            onInput={(event) => editor.text(event.currentTarget.value)}
            rows={18}
            spellcheck={false}
          />
          <label for="request-source-reason">Reason for this change</label>
          <input
            id="request-source-reason"
            value={draft.reason}
            required
            maxLength={4000}
            disabled={busy || !editHere}
            onInput={(event) => editor.reason(event.currentTarget.value)}
          />
          <div class="proposal-actions">
            <button
              type="submit"
              class="proposal-accept"
              disabled={!editor.canPropose()}
            >
              {busy
                ? "Preparing proposal…"
                : editor.proposalUncertain.value
                ? "Create a new proposal from this draft"
                : "Propose these instructions"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => editor.discard()}
            >
              Cancel draft
            </button>
          </div>
        </form>
      )}
      {proposal && diff && (
        <ModelChangeView
          id={proposal.id}
          title="Review Request instructions"
          author="Local owner"
          commit={proposal.baseVersion}
          commitLabel="Original source"
          stats={diff.stats}
          patch={diff.patch}
          state={receipt ? "accepted" : "pending"}
          layout="header"
          notice="Review these exact changes before publishing. The running model will stay unchanged."
          actions={!intent?.acceptAttempted || editor.resumeAbsent.value
            ? (
              <button
                type="button"
                class="proposal-accept"
                disabled={!editor.canAccept()}
                onClick={() => void editor.accept()}
              >
                {busy
                  ? "Recording approval…"
                  : intent?.acceptAttempted
                  ? "Retry recording this same approval"
                  : "Publish this source change"}
              </button>
            )
            : undefined}
          footer={!intent?.acceptAttempted
            ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => editor.discard()}
              >
                Cancel this proposal locally
              </button>
            )
            : undefined}
        />
      )}
      {receipt && editHere && (
        <button
          type="button"
          class="proposal-adjust"
          onClick={() => editor.start(props.path, props.text, props.version)}
        >
          Edit current source again
        </button>
      )}
    </section>
  );
}
