import assert from "node:assert/strict";
import type { SystemSourcesUpdateOptions } from "../../src/application/model/repository.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import type { ModelCompiler } from "../../src/application/model/builds/ports/out/model-compiler.port.ts";
import { publicationFailure } from "../../src/application/model/publication/publication-failure.ts";
import {
  assertPublicationSize,
  publicationSystemId,
  type SourcePublication,
} from "../../src/domain/model/publication/change.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import type { SourceRepository } from "../../src/application/model/source-repository.ts";
import type { SourceRevision } from "../../src/domain/model/records/source-revision.ts";

/** Preparation never advances storage; shared with the durable recovery fixture. */
export async function compileVerifiedSources(
  compiler: ModelCompiler,
  sources: Record<string, string>,
  current: SourceRevision,
  verify: SystemSourcesUpdateOptions["verify"],
) {
  const compiled = await compiler.compile(sources);
  await verify?.(structuredClone({ ...compiled, version: current.version }));
  return compiled;
}

/** A serialized host writer with immutable snapshots and pre-publication verification. */
export class MemorySourceRepository implements SourceRepository {
  readonly publications = new Map<
    string,
    { revision: ModelRevision; receipt: SourcePublication }
  >();
  readonly versions = new Map<string, ModelRevision>();
  value?: ModelRevision;
  #updates: Promise<unknown> = Promise.resolve();
  constructor(readonly compiler: ModelCompiler) {}
  findPublication(id: string) {
    return Promise.resolve(structuredClone(this.publications.get(id) ?? null));
  }
  async initialize(sources: Record<string, string>) {
    return this.value ??
      await this.publishSystemSources(sources, "", "initialize");
  }
  current() {
    assert(this.value);
    return Promise.resolve(structuredClone(this.value));
  }
  at(version: string) {
    const value = this.versions.get(version);
    assert(value);
    return Promise.resolve(structuredClone(value));
  }
  async publishSystemSources(
    sources: Record<string, string>,
    expected: string,
    _author = "fixture",
  ) {
    assert.equal(this.value?.version ?? "", expected);
    return this.#publish(await this.compiler.compile(sources));
  }
  #publish(compiled: Awaited<ReturnType<ModelCompiler["compile"]>>) {
    const revision = {
      ...compiled,
      version: `memory:${this.versions.size + 1}`,
    };
    this.versions.set(revision.version, structuredClone(revision));
    this.value = structuredClone(revision);
    return revision;
  }
  async updateSystemSources(
    update: Parameters<SourceRepository["updateSystemSources"]>[0],
    _author: string,
    options: SystemSourcesUpdateOptions = {},
  ) {
    const pending = this.#updates.then(async () => {
      const receipt = options.publication;
      if (receipt) {
        assertPublicationSize(receipt);
        const found = await this.findPublication(receipt.changeId);
        if (found) {
          assert.deepEqual({
            ...receipt,
            edits: receipt.edits.length ? receipt.edits : found.receipt.edits,
          }, found.receipt);
          receipt.edits = structuredClone(found.receipt.edits);
          return found.revision;
        }
      }
      const current = await this.current();
      let compiled: Awaited<ReturnType<ModelCompiler["compile"]>>;
      try {
        const sources = await update(structuredClone(current));
        if (receipt) assertPublicationSize(receipt);
        if (canonical(sources) === canonical(current.sources)) {
          if (receipt && receipt.type !== "candidate-activation") {
            throw Object.assign(
              new Error("Approved publication must change sources"),
              {
                code: "INVALID_REQUEST",
              },
            );
          }
          await options.verify?.(structuredClone(current));
          return current;
        }
        compiled = await compileVerifiedSources(
          this.compiler,
          sources,
          current,
          options.verify,
        );
      } catch (error) {
        if (!receipt) throw error;
        throw publicationFailure(error, {
          changeId: receipt.changeId,
          systemId: publicationSystemId(receipt),
        }, "refuse");
      }
      const revision = this.#publish(compiled);
      if (receipt) {
        this.publications.set(receipt.changeId, {
          revision: structuredClone(revision),
          receipt: structuredClone(receipt),
        });
      }
      return revision;
    });
    this.#updates = pending.catch(() => {});
    return await pending;
  }
  propose(
    _request: Parameters<SourceRepository["propose"]>[0],
  ): ReturnType<SourceRepository["propose"]> {
    return Promise.reject(
      new Error("Source proposals are not supported by this fixture"),
    );
  }
}
