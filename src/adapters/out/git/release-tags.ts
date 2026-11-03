import { matchesExactRevision } from "../../../domain/shared-kernel/revision-id.ts";
import type { ReleaseTagsPort } from "../../../application/work/saved-systems/ports.ts";
import {
  SavedSystemError,
  type SavedSystemSourceEvidence,
} from "../../../domain/work/saved-systems.ts";
import {
  assertReleaseTagBinding,
  assertReleaseTagSelection,
  type ReleaseTagBinding,
  type ReleaseTagSelection,
} from "../../../domain/work/release-tags.ts";
import type { GitModelRepositoryReader } from "./repository.ts";
import type { RepositoryWriterLock } from "./writer-lock.ts";

const MAX_INVENTORY_BYTES = 512 * 1024;
const MAX_TAGS = 1000;
const GIT_DEADLINE_MS = 3000;
const INVENTORY_DEADLINE_MS = 10000;
const ENSURE_DEADLINE_MS = 2000;
const oidPattern = /^[a-f0-9]{40}$/;

function unavailable(): SavedSystemError {
  return new SavedSystemError(
    "TAG_UNAVAILABLE",
    "The exact Release tag is unavailable.",
  );
}

/** Git facts only. The caller checks source visibility and authority separately. */
export class GitReleaseTags implements ReleaseTagsPort {
  constructor(
    private readonly options: {
      projectDir: string;
      repositoryId: string;
      reader: () => Promise<
        Pick<GitModelRepositoryReader, "repositoryId" | "at">
      >;
      writerLock: RepositoryWriterLock;
      /** Content-free advice after an exact durable tag write; never authority. */
      notifyCatalogue?: () => void;
    },
  ) {}

