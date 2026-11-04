import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import {
  materialize,
  sha256,
} from "../../src/domain/model/value-objects/artifact.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import type { ModelSourceAuthorizationPort } from "../../src/application/governance/ports/out/model-source-authorization.port.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import type { ModelProposalAuthorization } from "../../src/domain/governance/model-access/model-edit-authorization.ts";
const compiler = {
  compile: (sources: Sources) => materialize([], sources, "fixture-engine"),
  recipe: () => {
    throw new Error("Fixture compiler reports no build recipe");
  },
};
const initialSources = { "a.sysml": "package A;\n", "b.sysml": "package B;\n" };
const authorization: ModelProposalAuthorization = {
  kind: "operator",
  systemQualifiedName: "S",
  operatorQualifiedName: "S::O",
  operatorNativeId: "o",
  mandateId: "m",
  mandateRevision: 1,
  policyId: "p",
  policyRevision: 1,
  policyDigest: "digest",
  operations: ["replace-source"],
};
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function denied(
  action: () => Promise<unknown>,
  code = "EDIT_SCOPE_DENIED",
) {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof ModelRepositoryError && error.code === code,
      String(error),
    );
    return;
  }
  throw new Error("Expected denial");
}
const deny = (): never => {
  throw new ModelRepositoryError("EDIT_SCOPE_DENIED", "revoked");
};
Deno.test("Repository fails closed for agent writes without metadata or hook", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const base = await repo.initialize(initialSources);
    for (const auth of [undefined, authorization]) {
      await denied(() =>
        repo.propose({
          baseVersion: base.version,
          sources: { ...initialSources, "a.sysml": "package Changed;" },
          author: "agent:o",
          reason: "edit",
          authorization: auth,
        })
      );
    }
    assert((await repo.listProposals()).length === 0);
    assert((await repo.current()).version === base.version);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
Deno.test("Repository validates actual merged sources and pinned proposal principal before accepting", async () => {
  const projectDir = await Deno.makeTempDir();
  const calls: Parameters<ModelSourceAuthorizationPort["validate"]>[0][] = [];
  let revoked = false;
  const sourceAuthorization: ModelSourceAuthorizationPort = {
    validate(input) {
      calls.push(input);
      if (revoked) deny();
      return Promise.resolve();
    },
  };
  try {
    const repo = await GitModelRepository.open({
      projectDir,
      compiler,
      sourceAuthorization,
    });
    const base = await repo.initialize(initialSources);
    revoked = true;
    await denied(() =>
      repo.propose({
        baseVersion: base.version,
        sources: { ...initialSources, "a.sysml": "package Denied;" },
        author: "agent:o",
        reason: "edit",
        authorization,
      })
    );
    assert((await repo.listProposals()).length === 0);
    revoked = false;
    const proposal = await repo.propose({
      baseVersion: base.version,
      sources: { ...initialSources, "a.sysml": "package Allowed;" },
      author: "agent:o",
      reason: "edit",
      authorization,
    });
    assert(proposal.authorization?.kind === "operator");
    const advanced = await repo.publishSystemSources(
      { ...initialSources, "b.sysml": "package Later;" },
      base.version,
      "system",
    );
    revoked = true;
    await denied(() =>
      repo.accept({
        id: proposal.id,
        expectedVersion: advanced.version,
        author: "reviewer",
      })
    );
    const check = calls.at(-1)!;
    assert(check.phase === "acceptance" && check.author === "agent:o");
    assert(
      check.authority.version === advanced.version &&
        check.before.version === advanced.version,
    );
    assert(
      check.after.sources["a.sysml"] === "package Allowed;" &&
        check.after.sources["b.sysml"] === "package Later;",
    );
    assert((await repo.current()).version === advanced.version);
    assert((await repo.proposal(proposal.id)).status === "proposed");
    revoked = false;
    await repo.accept({
      id: proposal.id,
      expectedVersion: advanced.version,
      author: "reviewer",
    });
    assert(
      calls[1].phase === "proposal" &&
        calls[1].authority.version === base.version,
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
Deno.test("Proposal authorization cannot race admitted authority", async () => {
  const projectDir = await Deno.makeTempDir();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const waiting = new Promise<void>((resolve) => entered = resolve);
  try {
    const repo = await GitModelRepository.open({
      projectDir,
      compiler,
      sourceAuthorization: {
        async validate(input) {
          if (input.phase === "proposal") {
            entered();
            await gate;
          }
        },
      },
    });
    const base = await repo.initialize(initialSources);
    const pending = repo.propose({
      baseVersion: base.version,
      sources: { ...initialSources, "a.sysml": "package Changed;" },
      author: "agent:o",
      reason: "edit",
      authorization,
    });
    await waiting;
    const advanced = await repo.publishSystemSources(
      { ...initialSources, "b.sysml": "package Later;" },
      base.version,
      "system",
    );
    release();
    await denied(() => pending, "STALE_REVISION");
    assert(
      (await repo.listProposals()).length === 0 &&
        (await repo.current()).version === advanced.version,
    );
  } finally {
    release?.();
    await Deno.remove(projectDir, { recursive: true });
  }
});
Deno.test("Restart revalidates interrupted admission before restoring publication", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({
      projectDir,
      compiler,
      sourceAuthorization: { validate: () => Promise.resolve() },
    });
    const base = await repo.initialize(initialSources);
    const proposal = await repo.propose({
      baseVersion: base.version,
      sources: { ...initialSources, "a.sysml": "package Changed;" },
      author: "agent:o",
      reason: "edit",
      authorization,
    });
    const accepted = await repo.accept({
      id: proposal.id,
      expectedVersion: base.version,
      author: "reviewer",
    });
    const path =
      `${projectDir}/.assembly/runtime/proposals/${proposal.id}.json`;
    const journal = JSON.parse(await Deno.readTextFile(path));
    journal.value.status = "accepting";
    delete journal.value.acceptedVersion;
    journal.digest = await sha256(canonical(journal.value));
    await Deno.writeTextFile(path, JSON.stringify(journal));
    // Simulate interruption before the main-reference CAS using the real Git ref.
    const result = await new Deno.Command("git", {
      args: [
        "--git-dir",
        `${projectDir}/.git`,
        "update-ref",
        "refs/heads/admitted",
        base.version.slice(7),
        accepted.version.slice(7),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    const calls: Parameters<ModelSourceAuthorizationPort["validate"]>[0][] = [];
    await denied(() =>
      GitModelRepository.open({
        projectDir,
        compiler,
        sourceAuthorization: {
          validate(input) {
            calls.push(input);
            return deny();
          },
        },
      })
    );
    assert(
      calls.length === 1 && calls[0].phase === "recovery" &&
        calls[0].authority.version === base.version,
    );
    await denied(() => GitModelRepository.open({ projectDir, compiler }));
    delete journal.value.authorization;
    journal.digest = await sha256(canonical(journal.value));
    await Deno.writeTextFile(path, JSON.stringify(journal));
    await denied(() =>
      GitModelRepository.open({
        projectDir,
        compiler,
        sourceAuthorization: { validate: () => Promise.resolve() },
      })
    );
    journal.value.authorization = authorization;
    journal.digest = await sha256(canonical(journal.value));
    await Deno.writeTextFile(path, JSON.stringify(journal));
    const restored = await GitModelRepository.open({
      projectDir,
      compiler,
      sourceAuthorization: { validate: () => Promise.resolve() },
    });
    assert((await restored.current()).version === accepted.version);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
Deno.test("Acceptance authorization cannot overwrite a concurrent admitted head", async () => {
  const projectDir = await Deno.makeTempDir();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const waiting = new Promise<void>((resolve) => entered = resolve);
  try {
    const repo = await GitModelRepository.open({
      projectDir,
      compiler,
      sourceAuthorization: {
        async validate(input) {
          if (input.phase === "acceptance") {
            entered();
            await gate;
          }
        },
      },
    });
    const base = await repo.initialize(initialSources);
    const proposal = await repo.propose({
      baseVersion: base.version,
      sources: { ...initialSources, "a.sysml": "package Changed;" },
      author: "agent:o",
      reason: "edit",
      authorization,
    });
    const pending = repo.accept({
      id: proposal.id,
      expectedVersion: base.version,
      author: "reviewer",
    });
    await waiting;
    const advanced = await repo.publishSystemSources(
      { ...initialSources, "b.sysml": "package Later;" },
      base.version,
      "system",
    );
    release();
    await denied(() => pending, "STALE_REVISION");
    assert(
      (await repo.current()).version === advanced.version &&
        (await repo.proposal(proposal.id)).status === "proposed",
    );
  } finally {
    release?.();
    await Deno.remove(projectDir, { recursive: true });
  }
});
