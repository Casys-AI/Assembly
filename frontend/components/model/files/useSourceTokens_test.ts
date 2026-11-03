import assert from "node:assert/strict";
import { act } from "preact/test-utils";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import type { SourceTokensDocument } from "../../../../src/domain/model/consultation/source-tokens.ts";
import type { fetchSourceTokens } from "../../../lib/model/sources/tokens.ts";
import { useSourceTokens } from "./useSourceTokens.ts";
const A = `commit:${"a".repeat(40)}`, B = `commit:${"b".repeat(40)}`;
Deno.test("only current source/version/path is colored; late replies and unmounted reads are aborted", async () => {
  const root = probeRoot();
  const calls: {
    version: string;
    path: string;
    signal: AbortSignal;
    pending: PromiseWithResolvers<SourceTokensDocument>;
  }[] = [];
  const read: typeof fetchSourceTokens = (version, path, signal) => {
    const pending = Promise.withResolvers<SourceTokensDocument>();
    calls.push({ version, path, signal, pending });
    return pending.promise;
  };
  const seen: { document: SourceTokensDocument | null } = { document: null };
  const current = () => seen.document;
  function Probe(
    props: { version?: string; path: string; text: string | null },
  ) {
    seen.document = useSourceTokens(
      props.version,
      props.path,
      props.text,
      read,
    );
    return null;
  }
  const document = (version: string, path: string): SourceTokensDocument => ({
    version,
    path,
    legend: ["keyword"],
    tokens: [],
  });
  try {
    await root.show(Probe, { version: A, path: "a.sysml", text: "a" });
    assert.equal(calls.length, 1);
    await root.show(Probe, { version: B, path: "b.sysml", text: "b" });
    assert.equal(calls[0].signal.aborted, true);
    await act(async () => {
      calls[0].pending.resolve(document(A, "a.sysml"));
      await calls[0].pending.promise;
    });
    assert.equal(current(), null);
    await act(async () => {
      calls[1].pending.resolve(document(B, "b.sysml"));
      await calls[1].pending.promise;
    });
    assert.equal(current()?.version, B);
    await root.show(Probe, { version: B, path: "b.sysml", text: "changed" });
    assert.equal(current(), null);
    await act(async () => {
      calls[2].pending.reject(new Error("unavailable"));
      await Promise.resolve();
    });
    assert.equal(current(), null);
    await root.show(Probe, { version: A, path: "a.sysml", text: "a" });
    await root.unmount();
    assert.equal(calls[3].signal.aborted, true);
    await act(async () => {
      calls[3].pending.resolve(document(A, "a.sysml"));
      await calls[3].pending.promise;
    });
  } finally {
    await root.restore();
  }
});
