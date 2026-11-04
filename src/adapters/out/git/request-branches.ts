import type { RequestBranchPort } from "../../../application/work/request-spaces/ports.ts";
import {
  exactSourceVersion,
  RequestSpaceError,
} from "../../../domain/work/request-spaces/scope.ts";
import { type OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import type { GitModelRepositoryReader } from "./repository.ts";
import type { RepositoryWriterLock } from "./writer-lock.ts";

/** Minimal immutable initial Case refs. No process-wide checkout, source
 * publication, HEAD switch, main update or branch-local write path is exposed. */
export class GitRequestBranches implements RequestBranchPort {
  constructor(
    private readonly options: {
      projectDir: string;
      writerLock: RepositoryWriterLock;
      reader(): Promise<GitModelRepositoryReader>;
      gitExecutable?: string;
      /** Host-composed coherent D2 head; absence retains legacy B0-only reads. */
      admittedVersion?: (record: OpeningRecord) => Promise<string>;
    },
  ) {}
  /** Exact versions already read as verified model revisions, with the
   * repository that read them. A commit and its content-addressed build never
   * change, so a success is reused; refs, ancestry and admission stay live. */
  readonly #revisions = new Map<string, string>();
  private async exactRevision(
    version: string,
    repositoryId?: string,
  ): Promise<boolean> {
    let known = this.#revisions.get(version);
    if (known === undefined) {
      const reader = await this.options.reader();
      if (repositoryId !== undefined && reader.repositoryId !== repositoryId) {
        return false;
      }
      if ((await reader.at(version)).version !== version) return false;
      known = reader.repositoryId;
      this.#revisions.set(version, known);
      if (this.#revisions.size > 256) {
        this.#revisions.delete(this.#revisions.keys().next().value!);
      }
    }
    return repositoryId === undefined || known === repositoryId;
  }
  private ref(record: OpeningRecord): string {
    if (
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.branchId)
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The host Request branch identity is unavailable.",
      );
    }
    return `refs/heads/requests/${record.branchId}`;
  }
  private base(record: OpeningRecord): string {
    const version = record.base?.manifest.source?.sourceVersion;
    if (!exactSourceVersion(version)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The recorded Request base is unavailable.",
      );
    }
    return version;
  }
  private async git(args: string[], missing = false): Promise<string> {
    const result = await new Deno.Command(this.options.gitExecutable ?? "git", {
      args: [
        "--no-optional-locks",
        "--git-dir",
        `${this.options.projectDir}/.git`,
        ...args,
      ],
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      if (missing && result.code === 1) return "";
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The exact Request branch operation is unavailable.",
      );
    }
    return new TextDecoder().decode(result.stdout).trim();
  }
  /** Server-owned ref identity for provenance; does not resolve/move it. */
  refForInspection(record: OpeningRecord): string {
    return this.ref(record);
  }
  async sourceEvidence(
    record: OpeningRecord,
  ): Promise<{ version: string; branchRef: string }> {
    const snapshot = structuredClone(record);
    return {
      version: await this.sourceVersion(snapshot),
      branchRef: this.ref(snapshot),
    };
  }
  async ensure(record: OpeningRecord): Promise<void> {
    const snapshot = structuredClone(record);
    const version = this.base(snapshot), ref = this.ref(snapshot);
    const reader = await this.options.reader();
    await reader.at(version);
    await this.options.writerLock.runExclusive(async () => {
      this.options.writerLock.assertHeld();
      const before = await this.git(
        ["rev-parse", "--verify", "--quiet", ref],
        true,
      );
      if (before) {
        if (`commit:${before}` !== version) {
          throw new RequestSpaceError(
            "OPENING_CONFLICT",
            "The Request branch already names another exact base.",
          );
        }
        return;
      }
      await this.git(["update-ref", ref, version.slice(7), "0".repeat(40)]);
    });
    await this.sourceVersion(snapshot);
  }
  /** Resolve physical ref against the current admitted head and retain B0 in
   * its first-parent ancestry without compiling the admitted head. */
  private async admittedHead(record: OpeningRecord): Promise<string> {
    const snapshot = structuredClone(record);
    const base = this.base(snapshot);
    const actual = await this.git([
      "rev-parse",
      "--verify",
      "--quiet",
      this.ref(snapshot),
    ], true);
    const admitted = this.options.admittedVersion
      ? await this.options.admittedVersion(snapshot)
      : base;
    if (
      !exactSourceVersion(admitted) || !actual ||
      `commit:${actual}` !== admitted
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The Request branch is missing or differs from its admitted source.",
      );
    }
    const history = await this.git(["rev-list", "--first-parent", actual]);
    if (!history.split("\n").includes(base.slice(7))) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The admitted Request branch does not retain its exact opening base.",
      );
    }
    return admitted;
  }
  /** Retained execution is independent of a later unadmitted physical head.
   * Caller supplies verified B0/current R; ancestry does not grant admission. */
  async assertRetainedExecutionVersion(
    record: OpeningRecord,
    version: string,
  ): Promise<void> {
    const snapshot = structuredClone(record), base = this.base(snapshot);
    if (!exactSourceVersion(version)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The retained execution version is invalid.",
      );
    }
    const ref = this.ref(snapshot);
    const actual = await this.git(
      ["rev-parse", "--verify", "--quiet", ref],
      true,
    );
    const admitted = this.options.admittedVersion
      ? await this.options.admittedVersion(snapshot)
      : base;
    if (!actual || !exactSourceVersion(admitted)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The retained Request branch is unavailable.",
      );
    }
    const history = (await this.git(["rev-list", "--first-parent", actual]))
      .split("\n");
    const admittedIndex = history.indexOf(admitted.slice(7)),
      executionIndex = history.indexOf(version.slice(7)),
      baseIndex = history.indexOf(base.slice(7));
    if (
      history[0] !== actual || admittedIndex < 0 ||
      executionIndex < admittedIndex || baseIndex < executionIndex
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The Request branch does not retain its admitted execution ancestry.",
      );
    }
    if (
      !await this.exactRevision(
        version,
        snapshot.base!.manifest.source!.repositoryId,
      )
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The exact retained Request execution source differs.",
      );
    }
    const currentActual = await this.git([
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    ], true);
    const currentAdmitted = this.options.admittedVersion
      ? await this.options.admittedVersion(snapshot)
      : base;
    if (currentActual !== actual || currentAdmitted !== admitted) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The retained Request branch changed during verification.",
      );
    }
  }
  async sourceVersion(record: OpeningRecord): Promise<string> {
    const version = await this.admittedHead(record);
    await this.exactRevision(version);
    return version;
  }
  async assertVersion(record: OpeningRecord, version: string): Promise<void> {
    if (!exactSourceVersion(version)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The branch inspection version is invalid.",
      );
    }
    const head = await this.admittedHead(record);
    const history = await this.git([
      "rev-list",
      "--first-parent",
      head.slice(7),
    ]);
    if (!history.split("\n").includes(version.slice(7))) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The inspected version does not belong to this Request branch.",
      );
    }
    await this.exactRevision(version);
  }
}
