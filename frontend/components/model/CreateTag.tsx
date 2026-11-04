import { useEffect, useRef, useState } from "preact/hooks";
import {
  assertReleaseTagBinding,
  assertReleaseTagName,
  type ReleaseTagBinding,
} from "../../../src/domain/work/records/release-tags.ts";
import {
  assertRequestReleaseAdmissionReference,
  assertSavedSourceSelection,
  type SavedSystemSourceSelection,
} from "../../../src/domain/work/records/saved-systems.ts";
import { sameReleaseSource } from "../../lib/system/release-save-intent.ts";

/** Create a lightweight tag on exactly the displayed source; never publish a Release. */
export async function createModelTag(
  source: SavedSystemSourceSelection,
  name: string,
  request: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<ReleaseTagBinding> {
  assertSavedSourceSelection(source);
  assertReleaseTagName(name);
  const response = await request("/api/model-tags/create", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, name }),
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof value?.error === "string"
        ? value.error
        : "Tag creation is unavailable.",
    );
  }
  const tag = value?.tag as ReleaseTagBinding;
  try {
    assertSavedSourceSelection({
      branch: value?.source?.branch,
      sourceVersion: value?.source?.sourceVersion,
    });
    if (value.source.requestAdmission !== undefined) {
      assertRequestReleaseAdmissionReference(value.source.requestAdmission);
    }
  } catch {
    throw new Error("The tag creation response is invalid.");
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "source,tag" ||
    !value.source || !sameReleaseSource(source, value.source) ||
    typeof value.source.repositoryId !== "string" ||
    !value.source.repositoryId ||
    typeof value.source.branchRef !== "string" || !value.source.branchRef ||
    !/^commit:[a-f0-9]{40}$/.test(value.source.admittedHeadVersion) ||
    !/^[a-f0-9]{64}$/.test(value.source.sourceDigest) ||
    !tag || Object.keys(tag).sort().join(",") !== "commitOid,name,refOid"
  ) {
    throw new Error("The tag creation response is invalid.");
  }
  assertReleaseTagBinding(tag, source.sourceVersion);
  if (tag.name !== name || tag.refOid !== tag.commitOid) {
    throw new Error("The tag creation response is invalid.");
  }
  return tag;
}

export function CreateTag(
  { source, eligible = true, disabled = false, onCreated }: {
    source: SavedSystemSourceSelection;
    eligible?: boolean;
    disabled?: boolean;
    onCreated?(tag: ReleaseTagBinding): void;
  },
) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<ReleaseTagBinding | null>(null);
  const active = useRef(true);
  useEffect(() => () => {
    active.current = false;
  }, []);
  let valid = true;
  try {
    assertReleaseTagName(name);
  } catch {
    valid = false;
  }
  if (!eligible) {
    return (
      <p class="input-note">
        Only the current admitted Request version can be tagged for now.
      </p>
    );
  }
  return (
    <div class="create-tag" aria-label="Create tag">
      {!open && !created && (
        <button
          type="button"
          class="chip is-action"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          Create tag
        </button>
      )}
      {open && !created && (
        <form
          title={`Tag exact source ${source.sourceVersion}. This does not publish a Release or change the model in service.`}
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || busy || disabled) return;
            setBusy(true);
            setError("");
            void createModelTag(source, name).then((tag) => {
              setCreated(tag);
              if (active.current) onCreated?.(tag);
            }, (failure) => {
              setError(
                failure instanceof Error
                  ? failure.message
                  : "Tag creation is unavailable.",
              );
            }).finally(() => {
              setBusy(false);
            });
          }}
        >
          <label>
            Tag name{" "}
            <input
              value={name}
              required
              maxLength={200}
              onInput={(event) => setName(event.currentTarget.value)}
              aria-invalid={name.length > 0 && !valid}
            />
          </label>
          {name && !valid && (
            <p class="proposal-error" role="status">
              Enter a valid Git tag name.
            </p>
          )}
          {error && <p class="proposal-error" role="alert">{error}</p>}
          <button
            type="submit"
            class="chip is-action"
            disabled={disabled || busy || !valid}
          >
            {busy ? "Creating tag…" : "Create tag"}
          </button>
        </form>
      )}
      {created && (
        <p
          role="status"
          title={`Tag ${created.name} created at ${source.sourceVersion}. No Release was published and the model in service did not change.`}
        >
          <span class="chip">{created.name}</span>
        </p>
      )}
    </div>
  );
}
