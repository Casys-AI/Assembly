import { RequestSourceEdit } from "./RequestSourceEdit.tsx";
import { CreateTag } from "../CreateTag.tsx";
import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import { modelHref } from "../../../lib/workbench/desk.ts";
import { SavedSystems } from "../../system/SavedSystems.tsx";
import { filesHref } from "../../../lib/model/sources/files.ts";
import { ReadFailure } from "../../view/ReadFailure.tsx";
import { VersionLine } from "../../view/VersionLine.tsx";
import { FileBlob } from "./FileBlob.tsx";
import { FileTree } from "./FileTree.tsx";
import { type FilesPageProps, useFilesPage } from "./useFilesPage.ts";

/**
 * Model > Files: the sources of the model read like a repository, at the
 * admitted head or at the version the address names. The files are on the
 * left, grouped by directory; the one selected is on the right as plain text,
 * with its path and the commit that last changed it. Nothing on this page
 * changes the model.
 */
export function FilesPage(props: FilesPageProps) {
  const {
    store,
    asked,
    named,
    line,
    listing,
    groups,
    shown,
    version,
    text,
  } = useFilesPage(props);
  const requestCurrent = props.caseReadOnly && version !== undefined &&
    version === props.requestExecutionVersion;
  // The Case facade supplies the verified admitted source independently of
  // execution. Retention revalidates its exact admission and current authority.
  const canCreateRelease = !props.caseReadOnly ||
    Boolean(
      props.releaseBranch?.kind === "case" && version &&
        props.requestBranchVersion === version,
    );
  return (
    <div class="files-page">
      {listing.status === "failed" && (
        <ReadFailure
          problem={listing.problem}
          // Reading again can only help when the host was unreachable.
          again={listing.problem.code === "files-failed"
            ? { run: () => void store.open(asked) }
            : undefined}
          home={asked ? filesHref({ file: named, line }) : undefined}
        />
      )}
      {listing.status === "reading" && (
        <p class="rev-empty" role="status">Reading the files…</p>
      )}
      {listing.status === "ready" && version && (
        <>
          <VersionLine
            version={version}
            pinned={props.caseReadOnly
              ? props.releases && canCreateRelease ? false : !requestCurrent
              : Boolean(asked)}
            currentLabel={props.caseReadOnly
              ? props.releases && canCreateRelease
                ? "Current admitted Request source"
                : "Request model"
              : undefined}
            home={props.releases
              ? modelHref("releases")
              : filesHref({ file: named, line })}
          >
            {props.caseReadOnly && canCreateRelease && !requestCurrent && (
              <span
                class="chip release-source-context"
                role="status"
                title={`Release source ${version} · execution remains ${
                  props.requestExecutionVersion ?? "unavailable"
                }. Creating a Release does not adopt this source.`}
              >
                not running
              </span>
            )}
          </VersionLine>
          {props.releases
            ? (
              props.caseReadOnly &&
                (props.releaseBranch?.kind !== "case" || !props.releaseApi)
                ? (
                  <p class="proposal-error" role="alert">
                    The scoped Request Release context is unavailable.
                  </p>
                )
                : (
                  <SavedSystems
                    catalogueInvalidation={props.catalogueInvalidation}
                    catalogueConnection={props.catalogueConnection}
                    sessionGeneration={props.sessionGeneration}
                    key={version}
                    api={props.releaseApi}
                    source={{
                      branch: props.releaseBranch ?? { kind: "main" },
                      sourceVersion: version,
                    }}
                    canCreate={canCreateRelease}
                    initiallyCreating={new URLSearchParams(
                      props.location.search,
                    )
                      .get("create") === "1"}
                  />
                )
            )
            : (
              <div class="files-content-layout">
                {(canCreateRelease || props.caseReadOnly) && (
                  <aside
                    class="releases-actions files-release-actions"
                    aria-label="Source actions"
                  >
                    {canCreateRelease && (
                      <ModelContextLink
                        class="button"
                        href={modelHref("releases", { version, create: "1" })}
                      >
                        Create release
                      </ModelContextLink>
                    )}
                    {/^commit:[a-f0-9]{40}$/.test(version) &&
                      (!props.caseReadOnly ||
                        props.releaseBranch?.kind === "case") &&
                      (
                        <CreateTag
                          key={JSON.stringify([props.releaseBranch, version])}
                          source={{
                            branch: props.releaseBranch ?? { kind: "main" },
                            sourceVersion: version,
                          }}
                          eligible={!props.caseReadOnly || canCreateRelease}
                        />
                      )}
                  </aside>
                )}
                {groups.length === 0 && (
                  <p class="rev-empty" data-code="no-files">
                    No files in this version.
                  </p>
                )}
                {shown && shown.kind !== "none" &&
                  groups.length > 0 && (
                  <div class="repo">
                    <FileTree
                      groups={groups}
                      current={shown.kind === "file"
                        ? shown.entry.path
                        : undefined}
                      version={asked}
                    />
                    {shown.kind === "file"
                      ? text && (
                        <FileBlob
                          entry={shown.entry}
                          text={text}
                          line={line}
                          version={asked}
                          sourceVersion={props.caseReadOnly
                            ? undefined
                            : version}
                          onRetry={() => void store.readSources(version)}
                          now={props.now}
                          actions={props.sourceEditor &&
                              text.status === "ready" &&
                              props.requestBranchVersion &&
                              props.requestExecutionVersion
                            ? (
                              <RequestSourceEdit
                                editor={props.sourceEditor}
                                path={shown.entry.path}
                                text={text.text}
                                version={version}
                                admittedVersion={props.requestBranchVersion}
                                executionVersion={props.requestExecutionVersion}
                              />
                            )
                            : undefined}
                        />
                      )
                      : (
                        <p class="rev-empty" data-code="file-absent">
                          <code>{shown.path}</code> is not in this version.
                        </p>
                      )}
                  </div>
                )}
              </div>
            )}
        </>
      )}
    </div>
  );
}