  private async git(
    args: string[],
    maxBytes = 4096,
    missing = false,
    deadline = Date.now() + GIT_DEADLINE_MS,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw unavailable();
    const remaining = Math.min(GIT_DEADLINE_MS, deadline - Date.now());
    if (remaining <= 0) throw unavailable();
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command("git", {
        args: [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "protocol.allow=never",
          `--git-dir=${this.options.projectDir}/.git`,
          ...args,
        ],
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "",
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch {
      throw unavailable();
    }
    const read = async (stream: ReadableStream<Uint8Array>, limit: number) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > limit) throw unavailable();
          chunks.push(chunk);
        }
      } catch (error) {
        try {
          child.kill("SIGKILL");
        } catch { /* already exited */ }
        throw error;
      }
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    };
    let timedOut = false;
    const abort = () => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, remaining);
    const [status, stdout, stderr] = await Promise.allSettled([
      child.status,
      read(child.stdout, maxBytes),
      read(child.stderr, 4096),
    ]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (timedOut || signal?.aborted) throw unavailable();
    if (
      status.status === "rejected" || stdout.status === "rejected" ||
      stderr.status === "rejected"
    ) throw unavailable();
    if (!status.value.success) {
      if (missing && status.value.code === 1 && stderr.value.length === 0) {
        return "";
      }
      throw unavailable();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(stdout.value)
      .trim();
  }

  private async source(source: SavedSystemSourceEvidence): Promise<string> {
    if (
      source.repositoryId !== this.options.repositoryId ||
      !matchesExactRevision(source.sourceVersion)
    ) throw unavailable();
    const reader = await this.options.reader();
    if (reader.repositoryId !== this.options.repositoryId) throw unavailable();
    const revision = await reader.at(source.sourceVersion);
    if (
      revision.version !== source.sourceVersion ||
      revision.sourceDigest !== source.sourceDigest
    ) throw unavailable();
    return source.sourceVersion.slice(7);
  }
  private async raw(
    name: string,
    deadline?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const ref = `refs/tags/${name}`;
    // A tag must be a direct ref. In particular, never follow a tag into Main.
    if (
      await this.git(
        ["symbolic-ref", "--quiet", ref],
        1024,
        true,
        deadline,
        signal,
      )
    ) throw unavailable();
    const oid = await this.git(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
      256,
      true,
      deadline,
      signal,
    );
    if (oid && !oidPattern.test(oid)) throw unavailable();
    if (
      await this.git(
        ["symbolic-ref", "--quiet", ref],
        1024,
        true,
        deadline,
        signal,
      )
    ) throw unavailable();
    return oid;
  }
  private async binding(
    name: string,
    deadline?: number,
    signal?: AbortSignal,
  ): Promise<ReleaseTagBinding | null> {
    const refOid = await this.raw(name, deadline, signal);
    if (!refOid) return null;
    const commitOid = await this.git(
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${refOid}^{commit}`,
      ],
      256,
      true,
      deadline,
      signal,
    );
    if (
      !oidPattern.test(commitOid) ||
      await this.raw(name, deadline, signal) !== refOid
    ) return null;
    return { name, refOid, commitOid };
  }
  async prepare(
    selection: ReleaseTagSelection,
    source: SavedSystemSourceEvidence,
  ): Promise<ReleaseTagBinding> {
    assertReleaseTagSelection(selection);
    const commitOid = await this.source(source);
    if (selection.mode === "create") {
      if (await this.raw(selection.name)) throw unavailable();
      return { name: selection.name, refOid: commitOid, commitOid };
    }
    const binding = await this.binding(selection.name);
    if (!binding || binding.commitOid !== commitOid) throw unavailable();
    return binding;
  }
  async list(source: SavedSystemSourceEvidence): Promise<ReleaseTagBinding[]> {
    const commitOid = await this.source(source);
    const deadline = Date.now() + INVENTORY_DEADLINE_MS;
    const text = await this.git(
      [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)",
        "refs/tags/",
      ],
      MAX_INVENTORY_BYTES,
      false,
      deadline,
    );
    const rows = text ? text.split("\n") : [];
    if (rows.length > MAX_TAGS) throw unavailable();
    const matches: ReleaseTagBinding[] = [];
    for (const row of rows) {
      const [ref, raw, type, peeled, peeledType, symref, ...extra] = row.split(
        "\0",
      );
      if (
        extra.length || symref === undefined ||
        !ref?.startsWith("refs/tags/") ||
        !oidPattern.test(raw ?? "")
      ) throw unavailable();
      if (symref) throw unavailable();
      const name = ref.slice(10);
      try {
        assertReleaseTagSelection({ mode: "existing", name });
      } catch {
        continue;
      }
      let target = type === "commit"
        ? raw
        : type === "tag" && peeledType === "commit"
        ? peeled
        : "";
      // The format's starred fields peel only one tag object. Resolve nested
      // tag objects recursively to their final object, which may be a blob or
      // tree; only exact commit OIDs match the already verified source.
      if (type === "tag" && peeledType === "tag") {
        target = await this.git(
          ["rev-parse", "--verify", "--quiet", "--end-of-options", `${raw}^{}`],
          256,
          false,
          deadline,
        );
        if (!oidPattern.test(target)) throw unavailable();
      }
      if (target !== commitOid) continue;
      const binding = await this.binding(name, deadline);
      if (!binding) {
        if (await this.raw(name, deadline) !== raw) throw unavailable();
        continue;
      }
      if (binding.refOid !== raw) throw unavailable();
      if (binding.commitOid === commitOid) matches.push(binding);
    }
    return matches;
  }
  private async inspectWithSignal(
    binding: ReleaseTagBinding,
    signal?: AbortSignal,
  ): Promise<"verified" | "unavailable"> {
    try {
      assertReleaseTagBinding(binding, `commit:${binding.commitOid}`);
      const actual = await this.binding(binding.name, undefined, signal);
      return actual?.refOid === binding.refOid &&
          actual.commitOid === binding.commitOid
        ? "verified"
        : "unavailable";
    } catch {
      return "unavailable";
    }
  }
  inspect(binding: ReleaseTagBinding): Promise<"verified" | "unavailable"> {
    return this.inspectWithSignal(binding);
  }
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.writerLock.runExclusive(operation);
  }
  async ensure(
    selection: ReleaseTagSelection,
    binding: ReleaseTagBinding,
    authoritySignal?: AbortSignal,
  ): Promise<void> {
    const signal = authoritySignal
      ? AbortSignal.any([
        authoritySignal,
        AbortSignal.timeout(ENSURE_DEADLINE_MS),
      ])
      : AbortSignal.timeout(ENSURE_DEADLINE_MS);
    this.options.writerLock.assertHeld();
    assertReleaseTagSelection(selection);
    assertReleaseTagBinding(binding, `commit:${binding.commitOid}`);
    if (selection.name !== binding.name) throw unavailable();
    if (await this.inspectWithSignal(binding, signal) === "verified") return;
    if (
      signal.aborted || selection.mode !== "create" ||
      binding.refOid !== binding.commitOid ||
      await this.raw(binding.name, undefined, signal)
    ) throw unavailable();
    if (
      await this.git(
        ["cat-file", "-t", binding.commitOid],
        4096,
        false,
        undefined,
        signal,
      ) !== "commit"
    ) {
      throw unavailable();
    }
    try {
      await this.git(
        [
          "update-ref",
          "--no-deref",
          `refs/tags/${binding.name}`,
          binding.commitOid,
          "0".repeat(40),
        ],
        4096,
        false,
        undefined,
        signal,
      );
    } catch {
      if (await this.inspectWithSignal(binding, signal) !== "verified") {
        throw unavailable();
      }
    }
    if (await this.inspectWithSignal(binding, signal) !== "verified") {
      throw unavailable();
    }
    try {
      this.options.notifyCatalogue?.();
    } catch {
      // A committed tag remains successful when advisory stream delivery fails.
    }
  }
}
